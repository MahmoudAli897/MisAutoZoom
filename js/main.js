/* ZoomTransform - main.js
 * Canvas drawing + rectangle manipulation + zoom value derivation.
 * Talks to Premiere Pro via jsx/host.jsx through CSInterface.
 *
 * Rectangle model: {x, y, w, h, rot} where (x,y) is the top-left corner in
 * pre-rotation canvas space, and rotation is applied about the rect center.
 */
(function () {
    "use strict";

    var cs = new CSInterface();
    var THEME_CHANGED = "com.adobe.csxs.events.ThemeColorChanged";
    var THEME_PPRO = "com.adobe.csxs.events.ApplicationThemeChanged";

    // ---------- Elements ----------
    var canvas = document.getElementById("canvas");
    var ctx = canvas.getContext("2d");
    var hint = document.getElementById("canvas-hint");
    var btnReframe = document.getElementById("btn-reframe");
    var btnClear = document.getElementById("btn-clear");
    var btnApply = document.getElementById("btn-apply");
    var toggleGrid = document.getElementById("toggle-grid");
    var maxZoomInput = document.getElementById("max-zoom");
    var durationInput = document.getElementById("duration");
    var durationVal = document.getElementById("duration-val");
    var easingSel = document.getElementById("easing");
    var motionBlur = document.getElementById("motion-blur");
    var createKeyframes = document.getElementById("create-keyframes");
    var lockCenter = document.getElementById("lock-center");
    var roZoom = document.getElementById("ro-zoom");
    var roPos = document.getElementById("ro-pos");
    var roSize = document.getElementById("ro-size");
    var roRot = document.getElementById("ro-rot");
    var statusEl = document.getElementById("status");

    // ---------- State ----------
    var state = {
        bgImage: null,        // HTMLImageElement of captured frame
        rect: null,           // {x,y,w,h,rot} in canvas coords
        drawMode: false,      // currently drawing a new rect by dragging
        dragMode: null,       // 'move' | 'resize' | 'rotate' | null
        dragHandle: null,     // 0..3 corner index
        dragStart: null,      // {mx,my, rect snapshot, oppositeWorld}
        showGrid: true,
        themeColor: "#2b2b2b"
    };

    var HANDLE_SIZE = 8;
    var ROT_HANDLE_DIST = 22;

    // ---------- Theme ----------
    function applyTheme() {
        try {
            var info = cs.getHostEnvironment();
            if (info && info.appSkinInfo) {
                var c = info.appSkinInfo.panelBackgroundColor;
                if (c && c.color) {
                    var rgb = c.color;
                    var hex = "#" + toHex(rgb.red) + toHex(rgb.green) + toHex(rgb.blue);
                    document.documentElement.style.setProperty("--bg", hex);
                    state.themeColor = hex;
                }
            }
        } catch (e) { /* default dark theme */ }
    }
    function toHex(n) { var s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length === 1 ? "0" + s : s; }
    cs.addEventListener(THEME_CHANGED, applyTheme);
    cs.addEventListener(THEME_PPRO, applyTheme);
    applyTheme();

    // ---------- Geometry helpers ----------
    function getMouse(e) {
        var r = canvas.getBoundingClientRect();
        var scaleX = canvas.width / r.width;
        var scaleY = canvas.height / r.height;
        return {
            mx: (e.clientX - r.left) * scaleX,
            my: (e.clientY - r.top) * scaleY
        };
    }

    function rectCenter(r) { return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 }; }

    function rotatePoint(px, py, cx, cy, ang) {
        var s = Math.sin(ang), c = Math.cos(ang);
        var dx = px - cx, dy = py - cy;
        return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
    }

    function localToWorld(localPt, r) {
        // localPt is relative to pre-rotation rect (origin at r.x,r.y)
        return rotatePoint(r.x + localPt.x, r.y + localPt.y, r.x + r.w / 2, r.y + r.h / 2, r.rot);
    }

    function worldToLocal(worldPt, r) {
        // invert rotation around center, then subtract origin
        var ctr = rectCenter(r);
        var p = rotatePoint(worldPt.x, worldPt.y, ctr.cx, ctr.cy, -r.rot);
        return { x: p.x - r.x, y: p.y - r.y };
    }

    function corners(r) {
        return [
            localToWorld({ x: 0, y: 0 }, r),
            localToWorld({ x: r.w, y: 0 }, r),
            localToWorld({ x: r.w, y: r.h }, r),
            localToWorld({ x: 0, y: r.h }, r)
        ];
    }

    function pointInRect(worldPt, r) {
        var lp = worldToLocal(worldPt, r);
        return lp.x >= 0 && lp.x <= r.w && lp.y >= 0 && lp.y <= r.h;
    }

    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

    function handleAt(worldPt, r) {
        var cs2 = corners(r);
        for (var i = 0; i < 4; i++) {
            if (dist(worldPt, cs2[i]) <= HANDLE_SIZE + 2) return i;
        }
        // rotate handle: along the outward normal of the top edge, in world coords
        var normal = localToWorld({ x: r.w / 2, y: -ROT_HANDLE_DIST }, r);
        if (dist(worldPt, normal) <= HANDLE_SIZE + 4) return "rot";
        return null;
    }

    // ---------- Zoom value ----------
    function computeZoom() {
        if (!state.rect) return 100;
        var maxZoom = clamp(parseInt(maxZoomInput.value, 10) || 600, 100, 1000);
        // area-based: full canvas = 100%, smallest reasonable -> maxZoom
        var canvasArea = canvas.width * canvas.height;
        var rectArea = Math.abs(state.rect.w * state.rect.h);
        if (rectArea <= 0) return 100;
        var ratio = rectArea / canvasArea; // 0..1
        // map ratio 1 -> 100%, ratio ->0 -> maxZoom
        var zoom = 100 + (maxZoom - 100) * (1 - Math.min(1, ratio));
        return Math.round(zoom);
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    // ---------- Drawing ----------
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // background image or placeholder
        if (state.bgImage) {
            drawImageCover(state.bgImage, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = "#151515";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        if (state.showGrid) drawGrid();
        if (state.rect) drawRect(state.rect);
    }

    function drawImageCover(img, dx, dy, dw, dh) {
        var ir = img.width / img.height;
        var cr = dw / dh;
        var sw, sh, sx, sy;
        if (ir > cr) {
            sh = img.height; sw = sh * cr;
            sx = (img.width - sw) / 2; sy = 0;
        } else {
            sw = img.width; sh = sw / cr;
            sx = 0; sy = (img.height - sh) / 2;
        }
        ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    }

    function drawGrid() {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        // thirds
        for (var i = 1; i < 3; i++) {
            ctx.beginPath(); ctx.moveTo(canvas.width * i / 3, 0); ctx.lineTo(canvas.width * i / 3, canvas.height); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, canvas.height * i / 3); ctx.lineTo(canvas.width, canvas.height * i / 3); ctx.stroke();
        }
        // center cross
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        ctx.beginPath(); ctx.moveTo(canvas.width / 2, 0); ctx.lineTo(canvas.width / 2, canvas.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
        ctx.restore();
    }

    function drawRect(r) {
        var ctr = rectCenter(r);
        ctx.save();
        ctx.translate(ctr.cx, ctr.cy);
        ctx.rotate(r.rot);
        ctx.translate(-r.w / 2, -r.h / 2);

        // fill
        ctx.fillStyle = "rgba(43,140,255,0.18)";
        ctx.fillRect(0, 0, r.w, r.h);

        // border
        ctx.strokeStyle = "#2b8cff";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(0, 0, r.w, r.h);

        // center crosshair inside
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.beginPath(); ctx.moveTo(r.w / 2, 0); ctx.lineTo(r.w / 2, r.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, r.h / 2); ctx.lineTo(r.w, r.h / 2); ctx.stroke();
        ctx.setLineDash([]);

        // handles
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#2b8cff";
        var hs = HANDLE_SIZE / 2;
        drawHandle(0, 0, hs);
        drawHandle(r.w, 0, hs);
        drawHandle(r.w, r.h, hs);
        drawHandle(0, r.h, hs);

        // rotate handle
        ctx.beginPath();
        ctx.moveTo(r.w / 2, 0);
        ctx.lineTo(r.w / 2, -ROT_HANDLE_DIST);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(r.w / 2, -ROT_HANDLE_DIST, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#2b8cff";
        ctx.fill();

        // zoom label
        var zoom = computeZoom();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        var label = zoom + "%";
        // bg pill
        var tw = ctx.measureText(label).width + 10;
        var th = 18;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        roundRect(ctx, r.w / 2 - tw / 2, r.h / 2 - th / 2, tw, th, 4);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.fillText(label, r.w / 2, r.h / 2);

        ctx.restore();
    }

    function drawHandle(x, y, hs) {
        ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
        ctx.strokeRect(x - hs, y - hs, hs * 2, hs * 2);
    }

    function roundRect(c, x, y, w, h, rad) {
        c.beginPath();
        c.moveTo(x + rad, y);
        c.arcTo(x + w, y, x + w, y + h, rad);
        c.arcTo(x + w, y + h, x, y + h, rad);
        c.arcTo(x, y + h, x, y, rad);
        c.arcTo(x, y, x + w, y, rad);
        c.closePath();
    }

    // ---------- Readout ----------
    function updateReadout() {
        var z = computeZoom();
        roZoom.textContent = z + "%";
        if (state.rect) {
            var ctr = rectCenter(state.rect);
            roPos.textContent = Math.round(ctr.cx) + "," + Math.round(ctr.cy);
            roSize.textContent = Math.round(state.rect.w) + "x" + Math.round(state.rect.h);
            roRot.textContent = Math.round(state.rect.rot * 180 / Math.PI) + " deg";
        } else {
            roPos.textContent = "--";
            roSize.textContent = "--";
            roRot.textContent = "0 deg";
        }
        btnApply.disabled = !state.rect;
    }

    // ---------- Mouse interaction ----------
    function onDown(e) {
        var p = getMouse(e);
        if (state.rect) {
            var h = handleAt(p, state.rect);
            if (h === "rot") {
                state.dragMode = "rotate";
                state.dragStart = { mx: p.mx, my: p.my, rect: cloneRect(state.rect) };
                return;
            } else if (typeof h === "number") {
                // resize: keep opposite corner fixed in world
                var cs2 = corners(state.rect);
                var opposite = cs2[(h + 2) % 4];
                state.dragMode = "resize";
                state.dragHandle = h;
                state.dragStart = { mx: p.mx, my: p.my, rect: cloneRect(state.rect), oppositeWorld: opposite };
                return;
            } else if (pointInRect(p, state.rect)) {
                state.dragMode = "move";
                state.dragStart = { mx: p.mx, my: p.my, rect: cloneRect(state.rect) };
                return;
            }
        }
        // start drawing a new rect
        state.drawMode = true;
        state.rect = { x: p.mx, y: p.my, w: 0, h: 0, rot: 0 };
        state.dragStart = { mx: p.mx, my: p.my };
        hint.classList.add("hidden");
    }

    function onMove(e) {
        var p = getMouse(e);
        if (state.drawMode) {
            var s = state.dragStart;
            var x = Math.min(s.mx, p.mx), y = Math.min(s.my, p.my);
            var w = Math.abs(p.mx - s.mx), h = Math.abs(p.my - s.my);
            state.rect = { x: x, y: y, w: w, h: h, rot: 0 };
            draw(); updateReadout();
            return;
        }
        if (!state.dragMode) return;
        var d = state.dragStart;
        var dx = p.mx - d.mx, dy = p.my - d.my;

        if (state.dragMode === "move") {
            state.rect.x = d.rect.x + dx;
            state.rect.y = d.rect.y + dy;
        } else if (state.dragMode === "rotate") {
            var ctr = rectCenter(d.rect);
            var ang0 = Math.atan2(d.my - ctr.cy, d.mx - ctr.cx);
            var ang1 = Math.atan2(p.my - ctr.cy, p.mx - ctr.cx);
            state.rect.rot = d.rect.rot + (ang1 - ang0);
        } else if (state.dragMode === "resize") {
            // Keep opposite corner fixed in world; rebuild rect in local frame of fixed opposite corner.
            var opp = d.oppositeWorld;
            // local axes (rotated by d.rect.rot)
            var ang = d.rect.rot;
            var ux = { x: Math.cos(ang), y: Math.sin(ang) };
            var uy = { x: -Math.sin(ang), y: Math.cos(ang) };
            // vector from opposite to mouse in world
            var vx = p.mx - opp.x, vy = p.my - opp.y;
            // project onto axes
            var a = vx * ux.x + vy * ux.y;
            var b = vx * uy.x + vy * uy.y;
            // new width/height (signed)
            var nw = Math.abs(a), nh = Math.abs(b);
            // Determine new top-left (local origin) so that the opposite corner stays at `opp`.
            var signA = a >= 0 ? 1 : -1;
            var signB = b >= 0 ? 1 : -1;
            // origin in world = opp - signA*nw*ux - signB*nh*uy
            var ox = opp.x - signA * nw * ux.x - signB * nh * uy.x;
            var oy = opp.y - signA * nw * ux.y - signB * nh * uy.y;
            state.rect = { x: ox, y: oy, w: Math.max(10, nw), h: Math.max(10, nh), rot: ang };
        }
        draw(); updateReadout();
    }

    function onUp(e) {
        if (state.drawMode) {
            state.drawMode = false;
            if (state.rect && (state.rect.w < 8 || state.rect.h < 8)) {
                state.rect = null;
            }
        }
        state.dragMode = null;
        state.dragHandle = null;
        state.dragStart = null;
        draw(); updateReadout();
    }

    function onWheel(e) {
        if (!state.rect) return;
        var p = getMouse(e);
        if (!pointInRect(p, state.rect)) return;
        e.preventDefault();
        var factor = e.deltaY < 0 ? 1.06 : 0.94;
        var r = state.rect;
        var ctr = rectCenter(r);
        // scale around center, keep rotation
        var nw = clamp(r.w * factor, 10, canvas.width);
        var nh = clamp(r.h * factor, 10, canvas.height);
        // keep center fixed: new x,y so center stays
        r.x = ctr.cx - nw / 2 * Math.cos(r.rot) + nh / 2 * Math.sin(r.rot);
        r.y = ctr.cy - nw / 2 * Math.sin(r.rot) - nh / 2 * Math.cos(r.rot);
        r.w = nw; r.h = nh;
        draw(); updateReadout();
    }

    function cloneRect(r) { return { x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot }; }

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // ---------- Controls ----------
    toggleGrid.addEventListener("change", function () { state.showGrid = toggleGrid.checked; draw(); });
    maxZoomInput.addEventListener("input", function () { draw(); updateReadout(); });
    durationInput.addEventListener("input", function () { durationVal.textContent = parseFloat(durationInput.value).toFixed(1); });

    btnClear.addEventListener("click", function () {
        state.rect = null;
        draw(); updateReadout();
    });

    // ---------- ReFrame: capture current frame via QE DOM ----------
    btnReframe.addEventListener("click", function () {
        setStatus("Capturing frame...", "");
        // call jsx to export current frame to temp PNG
        cs.evalScript("ZT_captureCurrentFrame()", function (result) {
            if (!result || result === "EvalScript error.") {
                setStatus("Failed to export the frame. Make sure a clip exists on the Timeline.", "error");
                return;
            }
            var path = result.replace(/^"|"$/g, "");
            if (path.indexOf("ERROR") === 0) {
                setStatus(path, "error");
                return;
            }
            var img = new Image();
            img.onload = function () {
                state.bgImage = img;
                hint.classList.add("hidden");
                draw();
                setStatus("Frame captured", "ok");
            };
            img.onerror = function () { setStatus("Failed to load the frame image: " + path, "error"); };
            img.src = "file://" + path;
        });
    });

    // ---------- Apply Transform ----------
    btnApply.addEventListener("click", function () {
        if (!state.rect) return;
        var r = state.rect;
        var ctr = rectCenter(r);
        var zoom = computeZoom();
        // Normalized center of the zoom rectangle in the frame (0..1).
        var nx = ctr.cx / canvas.width;
        var ny = ctr.cy / canvas.height;
        var nw = r.w / canvas.width;
        var nh = r.h / canvas.height;
        var rotDeg = r.rot * 180 / Math.PI;
        var payload = JSON.stringify({
            nx: nx,
            ny: ny,
            nw: nw,
            nh: nh,
            zoom: zoom,
            rot: rotDeg,
            duration: parseFloat(durationInput.value),
            easing: easingSel.value,
            motionBlur: motionBlur.checked,
            createKeyframes: createKeyframes.checked,
            lockCenter: lockCenter.checked,
            maxZoom: parseInt(maxZoomInput.value, 10) || 600
        });
        setStatus("Applying transform...", "");
        cs.evalScript("ZT_applyTransform(" + JSON.stringify(payload) + ")", function (res) {
            if (!res || res === "EvalScript error." || res.indexOf("ERROR") === 0) {
                setStatus("Apply failed: " + (res || ""), "error");
            } else {
                setStatus("Transform effect applied", "ok");
            }
        });
    });

    function setStatus(msg, kind) {
        statusEl.textContent = msg;
        statusEl.className = "status" + (kind ? " " + kind : "");
    }

    // ---------- Init ----------
    // Resize canvas to wrap aspect
    function fitCanvas() {
        var wrap = document.getElementById("canvas-wrap");
        var w = wrap.clientWidth - 2;
        var h = Math.round(w * 9 / 16);
        if (h > 260) h = 260;
        canvas.width = w;
        canvas.height = h;
        draw();
    }
    window.addEventListener("resize", fitCanvas);
    fitCanvas();
    updateReadout();
})();
