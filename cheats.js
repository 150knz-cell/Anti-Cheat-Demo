'use strict';
/* ============================================================================
 * cheats.js  --  The "Cheat Console": deliberate cheat injectors
 * ----------------------------------------------------------------------------
 * Each function mutates the shared game state the way a real cheat would, so we
 * can demonstrate the anti-cheat catching it live. In a real game these edits
 * would come from outside the program (a memory editor like Cheat Engine, a
 * patched binary, a browser extension, or the DevTools console). Here they are
 * built in purely for the demonstration.
 *
 * Every cheat documents (a) its real-world equivalent and (b) which detector it
 * is designed to headline. By design each one trips exactly ONE detector, so
 * the live log stays easy to explain during the presentation.
 * ==========================================================================*/

(function (root) {

  function S() { return root.Game.state; }
  function CFG() { return root.Game.config; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ==========================================================================
   * CHEAT 1 -- SPEED HACK   (headlines DETECTOR 1: speed validation)
   * --------------------------------------------------------------------------
   * Real-world equivalent: patching the movement-speed constant in memory, or
   * forcing the game loop to run extra ticks per second.
   *
   * Implementation: multiply the movement cap. The honest per-tick step is 4 px;
   * with the multiplier the player covers ~12 px/tick while keys are held, which
   * exceeds the speed detector's tolerance and is flagged continuously.
   *
   * This is a TOGGLE so it can be turned on for the demo and back off again.
   * `on` may be omitted to flip the current state, or passed explicitly.
   * ========================================================================*/
  function speedHack(on) {
    var s = S();
    var enabled = (typeof on === 'boolean') ? on : (s.speedMultiplier === 1);
    s.speedMultiplier = enabled ? 3 : 1;
    console.log('[Cheat] speedHack ' + (enabled ? 'ENABLED (x3)' : 'disabled'));
    return enabled;
  }

  /* ==========================================================================
   * CHEAT 2 -- SCORE INJECTION   (headlines DETECTOR 2: score integrity)
   * --------------------------------------------------------------------------
   * Real-world equivalent: opening DevTools and typing `Game.state.score += 1000`
   * or memory-editing the score address.
   *
   * Implementation: add points directly, bypassing collectCoin(). No coin event
   * is emitted, so the score no longer equals coinsCollected * COIN_VALUE and the
   * integrity invariant breaks.
   * ========================================================================*/
  function injectScore(amount) {
    if (typeof amount !== 'number') amount = 1000;
    S().score += amount;
    console.log('[Cheat] injectScore +' + amount);
  }

  /* ==========================================================================
   * CHEAT 3 -- TELEPORT   (headlines DETECTOR 3: teleport detection)
   * --------------------------------------------------------------------------
   * Real-world equivalent: writing arbitrary x/y coordinates straight into the
   * position memory, bypassing the physics engine entirely.
   *
   * Implementation: jump the player a large distance in one go (well beyond the
   * 40 px teleport threshold), clamped to stay on screen. Velocity is left as-is,
   * so the physics cannot explain the jump.
   * ========================================================================*/
  function teleport() {
    var s = S(), cfg = CFG(), p = s.player, half = p.size / 2;
    var jx = 240, jy = 130; // jump distances
    // Jump away from whichever side we're nearer, so we always stay in bounds.
    p.x = clamp(p.x > cfg.CANVAS_W / 2 ? p.x - jx : p.x + jx, half, cfg.CANVAS_W - half);
    p.y = clamp(p.y > cfg.CANVAS_H / 2 ? p.y - jy : p.y + jy, half, cfg.CANVAS_H - half);
    console.log('[Cheat] teleport -> (' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ')');
  }

  /* ==========================================================================
   * CHEAT 4 -- STATE TAMPER   (headlines DETECTOR 4: checksum / trusted ledger)
   * --------------------------------------------------------------------------
   * Real-world equivalent: a background process writing into game memory between
   * frames -- the game's own code never made the change.
   *
   * Teaching point: this cheat is deliberately SNEAKY. It bumps BOTH the coin
   * counter and the score so the naive invariant `score === coins * value` still
   * holds (500 === 50 * 10). The score detector is fooled. But the checksum
   * detector rebuilds the coin count from real collection events, so the inflated
   * counter does not match the trusted ledger and the tamper is caught.
   * ========================================================================*/
  function tamperState() {
    var s = S();
    s.coinsCollected += 50; // no real coin events back these
    s.score += 50 * CFG().COIN_VALUE; // keep the naive invariant intact (the trap)
    console.log('[Cheat] tamperState: coinsCollected +50, score +500 (invariant preserved)');
  }

  /* ==========================================================================
   * CHEAT 5 -- BOT SIMULATION   (headlines DETECTOR 5: statistical anomaly)
   * --------------------------------------------------------------------------
   * Real-world equivalent: an item-bot that reads coin positions from memory and
   * collects them at machine speed, with no human navigation or reaction delay.
   *
   * Implementation: collect a burst of coins through the SANCTIONED path so the
   * score stays perfectly consistent (the bot is "playing by the rules", value-
   * wise). The only thing it cannot fake is human timing: we advance the sim
   * clock by just `gapMs` between pickups, far faster than any person could move
   * to and react to each coin. The statistical detector catches the timing.
   * ========================================================================*/
  function simulateBot(opts) {
    opts = opts || {};
    var collects = opts.collects || 14;
    var gapMs = opts.gapMs || 10;     // 10 ms between pickups == ~100 coins/sec
    var s = S();
    for (var i = 0; i < collects; i++) {
      s.now += gapMs;                 // inhuman spacing in simulated time
      root.Game.collectCoin();        // sanctioned: score/coins stay consistent
    }
    console.log('[Cheat] simulateBot: collected ' + collects + ' coins at ' + gapMs + 'ms spacing');
  }

  /* --------------------------------------------------------------------------
   * Convenience: undo persistent cheats (used by the UI reset button alongside
   * Game.reset()). speedHack is the only cheat with a lingering toggle.
   * ------------------------------------------------------------------------*/
  function clearAll() {
    S().speedMultiplier = 1;
  }

  /* --------------------------------------------------------------------------
   * PUBLIC API
   * ------------------------------------------------------------------------*/
  root.Cheats = {
    speedHack: speedHack,
    injectScore: injectScore,
    teleport: teleport,
    tamperState: tamperState,
    simulateBot: simulateBot,
    clearAll: clearAll
  };

})(typeof window !== 'undefined' ? window : globalThis);
