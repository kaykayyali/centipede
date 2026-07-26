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

// Entity state machine values.
const STATE = { START: 0, PLAYING: 1, GAMEOVER: 2, LEVELCLEAR: 3 };

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
  killSeg:  () => { blip(660, 0.06); blip(330, 0.12, "sawtooth", 0.07); },
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
  }
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
  mushrooms: [],         // sparse grid: map "x,y" -> {x,y,hp,poison}
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
};

function startGame() {
  game.state = STATE.PLAYING;
  game.score = 0;
  game.lives = 3;
  game.level = 1;
  game.particles.length = 0;
  game.scorePops.length = 0;
  game.shake = 0; game.flash = 0;
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
  // (classic behaviour) — but ensure density target.
  if (game.level === 1) {
    game.mushrooms = [];
    seedMushrooms(40);
  } else {
    // Top up to a target density so the field doesn't thin to nothing.
    topUpMushrooms(40);
  }

  spawnCentipede();
}

// Mushrooms -----------------------------------------------------------------
function mkey(x, y) { return x + "," + y; }
function getMushroom(x, y) {
  for (const m of game.mushrooms) if (m.x === x && m.y === y) return m;
  return null;
}
function addMushroom(x, y, poison = false) {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return null;
  if (getMushroom(x, y)) return null;
  // Don't plant inside player band too densely near spawn.
  const m = { x, y, hp: 4, poison };
  game.mushrooms.push(m);
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
    const idx = game.mushrooms.indexOf(m);
    if (idx >= 0) game.mushrooms.splice(idx, 1);
    addScore(1);
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
        addScore(10);
        SFX.killSeg();
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
function spawnCentipede() {
  const len = Math.min(9 + game.level, 14);
  const speed = 60 + game.level * 14;
  const chain = [];
  for (let i = 0; i < len; i++) {
    chain.push({
      x: (COLS - 1 - i) * CELL,
      y: 0,
      dir: -1, // moving left initially from top-right
      dropDir: 1, // drop down when blocked
      isHead: i === 0,
      poison: false,
    });
  }
  game.centipedes.push(chain);
}
function updateCentipede(dt) {
  for (const chain of game.centipedes) {
    if (chain.length === 0) continue;
    const head = chain[0];
    const speed = (head.poison ? 130 : 60 + game.level * 14) * (head.y >= PLAYER_TOP_ROW * CELL ? 1.25 : 1);
    // Movement: head moves horizontally; body follows.
    head.x += head.dir * speed * dt;
    // Wall bounce
    if (head.x < 0) { head.x = 0; dropChain(chain); }
    else if (head.x > W - CELL) { head.x = W - CELL; dropChain(chain); }
    // Mushroom bounce
    const hx = Math.floor((head.x + CELL / 2) / CELL);
    const hy = Math.floor((head.y + CELL / 2) / CELL);
    const ahead = getMushroom(head.dir < 0 ? hx - 1 : hx + 1, hy);
    if (ahead) { dropChain(chain); }
    // Body trail: each segment follows previous segment's position with offset.
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1], cur = chain[i];
      const dx = prev.x - cur.x, dy = prev.y - cur.y;
      const dist = Math.hypot(dx, dy);
      if (dist > CELL) {
        const move = dist - CELL;
        cur.x += (dx / dist) * move;
        cur.y += (dy / dist) * move;
      }
    }
    // Touch player?
    if (game.player && rectHit(segRect(head), game.player) && game.player.invuln <= 0) {
      playerHit();
    }
  }
  // Remove empty chains.
  game.centipedes = game.centipedes.filter(c => c.length > 0);
  // Level clear?
  if (game.centipedes.length === 0 && game.state === STATE.PLAYING) {
    game.state = STATE.LEVELCLEAR;
    game.levelClearTimer = 1.6;
    SFX.level();
  }
}
function dropChain(chain) {
  const head = chain[0];
  head.dir = -head.dir;
  // Drop a row. In player band, centipede still drops but reverses; classic.
  const ny = head.y + CELL;
  if (ny > H - CELL) {
    // Wrap back to top (re-enter) — classic centipede reappears at top as new head.
    head.y = 0;
  } else {
    head.y = ny;
  }
  // Body snaps behind head.
  for (let i = 1; i < chain.length; i++) {
    chain[i].x = head.x + i * CELL * head.dir;
    chain[i].y = head.y;
  }
}

// Spider --------------------------------------------------------------------
let spiderTimer = 0;
function updateSpider(dt) {
  spiderTimer -= dt;
  if (!game.spider && spiderTimer <= 0) {
    spiderTimer = 5 + Math.random() * 4;
    if (game.state === STATE.PLAYING) {
      const fromLeft = Math.random() < 0.5;
      game.spider = {
        x: fromLeft ? -CELL : W,
        y: (PLAYER_TOP_ROW + 2 + Math.random() * 4) * CELL,
        w: 18, h: 18,
        vx: (fromLeft ? 1 : -1) * (60 + Math.random() * 40),
        vy: (Math.random() < 0.5 ? 1 : -1) * 80,
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
    const idx = game.mushrooms.indexOf(m); if (idx >= 0) game.mushrooms.splice(idx, 1);
  }
  if (s.x < -CELL * 2 || s.x > W + CELL) game.spider = null;
  if (game.player && game.player.invuln <= 0 && rectHit(s, game.player)) playerHit();
}
function hitSpider() {
  addScore(300 + Math.floor(Math.random() * 3) * 100);
  spawnParticles(game.spider.x, game.spider.y, "#ff2e88", 14);
  SFX.killSeg();
  game.spider = null; game.shake = Math.min(game.shake + 4, 10);
}

// Flea ---------------------------------------------------------------------
function updateFlea(dt) {
  // Spawn a flea when the bottom 6 rows have few mushrooms.
  if (!game.flea && game.state === STATE.PLAYING) {
    let lowCount = 0;
    for (const m of game.mushrooms) if (m.y > PLAYER_TOP_ROW - 2) lowCount++;
    if (lowCount < 5 && Math.random() < 0.02) {
      game.flea = {
        x: (Math.random() * (COLS - 2) + 1) * CELL,
        y: -CELL,
        w: 12, h: 14,
        vy: 200,
        dropTimer: 0,
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
  if (game.flea.hp === undefined) { game.flea.hp = 2; game.flea.vy *= 1.5; addScore(50); SFX.hitSeg(); }
  else {
    addScore(50); spawnParticles(game.flea.x, game.flea.y, "#88ddff", 10); SFX.killSeg(); game.flea = null;
  }
}

// Scorpion -----------------------------------------------------------------
let scorpionTimer = 0;
function updateScorpion(dt) {
  scorpionTimer -= dt;
  if (!game.scorpion && scorpionTimer <= 0 && game.state === STATE.PLAYING && game.level >= 2) {
    scorpionTimer = 12 + Math.random() * 8;
    const fromLeft = Math.random() < 0.5;
    game.scorpion = {
      x: fromLeft ? -CELL : W,
      y: (PLAYER_TOP_ROW - 4) * CELL,
      w: 20, h: 12,
      vx: (fromLeft ? 1 : -1) * 90,
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
  addScore(1000); spawnParticles(game.scorpion.x, game.scorpion.y, "#ffd24a", 14);
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
function addScore(n) {
  game.score += n;
  if (game.score > game.high) { /* live high not persisted until death */ }
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
  if (game.state === STATE.PLAYING) {
    movePlayer(dt);
    updateBullet(dt);
    updateCentipede(dt);
    updateSpider(dt);
    updateFlea(dt);
    updateScorpion(dt);
    updateParticles(dt);
    // Decay poison over level? keep.
    if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 20);
    if (game.flash > 0) game.flash = Math.max(0, game.flash - dt * 2);
  } else if (game.state === STATE.LEVELCLEAR) {
    updateParticles(dt);
    game.levelClearTimer -= dt;
    if (game.levelClearTimer <= 0) {
      game.level++;
      initLevel();
      game.state = STATE.PLAYING;
    }
  } else {
    updateParticles(dt);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  ctx.save();
  // Screen shake.
  if (game.shake > 0) {
    ctx.translate((Math.random() - 0.5) * game.shake, (Math.random() - 0.5) * game.shake);
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  // Player band divider line.
  ctx.fillStyle = "#1a1a2a";
  ctx.fillRect(0, PLAYER_TOP_ROW * CELL, W, 1);

  drawMushrooms();
  drawCentipede();
  drawSpider();
  drawFlea();
  drawScorpion();
  drawPlayer();
  drawBullet();
  drawParticles();
  ctx.restore();

  // Flash overlay.
  if (game.flash > 0) {
    ctx.fillStyle = `rgba(255,80,80,${game.flash})`;
    ctx.fillRect(0, 0, W, H);
  }

  drawHUD();

  if (game.state === STATE.START) drawStartScreen();
  else if (game.state === STATE.GAMEOVER) drawGameOverScreen();
  else if (game.state === STATE.LEVELCLEAR) drawLevelClear();
}

function drawMushrooms() {
  for (const m of game.mushrooms) {
    const x = m.x * CELL, y = m.y * CELL;
    const c = m.poison ? "#7df9ff" : ["#3b2a6b","#5a3f9c","#7a4fb0","#a070d0"][Math.min(3, 4 - m.hp)];
    ctx.fillStyle = c;
    // mushroom cap + stem dots
    ctx.fillRect(x + 2, y + 3, CELL - 4, CELL / 2 - 2);
    ctx.fillRect(x + 5, y + CELL / 2, CELL - 10, CELL / 3);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(x + 4, y + 5, 3, 3);
  }
}

function drawCentipede() {
  for (const chain of game.centipedes) {
    for (let i = 0; i < chain.length; i++) {
      const s = chain[i];
      const isHead = i === 0;
      ctx.fillStyle = s.poison ? "#7df9ff" : (isHead ? "#39ff14" : "#22cc11");
      ctx.fillRect(s.x + 1, s.y + 2, CELL - 2, CELL - 4);
      // legs
      ctx.fillRect(s.x, s.y + 4, 2, 2);
      ctx.fillRect(s.x + CELL - 2, s.y + 4, 2, 2);
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
  centerText("Space to fire", H / 2 + 16, 14, "#cfcfcf");
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