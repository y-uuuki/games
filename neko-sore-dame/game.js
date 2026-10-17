/*
 * ネコ、それダメ! — browser prototype
 * Classic script (no modules, no build). Needs vendor/matter.min.js loaded first.
 *
 * Sections
 *   1. CONFIG ............ every gameplay tuning number
 *   2. Utilities & RNG ... math helpers, seeded mulberry32, URL params
 *   3. Storage ........... localStorage wrapped in try/catch
 *   4. Audio ............. WebAudio-synthesised SFX, mute toggle
 *   5. View & input ...... canvas scaling/letterbox, pointer events
 *   6. Entities .......... items (Matter.js bodies), cats (state machine), fx
 *   7. Update ............ rules, scoring, spawning, escalation, treat
 *   8. Render ............ table, items, cats, fx, HUD
 *   9. Screens & UI ...... title / play / over / result, share, ad hook
 *  10. Main loop ......... fixed-timestep update, rAF render
 *  11. Test hooks ........ window.__game, ?test=1, ?shot=title|play|result
 */
(function () {
  'use strict';

  // ==========================================================================
  // 1. CONFIG
  // ==========================================================================
  var CONFIG = {
    view: { w: 720, h: 1280 },                 // logical resolution (portrait)
    table: { x: 50, y: 196, w: 620, h: 904 },  // table rect in logical px
    stepHz: 60,                                // fixed simulation rate
    maxStepsPerFrame: 5,

    physics: {
      substeps: 2,            // Matter updates per fixed step (less tunnelling)
      positionIterations: 8,
      velocityIterations: 6,
      itemFriction: 0.02
    },

    // Player "おはじき" flick. Speeds are px per 1/60 s (Matter units).
    flick: {
      grabPad: 64,            // touch radius beyond an item's edge
      minDrag: 14,            // shorter drags are ignored (taps)
      maxDrag: 230,           // drag length for full power
      minSpeed: 4,
      maxSpeed: 34,
      powerCurve: 1.25,       // >1 = finer control at low power
      arrowScale: 1.5,        // arrow is longer than the drag so it shows past the finger
      velSampleMs: 90,        // release-velocity window
      velBoostStart: 0.9,     // release speed (logical px/ms) where the boost starts
      velBoostPerUnit: 0.22,  // extra power per px/ms above the start
      velBoostMax: 0.3,
      spin: 0.12,
      showLanding: true       // faint marker where the item would stop
    },

    items: {
      cup:    { name: 'コップ',   shape: 'circle', r: 30, frictionAir: 0.050, restitution: 0.45, density: 0.0012, breakValue: 1, crashText: 'ガシャーン!', colors: ['#d9f0fa', '#86bdd6'] },
      plate:  { name: '皿',       shape: 'circle', r: 42, frictionAir: 0.055, restitution: 0.40, density: 0.0010, breakValue: 1, crashText: 'ガシャーン!', colors: ['#fdfcf8', '#d2914f'] },
      vase:   { name: '花びん',   shape: 'circle', r: 29, frictionAir: 0.055, restitution: 0.40, density: 0.0016, breakValue: 1, crashText: 'ガシャーン!', colors: ['#4c78c8', '#ff8fb1'] },
      cake:   { name: 'ケーキ',   shape: 'rect', w: 72, h: 64, chamfer: 16, frictionAir: 0.060, restitution: 0.30, density: 0.0010, breakValue: 1, crashText: 'ベチャッ!', colors: ['#fff3e3', '#e8434f'] },
      phone:  { name: 'スマホ',   shape: 'rect', w: 50, h: 92, chamfer: 11, frictionAir: 0.045, restitution: 0.45, density: 0.0014, breakValue: 1, crashText: 'バキッ!', colors: ['#2b2f3f', '#8fd0ff'] },
      orange: { name: 'みかん',   shape: 'circle', r: 24, frictionAir: 0.020, restitution: 0.60, density: 0.0010, breakValue: 1, crashText: 'ベシャッ!', colors: ['#ff9b21', '#5aa83a'] },
      ball:   { name: 'ボール',   shape: 'circle', r: 27, frictionAir: 0.013, restitution: 0.85, density: 0.0006, breakValue: 1, crashText: 'ボヨーン…', colors: ['#ff5a5f', '#3d9df2'] },
      tsubo:  { name: '高級つぼ', shape: 'circle', r: 37, frictionAir: 0.060, restitution: 0.35, density: 0.0024, breakValue: 2, crashText: 'ガシャーン!!', colors: ['#f7f5ef', '#2f5fa7'] }
    },

    itemSpawn: {
      initial: ['cup', 'plate', 'vase', 'cake', 'phone'],
      interval: 15,           // a family member places a new item every N s
      maxItems: 16,
      tsuboOnSpawn: 1,        // the 1st placed item (at 15 s) is always the 高級つぼ: the signature 'stare at the camera' target
      tsuboFromTime: 45,      // after this, つぼ can appear randomly
      roundFromTime: 90,      // みかん / ボール join the pool
      margin: 110,            // keep new items this far from the edges
      firstNearEdge: 2,       // the first N items start near an edge so the first cat has a target soon
      firstMargin: 70,        // ...at this margin + firstInset px from that edge
      firstInset: [10, 50],   // (smaller = the first "じーっ" stare comes sooner; ~8-9 s with no input)
      spacing: 26,            // extra gap between items when placing
      dropTime: 0.35
    },

    cat: {
      radius: 40,              // logic + draw radius (art is drawn at 34 and scaled)
      firstSpawnAt: 1.2,
      spawnCooldown: 2.6,
      gatherSpawnCooldown: 0.45,
      scaredReturnDelay: 4.0,
      enterJumpTime: 0.55,
      enterJumpHeight: 70,
      enterInset: 52,
      outsideDist: 120,
      sitTime: 0.45,
      stareOverhang: 0.30,     // cat stops pushing at this overhang and stares at the camera
      finalPushDist: 150,
      afterTime: 0.7,
      leaveChance: 0.45,
      leaveChanceAfterBreak: 0.7,
      maxTapsPerTarget: 30,
      maxPushTime: 18,         // a push that drags on this long (player keeps nudging it back) is abandoned
      scareSpeed: 5.5,         // flicked item speed needed to scare a cat
      playerTouchWindow: 2.5,  // seconds a flicked (or chain-hit) item counts as "yours"
      hitBounce: 0.6,          // a scared cat bounces the item back at this fraction of its speed
      startleHop: 0.4,         // flicking a cat's own target at it: the cat hops (s) and the item slides under
      startleHeight: 38,
      targetEdgeWeight: 1.0,
      targetDistWeight: 0.3,
      targetJitter: 70,
      takenPenalty: 420,
      pawTime: 0.18,
      smugTime: 3.0,
      idleTime: 0.8,           // idle (no items) before looking again
      huhTime: 0.5,            // '!?' pause after losing the target
      walkTimeout: 9,          // give up walking to a target after this many s
      followSpeedMin: 200,     // sitting/pushing cats keep up with their item at least this fast
      pushLeash: 80,           // item farther than this from the paw spot: stop pushing
      flickedGiveUp: 1.0,      // ...and if the player flicked it within this many s, give up on it
      firstTapDelay: 0.15,
      tapRetry: 0.12,          // item still sliding toward the stare line: wait this long
      stareStartDist: 3,       // start staring when the item is this close to the stare line...
      stareStartSpeed: 0.6,    // ...and nearly still
      stareBreakDist: 22,      // item moved this far back from the stare line: the stare is broken
      stareLeash: 60,          // cat this far from its spot: the stare is broken
      finalPushMinOverhang: 0.1,
      finalPushMaxDist: 24,
      lastTargetPenalty: 260,  // target score penalty for the item the cat just left
      tsuboBonus: 140,         // cats love the 高級つぼ: target score bonus (lower = preferred)
      foilWindow: 1.0,         // stare broken this soon after a player flick: the cat goes 'チッ…'
      heartbeatEvery: 0.5,     // 'ドクン' while a cat stares (s)
      popTime: 0.35,           // 忍者ネコ pop-up animation
      leaveSpeedMul: 1.2,
      leaveJump: { time: 0.45, height: 50 },
      scareJump: { speed: 750, minTime: 0.45, maxTime: 0.85, height: 110 }
    },

    // tapDist / tapInterval are [start, end] lerped over difficultyRampTime
    catTypes: {
      normal: { name: null,       scale: 1.00, walkSpeed: 160, tapDist: [18, 32], tapInterval: [0.9, 0.45], stareTime: 1.5 },
      kitten: { name: '子ネコ',   scale: 0.72, walkSpeed: 300, tapDist: [18, 18], tapInterval: [0.3, 0.3],  stareTime: 1.1, switchTaps: [2, 4] },
      fat:    { name: 'デブ猫',   scale: 1.30, walkSpeed: 95,  tapDist: [36, 36], tapInterval: [1.0, 1.0],  stareTime: 1.5, ignoresHits: true, landInset: 170, shoveRadius: 290, shoveDist: 95, shoveMin: 0.35, jumpTimeMul: 1.9, jumpHeightMul: 1.8 },
      ninja:  { name: '忍者ネコ', scale: 0.95, walkSpeed: 330, tapDist: [26, 26], tapInterval: [0.45, 0.45], stareTime: 1.3, popUp: true }
    },
    difficultyRampTime: 100,

    phases: [
      { t: 0,   cats: 1, special: 0 },
      { t: 30,  cats: 2, special: 0,    msg: 'ネコが2匹に!',        sub: '別々の物を同時に狙ってくる' },
      { t: 60,  cats: 3, special: 0,    msg: 'ネコが3匹に!',        sub: '全部は救えないかも…' },
      { t: 90,  cats: 3, special: 0.55, msg: 'あやしいネコが来た…!', sub: '子ネコ・デブ猫・忍者ネコ' },
      { t: 120, cats: 4, special: 0.6,  msg: 'ネコが4匹に!',        sub: 'もう限界…?' },
      { t: 180, cats: 5, special: 0.65, msg: 'ネコが5匹に!',        sub: 'ここからが本番' }
    ],
    gather: { firstAt: 95, every: 45, warn: 3.0, cats: 5, duration: 16 },
    treat: { duration: 10, bowlX: 520, bowlY: 1196, ringR: 80, jumpTime: 0.7, jumpHeight: 90, returnTime: 0.6, returnHeight: 100, returnInset: 70, returnSpread: 60, returnSpawnDelay: 0.6 },
    // safeOverhang: rescue counts when the item was at least this far over (it falls at 0.5);
    // セーフ! pops once the item is back on the table and predicted to stop on it (or slows below safeSettleSpeed /
    // safeTimeout passes); safeArmWindow: the rescue must happen within this many s of the flick
    score: { perItemPerSecond: 1, safe: 500, catHit: 300, safeOverhang: 0.25, safeSettleSpeed: 3, safeTimeout: 2.5, safeArmWindow: 5 },
    breaksToLose: 3,
    fallTime: 0.45,
    fallMinSpeed: 1.5,          // items always leave the table at least this fast
    fallMaxOut: 26,             // a falling item's centre stays within this many px past the edge (stays on a phone screen)
    overSlowMo: 0.3,
    overTime: 1.6,
    resultInputDelay: 0.7,
    fx: {
      shakeCrash: 0.7, shakeLand: 0.8, shakeHit: 0.25, shakeMax: 24, shakeDecay: 1.6,
      hitStop: 0.07, hitStopScale: 0.04,        // near-freeze right at a crash / デブ猫 landing (real s)
      fallSlowScale: 0.4, fallSlowTime: 0.55,    // slow-motion while an item tips over the edge
      fallSlowCooldown: 1.6,
      crashFlash: 0.32, landFlash: 0.22, safeFlash: 0.12, flashDecay: 1.6,
      stareDim: 0.42,                           // spotlight: darkness of the rest of the table while a cat stares
      stareDimCrowd: 0.5,                       // ...divided by (cats on the table ^ this): lighter in the late-game chaos
      stareSpot: 190                            // spotlight radius around the staring cat + its item
    },
    // first-run coaching (per run, until the player has done it once)
    tutorial: { hintUntil: 25, dangerUntil: 60, hintCycle: 2.0 },
    // result-screen 称号 by survival time (s); selfOwnRank overrides when 2+ breaks were the player's own fault
    ranks: [
      { t: 0,   name: 'ネコの下僕' },
      { t: 25,  name: '見習い見張り番' },
      { t: 50,  name: 'テーブルの番人' },
      { t: 90,  name: 'ネコ界の宿敵' },
      { t: 140, name: 'おはじき名人' },
      { t: 200, name: '伝説のテーブル守護神' }
    ],
    selfOwnRank: '自滅の達人'
  };

  var VW = CONFIG.view.w, VH = CONFIG.view.h;
  var T = CONFIG.table, TR = T.x + T.w, TB = T.y + T.h;
  var TCX = T.x + T.w / 2, TCY = T.y + T.h / 2;
  var STEP = 1 / CONFIG.stepHz;
  var TAU = Math.PI * 2;
  var FONT = '"Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", sans-serif';
  var M = window.Matter;
  var KEY_BEST = 'nekoSoreDame.best', KEY_BEST_TIME = 'nekoSoreDame.bestTime', KEY_MUTE = 'nekoSoreDame.muted';

  var UI = {
    mute: { x: 668, y: 60, r: 32 },
    treat: { x: 28, y: 1134, w: 296, h: 112 },
    retry: { x: 140, y: 916, w: 440, h: 112 },
    share: { x: 210, y: 1056, w: 300, h: 86 }
  };
  var CAT_ART_R = 34;   // cats are drawn at this radius and scaled to catR()

  var CAT_COLORS = {
    tora:  { body: '#f2a04e', stripe: '#d0772a', belly: '#ffe3c2', outline: '#9c5520', ear: '#f7b3a1', eye: '#c8e35a', name: '茶トラ', whisker: '#9c5520' },
    black: { body: '#2c2b34', stripe: '#3a3944', belly: '#3d3c48', outline: '#5f5a72', ear: '#7a5566', eye: '#ffd23f', name: '黒ネコ', whisker: '#8d88a0' },
    white: { body: '#fbf8f2', stripe: '#ece4d8', belly: '#ffffff', outline: '#bdb2a2', ear: '#f7b3a1', eye: '#6cc3f0', name: '白ネコ', whisker: '#bdb2a2' }
  };

  // ==========================================================================
  // 2. Utilities & RNG
  // ==========================================================================
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hypot(x, y) { return Math.sqrt(x * x + y * y); }
  function dist(ax, ay, bx, by) { return hypot(bx - ax, by - ay); }
  function easeOutBack(t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInCubic(t) { return t * t * t; }
  function angleLerp(a, b, t) { var d = ((b - a + Math.PI * 3) % TAU) - Math.PI; return a + d * t; }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function round(v, d) { var k = Math.pow(10, d); return Math.round(v * k) / k; }

  // mulberry32 — small, fast, deterministic
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    var r = function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.range = function (lo, hi) { return lo + (hi - lo) * r(); };
    r.int = function (lo, hi) { return lo + Math.floor(r() * (hi - lo + 1)); };
    r.pick = function (arr) { return arr[Math.floor(r() * arr.length)]; };
    return r;
  }

  var PARAMS = (function () {
    var o = {};
    try {
      var q = window.location.search.replace(/^\?/, '');
      if (q) q.split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
        var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
        o[k] = v;
      });
    } catch (e) { /* ignore */ }
    return o;
  })();
  function parseSeed(s) {
    if (/^\d+$/.test(s)) return (parseInt(s, 10) >>> 0) || 1;
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0) || 1;
  }
  function randomSeed() { return ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0) || 1; }
  var TEST_MODE = PARAMS.test === '1';
  var SHOT = PARAMS.shot || null;
  var FIXED_SEED = (PARAMS.seed !== undefined && PARAMS.seed !== '') ? parseSeed(PARAMS.seed) : null;
  function nextSeed() { return FIXED_SEED !== null ? FIXED_SEED : randomSeed(); }

  function reportError(e) {
    var msg = (e && (e.stack || e.message)) || String(e);
    if (window.__errors) window.__errors.push(msg);
    if (window.__onGameError) { try { window.__onGameError(); } catch (e2) { /* ignore */ } }
  }

  // ==========================================================================
  // 3. Storage (must keep working when localStorage throws)
  // ==========================================================================
  var Store = {
    get: function (k, def) {
      try { var v = window.localStorage.getItem(k); return v === null || v === undefined ? def : v; } catch (e) { return def; }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(k, String(v)); return true; } catch (e) { return false; }
    },
    remove: function (k) {
      try { window.localStorage.removeItem(k); return true; } catch (e) { return false; }
    }
  };

  // ==========================================================================
  // 4. Audio — all SFX synthesised with WebAudio (no files)
  // ==========================================================================
  var Sfx = (function () {
    var ac = null, master = null, noiseBuf = null;
    var muted = Store.get(KEY_MUTE, '0') === '1';
    var lastPlay = {};
    var VOL = 0.6;

    function unlock() {
      try {
        if (!ac) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          ac = new AC();
          master = ac.createGain();
          master.gain.value = muted ? 0 : VOL;
          master.connect(ac.destination);
          var len = Math.floor(ac.sampleRate * 1.0);
          noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
          var d = noiseBuf.getChannelData(0);
          for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        }
        // iOS reports 'interrupted' after calls / backgrounding; both need a resume inside a gesture
        if ((ac.state === 'suspended' || ac.state === 'interrupted') && ac.resume) { var p = ac.resume(); if (p && p.catch) p.catch(function () {}); }
      } catch (e) { /* audio is optional */ }
    }
    function env(g, t0, vol, attack, dur) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(dur, attack + 0.01));
    }
    function tone(f, f2, dur, type, vol, delay, attack) {
      var t0 = ac.currentTime + (delay || 0);
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t0);
      if (f2 && f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
      env(g, t0, vol, attack || 0.005, dur);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }
    function noise(dur, vol, ftype, freq, freq2, q, delay) {
      var t0 = ac.currentTime + (delay || 0);
      var src = ac.createBufferSource(); src.buffer = noiseBuf;
      var f = ac.createBiquadFilter(); f.type = ftype || 'bandpass';
      f.frequency.setValueAtTime(freq || 1000, t0);
      if (freq2) f.frequency.exponentialRampToValueAtTime(freq2, t0 + dur);
      f.Q.value = q || 1;
      var g = ac.createGain(); env(g, t0, vol, 0.004, dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0, Math.random() * 0.4); src.stop(t0 + dur + 0.05);
    }
    var defs = {
      ui: function () { tone(660, 880, 0.07, 'triangle', 0.18); },
      grab: function () { tone(420, 540, 0.05, 'sine', 0.12); },
      flick: function (p) { p = p || 0.5; noise(0.12 + p * 0.08, 0.12 + p * 0.25, 'bandpass', 700, 2600 + p * 1600, 1.2); tone(260, 520 + p * 300, 0.09, 'triangle', 0.08 + p * 0.08); },
      clack: function (imp) { var v = clamp(imp / 16, 0.06, 1); tone(900 + Math.random() * 700, 620, 0.05, 'triangle', 0.22 * v); noise(0.04, 0.12 * v, 'highpass', 2500, 0, 0.7); },
      pat: function () { tone(210, 130, 0.07, 'sine', 0.16); noise(0.04, 0.05, 'lowpass', 900, 0, 0.7); },
      push: function () { tone(170, 90, 0.14, 'sine', 0.3); noise(0.1, 0.12, 'lowpass', 700, 0, 0.7); },
      stare: function () { tone(1800, 2600, 0.12, 'sine', 0.12); tone(2700, 3600, 0.16, 'sine', 0.08, 0.07); tone(110, 104, 0.9, 'triangle', 0.1, 0, 0.08); },
      nya: function () {
        var t0 = ac.currentTime, p = 0.9 + Math.random() * 0.25;
        var o = ac.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(520 * p, t0);
        o.frequency.linearRampToValueAtTime(930 * p, t0 + 0.07);
        o.frequency.linearRampToValueAtTime(640 * p, t0 + 0.3);
        var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
        bp.frequency.setValueAtTime(800, t0);
        bp.frequency.linearRampToValueAtTime(1900, t0 + 0.08);
        bp.frequency.linearRampToValueAtTime(1000, t0 + 0.3);
        var g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.55, t0 + 0.03);
        g.gain.setValueAtTime(0.55, t0 + 0.18);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
        o.connect(bp); bp.connect(g); g.connect(master);
        o.start(t0); o.stop(t0 + 0.4);
      },
      crash: function () {
        noise(0.6, 0.5, 'highpass', 1800, 0, 0.6);
        noise(0.25, 0.4, 'bandpass', 3500, 1500, 1);
        tone(130, 45, 0.25, 'sine', 0.45);
        for (var i = 0; i < 7; i++) tone(2200 + Math.random() * 3200, 0, 0.08 + Math.random() * 0.12, 'triangle', 0.07, 0.02 + i * 0.035 + Math.random() * 0.03);
      },
      fall: function () { tone(900, 300, 0.32, 'sine', 0.1); },
      safe: function () { tone(784, 0, 0.09, 'triangle', 0.18); tone(1047, 0, 0.09, 'triangle', 0.18, 0.07); tone(1568, 0, 0.2, 'triangle', 0.2, 0.14); },
      pon: function () { tone(520, 980, 0.09, 'sine', 0.22); },
      land: function () { tone(110, 40, 0.3, 'sine', 0.5); noise(0.25, 0.25, 'lowpass', 500, 120, 0.7); },
      ninja: function () { noise(0.16, 0.2, 'bandpass', 3500, 900, 1.5); tone(1400, 2200, 0.06, 'square', 0.05, 0.1); },
      thud: function () { tone(140, 70, 0.18, 'sine', 0.35); },
      warn: function () { for (var i = 0; i < 3; i++) { tone(880, 0, 0.14, 'square', 0.08, i * 0.32); tone(660, 0, 0.14, 'square', 0.08, i * 0.32 + 0.16); } },
      phase: function () { tone(660, 0, 0.1, 'triangle', 0.14); tone(880, 0, 0.16, 'triangle', 0.14, 0.1); },
      treat: function () { [523, 659, 784, 1047, 1319].forEach(function (f, i) { tone(f, 0, 0.14, 'triangle', 0.16, i * 0.07); }); },
      munch: function () { noise(0.05, 0.07, 'bandpass', 1800, 0, 2); },
      over: function () { [523, 440, 349, 262].forEach(function (f, i) { tone(f, f * 0.98, 0.28, 'triangle', 0.2, i * 0.18); }); },
      best: function () { [784, 988, 1175, 1568].forEach(function (f, i) { tone(f, 0, 0.16, 'square', 0.07, 0.3 + i * 0.09); }); },
      miss: function () { tone(300, 260, 0.04, 'sine', 0.05); },
      heart: function () { tone(78, 48, 0.13, 'sine', 0.55); tone(156, 96, 0.1, 'triangle', 0.12); tone(70, 44, 0.12, 'sine', 0.4, 0.17); tone(140, 88, 0.09, 'triangle', 0.09, 0.17); },     // ドクン… (+ harmonic for phone speakers)
      hop: function () { tone(380, 760, 0.1, 'sine', 0.1); },
      whistle: function () { tone(1500, 380, 1.0, 'sine', 0.07, 0, 0.05); }                                 // ヒュ〜… (デブ猫)
    };
    var minGap = { clack: 0.035, pat: 0.03, munch: 0.08, heart: 0.3, hop: 0.1 };
    function play(name, arg) {
      if (!ac || muted || !defs[name]) return;
      try {
        var now = ac.currentTime;
        if (minGap[name] && lastPlay[name] !== undefined && now - lastPlay[name] < minGap[name]) return;
        lastPlay[name] = now;
        defs[name](arg);
      } catch (e) { /* never let audio break the game */ }
    }
    function setMuted(m) {
      muted = !!m;
      Store.set(KEY_MUTE, muted ? '1' : '0');
      try { if (master) master.gain.setValueAtTime(muted ? 0 : VOL, ac.currentTime); } catch (e) { /* ignore */ }
    }
    return {
      unlock: unlock,
      play: play,
      setMuted: setMuted,
      toggle: function () { setMuted(!muted); return muted; },
      isMuted: function () { return muted; },
      ready: function () { return !!ac; }
    };
  })();

  // ==========================================================================
  // 5. View & input
  // ==========================================================================
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var view = { w: 390, h: 844, dpr: 1, s: 1, ox: 0, oy: 0, x0: 0, y0: 0, x1: 720, y1: 1280 };  // x0..y1 = visible logical rect

  // inside a #stage wrapper (a page that keeps clear of phone safe areas) fit the wrapper, otherwise the window
  function stageEl() { var p = canvas.parentElement; return p && p.id === 'stage' ? p : null; }
  function resize() {
    var st = stageEl();
    var w = Math.max(1, st ? st.clientWidth : (window.innerWidth || document.documentElement.clientWidth || 390));
    var h = Math.max(1, st ? st.clientHeight : (window.innerHeight || document.documentElement.clientHeight || 844));
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    view.w = w; view.h = h; view.dpr = dpr;
    view.s = Math.min(w / VW, h / VH);
    view.ox = (w - VW * view.s) / 2;
    view.oy = (h - VH * view.s) / 2;
    view.x0 = -view.ox / view.s; view.y0 = -view.oy / view.s;
    view.x1 = (w - view.ox) / view.s; view.y1 = (h - view.oy) / view.s;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
  function toLogical(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.ox) / view.s, y: (e.clientY - r.top - view.oy) / view.s };
  }
  function evTime(e) { return (e && e.timeStamp) ? e.timeStamp : performance.now(); }

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    // A new primary touch means every earlier touch has ended: drop any drag whose
    // pointerup/cancel never arrived, so its item can be grabbed again.
    if (e.isPrimary) clearDrags(function (d) { return d.ptype === e.pointerType && d.id !== e.pointerId; });
    var p = toLogical(e);
    onDown(p.x, p.y, e.pointerId, evTime(e), e.pointerType);
  }, { passive: false });
  canvas.addEventListener('pointermove', function (e) {
    if (!G.drags[e.pointerId]) return;
    e.preventDefault();
    var p = toLogical(e);
    onMove(p.x, p.y, e.pointerId, evTime(e));
  }, { passive: false });
  canvas.addEventListener('pointerup', function (e) {
    e.preventDefault();
    var p = toLogical(e);
    onUp(p.x, p.y, e.pointerId, evTime(e));
  }, { passive: false });
  canvas.addEventListener('pointercancel', function (e) { onCancel(e.pointerId); });
  canvas.addEventListener('lostpointercapture', function (e) { if (G.drags[e.pointerId] || G.pressedId === e.pointerId) onCancel(e.pointerId); });

  // No scrolling, zooming, selecting or context menus while playing.
  document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('touchstart', function (e) { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('selectstart', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });
  window.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  // Losing focus mid-drag (app switch, alt-tab) can swallow the pointerup: forget held items.
  window.addEventListener('blur', function () { clearDrags(); G.pressed = null; });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { clearDrags(); G.pressed = null; } });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'm' || e.key === 'M') { Sfx.unlock(); Sfx.toggle(); }
    if ((e.key === ' ' || e.key === 'Enter') && (G.screen === 'title' || (G.screen === 'result' && G.resultT > CONFIG.resultInputDelay))) {
      Sfx.unlock(); startRun(nextSeed());
    }
  });

  function hitCircle(c, x, y, pad) { return dist(c.x, c.y, x, y) <= c.r + (pad || 0); }
  function hitRect(r, x, y, pad) { pad = pad || 0; return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad; }

  function onDown(x, y, id, t, ptype) {
    Sfx.unlock();
    if (hitCircle(UI.mute, x, y, 12)) { Sfx.toggle(); Sfx.play('ui'); return; }
    if (G.screen === 'title') {
      if (G.titleT > 0.25) { Sfx.play('ui'); startRun(nextSeed()); }
      return;
    }
    if (G.screen === 'result') {
      if (G.resultT < CONFIG.resultInputDelay) return;
      if (hitRect(UI.retry, x, y, 8)) { G.pressed = 'retry'; G.pressedId = id; }
      else if (hitRect(UI.share, x, y, 8)) { G.pressed = 'share'; G.pressedId = id; }
      return;
    }
    if (G.screen !== 'play') return;
    var it = pickItem(x, y);
    // The おやつ button sits just below the table: an item hanging over the bottom edge can
    // overlap it. Touching the item itself grabs the item; after the treat is used the
    // (inert) button never steals a grab.
    if (hitRect(UI.treat, x, y, 6)) {
      var onItem = it && distToItem(it, x, y) <= 6;
      if (!onItem && (!G.treat.used || !it)) { useTreat(); return; }
    }
    if (!it) { fxRipple(x, y); Sfx.play('miss'); return; }
    G.drags[id] = { id: id, item: it, ptype: ptype || 'test', sx: x, sy: y, x: x, y: y, samples: [{ x: x, y: y, t: t }] };
    Sfx.play('grab');
  }
  function onMove(x, y, id, t) {
    var d = G.drags[id];
    if (!d) return;
    d.x = x; d.y = y;
    d.samples.push({ x: x, y: y, t: t });
    while (d.samples.length > 2 && t - d.samples[0].t > 250) d.samples.shift();
  }
  function onUp(x, y, id, t) {
    Sfx.unlock();
    if (G.screen === 'result') {
      var pr = G.pressed; G.pressed = null;
      if (pr === 'retry' && hitRect(UI.retry, x, y, 8)) { Sfx.play('ui'); startRun(nextSeed()); }
      else if (pr === 'share' && hitRect(UI.share, x, y, 8)) { Sfx.play('ui'); shareResult(); }
      return;
    }
    var d = G.drags[id];
    if (!d) return;
    onMove(x, y, id, t);
    delete G.drags[id];
    if (G.screen !== 'play' || d.item.state !== 'table') return;
    var dx = d.x - d.sx, dy = d.y - d.sy;
    if (hypot(dx, dy) < CONFIG.flick.minDrag) return;
    flickItem(d.item, dx, dy, releaseBoost(d.samples, t));
  }
  function onCancel(id) {
    delete G.drags[id];
    if (G.pressed && G.pressedId === id) G.pressed = null;
  }
  function clearDrags(filter) {
    for (var k in G.drags) if (!filter || filter(G.drags[k])) delete G.drags[k];
  }

  // Quick swipes get a little extra power on top of the drag length.
  function releaseBoost(samples, tEnd) {
    var F = CONFIG.flick;
    if (!samples || samples.length < 2) return 0;
    var last = samples[samples.length - 1], first = last;
    for (var i = samples.length - 1; i >= 0; i--) {
      first = samples[i];
      if (tEnd - samples[i].t >= F.velSampleMs) break;
    }
    var dt = Math.max(16, last.t - first.t);
    var v = dist(first.x, first.y, last.x, last.y) / dt;
    return clamp((v - F.velBoostStart) * F.velBoostPerUnit, 0, F.velBoostMax);
  }

  // ==========================================================================
  // 6. Entities — game state, items, cats, fx
  // ==========================================================================
  var G = {
    screen: 'title', frozen: false, seed: 1, rng: makeRng(1), fx: makeRng(2),
    engine: null, items: [], cats: [], particles: [], popups: [], banner: null, toast: null,
    drags: {}, pressed: null, pressedId: null, time: 0, realTime: 0, frame: 0, titleT: 0, overT: 0, resultT: 0,
    score: 0, breaks: 0, broken: [], scoreAcc: 0, scorePop: 0, breakPop: 0,
    best: parseInt(Store.get(KEY_BEST, '0'), 10) || 0,
    bestTime: parseFloat(Store.get(KEY_BEST_TIME, '0')) || 0,
    shake: 0, nextId: 1, phaseIdx: 0,
    spawn: { catT: 0, itemT: 0, itemCount: 0 },
    gather: { next: 0, warned: false, until: -1 },
    treat: { used: false, active: false, t: 0, slots: 0, fade: 0 },
    stats: { flicks: 0, safes: 0, catHits: 0, specials: 0 },
    result: null, debugNoSpawn: false, decor: null,
    slow: { t: 0, dur: 1, scale: 1, cd: 0 }, hitStop: 0, flash: 0, flashCol: '#ffffff'
  };

  // ---- shared geometry helpers --------------------------------------------
  function nearestEdge(x, y) {
    var dl = x - T.x, dr = TR - x, dt = y - T.y, db = TB - y;
    var m = Math.min(dl, dr, dt, db);
    if (m === dl) return { nx: -1, ny: 0, d: dl };
    if (m === dr) return { nx: 1, ny: 0, d: dr };
    if (m === dt) return { nx: 0, ny: -1, d: dt };
    return { nx: 0, ny: 1, d: db };
  }
  function slideSpeed(D, f) { return D * f / (1 - f / CONFIG.physics.substeps); }  // speed that slides D px
  function slideDist(v, f) { return v * (1 - f / CONFIG.physics.substeps) / f; }   // inverse
  function flickSpeed(power) { var F = CONFIG.flick; return lerp(F.minSpeed, F.maxSpeed, Math.pow(clamp(power, 0, 1), F.powerCurve)); }
  function onTable(it) { return it.state === 'table'; }
  function countOnTable() { var n = 0; for (var i = 0; i < G.items.length; i++) if (G.items[i].state === 'table') n++; return n; }
  function findItem(id) { for (var i = 0; i < G.items.length; i++) if (G.items[i].id === id) return G.items[i]; return null; }
  function findCat(id) { for (var i = 0; i < G.cats.length; i++) if (G.cats[i].id === id) return G.cats[i]; return null; }

  // ---- items ----------------------------------------------------------------
  function typeRadius(type) { var d = CONFIG.items[type]; return d.shape === 'circle' ? d.r : (d.w + d.h) / 4; }
  function itemRadius(it) { return typeRadius(it.type); }
  function itemHalf(it) {
    if (!it.body) { var d = it.def; return d.shape === 'circle' ? { hw: d.r, hh: d.r } : { hw: d.w / 2, hh: d.h / 2 }; }
    var b = it.body.bounds;
    return { hw: (b.max.x - b.min.x) / 2, hh: (b.max.y - b.min.y) / 2 };
  }
  function createItem(type, x, y, angle) {
    var d = CONFIG.items[type];
    var opts = {
      frictionAir: d.frictionAir, restitution: d.restitution, density: d.density,
      friction: CONFIG.physics.itemFriction, frictionStatic: 0.05, angle: angle || 0, label: 'item:' + type
    };
    var body;
    if (d.shape === 'circle') body = M.Bodies.circle(x, y, d.r, opts);
    else { opts.chamfer = { radius: d.chamfer }; body = M.Bodies.rectangle(x, y, d.w, d.h, opts); }
    var it = {
      id: G.nextId++, type: type, def: d, body: body, x: x, y: y, angle: angle || 0,
      state: 'table', overhang: 0, edgeNx: 0, edgeNy: 0, spawnT: 0,
      lastToucher: null, playerTouchT: -99, rescueArmed: false, rescueT: 0, catDanger: false,
      fallT: 0, vx: 0, vy: 0, fallNx: 0, fallNy: 0, hitCatId: 0, hitT: -99, landed: false
    };
    body.plugin = body.plugin || {};
    body.plugin.item = it;
    M.Composite.add(G.engine.world, body);
    G.items.push(it);
    computeOverhang(it);
    return it;
  }
  // overhang = fraction of the item's width hanging past the nearest table edge (0.5 = centre on the edge)
  function computeOverhang(it) {
    var b = it.body.bounds, w = b.max.x - b.min.x, h = b.max.y - b.min.y;
    var o = 0, nx = 0, ny = 0, v;
    v = (T.x - b.min.x) / w; if (v > o) { o = v; nx = -1; ny = 0; }
    v = (b.max.x - TR) / w; if (v > o) { o = v; nx = 1; ny = 0; }
    v = (T.y - b.min.y) / h; if (v > o) { o = v; nx = 0; ny = -1; }
    v = (b.max.y - TB) / h; if (v > o) { o = v; nx = 0; ny = 1; }
    it.overhang = o; it.edgeNx = nx; it.edgeNy = ny;
  }
  // distance the item's leading edge still has to travel (along dir) before the cat stops to stare
  function distToStareLine(it, dir) {
    var b = it.body.bounds, w = b.max.x - b.min.x, h = b.max.y - b.min.y, s = CONFIG.cat.stareOverhang;
    if (dir.x < 0) return b.min.x - (T.x - s * w);
    if (dir.x > 0) return (TR + s * w) - b.max.x;
    if (dir.y < 0) return b.min.y - (T.y - s * h);
    return (TB + s * h) - b.max.y;
  }
  // distance from a point to the item's shape (0 inside)
  function distToItem(it, x, y) {
    var d = it.def;
    if (d.shape === 'circle') return Math.max(0, dist(x, y, it.x, it.y) - d.r);
    var c = Math.cos(-it.angle), s = Math.sin(-it.angle), lx = x - it.x, ly = y - it.y;
    var rx = lx * c - ly * s, ry = lx * s + ly * c;
    var ex = Math.max(Math.abs(rx) - d.w / 2, 0), ey = Math.max(Math.abs(ry) - d.h / 2, 0);
    return hypot(ex, ey);
  }
  function isHeld(it) { for (var k in G.drags) if (G.drags[k].item === it) return true; return false; }
  function pickItem(x, y) {
    var best = null, bestD = CONFIG.flick.grabPad;
    for (var i = 0; i < G.items.length; i++) {
      var it = G.items[i];
      if (!onTable(it) || isHeld(it)) continue;
      var d = distToItem(it, x, y);
      if (d < bestD || (d === 0 && best && dist(x, y, it.x, it.y) < dist(x, y, best.x, best.y))) { best = it; bestD = d; }
    }
    return best;
  }
  function flickItem(it, dx, dy, boost) {
    var len = hypot(dx, dy);
    if (len < CONFIG.flick.minDrag || !onTable(it)) return false;
    var power = clamp(Math.min(len / CONFIG.flick.maxDrag, 1) + (boost || 0), 0, 1);
    var spd = flickSpeed(power), nx = dx / len, ny = dy / len;
    M.Body.setVelocity(it.body, { x: nx * spd, y: ny * spd });
    M.Body.setAngularVelocity(it.body, (G.rng() - 0.5) * CONFIG.flick.spin * (0.5 + power));
    it.lastToucher = { kind: 'player', name: 'あなた' };
    it.playerTouchT = G.time;
    // セーフ! only for an item a cat (or a cat's chain/shove) put in danger; pushing your own
    // item to the edge and flicking it back must not farm +500.
    if (it.overhang >= CONFIG.score.safeOverhang && it.catDanger) { it.rescueArmed = true; it.rescueT = G.time; }
    G.stats.flicks++;
    Sfx.play('flick', power);
    for (var i = 0; i < 6; i++) {
      var a = Math.atan2(-ny, -nx) + G.fx.range(-0.8, 0.8), sp = G.fx.range(1, 3.5);
      spawnParticle({ kind: 'dust', x: it.x - nx * itemRadius(it), y: it.y - ny * itemRadius(it), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 0.88, life: 0.4, size: G.fx.range(5, 9), color: 'rgba(255,255,255,0.7)' });
    }
    return true;
  }

  // ---- cats -----------------------------------------------------------------
  function catR(c) { return CONFIG.cat.radius * c.def.scale; }
  function catName(c) { return c.def.name || CAT_COLORS[c.color].name; }
  function catSnapshot(c) { return { kind: 'cat', catId: c.id, color: c.color, ctype: c.type, name: catName(c) }; }
  function makeCat(type, color) {
    var def = CONFIG.catTypes[type];
    return {
      id: G.nextId++, type: type, def: def, color: color, x: 0, y: 0, z: 0, face: Math.PI / 2,
      state: 'idle', st: 0, anim: G.fx() * 10, target: null, pushDir: null, taps: 0, tapT: 0, pawT: 0,
      stare: 0, smugT: 0, lookX: 0, lookY: 1, jump: null, dead: false, leaving: false, popT: 0,
      switchAt: def.switchTaps ? G.rng.int(def.switchTaps[0], def.switchTaps[1]) : 0, switches: 0,
      lastTarget: null, mood: 'normal', moodT: 0, moving: false, broke: false, leaveEdge: null, munchT: 0, hopT: 0, beatT: 0
    };
  }
  function setState(c, s) { c.state = s; c.st = 0; }
  function isHittable(c) {
    return !c.dead && c.z < 8 && (c.state === 'walk' || c.state === 'sit' || c.state === 'push' || c.state === 'stare' ||
      c.state === 'after' || c.state === 'huh' || c.state === 'idle' || c.state === 'choose' || c.state === 'leave' || c.state === 'pose');
  }
  function randomEdgePoint(inset) {
    var per = 2 * (T.w + T.h), r = G.rng() * per, m = 70, e;
    if (r < T.w) e = { nx: 0, ny: -1, ex: lerp(T.x + m, TR - m, r / T.w), ey: T.y };
    else if (r < T.w * 2) e = { nx: 0, ny: 1, ex: lerp(T.x + m, TR - m, (r - T.w) / T.w), ey: TB };
    else if (r < T.w * 2 + T.h) e = { nx: -1, ny: 0, ex: T.x, ey: lerp(T.y + m, TB - m, (r - 2 * T.w) / T.h) };
    else e = { nx: 1, ny: 0, ex: TR, ey: lerp(T.y + m, TB - m, (r - 2 * T.w - T.h) / T.h) };
    var od = CONFIG.cat.outsideDist;
    e.ox = e.ex + e.nx * od; e.oy = e.ey + e.ny * od;
    e.lx = e.ex - e.nx * inset; e.ly = e.ey - e.ny * inset;
    return e;
  }
  function spawnCat(type, opts) {
    opts = opts || {};
    var color = opts.color || (type === 'ninja' ? 'black' : G.rng.pick(['tora', 'black', 'white']));
    var c = makeCat(type, color);
    G.cats.push(c);
    if (type !== 'normal') G.stats.specials++;
    if (opts.state) {                       // placed directly (tests / screenshots)
      c.x = opts.x; c.y = opts.y; setState(c, opts.state);
      if (opts.target) { c.target = opts.target; var ap = approachPoint(c, c.target, false); c.x = ap.x; c.y = ap.y; lookAt(c, c.target.x, c.target.y, 1); }
      return c;
    }
    if (c.def.popUp && ninjaPop(c)) return c;
    var e;
    if (opts.landX !== undefined) {
      var ne = nearestEdge(opts.landX, opts.landY);
      e = { ox: opts.landX + ne.nx * (ne.d + CONFIG.cat.outsideDist), oy: opts.landY + ne.ny * (ne.d + CONFIG.cat.outsideDist), lx: opts.landX, ly: opts.landY };
    } else e = randomEdgePoint(c.def.landInset || CONFIG.cat.enterInset);
    c.x = e.ox; c.y = e.oy;
    startJump(c, e.lx, e.ly, CONFIG.cat.enterJumpTime * (c.def.jumpTimeMul || 1), CONFIG.cat.enterJumpHeight * (c.def.jumpHeightMul || 1), 'landed');
    Sfx.play(type === 'fat' ? 'whistle' : 'hop');
    return c;
  }
  // 忍者ネコ: pops up right at the table edge beside an item that is already near the edge
  function ninjaPop(c) {
    var it = pickTarget(c);
    if (!it) return false;
    var e = nearestEdge(it.x, it.y), R = catR(c);
    var along = (G.rng() < 0.5 ? -1 : 1) * (itemRadius(it) + R + 6);
    var px, py;
    if (e.nx !== 0) { px = e.nx < 0 ? T.x + R * 0.7 : TR - R * 0.7; py = clamp(it.y + along, T.y + 40, TB - 40); }
    else { py = e.ny < 0 ? T.y + R * 0.7 : TB - R * 0.7; px = clamp(it.x + along, T.x + 40, TR - 40); }
    c.x = px; c.y = py; c.target = it; c.popT = CONFIG.cat.popTime;
    setState(c, 'walk');
    for (var i = 0; i < 12; i++) {
      var a = G.fx.range(0, TAU), sp = G.fx.range(1, 4);
      spawnParticle({ kind: 'smoke', x: px, y: py, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 0.86, life: 0.6, size: G.fx.range(10, 18), color: 'rgba(210,205,225,0.8)' });
    }
    popup('シュタッ!', px, py - 60, { size: 34, color: '#ffffff', stroke: '#3a3550' });
    Sfx.play('ninja');
    return true;
  }
  function startJump(c, tx, ty, dur, h, onLand) {
    c.jump = { fx: c.x, fy: c.y, tx: tx, ty: ty, t: 0, dur: dur, h: h, onLand: onLand };
    c.hopT = 0;
    c.face = Math.atan2(ty - c.y, tx - c.x);
    setState(c, 'jump');
  }
  function updateJump(c, dt) {
    var j = c.jump;
    j.t += dt;
    var p = clamp(j.t / j.dur, 0, 1);
    c.x = lerp(j.fx, j.tx, p); c.y = lerp(j.fy, j.ty, p);
    c.z = Math.sin(Math.PI * p) * j.h;
    if (p >= 1) { c.z = 0; c.jump = null; onCatLand(c, j.onLand); }
  }
  function onCatLand(c, kind) {
    if (kind === 'gone') { c.dead = true; return; }
    if (kind === 'eat') { setState(c, 'eat'); c.mood = 'happy'; c.face = Math.atan2(CONFIG.treat.bowlY - c.y, CONFIG.treat.bowlX - c.x); return; }
    for (var i = 0; i < 8; i++) {
      var a = i / 8 * TAU, sp = G.fx.range(1.5, 3);
      spawnParticle({ kind: 'dust', x: c.x, y: c.y + 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6, drag: 0.85, life: 0.45, size: G.fx.range(6, 10), color: 'rgba(255,248,235,0.75)' });
    }
    if (c.type === 'fat') fatShove(c); else Sfx.play('pat');
    setState(c, 'choose');
  }
  // デブ猫's landing shoves everything nearby outward
  function fatShove(c) {
    var R = c.def.shoveRadius, maxD = c.def.shoveDist;
    for (var i = 0; i < G.items.length; i++) {
      var it = G.items[i];
      if (!onTable(it)) continue;
      var dx = it.x - c.x, dy = it.y - c.y, d = hypot(dx, dy);
      if (d > R) continue;
      if (d < 1) { dx = 1; dy = 0; d = 1; }
      var k = 1 - d / R, D = maxD * (c.def.shoveMin + (1 - c.def.shoveMin) * k), v = slideSpeed(D, it.def.frictionAir);
      var cur = M.Body.getVelocity(it.body);
      M.Body.setVelocity(it.body, { x: cur.x + dx / d * v, y: cur.y + dy / d * v });
      it.lastToucher = catSnapshot(c);
    }
    addShake(CONFIG.fx.shakeLand);
    addFlash(CONFIG.fx.landFlash, '#fff3dc');
    hitStop(CONFIG.fx.hitStop);
    Sfx.play('land');
    popup('ドスン!', c.x, c.y - 90, { size: 64, color: '#ffffff', stroke: '#7a4a2a', pop: 1.4, life: 1.1 });
    for (var j = 0; j < 18; j++) {
      var a = j / 18 * TAU;
      spawnParticle({ kind: 'dust', x: c.x + Math.cos(a) * 30, y: c.y + Math.sin(a) * 30, vx: Math.cos(a) * 6, vy: Math.sin(a) * 6, drag: 0.86, life: 0.55, size: 12, color: 'rgba(255,248,235,0.8)' });
    }
  }
  function lookAt(c, x, y, k) {
    var dx = x - c.x, dy = y - c.y, d = hypot(dx, dy);
    if (d < 0.001) return;
    c.lookX = lerp(c.lookX, dx / d, k); c.lookY = lerp(c.lookY, dy / d, k);
    c.face = angleLerp(c.face, Math.atan2(dy, dx), k);
  }
  function moveToward(c, x, y, maxStep) {
    var dx = x - c.x, dy = y - c.y, d = hypot(dx, dy);
    if (d <= maxStep) { c.x = x; c.y = y; return true; }
    c.x += dx / d * maxStep; c.y += dy / d * maxStep;
    c.moving = true;
    c.face = angleLerp(c.face, Math.atan2(dy, dx), 0.25);
    return false;
  }
  // where the cat sits: on the far side of the item from its nearest edge
  function approachPoint(c, it, keepDir) {
    if (!keepDir || !c.pushDir) { var e = nearestEdge(it.x, it.y); c.pushDir = { x: e.nx, y: e.ny }; }
    var he = itemHalf(it), ext = c.pushDir.x !== 0 ? he.hw : he.hh;
    var gap = ext + catR(c) * 1.05;
    return { x: clamp(it.x - c.pushDir.x * gap, T.x + 16, TR - 16), y: clamp(it.y - c.pushDir.y * gap, T.y + 16, TB - 16) };
  }
  function pickTarget(c) {
    var best = null, bestS = Infinity, C = CONFIG.cat;
    for (var i = 0; i < G.items.length; i++) {
      var it = G.items[i];
      if (!onTable(it)) continue;
      var taken = false;
      for (var j = 0; j < G.cats.length; j++) {
        var o = G.cats[j];
        if (o !== c && !o.dead && !o.leaving && o.target === it) { taken = true; break; }
      }
      var s = nearestEdge(it.x, it.y).d * C.targetEdgeWeight + dist(c.x, c.y, it.x, it.y) * C.targetDistWeight +
        G.rng() * C.targetJitter + (taken ? C.takenPenalty : 0) + (it === c.lastTarget ? C.lastTargetPenalty : 0) -
        (it.def.breakValue > 1 ? C.tsuboBonus : 0);
      if (s < bestS) { bestS = s; best = it; }
    }
    return best;
  }
  function chooseTarget(c) {
    var it = pickTarget(c);
    c.taps = 0; c.pushDir = null;
    if (!it) { c.target = null; setState(c, 'idle'); return; }
    c.target = it;
    setState(c, 'walk');
  }
  function diffParams(c) {
    var k = clamp(G.time / CONFIG.difficultyRampTime, 0, 1);
    return { tapDist: lerp(c.def.tapDist[0], c.def.tapDist[1], k), tapInterval: lerp(c.def.tapInterval[0], c.def.tapInterval[1], k) };
  }
  function pawPos(c) {
    var R = catR(c);
    return { x: c.x + Math.cos(c.face) * R * 1.2, y: c.y + Math.sin(c.face) * R * 1.2 };
  }
  // "ちょい…ちょい…" one small tap toward the edge
  function catTap(c, it) {
    var D = distToStareLine(it, c.pushDir);
    var v = M.Body.getVelocity(it.body);
    var along = v.x * c.pushDir.x + v.y * c.pushDir.y;
    var remaining = along > 0 ? slideDist(along, it.def.frictionAir) : 0;
    var Deff = D - remaining;
    if (D <= CONFIG.cat.stareStartDist && M.Body.getSpeed(it.body) < CONFIG.cat.stareStartSpeed) { startStare(c, it); return; }
    if (Deff <= CONFIG.cat.stareStartDist) { c.tapT = CONFIG.cat.tapRetry; return; }
    var p = diffParams(c), step = Math.min(p.tapDist, Deff), dv = slideSpeed(step, it.def.frictionAir);
    M.Body.setVelocity(it.body, { x: v.x + c.pushDir.x * dv, y: v.y + c.pushDir.y * dv });
    c.pawT = CONFIG.cat.pawTime; c.taps++; c.tapT = p.tapInterval;
    it.lastToucher = catSnapshot(c);
    Sfx.play('pat');
    if (c.taps % 2 === 1) { var pp = pawPos(c); popup('ちょい', pp.x, pp.y - 26, { size: 26, color: '#6b4a2e', stroke: '#fff5e0', life: 0.6, rise: 22 }); }
    if (c.def.switchTaps && c.taps >= c.switchAt) {
      c.switches++; c.lastTarget = it; c.target = null;
      c.switchAt = G.rng.int(c.def.switchTaps[0], c.def.switchTaps[1]);
      setState(c, 'choose');
    } else if (c.taps > CONFIG.cat.maxTapsPerTarget) {
      c.lastTarget = it; c.target = null; setState(c, 'choose');
    }
  }
  function startStare(c, it) {
    setState(c, 'stare');
    c.beatT = 0.25;
    Sfx.play('stare');
    var R = catR(c);
    spawnParticle({ kind: 'star', x: c.x - R * 0.35, y: c.y - R * 0.7, vx: 0, vy: -0.3, drag: 0.9, life: 0.5, size: 10, color: '#fff7c2' });
    spawnParticle({ kind: 'star', x: c.x + R * 0.35, y: c.y - R * 0.7, vx: 0, vy: -0.3, drag: 0.9, life: 0.5, size: 10, color: '#fff7c2' });
  }
  function finalPush(c, it) {
    var D = distToStareLine(it, c.pushDir);
    if (it.overhang < CONFIG.cat.finalPushMinOverhang || D > CONFIG.cat.finalPushMaxDist) { huh(c); return; }
    var v = slideSpeed(CONFIG.cat.finalPushDist, it.def.frictionAir);
    M.Body.setVelocity(it.body, { x: c.pushDir.x * v, y: c.pushDir.y * v });
    it.lastToucher = catSnapshot(c);
    c.pawT = CONFIG.cat.pawTime * 1.4;
    Sfx.play('push');
    var pp = pawPos(c);
    popup('えいっ', pp.x, pp.y - 30, { size: 40, color: '#ffffff', stroke: '#c0392b', life: 0.8, pop: 1.3 });
    addShake(0.12);
    setState(c, 'after');
  }
  function huh(c) {
    popup('!?', c.x, c.y - catR(c) * 1.9, { size: 30, color: '#ffffff', stroke: '#3a3550', life: 0.6, rise: 16 });
    c.lastTarget = c.target; c.target = null;
    setState(c, 'huh');
  }
  // the player snatched the item away mid-stare
  function foiled(c) {
    popup('チッ…', c.x, c.y - catR(c) * 2.0, { size: 36, color: '#ffffff', stroke: '#5a4a6a', life: 0.9, rise: 18, pop: 1.2 });
    c.mood = 'annoyed'; c.moodT = 0.9;
    c.lastTarget = c.target; c.target = null;
    setState(c, 'huh');
  }
  function startLeave(c) {
    c.leaving = true; c.target = null;
    var e = nearestEdge(c.x, c.y), od = CONFIG.cat.outsideDist;
    var ex = e.nx !== 0 ? (e.nx < 0 ? T.x + 6 : TR - 6) : c.x;
    var ey = e.ny !== 0 ? (e.ny < 0 ? T.y + 6 : TB - 6) : c.y;
    c.leaveEdge = { x: ex, y: ey, ox: ex + e.nx * od, oy: ey + e.ny * od };
    G.spawn.catT = Math.max(G.spawn.catT, CONFIG.cat.spawnCooldown);
    if (c.smugT > 0) c.smugT = Math.max(c.smugT, 2.5);   // walks off looking pleased with itself
    setState(c, 'leave');
  }
  function scareCat(c, nx, ny) {
    c.mood = 'scared'; c.moodT = 3; c.leaving = true; c.target = null;
    var ex, ey;
    if (Math.abs(nx) > Math.abs(ny)) {
      ex = nx > 0 ? TR : T.x;
      ey = clamp(c.y + ny / Math.max(0.2, Math.abs(nx)) * Math.abs(ex - c.x), T.y + 40, TB - 40);
    } else {
      ey = ny > 0 ? TB : T.y;
      ex = clamp(c.x + nx / Math.max(0.2, Math.abs(ny)) * Math.abs(ey - c.y), T.x + 40, TR - 40);
    }
    var e = nearestEdge(ex, ey), od = CONFIG.cat.outsideDist;
    var ox = ex + e.nx * od, oy = ey + e.ny * od;
    var SJ = CONFIG.cat.scareJump;
    startJump(c, ox, oy, clamp(dist(c.x, c.y, ox, oy) / SJ.speed, SJ.minTime, SJ.maxTime), SJ.height, 'gone');
    G.spawn.catT = Math.max(G.spawn.catT, CONFIG.cat.scaredReturnDelay);
  }
  // The item a cat is pushing gets flicked straight back at it: the cat hops up in surprise,
  // the item slides underneath, and the cat loses interest. (Scaring needs a different item.)
  function startleCat(c, it) {
    it.hitCatId = c.id; it.hitT = G.time;
    if (c.hopT > 0) return;
    c.hopT = CONFIG.cat.startleHop;
    c.mood = 'scared'; c.moodT = 0.6;
    popup('ビクッ!', c.x, c.y - catR(c) * 1.9, { size: 34, color: '#ffffff', stroke: '#3a3550', life: 0.6, rise: 20 });
    // snatched away right under its nose mid-stare: a sulky "チッ…" once it lands
    if (c.state === 'stare') popup('チッ…', c.x, c.y - catR(c) * 2.0, { size: 36, color: '#ffffff', stroke: '#5a4a6a', life: 0.9, rise: 16, pop: 1.2, delay: 0.55 });
    c.lastTarget = c.target; c.target = null;
    setState(c, 'huh');
  }
  function hitCat(c, it, v, nx, ny) {
    var vn = v.x * nx + v.y * ny, b = CONFIG.cat.hitBounce;
    M.Body.setVelocity(it.body, { x: (v.x - 2 * vn * nx) * b, y: (v.y - 2 * vn * ny) * b });  // the item bounces back
    it.hitCatId = c.id; it.hitT = G.time;
    if (c.def.ignoresHits) {
      popup('びくともしない…', c.x, c.y - catR(c) * 1.8, { size: 28, color: '#ffffff', stroke: '#5a4a3a', life: 0.9 });
      Sfx.play('thud');
      addShake(0.15);
      c.mood = 'annoyed'; c.moodT = 0.9;
      return;
    }
    G.score += CONFIG.score.catHit;
    G.stats.catHits++;
    G.scorePop = 1;
    popup('ニャッ!', c.x, c.y - 70, { size: 58, color: '#ffffff', stroke: '#ff7a45', pop: 1.3, life: 0.9 });
    popup('+' + CONFIG.score.catHit, c.x + 10, c.y - 10, { size: 34, color: '#ffd166', stroke: '#3a2b2b', life: 0.9, rise: 70 });
    Sfx.play('nya');
    addShake(CONFIG.fx.shakeHit);
    for (var i = 0; i < 8; i++) {
      var a = G.fx.range(0, TAU), sp = G.fx.range(2, 6);
      spawnParticle({ kind: 'star', x: c.x, y: c.y - 20, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 0.9, life: 0.6, size: G.fx.range(7, 12), color: '#ffd166' });
    }
    scareCat(c, nx, ny);
  }
  function followTarget(c, it, dt) {
    var ap = approachPoint(c, it, true);
    var d = dist(c.x, c.y, ap.x, ap.y);
    moveToward(c, ap.x, ap.y, Math.max(c.def.walkSpeed, CONFIG.cat.followSpeedMin) * dt);
    return d;
  }
  function updateCat(c, dt) {
    c.st += dt; c.anim += dt; c.moving = false;
    if (c.pawT > 0) c.pawT = Math.max(0, c.pawT - dt);
    if (c.smugT > 0) c.smugT = Math.max(0, c.smugT - dt);
    if (c.popT > 0) c.popT = Math.max(0, c.popT - dt);
    if (c.moodT > 0) { c.moodT -= dt; if (c.moodT <= 0) c.mood = 'normal'; }
    c.stare += ((c.state === 'stare' ? 1 : 0) - c.stare) * Math.min(1, dt * 12);
    if (c.hopT > 0 && c.state !== 'jump') {
      c.hopT = Math.max(0, c.hopT - dt);
      c.z = Math.sin(Math.PI * (1 - c.hopT / CONFIG.cat.startleHop)) * CONFIG.cat.startleHeight;
      if (c.hopT === 0) c.z = 0;
    }
    var it = (c.target && c.target.state === 'table') ? c.target : null;
    var ap, d;
    switch (c.state) {
      case 'jump': updateJump(c, dt); return;
      case 'pose': return;
      case 'choose': chooseTarget(c); return;
      case 'idle':
        c.lookX = Math.cos(c.anim * 0.8); c.lookY = Math.sin(c.anim * 0.6);
        if (c.st > CONFIG.cat.idleTime) setState(c, 'choose');
        return;
      case 'walk':
        if (!it) { setState(c, 'choose'); return; }
        ap = approachPoint(c, it, false);
        if (moveToward(c, ap.x, ap.y, c.def.walkSpeed * dt)) setState(c, 'sit');
        else if (c.st > CONFIG.cat.walkTimeout) setState(c, 'choose');
        lookAt(c, it.x, it.y, Math.min(1, dt * 8));
        return;
      case 'sit':
        if (!it) { setState(c, 'choose'); return; }
        followTarget(c, it, dt);
        lookAt(c, it.x, it.y, Math.min(1, dt * 10));
        if (c.st >= CONFIG.cat.sitTime) { setState(c, 'push'); c.tapT = CONFIG.cat.firstTapDelay; }
        return;
      case 'push':
        if (!it) { huh(c); return; }
        d = followTarget(c, it, dt);
        lookAt(c, it.x, it.y, Math.min(1, dt * 10));
        if (d > CONFIG.cat.pushLeash) {
          if (G.time - it.playerTouchT < CONFIG.cat.flickedGiveUp) huh(c); else setState(c, 'walk');
          return;
        }
        if (c.st > CONFIG.cat.maxPushTime) { huh(c); return; }
        c.tapT -= dt;
        if (c.tapT <= 0) catTap(c, it);
        return;
      case 'stare':
        if (!it) { huh(c); return; }
        c.lookX = lerp(c.lookX, 0, Math.min(1, dt * 12)); c.lookY = lerp(c.lookY, 0, Math.min(1, dt * 12));
        c.beatT -= dt;
        if (c.beatT <= 0) { c.beatT = CONFIG.cat.heartbeatEvery; Sfx.play('heart'); }
        ap = approachPoint(c, it, true);
        if (distToStareLine(it, c.pushDir) > CONFIG.cat.stareBreakDist || dist(c.x, c.y, ap.x, ap.y) > CONFIG.cat.stareLeash) {
          if (G.time - it.playerTouchT < CONFIG.cat.foilWindow) foiled(c); else huh(c);
          return;
        }
        if (c.st >= c.def.stareTime) finalPush(c, it);
        return;
      case 'after':
        if (c.target && c.target.state !== 'gone') lookAt(c, c.target.x, c.target.y, Math.min(1, dt * 8));
        if (c.st >= CONFIG.cat.afterTime) {
          var chance = c.broke ? CONFIG.cat.leaveChanceAfterBreak : CONFIG.cat.leaveChance;
          if (G.rng() < chance) startLeave(c);
          else { c.lastTarget = c.target; c.target = null; setState(c, 'choose'); }
        }
        return;
      case 'huh':
        if (c.st > CONFIG.cat.huhTime) setState(c, 'choose');
        return;
      case 'leave':
        var e = c.leaveEdge;
        if (moveToward(c, e.x, e.y, c.def.walkSpeed * CONFIG.cat.leaveSpeedMul * dt)) startJump(c, e.ox, e.oy, CONFIG.cat.leaveJump.time, CONFIG.cat.leaveJump.height, 'gone');
        return;
      case 'eat':
        c.face = angleLerp(c.face, Math.atan2(CONFIG.treat.bowlY - c.y, CONFIG.treat.bowlX - c.x), Math.min(1, dt * 6));
        c.mood = 'happy'; c.moodT = 0.3;
        c.munchT -= dt;
        if (c.munchT <= 0) {
          c.munchT = 0.9 + G.fx() * 0.8;
          popup('もぐ', c.x + G.fx.range(-14, 14), c.y - catR(c) * 1.6, { size: 22, color: '#ffffff', stroke: '#d0537a', life: 0.7, rise: 26 });
          Sfx.play('munch');
        }
        return;
    }
  }

  // ---- fx -----------------------------------------------------------------------
  function spawnParticle(p) {
    if (G.particles.length > 500) G.particles.splice(0, 60);
    p.t = 0;
    G.particles.push(p);
  }
  // keep a popup's text inside the 720-wide play area (big crash texts used to be cut off at the side)
  function fitPopupX(text, x, size, pop) {
    ctx.font = 'bold ' + Math.round(size) + 'px ' + FONT;
    var hw = (ctx.measureText(text).width / 2 + size * 0.15) * Math.max(1, pop * 1.05);   // room for the pop-in overshoot
    if (hw * 2 > VW - 16) return VW / 2;
    return clamp(x, 8 + hw, VW - 8 - hw);
  }
  // o.key: replaces a live popup with the same key; o.stack: moves down past a live stacked popup (two crashes at once)
  function popup(text, x, y, o) {
    o = o || {};
    x = fitPopupX(text, x, o.size || 36, o.pop || 1);
    var i;
    if (o.key) for (i = G.popups.length - 1; i >= 0; i--) if (G.popups[i].key === o.key) G.popups.splice(i, 1);
    if (o.stack) {
      for (var guard = 0; guard < 4; guard++) {
        var hit = false;
        for (i = 0; i < G.popups.length; i++) { var q = G.popups[i]; if (q.stack && q.t < q.life * 0.8 && Math.abs(q.y - y) < 180) { hit = true; break; } }
        if (!hit) break;
        y += y > TCY + 100 ? -200 : 200;
      }
    }
    var p = { text: text, x: x, y: y, t: -(o.delay || 0), life: o.life || 0.9, size: o.size || 36, color: o.color || '#ffffff',
      stroke: o.stroke || '#3a2b2b', rise: o.rise === undefined ? 50 : o.rise, rot: o.rot || 0, pop: o.pop || 1, key: o.key || null, stack: !!o.stack };
    G.popups.push(p);
    return p;
    if (G.popups.length > 40) G.popups.shift();
  }
  function banner(text, sub, life, kind, y) { G.banner = { text: text, sub: sub || '', t: 0, life: life || 2, kind: kind || 'info', y: y || 520 }; }
  function toast(text) { G.toast = { text: text, t: 0, life: 2.2 }; }
  function addShake(a) { G.shake = clamp(G.shake + a, 0, 1); }
  function addFlash(a, col) { if (a > G.flash) { G.flash = a; G.flashCol = col || '#ffffff'; } }
  // slow motion / hit-stop only scale the play simulation (fx, popups and input stay real-time)
  function slowMo(scale, dur) {
    if (G.screen !== 'play' || G.slow.cd > 0) return;
    G.slow = { t: dur, dur: dur, scale: scale, cd: CONFIG.fx.fallSlowCooldown };
  }
  function hitStop(d) { if (G.screen === 'play') G.hitStop = Math.max(G.hitStop, d); }
  function timeScale() {
    if (G.hitStop > 0) return CONFIG.fx.hitStopScale;
    if (G.slow.t > 0) return lerp(G.slow.scale, 1, easeInCubic(1 - G.slow.t / G.slow.dur));
    return 1;
  }
  function tickTimeScale(dt) {
    if (G.hitStop > 0) { G.hitStop = Math.max(0, G.hitStop - dt); return; }
    if (G.slow.t > 0) G.slow.t = Math.max(0, G.slow.t - dt);
    if (G.slow.cd > 0) G.slow.cd = Math.max(0, G.slow.cd - dt);
  }
  function fxRipple(x, y) { spawnParticle({ kind: 'ripple', x: x, y: y, vx: 0, vy: 0, life: 0.35, size: 14, color: 'rgba(255,255,255,0.8)' }); }

  // ==========================================================================
  // 7. Update — rules, scoring, spawning, escalation
  // ==========================================================================
  function resetRunState(seed) {
    G.seed = seed >>> 0 || 1;
    G.rng = makeRng(G.seed);
    G.fx = makeRng((G.seed ^ 0x5bd1e995) >>> 0);
    G.engine = M.Engine.create({ positionIterations: CONFIG.physics.positionIterations, velocityIterations: CONFIG.physics.velocityIterations, enableSleeping: false });
    G.engine.gravity.x = 0; G.engine.gravity.y = 0; G.engine.gravity.scale = 0;
    M.Events.on(G.engine, 'collisionStart', onCollision);
    G.items = []; G.cats = []; G.particles = []; G.popups = []; G.banner = null; G.toast = null;
    G.drags = {}; G.pressed = null; G.pressedId = null; G.debugNoSpawn = false;
    G.time = 0; G.score = 0; G.breaks = 0; G.broken = []; G.scoreAcc = 0; G.scorePop = 0; G.breakPop = 0;
    G.shake = 0; G.overT = 0; G.resultT = 0; G.phaseIdx = 0; G.result = null;
    G.slow = { t: 0, dur: 1, scale: 1, cd: 0 }; G.hitStop = 0; G.flash = 0;
    G.spawn = { catT: CONFIG.cat.firstSpawnAt, itemT: 0, itemCount: 0 };
    G.gather = { next: CONFIG.gather.firstAt, warned: false, until: -1 };
    G.treat = { used: false, active: false, t: 0, slots: 0, fade: 0 };
    G.stats = { flicks: 0, safes: 0, catHits: 0, specials: 0 };
  }
  function startRun(seed) {
    resetRunState(seed);
    var types = CONFIG.itemSpawn.initial;
    for (var i = 0; i < types.length; i++) {
      var near = i < CONFIG.itemSpawn.firstNearEdge;
      var p = findFreeSpot(typeRadius(types[i]), near ? CONFIG.itemSpawn.firstMargin : CONFIG.itemSpawn.margin, near);
      if (p) {
        var it = createItem(types[i], p.x, p.y, CONFIG.items[types[i]].shape === 'rect' ? G.rng.range(-0.5, 0.5) : 0);
        it.spawnT = 0.15 - i * 0.07;   // staggered drop-in
      }
    }
    G.screen = 'play';
    G.frozen = false;
  }
  // free spot on the table; nearEdge=true biases the first items toward an edge so the first cat has a target
  function findFreeSpot(r, margin, nearEdge) {
    var best = null, bestClear = -Infinity;
    for (var tries = 0; tries < 50; tries++) {
      var x = G.rng.range(T.x + margin, TR - margin), y = G.rng.range(T.y + margin, TB - margin);
      if (nearEdge) {
        var side = G.rng.int(0, 3), inset = margin + G.rng.range(CONFIG.itemSpawn.firstInset[0], CONFIG.itemSpawn.firstInset[1]);
        if (side === 0) x = T.x + inset; else if (side === 1) x = TR - inset; else if (side === 2) y = T.y + inset; else y = TB - inset;
      }
      var clear = Infinity;
      for (var i = 0; i < G.items.length; i++) {
        var o = G.items[i];
        if (!onTable(o)) continue;
        clear = Math.min(clear, dist(x, y, o.x, o.y) - r - itemRadius(o) - CONFIG.itemSpawn.spacing);
      }
      for (var j = 0; j < G.cats.length; j++) {
        var c = G.cats[j];
        if (c.dead || c.state === 'jump') continue;
        clear = Math.min(clear, dist(x, y, c.x, c.y) - r - catR(c));
      }
      if (clear >= 0) return { x: x, y: y };
      if (clear > bestClear) { bestClear = clear; best = { x: x, y: y }; }
    }
    return bestClear > -r ? best : null;
  }
  function pickNewItemType() {
    var S = CONFIG.itemSpawn;
    if (G.spawn.itemCount === S.tsuboOnSpawn) return 'tsubo';
    var pool = ['cup', 'plate', 'vase', 'cake', 'phone'];
    if (G.time >= S.tsuboFromTime) pool.push('tsubo');
    if (G.time >= S.roundFromTime) pool.push('orange', 'orange', 'ball', 'ball');
    return G.rng.pick(pool);
  }
  function placeNewItem() {
    G.spawn.itemCount++;
    var type = pickNewItemType();
    if (countOnTable() >= CONFIG.itemSpawn.maxItems) return null;
    var p = findFreeSpot(typeRadius(type), CONFIG.itemSpawn.margin, false);
    if (!p) return null;
    var it = createItem(type, p.x, p.y, CONFIG.items[type].shape === 'rect' ? G.rng.range(-0.6, 0.6) : 0);
    Sfx.play('pon');
    if (type === 'tsubo') {
      popup('高級つぼ!', p.x, p.y - 70, { size: 36, color: '#ffe9a8', stroke: '#5a3d0a', life: 1.8, rise: 30, pop: 1.3 });
      if (G.spawn.itemCount === CONFIG.itemSpawn.tsuboOnSpawn && !G.banner) { banner('高級つぼが置かれた!', '割れたら2つ分…ネコに注意!', 2.0, 'info', p.y < 760 ? 900 : 480); Sfx.play('phase'); }
      for (var i = 0; i < 10; i++) {
        var a = i / 10 * TAU;
        spawnParticle({ kind: 'star', x: p.x + Math.cos(a) * 40, y: p.y + Math.sin(a) * 40, vx: Math.cos(a) * 2, vy: Math.sin(a) * 2, drag: 0.9, life: 0.8, size: 9, color: '#ffe066' });
      }
    }
    else popup('ポン', p.x, p.y - 50, { size: 26, color: '#ffffff', stroke: '#6b4a2e', life: 0.7, rise: 24 });
    return it;
  }
  function phaseAt(t) {
    var ph = CONFIG.phases[0];
    for (var i = 0; i < CONFIG.phases.length; i++) if (t >= CONFIG.phases[i].t) ph = CONFIG.phases[i];
    return ph;
  }
  function desiredCats(t) { return t < G.gather.until ? CONFIG.gather.cats : phaseAt(t).cats; }
  function pickCatType(t) {
    var ph = phaseAt(t);
    if (ph.special > 0 && G.rng() < ph.special) {
      var pool = ['kitten', 'ninja', 'fat'];
      for (var i = 0; i < G.cats.length; i++) if (!G.cats[i].dead && G.cats[i].type === 'fat') { pool = ['kitten', 'ninja']; break; }
      return G.rng.pick(pool);
    }
    return 'normal';
  }
  function updateSpawning(dt) {
    if (G.debugNoSpawn) return;
    var S = CONFIG.itemSpawn, gc = CONFIG.gather;
    G.spawn.itemT += dt;
    if (G.spawn.itemT >= S.interval) { G.spawn.itemT -= S.interval; placeNewItem(); }

    while (G.phaseIdx + 1 < CONFIG.phases.length && G.time >= CONFIG.phases[G.phaseIdx + 1].t) {
      G.phaseIdx++;
      var ph = CONFIG.phases[G.phaseIdx];
      if (ph.msg) { banner(ph.msg, ph.sub, 2.2, 'info'); Sfx.play('phase'); }
    }
    if (!G.gather.warned && G.time >= G.gather.next - gc.warn) {
      G.gather.warned = true;
      banner('ネコ大集合!!', '', gc.warn + 0.5, 'warn');
      Sfx.play('warn');
    }
    if (G.time >= G.gather.next) {
      G.gather.until = G.time + gc.duration;
      G.gather.next += gc.every;
      G.gather.warned = false;
      G.spawn.catT = 0;
    }

    G.spawn.catT -= dt;
    if (G.treat.active) return;
    var want = desiredCats(G.time), active = 0;
    for (var i = 0; i < G.cats.length; i++) if (!G.cats[i].dead && !G.cats[i].leaving) active++;
    if (active < want && G.spawn.catT <= 0) {
      spawnCat(pickCatType(G.time));
      G.spawn.catT = G.time < G.gather.until ? CONFIG.cat.gatherSpawnCooldown : CONFIG.cat.spawnCooldown;
    }
  }

  function onCollision(ev) {
    var pairs = ev.pairs;
    for (var i = 0; i < pairs.length; i++) {
      var a = pairs[i].bodyA.parent || pairs[i].bodyA, b = pairs[i].bodyB.parent || pairs[i].bodyB;
      var ia = a.plugin && a.plugin.item, ib = b.plugin && b.plugin.item;
      if (!ia || !ib) continue;
      var va = M.Body.getVelocity(a), vb = M.Body.getVelocity(b);
      var rel = hypot(va.x - vb.x, va.y - vb.y);
      if (rel > 1.5) {
        Sfx.play('clack', rel);
        var fast = hypot(va.x, va.y) >= hypot(vb.x, vb.y) ? ia : ib, slow = fast === ia ? ib : ia;
        if (fast.lastToucher) slow.lastToucher = fast.lastToucher;   // chain reactions keep the culprit
        if (G.time - fast.playerTouchT < CONFIG.cat.playerTouchWindow) slow.playerTouchT = Math.max(slow.playerTouchT, fast.playerTouchT);
        if (rel > 6) {
          var cp = pairs[i].collision && pairs[i].collision.supports && pairs[i].collision.supports[0];
          var px = cp ? cp.x : (ia.x + ib.x) / 2, py = cp ? cp.y : (ia.y + ib.y) / 2;
          for (var k = 0; k < 4; k++) {
            var an = G.fx.range(0, TAU), sp = G.fx.range(1, 3);
            spawnParticle({ kind: 'spark', x: px, y: py, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, drag: 0.85, life: 0.25, size: 4, color: '#ffffff' });
          }
        }
      }
    }
  }

  function checkCatHits() {
    var C = CONFIG.cat;
    for (var i = 0; i < G.cats.length; i++) {
      var c = G.cats[i];
      if (!isHittable(c)) continue;
      var R = catR(c);
      for (var j = 0; j < G.items.length; j++) {
        var it = G.items[j];
        if (!onTable(it) || G.time - it.playerTouchT > C.playerTouchWindow) continue;
        if (it.hitCatId === c.id && G.time - it.hitT < 0.5) continue;
        var v = M.Body.getVelocity(it.body), sp = hypot(v.x, v.y);
        if (sp < C.scareSpeed) continue;
        var dx = c.x - it.x, dy = c.y - it.y, d = hypot(dx, dy);
        if (d > R + itemRadius(it) * 0.9 || d < 0.001) continue;
        if (v.x * dx + v.y * dy <= 0) continue;   // moving away from the cat
        if (it === c.target) { startleCat(c, it); break; }
        hitCat(c, it, v, dx / d, dy / d);
        break;
      }
    }
  }

  function startFall(it) {
    it.state = 'falling'; it.fallT = 0;
    var v = M.Body.getVelocity(it.body);
    it.vx = v.x; it.vy = v.y;
    var nx = it.x < T.x ? -1 : (it.x > TR ? 1 : 0), ny = it.y < T.y ? -1 : (it.y > TB ? 1 : 0);
    if (nx && ny) { if (Math.abs(it.vx) > Math.abs(it.vy)) ny = 0; else nx = 0; }
    it.fallNx = nx; it.fallNy = ny;
    var out = it.vx * nx + it.vy * ny;
    if (out < CONFIG.fallMinSpeed) { it.vx += nx * (CONFIG.fallMinSpeed - out); it.vy += ny * (CONFIG.fallMinSpeed - out); }
    M.Composite.remove(G.engine.world, it.body);
    for (var k in G.drags) if (G.drags[k].item === it) delete G.drags[k];
    it.rescueArmed = false;
    Sfx.play('fall');
    slowMo(CONFIG.fx.fallSlowScale, CONFIG.fx.fallSlowTime);   // "ああっ…" — the drop plays out in slow motion
  }
  function resolveCulprit(it) {
    if (it.lastToucher) return it.lastToucher;
    var best = null, bd = Infinity;
    for (var i = 0; i < G.cats.length; i++) {
      var c = G.cats[i];
      if (c.dead) continue;
      var d = dist(c.x, c.y, it.x, it.y);
      if (d < bd) { bd = d; best = c; }
    }
    return best ? catSnapshot(best) : { kind: 'cat', catId: 0, color: 'tora', ctype: 'normal', name: '茶トラ' };
  }
  function shatter(it) {
    it.state = 'gone';
    var d = it.def, f = G.fx, n = d.breakValue > 1 ? 26 : 16;
    var base = Math.atan2(it.fallNy, it.fallNx);
    for (var i = 0; i < n; i++) {
      var a = base + f.range(-2.5, 2.5), sp = f.range(2, 9);   // splash along the edge too, so it reads on a phone
      spawnParticle({ kind: 'shard', x: it.x + f.range(-10, 10), y: it.y + f.range(-10, 10), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        drag: 0.9, life: f.range(1.6, 3.2), size: f.range(5, 13), color: f() < 0.6 ? d.colors[0] : d.colors[1], rot: f.range(0, TAU), vr: f.range(-0.3, 0.3) });
    }
    for (var j = 0; j < 8; j++) {
      var a2 = f.range(0, TAU);
      spawnParticle({ kind: 'dust', x: it.x, y: it.y, vx: Math.cos(a2) * 3, vy: Math.sin(a2) * 3, drag: 0.85, life: 0.5, size: 12, color: 'rgba(255,255,255,0.5)' });
    }
    // the crash text sits a little inside the table (off the culprit cat) so the whole scene stays readable
    var px = lerp(clamp(it.x, T.x, TR), TCX, 0.35), py = clamp(it.y - (it.y > T.y + 260 ? 150 : -150), T.y + 90, TB - 170);
    var cp = popup(d.crashText, px, py, { size: 84, color: '#ffffff', stroke: '#d6333f', life: 1.3, rot: f.range(-0.15, 0.15), pop: 1.4, rise: 30, stack: true });
    px = cp.x; py = cp.y;
    var ly = py + 78;
    if (d.breakValue > 1) { popup('×' + d.breakValue + '!', px, ly, { size: 54, color: '#ffe066', stroke: '#8a1c1c', life: 1.3, rise: 20, pop: 1.3 }); ly += 58; }
    addShake(CONFIG.fx.shakeCrash);
    addFlash(CONFIG.fx.crashFlash, '#ffffff');
    hitStop(CONFIG.fx.hitStop);
    Sfx.play('crash');
    G.breaks += d.breakValue;
    G.breakPop = 1;
    var culprit = resolveCulprit(it);
    G.broken.push({ type: it.type, culprit: culprit, time: G.time, seed: f.int(1, 1e9) });
    var left = CONFIG.breaksToLose - G.breaks;
    if (culprit.kind === 'player') {
      // "自分で落としたあああ": the cats are innocent and look very pleased about it
      popup('じ、自滅…!', px, ly, { size: 50, color: '#ffffff', stroke: '#6b3fa0', life: 1.6, rise: 16, pop: 1.25, key: 'selfown' });
      ly += 54;
      for (var i = 0; i < G.cats.length; i++) {
        var oc = G.cats[i];
        if (oc.dead || oc.state === 'jump' || oc.state === 'eat') continue;
        oc.smugT = CONFIG.cat.smugTime * 0.7;
        popup('ネコ無罪', oc.x, oc.y - catR(oc) * 2.1, { size: 26, color: '#ffffff', stroke: '#6b3fa0', life: 1.5, rise: 18, delay: 0.5 });
      }
    } else if (culprit.kind === 'cat') {
      var c = findCat(culprit.catId);
      if (c && !c.dead) {
        c.smugT = CONFIG.cat.smugTime; c.broke = true;
        if (c.state !== 'jump') popup('ドヤッ', c.x, c.y - catR(c) * 2.1, { size: 38, color: '#ffd166', stroke: '#3a2b2b', life: 1.5, rise: 22, pop: 1.3, delay: 0.45 });
      }
    }
    // right under the われた counter, so the HUD explains itself
    if (left > 0 && G.screen === 'play') popup('あと' + left + 'つ割れたらアウト!', 360, 208, { size: 30, color: '#ffffff', stroke: '#d6333f', life: 2.0, rise: 0, pop: 1.2, delay: 0.2, key: 'left' });
    if (G.breaks >= CONFIG.breaksToLose && G.screen === 'play') gameOver();
  }
  function willStopOnTable(it) {
    var v = M.Body.getVelocity(it.body), sp = hypot(v.x, v.y), r = itemRadius(it) * 0.5;
    if (sp < 0.01) return true;
    var L = slideDist(sp, it.def.frictionAir), x = it.x + v.x / sp * L, y = it.y + v.y / sp * L;
    return x > T.x + r && x < TR - r && y > T.y + r && y < TB - r;
  }
  function awardSafe(it) {
    it.rescueArmed = false; it.catDanger = false;
    G.score += CONFIG.score.safe;
    G.stats.safes++;
    G.scorePop = 1;
    // shown where the item is going to stop (toward the middle), clear of the cat and its "ビクッ!/チッ…"
    var v = M.Body.getVelocity(it.body), sp = hypot(v.x, v.y), L = sp > 0.01 ? Math.min(slideDist(sp, it.def.frictionAir), 320) : 0;
    var sx = clamp(it.x + (sp > 0.01 ? v.x / sp * L : 0), T.x + 120, TR - 120);
    var sy = clamp(it.y + (sp > 0.01 ? v.y / sp * L : 0), T.y + 90, TB - 90) - 60;
    popup('セーフ!', sx, sy, { size: 64, color: '#ffffff', stroke: '#2e9e5b', pop: 1.4, life: 1.1 });
    addFlash(CONFIG.fx.safeFlash, '#c8ffd8');
    popup('+' + CONFIG.score.safe, sx, sy + 52, { size: 36, color: '#ffd166', stroke: '#3a2b2b', life: 1.0, rise: 70 });
    Sfx.play('safe');
    for (var i = 0; i < 10; i++) {
      var a = G.fx.range(0, TAU), sp = G.fx.range(2, 5);
      spawnParticle({ kind: 'star', x: it.x, y: it.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 0.9, life: 0.7, size: G.fx.range(7, 12), color: '#9df2b5' });
    }
  }
  function updateItems(dt) {
    var S = CONFIG.score;
    for (var i = 0; i < G.items.length; i++) {
      var it = G.items[i];
      if (it.spawnT < CONFIG.itemSpawn.dropTime) {
        it.spawnT += dt;
        if (it.spawnT >= CONFIG.itemSpawn.dropTime && !it.landed) {
          it.landed = true;
          for (var k = 0; k < 6; k++) {
            var a = k / 6 * TAU;
            spawnParticle({ kind: 'dust', x: it.x, y: it.y, vx: Math.cos(a) * 2.5, vy: Math.sin(a) * 2.5, drag: 0.85, life: 0.35, size: 7, color: 'rgba(255,255,255,0.6)' });
          }
        }
      }
      if (it.state === 'table') {
        var b = it.body;
        it.x = b.position.x; it.y = b.position.y; it.angle = b.angle;
        computeOverhang(it);
        if (it.x < T.x || it.x > TR || it.y < T.y || it.y > TB) { startFall(it); continue; }
        if (it.overhang >= S.safeOverhang && it.lastToucher && it.lastToucher.kind === 'cat') it.catDanger = true;
        else if (it.overhang <= 0 && !it.rescueArmed) it.catDanger = false;
        if (it.rescueArmed) {
          var sp = M.Body.getSpeed(b);
          // セーフ! as soon as the item is back on the table and is going to stop on it (snappy),
          // or once it settles / times out; a flick that will carry it off the far side waits
          if (it.overhang <= 0 && (sp < S.safeSettleSpeed || G.time - it.rescueT > S.safeTimeout || willStopOnTable(it))) awardSafe(it);
          else if (G.time - it.rescueT > S.safeArmWindow) it.rescueArmed = false;
        }
      } else if (it.state === 'falling') {
        it.fallT += dt;
        var k2 = Math.pow(0.9, dt * 60);
        it.vx *= k2; it.vy *= k2;
        it.x += it.vx * dt * 60; it.y += it.vy * dt * 60;
        var mo = CONFIG.fallMaxOut;
        if (it.fallNx) it.x = clamp(it.x, T.x - mo, TR + mo);
        if (it.fallNy) it.y = clamp(it.y, T.y - mo, TB + mo);
        it.angle += 0.05;
        if (it.fallT >= CONFIG.fallTime) shatter(it);
      }
    }
    for (var j = G.items.length - 1; j >= 0; j--) if (G.items[j].state === 'gone') G.items.splice(j, 1);
  }

  // ---- おやつ (rewarded-ad hook) ------------------------------------------------
  // === AD HOOK ===================================================================
  // Stub for a future rewarded video ad. A real integration would show the ad and
  // call onReward() only after the player watched it (onCancel otherwise).
  // For this prototype the reward is granted immediately. No real ad is shown.
  var AdHooks = {
    showRewarded: function (placement, onReward, onCancel) {
      try { onReward(); } catch (e) { reportError(e); if (onCancel) onCancel(); }
    }
  };
  function useTreat() {
    if (G.treat.used || G.screen !== 'play') { if (G.treat.used) Sfx.play('miss'); return; }
    AdHooks.showRewarded('treat', startTreat);
  }
  var BOWL_SLOTS = [-90, -160, -20, 140, 40, -125, -55, 180, 0];
  function startTreat() {
    var tr = G.treat;
    tr.used = true; tr.active = true; tr.t = 0; tr.slots = 0; tr.fade = 1;
    Sfx.play('treat');
    banner('おやつタイム!', 'ネコたちが10秒おやつに夢中', 1.8, 'treat');
    for (var i = 0; i < G.cats.length; i++) {
      var c = G.cats[i];
      if (c.dead || (c.leaving && c.state === 'jump')) continue;
      sendToBowl(c);
    }
  }
  function sendToBowl(c) {
    var TC = CONFIG.treat, a = BOWL_SLOTS[G.treat.slots % BOWL_SLOTS.length] * Math.PI / 180;
    G.treat.slots++;
    c.target = null; c.pushDir = null; c.leaving = false;
    startJump(c, TC.bowlX + Math.cos(a) * TC.ringR, TC.bowlY + Math.sin(a) * TC.ringR * 0.6, TC.jumpTime, TC.jumpHeight, 'eat');
    popup('!', c.x, c.y - catR(c) * 1.8, { size: 40, color: '#ffffff', stroke: '#d0537a', life: 0.5, rise: 10 });
  }
  function updateTreat(dt) {
    var tr = G.treat, TC = CONFIG.treat;
    if (!tr.active) { if (tr.fade > 0) tr.fade = Math.max(0, tr.fade - dt * 2); return; }
    tr.t += dt;
    if (tr.t >= CONFIG.treat.duration) {
      tr.active = false;
      banner('おやつ終わり!', 'ネコが戻ってくる…', 1.4, 'info');
      for (var i = 0; i < G.cats.length; i++) {
        var c = G.cats[i];
        if (c.dead) continue;
        if (c.state === 'eat' || (c.state === 'jump' && c.jump && c.jump.onLand === 'eat')) {
          c.mood = 'normal';
          startJump(c, clamp(c.x, T.x + TC.returnInset, TR - TC.returnInset), TB - TC.returnInset - G.rng() * TC.returnSpread, TC.returnTime, TC.returnHeight, 'landed');
        }
      }
      G.spawn.catT = Math.min(G.spawn.catT, TC.returnSpawnDelay);
    }
  }

  // 称号 for the result screen / share text
  function rankFor(r) {
    var mine = 0, i;
    for (i = 0; i < r.broken.length; i++) if (r.broken[i].culprit && r.broken[i].culprit.kind === 'player') mine++;
    if (mine >= 2) return CONFIG.selfOwnRank;
    var name = CONFIG.ranks[0].name;
    for (i = 0; i < CONFIG.ranks.length; i++) if (r.time >= CONFIG.ranks[i].t) name = CONFIG.ranks[i].name;
    return name;
  }
  function gameOver() {
    G.screen = 'over';
    G.overT = 0;
    G.drags = {};
    Sfx.play('over');
    banner(CONFIG.breaksToLose + 'つ割れた…', 'ゲームオーバー', CONFIG.overTime + 0.2, 'over');
  }
  function showResult(opts) {
    opts = opts || {};
    var r = { time: G.time, score: G.score, broken: G.broken.slice(0, 3), newBest: false, newBestTime: false, best: G.best, bestTime: G.bestTime,
      stats: { flicks: G.stats.flicks, safes: G.stats.safes, catHits: G.stats.catHits } };
    r.rank = rankFor(r);
    if (G.score > G.best) { G.best = G.score; r.newBest = G.score > 0; if (!opts.noSave) Store.set(KEY_BEST, G.best); }
    if (G.time > G.bestTime) { G.bestTime = G.time; r.newBestTime = true; if (!opts.noSave) Store.set(KEY_BEST_TIME, round(G.bestTime, 1)); }
    r.best = G.best; r.bestTime = G.bestTime;
    G.result = r;
    G.screen = 'result';
    G.resultT = 0;
    G.pressed = null;
    if (r.newBest) Sfx.play('best');
  }

  function updatePlay(dt, ending) {
    if (!ending) {
      G.time += dt;
      G.scoreAcc += dt;
      while (G.scoreAcc >= 1) {
        G.scoreAcc -= 1;
        var n = countOnTable();
        if (n > 0) { G.score += n * CONFIG.score.perItemPerSecond; G.scorePop = Math.max(G.scorePop, 0.4); }
      }
      updateSpawning(dt);
      updateTreat(dt);
    }
    var sub = CONFIG.physics.substeps, h = dt * 1000 / sub;
    for (var i = 0; i < sub; i++) M.Engine.update(G.engine, h);
    updateItems(dt);
    if (!ending && G.screen === 'play') checkCatHits();
    for (var j = 0; j < G.cats.length; j++) updateCat(G.cats[j], dt);
    for (var k = G.cats.length - 1; k >= 0; k--) if (G.cats[k].dead) G.cats.splice(k, 1);
  }
  function updateFx(dt) {
    var k = dt * 60;
    for (var i = G.particles.length - 1; i >= 0; i--) {
      var p = G.particles[i];
      p.t += dt;
      if (p.t >= p.life) { G.particles.splice(i, 1); continue; }
      p.x += p.vx * k; p.y += p.vy * k;
      var dr = Math.pow(p.drag || 0.92, k);
      p.vx *= dr; p.vy *= dr;
      if (p.vr) { p.rot += p.vr * k; p.vr *= dr; }
    }
    for (var j = G.popups.length - 1; j >= 0; j--) { G.popups[j].t += dt; if (G.popups[j].t >= G.popups[j].life) G.popups.splice(j, 1); }
    if (G.banner) { G.banner.t += dt; if (G.banner.t >= G.banner.life) G.banner = null; }
    if (G.toast) { G.toast.t += dt; if (G.toast.t >= G.toast.life) G.toast = null; }
    G.shake = Math.max(0, G.shake - CONFIG.fx.shakeDecay * dt);
    G.flash = Math.max(0, G.flash - CONFIG.fx.flashDecay * dt);
    G.scorePop = Math.max(0, G.scorePop - dt * 3);
    G.breakPop = Math.max(0, G.breakPop - dt * 1.5);
  }
  function update(dt) {
    G.frame++;
    G.realTime += dt;
    updateFx(dt);
    switch (G.screen) {
      case 'title': G.titleT += dt; updateDecor(dt); break;
      case 'play': { var ts = timeScale(); tickTimeScale(dt); updatePlay(dt * ts, false); break; }
      case 'over':
        G.overT += dt;
        updatePlay(dt * CONFIG.overSlowMo, true);
        if (G.overT >= CONFIG.overTime) showResult();
        break;
      case 'result': G.resultT += dt; break;
    }
  }

  // ==========================================================================
  // 8. Render
  // ==========================================================================
  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function circ(x, y, r, fill, stroke, lw) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 2; ctx.stroke(); }
  }
  function ellipse(x, y, rx, ry, rot, fill, stroke, lw) {
    ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot || 0, 0, TAU);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 2; ctx.stroke(); }
  }
  function txt(str, x, y, size, color, o) {
    o = o || {};
    ctx.font = (o.weight || 'bold') + ' ' + Math.round(size) + 'px ' + FONT;
    ctx.textAlign = o.align || 'center';
    ctx.textBaseline = o.base || 'middle';
    if (o.stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = o.strokeW || Math.max(3, size * 0.2);
      ctx.strokeStyle = o.stroke;
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
  function fillVisible(color) {
    ctx.fillStyle = color;
    ctx.fillRect(view.x0 - 60, view.y0 - 60, view.x1 - view.x0 + 120, view.y1 - view.y0 + 120);
  }
  function star(x, y, r, points, inner) {
    ctx.beginPath();
    for (var i = 0; i < points * 2; i++) {
      var a = -Math.PI / 2 + i * Math.PI / points, rad = i % 2 ? r * (inner || 0.45) : r;
      if (i === 0) ctx.moveTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad); else ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    ctx.closePath();
  }
  function shapePath(d, pad) {
    pad = pad || 0;
    if (d.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, d.r + pad, 0, TAU); }
    else rr(-d.w / 2 - pad, -d.h / 2 - pad, d.w + pad * 2, d.h + pad * 2, d.chamfer + pad);
  }

  // ---- floor & table --------------------------------------------------------------
  function drawFloor(x0, y0, x1, y1) {
    ctx.fillStyle = '#2b2430';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    var ph = 72, row = Math.floor(y0 / ph);
    for (var y = row * ph; y < y1; y += ph, row++) {
      if (row % 2 === 0) { ctx.fillStyle = '#2f2735'; ctx.fillRect(x0, y, x1 - x0, ph); }
      ctx.fillStyle = '#251f2a';
      ctx.fillRect(x0, y, x1 - x0, 2);
      var off = (row * 173) % 260;
      for (var x = Math.floor((x0 - off) / 260) * 260 + off; x < x1; x += 260) ctx.fillRect(x, y, 2, ph);
    }
  }
  function drawTable() {
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    rr(T.x + 10, T.y + 20, T.w, T.h, 12); ctx.fill();
    ctx.fillStyle = '#ead6b0';
    rr(T.x, T.y, T.w, T.h, 10); ctx.fill();
    ctx.strokeStyle = '#d9bd8c'; ctx.lineWidth = 8;
    rr(T.x + 4, T.y + 4, T.w - 8, T.h - 8, 8); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
    rr(T.x + 10, T.y + 10, T.w - 20, T.h - 20, 6); ctx.stroke();
  }
  function drawBowl(alpha) {
    var TC = CONFIG.treat;
    ctx.save();
    ctx.globalAlpha = alpha;
    ellipse(TC.bowlX + 4, TC.bowlY + 10, 52, 22, 0, 'rgba(0,0,0,0.3)');
    ellipse(TC.bowlX, TC.bowlY, 48, 30, 0, '#ff8fb1', '#c95b80', 4);
    ellipse(TC.bowlX, TC.bowlY - 3, 36, 20, 0, '#ffd8e4');
    for (var i = 0; i < 4; i++) {
      var fx = TC.bowlX - 20 + i * 13, fy = TC.bowlY - 4 + (i % 2) * 6;
      ellipse(fx, fy, 8, 4, 0.3, '#ff9b52');
      ctx.fillStyle = '#ff9b52'; ctx.beginPath(); ctx.moveTo(fx - 7, fy - 2); ctx.lineTo(fx - 12, fy - 6); ctx.lineTo(fx - 12, fy + 3); ctx.fill();
    }
    ctx.restore();
  }

  // ---- items ---------------------------------------------------------------------------
  function flower(x, y, s, col) {
    for (var i = 0; i < 5; i++) { var a = i / 5 * TAU; circ(x + Math.cos(a) * s * 0.55, y + Math.sin(a) * s * 0.55, s * 0.45, col); }
    circ(x, y, s * 0.35, '#fff1a8');
  }
  var ART = {
    cup: function (d) {
      var r = d.r;
      circ(0, 0, r, '#d9f0fa', '#86bdd6', 3);
      circ(0, 0, r * 0.76, '#b3def2');
      ctx.save(); ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.rotate(0.4); rr(-r * 0.45, -r * 0.4, r * 0.42, r * 0.42, 4); ctx.fill();
      ctx.rotate(0.7); rr(r * 0.02, -r * 0.05, r * 0.36, r * 0.36, 4); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.88, -2.6, -1.6); ctx.stroke();
    },
    plate: function (d) {
      var r = d.r;
      circ(0, 0, r, '#fdfcf8', '#d4cab9', 3);
      circ(0, 0, r * 0.72, null, '#ebe3d3', 2);
      ctx.save(); ctx.rotate(-0.25);
      ctx.fillStyle = '#d2914f'; ctx.strokeStyle = '#9b5d2c'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-r * 0.42, 0); ctx.lineTo(-r * 0.72, -r * 0.22); ctx.lineTo(-r * 0.72, r * 0.22); ctx.closePath(); ctx.fill(); ctx.stroke();
      ellipse(r * 0.04, 0, r * 0.5, r * 0.22, 0, '#d2914f', '#9b5d2c', 2);
      ctx.strokeStyle = '#8a4f22'; ctx.lineWidth = 2;
      for (var i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(i * r * 0.18 - 4, -r * 0.14); ctx.lineTo(i * r * 0.18 + 4, r * 0.14); ctx.stroke(); }
      circ(r * 0.36, -r * 0.04, 3.2, '#ffffff'); circ(r * 0.37, -r * 0.04, 1.6, '#222222');
      ctx.restore();
    },
    vase: function (d) {
      var r = d.r;
      circ(0, 0, r, '#4c78c8', '#2f5596', 3);
      circ(0, 0, r * 0.62, '#3a62ab');
      circ(0, 0, r * 0.42, '#22406f');
      for (var i = 0; i < 3; i++) { var a = 0.6 + i * 2.1; ellipse(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, r * 0.42, r * 0.16, a, '#58b368'); }
      flower(r * 0.25, -r * 0.3, r * 0.34, '#ff8fb1');
      flower(-r * 0.36, -r * 0.02, r * 0.3, '#ffd166');
      flower(r * 0.12, r * 0.38, r * 0.28, '#ff6b8a');
    },
    cake: function (d) {
      var w = d.w, h = d.h;
      rr(-w / 2, -h / 2, w, h, d.chamfer); ctx.fillStyle = '#fff3e3'; ctx.fill();
      ctx.strokeStyle = '#e2c39b'; ctx.lineWidth = 3; ctx.stroke();
      for (var i = 0; i < 12; i++) {
        var a = i / 12 * TAU, px = Math.cos(a) * (w / 2 - 9), py = Math.sin(a) * (h / 2 - 9);
        circ(px, py, 4.5, '#ffffff', '#efd9bd', 1.5);
      }
      var berries = [[-14, -8], [13, -10], [0, 11]];
      for (var j = 0; j < berries.length; j++) {
        var bx = berries[j][0], by = berries[j][1];
        circ(bx, by, 9, '#e8434f', '#b52a35', 2);
        ctx.fillStyle = '#ffe28a';
        ctx.fillRect(bx - 3, by - 1, 1.6, 1.6); ctx.fillRect(bx + 2, by + 2, 1.6, 1.6); ctx.fillRect(bx - 1, by + 4, 1.6, 1.6);
        ctx.fillStyle = '#4caf50'; star(bx, by - 7, 5, 4, 0.4); ctx.fill();
      }
    },
    phone: function (d) {
      var w = d.w, h = d.h;
      rr(-w / 2, -h / 2, w, h, d.chamfer); ctx.fillStyle = '#2b2f3f'; ctx.fill();
      ctx.strokeStyle = '#14161f'; ctx.lineWidth = 3; ctx.stroke();
      rr(-w / 2 + 5, -h / 2 + 11, w - 10, h - 24, 5); ctx.fillStyle = '#8fd0ff'; ctx.fill();
      var cols = ['#ff8fb1', '#ffd166', '#7bd389', '#ffffff', '#c7a6ff', '#ff9b52'];
      for (var i = 0; i < 6; i++) { ctx.fillStyle = cols[i]; rr(-w / 2 + 10 + (i % 2) * 16, -h / 2 + 18 + Math.floor(i / 2) * 18, 11, 11, 3); ctx.fill(); }
      circ(0, -h / 2 + 6, 2.2, '#5a6075');
      ctx.fillStyle = '#4a4f63'; rr(-8, h / 2 - 9, 16, 3, 1.5); ctx.fill();
    },
    orange: function (d) {
      var r = d.r;
      circ(0, 0, r, '#ff9b21', '#e07a0b', 3);
      var dots = [[-9, -6], [7, -10], [10, 6], [-4, 10], [-12, 4], [3, 2], [12, -2]];
      for (var i = 0; i < dots.length; i++) circ(dots[i][0], dots[i][1], 1.6, '#f08a12');
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.7, -2.6, -1.8); ctx.stroke();
      circ(0, 0, 3.4, '#6b4a2a');
      ellipse(7, -4, 8, 4, -0.5, '#5aa83a');
    },
    ball: function (d) {
      var r = d.r, cols = ['#ff5a5f', '#ffffff', '#3d9df2', '#ffffff', '#ffd23f', '#ffffff'];
      for (var i = 0; i < 6; i++) {
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, i * TAU / 6, (i + 1) * TAU / 6); ctx.closePath();
        ctx.fillStyle = cols[i]; ctx.fill();
      }
      circ(0, 0, r, null, '#b9b0b0', 2.5);
      circ(0, 0, r * 0.18, '#ffffff', '#d6d0d0', 1.5);
    },
    tsubo: function (d, t) {
      var r = d.r;
      circ(0, 0, r, '#f7f5ef', '#c9a23b', 4);
      circ(0, 0, r * 0.8, null, '#2f5fa7', 4);
      ctx.strokeStyle = '#2f5fa7'; ctx.lineWidth = 2.5;
      for (var i = 0; i < 6; i++) {
        var a = i / 6 * TAU + 0.3;
        ctx.beginPath(); ctx.arc(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, r * 0.12, a, a + Math.PI); ctx.stroke();
      }
      circ(0, 0, r * 0.42, '#1f2d4d', '#d9b04a', 3);
      ctx.fillStyle = '#fff7c2';
      star(-r * 0.55, -r * 0.55, 6 + 3 * Math.abs(Math.sin(t * 3)), 4, 0.35); ctx.fill();
    }
  };
  function drawItemShadow(it) {
    var d = it.def, sx = 5, sy = 9, lift = 0, alpha = 0.2;
    if (it.spawnT < CONFIG.itemSpawn.dropTime) { var p = clamp(it.spawnT / CONFIG.itemSpawn.dropTime, 0, 1); lift = (1 - p) * 40; alpha = 0.12 + 0.08 * p; }
    ctx.save();
    if (it.state === 'falling') {
      var q = clamp(it.fallT / CONFIG.fallTime, 0, 1);
      ctx.translate(it.x + it.fallNx * 30 * q + 6, it.y + it.fallNy * 30 * q + 14 + 40 * q);
      ctx.scale(1 - 0.4 * q, 1 - 0.4 * q);
      ctx.fillStyle = 'rgba(0,0,0,' + (0.35 - 0.15 * q) + ')';
    } else if (it.overhang > 0) {
      // stretched shadow toward the floor = "this is about to fall"
      var o = Math.min(it.overhang * 2, 1);
      ctx.translate(it.x + sx + it.edgeNx * (8 + 46 * o), it.y + sy + it.edgeNy * (8 + 46 * o));
      if (it.edgeNx) ctx.scale(1 + 1.4 * o, 1 - 0.1 * o); else ctx.scale(1 - 0.1 * o, 1 + 1.4 * o);
      ctx.fillStyle = 'rgba(30,0,0,' + (0.3 + 0.25 * o) + ')';
    } else {
      ctx.translate(it.x + sx + lift * 0.3, it.y + sy + lift);
      ctx.fillStyle = 'rgba(60,35,10,' + alpha + ')';
    }
    ctx.rotate(it.angle);
    shapePath(d, 0);
    ctx.fill();
    ctx.restore();
  }
  function drawItem(it, t, held) {
    var d = it.def, sc = 1, alpha = 1, lift = 0;
    if (it.spawnT < CONFIG.itemSpawn.dropTime) {
      var p = clamp(it.spawnT / CONFIG.itemSpawn.dropTime, 0, 1);
      sc = 1 + (1 - easeOutCubic(p)) * 0.6; lift = (1 - p) * 40; alpha = Math.min(1, p * 4);
      if (alpha <= 0) return;
    }
    if (it.state === 'falling') { var q = clamp(it.fallT / CONFIG.fallTime, 0, 1); sc = 1 - 0.45 * easeInCubic(q); alpha = 1 - 0.25 * q; }
    if (held) sc *= 1.07;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(it.x, it.y - lift);
    ctx.rotate(it.angle);
    ctx.scale(sc, sc);
    ART[it.type](d, t);
    if (it.state === 'table' && it.overhang > 0) {
      var o = Math.min(it.overhang * 2.2, 1), flash = 0.5 + 0.5 * Math.sin(t * (14 + 10 * o));
      ctx.globalAlpha = alpha * (0.18 + 0.45 * o) * (0.35 + 0.65 * flash);
      shapePath(d, 0); ctx.fillStyle = '#ff2d2d'; ctx.fill();
      ctx.globalAlpha = alpha * (0.5 + 0.5 * flash);
      shapePath(d, 3); ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 4; ctx.stroke();
    }
    ctx.restore();
  }

  // ---- cats ------------------------------------------------------------------------------
  function drawCatHead(col, o) {
    var C = CAT_COLORS[col], HR = 27, stare = o.stare || 0, mood = o.mood || 'normal';
    ctx.lineJoin = 'round';
    for (var s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(s * HR * 0.95, -HR * 0.2); ctx.lineTo(s * HR * 0.8, -HR * 1.2); ctx.lineTo(s * HR * 0.16, -HR * 0.82); ctx.closePath();
      ctx.fillStyle = C.body; ctx.fill(); ctx.strokeStyle = C.outline; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s * HR * 0.8, -HR * 0.42); ctx.lineTo(s * HR * 0.74, -HR * 0.98); ctx.lineTo(s * HR * 0.36, -HR * 0.76); ctx.closePath();
      ctx.fillStyle = C.ear; ctx.fill();
    }
    ellipse(0, 0, HR * 1.06, HR * 0.94, 0, C.body, C.outline, 3);
    if (col === 'tora') {
      ctx.strokeStyle = C.stripe; ctx.lineWidth = 4; ctx.lineCap = 'round';
      for (var k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(k * 8, -HR * 0.86); ctx.lineTo(k * 6, -HR * 0.56); ctx.stroke(); }
    }
    if (col === 'white') { ellipse(-HR * 0.62, HR * 0.3, 6, 4, 0, 'rgba(255,150,170,0.35)'); ellipse(HR * 0.62, HR * 0.3, 6, 4, 0, 'rgba(255,150,170,0.35)'); }
    if (o.ninja) {
      ctx.fillStyle = '#d6333f';
      ctx.fillRect(-HR * 1.02, -HR * 0.66, HR * 2.04, 9);
      ctx.save(); ctx.translate(HR * 0.95, -HR * 0.6); ctx.rotate(0.5); ctx.fillRect(0, -3, 16, 6); ctx.rotate(0.5); ctx.fillRect(0, -3, 13, 6); ctx.restore();
    }
    var ex = HR * (0.42 + 0.08 * stare), ey = -HR * 0.04, ER = HR * 0.33 * (1 + 0.5 * stare);
    var lx = clamp(o.lookX || 0, -1, 1) * (1 - stare), ly = clamp(o.lookY || 0, -1, 1) * (1 - stare);
    ctx.lineCap = 'round';
    for (var e = -1; e <= 1; e += 2) {
      var cx = e * ex, cy = ey;
      if (mood === 'happy' || o.blink) {
        ctx.strokeStyle = '#2a2230'; ctx.lineWidth = 3.2;
        ctx.beginPath();
        if (mood === 'happy') ctx.arc(cx, cy + 3, ER * 0.6, Math.PI * 1.15, Math.PI * 1.85);
        else { ctx.moveTo(cx - ER * 0.7, cy); ctx.lineTo(cx + ER * 0.7, cy); }
        ctx.stroke();
        continue;
      }
      if (mood === 'scared') {
        ctx.strokeStyle = '#2a2230'; ctx.lineWidth = 3.2; ctx.beginPath();
        ctx.moveTo(cx - e * ER * 0.6, cy - ER * 0.55); ctx.lineTo(cx + e * ER * 0.5, cy); ctx.lineTo(cx - e * ER * 0.6, cy + ER * 0.55);
        ctx.stroke();
        continue;
      }
      if (mood === 'annoyed') {
        ctx.strokeStyle = '#2a2230'; ctx.lineWidth = 3.2; ctx.beginPath(); ctx.moveTo(cx - ER * 0.7, cy); ctx.lineTo(cx + ER * 0.7, cy); ctx.stroke();
        continue;
      }
      circ(cx, cy, ER, C.eye, '#2a2230', 2);
      if (mood === 'smug') {
        circ(cx + ER * 0.25, cy + ER * 0.2, ER * 0.45, '#1b1b22');
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, ER + 1.5, 0, TAU); ctx.clip();
        ctx.fillStyle = C.body; ctx.fillRect(cx - ER - 2, cy - ER - 2, ER * 2 + 4, ER * 1.1);
        ctx.restore();
        ctx.strokeStyle = '#2a2230'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx - ER, cy - ER * 0.05); ctx.lineTo(cx + ER, cy - ER * 0.1); ctx.stroke();
        continue;
      }
      var pr = ER * (0.46 + 0.36 * stare);
      circ(cx + lx * ER * 0.32, cy + ly * ER * 0.32, pr, '#1b1b22');
      circ(cx - ER * 0.32 + lx * ER * 0.2, cy - ER * 0.36 + ly * ER * 0.2, ER * (0.2 + 0.08 * stare), '#ffffff');
      if (stare > 0.05) circ(cx + ER * 0.28, cy + ER * 0.26, ER * 0.11 * stare + 0.5, 'rgba(255,255,255,' + stare + ')');
    }
    ctx.fillStyle = '#f08aa0';
    ctx.beginPath(); ctx.moveTo(-4, HR * 0.24); ctx.lineTo(4, HR * 0.24); ctx.lineTo(0, HR * 0.33); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = C.outline; ctx.lineWidth = 2;
    ctx.beginPath();
    if (mood === 'scared') { ctx.arc(0, HR * 0.5, 4, 0, TAU); }
    else {
      ctx.arc(-4, HR * 0.38, 4, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.moveTo(8, HR * 0.38); ctx.arc(4, HR * 0.38, 4, 0.1 * Math.PI, 0.9 * Math.PI);
    }
    ctx.stroke();
    ctx.strokeStyle = C.whisker; ctx.lineWidth = 1.5; ctx.globalAlpha *= 0.8;
    for (var w = -1; w <= 1; w += 2) {
      ctx.beginPath();
      ctx.moveTo(w * HR * 0.5, HR * 0.3); ctx.lineTo(w * HR * 1.25, HR * 0.18);
      ctx.moveTo(w * HR * 0.5, HR * 0.38); ctx.lineTo(w * HR * 1.25, HR * 0.44);
      ctx.stroke();
    }
    ctx.globalAlpha /= 0.8;
  }
  function catMood(c) {
    if (c.mood && c.mood !== 'normal') return c.mood;
    if (c.smugT > 0) return 'smug';
    return 'normal';
  }
  function drawCat(c, t) {
    var C = CAT_COLORS[c.color], R = CAT_ART_R, sc = catR(c) / CAT_ART_R, z = c.z || 0;
    var pop = c.popT > 0 ? Math.max(0.01, easeOutBack(1 - c.popT / CONFIG.cat.popTime)) : 1;
    var bob = c.moving ? Math.abs(Math.sin(c.anim * 12)) * 3 : Math.sin(c.anim * 2.6) * 1.2;
    var shr = R * sc * Math.max(0.4, 1 - z / 300);
    ellipse(c.x + 4, c.y + 8, shr * 1.15, shr * 0.85, 0, 'rgba(0,0,0,' + (0.25 * (1 - Math.min(0.6, z / 200))) + ')');
    ctx.save();
    ctx.translate(c.x, c.y - z * 0.8 - bob);
    var s = sc * (1 + z / 260) * pop;
    ctx.scale(s, s);
    // body (top-down, rotated toward where the cat is facing)
    ctx.save();
    ctx.rotate(c.face);
    var tw = Math.sin(c.anim * (c.state === 'stare' ? 1.4 : 3.2)) * 0.6;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-R * 0.8, 0);
    ctx.quadraticCurveTo(-R * 1.5, tw * R * 0.8, -R * 1.7, tw * R * 1.2 + R * 0.35);
    ctx.strokeStyle = C.outline; ctx.lineWidth = 13; ctx.stroke();
    ctx.strokeStyle = C.body; ctx.lineWidth = 8; ctx.stroke();
    var fat = c.type === 'fat', bw = R * (fat ? 1.12 : 0.98), bh = R * (fat ? 0.98 : 0.74);
    ellipse(-R * 0.15, 0, bw, bh, 0, C.body, C.outline, 3);
    if (c.color === 'tora') {
      ctx.strokeStyle = C.stripe; ctx.lineWidth = 5;
      for (var k = -1; k <= 1; k++) {
        ctx.beginPath(); ctx.moveTo(-R * 0.2 + k * R * 0.34, -bh * 0.82); ctx.quadraticCurveTo(-R * 0.3 + k * R * 0.34, 0, -R * 0.2 + k * R * 0.34, bh * 0.82); ctx.stroke();
      }
    }
    circ(R * 0.55, -R * 0.42, R * 0.19, C.belly, C.outline, 2.5);
    if (c.pawT <= 0) circ(R * 0.55, R * 0.42, R * 0.19, C.belly, C.outline, 2.5);
    ctx.restore();
    // head: always faces the camera; the eyes do the acting
    var hd = R * 0.48, st = c.stare;
    var hx = Math.cos(c.face) * hd, hy = Math.sin(c.face) * hd * 0.8 - R * 0.12 - 8 * st;
    ctx.save();
    ctx.translate(hx, hy);
    var hs = (c.type === 'kitten' ? 1.14 : 1) * (1 + 0.2 * st);
    ctx.scale(hs, hs);
    var blink = st < 0.1 && (c.anim % 3.7) < 0.12;
    drawCatHead(c.color, { mood: catMood(c), lookX: c.lookX, lookY: c.lookY, stare: st, ninja: c.type === 'ninja', blink: blink });
    ctx.restore();
    // the tapping paw is drawn on top so the "ちょい" reads clearly
    if (c.pawT > 0) {
      var maxT = c.state === 'after' ? CONFIG.cat.pawTime * 1.4 : CONFIG.cat.pawTime;
      var ext = Math.sin(Math.PI * clamp(1 - c.pawT / maxT, 0, 1)) * R * 0.75;
      ctx.save(); ctx.rotate(c.face);
      ctx.strokeStyle = C.outline; ctx.lineWidth = R * 0.34; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(R * 0.3, R * 0.42); ctx.lineTo(R * 0.6 + ext, R * 0.34); ctx.stroke();
      ctx.strokeStyle = C.body; ctx.lineWidth = R * 0.26;
      ctx.beginPath(); ctx.moveTo(R * 0.3, R * 0.42); ctx.lineTo(R * 0.6 + ext, R * 0.34); ctx.stroke();
      circ(R * 0.62 + ext, R * 0.34, R * 0.2, C.belly, C.outline, 2.5);
      ctx.restore();
    }
    ctx.restore();
  }
  // speech bubble "じーっ…" beside a staring cat's head; flips to the left near the right edge
  function drawStareBubble(c) {
    var R = CAT_ART_R, sc = catR(c) / CAT_ART_R, st = c.stare;
    if (c.state === 'stare' && st > 0.5) {
      // speech bubble "じーっ…" beside the head; flips to the left near the right edge
      var BW = 132, BH = 54, side = c.x + R * sc * 0.7 + BW + 6 > VW ? -1 : 1;
      var bx = side > 0 ? c.x + R * sc * 0.7 : c.x - R * sc * 0.7 - BW, by = c.y - R * sc * 2.1 - BH / 2;
      var below = by < T.y - 24;               // at the top edge: hang the bubble below the cat (keeps the HUD clear)
      if (below) by = c.y + R * sc * 1.1;
      var tx = side > 0 ? bx + 18 : bx + BW - 18;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (st - 0.5) * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; rr(bx + 3, by + 5, BW, BH, 24); ctx.fill();
      ctx.fillStyle = '#ffffff'; rr(bx, by, BW, BH, 24); ctx.fill();
      ctx.beginPath();
      if (below) { ctx.moveTo(tx - 8, by + 4); ctx.lineTo(tx - side * 14, by - 16); ctx.lineTo(tx + 10, by + 4); }
      else { ctx.moveTo(tx - 8, by + BH - 4); ctx.lineTo(tx - side * 14, by + BH + 16); ctx.lineTo(tx + 10, by + BH - 4); }
      ctx.fill();
      var dots = Math.min(3, 1 + Math.floor(c.st * 2.2));
      txt(['じー', 'じーっ', 'じーっ…'][dots - 1], bx + BW / 2, by + BH / 2 + 1, 30, '#3a2b2b');
      ctx.restore();
    }
  }
  // While a cat stares at the camera: dim the rest of the table (spotlight on cat + item),
  // and run a countdown ring around the item = how long the player has left.
  var spotMask = { cv: null, cx: null };
  function drawStareFx(t) {
    var list = [], amt = 0, i, c, n = 0;
    for (i = 0; i < G.cats.length; i++) {
      c = G.cats[i];
      if (!c.dead && !c.leaving) n++;
      if (!c.dead && c.stare > 0.02) { list.push(c); amt = Math.max(amt, c.stare); }
    }
    if (!list.length) return;
    amt /= Math.pow(Math.max(1, n), CONFIG.fx.stareDimCrowd);
    var F = CONFIG.fx, x0 = view.x0 - 80, y0 = view.y0 - 80, w = view.x1 - view.x0 + 160, h = view.y1 - view.y0 + 160, k = 0.25;
    try {
      if (!spotMask.cv) { spotMask.cv = document.createElement('canvas'); spotMask.cx = spotMask.cv.getContext('2d'); }
      var cw = Math.max(1, Math.ceil(w * k)), ch = Math.max(1, Math.ceil(h * k)), o = spotMask.cx;
      if (spotMask.cv.width !== cw || spotMask.cv.height !== ch) { spotMask.cv.width = cw; spotMask.cv.height = ch; }
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.globalCompositeOperation = 'source-over';
      o.clearRect(0, 0, cw, ch);
      o.fillStyle = 'rgba(14,8,22,' + (F.stareDim * amt) + ')';
      o.fillRect(0, 0, cw, ch);
      o.globalCompositeOperation = 'destination-out';
      for (i = 0; i < list.length; i++) {
        c = list[i];
        var it = c.target && c.target.state === 'table' ? c.target : null;
        var px = it ? (c.x + it.x) / 2 : c.x, py = (it ? (c.y + it.y) / 2 : c.y) - 10;
        var r = F.stareSpot * k, gx = (px - x0) * k, gy = (py - y0) * k;
        var gr = o.createRadialGradient(gx, gy, r * 0.5, gx, gy, r);
        gr.addColorStop(0, 'rgba(0,0,0,' + c.stare + ')'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        o.fillStyle = gr; o.beginPath(); o.arc(gx, gy, r, 0, TAU); o.fill();
      }
      o.globalCompositeOperation = 'source-over';
      ctx.drawImage(spotMask.cv, x0, y0, w, h);
    } catch (e) { /* the spotlight is decoration only */ }
    for (i = 0; i < list.length; i++) drawStareBubble(list[i]);
    for (i = 0; i < list.length; i++) {
      c = list[i];
      var tg = c.target;
      if (c.state !== 'stare' || !tg || tg.state !== 'table') continue;
      var left = clamp(1 - c.st / c.def.stareTime, 0, 1), rr0 = itemRadius(tg) + 18 + Math.sin(t * 16) * 2;
      ctx.save();
      ctx.globalAlpha = c.stare;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(40,10,20,0.55)'; ctx.lineWidth = 12;
      ctx.beginPath(); ctx.arc(tg.x, tg.y, rr0, 0, TAU); ctx.stroke();
      ctx.strokeStyle = left < 0.35 ? '#ff3b3b' : '#ffd166'; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.arc(tg.x, tg.y, rr0, -Math.PI / 2, -Math.PI / 2 + TAU * left); ctx.stroke();
      ctx.restore();
    }
  }
  // デブ猫 in the air: show where it will land and how far the shove reaches
  function drawLandingMarks(t) {
    for (var i = 0; i < G.cats.length; i++) {
      var c = G.cats[i], j = c.jump;
      if (c.dead || c.state !== 'jump' || !j || j.onLand !== 'landed' || !c.def.shoveRadius) continue;
      var p = clamp(j.t / j.dur, 0, 1), R = catR(c);
      ctx.save();
      ellipse(j.tx + 4, j.ty + 8, R * (0.4 + 0.8 * p), R * (0.3 + 0.6 * p), 0, 'rgba(20,0,0,' + (0.15 + 0.3 * p) + ')');
      ctx.globalAlpha = 0.35 + 0.35 * Math.abs(Math.sin(t * 10));
      ctx.setLineDash([16, 14]); ctx.lineDashOffset = -t * 40;
      ctx.strokeStyle = '#d6333f'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(j.tx, j.ty, c.def.shoveRadius * (0.55 + 0.45 * easeOutCubic(p)), 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // ---- fx ------------------------------------------------------------------------------------
  function drawParticles() {
    for (var i = 0; i < G.particles.length; i++) {
      var p = G.particles[i], q = p.t / p.life;
      ctx.save();
      switch (p.kind) {
        case 'shard':
          ctx.globalAlpha = p.t > p.life - 0.5 ? (p.life - p.t) / 0.5 : 1;
          ctx.translate(p.x, p.y); ctx.rotate(p.rot || 0);
          ctx.beginPath(); ctx.moveTo(-p.size * 0.6, -p.size * 0.4); ctx.lineTo(p.size * 0.7, -p.size * 0.1); ctx.lineTo(-p.size * 0.1, p.size * 0.6); ctx.closePath();
          ctx.fillStyle = p.color; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke();
          break;
        case 'dust': case 'smoke':
          ctx.globalAlpha = (1 - q) * 0.8;
          circ(p.x, p.y, p.size * (1 + q * 1.4), p.color);
          break;
        case 'star':
          ctx.globalAlpha = 1 - q * q;
          ctx.fillStyle = p.color; star(p.x, p.y, p.size * (1 - q * 0.3), 5, 0.45); ctx.fill();
          break;
        case 'spark':
          ctx.globalAlpha = 1 - q;
          circ(p.x, p.y, p.size * (1 - q * 0.5), p.color);
          break;
        case 'ripple':
          ctx.globalAlpha = 1 - q;
          circ(p.x, p.y, p.size + q * 30, null, p.color, 3);
          break;
      }
      ctx.restore();
    }
  }
  function drawPopups() {
    for (var i = 0; i < G.popups.length; i++) {
      var p = G.popups[i], q = p.t / p.life;
      if (p.t < 0) continue;   // delayed popup (comic timing)
      var sIn = easeOutBack(clamp(p.t / 0.2, 0, 1)) * p.pop;
      var s = lerp(sIn, 1, clamp((p.t - 0.2) / 0.2, 0, 1) * (p.pop > 1 ? 1 : 0)) || sIn;
      var a = q < 0.7 ? 1 : 1 - (q - 0.7) / 0.3;
      ctx.save();
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.translate(p.x, p.y - p.rise * easeOutCubic(q));
      ctx.rotate(p.rot);
      ctx.scale(Math.max(0.01, s), Math.max(0.01, s));
      txt(p.text, 0, 0, p.size, p.color, { stroke: p.stroke, strokeW: Math.max(4, p.size * 0.22) });
      ctx.restore();
    }
  }
  function powerColor(p) {
    if (p < 0.5) return 'rgb(' + Math.round(lerp(123, 255, p * 2)) + ',' + Math.round(lerp(211, 209, p * 2)) + ',' + Math.round(lerp(137, 102, p * 2)) + ')';
    return 'rgb(255,' + Math.round(lerp(209, 107, (p - 0.5) * 2)) + ',' + Math.round(lerp(102, 90, (p - 0.5) * 2)) + ')';
  }
  function drawArrow(x, y, nx, ny, r0, len, col, alpha) {
    var ex = x + nx * len, ey = y + ny * len, head = 30;
    var bx = ex - nx * head, by = ey - ny * head, px = -ny, py = nx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(40,25,30,0.55)'; ctx.lineWidth = 22;
    ctx.beginPath(); ctx.moveTo(x + nx * r0, y + ny * r0); ctx.lineTo(bx, by); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = 14;
    ctx.beginPath(); ctx.moveTo(x + nx * r0, y + ny * r0); ctx.lineTo(bx, by); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(bx + px * 22, by + py * 22); ctx.lineTo(bx - px * 22, by - py * 22); ctx.closePath();
    ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = 'rgba(40,25,30,0.55)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.restore();
  }
  function drawDrags(t) {
    var F = CONFIG.flick;
    for (var k in G.drags) {
      var d = G.drags[k], it = d.item;
      if (it.state !== 'table') continue;
      var r = itemRadius(it) + 12 + Math.sin(t * 10) * 2;
      circ(it.x, it.y, r, null, 'rgba(255,255,255,0.95)', 4);
      var dx = d.x - d.sx, dy = d.y - d.sy, len = hypot(dx, dy);
      if (len < F.minDrag) continue;
      var p = Math.min(len / F.maxDrag, 1), nx = dx / len, ny = dy / len, col = powerColor(p);
      ctx.strokeStyle = col; ctx.lineWidth = 7; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(it.x, it.y, r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * p); ctx.stroke();
      if (F.showLanding) {
        var L = slideDist(flickSpeed(p), it.def.frictionAir), lx = it.x + nx * L, ly = it.y + ny * L;
        var off = lx < T.x || lx > TR || ly < T.y || ly > TB;
        ctx.save();
        ctx.setLineDash([10, 12]); ctx.lineWidth = 3;
        ctx.strokeStyle = off ? 'rgba(255,80,80,0.55)' : 'rgba(255,255,255,0.4)';
        ctx.beginPath(); ctx.moveTo(it.x, it.y); ctx.lineTo(lx, ly); ctx.stroke();
        ctx.setLineDash([]);
        circ(lx, ly, 12, off ? 'rgba(255,80,80,0.25)' : 'rgba(255,255,255,0.18)', off ? 'rgba(255,80,80,0.8)' : 'rgba(255,255,255,0.6)', 3);
        if (off) txt('落ちる!', clamp(lx, T.x + 60, TR - 60), clamp(ly, T.y + 30, TB - 30) - 30, 26, '#ffffff', { stroke: '#d6333f' });
        ctx.restore();
      }
      drawArrow(it.x, it.y, nx, ny, itemRadius(it) + 6, itemRadius(it) + 20 + Math.min(len, F.maxDrag) * F.arrowScale, col, 0.95);
    }
  }
  // a cartoon pointing hand; the fingertip is at (x, y)
  function drawPointer(x, y, s, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y); ctx.rotate(-0.42); ctx.scale(s, s);
    ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = '#3b2f45'; ctx.fillStyle = '#ffffff';
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; rr(-4, 48, 58, 56, 20); ctx.fill();
    ctx.fillStyle = '#ffffff';
    rr(8, 34, 16, 30, 8); ctx.fill(); ctx.stroke();
    rr(21, 38, 16, 28, 8); ctx.fill(); ctx.stroke();
    rr(33, 44, 14, 24, 7); ctx.fill(); ctx.stroke();
    rr(-12, 44, 58, 54, 20); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.translate(-8, 66); ctx.rotate(-0.7); rr(-8, -26, 17, 34, 8.5); ctx.fill(); ctx.stroke(); ctx.restore();
    rr(-10, 0, 20, 66, 10); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(59,47,69,0.35)'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(-5, 20); ctx.lineTo(5, 20); ctx.stroke();
    ctx.restore();
  }
  // which item the tutorial points at: the one a cat is after (most urgent first), else the one nearest an edge
  function hintTarget() {
    var best = null, bestS = Infinity, threat = false, i;
    for (i = 0; i < G.cats.length; i++) {
      var c = G.cats[i], it = c.target;
      if (c.dead || !it || it.state !== 'table' || it.spawnT < CONFIG.itemSpawn.dropTime) continue;
      if (c.state !== 'walk' && c.state !== 'sit' && c.state !== 'push' && c.state !== 'stare') continue;
      var sc = nearestEdge(it.x, it.y).d - (c.state === 'push' || c.state === 'stare' ? 1000 : 0);
      if (sc < bestS) { bestS = sc; best = it; threat = c.state === 'push' || c.state === 'stare'; }
    }
    if (best) return { it: best, threat: threat };
    for (i = 0; i < G.items.length; i++) {
      var o = G.items[i];
      if (!onTable(o) || o.spawnT < CONFIG.itemSpawn.dropTime) continue;
      var d = nearestEdge(o.x, o.y).d;
      if (d < bestS) { bestS = d; best = o; }
    }
    return best ? { it: best, threat: false } : null;
  }
  // First-run coaching: a ghost hand drags the item toward the middle, with a two-line caption.
  // Shown until the player's first flick in this run.
  function drawHint(t) {
    if (G.screen !== 'play' || G.stats.flicks > 0 || G.time > CONFIG.tutorial.hintUntil || Object.keys(G.drags).length) return;
    var h = hintTarget();
    if (!h) return;
    var it = h.it, F = CONFIG.flick;
    var dx = TCX - it.x, dy = TCY - it.y, d = hypot(dx, dy) || 1, nx = dx / d, ny = dy / d;
    var cyc = (G.realTime % CONFIG.tutorial.hintCycle) / CONFIG.tutorial.hintCycle;
    var press = clamp(cyc / 0.15, 0, 1), dp = clamp((cyc - 0.18) / 0.47, 0, 1);
    dp = dp < 0.5 ? 2 * dp * dp : 1 - Math.pow(-2 * dp + 2, 2) / 2;
    var len = 150 * dp, a = cyc < 0.82 ? 1 : 1 - (cyc - 0.82) / 0.18;
    var r = itemRadius(it) + 12 + Math.sin(t * 10) * 2;
    ctx.save(); ctx.globalAlpha = 0.9 * a;
    circ(it.x, it.y, r, null, h.threat ? '#ff6b6b' : '#ffffff', 5);
    ctx.restore();
    if (len > 10) drawArrow(it.x, it.y, nx, ny, itemRadius(it) + 6, itemRadius(it) + 20 + len * F.arrowScale, 'rgba(255,255,255,0.95)', 0.75 * a);
    var fx = it.x + nx * len, fy = it.y + ny * len, lift = cyc > 0.65 ? clamp((cyc - 0.65) / 0.15, 0, 1) : 0;
    if (cyc < 0.65 && press > 0.6) { ctx.save(); ctx.globalAlpha = 0.6 * a; circ(fx, fy, 16 + 6 * Math.sin(t * 12), 'rgba(255,255,255,0.35)', '#ffffff', 3); ctx.restore(); }
    drawPointer(fx + 6 * lift, fy + 4 - 26 * lift + (1 - press) * 40, 1.05 - 0.08 * press * (1 - lift), (cyc < 0.15 ? press : 1) * a);
    // caption at the far end of the table from the item, so it covers neither the demo nor the cat going for it
    var cy = it.y > TCY ? T.y + 78 : TB - 78;
    var l1 = h.threat ? 'ネコが落とそうとしてる!' : 'ドラッグで はじく!';
    var l2 = h.threat ? 'ドラッグで はじいて 戻そう' : 'ネコが落とす前に 真ん中へ戻そう';
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(TCX - 290, cy - 62 + 6, 580, 124, 34); ctx.fill();
    ctx.fillStyle = h.threat ? 'rgba(150,30,45,0.94)' : 'rgba(43,36,48,0.92)'; rr(TCX - 290, cy - 62, 580, 124, 34); ctx.fill();
    txt(l1, TCX, cy - 20, 42, '#ffffff', { stroke: h.threat ? '#7a1020' : '#1f1924', strokeW: 6 });
    txt(l2, TCX, cy + 32, 26, '#ffd166');
    ctx.restore();
  }
  // Early-game coaching after the first flick: a label on items a cat is pushing over the edge
  // ("あぶない!", or "いまだ!" while the cat stares), until the player has made a rescue.
  function catTargeting(it) {
    for (var i = 0; i < G.cats.length; i++) { var c = G.cats[i]; if (!c.dead && c.target === it && (c.state === 'push' || c.state === 'stare')) return c; }
    return null;
  }
  function drawDangerLabels(t) {
    if (G.screen !== 'play' || G.stats.flicks === 0 || G.stats.safes > 0 || G.time > CONFIG.tutorial.dangerUntil) return;
    for (var i = 0; i < G.items.length; i++) {
      var it = G.items[i];
      if (!onTable(it) || it.overhang < 0.05 || isHeld(it)) continue;
      if (!it.catDanger && !catTargeting(it)) continue;
      var cat = catTargeting(it), now = staredAt(it), label = now ? 'いまだ!はじけ!' : 'あぶない!', w = now ? 214 : 148;
      // stay clear of the cat's "じーっ…" bubble (above the cat unless it is at the top edge)
      var bubbleBelow = cat && cat.y - catR(cat) * 2.1 - 27 < T.y - 24;
      var up = now ? (bubbleBelow ? -1 : 1) : (it.y > TB - 110 ? -1 : 1);
      var ly = clamp(it.y + up * (itemRadius(it) + 46), T.y + 30, TB + 10) + Math.sin(t * 8) * 4;
      var lx = clamp(it.x, T.x + w / 2 + 6, TR - w / 2 - 6);
      ctx.save();
      ctx.fillStyle = now ? '#ff3b3b' : '#d6333f'; rr(lx - w / 2, ly - 24, w, 48, 24); ctx.fill();
      ctx.beginPath(); ctx.moveTo(lx - 10, ly - up * 22); ctx.lineTo(lx + clamp(it.x - lx, -40, 40) * 0.3, ly - up * 38); ctx.lineTo(lx + 10, ly - up * 22); ctx.fill();
      txt(label, lx, ly + 1, 28, '#ffffff');
      ctx.restore();
    }
  }
  function staredAt(it) { for (var i = 0; i < G.cats.length; i++) if (G.cats[i].target === it && G.cats[i].state === 'stare') return true; return false; }
  // the stretch of table edge an item is hanging over glows red
  function drawEdgeWarnings(t) {
    for (var i = 0; i < G.items.length; i++) {
      var it = G.items[i];
      if (it.state !== 'table' || it.overhang < 0.04) continue;
      var o = Math.min(1, it.overhang * 2.5), a = (0.35 + 0.45 * o) * (0.65 + 0.35 * Math.sin(t * (12 + 8 * o)));
      var L = itemRadius(it) + 50;
      ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = '#ff3b3b';
      if (it.edgeNx) rr(it.edgeNx > 0 ? TR - 8 : T.x, it.y - L, 8, L * 2, 4);
      else rr(it.x - L, it.edgeNy > 0 ? TB - 8 : T.y, L * 2, 8, 4);
      ctx.fill(); ctx.restore();
    }
  }

  // ---- HUD -------------------------------------------------------------------------------------
  function drawMuteButton() {
    var m = UI.mute, muted = Sfx.isMuted();
    circ(m.x, m.y, m.r, 'rgba(255,255,255,0.12)', 'rgba(255,255,255,0.35)', 2);
    ctx.save(); ctx.translate(m.x - 4, m.y);
    ctx.fillStyle = '#fff7e8';
    ctx.beginPath(); ctx.moveTo(-12, -6); ctx.lineTo(-5, -6); ctx.lineTo(4, -14); ctx.lineTo(4, 14); ctx.lineTo(-5, 6); ctx.lineTo(-12, 6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = muted ? '#ff6b5a' : '#fff7e8'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    if (muted) { ctx.beginPath(); ctx.moveTo(10, -7); ctx.lineTo(22, 7); ctx.moveTo(22, -7); ctx.lineTo(10, 7); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(6, 0, 8, -0.8, 0.8); ctx.stroke(); ctx.beginPath(); ctx.arc(6, 0, 15, -0.8, 0.8); ctx.stroke(); }
    ctx.restore();
  }
  function drawBreakSlot(x, y, broken, pop) {
    var s = 1 + pop * 0.35;
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    if (broken) {
      circ(0, 0, 22, '#ff6b5a', '#ffffff', 3);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(-3, -20); ctx.lineTo(4, -6); ctx.lineTo(-4, 2); ctx.lineTo(5, 10); ctx.lineTo(0, 20); ctx.stroke();
    } else {
      circ(0, 0, 22, 'rgba(255,255,255,0.9)', '#d4cab9', 3);
      circ(0, 0, 14, null, '#ebe3d3', 2);
    }
    ctx.restore();
  }
  function drawTreatButton(t) {
    var b = UI.treat, tr = G.treat, avail = !tr.used;
    ctx.save();
    ctx.globalAlpha = avail || tr.active ? 1 : 0.45;
    var lit = avail || tr.active;
    ctx.fillStyle = lit ? '#b3466b' : '#4a3f52'; rr(b.x, b.y + 8, b.w, b.h, 28); ctx.fill();
    var pulse = avail ? 1 + Math.sin(t * 4) * 0.015 : 1;
    ctx.translate(b.x + b.w / 2, b.y + b.h / 2); ctx.scale(pulse, pulse); ctx.translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
    ctx.fillStyle = avail ? '#ff8fb1' : tr.active ? '#d9739a' : '#6a5d73'; rr(b.x, b.y, b.w, b.h, 28); ctx.fill();
    ellipse(b.x + 54, b.y + b.h / 2, 26, 15, -0.2, '#ff9b52', '#c56a2a', 3);
    ctx.fillStyle = '#ff9b52'; ctx.beginPath(); ctx.moveTo(b.x + 30, b.y + b.h / 2 + 4); ctx.lineTo(b.x + 18, b.y + b.h / 2 - 12); ctx.lineTo(b.x + 18, b.y + b.h / 2 + 16); ctx.closePath(); ctx.fill();
    circ(b.x + 66, b.y + b.h / 2 - 5, 3, '#3a2b2b');
    if (tr.active) {
      var left = Math.max(0, CONFIG.treat.duration - tr.t);
      txt('夢中… ' + left.toFixed(1), b.x + 188, b.y + 40, 32, '#ffffff');
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; rr(b.x + 104, b.y + 70, 168, 14, 7); ctx.fill();
      ctx.fillStyle = '#ffffff'; rr(b.x + 104, b.y + 70, 168 * left / CONFIG.treat.duration, 14, 7); ctx.fill();
    } else if (avail) {
      txt('おやつ', b.x + 188, b.y + 42, 40, '#ffffff', { stroke: '#b3466b', strokeW: 6 });
      txt('10秒ネコ足止め(1回)', b.x + 188, b.y + 84, 21, '#fff3f7');
    } else {
      txt('おやつ済み', b.x + 186, b.y + b.h / 2, 30, '#d8cfe0');
    }
    ctx.restore();
  }
  function drawHUD(t) {
    txt('じかん', 40, 40, 24, '#bfb2cc', { align: 'left' });
    txt(G.time.toFixed(1) + '秒', 40, 86, 42, '#fff7e8', { align: 'left' });
    txt('スコア', VW / 2, 40, 24, '#bfb2cc');
    var ss = 1 + 0.18 * easeOutCubic(G.scorePop);
    ctx.save(); ctx.translate(VW / 2, 92); ctx.scale(ss, ss);
    txt(fmt(G.score), 0, 0, 56, '#ffd166', { stroke: '#1f1924', strokeW: 8 });
    ctx.restore();
    txt('われた', 262, 152, 24, '#bfb2cc', { align: 'right' });
    for (var i = 0; i < CONFIG.breaksToLose; i++) drawBreakSlot(300 + i * 60, 152, i < G.breaks, i === G.breaks - 1 ? G.breakPop : 0);
    drawMuteButton();
    drawTreatButton(t);
    var catsOn = 0;
    for (var j = 0; j < G.cats.length; j++) if (!G.cats[j].dead && !G.cats[j].leaving) catsOn++;
    txt('ネコ ' + catsOn + '匹', 690, 1160, 26, '#bfb2cc', { align: 'right' });
    txt('物 ' + countOnTable() + '個', 690, 1200, 26, '#bfb2cc', { align: 'right' });
  }
  function bannerSub(b) {
    if (!b) return null;
    if (b.kind !== 'warn' || G.screen !== 'play') return b.sub;
    // warned = counting down to G.gather.next; once the gather starts, next jumps 45 s ahead
    var left = G.gather.warned ? Math.ceil(G.gather.next - G.time) : 0;
    return left > 0 ? 'あと ' + left + ' 秒で' + CONFIG.gather.cats + '匹やってくる…!' : 'きたーっ!';
  }
  function drawBanner() {
    var b = G.banner;
    if (!b) return;
    var inP = clamp(b.t / 0.3, 0, 1), outP = clamp((b.t - (b.life - 0.3)) / 0.3, 0, 1);
    var s = easeOutBack(inP) * (1 - 0.2 * outP), a = 1 - outP;
    var col = b.kind === 'warn' ? '#d6333f' : b.kind === 'treat' ? '#c9507a' : b.kind === 'over' ? '#3b2f45' : '#4a3a5a';
    var sub = bannerSub(b);
    var y = b.y || 520, h = sub ? 150 : 110;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(VW / 2, y); ctx.scale(Math.max(0.01, s), Math.max(0.01, s));
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(-322, -h / 2 + 8, 644, h, 28); ctx.fill();
    ctx.fillStyle = col; rr(-322, -h / 2, 644, h, 28); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 4; rr(-312, -h / 2 + 10, 624, h - 20, 22); ctx.stroke();
    // long headlines shrink to fit inside the frame
    ctx.font = 'bold 58px ' + FONT;
    var hs = Math.min(58, 58 * 560 / Math.max(1, ctx.measureText(b.text).width));
    txt(b.text, 0, sub ? -24 : 0, hs, '#ffffff', { stroke: 'rgba(0,0,0,0.35)', strokeW: 8 });
    if (sub) txt(sub, 0, 38, 28, '#ffeef2');
    ctx.restore();
  }
  function drawToast() {
    var tt = G.toast;
    if (!tt) return;
    var a = tt.t < 0.2 ? tt.t / 0.2 : (tt.t > tt.life - 0.3 ? (tt.life - tt.t) / 0.3 : 1);
    ctx.save(); ctx.globalAlpha = clamp(a, 0, 1);
    ctx.fillStyle = 'rgba(20,16,24,0.92)'; rr(VW / 2 - 220, 1210, 440, 56, 28); ctx.fill();
    txt(tt.text, VW / 2, 1238, 26, '#ffffff');
    ctx.restore();
  }

  // ---- whole frame ---------------------------------------------------------------------------
  function drawScene(t) {
    drawTable();
    if (G.treat.active || G.treat.fade > 0) drawBowl(G.treat.active ? 1 : G.treat.fade);
    var i, held = {};
    for (var k in G.drags) held[G.drags[k].item.id] = true;
    drawEdgeWarnings(t);
    for (i = 0; i < G.items.length; i++) drawItemShadow(G.items[i]);
    for (i = 0; i < G.items.length; i++) if (G.items[i].state === 'falling') drawItem(G.items[i], t, false);
    for (i = 0; i < G.items.length; i++) if (G.items[i].state === 'table') drawItem(G.items[i], t, !!held[G.items[i].id]);
    drawLandingMarks(t);
    var cats = G.cats.slice().sort(function (a, b) { return (a.z > 5 ? 1 : 0) - (b.z > 5 ? 1 : 0) || a.y - b.y; });
    for (i = 0; i < cats.length; i++) drawCat(cats[i], t);
    drawStareFx(t);
    drawParticles();
    drawDangerLabels(t);
    drawHint(t);
    drawDrags(t);
    drawPopups();
  }
  function render() {
    var t = G.realTime;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2b2430';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var k = view.dpr * view.s;
    ctx.setTransform(k, 0, 0, k, view.ox * view.dpr, view.oy * view.dpr);
    var x0 = view.x0, y0 = view.y0, x1 = view.x1, y1 = view.y1;
    ctx.save();
    if (G.shake > 0 && !G.frozen) {
      var m = CONFIG.fx.shakeMax * G.shake * G.shake;
      ctx.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
      ctx.rotate((Math.random() * 2 - 1) * 0.01 * G.shake);
    }
    drawFloor(x0 - 40, y0 - 40, x1 + 40, y1 + 40);
    if (G.screen === 'title') { drawTitleScene(t); ctx.restore(); drawTitleUI(t); }
    else {
      drawScene(t);
      ctx.restore();
      if (G.flash > 0) { ctx.save(); ctx.globalAlpha = Math.min(1, G.flash); fillVisible(G.flashCol); ctx.restore(); }
      if (G.screen === 'play' || G.screen === 'over') { drawHUD(t); drawBanner(); }
      if (G.screen === 'result') drawResult(t);
    }
    drawToast();
  }

  // ==========================================================================
  // 9. Screens & UI
  // ==========================================================================
  // ---- title ------------------------------------------------------------------------------------
  function decorItem(type, x, y, angle, oh, nx, ny) {
    return { id: 0, type: type, def: CONFIG.items[type], body: null, x: x, y: y, angle: angle || 0, state: 'table',
      overhang: oh || 0, edgeNx: nx || 0, edgeNy: ny || 0, spawnT: 99, fallNx: 0, fallNy: 0 };
  }
  function buildDecor() {
    var tsubo = decorItem('tsubo', TR - 13, 880, 0, 0.32, 1, 0);
    var cat = {
      id: -1, type: 'normal', def: CONFIG.catTypes.normal, color: 'tora', x: TR - 13 - 37 - CONFIG.cat.radius * 1.05, y: 880, z: 0,
      face: 0, state: 'stare', st: 2, anim: 0, pawT: 0, stare: 1, smugT: 0, lookX: 0, lookY: 0, popT: 0, mood: 'normal', moving: false
    };
    var cat2 = {
      id: -2, type: 'kitten', def: CONFIG.catTypes.kitten, color: 'white', x: 170, y: 1010, z: 0,
      face: -2.4, state: 'push', st: 0, anim: 1.3, pawT: 0, stare: 0, smugT: 0, lookX: -0.6, lookY: -0.7, popT: 0, mood: 'normal', moving: false
    };
    G.decor = {
      items: [decorItem('plate', 175, 300), decorItem('phone', 520, 280, -0.4), decorItem('cup', T.x + 18, 1010 - 50, 0, 0.2, -1, 0),
        decorItem('cake', 300, 1000, 0.25), decorItem('vase', 560, 640), tsubo, decorItem('orange', 130, 700)],
      cats: [cat, cat2]
    };
  }
  function updateDecor(dt) {
    if (!G.decor) return;
    for (var i = 0; i < G.decor.cats.length; i++) {
      var c = G.decor.cats[i];
      c.anim += dt; c.st += dt;
      if (c.state === 'push' && (c.anim % 1.1) < dt) c.pawT = CONFIG.cat.pawTime;
      if (c.pawT > 0) c.pawT = Math.max(0, c.pawT - dt);
    }
  }
  function drawTitleScene(t) {
    if (!G.decor) buildDecor();
    drawTable();
    var i;
    for (i = 0; i < G.decor.items.length; i++) drawItemShadow(G.decor.items[i]);
    for (i = 0; i < G.decor.items.length; i++) drawItem(G.decor.items[i], t, false);
    for (i = 0; i < G.decor.cats.length; i++) drawCat(G.decor.cats[i], t);
    for (i = 0; i < G.decor.cats.length; i++) drawStareBubble(G.decor.cats[i]);
  }
  function drawTitleUI(t) {
    fillVisible('rgba(30,22,36,0.35)');
    // title card
    var bob = Math.sin(t * 2) * 4;
    ctx.save(); ctx.translate(0, bob);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(70, 214, 580, 300, 44); ctx.fill();
    ctx.fillStyle = '#fff7ea'; rr(70, 200, 580, 300, 44); ctx.fill();
    ctx.strokeStyle = '#f2a04e'; ctx.lineWidth = 6; rr(84, 214, 552, 272, 36); ctx.stroke();
    txt('ネコ、', 250, 290, 92, '#3b2f45');
    txt('それダメ!', 372, 412, 110, '#e9504f', { stroke: '#7a1f2a', strokeW: 10 });
    ctx.restore();
    // rule
    ctx.fillStyle = 'rgba(30,22,36,0.82)'; rr(60, 548, 600, 164, 28); ctx.fill();
    txt('ネコがテーブルの物を落とす前に、', VW / 2, 590, 30, '#fff7e8');
    txt('はじいて真ん中へ戻そう!', VW / 2, 634, 34, '#ffd166');
    txt('3つ割れたらおしまい。', VW / 2, 678, 26, '#e7dcef');
    // start
    var a = 0.55 + 0.45 * Math.abs(Math.sin(t * 2.6));
    ctx.save(); ctx.globalAlpha = a;
    txt('タップでスタート', VW / 2, 1182, 50, '#ffffff', { stroke: '#e9504f', strokeW: 10 });
    ctx.restore();
    if (G.best > 0) txt('ベスト ' + fmt(G.best) + '点' + (G.bestTime > 0 ? ' / ' + G.bestTime.toFixed(1) + '秒' : ''), VW / 2, 1244, 26, '#d8cfe0');
    drawMuteButton();
  }

  // ---- result ------------------------------------------------------------------------------------
  function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
  function drawHand(x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    var skin = '#ffd6b3', line = '#b5835a';
    for (var i = 0; i < 4; i++) { rr(-22 + i * 12, -34 + (i === 0 || i === 3 ? 8 : 0), 11, 30, 5.5); ctx.fillStyle = skin; ctx.fill(); ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke(); }
    rr(-24, -12, 50, 40, 14); ctx.fillStyle = skin; ctx.fill(); ctx.stroke();
    ctx.save(); ctx.translate(26, 4); ctx.rotate(-0.6); rr(-6, -18, 12, 26, 6); ctx.fillStyle = skin; ctx.fill(); ctx.stroke(); ctx.restore();
    ellipse(30, -26, 5, 8, 0.3, '#8fd0ff');
    ctx.restore();
  }
  function drawPhoto(entry, cx, cy, w, h, rot, idx) {
    var rng = makeRng(entry.seed || hashStr(entry.type + idx));
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(-w / 2 + 5, -h / 2 + 8, w, h, 6); ctx.fill();
    ctx.fillStyle = '#fffdf7'; rr(-w / 2, -h / 2, w, h, 6); ctx.fill();
    var pw = w - 20, px = -pw / 2, py = -h / 2 + 10;
    ctx.save();
    rr(px, py, pw, pw, 3); ctx.clip();
    ctx.fillStyle = '#3a3040'; ctx.fillRect(px, py, pw, pw);
    ctx.fillStyle = '#ead6b0'; ctx.fillRect(px, py, pw * 0.28, pw);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(px + pw * 0.28, py, 8, pw);
    var d = CONFIG.items[entry.type];
    for (var i = 0; i < 14; i++) {
      var sx = px + pw * rng.range(0.35, 0.95), sy = py + pw * rng.range(0.15, 0.95), ss = rng.range(5, 11);
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(rng.range(0, TAU));
      ctx.beginPath(); ctx.moveTo(-ss * 0.6, -ss * 0.4); ctx.lineTo(ss * 0.7, -ss * 0.1); ctx.lineTo(-ss * 0.1, ss * 0.6); ctx.closePath();
      ctx.fillStyle = rng() < 0.6 ? d.colors[0] : d.colors[1]; ctx.fill(); ctx.restore();
    }
    // the broken item, split in two
    var ix = px + pw * 0.6, iy = py + pw * 0.58, sc = 0.95;
    for (var half = -1; half <= 1; half += 2) {
      ctx.save();
      ctx.translate(ix + half * 6, iy + half * 2); ctx.rotate(half * 0.12);
      ctx.beginPath();
      if (half < 0) { ctx.moveTo(-80, -80); ctx.lineTo(4, -80); ctx.lineTo(-6, -20); ctx.lineTo(6, 6); ctx.lineTo(-4, 30); ctx.lineTo(2, 80); ctx.lineTo(-80, 80); }
      else { ctx.moveTo(80, -80); ctx.lineTo(4, -80); ctx.lineTo(-6, -20); ctx.lineTo(6, 6); ctx.lineTo(-4, 30); ctx.lineTo(2, 80); ctx.lineTo(80, 80); }
      ctx.closePath(); ctx.clip();
      ctx.scale(sc, sc);
      ART[entry.type](d, 0);
      ctx.restore();
    }
    // culprit, smug
    var cp = entry.culprit || {};
    if (cp.kind === 'player') {
      drawHand(px + pw * 0.24, py + pw * 0.3, 0.9);
    } else {
      ctx.save(); ctx.translate(px + pw * 0.26, py + pw * 0.3); ctx.scale(0.95, 0.95);
      drawCatHead(cp.color || 'tora', { mood: 'smug', ninja: cp.ctype === 'ninja' });
      ctx.restore();
      txt('ドヤッ', px + pw * 0.62, py + pw * 0.14, 22, '#ffd166', { stroke: '#3a2b2b', strokeW: 5 });
    }
    ctx.restore();
    if (d.breakValue > 1) {
      circ(-w / 2 + 22, -h / 2 + 22, 22, '#d6333f', '#ffffff', 3);
      txt('×' + d.breakValue, -w / 2 + 22, -h / 2 + 22, 20, '#ffffff');
    }
    txt(d.name, 0, py + pw + 26, 26, '#3b2f45');
    txt('犯人: ' + (cp.name || '?'), 0, py + pw + 56, 19, cp.kind === 'player' ? '#d6333f' : '#7a6a84');
    ctx.restore();
  }
  function mainCulprit(broken) {
    var count = {}, best = null, bc = 0;
    for (var i = 0; i < broken.length; i++) {
      var n = (broken[i].culprit && broken[i].culprit.name) || '?';
      count[n] = (count[n] || 0) + 1;
      if (count[n] > bc) { bc = count[n]; best = n; }
    }
    return { name: best, count: bc };
  }
  function drawButton(b, label, size, fill, dark, pressed) {
    var oy = pressed ? 6 : 0;
    ctx.fillStyle = dark; rr(b.x, b.y + 8, b.w, b.h, b.h / 2); ctx.fill();
    ctx.fillStyle = fill; rr(b.x, b.y + oy, b.w, b.h, b.h / 2); ctx.fill();
    txt(label, b.x + b.w / 2, b.y + b.h / 2 + oy, size, '#ffffff', { stroke: dark, strokeW: 6 });
  }
  function drawResult(t) {
    var r = G.result;
    if (!r) return;
    var p = easeOutCubic(clamp(G.resultT / 0.45, 0, 1));
    ctx.save();
    fillVisible('rgba(30,22,36,' + (0.86 * p) + ')');
    ctx.translate(0, (1 - p) * 60);
    ctx.globalAlpha = p;
    // the game's name stays in every screenshot that gets shared
    drawMiniLogo(VW / 2, 58);
    txt(CONFIG.breaksToLose + 'つ割れちゃった…', VW / 2, 126, 30, '#e7dcef');
    txt(r.time.toFixed(1) + '秒 耐えた!', VW / 2, 192, 76, '#ffffff', { stroke: '#e9504f', strokeW: 10 });
    // 称号 ribbon (stamps in a moment after the screen appears)
    var rk = r.rank || rankFor(r), rp = clamp((G.resultT - 0.35) / 0.3, 0, 1);
    if (rp > 0) {
      ctx.save(); ctx.translate(VW / 2, 268);
      var rs = 1 + 0.6 * (1 - easeOutBack(rp)); ctx.scale(rs, rs); ctx.rotate(-0.02);
      ctx.font = 'bold 34px ' + FONT;
      var rw = Math.max(300, ctx.measureText('称号  ' + rk).width + 70);
      ctx.fillStyle = '#b8862a';
      ctx.beginPath(); ctx.moveTo(-rw / 2 - 26, -18); ctx.lineTo(-rw / 2 + 4, -18); ctx.lineTo(-rw / 2 + 4, 30); ctx.lineTo(-rw / 2 - 26, 30); ctx.lineTo(-rw / 2 - 12, 6); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(rw / 2 + 26, -18); ctx.lineTo(rw / 2 - 4, -18); ctx.lineTo(rw / 2 - 4, 30); ctx.lineTo(rw / 2 + 26, 30); ctx.lineTo(rw / 2 + 12, 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffd166'; rr(-rw / 2, -28, rw, 52, 10); ctx.fill();
      ctx.strokeStyle = 'rgba(122,74,10,0.6)'; ctx.lineWidth = 3; rr(-rw / 2 + 6, -22, rw - 12, 40, 7); ctx.stroke();
      ctx.font = 'bold 22px ' + FONT;
      var lw = ctx.measureText('称号').width;
      ctx.font = 'bold 34px ' + FONT;
      var nw = ctx.measureText(rk).width, sx0 = -(lw + 14 + nw) / 2;
      txt('称号', sx0, -1, 22, '#8a5a12', { align: 'left' });
      txt(rk, sx0 + lw + 14, -2, 34, '#3b2410', { align: 'left' });
      ctx.restore();
    }
    txt('スコア ' + fmt(r.score), VW / 2, 340, 46, '#ffd166', { stroke: '#1f1924', strokeW: 7 });
    txt('ベスト ' + fmt(r.best) + '  /  ' + r.bestTime.toFixed(1) + '秒', VW / 2, 386, 24, '#d8cfe0');
    if (r.newBest) {
      ctx.save(); ctx.translate(VW / 2 + 232, 326); ctx.rotate(0.18 + Math.sin(t * 6) * 0.05);
      ctx.fillStyle = '#e9504f'; rr(-58, -24, 116, 48, 24); ctx.fill();
      txt('NEW!', 0, 1, 28, '#ffffff');
      ctx.restore();
    }
    // crime scene board
    ctx.save(); ctx.translate(0, 22);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(30, 404, 660, 430, 26); ctx.fill();
    ctx.fillStyle = '#c99d64'; rr(30, 396, 660, 430, 26); ctx.fill();
    ctx.fillStyle = '#b88a52';
    for (var i = 0; i < 40; i++) { var hx = 50 + ((i * 97) % 620), hy = 414 + ((i * 61) % 390); ctx.fillRect(hx, hy, 3, 3); }
    ctx.save(); ctx.translate(VW / 2, 426); ctx.rotate(-0.02);
    ctx.fillStyle = '#ffd23f'; ctx.fillRect(-190, -24, 380, 48);
    ctx.fillStyle = '#2a2230';
    for (var s = 0; s < 8; s++) { ctx.beginPath(); ctx.moveTo(-190 + s * 50, -24); ctx.lineTo(-170 + s * 50, -24); ctx.lineTo(-190 + s * 50 + 4, 24); ctx.lineTo(-210 + s * 50 + 4, 24); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = '#ffd23f'; rr(-110, -20, 220, 40, 6); ctx.fill();
    txt('事件現場', 0, 1, 30, '#2a2230');
    ctx.restore();
    var n = r.broken.length, pw = 192, ph = 252, gap = 22, total = n * pw + (n - 1) * gap;
    var rots = [-0.06, 0.035, -0.025];
    for (var j = 0; j < n; j++) {
      var cx = VW / 2 - total / 2 + pw / 2 + j * (pw + gap);
      drawPhoto(r.broken[j], cx, 614, pw, ph, rots[j % 3], j);
      circ(cx, 614 - ph / 2 + 4, 8, '#d6333f', '#7a1f2a', 2);
    }
    if (n === 0) txt('(何も割れていない…?)', VW / 2, 614, 28, '#3b2f45');
    var mc = mainCulprit(r.broken);
    var line = !mc.name ? '' : mc.name === 'あなた' ? '主犯:あなた…?(ネコは無罪)' : '主犯:' + mc.name + (mc.count > 1 ? '(' + mc.count + '件)' : '') + ' ― 反省の色なし';
    if (line) txt(line, VW / 2, 790, 28, '#3b2a1a');
    ctx.restore();
    // what you did about it
    var st = r.stats || { safes: 0, catHits: 0, flicks: 0 };
    txt('セーフ! ×' + st.safes + '    ニャッ! ×' + st.catHits + '    はじいた ' + st.flicks + '回', VW / 2, 880, 26, '#e7dcef');
    // buttons
    if (G.resultT > CONFIG.resultInputDelay * 0.6) {
      drawButton(UI.retry, 'もう一回', 50, '#e9504f', '#9b2f37', G.pressed === 'retry');
      drawButton(UI.share, 'シェア', 36, '#4c78c8', '#2f4f8a', G.pressed === 'share');
    }
    txt('#ネコそれダメ', VW / 2, 1190, 24, 'rgba(231,220,239,0.7)');
    ctx.restore();
    drawMuteButton();
  }
  function drawMiniLogo(x, y) {
    ctx.save();
    ctx.font = 'bold 34px ' + FONT;
    var w1 = ctx.measureText('ネコ、').width, w2 = ctx.measureText('それダメ!').width, w = w1 + w2 + 44;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(x - w / 2, y - 26 + 5, w, 52, 26); ctx.fill();
    ctx.fillStyle = '#fff7ea'; rr(x - w / 2, y - 26, w, 52, 26); ctx.fill();
    ctx.strokeStyle = '#f2a04e'; ctx.lineWidth = 3; rr(x - w / 2 + 5, y - 21, w - 10, 42, 21); ctx.stroke();
    txt('ネコ、', x - (w1 + w2) / 2, y + 1, 34, '#3b2f45', { align: 'left' });
    txt('それダメ!', x - (w1 + w2) / 2 + w1, y + 1, 34, '#e9504f', { align: 'left' });
    ctx.restore();
  }
  function shareText() {
    var r = G.result || { time: G.time, score: G.score };
    var rk = G.result ? (G.result.rank || rankFor(G.result)) : null;
    return 'ネコ、それダメ!で' + r.time.toFixed(1) + '秒耐えた… ' + (rk ? '称号「' + rk + '」 ' : '') + 'スコア' + fmt(r.score) + ' #ネコそれダメ';
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }
  function copyText(text) {
    var done = function (ok) { toast(ok ? 'コピーしました!貼りつけてシェアしてね' : 'コピーできませんでした'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
        return;
      }
    } catch (e) { /* fall through */ }
    done(legacyCopy(text));
  }
  function shareResult() {
    var text = shareText(), url = '';
    try { if (/^https?:$/.test(window.location.protocol)) url = window.location.origin + window.location.pathname; } catch (e) { /* ignore */ }
    try {
      if (navigator.share) {
        var data = url ? { text: text, url: url } : { text: text };
        var pr = navigator.share(data);
        if (pr && pr.then) pr.then(function () { toast('シェアしました!'); }, function (err) { if (!err || err.name !== 'AbortError') copyText(text + (url ? ' ' + url : '')); });
        return;
      }
    } catch (e) { /* fall back to copy */ }
    copyText(text + (url ? ' ' + url : ''));
  }

  // ==========================================================================
  // 10. Main loop — fixed timestep update, rAF render
  // ==========================================================================
  var lastFrame = 0, acc = 0;
  function frame(now) {
    window.requestAnimationFrame(frame);
    if (!lastFrame) lastFrame = now;
    var dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0.25) dt = 0.25;
    // moving the window to a screen with another pixel ratio does not always fire 'resize'
    if (Math.min(window.devicePixelRatio || 1, 3) !== view.dpr) resize();
    if (!G.frozen && !TEST_MODE) {
      acc += dt;
      var n = 0;
      while (acc >= STEP && n < CONFIG.maxStepsPerFrame) { update(STEP); acc -= STEP; n++; }
      if (n >= CONFIG.maxStepsPerFrame) acc = 0;
    }
    try { render(); } catch (e) { reportError(e); }
  }

  // ==========================================================================
  // 11. Test hooks
  // ==========================================================================
  function exportState() {
    return {
      screen: G.screen, seed: G.seed, frame: G.frame, time: round(G.time, 3), score: G.score, breaks: G.breaks,
      best: G.best, bestTime: round(G.bestTime, 2), muted: Sfx.isMuted(), frozen: G.frozen,
      desiredCats: desiredCats(G.time), phase: G.phaseIdx,
      treat: { used: G.treat.used, active: G.treat.active, t: round(G.treat.t, 2) },
      gather: { next: G.gather.next, warned: G.gather.warned, until: round(G.gather.until, 2), active: G.time < G.gather.until },
      items: G.items.map(function (it) {
        var v = it.body && it.state === 'table' ? M.Body.getVelocity(it.body) : { x: it.vx, y: it.vy };
        return { id: it.id, type: it.type, state: it.state, x: round(it.x, 2), y: round(it.y, 2), vx: round(v.x, 3), vy: round(v.y, 3),
          speed: round(hypot(v.x, v.y), 3), overhang: round(it.overhang, 3), held: isHeld(it), culprit: it.lastToucher ? it.lastToucher.name : null };
      }),
      cats: G.cats.filter(function (c) { return !c.dead; }).map(function (c) {
        return { id: c.id, type: c.type, color: c.color, name: catName(c), state: c.state, x: round(c.x, 2), y: round(c.y, 2), z: round(c.z, 2),
          target: c.target ? c.target.id : null, mood: catMood(c), leaving: c.leaving, taps: c.taps, switches: c.switches };
      }),
      broken: G.broken.map(function (b) { return { type: b.type, culprit: b.culprit.name, kind: b.culprit.kind }; }),
      stats: { flicks: G.stats.flicks, safes: G.stats.safes, catHits: G.stats.catHits, specials: G.stats.specials },
      drags: Object.keys(G.drags).length,
      itemsPlaced: G.spawn.itemCount,
      spawnsHeld: G.debugNoSpawn,
      bodies: G.engine ? G.engine.world.bodies.length : 0,
      popups: G.popups.map(function (p) { return p.text; }),
      banner: G.banner ? G.banner.text : null,
      bannerSub: bannerSub(G.banner),
      toast: G.toast ? G.toast.text : null,
      particles: G.particles.length,
      result: G.result ? { time: round(G.result.time, 2), score: G.result.score, best: G.result.best, newBest: G.result.newBest, broken: G.result.broken.length, rank: G.result.rank } : null,
      timeScale: round(timeScale(), 3),
      view: { w: view.w, h: view.h, scale: view.s, ox: view.ox, oy: view.oy, dpr: view.dpr }
    };
  }
  function stepN(n) {
    n = Math.max(0, n | 0);
    for (var i = 0; i < n; i++) update(STEP);
    render();
    return exportState();
  }
  function simMs() { return G.frame * 1000 / CONFIG.stepHz; }
  var api = {
    config: CONFIG,
    start: function (seed) { startRun(seed === undefined ? nextSeed() : seed); render(); return exportState(); },
    step: stepN,
    state: exportState,
    render: function () { render(); },
    freeze: function (on) { G.frozen = on !== false; },
    input: {
      down: function (x, y, id) { onDown(x, y, id === undefined ? 1 : id, simMs()); },
      move: function (x, y, id) { onMove(x, y, id === undefined ? 1 : id, simMs()); },
      up: function (x, y, id) { onUp(x, y, id === undefined ? 1 : id, simMs()); },
      cancel: function (id) { onCancel(id === undefined ? 1 : id); }
    },
    ui: UI,
    table: { x: T.x, y: T.y, w: T.w, h: T.h },
    shareText: shareText,
    debug: {
      holdSpawns: function (on) { G.debugNoSpawn = on !== false; },
      clearCats: function () { G.cats = []; },
      clearItems: function () {
        for (var i = 0; i < G.items.length; i++) if (G.items[i].body && G.items[i].state === 'table') M.Composite.remove(G.engine.world, G.items[i].body);
        G.items = []; G.drags = {};
      },
      placeItem: function (type, x, y, angle) { var it = createItem(type, x, y, angle || 0); it.spawnT = 99; it.landed = true; return it.id; },
      setVelocity: function (id, vx, vy) { var it = findItem(id); if (it && it.body) M.Body.setVelocity(it.body, { x: vx, y: vy }); },
      spawnCat: function (type, opts) {
        opts = opts || {};
        if (opts.targetId) opts.target = findItem(opts.targetId);
        return spawnCat(type || 'normal', opts).id;
      },
      catState: function (id, state) { var c = findCat(id); if (c) setState(c, state); },
      setTime: function (t) { G.time = t; },
      setBreaks: function (n) { G.breaks = n; if (n === 0) G.broken = []; },
      forceGameOver: function () { if (G.screen === 'play') { G.breaks = Math.max(G.breaks, CONFIG.breaksToLose); gameOver(); } },
      phaseAt: function (t) { return phaseAt(t).cats; },
      saveBest: function () { Store.set(KEY_BEST, G.best); Store.set(KEY_BEST_TIME, G.bestTime); return Store.get(KEY_BEST, 'fallback'); },
      sfxAll: function (noUnlock) { if (!noUnlock) Sfx.unlock(); var names = ['ui', 'grab', 'flick', 'clack', 'pat', 'push', 'stare', 'nya', 'crash', 'fall', 'safe', 'pon', 'land', 'ninja', 'thud', 'warn', 'phase', 'treat', 'munch', 'over', 'best', 'miss', 'heart', 'hop', 'whistle']; names.forEach(function (n) { Sfx.play(n, 8); }); Sfx.toggle(); Sfx.toggle(); return Sfx.ready(); },
      flick: function (id, dx, dy) { var it = findItem(id); return it ? flickItem(it, dx, dy, 0) : false; },
      fastStep: function (n) { for (var i = 0; i < (n | 0); i++) update(STEP); },   // no render (long simulations)
      timeScale: function () { return timeScale(); }
    }
  };
  window.__game = api;

  // ---- ?shot= screens (frozen representative moments for screenshots) ------------------------
  function setupShot(kind) {
    if (kind === 'title') { G.screen = 'title'; G.titleT = 1; G.realTime = 0.62; buildDecor(); G.frozen = true; return; }
    var seed = FIXED_SEED !== null ? FIXED_SEED : 7;
    startRun(seed);
    G.debugNoSpawn = true;
    api.debug.clearItems();
    var d = api.debug, i;
    if (kind === 'play') {
      G.time = 96.4; G.score = 4820; G.breaks = 1; G.phaseIdx = 3; G.gather.next = 160;
      G.broken.push({ type: 'cup', culprit: { kind: 'cat', color: 'tora', ctype: 'normal', name: '茶トラ' }, time: 40, seed: 3 });
      var ts = findItem(d.placeItem('tsubo', TR - 13, 610));
      var phone = findItem(d.placeItem('phone', T.x + 14, 860, 0.1));
      var cup = findItem(d.placeItem('cup', 250, T.y + 34));
      d.placeItem('plate', 330, 470); d.placeItem('cake', 210, 640, 0.3); d.placeItem('vase', 470, 330);
      d.placeItem('orange', 400, 760); d.placeItem('ball', 520, 930); d.placeItem('cup', 360, 1000); d.placeItem('plate', 560, 470);
      update(STEP);
      var c1 = spawnCat('normal', { color: 'tora', x: 0, y: 0, state: 'stare', target: ts }); c1.stare = 1; c1.st = 0.8;
      var c2 = spawnCat('kitten', { color: 'white', x: 0, y: 0, state: 'push', target: cup }); c2.pawT = CONFIG.cat.pawTime * 0.5;
      var c3 = spawnCat('ninja', { x: 0, y: 0, state: 'push', target: phone }); c3.pawT = 0;
      var c4 = spawnCat('fat', { color: 'white', x: 300, y: 860, state: 'pose' }); c4.face = -2.2; c4.lookX = -0.4; c4.lookY = -0.8;
      for (i = 0; i < 18; i++) {
        spawnParticle({ kind: 'shard', x: 150 + G.fx.range(-60, 60), y: TB + 40 + G.fx.range(-20, 30), vx: 0, vy: 0, life: 5, t: 0, size: G.fx.range(6, 12), color: G.fx() < 0.6 ? '#d9f0fa' : '#86bdd6', rot: G.fx.range(0, 6) });
      }
      popup('セーフ!', 520, 880, { size: 60, color: '#ffffff', stroke: '#2e9e5b', life: 99, rise: 0 });
      popup('+500', 520, 935, { size: 34, color: '#ffd166', stroke: '#3a2b2b', life: 99, rise: 0 });
      G.popups.forEach(function (p) { p.t = 0.4; });
      onDown(phone.x + 4, phone.y, 9, 0);
      onMove(phone.x + 130, phone.y - 120, 9, 120);
      G.realTime = 0.37;
      G.frozen = true;
      return;
    }
    if (kind === 'result') {
      for (i = 0; i < 6; i++) d.placeItem(CONFIG.itemSpawn.initial[i % 5], 150 + (i % 3) * 200, 400 + Math.floor(i / 3) * 300);
      G.time = 87.4; G.score = 6230; G.breaks = 3;
      G.stats.flicks = 64; G.stats.safes = 7; G.stats.catHits = 3;
      G.broken = [
        { type: 'vase', culprit: { kind: 'cat', color: 'tora', ctype: 'normal', name: '茶トラ' }, time: 31, seed: 11 },
        { type: 'cake', culprit: { kind: 'player', name: 'あなた' }, time: 64, seed: 22 },
        { type: 'phone', culprit: { kind: 'cat', color: 'black', ctype: 'ninja', name: '忍者ネコ' }, time: 87, seed: 33 }
      ];
      // show a NEW! badge without touching the player's real best (in memory or saved)
      var realBest = G.best, realBestTime = G.bestTime;
      G.best = Math.min(G.best, 6000);
      showResult({ noSave: true });
      G.best = realBest; G.bestTime = realBestTime;
      G.resultT = 2; G.realTime = 0.2;
      G.frozen = true;
    }
  }

  // ---- ?test=1 automated scenario ----------------------------------------------------------------
  var testReport = null;
  function writeReport(R) {
    testReport = R;
    var pre = document.getElementById('test-report');
    if (pre) pre.textContent = JSON.stringify(R, null, 2);
    document.title = R.pass ? 'TEST PASS' : 'TEST FAIL';
  }
  window.__onGameError = function () {
    if (!TEST_MODE || !testReport) return;
    testReport.pass = false;
    testReport.errors = (window.__errors || []).slice();
    writeReport(testReport);
  };
  function runTests() {
    var t0 = performance.now();
    var R = { pass: true, seed: FIXED_SEED !== null ? FIXED_SEED : 1, checks: [], errors: [], notes: [] };
    var g = api, d = api.debug, s, i;
    // the run must not change the player's saved settings/records: snapshot and restore them
    var savedKeys = [KEY_BEST, KEY_BEST_TIME, KEY_MUTE], saved = {};
    savedKeys.forEach(function (k) { saved[k] = Store.get(k, null); });
    var savedMem = { muted: Sfx.isMuted(), best: G.best, bestTime: G.bestTime };
    function ok(name, cond, info) {
      var c = { name: name, ok: !!cond };
      if (info !== undefined) c.info = info;
      R.checks.push(c);
      if (!cond) R.pass = false;
    }
    function itemById(st, id) { for (var k = 0; k < st.items.length; k++) if (st.items[k].id === id) return st.items[k]; return null; }
    function catById(st, id) { for (var k = 0; k < st.cats.length; k++) if (st.cats[k].id === id) return st.cats[k]; return null; }
    function drag(x0, y0, x1, y1, id, steps) {
      steps = steps || 3;
      g.input.down(x0, y0, id); g.step(2);
      for (var k = 1; k <= steps; k++) { g.input.move(lerp(x0, x1, k / steps), lerp(y0, y1, k / steps), id); g.step(2); }
      g.input.up(x1, y1, id);
    }
    try {
      ok('Matter.js vendored & loaded', !!(window.Matter && window.Matter.Engine && window.Matter.Body.getVelocity));
      ok('starts on title screen', g.state().screen === 'title');
      var errsBefore = (window.__errors || []).length;
      ok('SFX and mute before the audio unlock are silent no-ops', d.sfxAll(true) === false && (window.__errors || []).length === errsBefore);
      ok('synth SFX schedule without errors', d.sfxAll() !== undefined);

      // --- start from the title with a tap
      g.step(30);
      g.input.down(360, 900, 1); g.input.up(360, 900, 1);
      s = g.state();
      ok('tap on title starts a run', s.screen === 'play');
      if (s.screen !== 'play') g.start(R.seed);
      s = g.state();
      ok('5 items on the table at start', s.items.length === 5, s.items.map(function (x) { return x.type; }));
      ok('one cat wanted in phase 1', s.desiredCats === 1);
      g.step(150);
      s = g.state();
      ok('first cat jumped onto the table', s.cats.length === 1 && s.cats[0].state !== 'jump', s.cats);

      // --- flick with simulated pointer input
      var it0 = s.items[0], dxc = TCX - it0.x, dyc = TCY - it0.y, dl = hypot(dxc, dyc) || 1;
      var ux = dxc / dl, uy = dyc / dl;
      g.input.down(it0.x + 8, it0.y - 6, 1); g.step(2);
      g.input.move(it0.x + 8 + ux * 70, it0.y - 6 + uy * 70, 1); g.step(2);
      ok('drag registered on item (generous grab radius)', g.state().drags === 1);
      g.input.move(it0.x + 8 + ux * 150, it0.y - 6 + uy * 150, 1); g.step(2);
      g.input.up(it0.x + 8 + ux * 150, it0.y - 6 + uy * 150, 1);
      s = g.step(1);
      var f1 = itemById(s, it0.id);
      ok('release flicks the item', f1 && f1.speed > 3, f1 && f1.speed);
      ok('flick moves toward drag direction', f1 && (f1.vx * ux + f1.vy * uy) > 0);
      g.step(60);
      s = g.state(); f1 = itemById(s, it0.id);
      ok('flicked item slid and slowed (frictionAir)', f1 && dist(f1.x, f1.y, it0.x, it0.y) > 60 && f1.speed < 8, f1 && { moved: dist(f1.x, f1.y, it0.x, it0.y), speed: f1.speed });
      ok('flick counted', s.stats.flicks === 1);
      g.input.down(it0.x, it0.y, 4); g.input.up(it0.x + 3, it0.y, 4);
      ok('tiny tap does not flick', g.state().stats.flicks === 1);
      g.input.down(T.x - 30, T.y - 60, 5); g.input.up(T.x - 30, T.y - 60, 5);
      ok('tap on empty floor is harmless', g.state().drags === 0);
      g.step(120);
      s = g.state();
      ok('score ticks with items on table', s.score > 0 && s.time > 5, { score: s.score, time: s.time });

      // --- controlled: hit a cat with a flicked item
      d.holdSpawns(true); d.clearCats(); d.clearItems();
      var catId = d.spawnCat('normal', { x: 360, y: 470, state: 'pose', color: 'tora' });
      var cupId = d.placeItem('cup', 360, 760);
      var scoreBefore = g.state().score;
      drag(360, 760, 360, 600, 2, 3);
      g.step(40);
      s = g.state();
      ok('flicked item scares cat: ニャッ +300', s.stats.catHits === 1 && s.score >= scoreBefore + 300, { catHits: s.stats.catHits, gained: s.score - scoreBefore });
      var hc = catById(s, catId);
      ok('scared cat leaps off the table', !hc || hc.state === 'jump', hc);
      var cupS = itemById(s, cupId);
      ok('item bounces back off the cat', cupS && cupS.vy > 0, cupS);
      g.step(60);

      // --- flicking a cat's own target back at it: the cat hops in surprise, no bounce, no +300
      d.clearCats(); d.clearItems();
      var tgtId = d.placeItem('plate', TR - 60, 700);
      var pcId = d.spawnCat('normal', { x: 0, y: 0, state: 'push', targetId: tgtId, color: 'white' });
      s = g.step(1);
      var tgt = itemById(s, tgtId), hitsBefore = s.stats.catHits;
      drag(tgt.x, tgt.y, tgt.x - 180, tgt.y, 2, 3);
      g.step(30);
      s = g.state(); tgt = itemById(s, tgtId);
      var pc = catById(s, pcId);
      ok('own target flicked back: cat startles (ビクッ), item slides under', s.stats.catHits === hitsBefore && pc && pc.target === null && !pc.leaving && tgt && tgt.x < TR - 200 && s.popups.indexOf('ビクッ!') >= 0,
        { cat: pc, item: tgt && { x: tgt.x }, popups: s.popups });
      g.step(30);

      // --- controlled: セーフ! rescue of an item a cat pushed to the edge
      d.clearCats(); d.clearItems();
      var plateId = d.placeItem('plate', TR - 95, 640);
      var pusher = d.spawnCat('normal', { x: 0, y: 0, state: 'push', targetId: plateId, color: 'tora' });
      for (i = 0; i < 60 * 12; i++) { s = g.step(1); var pcs = catById(s, pusher); if (pcs && pcs.state === 'stare') break; }
      var pl = itemById(s, plateId);
      ok('cat pushes the item to the edge, then stares', catById(s, pusher) && catById(s, pusher).state === 'stare' && pl && pl.overhang >= 0.25 && pl.culprit === '茶トラ', { cat: catById(s, pusher), item: pl });
      var safeBefore = s.score, safeAt = -1, catReact = false;
      drag(pl.x - 6, pl.y, pl.x - 186, pl.y + 10, 3, 3);
      for (i = 0; i < 150; i++) {
        s = g.step(1);
        if (s.popups.indexOf('ビクッ!') >= 0 || s.popups.indexOf('チッ…') >= 0) catReact = true;
        if (safeAt < 0 && s.stats.safes === 1) safeAt = i;
      }
      s = g.state(); pl = itemById(s, plateId);
      ok('rescue from the edge gives セーフ! +500', s.stats.safes === 1 && s.score >= safeBefore + 500, { safes: s.stats.safes, gained: s.score - safeBefore });
      ok('セーフ! pops as the item comes back (not after it settles), and the staring cat reacts', safeAt >= 0 && safeAt < 40 && catReact, { stepsAfterRelease: safeAt, catReact: catReact });
      ok('rescued item stays on the table', pl && pl.state === 'table' && pl.overhang === 0, pl);

      // --- セーフ! cannot be farmed: nudging your own item to the edge and back gives nothing
      d.clearCats(); d.clearItems();
      var farmId = d.placeItem('plate', TCX, 640);
      var farmSafes = g.state().stats.safes, farmScore = g.state().score, farmOh = [];
      var Fp = CONFIG.flick, fa = CONFIG.items.plate.frictionAir;
      for (var fk = 0; fk < 3; fk++) {
        var fit = itemById(g.state(), farmId);
        var want = fit.x - (T.x + (0.5 - 0.38) * 84);          // stop with ~38% hanging over the left edge
        var pw = Math.pow((slideSpeed(want, fa) - Fp.minSpeed) / (Fp.maxSpeed - Fp.minSpeed), 1 / Fp.powerCurve);
        d.flick(farmId, -pw * Fp.maxDrag, 0); g.step(150);
        farmOh.push(itemById(g.state(), farmId).overhang);
        d.flick(farmId, 160, 0); g.step(150);
      }
      s = g.state();
      ok('self-made edge items give no セーフ (no +500 farming)', farmOh[0] >= 0.25 && s.stats.safes === farmSafes && s.score - farmScore < 100, { overhangs: farmOh, safes: s.stats.safes - farmSafes, gained: s.score - farmScore });

      // --- the おやつ button must not steal a grab on an item hanging over the bottom edge
      d.clearCats(); d.clearItems();
      var lowId = d.placeItem('plate', 200, TB - 5);
      s = g.step(1);
      var tb0 = UI.treat;
      g.input.down(200, TB + 36, 14);
      s = g.state();
      ok('touching an item over the おやつ button grabs the item (treat not wasted)', !s.treat.used && s.drags === 1 && hitRect(tb0, 200, TB + 36, 0), { treat: s.treat, drags: s.drags });
      g.input.up(200, TB - 120, 14);
      s = g.step(60);
      ok('...and the hanging item was flicked back', itemById(s, lowId) && itemById(s, lowId).y < TB - 60 && itemById(s, lowId).overhang === 0, itemById(s, lowId));

      // --- multi-touch: two fingers flick two items at once; a third cannot steal a held item
      d.clearCats(); d.clearItems();
      var mA = d.placeItem('cup', 220, 640), mB = d.placeItem('plate', 500, 640);
      g.input.down(220, 640, 21); g.input.down(500, 640, 22); g.step(2);
      g.input.down(226, 640, 23);
      var mDr = g.state().drags;
      g.input.move(220, 540, 21); g.input.move(500, 540, 22); g.step(2);
      g.input.up(220, 540, 21); g.input.up(500, 540, 22); g.input.up(226, 640, 23);
      s = g.step(1);
      ok('multi-touch: two simultaneous flicks, held item not stolen', mDr === 2 && itemById(s, mA).vy < -3 && itemById(s, mB).vy < -3 && s.drags === 0, { drags: mDr, a: itemById(s, mA).vy, b: itemById(s, mB).vy });
      // pointer cancel and window blur both drop a drag
      g.input.down(itemById(s, mA).x, itemById(s, mA).y, 24); g.input.cancel(24);
      var afterCancel = g.state().drags;
      s = g.state();
      g.input.down(itemById(s, mA).x, itemById(s, mA).y, 25);
      window.dispatchEvent(new Event('blur'));
      ok('pointercancel / window blur release held items', afterCancel === 0 && g.state().drags === 0);
      // real PointerEvents through the canvas listeners: a new primary touch clears a stale touch drag
      g.step(90); s = g.state();
      var vw = s.view, pa = itemById(s, mA);
      var toClient = function (lx, ly) { return { x: vw.ox + lx * vw.scale, y: vw.oy + ly * vw.scale }; };
      var pev = function (type, id, lx, ly) {
        var c = toClient(lx, ly);
        canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: c.x, clientY: c.y, bubbles: true, cancelable: true }));
      };
      var fl0 = s.stats.flicks;
      pev('pointerdown', 31, pa.x, pa.y);             // its pointerup never arrives
      var staleHeld = g.state().drags;
      pev('pointerdown', 32, pa.x, pa.y);             // next touch on the same item
      pev('pointermove', 32, pa.x + 15, pa.y + 22);
      pev('pointerup', 32, pa.x + 30, pa.y + 45);
      s = g.step(1);
      ok('real pointer events: stale touch drag is cleared, item can be grabbed and flicked', staleHeld === 1 && s.drags === 0 && s.stats.flicks === fl0 + 1 && itemById(s, mA).vy > 3, { staleHeld: staleHeld, drags: s.drags, flicks: s.stats.flicks - fl0, vy: itemById(s, mA).vy });
      g.step(120);
      s = g.state();
      ok('no breaks during the controlled input checks', s.breaks === 0 && s.screen === 'play', { breaks: s.breaks, broken: s.broken });
      d.setBreaks(0);

      // --- cat behaviour: walk → sit → push → stare → final push → break
      d.clearItems(); d.clearCats();
      var vaseId = d.placeItem('vase', TR - 120, 520);
      var cat2 = d.spawnCat('normal', { x: TCX, y: 520, state: 'choose', color: 'black' });
      var seen = {}, fallScale = null, minScale = 1;
      for (i = 0; i < 60 * 14; i++) {
        var st1 = g.step(1);
        var cs = catById(st1, cat2), vz = itemById(st1, vaseId);
        if (cs) seen[cs.state] = true;
        if (vz && vz.state === 'falling' && fallScale === null) fallScale = st1.timeScale;
        minScale = Math.min(minScale, st1.timeScale);
        if (st1.breaks > 0) break;
      }
      s = g.state();
      ok('staging: the drop plays in slow motion, then a hit-stop at the crash', fallScale !== null && fallScale < 0.8 && s.timeScale < 0.2, { fallScale: fallScale, atCrash: s.timeScale });
      ok('staging: culprit cat goes ドヤッ, the HUD says how many breaks are left', s.popups.indexOf('ドヤッ') >= 0 && s.popups.indexOf('あと2つ割れたらアウト!') >= 0 && catById(s, cat2) && catById(s, cat2).mood === 'smug', { popups: s.popups, cat: catById(s, cat2) });
      ok('cat state machine walked/sat/pushed/stared', seen.walk && seen.sit && seen.push && seen.stare, Object.keys(seen));
      ok('cat pushed the item off: break counted', s.breaks === 1 && s.broken.length === 1 && s.broken[0].type === 'vase', s.broken);
      ok('culprit is the cat', s.broken[0] && s.broken[0].kind === 'cat' && s.broken[0].culprit === '黒ネコ', s.broken[0]);
      ok('ガシャーン! shown', s.popups.indexOf('ガシャーン!') >= 0, s.popups);
      ok('shards spawned', s.particles > 10, s.particles);
      ok('still playing after 1 break', s.screen === 'play');
      g.step(90);

      // --- 自滅: the player's own flick knocks an item off; the cats are innocent (and smug)
      d.clearItems(); d.clearCats(); d.setBreaks(0);
      var soCake = d.placeItem('cake', T.x + 58, 650, 0.1), soPlate = d.placeItem('plate', 330, 655);
      var soCat = d.spawnCat('normal', { x: 540, y: 900, state: 'pose', color: 'white' });
      d.flick(soPlate, -240, 0);
      for (i = 0; i < 120; i++) { s = g.step(1); if (s.breaks > 0) break; }
      s = g.step(2);
      ok('自滅: a break caused by your own flick blames you, says じ、自滅…!, and the cats look smug', s.broken.length >= 1 && s.broken[0].kind === 'player' && s.broken[0].type === 'cake' &&
        s.popups.indexOf('じ、自滅…!') >= 0 && catById(s, soCat) && catById(s, soCat).mood === 'smug' && s.screen === 'play', { broken: s.broken, popups: s.popups, cat: catById(s, soCat) });
      g.step(90); d.setBreaks(0);
      void soCake;

      // --- おやつ (ad hook stub)
      d.clearCats(); d.clearItems();
      d.placeItem('plate', 300, 500); d.placeItem('cup', 450, 700);
      d.spawnCat('normal', { x: 300, y: 650, state: 'choose' }); d.spawnCat('normal', { x: 450, y: 450, state: 'choose' });
      g.step(30);
      var tb = UI.treat;
      g.input.down(tb.x + tb.w / 2, tb.y + tb.h / 2, 6); g.input.up(tb.x + tb.w / 2, tb.y + tb.h / 2, 6);
      s = g.state();
      ok('おやつ starts treat time', s.treat.used && s.treat.active, s.treat);
      g.step(60);
      s = g.state();
      ok('all cats go eat the treat', s.cats.length === 2 && s.cats.every(function (c) { return c.state === 'eat'; }), s.cats.map(function (c) { return c.state; }));
      g.input.down(tb.x + tb.w / 2, tb.y + tb.h / 2, 6); g.input.up(tb.x + tb.w / 2, tb.y + tb.h / 2, 6);
      g.step(60 * 9 + 30);
      s = g.state();
      ok('treat lasts 10s then ends (once per run)', !s.treat.active && s.treat.used, s.treat);
      g.step(60);
      s = g.state();
      ok('cats come back after the treat', s.cats.length === 2 && s.cats.every(function (c) { return c.state !== 'eat'; }), s.cats.map(function (c) { return c.state; }));

      // --- special cats
      d.clearCats(); d.clearItems(); d.setBreaks(0);
      var nearId = d.placeItem('cake', TCX + 40, 700);
      for (i = 0; i < 4; i++) d.placeItem(['cup', 'plate', 'phone', 'orange'][i], 140 + i * 140, 360);
      d.placeItem('ball', T.x + 70, 980);
      d.spawnCat('fat', { landX: TCX, landY: 640 });
      g.step(80);
      s = g.state();
      var cake = itemById(s, nearId);
      ok('デブ猫 landing shoves nearby items', cake && dist(cake.x, cake.y, TCX + 40, 700) > 15, cake && dist(cake.x, cake.y, TCX + 40, 700));
      var ninjaId = d.spawnCat('ninja', {});
      s = g.state();
      var nj = catById(s, ninjaId);
      ok('忍者ネコ pops up at the table edge (no jump)', nj && nj.state === 'walk' && (Math.min(nj.x - T.x, TR - nj.x, nj.y - T.y, TB - nj.y) < 50), nj);
      var kitId = d.spawnCat('kitten', {});
      var fatId = s.cats.filter(function (c) { return c.type === 'fat'; })[0].id;
      // flick an item straight at the fat cat: it should shrug it off
      d.catState(fatId, 'pose');
      var fc = catById(g.state(), fatId);
      var hitId = d.placeItem('cup', fc.x, Math.min(fc.y + 170, TB - 40));
      var hitBefore = g.state().stats.catHits;
      d.flick(hitId, 0, -200);
      g.step(30);
      s = g.state(); fc = catById(s, fatId);
      ok('デブ猫 ignores hits', fc && !fc.leaving && fc.state === 'pose' && s.stats.catHits === hitBefore && s.popups.indexOf('びくともしない…') >= 0, { cat: fc, popups: s.popups });
      d.catState(fatId, 'choose');
      var kitSwitches = 0, kitSeen = false;
      for (i = 0; i < 24; i++) {
        d.setBreaks(0);
        s = g.step(30);
        var kc = catById(s, kitId);
        if (kc) { kitSeen = true; kitSwitches = Math.max(kitSwitches, kc.switches); }
      }
      ok('子ネコ switches targets', kitSeen && kitSwitches >= 1, { seen: kitSeen, switches: kitSwitches });

      // --- escalation table
      ok('escalation: 1 cat at 10s, 2 at 45s, 3 at 75s, 3+specials at 100s', d.phaseAt(10) === 1 && d.phaseAt(45) === 2 && d.phaseAt(75) === 3 && d.phaseAt(100) === 3 && CONFIG.phases[3].special > 0);

      // --- ネコ大集合 + live spawning at 90s+
      if (g.state().screen !== 'play') { R.notes.push('run ended during special-cat segment (cats broke items unattended); restarted'); g.start(R.seed); d.holdSpawns(true); }
      d.clearCats(); d.clearItems();
      for (i = 0; i < 8; i++) d.placeItem(['cup', 'plate', 'vase', 'cake', 'phone', 'tsubo', 'orange', 'ball'][i], 160 + (i % 4) * 130, 420 + Math.floor(i / 4) * 300);
      d.setBreaks(0); d.holdSpawns(false);
      d.setTime(CONFIG.gather.firstAt - CONFIG.gather.warn - 0.5);
      g.step(60);
      s = g.state();
      ok('ネコ大集合 is announced before it starts', s.banner === 'ネコ大集合!!' && /^あと [1-3] 秒で5匹やってくる…!$/.test(s.bannerSub), [s.banner, s.bannerSub]);
      g.step(Math.round(60 * 2.6));
      s = g.state();
      ok('ネコ大集合 banner says きたーっ! when the cats arrive (not "あと 45 秒")', s.gather.active && (s.banner !== 'ネコ大集合!!' || s.bannerSub === 'きたーっ!'), [s.time, s.banner, s.bannerSub]);
      g.step(Math.round(60 * 3.4));
      s = g.state();
      ok('ネコ大集合: 5 cats wanted, several on the table', s.gather.active && s.desiredCats === 5 && s.cats.length >= 4, { cats: s.cats.length, desired: s.desiredCats });
      var placedBefore = s.itemsPlaced;
      g.step(60 * 16);
      s = g.state();
      ok('a new item is placed every 15s', s.itemsPlaced > placedBefore || s.screen !== 'play', { before: placedBefore, now: s.itemsPlaced, screen: s.screen });

      // --- 高級つぼ counts double → game over → result
      if (g.state().screen !== 'play') g.start(R.seed);
      d.holdSpawns(true); d.clearCats(); d.clearItems(); d.setBreaks(1);
      var tsId = d.placeItem('tsubo', T.x + 12, 900);
      d.setVelocity(tsId, -5, 0);
      g.step(60);
      s = g.state();
      ok('高級つぼ counts as 2 breaks', s.breaks === 3, s.breaks);
      ok('3 breaks = game over', s.screen === 'over');
      g.step(Math.ceil(CONFIG.overTime * 60) + 5);
      s = g.state();
      ok('result screen shown', s.screen === 'result' && s.result && s.result.time > 0, s.result);
      ok('result has a 称号 and the share text carries it', !!s.result.rank && g.shareText().indexOf('称号「' + s.result.rank + '」') >= 0, { rank: s.result.rank, text: g.shareText() });
      g.step(60);
      g.input.down(UI.share.x + UI.share.w / 2, UI.share.y + 20, 7); g.input.up(UI.share.x + UI.share.w / 2, UI.share.y + 20, 7);
      ok('share button does not throw', true);
      ok('share text format', /^ネコ、それダメ!で[\d.]+秒耐えた… .*#ネコそれダメ$/.test(g.shareText()), g.shareText());
      g.input.down(UI.retry.x + 50, UI.retry.y + 50, 7); g.input.up(UI.retry.x + 50, UI.retry.y + 50, 7);
      s = g.state();
      ok('もう一回 restarts instantly', s.screen === 'play' && s.breaks === 0 && s.score === 0 && s.items.length === 5, { screen: s.screen, breaks: s.breaks });
      ok('retry fully resets the run (spawns, treat, phase, gather, physics world, fx)', !s.spawnsHeld && s.time === 0 && s.phase === 0 && !s.treat.used && !s.treat.active && s.gather.next === CONFIG.gather.firstAt &&
        s.bodies === 5 && s.cats.length === 0 && s.broken.length === 0 && s.stats.flicks === 0 && s.result === null && s.drags === 0 && s.itemsPlaced === 0,
        { spawnsHeld: s.spawnsHeld, time: s.time, phase: s.phase, treat: s.treat, gather: s.gather, bodies: s.bodies, cats: s.cats.length });
      s = g.step(150);
      ok('cats spawn again after retry (no debug hold leaks between runs)', s.cats.length === 1, s.cats.length);

      // --- mute toggle
      var m0 = g.state().muted;
      g.input.down(UI.mute.x, UI.mute.y, 8); g.input.up(UI.mute.x, UI.mute.y, 8);
      var m1 = g.state().muted;
      g.input.down(UI.mute.x, UI.mute.y, 8); g.input.up(UI.mute.x, UI.mute.y, 8);
      ok('mute toggle works and does not grab items', m1 === !m0 && g.state().muted === m0 && g.state().drags === 0);

      // --- storage that throws
      var desc = Object.getOwnPropertyDescriptor(window, 'localStorage');
      var overridden = false, threw = false, got = null;
      try {
        Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { throw new Error('blocked'); } });
        overridden = true;
        try { got = d.saveBest(); g.input.down(UI.mute.x, UI.mute.y, 8); g.input.down(UI.mute.x, UI.mute.y, 8); } catch (e) { threw = true; }
      } catch (e) { R.notes.push('could not override localStorage: ' + e.message); }
      finally { try { if (desc) Object.defineProperty(window, 'localStorage', desc); else delete window.localStorage; } catch (e) { /* ignore */ } }
      ok('game survives localStorage throwing', !threw && (!overridden || got === 'fallback'), { overridden: overridden, got: got });

      // --- forced game over hook
      d.forceGameOver();
      g.step(120);
      ok('forced game over reaches result', g.state().screen === 'result');

      // --- fuzz: a minute of random flicks with live spawning
      g.start(4242);
      var fr = makeRng(99), nanFound = false, maxCats = 0;
      for (i = 0; i < 60 * 70; i++) {
        if (i % 25 === 0) {
          var st = g.state();
          if (st.screen === 'result') { g.input.down(UI.retry.x + 60, UI.retry.y + 50, 3); g.input.up(UI.retry.x + 60, UI.retry.y + 50, 3); }
          var tgt = st.items.length ? st.items[Math.floor(fr() * st.items.length)] : { x: TCX, y: TCY };
          var ax = tgt.x + fr.range(-20, 20), ay = tgt.y + fr.range(-20, 20);
          g.input.down(ax, ay, 3); g.step(3);
          g.input.move(ax + fr.range(-200, 200), ay + fr.range(-200, 200), 3); g.step(3);
          g.input.up(ax + fr.range(-200, 200), ay + fr.range(-200, 200), 3);
        }
        update(STEP);
        if (i % 60 === 0) {
          var sv = exportState();
          maxCats = Math.max(maxCats, sv.cats.length);
          sv.items.forEach(function (x) { if (!isFinite(x.x) || !isFinite(x.y) || !isFinite(x.vx)) nanFound = true; });
          sv.cats.forEach(function (x) { if (!isFinite(x.x) || !isFinite(x.y)) nanFound = true; });
        }
        if (i % 120 === 0) render();
      }
      ok('fuzz: 70s of random input without NaN/errors', !nanFound && (window.__errors || []).length === 0, { maxCats: maxCats, state: g.state().screen });

      // --- best score: only a higher score replaces it; survives storage throwing
      startRun(5); G.best = 1000; G.bestTime = 50;
      G.score = 400; G.time = 20; showResult();
      var b1 = { best: G.best, newBest: G.result.newBest, shown: G.result.best, stored: Store.get(KEY_BEST, null) };
      startRun(5); G.score = 2500; G.time = 30; showResult();
      var b2 = { best: G.best, newBest: G.result.newBest, shown: G.result.best, stored: Store.get(KEY_BEST, null), bestTime: G.bestTime };
      ok('best score: lower score keeps the best, higher one replaces and saves it', b1.best === 1000 && !b1.newBest && b1.shown === 1000 &&
        b2.best === 2500 && b2.newBest && b2.shown === 2500 && (b2.stored === null || b2.stored === '2500') && b2.bestTime === 50, { b1: b1, b2: b2 });
      var lsDesc = Object.getOwnPropertyDescriptor(window, 'localStorage'), b3 = null, b3err = null;
      try {
        Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { throw new Error('blocked'); } });
        startRun(5); G.score = 3100; G.time = 60; showResult();
        b3 = { best: G.best, newBest: G.result.newBest, bestTime: G.bestTime };
      } catch (e) { b3err = String(e); }
      finally { try { if (lsDesc) Object.defineProperty(window, 'localStorage', lsDesc); } catch (e) { /* ignore */ } }
      ok('best score still works in memory when storage throws on save', !b3err && b3 && b3.best === 3100 && b3.newBest && b3.bestTime === 60, { b3: b3, err: b3err });

      // --- soak: 150 s of the late game (special cats, ネコ大集合) with a simple rescue bot;
      //     no NaN, no cat stuck in one state, no item stuck mid-fall, run state stays sane
      var soak = (function () {
        startRun(31337); G.time = 85;
        var stuckMax = 0, stuckInfo = null, seenTypes = {}, maxCats = 0, nan = false, fallStuck = false, restarts = 0, gathers = 0, treatUsed = false;
        var since = {}, last = {}, wasGather = false;
        for (var k = 0; k < 60 * 150; k++) {
          if (G.screen === 'result') { restarts++; startRun(31337 + restarts); G.time = 85; since = {}; last = {}; }
          if (G.screen === 'play' && k % 20 === 0) {
            var worst = null;
            for (var q = 0; q < G.items.length; q++) { var w = G.items[q]; if (w.state === 'table' && w.overhang > 0.12 && (!worst || w.overhang > worst.overhang)) worst = w; }
            if (worst) {
              var ddx = TCX - worst.x, ddy = TCY - worst.y, dd = hypot(ddx, ddy) || 1;
              var need = Math.min(dd * 0.8, 420), sp = slideSpeed(need, worst.def.frictionAir);
              var pw = clamp(Math.pow(clamp((sp - CONFIG.flick.minSpeed) / (CONFIG.flick.maxSpeed - CONFIG.flick.minSpeed), 0, 1), 1 / CONFIG.flick.powerCurve), 0.08, 1);
              var L = Math.max(CONFIG.flick.minDrag + 1, pw * CONFIG.flick.maxDrag);
              onDown(worst.x, worst.y, 40, simMs()); onMove(worst.x + ddx / dd * L * 0.5, worst.y + ddy / dd * L * 0.5, 40, simMs() + 200);
              onUp(worst.x + ddx / dd * L, worst.y + ddy / dd * L, 40, simMs() + 400);
            }
            if (!treatUsed && G.time > 100 && G.cats.length >= 4) { onDown(UI.treat.x + 20, UI.treat.y + UI.treat.h - 12, 41, simMs()); onUp(UI.treat.x + 20, UI.treat.y + UI.treat.h - 12, 41, simMs()); treatUsed = G.treat.used; }
          }
          update(STEP);
          var ga = G.time < G.gather.until; if (ga && !wasGather) gathers++; wasGather = ga;
          for (var ci = 0; ci < G.cats.length; ci++) {
            var cc = G.cats[ci];
            seenTypes[cc.type] = true;
            if (!isFinite(cc.x) || !isFinite(cc.y) || !isFinite(cc.z)) nan = true;
            if (last[cc.id] !== cc.state) { last[cc.id] = cc.state; since[cc.id] = G.time; }
            var dur = G.time - since[cc.id];
            if (cc.state !== 'eat' && dur > stuckMax) { stuckMax = dur; stuckInfo = { type: cc.type, state: cc.state, t: round(G.time, 1) }; }
          }
          maxCats = Math.max(maxCats, G.cats.length);
          for (var ii = 0; ii < G.items.length; ii++) {
            var iv = G.items[ii];
            if (!isFinite(iv.x) || !isFinite(iv.y) || (iv.body && !isFinite(iv.body.velocity.x))) nan = true;
            if (iv.state === 'falling' && iv.fallT > CONFIG.fallTime + 0.1) fallStuck = true;
          }
          if (!isFinite(G.score)) nan = true;
          if (k % 600 === 0) render();
        }
        return { stuckMax: round(stuckMax, 1), stuckInfo: stuckInfo, types: Object.keys(seenTypes), maxCats: maxCats, nan: nan, fallStuck: fallStuck, restarts: restarts, gathers: gathers, treat: treatUsed, t: round(G.time, 1) };
      })();
      ok('soak 150 s late game: special cats + ネコ大集合, no NaN, nothing stuck', !soak.nan && !soak.fallStuck && soak.stuckMax < 30 && soak.types.length >= 3 && soak.maxCats >= 4 && soak.gathers >= 1 && (window.__errors || []).length === 0, soak);

      // --- determinism (same seed + same inputs = same state)
      var snap = function () {
        g.start(777);
        for (var r = 0; r < 6; r++) {
          g.step(90);
          var st2 = g.state();
          if (st2.screen !== 'play' || !st2.items.length) break;
          var a = st2.items[r % st2.items.length];
          drag(a.x, a.y, a.x + 90, a.y - 60, 1, 3);
        }
        g.step(240);
        var f = g.state();
        return JSON.stringify({ score: f.score, breaks: f.breaks, items: f.items.map(function (x) { return [x.type, x.x, x.y]; }), cats: f.cats.map(function (x) { return [x.type, x.state, x.x, x.y]; }) });
      };
      var A = snap(), B = snap();
      ok('deterministic with the same seed', A === B, A === B ? undefined : { A: A.slice(0, 300), B: B.slice(0, 300) });

      // --- shot setups render
      var bestBeforeShots = G.best;
      ['title', 'play', 'result'].forEach(function (k) { setupShot(k); render(); });
      ok('?shot= scenes build and render', true);
      ok('?shot=result does not change the real best score', G.best === bestBeforeShots && G.result && G.result.newBest, { before: bestBeforeShots, after: G.best });
      G.frozen = false;
      g.start(R.seed);
    } catch (e) {
      R.pass = false;
      R.errors.push(String((e && e.stack) || e));
    }
    savedKeys.forEach(function (k) { if (saved[k] === null) Store.remove(k); else Store.set(k, saved[k]); });
    Sfx.setMuted(savedMem.muted);
    if (saved[KEY_MUTE] === null) Store.remove(KEY_MUTE);
    G.best = savedMem.best; G.bestTime = savedMem.bestTime;
    var errs = (window.__errors || []).slice();
    if (errs.length) { R.pass = false; R.errors = R.errors.concat(errs); }
    R.summary = R.checks.filter(function (c) { return c.ok; }).length + '/' + R.checks.length + ' checks passed';
    R.ms = Math.round(performance.now() - t0);
    writeReport(R);
  }

  // ==========================================================================
  // boot
  // ==========================================================================
  resize();
  if (!M) {
    reportError(new Error('Matter.js failed to load (vendor/matter.min.js)'));
  } else {
    buildDecor();
    if (SHOT === 'title' || SHOT === 'play' || SHOT === 'result') {
      try { setupShot(SHOT); } catch (e) { reportError(e); }
    }
    window.requestAnimationFrame(frame);
    if (TEST_MODE) {
      var go = function () { try { runTests(); } catch (e) { reportError(e); writeReport({ pass: false, errors: (window.__errors || []).slice() }); } };
      if (document.readyState === 'complete') setTimeout(go, 0); else window.addEventListener('load', function () { setTimeout(go, 0); });
    }
  }
})();
