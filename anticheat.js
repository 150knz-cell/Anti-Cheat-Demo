'use strict';
/* ============================================================================
 * anticheat.js  --  The anti-cheat detection module
 * ----------------------------------------------------------------------------
 * Runs alongside the game loop and inspects the central game state every tick.
 * It implements FIVE clearly-labelled detection techniques and reports each
 * violation as a structured event: { type, severity, message, timestamp,
 * evidence }. This is a demo, so nothing is hard-banned -- violations are only
 * logged and surfaced to the UI.
 *
 * THE TRUST BOUNDARY (the most important idea in this file)
 * ---------------------------------------------------------
 * A correct detector must never trust values a cheat could have edited. So this
 * module keeps its OWN independent copies of the things it checks against:
 *
 *   - Its own reference constants (REF_*), NOT game config. A cheat that raises
 *     `Game.config.MAX_SPEED` cannot widen the speed threshold here.
 *   - Its own `lastPos`, captured at the end of each inspection, NOT the game's
 *     `prevX/prevY`. This is what lets it catch a teleport that happens between
 *     ticks: the game engine cannot "hide" the jump by resyncing its own fields.
 *   - A "trusted ledger" of score/coins rebuilt purely from sanctioned coin
 *     events. Anything that writes those fields directly diverges from the
 *     ledger and is caught by the checksum.
 *
 * DETECTORS, AND WHICH CHEAT EACH ONE HEADLINES
 * ---------------------------------------------
 *   1. Speed validation  -> the speed hack       (per-tick distance too large)
 *   2. Score integrity   -> the +1000 injection  (score not justified by coins)
 *   3. Teleport          -> the teleport          (single huge position jump)
 *   4. State tamper       -> the tamper           (coins/maxSpeed != trusted ledger)
 *   5. Statistical        -> the bot              (inhuman collection timing)
 *
 * The detectors' responsibilities are deliberately partitioned so that, in the
 * demo, each cheat button lights up exactly ONE headline detector:
 *   - position is owned by #1 and #3,
 *   - score is owned by #2,
 *   - the remaining critical fields (coins counter + speed cap) are owned by #4.
 * Real systems run overlapping detectors (defence in depth); we separate them
 * here so each technique is easy to explain on its own.
 * ==========================================================================*/

(function (root) {

  /* --------------------------------------------------------------------------
   * PRIVATE REFERENCE CONSTANTS  (mirror the honest physics; never read from
   * mutable game state -- see "trust boundary" above)
   * ------------------------------------------------------------------------*/
  var REF_MAX_SPEED = 240;                         // px/s  (== honest Game MAX_SPEED)
  var REF_DT = 1 / 60;                             // s     (== honest Game FIXED_DT)
  var COIN_VALUE = 10;                             // points per coin

  var SPEED_TOLERANCE = 1.35;                      // allow 35% over the ideal step
  var TELEPORT_STEP = 40;                          // px: a single jump bigger than
                                                   //     this is a discontinuity
                                                   //     (10x the 4px legit step)

  var STAT_WINDOW = 5;                             // samples needed before judging
  var MIN_INTERVAL_MS = 70;                        // mean gap between collections a
                                                   //     human can't beat (sustained)
  var MIN_REACTION_MS = 120;                       // spawn->collect time a human
                                                   //     can't beat (sustained)

  var SPEED_THROTTLE_MS = 400;                     // don't spam continuous speed flags
  var STAT_THROTTLE_MS = 600;                      // don't spam continuous bot flags

  /* --------------------------------------------------------------------------
   * PRIVATE DETECTOR STATE
   * ------------------------------------------------------------------------*/
  var lastPos = null;            // {x,y} captured by THIS module last tick

  var trustedCoins = 0;          // coins rebuilt from sanctioned events only
  var trustedScore = 0;          // == trustedCoins * COIN_VALUE

  var lastScore = 0;             // score/coins seen on the previous inspection
  var lastCoins = 0;
  var wasConsistent = true;      // edge-trigger memory for the score detector
  var wasTampered = false;       // edge-trigger memory for the tamper detector

  var acLastNow = null;          // sim time of the previous collection
  var intervals = [];            // recent gaps between collections (ms)
  var reactions = [];            // recent spawn->collect reaction times (ms)
  var lastStatNow = -1e9;        // throttle clock for statistical flags
  var lastSpeedNow = -1e9;       // throttle clock for speed flags

  var events = [];               // the violation log
  var listeners = [];            // UI callbacks

  /* --------------------------------------------------------------------------
   * UTILITIES
   * ------------------------------------------------------------------------*/

  // FNV-1a 32-bit hash -- a tiny, deterministic, non-cryptographic checksum.
  // (A real system signs state with a server-held HMAC key the client never
  // sees; see the README's "known limitations".)
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      // h *= 16777619  (mod 2^32), expressed with shifts to stay in 32-bit int
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function mean(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  // Build and emit a structured violation event.
  function report(type, severity, message, evidence) {
    var ev = {
      type: type,
      severity: severity,      // 'low' | 'medium' | 'high'
      message: message,
      timestamp: Date.now(),
      evidence: evidence
    };
    events.push(ev);
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[AntiCheat] ' + type + ' (' + severity + '): ' + message, evidence);
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](ev); } catch (e) { /* never let a UI bug break detection */ }
    }
    return ev;
  }

  /* ==========================================================================
   * DETECTOR 1 -- SPEED / MOVEMENT VALIDATION   (headlines: speed hack)
   * --------------------------------------------------------------------------
   * Every legitimate tick the player moves at most MAX_STEP = MAX_SPEED * DT
   * pixels, in ANY direction (diagonals are normalised). We compare the actual
   * per-tick displacement (measured from OUR OWN lastPos) against that bound
   * plus a small tolerance. A speed hack inflates the per-tick distance and is
   * caught here. A huge single jump is handled by the teleport detector instead
   * (see the branch in inspect()), so the two never double-report.
   * ========================================================================*/
  function checkSpeed(state, dist, dtMs) {
    var allowed = REF_MAX_SPEED * (dtMs / 1000) * SPEED_TOLERANCE; // ≈ 5.4 px
    if (dist > allowed) {
      if (state.now - lastSpeedNow < SPEED_THROTTLE_MS) return; // throttle spam
      lastSpeedNow = state.now;
      report('SPEED_VIOLATION', 'medium',
        'Player moved faster than physically possible this tick.',
        {
          distancePx: +dist.toFixed(2),
          maxAllowedPx: +allowed.toFixed(2),
          idealStepPx: +(REF_MAX_SPEED * (dtMs / 1000)).toFixed(2),
          tolerance: SPEED_TOLERANCE
        });
    }
  }

  /* ==========================================================================
   * DETECTOR 3 -- TELEPORT DETECTION            (headlines: teleport)
   * --------------------------------------------------------------------------
   * A position change larger than TELEPORT_STEP cannot be produced by the
   * physics in a single tick (it is 10x the legitimate step). We measure the
   * jump from OUR OWN lastPos, so a teleport injected BETWEEN ticks is visible
   * even though the game engine itself never produced that velocity.
   * ========================================================================*/
  function checkTeleport(state, dist, from, to) {
    report('TELEPORT', 'high',
      'Position jumped further than any legitimate single step.',
      {
        distancePx: +dist.toFixed(1),
        maxStepPx: TELEPORT_STEP,
        from: { x: +from.x.toFixed(1), y: +from.y.toFixed(1) },
        to: { x: +to.x.toFixed(1), y: +to.y.toFixed(1) }
      });
  }

  /* ==========================================================================
   * DETECTOR 2 -- SCORE INTEGRITY               (headlines: +1000 injection)
   * --------------------------------------------------------------------------
   * Legitimate scoring obeys two invariants at all times:
   *   (a) score === coinsCollected * COIN_VALUE            (consistency)
   *   (b) any change in score this tick equals the change in coins * COIN_VALUE
   *       (every point is backed by a coin)                (impossible jump)
   * A "+1000" injection breaks (a) and (b). We edge-trigger (report on the
   * transition into a bad state) so a persistent bad state does not spam.
   * Note: a smart tamper that bumps BOTH score and coins consistently passes
   * here -- and is caught by the checksum detector instead. That contrast is a
   * deliberate teaching point: a naive score check can be fooled.
   * ========================================================================*/
  function checkScore(state) {
    var expected = state.coinsCollected * COIN_VALUE;
    var consistent = (state.score === expected);

    var scoreDelta = state.score - lastScore;
    var coinsDelta = state.coinsCollected - lastCoins;
    var deltaImpossible = (scoreDelta !== coinsDelta * COIN_VALUE);

    if ((wasConsistent && !consistent) || (scoreDelta !== 0 && deltaImpossible)) {
      report('SCORE_INTEGRITY', 'high',
        'Score changed without a matching coin collection.',
        {
          score: state.score,
          coinsCollected: state.coinsCollected,
          expectedScore: expected,
          scoreDeltaThisTick: scoreDelta,
          coinsDeltaThisTick: coinsDelta
        });
    }

    wasConsistent = consistent;
    lastScore = state.score;
    lastCoins = state.coinsCollected;
  }

  /* ==========================================================================
   * DETECTOR 4 -- STATE TAMPER / CHECKSUM       (headlines: tamper)
   * --------------------------------------------------------------------------
   * We keep a checksum over the critical fields that the OTHER detectors do not
   * already own: the coins counter and the speed cap. The "trusted" side of the
   * checksum is rebuilt from sanctioned events (coins) and the honest reference
   * (maxSpeed). If a cheat writes those fields directly -- e.g. inflating the
   * coin counter to launder an illegitimate score, or raising the speed cap --
   * the live checksum diverges from the trusted checksum and we flag it, listing
   * exactly which field diverged. Edge-triggered to avoid per-tick spam.
   * ========================================================================*/
  function checkTamper(state) {
    var liveStr = state.coinsCollected + '|' + Math.round(state.maxSpeed);
    var trustStr = trustedCoins + '|' + Math.round(REF_MAX_SPEED);
    var liveSum = fnv1a(liveStr);
    var trustSum = fnv1a(trustStr);
    var mismatch = (liveSum !== trustSum);

    if (mismatch && !wasTampered) {
      var diffs = [];
      if (state.coinsCollected !== trustedCoins) {
        diffs.push({ field: 'coinsCollected', live: state.coinsCollected, trusted: trustedCoins });
      }
      if (Math.round(state.maxSpeed) !== Math.round(REF_MAX_SPEED)) {
        diffs.push({ field: 'maxSpeed', live: state.maxSpeed, trusted: REF_MAX_SPEED });
      }
      report('STATE_TAMPER', 'high',
        'Critical state does not match the event-reconstructed trusted ledger.',
        {
          liveChecksum: '0x' + liveSum.toString(16),
          trustedChecksum: '0x' + trustSum.toString(16),
          divergedFields: diffs
        });
    }
    wasTampered = mismatch;
  }

  /* ==========================================================================
   * DETECTOR 5 -- STATISTICAL ANOMALY           (headlines: bot)
   * --------------------------------------------------------------------------
   * Runs on each sanctioned collection event (not per tick). It looks at two
   * human limits over a rolling window, and only flags SUSTAINED inhuman
   * behaviour (>= STAT_WINDOW samples) so a lucky fast pickup never trips it:
   *   - collection RATE: mean gap between collections below MIN_INTERVAL_MS
   *   - REACTION time:   spawn->collect time below MIN_REACTION_MS every time
   * A bot collecting many coins back-to-back violates both; a human does not.
   * ========================================================================*/
  function evaluateStatistics(now) {
    // (a) sustained collection rate
    if (intervals.length >= STAT_WINDOW) {
      var avg = mean(intervals);
      if (avg < MIN_INTERVAL_MS && (now - lastStatNow) >= STAT_THROTTLE_MS) {
        lastStatNow = now;
        report('STAT_ANOMALY', 'medium',
          'Coin-collection rate is faster than humanly possible.',
          {
            metric: 'collection_interval',
            meanIntervalMs: +avg.toFixed(1),
            humanThresholdMs: MIN_INTERVAL_MS,
            sampleSize: intervals.length
          });
        return; // one event is enough; don't also fire the reaction sub-check
      }
    }
    // (b) sustained inhuman reaction time
    if (reactions.length >= STAT_WINDOW) {
      var recent = reactions.slice(-STAT_WINDOW);
      var worst = Math.max.apply(null, recent); // the SLOWEST of the fast ones
      if (worst < MIN_REACTION_MS && (now - lastStatNow) >= STAT_THROTTLE_MS) {
        lastStatNow = now;
        report('STAT_ANOMALY', 'medium',
          'Reaction time between spawn and pickup is inhumanly short.',
          {
            metric: 'reaction_time',
            slowestRecentMs: +worst.toFixed(1),
            humanThresholdMs: MIN_REACTION_MS,
            sampleSize: recent.length
          });
      }
    }
  }

  /* --------------------------------------------------------------------------
   * PUBLIC: per-tick inspection (detectors 1-4)
   * ------------------------------------------------------------------------*/
  function inspect(state, dtMs) {
    var p = state.player;

    // --- movement detectors (1 & 3) share one displacement measurement ---
    if (lastPos !== null) {
      var dx = p.x - lastPos.x;
      var dy = p.y - lastPos.y;
      var dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > TELEPORT_STEP) {
        // A clear discontinuity -> teleport. (Speed is intentionally not also
        // fired, so each cheat produces exactly one movement headline.)
        checkTeleport(state, dist, lastPos, { x: p.x, y: p.y });
      } else {
        checkSpeed(state, dist, dtMs);
      }
    }
    lastPos = { x: p.x, y: p.y };

    // --- value detectors (2 & 4) ---
    checkScore(state);
    checkTamper(state);
  }

  /* --------------------------------------------------------------------------
   * PUBLIC: sanctioned coin-collection event (feeds detectors 4 & 5)
   * ------------------------------------------------------------------------*/
  function notifyCoinCollected(payload) {
    var now = payload && typeof payload.now === 'number' ? payload.now : 0;
    var reaction = payload && typeof payload.reaction === 'number' ? payload.reaction : 0;

    // Update the trusted ledger from this legitimate event.
    trustedCoins += 1;
    trustedScore += COIN_VALUE;

    // Record timing samples for the statistical detector.
    if (acLastNow !== null) {
      intervals.push(now - acLastNow);
      if (intervals.length > STAT_WINDOW) intervals.shift();
    }
    acLastNow = now;
    reactions.push(reaction);
    if (reactions.length > STAT_WINDOW) reactions.shift();

    evaluateStatistics(now);
  }

  /* --------------------------------------------------------------------------
   * PUBLIC: lifecycle / accessors
   * ------------------------------------------------------------------------*/
  function reset() {
    lastPos = null;
    trustedCoins = 0;
    trustedScore = 0;
    lastScore = 0;
    lastCoins = 0;
    wasConsistent = true;
    wasTampered = false;
    acLastNow = null;
    intervals = [];
    reactions = [];
    lastStatNow = -1e9;
    lastSpeedNow = -1e9;
    events = [];
  }

  // Clear only the visible log; keep the detector's trusted memory intact.
  function clear() { events = []; }

  function getEvents() { return events; }
  function onEvent(cb) { if (typeof cb === 'function') listeners.push(cb); }

  // Exposed for the test suite / curious inspection.
  function getTrusted() {
    return { coins: trustedCoins, score: trustedScore };
  }

  /* --------------------------------------------------------------------------
   * PUBLIC API
   * ------------------------------------------------------------------------*/
  root.AntiCheat = {
    inspect: inspect,
    notifyCoinCollected: notifyCoinCollected,
    reset: reset,
    clear: clear,
    getEvents: getEvents,
    onEvent: onEvent,
    getTrusted: getTrusted,
    // reference thresholds (read-only; handy for the UI/tests to display)
    constants: {
      REF_MAX_SPEED: REF_MAX_SPEED,
      MAX_STEP: REF_MAX_SPEED * REF_DT,
      TELEPORT_STEP: TELEPORT_STEP,
      SPEED_TOLERANCE: SPEED_TOLERANCE,
      MIN_INTERVAL_MS: MIN_INTERVAL_MS,
      MIN_REACTION_MS: MIN_REACTION_MS,
      STAT_WINDOW: STAT_WINDOW
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
