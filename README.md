# ZoomTransform

An Adobe CEP (CEP 9 / CSXS.9) extension for **Adobe Premiere Pro 2020 (13.x)** that creates a **Transform effect** with an **interactive zoom animation** drawn as a rectangle on a canvas.

![CEP](https://img.shields.io/badge/CEP-9%20(CSXS.9)-blue) ![Premiere Pro](https://img.shields.io/badge/Premiere%20Pro-2020%20(13.x)-purple)

---

## Features

### Canvas & Drawing
- **ReFrame** button captures the frame at the current playhead through the hidden **QE DOM** and shows it as the canvas background, so you can see the actual frame before applying the zoom.
- **Draw the rectangle** by dragging on the canvas. The rectangle size is the zoom amount.
- **Move** the rectangle after drawing it by pressing inside it and dragging.
- **Rotate** the rectangle via the circular handle above it.
- **Resize** by dragging any of the four corner handles (the opposite corner stays fixed, even while rotated).
- **Wheel zoom** over the rectangle to scale it.
- **Four-section grid** (rule of thirds + center cross) for precise framing.

### Zoom & Values
- The zoom value is written **inside the rectangle** and updates live.
- Zoom is derived from the **rectangle area to canvas area ratio**: a full rectangle = 100%, the smallest rectangle approaches the maximum.
- **Customizable max zoom**: default 600 (adjustable from 100 to 1000).
- A readout panel shows: zoom, position, size, rotation.

### Animation & Application
- **Transition duration** from 0 to 5 seconds.
- Easing types: `Linear` / `Ease In` / `Ease Out` / `Ease InOut`.
- Options: Motion Blur, Create Keyframes, Lock Zoom Center.
- **Apply Transform** button adds the Transform effect (match name `AE.ADBE Transform`) on the clip under the playhead, sets the Anchor Point to the rectangle center, and creates **zoom keyframes**: a start keyframe at the current playhead time holding the clip's *current* scale, and an end keyframe after the chosen transition duration holding the target zoom derived from the rectangle.

---

## Project Structure

```
ZoomTransform/
├── CSXS/manifest.xml      ← CSXS.9 (PPRO 13.x / 2020)
├── .debug                 ← local debug port (8088)
├── index.html             ← panel UI
├── css/style.css          ← dark theme matching Premiere
├── js/main.js             ← canvas drawing + rectangle manipulation + zoom derivation
├── lib/CSInterface.js     ← official Adobe CEP v9.4.0
├── jsx/host.jsx           ← Premiere interaction (QE DOM + Transform effect + keyframes)
└── README.md             ← installation and usage
```

---

## Installation

### 1) Copy the extension to the extensions folder

Copy the entire `ZoomTransform` folder to:

| OS | Path |
|----|------|
| **Windows** | `C:\Users\<USER>\AppData\Roaming\Adobe\CEP\extensions\ZoomTransform` |
| **macOS** | `~/Library/Application Support/Adobe/CEP/extensions/ZoomTransform` |

> Create the `CEP/extensions` folder if it does not exist.

### 2) Enable PlayerDebugMode

The extension is unsigned, so `PlayerDebugMode` must be enabled.

#### Windows (Registry)
```bat
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.9" /v PlayerDebugMode /t REG_SZ /d 1 /f
```

#### macOS (Terminal)
```bash
defaults write com.adobe.CSXS.9 PlayerDebugMode 1
killall cfprefsd
```

### 3) Restart and open

- Restart **Adobe Premiere Pro 2020**.
- Open the panel from: **Window → Extensions → ZoomTransform**.

---

## Usage

1. Place a clip on the Timeline and move the playhead to the frame you want to zoom into.
2. Click **ReFrame** to capture the frame and show it on the canvas.
3. Adjust **Max Zoom**, **Transition duration**, and **Easing** as needed.
4. Drag on the canvas to draw the zoom rectangle, then move / rotate / resize it to select the region.
5. (Optional) Toggle **Grid**, **Motion Blur**, **Create Keyframes**, **Lock Zoom Center**.
6. Click **Apply Transform** to add the effect on the clip under the playhead.

### Keyframe behavior

When **Create Keyframes** is on (and the transition duration is greater than 0), the extension:

1. Reads the clip's **current scale** value (the zoom that was already applied).
2. Creates a **start keyframe** at the current playhead time holding that current scale.
3. Creates an **end keyframe** at `playhead + transition duration` holding the **target zoom** derived from the rectangle.

So the animation transitions from the zoom that existed *before* using the extension, to the zoom you drew, over the chosen duration (e.g. `0.8s`).

---

## Technical Notes

- **ReFrame** relies on the hidden **QE DOM** (`app.enableQE()`). The exact export call name (`exportAsMediaDirect` / `exportAsMedia`) may differ between PPRO 13.x builds. If you see *"Could not export the frame"*, report the exact error so the QE call can be adjusted for your build.
- The **Transform effect** is added by match name `AE.ADBE Transform`. Rarely, a build may require the display name `"Transform"` — both are tried automatically.
- The **Anchor Point** is set to the center of the zoom rectangle (in pixel space) so scaling happens about the selected region. With **Lock Zoom Center** on, Position keyframes are also created to keep the region centered in the frame.
- Because the extension is unsigned, running it requires `PlayerDebugMode` as described above.

---

## Development & Debugging

The `.debug` file sets the local port **8088**. Open the debug UI in a browser at:
```
http://localhost:8088
```

---

## License

This project is open source for free use and development. The file `lib/CSInterface.js` is owned by Adobe and licensed under Adobe's terms (see the file header).
