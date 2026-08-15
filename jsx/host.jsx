/* ZoomTransform - jsx/host.jsx
 * ExtendScript host layer for Premiere Pro (PPRO 2020 / 13.x).
 *
 * Responsibilities:
 *  1) ZT_captureCurrentFrame() — export the frame at the playhead to a temp PNG.
 *  2) ZT_applyTransform(payloadStr) — add the AE.ADBE Transform effect to the
 *     clip under the playhead and create zoom keyframes (start = current scale
 *     at playhead, end = target zoom after transition duration).
 *  3) ZT_diagnose() — returns a diagnostic report so the panel can show
 *     exactly what is available and where any failure happens.
 *
 * PPRO keyframe API (NOT the After Effects setValueAtTime):
 *     prop.setTimeVarying(true);   // enable stopwatch
 *     prop.addKey(time);            // create keyframe (seconds or Time)
 *     prop.setValueAtKey(time, value, updateUI);
 *
 * Effects are added via the hidden QE DOM:
 *     app.enableQE();
 *     qeClip.addVideoEffect(qe.project.getVideoEffectByName("Transform"));
 */

var ZT_TICKS_PER_SECOND = 254016000000;

// Match name for the After Effects Transform effect in Premiere.
var ZT_TRANSFORM_MATCHNAME = "AE.ADBE Transform";
var ZT_TRANSFORM_DISPLAYNAME = "Transform";

var ZT_PROP_SCALE_LABEL = "Scale";
var ZT_PROP_ANCHOR_LABEL = "Anchor Point";
var ZT_PROP_POSITION_LABEL = "Position";
var ZT_PROP_ROTATION_LABEL = "Rotation";
var ZT_PROP_UNIFORM_LABEL = "Uniform Scale";

/* ------------------------------------------------------------------ *
 *  Logging / diagnostics
 * ------------------------------------------------------------------ */

function ZT_log(msg) {
    try { $.writeln("[ZoomTransform] " + msg); } catch (e) {}
}

// Accumulator used to build the diagnostic report.
var ZT_diagLines = [];
function ZT_diag(msg) { ZT_diagLines.push(msg); }

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
    // Return the topmost video-track clip under the playhead, plus indices.
    try {
        var now = seq.getPlayerPosition();
        var nowSec = now.seconds;
        var nowTicks = now.ticks;
        var nowNum = parseFloat(nowTicks);
        var tracks = seq.videoTracks;
        for (var t = tracks.numTracks - 1; t >= 0; t--) {
            var track = tracks[t];
            var clips = track.clips;
            var n = clips.numItems;
            for (var c = 0; c < n; c++) {
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
    try { app.enableQE(); return true; } catch (e) { return false; }
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
                if (pr.displayName.toLowerCase() === label.toLowerCase()) return pr;
            }
        }
    } catch (e) {}
    return null;
}

function ZT_listPropNames(component) {
    var names = [];
    try {
        var props = component.properties;
        for (var i = 0; i < props.numItems; i++) {
            var pr = props[i];
            names.push((pr.displayName || "?") + " [" + (pr.matchName || "?") + "]");
        }
    } catch (e) {}
    return names;
}

/* ------------------------------------------------------------------ *
 *  Frame capture (ReFrame)
 * ------------------------------------------------------------------ */

function ZT_captureCurrentFrame() {
    try {
        var seq = ZT_getActiveSequence();
        if (!seq) return "ERROR: No active sequence. Open a sequence on the Timeline.";

        ZT_enableQE();
        var out = ZT_tempPath("png");
        var exported = false;

        // Save current in/out points so we can restore them.
        var oldInSec = 0, oldOutSec = 0;
        try { oldInSec = seq.getInPointAsTime().seconds; } catch (e) {}
        try { oldOutSec = seq.getOutPointAsTime().seconds; } catch (e) {}

        var playerPos = seq.getPlayerPosition();
        var frameStart = playerPos.seconds;
        var frameEnd = frameStart + 0.04;

        try { seq.setInPoint(frameStart); } catch (e) {}
        try { seq.setOutPoint(frameEnd); } catch (e) {}

        // ENCODE_IN_TO_OUT = 1
        // Try public sequence API first.
        try {
            if (typeof seq.exportAsMediaDirect === "function") {
                seq.exportAsMediaDirect(out.fsName, "PNG", 1);
                exported = out.exists;
            }
        } catch (e) { ZT_log("seq.exportAsMediaDirect failed: " + e); }

        // Try QE DOM.
        if (!exported) {
            try {
                var qeSeq = qe.project.getActiveSequence();
                if (qeSeq && typeof qeSeq.exportAsMediaDirect === "function") {
                    qeSeq.exportAsMediaDirect(out.fsName, "PNG", 1);
                    exported = out.exists;
                }
            } catch (e) { ZT_log("qeSeq.exportAsMediaDirect failed: " + e); }
        }

        // Restore in/out points.
        try { seq.setInPoint(oldInSec); } catch (e) {}
        try { seq.setOutPoint(oldOutSec); } catch (e) {}

        if (!exported) {
            return "ERROR: Could not export the frame. exportAsMediaDirect did not produce a file. " +
                   "Try the Diagnose button for details.";
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

        // Add the Transform effect via QE DOM if not present.
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
            tf = ZT_findComponent(clip, ZT_TRANSFORM_MATCHNAME);
        }
        if (!tf) {
            // Diagnostic detail for the panel.
            var compsAvail = [];
            try {
                var comps = clip.components;
                for (var i = 0; i < comps.numItems; i++) {
                    compsAvail.push(comps[i].matchName);
                }
            } catch (e2) {}
            return "ERROR: Transform effect not found. Components present: [" +
                   compsAvail.join(", ") + "]";
        }

        // Resolve property objects by display name.
        var scaleProp = ZT_findPropByLabel(tf, ZT_PROP_SCALE_LABEL);
        var anchorProp = ZT_findPropByLabel(tf, ZT_PROP_ANCHOR_LABEL);
        var posProp = ZT_findPropByLabel(tf, ZT_PROP_POSITION_LABEL);
        var rotProp = ZT_findPropByLabel(tf, ZT_PROP_ROTATION_LABEL);
        var uniformProp = ZT_findPropByLabel(tf, ZT_PROP_UNIFORM_LABEL);

        if (!scaleProp) {
            return "ERROR: 'Scale' property not found on Transform. Props: [" +
                   ZT_listPropNames(tf).join(", ") + "]";
        }

        // Frame dimensions (pixels).
        var frame = ZT_getFrameSize(seq, clip);
        var srcW = frame.w, srcH = frame.h;

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

        // Force uniform scale if available.
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

        // Start/end times in seconds (sequence space).
        var playerPos = seq.getPlayerPosition();
        var startSec = playerPos.seconds;
        var clipEndSec = parseFloat(clip.end.seconds);
        var endSec = startSec + duration;
        if (endSec > clipEndSec) endSec = clipEndSec;
        if (endSec < startSec) endSec = startSec;

        // Anchor point = rectangle center (static).
        if (anchorProp && anchorProp.setValue) {
            try { anchorProp.setValue([anchorX, anchorY], true); } catch (e) {}
        }

        if (!doKeyframes) {
            if (scaleProp && scaleProp.setValue) {
                try { scaleProp.setValue([targetZoom, targetZoom], true); }
                catch (e) { try { scaleProp.setValue(targetZoom, true); } catch (e2) {} }
            }
            if (p.lockCenter && posProp && posProp.setValue) {
                try { posProp.setValue([anchorX, anchorY], true); } catch (e) {}
            }
            return "OK: Applied static zoom " + Math.round(targetZoom) + "%.";
        }

        // ---- Keyframed zoom animation ----
        var interpType = ZT_easingToInterp(easing);
        var kMsgs = [];

        if (scaleProp) {
            // Enable the stopwatch.
            try {
                if (!scaleProp.isTimeVarying()) scaleProp.setTimeVarying(true);
            } catch (e) { kMsgs.push("setTimeVarying: " + e); }

            kMsgs.push(ZT_addKeyWithValue(scaleProp, startSec, currentScale, interpType, "start"));
            kMsgs.push(ZT_addKeyWithValue(scaleProp, endSec, targetZoom, interpType, "end"));
        }

        if (p.lockCenter && posProp) {
            try {
                if (!posProp.isTimeVarying()) posProp.setTimeVarying(true);
            } catch (e) {}
            ZT_addKeyWithValue(posProp, startSec, [anchorX, anchorY], interpType, "pos-start");
            ZT_addKeyWithValue(posProp, endSec, [anchorX, anchorY], interpType, "pos-end");
        }

        return "OK: zoom " + Math.round(currentScale) + "% -> " + Math.round(targetZoom) +
               "% over " + duration + "s. [" + kMsgs.join(" | ") + "]";
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

/* ------------------------------------------------------------------ *
 *  Keyframe helpers (PPRO API)
 * ------------------------------------------------------------------ */

function ZT_readScale(scaleProp) {
    if (!scaleProp) return 100;
    try {
        var v = scaleProp.getValue();
        if (v instanceof Array) return v[0];
        return v;
    } catch (e) {
        return 100;
    }
}

function ZT_addKeyWithValue(prop, timeSeconds, value, interpType, tag) {
    // Create a keyframe at timeSeconds, set its value, optionally set interp.
    if (!prop) return tag + ": no prop";
    var msgs = [];
    try {
        prop.addKey(timeSeconds);
    } catch (e) {
        // Some builds want a Time object, not seconds. Try that as fallback.
        try {
            var t = new Time();
            t.seconds = timeSeconds;
            prop.addKey(t);
            msgs.push("addKey(Time)");
        } catch (e2) {
            return tag + ": addKey failed (" + e + ")";
        }
    }
    try {
        prop.setValueAtKey(timeSeconds, value, true);
    } catch (e) {
        // Try with Time object.
        try {
            var t2 = new Time();
            t2.seconds = timeSeconds;
            prop.setValueAtKey(t2, value, true);
            msgs.push("setVal(Time)");
        } catch (e2) {
            // Fallback: set statically.
            try { prop.setValue(value, true); msgs.push("static fallback"); }
            catch (e3) { return tag + ": setValueAtKey failed (" + e2 + ")"; }
        }
    }
    if (interpType !== undefined) {
        try {
            var kt = prop.findNearestKey(timeSeconds, 0.05);
            if (kt !== undefined && kt !== null) {
                prop.setInterpolationTypeAtKey(kt, interpType, true);
            }
        } catch (e) { /* not all props/builds support this */ }
    }
    return tag + ": ok" + (msgs.length ? " (" + msgs.join(",") + ")" : "");
}

function ZT_easingToInterp(easing) {
    // PPRO: 0 = Linear, 4 = Hold, 5 = Bezier, 6 = Time.
    if (easing === "linear") return 0;
    if (easing === "easeIn" || easing === "easeOut" || easing === "easeInOut") return 5;
    return 0;
}

/* ------------------------------------------------------------------ *
 *  Diagnostics
 *  Returns a JSON-ish string the panel can show.
 * ------------------------------------------------------------------ */

function ZT_diagnose() {
    ZT_diagLines = [];
    try {
        ZT_diag("app.version = " + app.version);
        ZT_diag("app.build = " + app.build);
    } catch (e) { ZT_diag("app info error: " + e); }

    var seq = ZT_getActiveSequence();
    if (!seq) { ZT_diag("No active sequence."); return ZT_diagLines.join("\n"); }
    ZT_diag("active sequence = " + seq.name);

    var ac = ZT_getActiveClip(seq);
    if (!ac || !ac.clip) { ZT_diag("No clip under playhead."); return ZT_diagLines.join("\n"); }
    ZT_diag("clip = " + ac.clip.name + " (track " + ac.trackIndex + ", clip " + ac.clipIndex + ")");

    try {
        var pp = seq.getPlayerPosition();
        ZT_diag("playhead = " + pp.seconds + "s (" + pp.ticks + " ticks)");
    } catch (e) { ZT_diag("playhead error: " + e); }

    try {
        ZT_diag("clip.start = " + ac.clip.start.seconds + "s");
        ZT_diag("clip.end = " + ac.clip.end.seconds + "s");
    } catch (e) { ZT_diag("clip time error: " + e); }

    var qeOK = ZT_enableQE();
    ZT_diag("enableQE = " + qeOK);
    try {
        var qeSeq = qe.project.getActiveSequence();
        ZT_diag("qe.sequence = " + (qeSeq ? qeSeq.name : "null"));
    } catch (e) { ZT_diag("qe.sequence error: " + e); }

    // List components on the clip.
    try {
        var comps = ac.clip.components;
        ZT_diag("components (" + comps.numItems + "):");
        for (var i = 0; i < comps.numItems; i++) {
            var c = comps[i];
            ZT_diag("  [" + i + "] " + c.matchName + " / " + c.displayName);
        }
    } catch (e) { ZT_diag("components error: " + e); }

    // Look for Transform component and list its properties.
    var tf = ZT_findComponent(ac.clip, ZT_TRANSFORM_MATCHNAME);
    if (!tf) {
        ZT_diag("Transform component NOT present. Attempting to add via QE DOM...");
        try {
            var qeClip = qe.project.getActiveSequence().getVideoTrackAt(ac.trackIndex).getItemAt(ac.clipIndex);
            qeClip.addVideoEffect(qe.project.getVideoEffectByName(ZT_TRANSFORM_DISPLAYNAME));
        } catch (e) { ZT_diag("addVideoEffect error: " + e); }
        tf = ZT_findComponent(ac.clip, ZT_TRANSFORM_MATCHNAME);
    }
    if (tf) {
        ZT_diag("Transform component present.");
        var names = ZT_listPropNames(tf);
        ZT_diag("Transform properties (" + names.length + "):");
        for (var j = 0; j < names.length; j++) ZT_diag("  - " + names[j]);

        // Report scale value and timeVarying.
        var sp = ZT_findPropByLabel(tf, ZT_PROP_SCALE_LABEL);
        if (sp) {
            ZT_diag("Scale.getValue() = " + ZT_readScale(sp));
            try { ZT_diag("Scale.isTimeVarying() = " + sp.isTimeVarying()); } catch (e) {}
            try { ZT_diag("Scale keys = " + sp.getKeys().length); } catch (e) {}
        } else {
            ZT_diag("Scale property NOT found.");
        }
    } else {
        ZT_diag("Transform component still NOT present after add attempt.");
    }

    return ZT_diagLines.join("\n");
}
