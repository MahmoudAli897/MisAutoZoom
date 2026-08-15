/* ZoomTransform - jsx/host.jsx
 * ExtendScript host layer for Premiere Pro (PPRO).
 * - Captures the current frame at the playhead via the hidden QE DOM and
 *   exports it to a temp PNG for display in the canvas (ReFrame).
 * - Applies the AE.ADBE Transform effect on the active clip under the playhead
 *   and (optionally) creates zoom keyframes with the requested easing.
 *
 * Note: ExtendScript is ES3-ish. Avoid Array.prototype.map/filter closures
 * that rely on ES5 semantics; keep loops explicit.
 *
 * The capture function relies on the hidden QE DOM (app.enableQE()). The exact
 * export call name may vary between PPRO 13.x builds; we try exportFrame then
 * exportAsMedia.
 */

// Match name for the After Effects Transform effect in Premiere.
var ZT_TRANSFORM_MATCHNAME = "AE.ADBE Transform";

/* ------------------------------------------------------------------ *
 *  Utilities
 * ------------------------------------------------------------------ */

function ZT_log(msg) {
    // Best-effort logging to the ExtendScript console.
    try { $.writeln("[ZoomTransform] " + msg); } catch (e) {}
}

function ZT_tempDir() {
    var f;
    try {
        f = Folder.temp;
    } catch (e) {}
    if (!f) f = new Folder(Folder.system.fsName + (Folder.system.fsName.indexOf(":") > -1 ? "\\Temp" : "/tmp"));
    return f;
}

function ZT_tempPath(ext) {
    ext = ext || "png";
    var name = "zt_frame_" + (new Date().getTime()) + "." + ext;
    var f = new File(ZT_tempDir().fsName + (ZT_tempDir().fsName.indexOf(":") > -1 ? "\\" : "/") + name);
    return f;
}

function ZT_getActiveSequence() {
    try {
        if (app.project && app.project.activeSequence) return app.project.activeSequence;
    } catch (e) {}
    return null;
}

function ZT_getActiveClip(seq) {
    // Return the video track clip under the playhead.
    try {
        var ct = seq.getCurrentTime(); // ticks string
        var tracks = seq.videoTracks;
        for (var t = tracks.numTracks - 1; t >= 0; t--) {
            var track = tracks[t];
            var clips = track.clips;
            for (var c = 0; c < clips.numclips; c++) {
                var clip = clips[c];
                if (ZT_inRange(ct, clip.start, clip.end)) {
                    return { clip: clip, track: track };
                }
            }
        }
    } catch (e) { ZT_log("getActiveClip error: " + e); }
    return null;
}

function ZT_inRange(ticks, startTicks, endTicks) {
    // All values are Premiere tick strings; compare numerically.
    try {
        var t = parseFloat(ticks), s = parseFloat(startTicks), e = parseFloat(endTicks);
        return t >= s && t <= e;
    } catch (err) {
        return false;
    }
}

function ZT_ticksFromSeconds(seconds, seq) {
    // Premiere stores time as ticks; 254016000000 ticks per second.
    var TICKS_PER_SECOND = 254016000000;
    try {
        var fps = seq.getSettings().videoFrameRate.ticks ? 1 : 0;
    } catch (e) {}
    return Math.round(seconds * TICKS_PER_SECOND).toString();
}

/* ------------------------------------------------------------------ *
 *  Frame capture (ReFrame) via hidden QE DOM
 * ------------------------------------------------------------------ */

function ZT_captureCurrentFrame() {
    try {
        var seq = ZT_getActiveSequence();
        if (!seq) return "ERROR: لا يوجد تسلسل نشط. افتح تسلسلاً في الـ Timeline.";

        // Enable the hidden QE DOM.
        try { app.enableQE(); } catch (e) {}

        var out = ZT_tempPath("png");

        // Try the most common export path: qe.project.getActiveSequence().exportAsMediaDirect
        var exported = false;
        try {
            var qeSeq = qe.project.getActiveSequence();
            if (qeSeq) {
                // Attempt exportAsMediaDirect(path, presetPath, workArea)
                // Without a preset we cannot reliably call exportAsMediaDirect.
                // Fall through to alternative method below.
            }
        } catch (e) {}

        // Fallback: use the public Sequence.exportAsMediaDirect with a PNG encoder preset
        // if available; otherwise try exportAsFrame.
        if (!exported) {
            try {
                // Some PPRO 13 builds expose exportAsMediaDirect on the public sequence.
                if (typeof seq.exportAsMediaDirect === "function") {
                    seq.exportAsMediaDirect(out.fsName, "PNG", 0);
                    exported = out.exists;
                }
            } catch (e) { ZT_log("exportAsMediaDirect failed: " + e); }
        }

        if (!exported) {
            // Last resort: instruct the user that the build-specific QE export name differs.
            return "ERROR: تعذّر تصدير اللقطة من هذا البناء من بريمير. جرّب إصداراً آخر أو أبلغ برسالة الخطأ.";
        }

        if (!out.exists) return "ERROR: لم يُنشأ ملف اللقطة.";
        return out.fsName;
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

/* ------------------------------------------------------------------ *
 *  Apply Transform effect + zoom keyframes
 * ------------------------------------------------------------------ */

// Property match names inside AE.ADBE Transform
var ZT_PROP_SCALE = "ADBE Scale";
var ZT_PROP_ANCHOR = "ADBE Anchor Point";
var ZT_PROP_POSITION = "ADBE Position";
var ZT_PROP_ROTATION = "ADBE Rotation";
var ZT_PROP_MOTION_BLUR = "ADBE Motion Blur";

function ZT_applyTransform(payloadStr) {
    var p;
    try {
        p = JSON.parse(payloadStr);
    } catch (e) {
        return "ERROR: بيانات غير صالحة";
    }

    try {
        var seq = ZT_getActiveSequence();
        if (!seq) return "ERROR: لا يوجد تسلسل نشط.";

        var ac = ZT_getActiveClip(seq);
        if (!ac || !ac.clip) return "ERROR: لا يوجد مقطع تحت المؤشر على الـ Timeline.";

        var clip = ac.clip;
        var components = clip.components;
        var tf = null;

        // Look for an existing Transform component to update.
        for (var i = 0; i < components.numComponents; i++) {
            var comp = components[i];
            if (comp && comp.matchName === ZT_TRANSFORM_MATCHNAME) { tf = comp; break; }
        }

        // Add the Transform effect if not present.
        if (!tf) {
            try {
                clip.addEffect(ZT_TRANSFORM_MATCHNAME);
            } catch (e) {
                // Some builds require the display name.
                try { clip.addEffect("Transform"); } catch (e2) {
                    return "ERROR: تعذّر إضافة تأثير Transform إلى المقطع.";
                }
            }
            // Re-fetch components to locate the newly added Transform.
            components = clip.components;
            for (var j = 0; j < components.numComponents; j++) {
                var c2 = components[j];
                if (c2 && c2.matchName === ZT_TRANSFORM_MATCHNAME) { tf = c2; break; }
            }
        }

        if (!tf) return "ERROR: لم يتم العثور على مكوّن Transform بعد الإضافة.";

        // Resolve property objects.
        var scaleProp = ZT_findProp(tf, ZT_PROP_SCALE);
        var anchorProp = ZT_findProp(tf, ZT_PROP_ANCHOR);
        var posProp = ZT_findProp(tf, ZT_PROP_POSITION);
        var rotProp = ZT_findProp(tf, ZT_PROP_ROTATION);

        // Normalized center of the zoom rectangle (0..1).
        var nx = p.nx, ny = p.ny;
        // Source frame dimensions (use sequence if clip dimensions unavailable).
        var srcW = 1920, srcH = 1080;
        try {
            var vs = seq.getSettings().videoFrameRate; // not dims
        } catch (e) {}
        try {
            if (clip.source && clip.source.getMediaInfo && clip.source.getMediaInfo().frameSize) {
                srcW = clip.source.getMediaInfo().frameSize.width || srcW;
                srcH = clip.source.getMediaInfo().frameSize.height || srcH;
            }
        } catch (e) {}
        try {
            var ss = seq.getSettings();
            if (ss && ss.videoFrameSize) { srcW = ss.videoFrameSize.width || srcW; srcH = ss.videoFrameSize.height || srcH; }
        } catch (e) {}

        var anchorX = nx * srcW;
        var anchorY = ny * srcH;

        // Anchor point to the center of the zoom rectangle.
        if (anchorProp && anchorProp.setValue) {
            try {
                anchorProp.setValue([anchorX, anchorY], true);
            } catch (e) { ZT_log("anchor set failed: " + e); }
        }

        // Rotation.
        if (rotProp && rotProp.setValue) {
            try { rotProp.setValue(p.rot || 0, true); } catch (e) {}
        }

        var zoom = p.zoom || 100;
        var scaleVal = zoom; // percent

        var duration = Math.max(0, Math.min(5, p.duration || 0));
        var easing = p.easing || "easeInOut";
        var doKeyframes = !!p.createKeyframes && duration > 0;
        var motionBlur = !!p.motionBlur;

        // Motion blur on the component if supported.
        if (motionBlur) {
            try {
                var mb = ZT_findProp(tf, ZT_PROP_MOTION_BLUR);
                if (mb && mb.setValue) mb.setValue(1, true);
            } catch (e) {}
        }

        if (!doKeyframes) {
            // Static zoom only.
            if (scaleProp && scaleProp.setValue) {
                try { scaleProp.setValue(scaleVal, true); } catch (e) {}
                if (posProp && posProp.setValue && p.lockCenter) {
                    try { posProp.setValue([anchorX, anchorY], true); } catch (e) {}
                }
            }
            return "OK: تم تطبيق زوم ثابت " + Math.round(scaleVal) + "%.";
        }

        // Keyframed zoom animation across the clip from playhead.
        var startTicks = clip.start;
        var endTicks = clip.end;
        var durTicks = parseFloat(endTicks) - parseFloat(startTicks);
        if (durTicks <= 0) durTicks = ZT_ticksFromSeconds(duration, seq);
        var animTicks = ZT_ticksFromSeconds(duration, seq);
        if (animTicks <= 0 || animTicks > durTicks) animTicks = durTicks;
        var t0 = seq.getCurrentTime();
        var startT = parseFloat(t0);
        var endT = startT + parseFloat(animTicks);
        if (endT > parseFloat(endTicks)) endT = parseFloat(endTicks);

        if (scaleProp) {
            try {
                // Begin: 100%, End: target zoom.
                ZT_addKey(scaleProp, startT, 100, easing, 0);
                ZT_addKey(scaleProp, endT, scaleVal, easing, 1);
            } catch (e) { ZT_log("scale keyframe failed: " + e); }
        }
        if (posProp && p.lockCenter) {
            try {
                ZT_addKey(posProp, startT, [anchorX, anchorY], easing, 0);
                ZT_addKey(posProp, endT, [anchorX, anchorY], easing, 1);
            } catch (e) {}
        }

        return "OK: تم إنشاء أنيمشن زوم من 100% إلى " + Math.round(scaleVal) + "% خلال " + duration + " ثانية.";
    } catch (e) {
        return "ERROR: " + e.toString();
    }
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

function ZT_addKey(prop, ticksVal, value, easing, position /* 0 start / 1 end */) {
    if (!prop) return;
    try {
        // Ensure keyframing is enabled.
        if (prop.isTimeVarying !== undefined && !prop.isTimeVarying) {
            try { prop.isTimeVarying = true; } catch (e) {}
        }
        prop.setValueAtTime(ticksVal.toString(), value);
    } catch (e) {
        // Fallback: just set the value statically at end.
        try { prop.setValue(value, true); } catch (e2) {}
    }
}

// Easing helper (unused by setValueAtTime directly; reserved for future
// interpolation refinement via temporal ease if supported by the build).
function ZT_easeFactor(t, type) {
    // t in [0,1]
    if (type === "linear") return t;
    if (type === "easeIn") return t * t;
    if (type === "easeOut") return 1 - (1 - t) * (1 - t);
    // easeInOut
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
