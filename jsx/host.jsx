/* ZoomTransform - jsx/host.jsx
 * ExtendScript host layer for Premiere Pro (PPRO).
 *
 * - Captures the current frame at the playhead via the hidden QE DOM and
 *   exports it to a temp PNG for display in the canvas (ReFrame).
 * - Applies the AE.ADBE Transform effect on the active clip under the playhead
 *   and creates zoom keyframes: a start keyframe at the current playhead time
 *   holding the clip's CURRENT scale, and an end keyframe "duration" seconds
 *   later holding the target zoom derived from the rectangle.
 *
 * Note: ExtendScript is ES3-ish. Avoid Array.prototype.map/filter closures
 * that rely on ES5 semantics; keep loops explicit.
 *
 * The capture function relies on the hidden QE DOM (app.enableQE()). The exact
 * export call name may vary between PPRO 13.x builds; we try several methods.
 */

// Match name for the After Effects Transform effect in Premiere.
var ZT_TRANSFORM_MATCHNAME = "AE.ADBE Transform";

// Property match names inside AE.ADBE Transform.
var ZT_PROP_SCALE = "ADBE Scale";
var ZT_PROP_ANCHOR = "ADBE Anchor Point";
var ZT_PROP_POSITION = "ADBE Position";
var ZT_PROP_ROTATION = "ADBE Rotation";
var ZT_PROP_MOTION_BLUR = "ADBE Motion Blur";
var ZT_PROP_UNIFORM_SCALE = "ADBE Uniform Scale";

// Premiere stores time as ticks; 254016000000 ticks per second.
var ZT_TICKS_PER_SECOND = 254016000000;

/* ------------------------------------------------------------------ *
 *  Utilities
 * ------------------------------------------------------------------ */

function ZT_log(msg) {
    try { $.writeln("[ZoomTransform] " + msg); } catch (e) {}
}

function ZT_tempDir() {
    var f;
    try { f = Folder.temp; } catch (e) {}
    if (!f) {
        try { f = new Folder(Folder.system.fsName + (Folder.system.fsName.indexOf(":") > -1 ? "\\Temp" : "/tmp")); } catch (e2) {}
    }
    return f;
}

function ZT_tempPath(ext) {
    ext = ext || "png";
    var name = "zt_frame_" + (new Date().getTime()) + "." + ext;
    var dir = ZT_tempDir();
    var sep = dir.fsName.indexOf(":") > -1 ? "\\" : "/";
    var f = new File(dir.fsName + sep + name);
    return f;
}

function ZT_getActiveSequence() {
    try {
        if (app.project && app.project.activeSequence) return app.project.activeSequence;
    } catch (e) {}
    return null;
}

function ZT_getActiveClip(seq) {
    // Return the topmost video-track clip under the playhead.
    try {
        var ct = seq.getCurrentTime(); // ticks string
        var tracks = seq.videoTracks;
        for (var t = tracks.numTracks - 1; t >= 0; t--) {
            var track = tracks[t];
            if (!track.isLocked()) {
                var clips = track.clips;
                for (var c = 0; c < clips.numclips; c++) {
                    var clip = clips[c];
                    if (ZT_inRange(ct, clip.start, clip.end)) {
                        return { clip: clip, track: track };
                    }
                }
            }
        }
    } catch (e) { ZT_log("getActiveClip error: " + e); }
    return null;
}

function ZT_inRange(ticks, startTicks, endTicks) {
    try {
        var t = parseFloat(ticks), s = parseFloat(startTicks), e = parseFloat(endTicks);
        return t >= s && t <= e;
    } catch (err) { return false; }
}

function ZT_secondsToTicks(seconds) {
    return Math.round(seconds * ZT_TICKS_PER_SECOND).toString();
}

function ZT_addTicks(ticksStr, seconds) {
    // Returns a ticks string = ticksStr + seconds, clamped to >= 0.
    var base = parseFloat(ticksStr);
    var add = seconds * ZT_TICKS_PER_SECOND;
    var result = base + add;
    if (result < 0) result = 0;
    return Math.round(result).toString();
}

function ZT_getFrameSize(seq, clip) {
    // Resolve the source/sequence frame dimensions in pixels.
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

/* ------------------------------------------------------------------ *
 *  Frame capture (ReFrame) via hidden QE DOM
 * ------------------------------------------------------------------ */

function ZT_captureCurrentFrame() {
    try {
        var seq = ZT_getActiveSequence();
        if (!seq) return "ERROR: No active sequence. Open a sequence on the Timeline.";

        // Enable the hidden QE DOM.
        try { app.enableQE(); } catch (e) {}

        var out = ZT_tempPath("png");
        var exported = false;

        // Method 1: qe.project.getActiveSequence().exportAsMediaDirect(path, encoder, workArea)
        try {
            var qeSeq = qe.project.getActiveSequence();
            if (qeSeq && typeof qeSeq.exportAsMediaDirect === "function") {
                qeSeq.exportAsMediaDirect(out.fsName, "PNG", 0);
                exported = out.exists;
            }
        } catch (e) { ZT_log("qe exportAsMediaDirect failed: " + e); }

        // Method 2: public Sequence.exportAsMediaDirect
        if (!exported) {
            try {
                if (typeof seq.exportAsMediaDirect === "function") {
                    seq.exportAsMediaDirect(out.fsName, "PNG", 0);
                    exported = out.exists;
                }
            } catch (e) { ZT_log("seq exportAsMediaDirect failed: " + e); }
        }

        if (!exported) {
            return "ERROR: Could not export the frame from this Premiere build. Try a different build or report the exact error.";
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

        // Ensure the Transform effect is present.
        var tf = ZT_findComponent(clip, ZT_TRANSFORM_MATCHNAME);
        if (!tf) {
            try {
                clip.addEffect(ZT_TRANSFORM_MATCHNAME);
            } catch (e) {
                try { clip.addEffect("Transform"); } catch (e2) {
                    return "ERROR: Could not add the Transform effect to the clip.";
                }
            }
            tf = ZT_findComponent(clip, ZT_TRANSFORM_MATCHNAME);
        }
        if (!tf) return "ERROR: Transform component not found after adding the effect.";

        // Resolve property objects.
        var scaleProp = ZT_findProp(tf, ZT_PROP_SCALE);
        var anchorProp = ZT_findProp(tf, ZT_PROP_ANCHOR);
        var posProp = ZT_findProp(tf, ZT_PROP_POSITION);
        var rotProp = ZT_findProp(tf, ZT_PROP_ROTATION);
        var uniformScaleProp = ZT_findProp(tf, ZT_PROP_UNIFORM_SCALE);

        // Normalize the zoom-rectangle center in the frame (0..1).
        var nx = p.nx, ny = p.ny;
        var frame = ZT_getFrameSize(seq, clip);
        var srcW = frame.w, srcH = frame.h;

        // Anchor Point = pixel center of the zoom rectangle within the frame.
        var anchorX = nx * srcW;
        var anchorY = ny * srcH;

        var targetZoom = p.zoom || 100;
        var duration = Math.max(0, Math.min(5, p.duration || 0));
        var easing = p.easing || "easeInOut";
        var doKeyframes = !!p.createKeyframes && duration > 0;
        var motionBlur = !!p.motionBlur;

        // Read the clip's CURRENT scale to use as the start value.
        var currentScale = ZT_readScale(scaleProp, uniformScaleProp);

        // Force uniform scale if the property is available (keeps aspect ratio).
        if (uniformScaleProp && uniformScaleProp.setValue) {
            try { uniformScaleProp.setValue(true, true); } catch (e) {}
        }

        // Rotation (static).
        if (rotProp && rotProp.setValue) {
            try { rotProp.setValue(p.rot || 0, true); } catch (e) {}
        }

        // Motion blur if supported and requested.
        if (motionBlur) {
            try {
                var mb = ZT_findProp(tf, ZT_PROP_MOTION_BLUR);
                if (mb && mb.setValue) mb.setValue(1, true);
            } catch (e) {}
        }

        // Determine the current playhead time (ticks string) in sequence space.
        var nowTicks = seq.getCurrentTime();
        var nowTickNum = parseFloat(nowTicks);
        // End time = now + duration, clamped to the clip end.
        var endTickNum = nowTickNum + duration * ZT_TICKS_PER_SECOND;
        var clipEndNum = parseFloat(clip.end);
        if (endTickNum > clipEndNum) endTickNum = clipEndNum;
        if (endTickNum < nowTickNum) endTickNum = nowTickNum;

        if (!doKeyframes) {
            // Static zoom: just set the target scale and anchor at the playhead.
            ZT_setStatic(anchorProp, [anchorX, anchorY]);
            ZT_setStatic(scaleProp, targetZoom);
            if (p.lockCenter) ZT_setStatic(posProp, [anchorX, anchorY]);
            return "OK: Applied static zoom " + Math.round(targetZoom) + "%.";
        }

        // ---- Keyframed zoom animation ----
        // 1) Anchor point: set it to the zoom-rectangle center (static, not animated)
        //    so scaling happens about the selected region.
        ZT_setStatic(anchorProp, [anchorX, anchorY]);

        // 2) Scale keyframes: start = current scale at playhead, end = target zoom.
        if (scaleProp) {
            // Enable keyframing for the scale property.
            ZT_enableKeyframing(scaleProp);
            // Start keyframe: hold the current scale at the current time.
            ZT_setKeyAtTime(scaleProp, nowTickNum.toString(), currentScale);
            // End keyframe: target zoom at (now + duration).
            ZT_setKeyAtTime(scaleProp, Math.round(endTickNum).toString(), targetZoom);
        }

        // 3) Position keyframes (only when lock center is on): keep the anchor
        //    centered in the frame by offsetting position to match the anchor.
        if (posProp && p.lockCenter) {
            ZT_enableKeyframing(posProp);
            ZT_setKeyAtTime(posProp, nowTickNum.toString(), [anchorX, anchorY]);
            ZT_setKeyAtTime(posProp, Math.round(endTickNum).toString(), [anchorX, anchorY]);
        }

        return "OK: Created zoom keyframes from " + Math.round(currentScale) + "% to " + Math.round(targetZoom) + "% over " + duration + "s.";
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

/* ------------------------------------------------------------------ *
 *  Property helpers
 * ------------------------------------------------------------------ */

function ZT_findComponent(clip, matchName) {
    try {
        var components = clip.components;
        for (var i = 0; i < components.numComponents; i++) {
            var comp = components[i];
            if (comp && comp.matchName === matchName) return comp;
        }
    } catch (e) {}
    return null;
}

function ZT_findProp(component, matchName) {
    try {
        var props = component.properties;
        for (var i = 0; i < props.numProperties; i++) {
            var pr = props[i];
            if (pr && pr.matchName === matchName) return pr;
        }
    } catch (e) {}
    return null;
}

function ZT_readScale(scaleProp, uniformScaleProp) {
    // Read the current scale value as a single percent. Premiere's ADBE Scale
    // is a 2D array [x, y]; when uniform scale is on, x == y.
    if (!scaleProp) return 100;
    try {
        var v = scaleProp.getValue();
        if (v instanceof Array) {
            return v[0];
        }
        return v;
    } catch (e) {
        try {
            // getValueAtTime fallback at time 0.
            var v0 = scaleProp.getValueAtTime("0");
            if (v0 instanceof Array) return v0[0];
            return v0;
        } catch (e2) { return 100; }
    }
}

function ZT_setStatic(prop, value) {
    if (!prop || !prop.setValue) return false;
    try { prop.setValue(value, true); return true; } catch (e) { return false; }
}

function ZT_enableKeyframing(prop) {
    if (!prop) return;
    // Premiere component properties support stopwatches via different APIs
    // depending on the build. Try the common ones.
    try { if (prop.isTimeVarying !== undefined && !prop.isTimeVarying) prop.isTimeVarying = true; } catch (e) {}
    try { if (typeof prop.setKeyframeEnabled === "function") prop.setKeyframeEnabled(true); } catch (e) {}
    try { if (prop.canSetTimeVarying !== undefined && prop.canSetTimeVarying) prop.timeVarying = true; } catch (e) {}
}

function ZT_setKeyAtTime(prop, ticksStr, value) {
    if (!prop) return false;
    // setValueAtTime(time, value) is the documented Premiere API on TVG properties.
    try {
        prop.setValueAtTime(ticksStr, value);
        return true;
    } catch (e) {
        ZT_log("setValueAtTime failed: " + e + " (ticks=" + ticksStr + ")");
        // Fallback: set the value statically so the effect still applies.
        try { prop.setValue(value, true); } catch (e2) {}
        return false;
    }
}

// Easing helper reserved for future temporal-ease refinement if the build
// exposes keyframe ease accessors.
function ZT_easeFactor(t, type) {
    if (type === "linear") return t;
    if (type === "easeIn") return t * t;
    if (type === "easeOut") return 1 - (1 - t) * (1 - t);
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
