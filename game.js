"use strict";
/*
 * Centipede — vanilla JS / Canvas clone of the 1981 Atari shooter.
 *
 * Layout:
 *   - The playfield is a grid of CELLS (16x16 px). Mushrooms occupy cells.
 *   - The centipede is a chain of segments that weave across the field, dropping
 *     a row and reversing direction each time it hits a wall or a mushroom.
 *   - The player (the "shooter") roams the bottom band, fires darts upward.
 *   - Spider, Flea, and Scorpion are the auxiliary enemies.
 *
 * Architecture:
 *   game.js   — all game logic + rendering + input + audio (one file, no build).
 *   index.html — canvas + touch UI shell.
 *
 * The update loop uses a fixed timestep accumulator so movement is frame-rate
 * independent; rendering is interpolated loosely (we just draw latest state).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const COLS = 30;          // playfield columns
const ROWS = 40;          // playfield rows (incl. player band)
const CELL = 16;          // px per cell
const PLAYER_BAND_ROWS = 8; // bottom rows the player may roam
const PLAYER_TOP_ROW = ROWS - PLAYER_BAND_ROWS; // first row the player may enter

const W = COLS * CELL;     // 480
const H = ROWS * CELL;     // 640

// Reduced-motion: honor the OS setting by dampening shake/flash/particles.
const REDUCED = window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sr = document.getElementById("sr-status");
function announceStatus() {
  if (!sr) return;
  const names = { 0: "Start screen", 1: "Playing", 2: "Game over", 3: "Level cleared", 4: "Paused" };
  sr.textContent = `${names[game.state] || ""}. Score ${game.score}. Lives ${game.lives}. Wave ${game.level}.`;
}
let lastAnnouncedState = -1;

// Entity state machine values.
const STATE = { START: 0, PLAYING: 1, GAMEOVER: 2, LEVELCLEAR: 3, PAUSED: 4 };

// ---------------------------------------------------------------------------
// Canvas setup with crisp scaling
// ---------------------------------------------------------------------------
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

// Scale the fixed-resolution canvas to fit the window while keeping aspect.
function resize() {
  const pad = 12;
  const scale = Math.min(
    (window.innerWidth - pad) / W,
    (window.innerHeight - pad) / H
  );
  canvas.style.width = Math.floor(W * scale) + "px";
  canvas.style.height = Math.floor(H * scale) + "px";
}
window.addEventListener("resize", resize);
resize();

// Detect touch and show touch UI.
if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
  document.body.classList.add("touch");
}

// ---------------------------------------------------------------------------
// Audio — synthesized via Web Audio API (no asset files)
// ---------------------------------------------------------------------------
let audioCtx = null;
function audio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  return audioCtx;
}
// Resume on first interaction (autoplay policy).
function ensureAudio() { const a = audio(); if (a && a.state === "suspended") a.resume(); }

function blip(freq, dur, type = "square", gain = 0.08) {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime);
  g.gain.setValueAtTime(gain, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur);
}
// blip with an upward frequency sweep — used for combo pitch-shifts.
function sweep(f0, f1, dur, type = "square", gain = 0.07) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, a.currentTime);
  o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), a.currentTime + dur);
  g.gain.setValueAtTime(gain, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start(); o.stop(a.currentTime + dur);
}
function noiseBurst(dur, gain = 0.12, filterFreq = 1200) {
  const a = audio();
  if (!a) return;
  const n = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, n, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = filterFreq;
  const g = a.createGain(); g.gain.value = gain;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}
const SFX = {
  shoot:    () => blip(880, 0.08, "square", 0.05),
  hitMush:  () => blip(220, 0.06, "square", 0.06),
  hitSeg:   () => { blip(440, 0.05); noiseBurst(0.08, 0.08, 2000); },
  killSeg:  (pitch = 1) => { blip(660 * pitch, 0.06); blip(330 * pitch, 0.12, "sawtooth", 0.07); },
  spider:   () => blip(140, 0.05, "sawtooth", 0.04),
  flea:     () => blip(1100, 0.04, "square", 0.04),
  scorpion: () => blip(180, 0.1, "sawtooth", 0.05),
  playerHit:() => { noiseBurst(0.4, 0.18, 800); },
  life:     () => { blip(523, 0.1); setTimeout(() => blip(784, 0.15), 110); },
  over:     () => { blip(200, 0.3, "sawtooth", 0.1); setTimeout(() => blip(120, 0.5, "sawtooth", 0.1), 200); },
  level:    () => { blip(523, 0.1); setTimeout(() => blip(659, 0.1), 110); setTimeout(() => blip(784, 0.2), 220); },
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = { left: false, right: false, up: false, down: false, fire: false };
let firePressed = false; // edge-triggered fire

function setKey(code, val) {
  switch (code) {
    case "ArrowLeft": case "KeyA": keys.left = val; break;
    case "ArrowRight": case "KeyD": keys.right = val; break;
    case "ArrowUp": case "KeyW": keys.up = val; break;
    case "ArrowDown": case "KeyS": keys.down = val; break;
    case "Space": keys.fire = val; if (val) firePressed = true; break;
    case "KeyP": if (val) togglePause(); break;
    case "Escape": if (val) togglePause(); break;
  }
}
function togglePause() {
  if (game.state === STATE.PLAYING) game.state = STATE.PAUSED;
  else if (game.state === STATE.PAUSED) game.state = STATE.PLAYING;
}
window.addEventListener("keydown", (e) => {
  if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Space"].includes(e.code)) e.preventDefault();
  ensureAudio();
  setKey(e.code, true);
  if (e.code === "Enter") handleEnter();
});
window.addEventListener("keyup", (e) => setKey(e.code, false));

// Touch buttons
function bindBtn(id, on, off) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = (e) => { e.preventDefault(); ensureAudio(); on(); };
  const end = (e) => { e.preventDefault(); off(); };
  el.addEventListener("touchstart", start, { passive: false });
  el.addEventListener("touchend", end, { passive: false });
  el.addEventListener("touchcancel", end, { passive: false });
  el.addEventListener("mousedown", start);
  el.addEventListener("mouseup", end);
  el.addEventListener("mouseleave", end);
}
bindBtn("b-left",  () => keys.left = true,  () => keys.left = false);
bindBtn("b-right", () => keys.right = true, () => keys.right = false);
bindBtn("b-up",    () => keys.up = true,    () => keys.up = false);
bindBtn("b-down",  () => keys.down = true,  () => keys.down = false);
bindBtn("fire",    () => { keys.fire = true; firePressed = true; }, () => keys.fire = false);
// Pause button fires togglePause on tap (edge-triggered inside togglePause via key? no — call directly).
bindBtn("b-pause", () => togglePause(), () => {});

function handleEnter() {
  if (game.state === STATE.START) startGame();
  else if (game.state === STATE.GAMEOVER) startGame();
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const game = {
  state: STATE.START,
  score: 0,
  high: parseInt(localStorage.getItem("centipede_high") || "0", 10),
  lives: 3,
  level: 1,
  mushrooms: [],         // array of {x,y,hp,poison}
  mushroomMap: new Map(), // "x,y" -> same object, for O(1) cell lookup
  player: null,
  bullet: null,
  centipedes: [],         // array of chains; each chain = array of segments
  spider: null,
  flea: null,
  scorpion: null,
  particles: [],
  scorePops: [],
  shake: 0,
  flash: 0,
  levelClearTimer: 0,
  waveBannerTimer: 0,
  // combo pitch ladder for consecutive segment kills (resets on miss/long gap)
  combo: 0,
  comboTimer: 0,
  nextBonus: 10000, // score threshold for the next extra life
  phase: 0,         // global animation phase (legs, twinkle, muzzle)
  muzzle: 0,
  stars: [],        // static starfield positions
};

// Starfield: fixed decorative dots, generated once.
for (let i = 0; i < 36; i++) {
  game.stars.push({ x: Math.random() * W, y: Math.random() * H, b: 0.3 + Math.random() * 0.7, s: Math.random() * 1.6 + 0.4 });
}

function startGame() {
  game.state = STATE.PLAYING;
  game.score = 0;
  game.lives = 3;
  game.level = 1;
  game.particles.length = 0;
  game.scorePops.length = 0;
  game.shake = 0; game.flash = 0;
  game.combo = 0; game.comboTimer = 0;
  game.nextBonus = 10000;
  initLevel();
  spawnPlayer();
}

function initLevel() {
  // Clear transient entities.
  game.bullet = null;
  game.spider = null;
  game.flea = null;
  game.scorpion = null;
  game.centipedes = [];

  // Reset / seed mushrooms. On level >1 keep damage from previous field
  // (classic behaviour) — but ensure density target, and clear poison so a
  // fresh wave doesn't inherit a poisoned field from the last scorpion.
  if (game.level === 1) {
    game.mushrooms = [];
    game.mushroomMap.clear();
    seedMushrooms(40);
  } else {
    for (const m of game.mushrooms) m.poison = false;
    topUpMushrooms(40);
  }

  // Reset auxiliary-enemy timers so a new wave doesn't immediately dump a spider.
  spiderTimer = 4 + Math.random() * 2;
  scorpionTimer = 10 + Math.random() * 6;
  game.waveBannerTimer = 1.1;
  spawnCentipede();
}

// Mushrooms -----------------------------------------------------------------
function mkey(x, y) { return x + "," + y; }
function getMushroom(x, y) { return game.mushroomMap.get(mkey(x, y)) || null; }
function addMushroom(x, y, poison = false) {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return null;
  const k = mkey(x, y);
  if (game.mushroomMap.has(k)) return null;
  const m = { x, y, hp: 4, poison };
  game.mushrooms.push(m);
  game.mushroomMap.set(k, m);
  return m;
}
function seedMushrooms(target) {
  let tries = 0;
  while (countMushrooms() < target && tries++ < target * 8) {
    const x = (Math.random() * COLS) | 0;
    const y = ((Math.random() * (PLAYER_TOP_ROW - 2)) | 0) + 2;
    addMushroom(x, y);
  }
}
function topUpMushrooms(target) {
  // Remove mushrooms in player's spawn row corridor, then top up.
  seedMushrooms(target);
}
function countMushrooms() { return game.mushrooms.length; }
function damageMushroom(m) {
  m.hp--;
  SFX.hitMush();
  if (m.hp <= 0) {
    game.mushrooms.splice(game.mushrooms.indexOf(m), 1);
    game.mushroomMap.delete(mkey(m.x, m.y));
    addScoreAt(1, m.x * CELL + CELL / 2, m.y * CELL + CELL / 2, "#a070d0");
    spawnParticles(m.x * CELL + CELL / 2, m.y * CELL + CELL / 2, "#7a4fb0", 6);
  }
}

// Player --------------------------------------------------------------------
function spawnPlayer() {
  game.player = {
    x: (COLS / 2) * CELL,
    y: (ROWS - 3) * CELL,
    w: 16, h: 16,
    speed: 130, // px/s
    invuln: 1.0,
    blink: 0,
  };
}

// Axis-separated movement so the player slides along mushroom walls instead of sticking.
function movePlayer(dt) {
  const p = game.player; if (!p) return;
  let dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  let dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }
  const top = PLAYER_TOP_ROW * CELL;
  const bottom = H - p.h;
  // X axis
  let nx = p.x + dx * p.speed * dt;
  nx = Math.max(0, Math.min(W - p.w, nx));
  if (!collidesMushroom(nx, p.y, p.w, p.h)) p.x = nx;
  // Y axis
  let ny = p.y + dy * p.speed * dt;
  ny = Math.max(top, Math.min(bottom, ny));
  if (!collidesMushroom(p.x, ny, p.w, p.h)) p.y = ny;
  if (p.invuln > 0) { p.invuln -= dt; p.blink += dt; }
  if (keys.fire) tryFire();
}
function collidesMushroom(px, py, pw, ph) {
  const x0 = Math.floor(px / CELL), x1 = Math.floor((px + pw - 0.01) / CELL);
  const y0 = Math.floor(py / CELL), y1 = Math.floor((py + ph - 0.01) / CELL);
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      if (getMushroom(x, y)) return true;
  return false;
}

// Bullet --------------------------------------------------------------------
const BULLET_SPEED = 520;
const FIRE_COOLDOWN = 0.18;
let fireCooldown = 0;
function tryFire() {
  if (game.bullet || fireCooldown > 0) return;
  ensureAudio();
  SFX.shoot();
  const p = game.player;
  game.bullet = { x: p.x + p.w / 2 - 1.5, y: p.y - 4, w: 3, h: 10, vy: -BULLET_SPEED };
  fireCooldown = FIRE_COOLDOWN;
  game.muzzle = 0.06;
}
function updateBullet(dt) {
  if (fireCooldown > 0) fireCooldown -= dt;
  const b = game.bullet;
  if (!b) return;
  b.y += b.vy * dt;
  if (b.y < -b.h) { game.bullet = null; return; }
  // Mushroom hit
  const mx = Math.floor((b.x + b.w / 2) / CELL);
  const my = Math.floor(b.y / CELL);
  const m = getMushroom(mx, my);
  if (m) { damageMushroom(m); game.bullet = null; return; }
  // Centipede segment hit
  for (const chain of game.centipedes) {
    for (let i = 0; i < chain.length; i++) {
      const s = chain[i];
      if (rectHit(b, segRect(s))) {
        // Shot segment becomes a mushroom at its cell.
        const cx = Math.floor((s.x + CELL / 2) / CELL);
        const cy = Math.floor((s.y + CELL / 2) / CELL);
        addMushroom(cx, cy, false);
        chain.splice(i, 1);
        addScoreAt(10, s.x + CELL / 2, s.y + CELL / 2, "#39ff14");
        // Combo: each consecutive segment kill within the window pitches up.
        game.combo = Math.min(game.combo + 1, 12);
        game.comboTimer = 1.2;
        SFX.killSeg(1 + game.combo * 0.07);
        spawnParticles(s.x + CELL / 2, s.y + CELL / 2, "#39ff14", 10);
        game.shake = Math.min(game.shake + 3, 8);
        // Classic split: the front keeps going; everything past the break
        // becomes a new independent centipede whose first segment is a head.
        if (chain.length > 0) {
          if (i === 0) {
            chain[0].isHead = true; // head was shot — promote successor
          } else if (i < chain.length) {
            const remainder = chain.splice(i);
            remainder[0].isHead = true;
            game.centipedes.push(remainder);
          }
        }
        game.bullet = null;
        return;
      }
    }
  }
  // Spider / flea / scorpion hits
  if (game.spider && rectHit(b, game.spider)) { hitSpider(); game.bullet = null; return; }
  if (game.flea && rectHit(b, game.flea)) { hitFlea(); game.bullet = null; return; }
  if (game.scorpion && rectHit(b, game.scorpion)) { hitScorpion(); game.bullet = null; return; }
}
function rectHit(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function segRect(s) { return { x: s.x, y: s.y, w: CELL, h: CELL }; }

// Centipede -----------------------------------------------------------------
// Grid-anchored snake movement: each segment occupies a cell and animates a
// sub-cell `t` (0..1) toward its target cell. The head picks targets using
// weave/drop/poison logic; each body segment targets the cell its predecessor
// just vacated, so the whole chain trails one cell behind like a real snake.
// `x`/`y` are derived pixels (kept for segRect/hit-cell compatibility).
function spawnCentipede() {
  const len = Math.min(9 + game.level, 14);
  const chain = [];
  for (let i = 0; i < len; i++) {
    chain.push({
      cx: COLS - 1 + i, cy: 0,    // current cell (head at COLS-1; body files in from the right)
      nx: COLS - 1 + i - 1, ny: 0, // target cell (each targets the cell ahead of it)
      t: 0,
      dir: -1,        // head's horizontal direction
      dropDir: 1,     // +1 = drops downward when blocked, -1 = rises
      poison: false,
      isHead: i === 0,
      x: (COLS - 1 + i) * CELL, y: 0,
    });
  }
  game.centipedes.push(chain);
}
function centiBaseSpeed() { return Math.min(2.2 + game.level * 0.4, 6); } // cells/sec, capped
function pickHeadTarget(h) {
  // Poisoned head dives straight down through mushrooms until it bottoms out.
  if (h.poison) {
    if (h.cy + 1 >= ROWS) { h.poison = false; h.dropDir = -1; }
    else { h.nx = h.cx; h.ny = h.cy + 1; return; }
  }
  const tryX = h.cx + h.dir;
  // Wall: reverse and drop/rise.
  if (tryX < 0 || tryX >= COLS) {
    h.dir = -h.dir;
    verticalStep(h);
    h.nx = h.cx + h.dir; // step the other way next tick
    return;
  }
  // Mushroom ahead: reverse and drop/rise.
  if (getMushroom(tryX, h.cy)) {
    h.dir = -h.dir;
    verticalStep(h);
    h.nx = h.cx + h.dir;
    return;
  }
  h.nx = tryX; h.ny = h.cy;
}
function verticalStep(h) {
  // Once a centipede has entered the player band, it bounces within it
  // (classic) rather than climbing back out into the open field.
  const inBand = h.cy >= PLAYER_TOP_ROW;
  let ny = h.cy + h.dropDir;
  if (inBand) {
    if (ny < PLAYER_TOP_ROW) { h.dropDir = 1; ny = h.cy + 1; }
    if (ny >= ROWS) { h.dropDir = -1; ny = h.cy - 1; }
  } else {
    if (ny >= ROWS) { h.dropDir = -1; ny = h.cy - 1; }
    if (ny < 0) { h.dropDir = 1; ny = h.cy + 1; }
  }
  h.ny = ny;
}
function updateCentipede(dt) {
  for (const chain of game.centipedes) {
    if (chain.length === 0) continue;
    const head = chain[0];
    const inBand = head.cy >= PLAYER_TOP_ROW;
    const speed = (head.poison ? 4.5 : centiBaseSpeed()) * (inBand ? 1.3 : 1);
    const rate = speed * dt; // cells of progress this frame
    // Capture each segment's old cell as it commits, to feed the next segment.
    let prevOld = null;
    let prevCommitted = false;
    for (let i = 0; i < chain.length; i++) {
      const s = chain[i];
      s.t += rate;
      // Derive pixel position from current→target interpolation.
      s.x = (s.cx + (s.nx - s.cx) * Math.min(1, s.t)) * CELL;
      s.y = (s.cy + (s.ny - s.cy) * Math.min(1, s.t)) * CELL;
      if (s.t >= 1) {
        const old = { cx: s.cx, cy: s.cy };
        s.cx = s.nx; s.cy = s.ny;
        s.t -= 1;
        if (i === 0) {
          // Head: pick its own next target; detect poison mushrooms under it.
          if (getMushroom(s.cx, s.cy) && getMushroom(s.cx, s.cy).poison) s.poison = true;
          pickHeadTarget(s);
        } else {
          // Body: target the cell the predecessor just vacated (if available).
          if (prevCommitted && prevOld) { s.nx = prevOld.cx; s.ny = prevOld.cy; }
        }
        prevOld = old;
        prevCommitted = true;
      }
      // If this segment didn't commit, its old cell isn't fresh for the next.
      // (prevCommitted only set on commit; reset for the next sibling below.)
    }
    // Player collision with any segment.
    if (game.player && game.player.invuln <= 0) {
      for (const s of chain) if (rectHit(segRect(s), game.player)) { playerHit(); break; }
    }
  }
  game.centipedes = game.centipedes.filter(c => c.length > 0);
  if (game.centipedes.length === 0 && game.state === STATE.PLAYING) {
    game.state = STATE.LEVELCLEAR;
    game.levelClearTimer = 1.6;
    SFX.level();
  }
}

// Spider --------------------------------------------------------------------
let spiderTimer = 0;
function updateSpider(dt) {
  spiderTimer -= dt;
  if (!game.spider && spiderTimer <= 0) {
    // Spider pressure ramps with level (min 2.2s gap), and gets faster.
    spiderTimer = Math.max(2.2, 5.5 - game.level * 0.25) + Math.random() * 2.5;
    if (game.state === STATE.PLAYING) {
      const fromLeft = Math.random() < 0.5;
      game.spider = {
        x: fromLeft ? -CELL : W,
        y: (PLAYER_TOP_ROW + 2 + Math.random() * 4) * CELL,
        w: 18, h: 18,
        vx: (fromLeft ? 1 : -1) * (60 + game.level * 4 + Math.random() * 40),
        vy: (Math.random() < 0.5 ? 1 : -1) * (80 + game.level * 4),
        zig: 0,
      };
    }
  }
  const s = game.spider;
  if (!s) return;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.zig += dt;
  if (s.zig > 0.35) { s.zig = 0; s.vy = -s.vy; SFX.spider(); }
  // Bounce vertically within player band + a bit above.
  const top = PLAYER_TOP_ROW * CELL - CELL;
  const bottom = H - s.h;
  if (s.y < top) { s.y = top; s.vy = Math.abs(s.vy); }
  if (s.y > bottom) { s.y = bottom; s.vy = -Math.abs(s.vy); }
  // Eat mushrooms it touches.
  const sx = Math.floor((s.x + s.w / 2) / CELL), sy = Math.floor((s.y + s.h / 2) / CELL);
  const m = getMushroom(sx, sy);
  if (m) {
    game.mushrooms.splice(game.mushrooms.indexOf(m), 1);
    game.mushroomMap.delete(mkey(sx, sy));
  }
  if (s.x < -CELL * 2 || s.x > W + CELL) game.spider = null;
  if (game.player && game.player.invuln <= 0 && rectHit(s, game.player)) playerHit();
}
function hitSpider() {
  const pts = 300 + Math.floor(Math.random() * 3) * 100;
  addScoreAt(pts, game.spider.x + 9, game.spider.y, "#ff2e88");
  spawnParticles(game.spider.x, game.spider.y, "#ff2e88", 14);
  SFX.killSeg();
  game.spider = null; game.shake = Math.min(game.shake + 4, 10);
}

// Flea ---------------------------------------------------------------------
function updateFlea(dt) {
  // Spawn a flea when the player band has few mushrooms. Spawn rate rises with level.
  if (!game.flea && game.state === STATE.PLAYING) {
    let lowCount = 0;
    for (const m of game.mushrooms) if (m.y >= PLAYER_TOP_ROW - 2) lowCount++;
    const p = Math.min(0.06, 0.018 + game.level * 0.004);
    if (lowCount < 5 && Math.random() < p) {
      game.flea = {
        x: (Math.random() * (COLS - 2) + 1) * CELL,
        y: -CELL,
        w: 12, h: 14,
        vy: 190 + game.level * 8,
        dropTimer: 0,
        hp: undefined,
      };
    }
  }
  const f = game.flea; if (!f) return;
  f.y += f.vy * dt;
  f.dropTimer += dt;
  if (f.dropTimer > 0.06) {
    f.dropTimer = 0;
    const cx = Math.floor(f.x / CELL), cy = Math.floor(f.y / CELL);
    if (cy > 0 && cy < ROWS - 2 && !getMushroom(cx, cy) && Math.random() < 0.5)
      addMushroom(cx, cy);
    SFX.flea();
  }
  if (f.y > H) game.flea = null;
  if (game.player && game.player.invuln <= 0 && rectHit(f, game.player)) playerHit();
}
function hitFlea() {
  // Two hits to kill; speed up after first.
  if (!game.flea) return;
  if (game.flea.hp === undefined) {
    game.flea.hp = 2; game.flea.vy *= 1.5;
    addScoreAt(10, game.flea.x + 6, game.flea.y, "#88ddff"); SFX.hitSeg();
  } else {
    addScoreAt(50, game.flea.x + 6, game.flea.y, "#88ddff");
    spawnParticles(game.flea.x, game.flea.y, "#88ddff", 10); SFX.killSeg(); game.flea = null;
  }
}

// Scorpion -----------------------------------------------------------------
let scorpionTimer = 0;
function updateScorpion(dt) {
  scorpionTimer -= dt;
  if (!game.scorpion && scorpionTimer <= 0 && game.state === STATE.PLAYING && game.level >= 2) {
    // Scorpion appears more often at higher levels; crosses a mid-field row.
    scorpionTimer = Math.max(7, 14 - game.level) + Math.random() * 6;
    // Choose a mid-field row that actually has mushrooms to poison.
    const rowsWith = new Set();
    for (const m of game.mushrooms)
      if (m.y >= 4 && m.y < PLAYER_TOP_ROW - 1) rowsWith.add(m.y);
    if (rowsWith.size === 0) return; // nothing to poison this wave
    const rows = [...rowsWith];
    const row = rows[Math.floor(Math.random() * rows.length)];
    const fromLeft = Math.random() < 0.5;
    game.scorpion = {
      x: fromLeft ? -CELL : W,
      y: row * CELL,
      w: 20, h: 12,
      vx: (fromLeft ? 1 : -1) * (90 + game.level * 4),
    };
  }
  const s = game.scorpion; if (!s) return;
  s.x += s.vx * dt;
  // Poison mushrooms in its row.
  const sy = Math.floor((s.y + s.h / 2) / CELL);
  const sx = Math.floor((s.x + s.w / 2) / CELL);
  const m = getMushroom(sx, sy);
  if (m && !m.poison) { m.poison = true; SFX.scorpion(); }
  if (s.x < -CELL || s.x > W) game.scorpion = null;
  if (game.player && game.player.invuln <= 0 && rectHit(s, game.player)) playerHit();
}
function hitScorpion() {
  addScoreAt(1000, game.scorpion.x + 10, game.scorpion.y, "#ffd24a");
  spawnParticles(game.scorpion.x, game.scorpion.y, "#ffd24a", 14);
  SFX.killSeg(); game.scorpion = null; game.shake = Math.min(game.shake + 4, 10);
}

// Player death -------------------------------------------------------------
function playerHit() {
  if (!game.player || game.player.invuln > 0) return;
  SFX.playerHit();
  spawnParticles(game.player.x + 8, game.player.y + 8, "#39ff14", 24);
  game.shake = 14; game.flash = 0.4;
  game.lives--;
  if (game.lives <= 0) {
    game.state = STATE.GAMEOVER;
    if (game.score > game.high) { game.high = game.score; localStorage.setItem("centipede_high", game.high); }
    SFX.over();
  } else {
    spawnPlayer();
    // Clear nearby enemies to avoid instant re-death.
    game.spider = null; game.flea = null;
  }
}

// Particles & score pops ---------------------------------------------------
function spawnParticles(x, y, color, n) {
  if (REDUCED) n = Math.ceil(n / 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 30 + Math.random() * 90;
    game.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4 + Math.random() * 0.3, color });
  }
}
function updateParticles(dt) {
  for (const p of game.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 120 * dt; p.life -= dt; }
  game.particles = game.particles.filter(p => p.life > 0);
}
function updateScorePops(dt) {
  for (const s of game.scorePops) { s.y += s.vy * dt; s.vy *= (1 - dt * 1.5); s.life -= dt; }
  game.scorePops = game.scorePops.filter(s => s.life > 0);
}
function addScore(n) {
  game.score += n;
  // Bonus life every 10000 pts (classic). Cap lives so the HUD stays sane.
  while (game.score >= game.nextBonus && game.lives < 8) {
    game.lives++;
    game.nextBonus += 10000;
    SFX.life();
    game.scorePops.push({ x: W / 2, y: 28, vy: -28, life: 1.4, n: "1UP", color: "#ff2e88" });
  }
}
// addScore with a floating popup at screen coords (juice).
function addScoreAt(n, x, y, color = "#ffffff") {
  addScore(n);
  game.scorePops.push({ x, y, vy: -34, life: 0.9, n, color });
}

// ---------------------------------------------------------------------------
// Main loop — fixed-timestep accumulator
// ---------------------------------------------------------------------------
const FIXED_DT = 1 / 60;
let acc = 0;
let last = performance.now();

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25; // clamp after tab switch
  acc += dt;
  let steps = 0;
  while (acc >= FIXED_DT && steps < 6) {
    update(FIXED_DT);
    acc -= FIXED_DT;
    steps++;
  }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function update(dt) {
  game.phase += dt;
  if (game.muzzle > 0) game.muzzle -= dt;
  if (game.state === STATE.PLAYING) {
    movePlayer(dt);
    updateBullet(dt);
    updateCentipede(dt);
    updateSpider(dt);
    updateFlea(dt);
    updateScorpion(dt);
    updateParticles(dt);
    updateScorePops(dt);
    if (game.waveBannerTimer > 0) game.waveBannerTimer -= dt;
    // Combo decays back to 0 if you stop killing segments.
    if (game.comboTimer > 0) { game.comboTimer -= dt; if (game.comboTimer <= 0) game.combo = 0; }
    // Decay poison over level? keep.
    if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 20);
    if (game.flash > 0) game.flash = Math.max(0, game.flash - dt * 2);
  } else if (game.state === STATE.LEVELCLEAR) {
    updateParticles(dt);
    updateScorePops(dt);
    game.levelClearTimer -= dt;
    if (game.levelClearTimer <= 0) {
      game.level++;
      initLevel();
      game.state = STATE.PLAYING;
    }
  } else if (game.state === STATE.PAUSED) {
    // Frozen: no updates, no timers.
  } else {
    updateParticles(dt);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  ctx.save();
  // Screen shake (suppressed under reduced-motion).
  if (game.shake > 0 && !REDUCED) {
    ctx.translate((Math.random() - 0.5) * game.shake, (Math.random() - 0.5) * game.shake);
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  // Player band divider line.
  ctx.fillStyle = "#1a1a2a";
  ctx.fillRect(0, PLAYER_TOP_ROW * CELL, W, 1);

  drawStars();
  drawMushrooms();
  drawCentipede();
  drawSpider();
  drawFlea();
  drawScorpion();
  drawPlayer();
  drawBullet();
  drawParticles();
  drawScorePops();
  ctx.restore();

  // Flash overlay (suppressed under reduced-motion).
  if (game.flash > 0 && !REDUCED) {
    ctx.fillStyle = `rgba(255,80,80,${game.flash})`;
    ctx.fillRect(0, 0, W, H);
  }

  drawHUD();
  if (game.state === STATE.PLAYING && game.waveBannerTimer > 0) drawWaveBanner();

  // Mirror state to the screen-reader live region (throttled to state changes
  // + occasional score bumps so it isn't chatty every frame).
  if (game.state !== lastAnnouncedState) {
    lastAnnouncedState = game.state;
    announceStatus();
  }

  if (game.state === STATE.START) drawStartScreen();
  else if (game.state === STATE.GAMEOVER) drawGameOverScreen();
  else if (game.state === STATE.LEVELCLEAR) drawLevelClear();
  else if (game.state === STATE.PAUSED) drawPauseScreen();
}

function drawStars() {
  for (const st of game.stars) {
    const tw = 0.5 + 0.5 * Math.sin(game.phase * 2 + st.x); // twinkle
    ctx.globalAlpha = st.b * (0.5 + 0.5 * tw);
    ctx.fillStyle = "#556677";
    ctx.fillRect(st.x, st.y, st.s, st.s);
  }
  ctx.globalAlpha = 1;
}
function drawMushrooms() {
  for (const m of game.mushrooms) {
    ctx.drawImage(mushroomSprite(m.hp, m.poison), m.x * CELL, m.y * CELL);
  }
}
// Pre-rendered mushroom sprites keyed by `${hp}-${poison}` so each mushroom
// is one drawImage instead of 3 fillRects (the mushroom field is the most
// numerous thing on screen, so this is where batching pays off).
const mushSprites = new Map();
function mushroomSprite(hp, poison) {
  hp = Math.max(1, Math.min(4, hp));
  const key = hp + "-" + (poison ? 1 : 0);
  let s = mushSprites.get(key);
  if (s) return s;
  s = document.createElement("canvas");
  s.width = CELL; s.height = CELL;
  const g = s.getContext("2d");
  const c = poison ? "#7df9ff" : ["#3b2a6b", "#5a3f9c", "#7a4fb0", "#a070d0"][4 - hp];
  g.fillStyle = c;
  g.fillRect(2, 3, CELL - 4, CELL / 2 - 2);
  g.fillRect(5, CELL / 2, CELL - 10, CELL / 3);
  g.fillStyle = "rgba(255,255,255,0.25)";
  g.fillRect(4, 5, 3, 3);
  mushSprites.set(key, s);
  return s;
}

function drawCentipede() {
  const leg = (game.phase * 12) % 4 < 2 ? 0 : 2; // leg animation: two-frame wiggle
  for (const chain of game.centipedes) {
    for (let i = 0; i < chain.length; i++) {
      const s = chain[i];
      const isHead = i === 0;
      ctx.fillStyle = s.poison ? "#7df9ff" : (isHead ? "#39ff14" : "#22cc11");
      ctx.fillRect(s.x + 1, s.y + 2, CELL - 2, CELL - 4);
      // animated legs
      ctx.fillRect(s.x, s.y + 4 + leg, 2, 2);
      ctx.fillRect(s.x + CELL - 2, s.y + 4 - leg, 2, 2);
      ctx.fillRect(s.x, s.y + CELL - 6 - leg, 2, 2);
      ctx.fillRect(s.x + CELL - 2, s.y + CELL - 6 + leg, 2, 2);
      if (isHead) {
        // eyes
        ctx.fillStyle = "#000";
        ctx.fillRect(s.x + 4, s.y + 5, 2, 2);
        ctx.fillRect(s.x + CELL - 6, s.y + 5, 2, 2);
      }
    }
  }
}

function drawSpider() {
  if (!game.spider) return;
  const s = game.spider;
  ctx.fillStyle = "#ff2e88";
  ctx.fillRect(s.x + 2, s.y + 4, s.w - 4, s.h - 8);
  // legs
  ctx.fillRect(s.x, s.y + 2, 2, 4);
  ctx.fillRect(s.x + s.w - 2, s.y + 2, 2, 4);
  ctx.fillRect(s.x, s.y + s.h - 6, 2, 4);
  ctx.fillRect(s.x + s.w - 2, s.y + s.h - 6, 2, 4);
  ctx.fillStyle = "#fff";
  ctx.fillRect(s.x + 5, s.y + 7, 2, 2);
  ctx.fillRect(s.x + s.w - 7, s.y + 7, 2, 2);
}

function drawFlea() {
  if (!game.flea) return;
  const f = game.flea;
  ctx.fillStyle = "#88ddff";
  ctx.fillRect(f.x, f.y, f.w, f.h);
  ctx.fillStyle = "#fff";
  ctx.fillRect(f.x + 2, f.y + 2, 2, 2);
  ctx.fillRect(f.x + f.w - 4, f.y + 2, 2, 2);
}

function drawScorpion() {
  if (!game.scorpion) return;
  const s = game.scorpion;
  ctx.fillStyle = "#ffd24a";
  ctx.fillRect(s.x + 2, s.y + 2, s.w - 4, s.h - 4);
  ctx.fillRect(s.x, s.y + 4, 2, 4);
  ctx.fillRect(s.x + s.w - 2, s.y + 4, 2, 4);
  // tail
  ctx.fillRect(s.x + s.w / 2 - 1, s.y - 3, 2, 4);
}

function drawPlayer() {
  const p = game.player; if (!p) return;
  if (p.invuln > 0 && Math.floor(p.blink * 12) % 2 === 0) return;
  ctx.fillStyle = "#ffcc33";
  // body
  ctx.fillRect(p.x + 4, p.y + 4, p.w - 8, p.h - 6);
  // turret
  ctx.fillRect(p.x + p.w / 2 - 2, p.y, 4, 6);
  // base
  ctx.fillStyle = "#ff7733";
  ctx.fillRect(p.x + 2, p.y + p.h - 4, p.w - 4, 3);
  // muzzle flash on fire
  if (game.muzzle > 0) {
    ctx.fillStyle = "rgba(255,255,180," + Math.min(1, game.muzzle * 18) + ")";
    ctx.fillRect(p.x + p.w / 2 - 3, p.y - 4, 6, 5);
  }
}

function drawBullet() {
  if (!game.bullet) return;
  ctx.fillStyle = "#fff";
  ctx.fillRect(game.bullet.x, game.bullet.y, game.bullet.w, game.bullet.h);
}

function drawParticles() {
  for (const p of game.particles) {
    ctx.fillStyle = p.color;
    ctx.globalAlpha = Math.max(0, p.life * 2);
    ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
  }
  ctx.globalAlpha = 1;
}
function drawScorePops() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 13px 'Courier New', monospace";
  for (const s of game.scorePops) {
    ctx.globalAlpha = Math.min(1, s.life * 1.6);
    ctx.fillStyle = s.color;
    ctx.fillText("" + s.n, s.x, s.y);
  }
  ctx.globalAlpha = 1;
}

function drawHUD() {
  ctx.fillStyle = "#39ff14";
  ctx.font = "14px 'Courier New', monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("SCORE " + game.score, 8, 6);
  ctx.textAlign = "center";
  ctx.fillText("HIGH " + Math.max(game.high, game.score), W / 2, 6);
  ctx.textAlign = "right";
  ctx.fillText("LIVES " + game.lives + "  LV " + game.level, W - 8, 6);
}

function centerText(text, y, size = 18, color = "#39ff14") {
  ctx.fillStyle = color;
  ctx.font = `${size}px 'Courier New', monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, W / 2, y);
}

function drawStartScreen() {
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(0, 0, W, H);
  centerText("CENTIPEDE", H / 2 - 60, 36, "#39ff14");
  centerText("Arrow Keys / WASD to move", H / 2 - 6, 14, "#cfcfcf");
  centerText("Space to fire   ·   P to pause", H / 2 + 16, 14, "#cfcfcf");
  centerText("Touch controls on mobile", H / 2 + 38, 12, "#8a8a8a");
  centerText("Press ENTER or TAP to start", H / 2 + 90, 16, "#ff2e88");
}

function drawGameOverScreen() {
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(0, 0, W, H);
  centerText("GAME OVER", H / 2 - 50, 34, "#ff2e88");
  centerText("Score " + game.score + "   High " + game.high, H / 2 - 8, 16, "#cfcfcf");
  // Restart button (drawn rect; clickable via pointer).
  const bw = 160, bh = 44, bx = W / 2 - bw / 2, by = H / 2 + 30;
  ctx.fillStyle = "#ff2e88";
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = "#000";
  centerText("RESTART", by + bh / 2, 18, "#000");
  centerText("Press ENTER", H / 2 + 92, 12, "#cfcfcf");
  // Store button rect for click handling.
  restartBtn = { x: bx, y: by, w: bw, h: bh };
}

function drawLevelClear() {
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, W, H);
  centerText("LEVEL " + game.level + " CLEARED", H / 2 - 10, 22, "#39ff14");
  centerText("Next wave incoming…", H / 2 + 18, 14, "#cfcfcf");
}
function drawPauseScreen() {
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, W, H);
  centerText("PAUSED", H / 2 - 14, 30, "#39ff14");
  centerText("Press P or Esc to resume", H / 2 + 22, 13, "#cfcfcf");
}
function drawWaveBanner() {
  const a = Math.min(1, game.waveBannerTimer * 1.4);
  ctx.globalAlpha = a;
  centerText("WAVE " + game.level, H * 0.28, 26, "#39ff14");
  ctx.globalAlpha = 1;
}

let restartBtn = null;
// Expose core state for debugging / automated smoke tests (no build, no module system).
window.game = game;

// Click/tap to restart on game over.
canvas.addEventListener("pointerdown", (e) => {
  ensureAudio();
  if (game.state === STATE.START) { startGame(); return; }
  if (game.state === STATE.GAMEOVER) {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (W / r.width);
    const y = (e.clientY - r.top) * (H / r.height);
    if (restartBtn && x >= restartBtn.x && x <= restartBtn.x + restartBtn.w &&
        y >= restartBtn.y && y <= restartBtn.y + restartBtn.h) {
      startGame();
    }
  }
});