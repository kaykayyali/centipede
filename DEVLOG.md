# Devlog — Centipede

## 2026-07-26 — v1: core loop
**What:** Built the full game in one pass: state machine (start/playing/level
clear/game over), fixed-timestep loop, player with axis-separated mushroom
collision, mushrooms with 4 hp, a chain-based centipede that weaves/drops and
splits on segment kills, spider (zig-zag in player band), flea (mushroom
planter), scorpion (poisoner, level ≥2), Web Audio synthesized SFX, particles,
screen shake, score/HUD, keyboard + touch controls, persistent high score,
responsive canvas scaling.

**Why:** Spec requires all four pillars (graphics/UI, controls, core
mechanics, code quality) up front; the centipede split + poison + three aux
enemies *is* the core loop, so there's no smaller honest v1.

**Measured:** Headless smoke (`smoke.js` via puppeteer-core + Playwright
chromium): no console/page errors, START→PLAYING transition works, 10-segment
centipede + ~40 mushrooms spawn, gameplay runs 1s without error. Lifecycle
test: forced death reaches GAMEOVER, `startGame()` resets lives→3/score→0 and
respawns a fresh field, and rAF frame count over 500ms stays at ~31 (one loop,
no leak after restart). `node --check` clean.

**Rejected:**
- Phaser: no benefit over canvas for a single-screen grid shooter; would add a
  build/asset pipeline. Vanilla canvas keeps "open index.html → play".
- Per-function test suite: YAGNI for a one-file game; one smoke + one
  lifecycle test exercises the spec's stated bug surfaces (init, restart,
  double-loop).
- Tracking high score live in `localStorage` on every point: only persist on
  death to avoid hot-loop writes.

**Known gaps for later iterations:** centipede body trailing is a naive
follow-the-leader snap (can stretch on drops); mushroom cell lookup is O(n)
linear scan; no difficulty curve beyond linear speed+length; no sound for
level-clear wave; no pause; touch buttons always render on touch devices even
when unused.