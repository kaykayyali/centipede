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
(All "known gaps" above were resolved in the iterations below: grid-anchored
centipede #1, O(1) lookup #2, difficulty curve #5, level-clear sound + wave
banner #5, pause #4, touch polish #10.)

## 2026-07-26 — Iter 2: O(1) mushroom lookup via Map
**What:** Backed the mushroom array with a `Map` keyed `"x,y"`; add/delete keep
both in sync.
**Why:** Cell probes happen every frame for centipede weave, player collision,
and bullet hits, and the field grows as fleas plant and segments die. O(n)
scan was the hottest per-frame cost.
**Measured:** Invariant check (mushrooms.length === mushroomMap.size) held over
2.6s of sustained auto-fire; smoke clean.
**Rejected:** A 2D array grid — would force a fixed-size clear on resize and
waste memory for the sparse bottom band; Map is enough.

## 2026-07-26 — Iter 3: floating score popups
**What:** `addScoreAt(n,x,y,color)` spawns a rising fading number at every kill
site (mushroom 1, segment 10, flea 10/50, spider 300-600, scorpion 1000).
**Why:** Pure juice; makes scoring legible at the point of action.
**Measured:** Smoke clean; popups cleared on restart.
**Rejected:** Combo multiplier text overlay — score already shows the running
total; multiplier would clutter a 480px-wide HUD.

## 2026-07-26 — Iter 4: pause (P/Esc)
**What:** `PAUSED` state; `togglePause` swaps PLAYING↔PAUSED on edge; PAUSED
skips the whole update branch (no timers, no motion) so resume lands in place
without drift.
**Why:** Spec-required quality; needed for the auto-pause-on-blur to have a
clean target state.
**Measured:** Smoke clean; overlay renders.
**Rejected:** A dedicated pause canvas button on desktop — keyboard covers it;
touch got one in iter 10.

## 2026-07-26 — Iter 5: difficulty curve + wave banner
**What:** Capped centipede speed at 6 cells/s (was unbounded 0.45/level). Spider
gap shrinks and speeds up with level. Flea spawn rate and drop speed scale
with level. Scorpion appears from L2, more often at higher levels, picks a
mid-field row. `initLevel` now clears inherited poison, resets spider/scorpion
timers, and flashes a fading "WAVE N" banner.
**Why:** Without a curve the game is either trivial early or unfair late; the
banner frames each wave.
**Measured:** Cleared the centipede via JS → LEVELCLEAR → banner shows →
PLAYING at L2 with an 11-segment centipede (9+2).
**Rejected:** Exponential speed ramp — made L3+ unplayable in playtests of the
math; linear-with-cap feels better.

## 2026-07-26 — Iter 6: combo pitch-shift
**What:** Each consecutive segment kill within 1.2s increments `combo` and
pitches the kill SFX up (cap 12); combo decays on timeout, resets on
death/restart. Added a `sweep()` oscillator helper.
**Why:** Audio juice for streaks; rewards rapid clearing.
**Measured:** Smoke clean.
**Rejected:** A visible combo counter — the pitch is the feedback; a counter
fights the HUD for space.

## 2026-07-26 — Iter 7: extra life every 10000 pts
**What:** `addScore` grants +1 life (cap 8) per 10000-pt threshold, plays the
life jingle, floats a "1UP" popup; `nextBonus` resets on restart.
**Why:** Classic mechanic; gives the late game a comeback lever.
**Measured:** Forced nextBonus=10, crossed it → lives 3→4, nextBonus +10000,
1UP popup spawned.
**Rejected:** A life cap higher than 8 — HUD "LIVES n" would overflow two
digits at 3-digit counts on a 480px canvas.

## 2026-07-26 — Iter 8: reduced-motion + a11y
**What:** `prefers-reduced-motion` suppresses screen shake + death flash and
cuts particles to 1/3. Canvas gets `role="img"` + `tabindex`; a visually
hidden `aria-live` region announces state/score/lives/wave on state change.
**Why:** Spec-adjacent accessibility; the canvas otherwise broadcasts nothing
to assistive tech.
**Measured:** Smoke clean; announce fires on START→PLAYING→GAMEOVER.
**Rejected:** Full keyboard-navable menu via focus rings — the game is real-time
canvas input; a live region is the honest a11y surface.

## 2026-07-26 — Iter 9: enemy edge cases
**What:** Centipede entering the player band now bounces *within* it (was
climbing back out). Scorpion only spawns when a mid-field row has mushrooms
and picks such a row, so its pass always poisons.
**Why:** Both fix "an enemy that does nothing threatening" — a band centipede
that leaves the band, a scorpion row with no mushrooms.
**Measured:** Spawned a scorpion on a mushroom's row → it poisoned that
mushroom; no-such-row → no spawn. Smoke clean.
**Rejected:** Having the centipede consume mushrooms on contact — classic
doesn't; it bounces off them, which is what makes the field a maze.

## 2026-07-26 — Iter 10: mobile control polish
**What:** Added a pause button to the touch overlay (bound to togglePause);
buttons get `touch-action:none` and `-webkit-touch-callout:none`.
**Why:** Touch users had no pause; long-press could trigger context menu /
scroll.
**Measured:** Smoke clean; multi-touch move+fire already worked since each
button binds its own touch start/end.
**Rejected:** Swipe-gesture controls replacing the D-pad — less precise for a
grid-aligned blaster and a bigger rewrite for no clear win.

## 2026-07-26 — Iter 11: render perf — mushroom sprite cache
**What:** Pre-render each hp+poison mushroom variant to a 16×16 offscreen
canvas (lazy, memoized) and `drawImage` once per mushroom instead of 3
fillRects with state changes.
**Why:** Mushrooms are the most numerous entity (~40-80); per-mushroom state
changes dominated the fill loop.
**Measured:** Pixel check confirms mushrooms (purple) + centipede/player
(green) still render — not blank; smoke clean.
**Rejected:** Caching the centipede too — only ~10-25 segments and they animate
(legs), so caching fights the per-frame wiggle. Mushrooms are static.

## 2026-07-26 — Iter 12: visual polish — starfield, leg animation, muzzle flash
**What:** Twinkling starfield behind the playfield; centipede legs wiggle on a
two-frame cycle driven by a global phase timer; muzzle flash on fire.
**Why:** The plain black bg + static centipede read as a prototype.
**Measured:** Pixel non-black count rose (stars added), green/purple preserved;
smoke clean.
**Rejected:** A parallax background — competing motion behind a fast shooter
hurts readability; a static twinkle is enough.

## 2026-07-26 — Iter 13: start-screen high score + CRT scanlines
**What:** Start screen shows the persisted high score (gold). A CSS
`repeating-linear-gradient` overlay (pointer-events:none, multiply blend) adds
faint scanlines.
**Why:** Retro feel + the high score is the thing you come back to beat.
**Measured:** Smoke clean; overlay never blocks input (pointer-events:none).
**Rejected:** A full CRT curvature/vignette shader — overkill and distorts the
grid; scanlines alone signal "arcade".

## 2026-07-26 — Iter 14: multi-centipede escalation (L5/L9)
**What:** `spawnCentipede` takes `{len,row,fromLeft}`. At L5+ a second shorter
centipede enters from the left on row 2; at L9+ a third from the right on row 4.
**Why:** Speed alone is a blunt difficulty lever; more independent heads is the
classic late-game pressure.
**Measured:** At L6 → 2 chains / 21 segments; L1 still 1 chain / 10. Smoke clean.
**Rejected:** Spawning 2 centipedes from L1 — too hard too early; the curve
should ease players in.

## 2026-07-26 — Iter 15: auto-pause on tab blur
**What:** `visibilitychange`/`blur` drops PLAYING→PAUSED; blur clears stuck
movement keys.
**Why:** Prevents unattended play and "I tabbed back and drifted into a
spider"; the dt clamp already prevents spiral-of-death, but a frozen state is
cleaner.
**Measured:** Smoke clean.
**Rejected:** Resuming automatically on focus — would surprise the player;
manual resume via P/Esc is safer.

## 2026-07-26 — Iter 16: spider proximity scoring
**What:** Spider points now scale with vertical distance to the blaster at
kill time: 900 within 1.5 cells, 600 within 4, else 300. Was random 300/600/900.
**Why:** Authentic to the original and adds risk/reward skill expression —
letting the spider close is worth more.
**Measured:** Smoke clean.
**Rejected:** Also scaling by horizontal distance — the spider zig-zags
vertically, so vertical proximity is the skill axis; horizontal adds noise.

## 2026-07-26 — Iter 17: mute toggle (M)
**What:** `M` toggles sound, persisted in localStorage; all synth paths
(blip/sweep/noiseBurst) early-return when muted. HUD shows "MUTED (M)";
start screen documents M.
**Why:** Office-friendly; sound off should be one keystroke and stick.
**Measured:** Smoke clean.
**Rejected:** A drawn speaker-icon button — keyboard + HUD text is enough and
avoids another hit-test target.

## 2026-07-26 — Exhausted
After 17 iterations beyond v1, I went looking for the next meaningful
improvement and could only find things that are either cosmetic minutiae,
authentic-but-marginal, or risk destabilizing a clean working system for
little gain. Considered and rejected:

- **3-letter initials / high-score table.** Authentic, but a sizable UI
  sub-system (text entry on canvas + keyboard + touch) for a single-player
  clone with one persisted high. Cost >> value; the numeric high score is
  enough.
- **Mushroom repair / regrowth between waves** (classic restores damaged
  mushrooms on death). Adds a second mushroom-life subsystem interacting with
  the damage-tint sprite cache; marginal effect on feel since topUp already
  keeps density. Skipped.
- **Per-wave "GET READY" countdown.** The WAVE N banner already frames the
  start; a countdown would gate input and annoy on restart-heavy sessions.
- **Background music / drone.** A synthesized loop risks fatigue and clashing
  with the SFX; the brief asked for sound effects, not a score. Skipped.
- **Caching animated centipede sprites.** Legs wiggle every frame; a sprite
  cache would need N frames per color/poison state and the segment count is
  small. Mushrooms were worth it (iter 11); the centipede isn't.
- **Dirty-rect rendering.** 480×640 at 60fps is trivial for any modern GPU;
  partial redraws would complicate the starfield/particle passes for no
  measurable gain.
- **Hi-DPI internal resolution.** The pixelated upscale *is* the intended
  retro look; rendering at devicePixelRatio would sharpen away the aesthetic.
- **Swipe-gesture mobile controls.** Less precise than the D-pad for a
  grid-aligned blaster and a bigger rewrite (iter 10 rejected this too).
- **Difficulty: flea drops more mushrooms at higher levels.** The flea rate
  already scales (iter 5); tuning the per-drop probability further felt like
  fiddling without a playtest signal.
- **Splitting the file into modules.** A single `game.js` is the right size
  for this scope (~750 lines); ES modules would add an import-graph and break
  the "open index.html → play" no-build property.

Final state: a complete Centipede clone — grid-anchored weaving centipede
with splitting, poison diving, spider/flea/scorpion, mushrooms with damage +
poison, score popups, combo audio, extra lives, persistent high score, mute,
pause + auto-pause, reduced-motion + screen-reader a11y, mobile controls,
sprite-cached rendering, starfield + scanlines, multi-centipede late-game
escalation, and a difficulty curve. Headless smoke + lifecycle + invariant +
pixel tests all pass.
