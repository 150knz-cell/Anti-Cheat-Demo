'use strict';
/* ============================================================================
 * tests.js  --  Automated test suite
 * ----------------------------------------------------------------------------
 * These tests drive the REAL Game, AntiCheat and Cheats modules -- not a copy
 * of the detection logic. Each test resets the world, performs an action by
 * stepping the actual fixed-timestep simulation (Game.tick) and/or firing a
 * real cheat, then asserts on the real AntiCheat event log.
 *
 * Coverage:
 *   POSITIVE -- each cheat triggers its headline detector.
 *   SEPARATION -- each cheat triggers ONLY its headline (the demo stays clean).
 *   NEGATIVE -- legitimate play produces ZERO violations, INCLUDING held-key
 *               and diagonal WASD movement and natural deceleration, and
 *               normal-paced coin collection does not look like a bot.
 *
 * Determinism: because the simulation uses a fixed timestep and an injectable
 * sim clock (state.now), every test is fully reproducible -- no reliance on
 * real wall-clock time or frame rate.
 *
 * Runs in the browser (via the "Run tests" button) and headlessly in Node.
 * ==========================================================================*/

(function (root) {

  var Game = root.Game;
  var AntiCheat = root.AntiCheat;
  var Cheats = root.Cheats;

  var MAX_STEP = Game.config.MAX_STEP; // 4 px -- the legitimate per-tick cap

  /* ----------------------------------------------------------------------- *
   * Tiny assertion helpers
   * ----------------------------------------------------------------------- */
  var results = [];
  function assert(name, cond, detail) {
    results.push({ name: name, pass: !!cond, detail: cond ? '' : (detail || '') });
  }

  function types() { return AntiCheat.getEvents().map(function (e) { return e.type; }); }
  function fired(type) { return types().indexOf(type) !== -1; }
  function count() { return AntiCheat.getEvents().length; }

  // Common setup: fresh world + a coin parked far away so it cannot be collected
  // by accident during pure-movement tests.
  function setup(parkCoinFarFrom) {
    Game.reset();
    if (parkCoinFarFrom) {
      // Put the coin somewhere the movement under test will not reach.
      Game.state.coin.x = parkCoinFarFrom.x;
      Game.state.coin.y = parkCoinFarFrom.y;
      Game.state.coin.spawnTime = Game.state.now;
    }
  }

  function hold(dir) { Game.setKey(dir, true); }
  function release(dir) { Game.setKey(dir, false); }
  function releaseAll() { ['up', 'down', 'left', 'right'].forEach(function (d) { release(d); }); }
  function ticks(n) { for (var i = 0; i < n; i++) Game.tick(); }

  /* ======================================================================= *
   * POSITIVE + SEPARATION TESTS
   * ======================================================================= */

  // 1. Speed hack -> SPEED_VIOLATION (and nothing else).
  function testSpeedHack() {
    setup({ x: 320, y: 30 });          // coin far from the horizontal path
    Game.state.player.x = 60;          // room to accelerate rightwards
    Game.state.player.y = 240;
    hold('right');
    Cheats.speedHack(true);
    ticks(20);                         // let velocity ramp past the threshold
    releaseAll();
    Cheats.speedHack(false);

    assert('Speed hack -> SPEED_VIOLATION fires', fired('SPEED_VIOLATION'),
      'types=' + types().join(','));
    assert('Speed hack does NOT look like a teleport', !fired('TELEPORT'),
      'types=' + types().join(','));
  }

  // 2. Score injection (+1000) -> SCORE_INTEGRITY (and not the checksum).
  function testScoreInjection() {
    setup({ x: 320, y: 30 });
    Cheats.injectScore(1000);
    ticks(1);
    assert('Score injection -> SCORE_INTEGRITY fires', fired('SCORE_INTEGRITY'),
      'types=' + types().join(','));
    assert('Score injection is owned by the score detector, not tamper',
      !fired('STATE_TAMPER'), 'types=' + types().join(','));
  }

  // 3. Teleport -> TELEPORT (and not a plain speed flag).
  function testTeleport() {
    setup({ x: 20, y: 30 });
    ticks(2);                          // establish a baseline position
    Cheats.teleport();
    ticks(1);
    assert('Teleport -> TELEPORT fires', fired('TELEPORT'),
      'types=' + types().join(','));
    assert('Teleport does NOT also fire a speed violation',
      !fired('SPEED_VIOLATION'), 'types=' + types().join(','));
  }

  // 4. Tamper -> STATE_TAMPER, while the naive score check is fooled.
  function testTamper() {
    setup({ x: 20, y: 30 });
    ticks(2);
    Cheats.tamperState();              // coins +50, score +500 (invariant intact)
    ticks(1);
    assert('Tamper -> STATE_TAMPER fires', fired('STATE_TAMPER'),
      'types=' + types().join(','));
    assert('Tamper fools the naive score check (no SCORE_INTEGRITY)',
      !fired('SCORE_INTEGRITY'), 'types=' + types().join(','));
    assert('Score invariant still holds after the sneaky tamper',
      Game.state.score === Game.state.coinsCollected * Game.config.COIN_VALUE,
      'score=' + Game.state.score + ' coins=' + Game.state.coinsCollected);
  }

  // 5. Bot -> STAT_ANOMALY, with score kept consistent (value detectors quiet).
  function testBot() {
    setup({ x: 20, y: 30 });
    Cheats.simulateBot({ collects: 14, gapMs: 10 });
    ticks(1); // run a real inspection so the value-detector assertions below mean something
    assert('Bot -> STAT_ANOMALY fires', fired('STAT_ANOMALY'),
      'types=' + types().join(','));
    assert('Bot keeps score consistent (no SCORE_INTEGRITY)',
      !fired('SCORE_INTEGRITY'), 'types=' + types().join(','));
    assert('Bot does not trip the checksum (it used the sanctioned path)',
      !fired('STATE_TAMPER'), 'types=' + types().join(','));
  }

  /* ======================================================================= *
   * NEGATIVE TESTS -- legitimate human play must produce ZERO violations
   * ======================================================================= */

  // 6. Straight held-key movement for a full second.
  function testLegitStraight() {
    setup({ x: 600, y: 30 });          // coin out of the rightward path
    Game.state.player.x = 80;
    Game.state.player.y = 240;
    hold('right');
    ticks(60);
    releaseAll();
    assert('Straight held-key movement -> zero violations', count() === 0,
      'events=' + types().join(','));
  }

  // 7. Diagonal held-key (W+D) movement. A PASS here proves diagonal speed is
  //    normalised: if it were not, the per-tick distance would be ~5.66 px,
  //    above the 5.4 px threshold, and SPEED_VIOLATION would fire.
  function testLegitDiagonal() {
    setup({ x: 30, y: 30 });           // coin behind us (we move down-right)
    Game.state.player.x = 200;
    Game.state.player.y = 130;
    hold('right'); hold('down');

    var prev = { x: Game.state.player.x, y: Game.state.player.y };
    var maxStep = 0;
    for (var i = 0; i < 40; i++) {
      Game.tick();
      var dx = Game.state.player.x - prev.x;
      var dy = Game.state.player.y - prev.y;
      maxStep = Math.max(maxStep, Math.sqrt(dx * dx + dy * dy));
      prev = { x: Game.state.player.x, y: Game.state.player.y };
    }
    releaseAll();

    assert('Diagonal movement -> zero violations', count() === 0,
      'events=' + types().join(','));
    assert('Diagonal is NOT faster than straight (normalised)',
      maxStep <= MAX_STEP * 1.05,
      'maxStep=' + maxStep.toFixed(3) + ' cap=' + (MAX_STEP * 1.05).toFixed(3));
    assert('Diagonal still reaches full speed (not crippled)',
      maxStep >= MAX_STEP * 0.9,
      'maxStep=' + maxStep.toFixed(3));
  }

  // 8. Natural acceleration then deceleration (release keys and coast to a stop).
  function testLegitAccelDecel() {
    setup({ x: 600, y: 30 });
    Game.state.player.x = 100;
    Game.state.player.y = 240;
    hold('right');
    ticks(20);
    releaseAll();                      // let it glide to a halt
    ticks(40);
    assert('Accelerate + decelerate -> zero violations', count() === 0,
      'events=' + types().join(','));
  }

  // 9. Normal-paced coin collection must not look like a bot.
  function testLegitCollectionPace() {
    setup();
    for (var i = 0; i < 8; i++) {
      Game.state.now += 400;           // a relaxed ~2.5 coins/second
      Game.collectCoin();
    }
    ticks(1);                          // one inspection to confirm values are clean
    assert('Human-paced collection -> no STAT_ANOMALY', !fired('STAT_ANOMALY'),
      'events=' + types().join(','));
    assert('Human-paced collection -> zero violations of any kind', count() === 0,
      'events=' + types().join(','));
  }

  // 10. A coin collected the moment it spawns once is fine; only SUSTAINED
  //     inhuman timing should flag (guards against single-sample false positives).
  function testLegitFastButOnce() {
    setup();
    Game.state.now += 5;               // one very fast pickup...
    Game.collectCoin();
    for (var i = 0; i < 4; i++) {      // ...followed by normal-paced ones
      Game.state.now += 500;
      Game.collectCoin();
    }
    assert('A single fast pickup among normal ones -> no STAT_ANOMALY',
      !fired('STAT_ANOMALY'), 'events=' + types().join(','));
  }

  /* ======================================================================= *
   * Runner
   * ======================================================================= */
  function run(onResult) {
    results = [];
    var suite = [
      testSpeedHack, testScoreInjection, testTeleport, testTamper, testBot,
      testLegitStraight, testLegitDiagonal, testLegitAccelDecel,
      testLegitCollectionPace, testLegitFastButOnce
    ];
    for (var i = 0; i < suite.length; i++) {
      try {
        suite[i]();
      } catch (err) {
        results.push({ name: suite[i].name + ' (threw)', pass: false, detail: String(err) });
      }
    }
    // Leave the world in a clean state for the live demo after testing.
    Game.reset();

    var passed = 0;
    for (var j = 0; j < results.length; j++) if (results[j].pass) passed++;
    var summary = { results: results.slice(), passed: passed, failed: results.length - passed, total: results.length };

    if (typeof onResult === 'function') onResult(summary);
    return summary;
  }

  // Plain-text summary (used by the Node CLI runner).
  function format(summary) {
    var lines = summary.results.map(function (r) {
      return (r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '   [' + r.detail + ']' : '');
    });
    lines.push('');
    lines.push(summary.passed + '/' + summary.total + ' passed, ' + summary.failed + ' failed');
    return lines.join('\n');
  }

  root.Tests = { run: run, format: format };

  /* ----------------------------------------------------------------------- *
   * Node CLI auto-run: `node run-tests.js` (see that file). When loaded under
   * Node with an explicit RUN flag, print the summary and set the exit code.
   * ----------------------------------------------------------------------- */
  if (typeof window === 'undefined' && root.__RUN_TESTS__) {
    var s = run();
    console.log(format(s));
    if (typeof process !== 'undefined') process.exitCode = s.failed ? 1 : 0;
  }

})(typeof window !== 'undefined' ? window : globalThis);
