# Centipede

A clone of the 1981 Atari arcade shooter **Centipede**, built with vanilla
JavaScript and HTML5 Canvas. No build step, no dependencies, no asset files —
opening `index.html` in a browser Just Works.

## The game

A segmented centipede weaves its way down a field of mushrooms toward your
blaster at the bottom of the screen. Shoot segments to split the centipede
into smaller, faster independent centipedes; each destroyed segment leaves a
mushroom behind. Clear the whole centipede to advance a wave.

Auxiliary enemies from the original:
- **Spider** — bounces through your bottom band, eating mushrooms and hunting
  you. Big points, especially at close range.
- **Flea** — drops vertically from the top, planting new mushrooms. Appears
  when your band runs low on mushrooms. Takes two hits.
- **Scorpion** — crosses a row mid-field, poisoning mushrooms. A poisoned
  mushroom makes any centipede segment that touches it dive straight down at
  the player. Worth a lot of points.

## How to play

Open `index.html` in any modern browser. Press **Enter** (or tap the canvas)
to start. Survive waves, score points, beat your high score.

## Controls

| Action | Keyboard | Touch |
|---|---|---|
| Move | Arrow keys or WASD | On-screen D-pad |
| Fire | Space (hold for auto-fire) | ⦿ button |
| Pause | P or Esc | II button |
| Mute | M | — (M key) |

The player moves freely within the bottom band of the screen and is blocked by
mushrooms. Firing is rate-limited; one dart on screen at a time. Scoring:
mushroom 1, centipede segment 10 (+ combo pitch), flea 10/50, spider
300/600/900 (closer to the blaster = more), scorpion 1000. Extra life every
10000 points. High score persists across sessions; mute preference too.

## Architecture

Single file of game logic (`game.js`) plus an `index.html` shell. Everything
runs client-side; sound is synthesized at runtime with the Web Audio API (no
audio files).

Key design points:
- **Fixed-timestep accumulator.** `update(dt)` runs at a locked 1/60 s step via
  an accumulator; rendering runs every rAF. Movement is frame-rate independent
  and a tab-switch clamp (`dt > 0.25`) prevents spiral-of-death.
- **State machine.** `START → PLAYING → (LEVELCLEAR → PLAYING)* → GAMEOVER →
  PLAYING` (restart), plus `PAUSED`. `startGame()` reinitializes every entity
  array and timer, so no listeners, timers, or centipedes leak across runs.
  There is exactly one `requestAnimationFrame` loop for the page lifetime; the
  auto-pause-on-blur prevents unattended play.
- **Mushroom field.** Mushrooms live in an array plus a `Map` keyed `"x,y"` for
  O(1) cell lookups (kept in sync on add/delete), which matters because the
  centipede weave, player collision, and bullet hits all probe cells every
  frame. Damage states are pre-rendered to cached 16×16 sprites and blitted
  with one `drawImage` per mushroom.
- **Grid-anchored centipede.** Each segment occupies a cell and animates a
  sub-cell `t ∈ [0,1)` toward a target cell. The head picks weave/drop/poison
  targets; each body segment targets the cell its predecessor just vacated, so
  the chain trails one cell behind like a real snake. Shooting a non-head
  segment splits the trailing portion into a new independent chain with its
  own head — the core Centipede mechanic. A centipede that enters the player
  band bounces within it; a poisoned head dives straight down. Late waves
  (L5, L9) spawn additional centipedes.
- **Axis-separated player movement.** The player tries X then Y each frame so
  it slides along mushroom walls instead of sticking.
- **Audio.** `blip()` (oscillator), `sweep()` (gliding oscillator), and
  `noiseBurst()` (filtered noise buffer) synthesize every SFX on demand — no
  audio asset files. Combo pitch-shifts consecutive segment kills; the
  AudioContext resumes on first input to satisfy autoplay policies; `M` mutes
  and persists.
- **Scaling & a11y.** Internal resolution fixed at 480×640; CSS scales the
  canvas to the viewport with `image-rendering: pixelated` plus a CRT scanline
  overlay. `prefers-reduced-motion` suppresses shake/flash and cuts particles;
  an `aria-live` region announces state/score/wave for screen readers.

A headless smoke test (`smoke.js`, not committed — needs `puppeteer-core`)
loads the page, verifies the start→play transition, exercises a full
death→restart cycle to confirm no leaked second rAF loop and a clean state
reset, and checks frame count stays ~60.

## Running the test

```
npm i puppeteer-core
node smoke.js
```
(Requires a Playwright/Chromium binary at
`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`.)