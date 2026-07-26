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

The player moves freely within the bottom band of the screen and is blocked by
mushrooms. Firing is rate-limited; one dart on screen at a time.

## Architecture

Single file of game logic (`game.js`) plus an `index.html` shell. Everything
runs client-side; sound is synthesized at runtime with the Web Audio API (no
audio files).

Key design points:
- **Fixed-timestep accumulator.** `update(dt)` runs at a locked 1/60 s step via
  an accumulator; rendering runs every rAF. Movement is frame-rate independent
  and a tab-switch clamp (`dt > 0.25`) prevents spiral-of-death.
- **State machine.** `START → PLAYING → (LEVELCLEAR → PLAYING)* → GAMEOVER →
  PLAYING` (restart). `startGame()` reinitializes every entity array, so no
  listeners, timers, or centipedes leak across runs. There is exactly one
  `requestAnimationFrame` loop for the lifetime of the page.
- **Sparse mushroom grid.** Mushrooms live in an array keyed by cell; a cell
  lookup is a linear scan over the field (small N, fine for now).
- **Centipede as chain of segments.** Each chain has a head that drives
  horizontal motion and row-drops on wall/mushroom contact; the body trails the
  head. Shooting a non-head segment splits the trailing portion into a new
  independent chain with its own head — the core Centipede mechanic.
- **Axis-separated player movement.** The player tries X then Y each frame so
  it slides along mushroom walls instead of sticking.
- **Audio.** `blip()` (oscillator) and `noiseBurst()` (filtered noise buffer)
  synthesize every SFX on demand; the AudioContext resumes on first input to
  satisfy autoplay policies.
- **Scaling.** The internal resolution is fixed at 480×640; CSS scales the
  canvas to the viewport with `image-rendering: pixelated` for crisp pixels.

A headless smoke test (`smoke.js`, not committed — needs `puppeteer-core`) loads
the page, verifies the start→play transition, and exercises a full
death→restart cycle to confirm no leaked second rAF loop and clean state reset.

## Running the test

```
npm i puppeteer-core
node smoke.js
```
(Requires a Playwright/Chromium binary at
`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`.)