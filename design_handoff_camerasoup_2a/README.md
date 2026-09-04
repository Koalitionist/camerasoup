# Handoff: camerasoup visual redesign — direction 2a "Poster + pills"

## Overview
A new visual identity for the camerasoup studio app (`studio/` Vite + React workspace). Direction 2a replaces the current dark, Satoshi, hairline-bordered UI with a Swiss-poster look: a huge lowercase `camerasoup` wordmark rotated down the left spine, Helvetica Neue throughout, a light warm-white ground for the website/phone-join pages and a near-black ground for the studio and editor, and **one saturated color per camera angle** carried through the camera spines, tags, program outline and timeline. Every color block is a **half-pill** (rounded on the end away from the screen edge); every panel, button and tag is rounded.

Functionality is unchanged. This is a re-skin plus layout change of existing screens — all data, hotkeys and flows stay as implemented in `studio/src`.

## About the Design Files
`camerasoup - redesign.dc.html` is a **design reference built in HTML** — a static mock showing intended look and layout, not production code. Recreate it inside the existing `studio/` React app: replace class rules in `studio/src/styles.css` and restructure JSX in `pages/Home.tsx`, `pages/Studio.tsx`, `components/ControlView.tsx`, `pages/Edit.tsx`, `pages/Join.tsx` (and by extension `RemoteControl.tsx`, `Check.tsx`, `Camera.tsx`). Keep the existing component boundaries (`ControlView` renders both Mac and iPad), state and hotkeys. Look at the `#2a` section only; `#1a`/`#1b`/`#1c` are earlier explorations, and `camerasoup - current.dc.html` is a recreation of today's UI for comparison.

## Fidelity
**High-fidelity for visual language** (colors, type, radii, spacing, component treatments — recreate as specified). **Medium for exact pixel positions** — frames were drawn at 1200×760 (site), 1440×900 (studio/editor), 390×844 (phone); the real app is fluid, so translate widths to flex/grid as noted. Camera feeds are striped placeholders; real `<video>` elements go there.

## Design Tokens

Typography
- Family: `"Helvetica Neue", Helvetica, Arial, sans-serif` (replace the Satoshi `@font-face`; `fonts/Satoshi-Variable.woff2` can be removed).
- Weights: 700 for everything that is a label, number, name, button or heading; 500 for meta/body; 300 for the `+` glyph.
- Display tracking: `letter-spacing: -0.05em` on the wordmark, `-0.04em` on spine labels and h1s, `-0.03em` on 22–36 px, `-0.02em` on 18–20 px. Body has none.
- Wordmark: lowercase `camerasoup`, 700, `line-height: .8`, rotated `-90deg` with `transform-origin: left bottom` and `translateY(100%)`, anchored bottom-left of a 200 px (desktop) / 104 px (phone) spine column. Size so the whole word fits: 126 px desktop, 92 px phone.
- Tabular numerals (`font-variant-numeric: tabular-nums`) on all timecodes.

Colors
- Light ground `#F4F3EF`, light text `#111111`, light hairline `#111111` 1 px.
- Dark ground `#0B0B0C`, dark panel/placeholder `#161617`–`#1C1C1E`, dark text `#F2F1EC`, dim text `#9A9A96`, dark hairline `#2A2A2C`, dashed empty-state border `#3A3A3C`, muted mono captions `#777777`.
- Angle palette, indexed by key number (replaces `CELL_COLORS`/`ANGLE_COLORS` in `ControlView.tsx` and `Edit.tsx`): 1 `#1F6FE5` blue · 2 `#FFC61A` yellow · 3 `#FF3B2F` red · 4 `#6F3FB8` purple · 5 `#22B8E0` cyan · 6 `#FF7A1A` orange · 7 `#C4127A` magenta · 8 `#17A34A` green. Text on a color: white, except on yellow and cyan, which take `#111` (keep the existing `textOn()` luminance helper).
- REC/live: `#FF3B2F` (same as angle 3 — acceptable; the REC control is always a pill, never a spine).
- Render button: `#F2F1EC` fill, `#111` text.

Radii
- Panels, video cells, program monitor: 24 px (phone camera preview 20 px).
- Pills (buttons, tags, code field, REC, status): 999 px.
- Half-pills: radius = half the short side, on the far end only. Vertical spine 112 px wide → `border-radius: 0 56px 56px 0`; 80 px phone spine → `0 40px 40px 0`; 64 px stripe → `32px 0 0 32px` when hanging from the right edge, `0 32px 32px 0` from the left; 84 px phone role pill → `0 42px 42px 0`; 80 px timeline segment → `0 40px 40px 0`.

Spacing
- Frame edge padding: 24 px (dark), 36–48 px (light).
- Gap between color blocks: 6 px (spines, mosaic cells, timeline segments, role pills); 8 px between feature stripes.
- Hairline separators only on the light pages and one above the recordings strip.

Placeholders: `repeating-linear-gradient(45deg, #161617 0 14px, #1C1C1E 14px 28px)` stands in for video; drop it for real `<video>`.

## Screens / Views

### 1. Home — camerasoup.com (light, `Home.tsx`)
Layout: two columns. Left **spine** 200 px, `border-right: 1px solid #111`, containing the rotated wordmark. Right: grid `1fr 440px`, gap 40 px, padding `36px 0 40px 48px`.

Left column (flex column, gap 22 px):
- Meta line 15 px/500: "A multicam studio in your browser".
- h1 52 px/700/-.04em/line-height .95: "Your Mac records. Your iPhones and iPads are the cameras."
- Lede 20 px/500/line-height 1.3, max 26em: "Nothing gets installed, and the footage never leaves your WiFi."
- Roles list: rows `grid-template-columns: 170px 1fr`, padding 12 px 0, 1 px hairline top and between rows, 15 px. Rows: **Mac with Chrome** / "Runs the show and keeps the footage." · **iPhone, iPad, Android** / "Each one is a camera. Scan the code, name the angle, done." · **iPad as remote** / "Press REC from across the room."
- Bottom action row (`margin-top: auto`, gap 12 px): primary pill `#111` bg, white 18 px/700 text, padding 18×28 "Start the studio" (→ `/studio`); secondary pill 2 px `#111` border, padding 16×26 "Check my network · 10 s" (→ `/check`); code input as a pill: 2 px border, 18 px/700, `letter-spacing: .2em`, uppercase, placeholder `#999` "ABC123" (existing join logic, Enter or ≥4 chars enables join).

Right column: five **feature stripes** hanging from the right edge, bottom-aligned, `align-items: flex-end`, gap 8 px, each 64 px tall, `border-radius: 32px 0 0 32px`, `box-sizing: border-box`, padding 0 28 px, 28 px/700/-.03em, widths 100/92/84/76/68 %: `#1F6FE5` "Record every angle" · `#FFC61A` "Cut live with 1 2 3" · `#FF3B2F` "Fix cuts afterwards" · `#6F3FB8` "Render 4:5 + 9:16" · `#22B8E0` "Footage stays home".

Notice/error variants (`notice`, `verdict red`): render as a rounded 24 px panel with a 6 px colored left edge → make it a half-pill-edged panel in the relevant color instead of the current square left border.

Responsive: below ~900 px, drop the spine to a 64 px top bar with the wordmark horizontal at 40 px; stack the columns.

### 2. Phone — join role picker (light, `Join.tsx` mode `choose`)
390 wide. Left spine 104 px with 92 px wordmark, hairline right. Content: padding-top 64 px; meta 15 px/500 "Room K7Q2PM" (20 px left padding); h1 32 px/700/-.04em "What should this iPhone do?"; then three **role pills** from the spine edge, gap 6 px, each 84 px tall, `border-radius: 0 42px 42px 0`, `box-sizing: border-box`, padding 0 20 px, flex column centered: bold 22 px/-.03em + 13 px sub line. Widths 100/90/80 %: `#1F6FE5` white text "Be a camera" / "Point it, name the angle." · `#FFC61A` `#111` text "Be the remote" / "Press REC from here." · `#22B8E0` `#111` text "Test connection" / "Ten seconds." Tapping sets mode camera / control / check as today.

Name gate (not mocked): same light page; angle-name suggestions (`topdown face action side`) as outline pills, quality as three outline pills with the selected one filled `#111`, "Start camera" as full-width `#111` pill 56 px.

### 3. Phone — live camera (dark/black, `Join.tsx` `LiveCamera` and `Camera.tsx`)
Background `#000`. Left **camera spine** 80 px wide inside 56 px top / 24 px bottom safe padding: fill = this camera's angle color (the hub assigns `keyNumber`; the phone can use the color the hub reports back, fallback `#1F6FE5`), `border-radius: 0 40px 40px 0`, `overflow: hidden`; rotated label anchored bottom-left (bottom 20 px, padding-left 14 px): numeral 44 px + name 34 px, 700, -.04em, white (or `#111` on yellow/cyan).
Right column padding `56px 16px 24px 12px`, gap 12 px: top row 40 px — "camerasoup" 15 px/700 left, outline pill "Rotate" (2 px white border, padding 6×14) right (add Flip/Rename here in the local `Camera.tsx` variant); preview fills the middle with 20 px radius, `object-fit: contain` on black; bottom **status pill** 72 px tall, radius 999, padding 0 24 px, 28 px/700/-.03em. States: idle → `#161617` bg "Ready — waiting for REC"; connecting → dim text "Connecting…"; recording → `#FF3B2F` "● REC" left with the dot pulsing (`@keyframes pulse {50%{opacity:.3}}`, 1.2 s) and tabular timer "0:42" right; flushing → "Finishing up…"; interrupted → `#FF3B2F` outline only with the error text. Drop the current 5 px inset red frame; the pill and spine carry the state.

### 4. Studio / producer mosaic (dark, `Studio.tsx` + `ControlView.tsx`; also `RemoteControl.tsx`)
Frame `#0B0B0C`, text `#F2F1EC`, 24 px radius if shown in a card; full-bleed in the app.

Left **spine rail** 112 px, flex column, gap 6 px, padding-bottom 12 px:
- 100 px header cell: "camerasoup" 15 px/700 rotated -90°, centered.
- One **camera spine** per source (flex: 1): fill = angle color, `border-radius: 0 56px 56px 0`, `overflow: hidden`, clickable (calls `actions.cut(id)`). Rotated label anchored bottom-left (bottom 24 px, padding-left 14 px): numeral 48 px, name 36 px, 700, -.04em. Live/on-program spine: add a 4 px inset white outline or keep as-is (the program cell already outlines) — prefer no extra state on the spine.
- 112 px **add cell**: 2 px dashed `#3A3A3C`, no left border, same half-pill radius, centered `+` 36 px/300 `#9A9A96`; opens the join QR overlay (Mac only; hide in `RemoteControl`).

Right area padding `0 24px 24px 18px`, gap 6 px:
- Header 100 px: meta 15 px/500 `#9A9A96` "3 sources · Movies/camerasoup" and, when >1 camera, "1–3 switches the live camera"; spacer; rec timer 36 px/700/-.03em tabular "00:00"; **REC pill** `#FF3B2F`, white 24 px/700, height 64, padding 0 36 "● REC". Recording → pill becomes 2 px `#FF3B2F` outline with red text "■ Stop"; finalizing → dim text "saving …".
- Mosaic grid `2fr 1fr 1fr` × `1fr 1fr`, gap 6 px (keep the existing `GRID_CONFIGS` logic for more cameras; program cell always spans 2 rows on the left). Every cell radius 24 px, `overflow: hidden`, placeholder/video `object-fit: cover` (`contain` on black for `local-screen`). **Tag pill** top-left 14–16 px inset: angle color bg, 18 px/700 (20 px on the program cell), padding 6×14 (8×18 program), radius 999, text "1 topdown". Program cell: `outline: 4px solid <angle color>; outline-offset: -4px`. The small cell of the on-air camera dims to `opacity: .5` with a mono "on air" caption (replaces `filter: brightness(.35)`). Empty extras cell: 2 px dashed `#3A3A3C`, radius 24, bottom-left stacked outline pills 16 px/700 (2 px `#F2F1EC` border, padding 8×16): "+ iPhone / iPad", "+ this screen", "+ this webcam". Status dot, buffering/interrupted badges, `✕` remove and zoom/torch controls keep their positions but become pills (`#0B0B0C` 85 % bg, radius 999).
- Recordings strip 88 px, `border-top: 1px solid #2A2A2C`, margin-top 12 px, flex gap 32 px, 15 px: "Recordings" `#9A9A96`; per session: id 18 px/700, meta `#9A9A96` "topdown · face · action · 13 s", outline pill "Edit" (→ `/edit?session=`), errors in `#FF3B2F`; right-aligned hint "Edit cuts the show and renders 4:5 + 9:16 into the session folder." With several sessions, stack rows at 56 px each and let the page scroll.
- Toast: `#F2F1EC` bg, `#111` text, radius 999, bottom center.

Join QR overlay: dark panel radius 24, QR on white with 16 px radius, code 28 px/700 `letter-spacing: .25em`, url mono, `✕` as outline pill.

### 5. Editor (dark, `Edit.tsx`)
Header 96 px, padding `0 24px 0 32px`, gap 32 px: "← Sessions" 15 px/700; session id 28 px/700/-.03em; timecode 28 px/700 tabular `#9A9A96` with total in `#555` "0:04.12 / 0:13.02"; spacer; "audio **face ▾**" and "preview **4:5 ▾**" 15 px (label `#9A9A96`, value `#F2F1EC`; style the native `<select>` as text with a ▾); **Render pill** `#F2F1EC`/`#111`, 20 px/700, height 56, padding 0 28 "Render 4:5 + 9:16"; while rendering show "rendering 4:5 42 %" in its place. Play/pause and "Clear cuts" move next to the timecode as outline pills.

Body (flex, gap 18 px, padding-right 24 px):
- Left **spine rail** 112 px: one camera spine per source as in the studio (numeral 48 / name 36), click = `addCut(id)`. No add cell.
- Center: program canvas, height 100 %, `aspect-ratio` from `FORMATS[format]`, black, radius 24, `outline: 4px solid <active angle color>` inset. Click toggles play.
- Right 320 px angle column, gap 6 px: one tile per source (flex: 1), radius 24, overflow hidden, video `object-fit: cover`; tag pill top-left "1 topdown" in angle color; rotate `⟳` 20 px top-right; active tile gets the 4 px inset outline in its color. Hint 13 px/1.4 `#9A9A96`: "1–2 or click cuts. Space plays, ←/→ steps, ⌫ removes the cut at the playhead."

Timeline: height 80 px, margin `18px 24px 24px 0`, flex, gap 6 px. Each segment is a **half-pill** `border-radius: 0 40px 40px 0` in its angle color, width = `seg.len / duration`, label = source id 22 px/700/-.02em padding-left 24 (white or `#111`). Playhead: 3 px white bar extending 10 px above and below the track, radius 2, with a white pill above it (`#111` text 12 px/700, padding 3×10, tabular) showing the current timecode. Cut handles sit at segment starts (12 px hit area, `col-resize`); the `×` delete affordance appears on hover as a small `#0B0B0C` pill at the segment's right end. Segments at full opacity (drop the `.75`), hover lightens 8 %.

Banners (render done/error): full-width pill row under the header, `#17A34A` green / `#FF3B2F` red, 15 px/700.

### 6. Not mocked — apply the same system
- **Connection check (`Check.tsx`)**: light page with spine; the four steps as a hairline list with a colored dot; QR panel radius 24; the verdict card becomes a 24 px panel with a half-pill colored left edge (`#17A34A` / `#FFC61A` / `#FF3B2F`) and the numbers row in 28 px/700.
- **Remote control**: identical to Studio minus the add cell, extras and recordings strip; header meta "remote · K7Q2PM".
- **Folder/error gates**: light page, spine, one 24 px panel, pill buttons.

## Interactions & Behavior
Unchanged from the code: number keys cut (live during recording, edit in the editor), Space play/pause, ←/→ step (Shift ×10), ⌫ delete cut, ⌘Z undo, drag cut handles, click cell/tile/spine to cut. Transitions: color/opacity changes 150 ms ease-out; the REC dot pulse 1.2 s; no layout animation. Hover: pills lighten 8 % (`filter: brightness(1.08)`), outline pills fill `#F2F1EC`/`#111` on dark or `#111`/`#fff` on light. Focus: 2 px offset ring in the element's own color. Disabled: opacity .4.

## State Management
No new state. The angle color becomes a derived value `colorForKey(keyNumber)` shared by `ControlView`, `Edit` and (via the hub snapshot) the phone camera page — add `color` or rely on `keyNumber` in `SnapshotCamera` so the phone can tint its spine.

## Assets
None besides the system Helvetica Neue stack (Arial fallback on Windows). Remove `studio/public/fonts/Satoshi-Variable.woff2` and its `@font-face`. QR codes continue to come from the `qrcode` package.

## Files
- `camerasoup - redesign.dc.html` — section `#2a` is the approved direction (Home, phone join, phone camera, Studio, Editor). Sections `#1a` `#1b` `#1c` are superseded explorations.
- `camerasoup - current.dc.html` — recreation of the existing UI, for before/after comparison.
- Source it maps to: `studio/src/styles.css`, `pages/Home.tsx`, `pages/Studio.tsx`, `components/ControlView.tsx`, `pages/Edit.tsx`, `pages/Join.tsx`, `pages/RemoteControl.tsx`, `pages/Check.tsx`, `pages/Camera.tsx`, `components/VerdictCard.tsx`.
