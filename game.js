'use strict';
/* ============================================================================
 * game.js  --  The mock game (model + physics + rendering)
 * ----------------------------------------------------------------------------
 * A simple top-down "collect the coins" game on a 2D canvas.
 *
 * Design decisions that matter for the anti-cheat demo:
 *
 *   1. ONE central state object (`state`) is the single source of truth. The
 *      anti-cheat module inspects this object; it keeps no physics of its own.
 *
 *   2. The simulation runs on a FIXED timestep. Every tick is exactly FIXED_DT
 *      seconds, which makes the anti-cheat math clean (the max legitimate move
 *      per tick is a constant) and makes the automated tests deterministic.
 *
 *   3. There is exactly ONE sanctioned way to gain score: collectCoin(). It is
 *      the only function that increments the score and the only thing that
 *      reports a "coin collected" event to the anti-cheat. Anything that changes
 *      score/position/counters WITHOUT going through the sanctioned path is, by
 *      definition, a cheat -- which is exactly what the detectors look for.
 *
 * LANGUAGE: per the assignment, code/comments/identifiers are English. Only the
 * on-screen UI text (index.html) and README are Bulgarian.
 *
 * The module attaches to `window` in the browser and to `globalThis` under
 * Node, so the same files can be unit-tested headlessly from the command line.
 * ==========================================================================*/

(function (root) {

  /* --------------------------------------------------------------------------
   * 1. CONFIGURATION CONSTANTS
   * These describe the limits of legitimate play. The anti-cheat keeps its OWN
   * private copies of the critical ones (see anticheat.js) so that a cheat
   * editing game config can never move the goalposts.
   * ------------------------------------------------------------------------*/
  var CONFIG = {
    CANVAS_W: 640,
    CANVAS_H: 420,

    PLAYER_SIZE: 26,        // px (drawn as a rounded square; collision uses a circle)
    COIN_SIZE: 16,          // px

    MAX_SPEED: 240,         // px/second -- the fixed top movement speed
    ACCEL: 2000,            // px/second^2 -- how quickly we reach MAX_SPEED
    FIXED_DT: 1 / 60,       // seconds per simulation tick (60 ticks/second)

    COIN_VALUE: 10          // points awarded per coin
  };
  CONFIG.FIXED_MS = CONFIG.FIXED_DT * 1000;             // ≈ 16.667 ms per tick
  // Maximum legitimate distance per tick. Because diagonals are normalised,
  // this single number is the cap in EVERY direction.
  CONFIG.MAX_STEP = CONFIG.MAX_SPEED * CONFIG.FIXED_DT; // = 4 px

  /* --------------------------------------------------------------------------
   * 2. CENTRAL GAME STATE  (the anti-cheat's source of truth)
   * ------------------------------------------------------------------------*/
  var state = {
    // Player position is the CENTRE of the square. vx/vy are in px/second.
    player: { x: 0, y: 0, vx: 0, vy: 0, size: CONFIG.PLAYER_SIZE },
    coin:   { x: 0, y: 0, size: CONFIG.COIN_SIZE, spawnTime: 0 },

    score: 0,             // current points (only collectCoin() should change this)
    coinsCollected: 0,    // number of coins legitimately collected

    timeMs: 0,            // elapsed PLAY time in ms (frozen while paused)
    now: 0,               // monotonic simulation clock in ms (drives all timing)

    paused: false,

    // CRITICAL protected fields -------------------------------------------
    // `maxSpeed` is normally equal to the honest MAX_SPEED. The checksum/tamper
    // detector watches it: a cheat raising the cap is caught even though no
    // single move looks impossible yet.
    maxSpeed: CONFIG.MAX_SPEED,
    // `speedMultiplier` is what the "speed hack" manipulates (normal = 1). It is
    // deliberately separate from maxSpeed so the speed-hack demo trips the SPEED
    // detector (per-tick distance) rather than the tamper detector.
    speedMultiplier: 1,

    // Held-key state (continuous movement, NOT one-shot key presses).
    keys: { up: false, down: false, left: false, right: false },

    // bookkeeping (not gameplay)
    _lastCollectNow: null
  };

  /* --------------------------------------------------------------------------
   * 3. RENDER / EFFECT STATE (purely cosmetic; never inspected by anti-cheat)
   * ------------------------------------------------------------------------*/
  var ctx = null;
  var rafId = null;
  var onHud = null;          // optional callback(state) used to refresh the HUD
  var pickupEffects = [];    // brief expanding rings shown on coin pickup
  var audioCtx = null;       // created lazily on first user gesture

  /* --------------------------------------------------------------------------
   * 4. SMALL HELPERS
   * ------------------------------------------------------------------------*/
  function rand(min, max) { return min + Math.random() * (max - min); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function nowReal() {
    return (root.performance && root.performance.now) ? root.performance.now() : Date.now();
  }
  // Move `cur` towards `target` by at most `maxDelta` (used for accel + decel).
  function approach(cur, target, maxDelta) {
    if (cur < target) return Math.min(cur + maxDelta, target);
    if (cur > target) return Math.max(cur - maxDelta, target);
    return cur;
  }

  /* --------------------------------------------------------------------------
   * 5. CORE GAME ACTIONS
   * ------------------------------------------------------------------------*/

  // Place a new coin at a random spot, avoiding spawning right on top of the
  // player (so it never instantly auto-collects -- which would itself look
  // "inhuman" and is bad gameplay).
  function spawnCoin() {
    var m = 26; // wall margin
    var minDist = state.player.size + state.coin.size + 40;
    var x = 0, y = 0, tries = 0;
    do {
      x = rand(m, CONFIG.CANVAS_W - m);
      y = rand(m, CONFIG.CANVAS_H - m);
      tries++;
      var dx = x - state.player.x, dy = y - state.player.y;
      if (Math.sqrt(dx * dx + dy * dy) >= minDist) break;
    } while (tries < 25);
    state.coin.x = x;
    state.coin.y = y;
    state.coin.spawnTime = state.now; // remember when it appeared (for reaction time)
  }

  // The ONE sanctioned scoring path. Both genuine collisions and the (cheating)
  // bot call this, so score/coins always stay internally consistent. That is
  // intentional: the bot is therefore catchable ONLY by behavioural/timing
  // analysis, which is the whole point of the statistical detector.
  function collectCoin() {
    var reaction = state.now - state.coin.spawnTime; // how long the coin existed

    state.coinsCollected += 1;
    state.score += CONFIG.COIN_VALUE;

    // Report a LEGITIMATE collection. The anti-cheat rebuilds its trusted
    // score/coin ledger purely from these events.
    if (root.AntiCheat) {
      root.AntiCheat.notifyCoinCollected({ now: state.now, reaction: reaction });
    }

    state._lastCollectNow = state.now;
    spawnCue(state.coin.x, state.coin.y);
    spawnCoin();
  }

  // Advance velocity from held keys: normalised diagonals + smooth accel/decel.
  function updateMovement() {
    var dt = CONFIG.FIXED_DT;
    var p = state.player;
    var k = state.keys;

    // Build a raw direction vector from the held keys.
    var dirX = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    var dirY = (k.down ? 1 : 0) - (k.up ? 1 : 0);

    // Normalise diagonals so e.g. W+D is NOT 1.414x faster than W alone.
    if (dirX !== 0 && dirY !== 0) {
      dirX *= Math.SQRT1_2; // 1/sqrt(2) ≈ 0.7071
      dirY *= Math.SQRT1_2;
    }

    // Speed cap. Honest cap = maxSpeed (240). The speed hack inflates
    // speedMultiplier so the per-tick distance exceeds MAX_STEP and is flagged.
    var cap = state.maxSpeed * state.speedMultiplier;
    var targetVx = dirX * cap;
    var targetVy = dirY * cap;

    // Accelerate / decelerate towards the target velocity. Because we move
    // between two vectors that are each within the cap, the resulting velocity
    // magnitude never exceeds the cap -> legitimate play never false-positives.
    var step = CONFIG.ACCEL * dt;
    p.vx = approach(p.vx, targetVx, step);
    p.vy = approach(p.vy, targetVy, step);

    // Integrate position.
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Keep the player inside the play area.
    var half = p.size / 2;
    p.x = clamp(p.x, half, CONFIG.CANVAS_W - half);
    p.y = clamp(p.y, half, CONFIG.CANVAS_H - half);
  }

  // Circle-vs-circle overlap test between player and coin.
  function checkCoinCollision() {
    var dx = state.player.x - state.coin.x;
    var dy = state.player.y - state.coin.y;
    var rr = state.player.size / 2 + state.coin.size / 2;
    if (dx * dx + dy * dy <= rr * rr) collectCoin();
  }

  /* --------------------------------------------------------------------------
   * 6. THE FIXED SIMULATION STEP
   * Exactly one of these = FIXED_DT seconds of game time. The render loop runs
   * as many as real time demands; tests call Game.tick() directly for full
   * determinism. The anti-cheat is inspected once per fixed step.
   * ------------------------------------------------------------------------*/
  function fixedStep() {
    if (state.paused) return; // frozen: no time passes, nothing to inspect

    state.now += CONFIG.FIXED_MS;
    state.timeMs += CONFIG.FIXED_MS;

    updateMovement();
    checkCoinCollision();

    if (root.AntiCheat) root.AntiCheat.inspect(state, CONFIG.FIXED_MS);
  }

  /* --------------------------------------------------------------------------
   * 7. INPUT
   * ------------------------------------------------------------------------*/
  function setKey(dir, isDown) {
    if (Object.prototype.hasOwnProperty.call(state.keys, dir)) {
      state.keys[dir] = !!isDown;
    }
  }

  // Map a physical key code to an action. Supports BOTH WASD and the arrow keys.
  function handleKeyCode(code, isDown) {
    switch (code) {
      case 'KeyW': case 'ArrowUp':    setKey('up', isDown); break;
      case 'KeyS': case 'ArrowDown':  setKey('down', isDown); break;
      case 'KeyA': case 'ArrowLeft':  setKey('left', isDown); break;
      case 'KeyD': case 'ArrowRight': setKey('right', isDown); break;
      case 'KeyP': case 'Escape':     if (isDown) togglePause(); break;
      default: break;
    }
  }

  function togglePause() {
    state.paused = !state.paused;
    if (state.paused) { state.player.vx = 0; state.player.vy = 0; } // stop drifting
  }

  /* --------------------------------------------------------------------------
   * 8. RESET
   * ------------------------------------------------------------------------*/
  function reset() {
    state.player.x = CONFIG.CANVAS_W / 2;
    state.player.y = CONFIG.CANVAS_H / 2;
    state.player.vx = 0;
    state.player.vy = 0;
    state.score = 0;
    state.coinsCollected = 0;
    state.timeMs = 0;
    state.now = 0;
    state.paused = false;
    state.maxSpeed = CONFIG.MAX_SPEED;
    state.speedMultiplier = 1;
    state.keys.up = state.keys.down = state.keys.left = state.keys.right = false;
    state._lastCollectNow = null;
    pickupEffects.length = 0;
    spawnCoin();
    // Keep the anti-cheat's trusted ledger in sync with this fresh state.
    if (root.AntiCheat) root.AntiCheat.reset();
  }

  /* --------------------------------------------------------------------------
   * 9. AUDIO + VISUAL PICKUP CUE  (cosmetic; safe to call headless / in tests)
   * ------------------------------------------------------------------------*/
  function enableAudio() {
    if (audioCtx) return;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }

  function spawnCue(x, y) {
    // Visual: an expanding ring + floating "+10".
    pickupEffects.push({ x: x, y: y, t0: nowReal() });
    // Audio: a short rising blip (only if audio has been enabled by a gesture).
    if (audioCtx) {
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(660, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(990, audioCtx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.2);
    }
  }

  /* --------------------------------------------------------------------------
   * 10. RENDERING
   * ------------------------------------------------------------------------*/
  function render() {
    if (!ctx) return;
    var W = CONFIG.CANVAS_W, H = CONFIG.CANVAS_H;

    ctx.fillStyle = '#0d1020';
    ctx.fillRect(0, 0, W, H);

    // Subtle grid so motion is easy to perceive.
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx <= W; gx += 32) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (var gy = 0; gy <= H; gy += 32) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

    // Coin (glowing gold).
    ctx.save();
    ctx.shadowColor = 'rgba(255,205,80,0.8)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(state.coin.x, state.coin.y, state.coin.size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Player (rounded square; turns red while a speed hack is active).
    var p = state.player, hs = p.size / 2;
    ctx.fillStyle = state.speedMultiplier > 1 ? '#ef4444' : '#4f8ef7';
    roundRect(ctx, p.x - hs, p.y - hs, p.size, p.size, 6);
    ctx.fill();

    // Pickup effects.
    var t = nowReal();
    for (var i = pickupEffects.length - 1; i >= 0; i--) {
      var e = pickupEffects[i];
      var age = (t - e.t0) / 400; // 0..1 over 400 ms
      if (age >= 1) { pickupEffects.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 8 + age * 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffe39a';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillText('+' + CONFIG.COIN_VALUE, e.x + 10, e.y - 12 - age * 18);
      ctx.globalAlpha = 1;
    }

    // Pause overlay (drawn UI text -> Bulgarian).
    if (state.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.font = 'bold 30px system-ui, sans-serif';
      ctx.fillText('ПАУЗА', W / 2, H / 2);
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('Натисни P или Esc за продължаване', W / 2, H / 2 + 28);
      ctx.textAlign = 'left';
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /* --------------------------------------------------------------------------
   * 11. RENDER LOOP  (fixed-timestep accumulator)
   * ------------------------------------------------------------------------*/
  function start(canvas, opts) {
    canvas.width = CONFIG.CANVAS_W;
    canvas.height = CONFIG.CANVAS_H;
    ctx = canvas.getContext('2d');
    onHud = opts && opts.onHud;
    reset();

    var last = nowReal();
    var acc = 0;

    function frame() {
      var t = nowReal();
      var dt = t - last;
      last = t;
      if (dt > 100) dt = 100; // avoid a "spiral of death" after a long stall
      acc += dt;

      // Run as many fixed steps as real time demands; each is independently
      // inspected by the anti-cheat.
      var safety = 0;
      while (acc >= CONFIG.FIXED_MS && safety < 5) {
        fixedStep();
        acc -= CONFIG.FIXED_MS;
        safety++;
      }
      if (safety >= 5) acc = 0; // fell too far behind -> drop the backlog

      render();
      if (onHud) onHud(state);
      rafId = root.requestAnimationFrame(frame);
    }
    rafId = root.requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId) root.cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* --------------------------------------------------------------------------
   * 12. PUBLIC API
   * ------------------------------------------------------------------------*/
  root.Game = {
    config: CONFIG,
    state: state,

    // lifecycle
    start: start,
    stop: stop,
    reset: reset,
    tick: fixedStep,          // advance exactly one fixed step (used by tests)

    // input
    setKey: setKey,
    handleKeyCode: handleKeyCode,
    togglePause: togglePause,

    // actions
    collectCoin: collectCoin, // the sanctioned scoring path
    spawnCoin: spawnCoin,
    enableAudio: enableAudio
  };

})(typeof window !== 'undefined' ? window : globalThis);
