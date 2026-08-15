/* ZoomTransform - jsx/host.jsx
 * ExtendScript host layer for Premiere Pro (PPRO 2020 / 13.x).
 *
 * Two responsibilities:
 *  1) ZT_captureCurrentFrame() — exports the frame at the current playhead to
 *     a temp PNG so the panel canvas can display it (ReFrame).
 *  2) ZT_applyTransform(payloadStr) — adds the AE.ADBE Transform effect to the
 *     clip under the playhead and creates zoom keyframes: a start keyframe at
 *     the playhead time holding the clip's CURRENT scale, and an end keyframe
 *     (transition duration) seconds later holding the target zoom derived from
 *     the rectangle.
 *
 * IMPORTANT: Premiere Pro's ExtendScript keyframe API differs from After
 * Effects. The correct sequence is:
 *     prop.setTimeVarying(true);   // enable the stopwatch
 *     prop.addKey(time);           // create a keyframe at a time (Time obj or seconds)
 *     prop.setValueAtKey(time, value, updateUI); // set its value
 * PPRO does NOT support setValueAtTime() (that is After Effects only).
 *
 * Effects are added via the hidden QE DOM:
 *     app.enableQE();
 *     qeClip.addVideoEffect(qe.project.getVideoEffectByName("Transform"));
 * Component/property access uses numItems and array indexing.
 *
 * Note: ExtendScript is ES3-ish. Keep loops explicit; avoid ES5 array methods.
 */

// Premiere tick constants.
var ZT_TICKS_PER_SECOND = 254016000000;

// Match name for the After Effects Transform effect in Premiere.
var ZT_TRANSFORM_MATCHNAME = "AE.ADBE Transform";
// Display name used when looking up the effect via the QE DOM.
var ZT_TRANSFORM_DISPLAYNAME = "Transform";

// Display-name fragments of the property groups inside AE.ADBE Transform.
// (PPRO exposes component properties by displayName, not always matchName.)
var ZT_PROP_SCALE_LABEL = "Scale";
var ZT_PROP_ANCHOR_LABEL = "Anchor Point";
var ZT_PROP_POSITION_LABEL = "Position";
var ZT_PROP_ROTATION_LABEL = "Rotation";
var ZT_PROP_UNIFORM_LABEL = "Uniform Scale";

/* ------------------------------------------------------------------ *
 *  Logging
 * ------------------------------------------------------------------ */

function ZT_log(msg) {
    try { $.writeln("[ZoomTransform] " + msg); } catch (e) {}
}

/* ------------------------------------------------------------------ *
 *  Utilities
 * ------------------------------------------------------------------ */

function ZT_getActiveSequence() {
    try {
        if (app.project && app.project.activeSequence) return app.project.activeSequence;
    } catch (e) {}
    return null;
}

function ZT_tempPath(ext) {
    ext = ext || "png";
    var dir = Folder.temp;
    var sep = (Folder.fs === "Windows") ? "\\" : "/";
    var name = "zt_frame_" + (new Date().getTime()) + "." + ext;
    return new File(dir.fsName + sep + name);
}

function ZT_getActiveClip(seq) {
    // Return the topmost unlocked video-track clip under the playhead.
    try {
        var nowTicks = seq.getPlayerPosition().ticks;
        var nowNum = parseFloat(nowTicks);
        var tracks = seq.videoTracks;
        for (var t = tracks.numTracks - 1; t >= 0; t--) {
            var track = tracks[t];
            var clips = track.clips;
            for (var c = 0; c < clips.numItems; c++) {
                var clip = clips[c];
                var s = parseFloat(clip.start.ticks);
                var e = parseFloat(clip.end.ticks);
                if (nowNum >= s && nowNum <= e) {
                    return { clip: clip, track: track, trackIndex: t, clipIndex: c };
                }
            }
        }
    } catch (e) { ZT_log("getActiveClip error: " + e); }
    return null;
}

function ZT_getFrameSize(seq, clip) {
    var w = 1920, h = 1080;
    try {
        var ss = seq.getSettings();
        if (ss && ss.videoFrameSize) {
            w = ss.videoFrameSize.width || w;
            h = ss.videoFrameSize.height || h;
        }
    } catch (e) {}
    try {
        if (clip.source && clip.source.getMediaInfo && clip.source.getMediaInfo().frameSize) {
            w = clip.source.getMediaInfo().frameSize.width || w;
            h = clip.source.getMediaInfo().frameSize.height || h;
        }
    } catch (e) {}
    return { w: w, h: h };
}

function ZT_enableQE() {
    try { app.enableQE(); } catch (e) {}
}

/* ------------------------------------------------------------------ *
 *  Component / property access (PPRO public API)
 * ------------------------------------------------------------------ */

function ZT_findComponent(clip, matchName) {
    try {
        var comps = clip.components;
        for (var i = 0; i < comps.numItems; i++) {
            var comp = comps[i];
            if (comp && comp.matchName === matchName) return comp;
        }
    } catch (e) {}
    return null;
}

function ZT_findPropByLabel(component, label) {
    // PPRO exposes properties by displayName; match case-insensitively.
    try {
        var props = component.properties;
        for (var i = 0; i < props.numItems; i++) {
            var pr = props[i];
            if (pr && pr.displayName) {
                var dn = pr.displayName.toLowerCase();
                if (dn === label.toLowerCase()) return pr;
            }
        }
    } catch (e) {}
    return null;
}

function ZT_listProps(component) {
    // Diagnostic helper: logs every property displayName + matchName.
    try {
        var props = component.properties;
        for (var i = 0; i < props.numItems; i++) {
            var pr = props[i];
            ZT_log("prop[" + i + "] = '" + (pr.displayName || "?") +
                   "' (matchName=" + (pr.matchName || "?") + ")");
        }
    } catch (e) {}
}

/* ------------------------------------------------------------------ *
 *  Frame capture (ReFrame)
 *
 *  Uses app.encoder.encodeSequence() with a PNG preset is NOT possible
 *  without a preset file path. Instead, we rely on the QE DOM's
 *  exportAsMediaDirect which can write a single frame when given an in/out
 *  range of one frame. As a fallback we also try the public sequence API.
 * ------------------------------------------------------------------ */

function ZT_captureCurrentFrame() {
    try {
        var seq = ZT_getActiveSequence();
        if (!seq) return "ERROR: No active sequence. Open a sequence on the Timeline.";

        ZT_enableQE();

        var out = ZT_tempPath("png");
        var exported = false;

        // Method A: QE DOM exportAsMediaDirect with a frame-range in/out.
        // We set the sequence in/out to a single frame around the playhead,
        // export, then restore the original in/out points.
        try {
            var qeSeq = qe.project.getActiveSequence();
            if (qeSeq) {
                var playerPos = seq.getPlayerPosition();
                var frameStart = playerPos.seconds;
                // ~1/24s window to capture a single frame.
                var frameEnd = frameStart + 0.04;

                var oldIn = seq.getInPointAsTime().seconds;
                var oldOut = seq.getOutPointAsTime().seconds;

                seq.setInPoint(frameStart);
                seq.setOutPoint(frameEnd);

                // exportAsMediaDirect(path, outputSettingsPath, workAreaType)
                // ENCODE_IN_TO_OUT = 1
                try {
                    if (typeof seq.exportAsMediaDirect === "function") {
                        seq.exportAsMediaDirect(out.fsName, "PNG", 1);
                        exported = out.exists;
                    }
                } catch (e1) { ZT_log("seq.exportAsMediaDirect failed: " + e1); }

                // Try QE version if the public one did not produce a file.
                if (!exported) {
                    try {
                        if (typeof qeSeq.exportAsMediaDirect === "function") {
                            qeSeq.exportAsMediaDirect(out.fsName, "PNG", 1);
                            exported = out.exists;
                        }
                    } catch (e2) { ZT_log("qeSeq.exportAsMediaDirect failed: " + e2); }
                }

                // Restore in/out points.
                seq.setInPoint(oldIn);
                seq.setOutPoint(oldOut);
            }
        } catch (e) { ZT_log("QE frame capture failed: " + e); }

        // Method B: last-resort — instruct the user.
        if (!exported) {
            return "ERROR: Could not export the frame from this Premiere build. " +
                   "If you have a PNG encoder preset (.epr), set its path. " +
                   "Otherwise report the exact error message.";
        }
        if (!out.exists) return "ERROR: Frame file was not created.";
        return out.fsName;
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

/* ------------------------------------------------------------------ *
 *  Apply Transform effect + zoom keyframes
 * ------------------------------------------------------------------ */

function ZT_applyTransform(payloadStr) {
    var p;
    try {
        p = JSON.parse(payloadStr);
    } catch (e) {
        return "ERROR: Invalid payload data.";
    }

    try {
        var seq = ZT_getActiveSequence();
        if (!seq) return "ERROR: No active sequence.";

        var ac = ZT_getActiveClip(seq);
        if (!ac || !ac.clip) return "ERROR: No clip under the playhead on the Timeline.";

        var clip = ac.clip;
        var trackIndex = ac.trackIndex;
        var clipIndex = ac.clipIndex;

        // Make sure the Transform effect is present. Use the QE DOM to add it.
        ZT_enableQE();
        var tf = ZT_findComponent(clip, ZT_TRANSFORM_MATCHNAME);
        if (!tf) {
            try {
                var qeSeq = qe.project.getActiveSequence();
                var qeClip = qeSeq.getVideoTrackAt(trackIndex).getItemAt(clipIndex);
                qeClip.addVideoEffect(qe.project.getVideoEffectByName(ZT_TRANSFORM_DISPLAYNAME));
            } catch (e) {
                ZT_log("addVideoEffect failed: " + e);
            }
            // The effect may take a moment to register in the public DOM.
            tf = ZT_findComponent(clip, ZT_TRANSFORM_MATCHNAME);
        }
        if (!tf) return "ERROR: Transform effect could not be added. Make sure 'Transform' is available in your Effects panel.";

        // Resolve property objects by display name.
        var scaleProp = ZT_findPropByLabel(tf, ZT_PROP_SCALE_LABEL);
        var anchorProp = ZT_findPropByLabel(tf, ZT_PROP_ANCHOR_LABEL);
        var posProp = ZT_findPropByLabel(tf, ZT_PROP_POSITION_LABEL);
        var rotProp = ZT_findPropByLabel(tf, ZT_PROP_ROTATION_LABEL);
        var uniformProp = ZT_findPropByLabel(tf, ZT_PROP_UNIFORM_LABEL);

        // Diagnostic: log available properties if scale isn't found.
        if (!scaleProp) {
            ZT_log("Scale property not found by label. Available properties:");
            ZT_listProps(tf);
        }

        // Frame dimensions (pixels) to convert normalized rect coords.
        var frame = ZT_getFrameSize(seq, clip);
        var srcW = frame.w, srcH = frame.h;

        // Normalized center of the zoom rectangle in the frame (0..1).
        var nx = p.nx, ny = p.ny;
        var anchorX = nx * srcW;
        var anchorY = ny * srcH;

        var targetZoom = p.zoom || 100;
        var duration = Math.max(0, Math.min(5, p.duration || 0));
        var easing = p.easing || "easeInOut";
        var doKeyframes = !!p.createKeyframes && duration > 0;
        var motionBlur = !!p.motionBlur;

        // Read the clip's CURRENT scale to use as the start keyframe value.
        var currentScale = ZT_readScale(scaleProp);

        // Force uniform scale if available, to keep aspect ratio.
        if (uniformProp && uniformProp.setValue) {
            try { uniformProp.setValue(true, true); } catch (e) {}
        }

        // Rotation (static).
        if (rotProp && rotProp.setValue) {
            try { rotProp.setValue(p.rot || 0, true); } catch (e) {}
        }

        // Motion blur if supported and requested.
        if (motionBlur) {
            var mb = ZT_findPropByLabel(tf, "Motion Blur");
            if (mb && mb.setValue) {
                try { mb.setValue(1, true); } catch (e) {}
            }
        }

        // Compute the start/end times in seconds (sequence space).
        var playerPos = seq.getPlayerPosition();
        var startSec = playerPos.seconds;
        var clipEndSec = parseFloat(clip.end.seconds);
        var endSec = startSec + duration;
        if (endSec > clipEndSec) endSec = clipEndSec;
        if (endSec < startSec) endSec = startSec;

        // Set the anchor point to the rectangle center so scaling happens
        // about the selected region (static, not keyframed).
        if (anchorProp && anchorProp.setValue) {
            try { anchorProp.setValue([anchorX, anchorY], true); } catch (e) { ZT_log("anchor set failed: " + e); }
        }

        if (!doKeyframes) {
            // Static zoom only.
            if (scaleProp && scaleProp.setValue) {
                try { scaleProp.setValue([targetZoom, targetZoom], true); } catch (e) {
                    try { scaleProp.setValue(targetZoom, true); } catch (e2) {}
                }
            }
            if (p.lockCenter && posProp && posProp.setValue) {
                try { posProp.setValue([anchorX, anchorY], true); } catch (e) {}
            }
            return "OK: Applied static zoom " + Math.round(targetZoom) + "%.";
        }

        // ---- Keyframed zoom animation ----
        // PPRO keyframe API: setTimeVarying(true) -> addKey(t) -> setValueAtKey(t, val, true)
        var interpType = ZT_easingToInterp(easing);

        if (scaleProp) {
            // 1) Enable the stopwatch for scale.
            try {
                if (!scaleProp.isTimeVarying()) scaleProp.setTimeVarying(true);
            } catch (e) { ZT_log("setTimeVarying(scale) failed: " + e); }

            // 2) Start keyframe: current scale at the playhead.
            ZT_addKeyWithValue(scaleProp, startSec, currentScale, interpType);

            // 3) End keyframe: target zoom after the transition duration.
            ZT_addKeyWithValue(scaleProp, endSec, targetZoom, interpType);
        }

        // Position keyframes (only when lock center is on).
        if (p.lockCenter && posProp) {
            try {
                if (!posProp.isTimeVarying()) posProp.setTimeVarying(true);
            } catch (e) {}
            ZT_addKeyWithValue(posProp, startSec, [anchorX, anchorY], interpType);
            ZT_addKeyWithValue(posProp, endSec, [anchorX, anchorY], interpType);
        }

        return "OK: Created zoom keyframes from " + Math.round(currentScale) + "% to " +
               Math.round(targetZoom) + "% over " + duration + "s.";
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

/* ------------------------------------------------------------------ *
 *  Keyframe helpers (PPRO API)
 * ------------------------------------------------------------------ */

function ZT_readScale(scaleProp) {
    // Read the current scale value as a single percent.
    if (!scaleProp) return 100;
    try {
        var v = scaleProp.getValue();
        if (v instanceof Array) return v[0];
        return v;
    } catch (e) {
        try {
            var v0 = scaleProp.getValueAtKey ? null : null;
        } catch (e2) {}
        return 100;
    }
}

function ZT_addKeyWithValue(prop, timeSeconds, value, interpType) {
    // Create a keyframe at timeSeconds, set its value, and (optionally)
    // interpolation. PPRO addKey accepts a time in seconds (float) or a Time.
    if (!prop) return false;
    try {
        prop.addKey(timeSeconds);
    } catch (e) {
        ZT_log("addKey failed at " + timeSeconds + "s: " + e);
        return false;
    }
    try {
        prop.setValueAtKey(timeSeconds, value, true);
    } catch (e) {
        ZT_log("setValueAtKey failed at " + timeSeconds + "s: " + e);
        // Fallback: try setValue (sets the property statically).
        try { prop.setValue(value, true); } catch (e2) {}
    }
    // Set interpolation type if supported and requested.
    if (interpType !== undefined) {
        try {
            // findNearestKey returns a Time object we can pass to setInterpolationTypeAtKey.
            var keyTime = prop.findNearestKey(timeSeconds, 0.05);
            if (keyTime !== undefined && keyTime !== null) {
                prop.setInterpolationTypeAtKey(keyTime, interpType, true);
            }
        } catch (e) { /* not all props/builds support this */ }
    }
    return true;
}

function ZT_easingToInterp(easing) {
    // PPRO keyframe interpolation constants (from PProPanel):
    //   0 = Linear, 4 = Hold, 5 = Bezier, 6 = Time (auto bezier-ish)
    if (easing === "linear") return 0;
    if (easing === "easeIn" || easing === "easeOut" || easing === "easeInOut") return 5;
    return 0;
}

// Reserved for future manual easing refinement.
function ZT_easeFactor(t, type) {
    if (type === "linear") return t;
    if (type === "easeIn") return t * t;
    if (type === "easeOut") return 1 - (1 - t) * (1 - t);
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
