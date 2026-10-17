/*
 * ぴったり給食当番 — browser prototype
 * Classic script (no modules, no build). Open index.html directly; file:// works.
 *
 * Sections
 *   1. CONFIG        — every gameplay tuning number
 *   2. Look data     — palette, layout, names, lines (visual / text only)
 *   3. Utils & RNG   — math helpers, seeded mulberry32
 *   4. Storage       — localStorage wrapped in try/catch
 *   5. Audio         — WebAudio synthesized SFX
 *   6. Pots & classes— shape profiles, level<->volume tables, class generation
 *   7. Game flow     — state machine, pouring, fairness, scoring
 *   8. FX            — particles, pop-up text, shake
 *   9. Render: scene — background, kids, pot, plates, ladle
 *  10. Render: UI    — HUD, cards, title, result
 *  11. Main loop     — resize (DPR + letterbox), DOM input, rAF fixed-step loop
 *  12. Test hooks    — window.__game, ?test=1, ?shot=
 */
(function () {
  'use strict';

  // =====================================================================
  // 1. CONFIG — all gameplay tuning lives here
  // =====================================================================
  var CONFIG = {
    W: 720, H: 1280,            // logical resolution (portrait)
    DT: 1 / 60,                 // fixed simulation step
    maxFrameDt: 0.25,

    // --- pouring (amounts are in "servings": 1.0 = one plain kid's fair blob) ---
    baseFlow: 0.85,             // servings / second at full flow (multiplied by menu.flow)
    rampTime: 0.2,              // seconds for the flow to ramp up after pressing
    wobble: 0.10,               // ±10% flow wobble
    wobbleHz: [1.7, 4.3],
    minServe: 0.06,             // releasing below this does not finalize (kid keeps waiting)
    emptyEps: 0.02,             // pot counts as empty below this many servings
    emptyAutoRelease: 0.35,     // seconds of scraping an empty pot before the serving auto-finalizes
    scrapeFrac: 0.07,           // pot fraction (of the class volume) below which pouring goes "カンカン"
    scrapeInterval: 0.2,

    // --- menus: viscosity / chunkiness ---
    menus: {
      curry: { flow: 1.0, cont: 1.0, chunkRate: 2.0, chunkMin: 0.03, chunkMax: 0.06 },
      stew:  { flow: 1.45, cont: 1.0, chunkRate: 1.5, chunkMin: 0.02, chunkMax: 0.05 },   // さらさら: fast
      rice:  { flow: 0.85, cont: 0.3, chunkRate: 4.5, chunkMin: 0.05, chunkMax: 0.10 }   // lumps: more variance
    },

    // --- pot shapes (width profile; volume uses width^potVolumeExponent: 2 = round pot) ---
    shapes: {
      zundou:   { pxW: 236, pxH: 380, cornerH: 0.05 },
      marusoko: { pxW: 262, pxH: 352, roundH: 0.40 },
      bowl:     { pxW: 270, pxH: 330, bottomW: 0.40 }
    },
    potTableSteps: 256,
    potVolumeExponent: 2,

    // --- pacing ---
    beatTime: 0.6,              // pause after a serving before the next kid steps up
    beatTimeMin: 0.42,
    beatShrinkPerClass: 0.012,  // lunch break gets busier: the line moves a bit faster later
    // 昼休みのタイマー: a wall clock runs 12:20 → 12:50 during a class; as it runs the line speeds up
    lunchStartMin: 20,          // clock starts at 12:20
    lunchSpanMin: 30,           // ... and reaches 12:50
    lunchSecPerKid: 2.4,        // play seconds per person in line for the clock to reach 12:50
    lunchRush: 0.7,             // beat multiplier once the clock reaches the end
    complainBeatExtra: 0.45,    // extra beat so a complaint can be read
    stepTime: 0.3,              // next kid stepping up
    kidEase: 11,                // how snappily kids walk to their spot in line
    introMinTime: 0.35,
    introAutoStart: 6.0,
    classEndMinTime: 0.9,
    overDuration: { empty: 4.8, meeting: 3.6 },
    overSkipTime: 1.5,
    resultMinTime: 0.6,

    // --- fairness ---
    toleranceByGrade: [0.22, 0.20, 0.18, 0.16, 0.15, 0.15], // allowed difference vs. previous kid (1年 is forgiving)
    guideRingUntilClass: 3,     // 1年 (classes 0-2): dashed ring shows "same as the previous kid" on the plate
    closeMatch: 0.05,           // within this → "そっくり！"
    floorFrac: 0.35,            // below this × fair share is always a complaint ("これだけ！？")
    maxComplaints: 3,           // → 学級会

    // --- class generation ---
    classesPerGrade: 3,
    maxGrade: 6,
    classSizes: [12, 16, 20, 25, 27, 29, 31, 33, 35, 37, 39, 40],
    fairShareMin: 0.85,         // pot holds (fairShare × sum of expectations) servings
    fairShareMax: 1.15,
    fillMin: 0.78,              // pot starts this full (by volume)
    fillMax: 0.92,
    oomoriFrom: 1, oomoriRate: 0.07, oomoriExpect: 2,
    sukunameFrom: 2, sukunameRate: 0.07, sukunameExpect: 0.5,
    teacherFrom: 3, teacherExpect: 3,
    leaveFrom: 4, leaveTwoFrom: 9, leaveWindow: [0.3, 0.7],
    menuIntro: ['curry', 'curry', 'stew', 'curry', 'rice'],
    menuPool: ['curry', 'curry', 'stew', 'rice'],
    shapeCycle: ['zundou', 'marusoko', 'bowl'],

    // --- scoring ---
    evennessZeroCV: 0.35,       // coefficient of variation that maps to 均等度 0
    pittariFrac: 0.02,          // < 2% left → ぴったり
    pittariBonus: 50,
    leftoverPenaltyPerPct: 3,

    // --- plate visuals (blob AREA ∝ amount) ---
    servingRadius: 56,          // px radius of a 1.0-serving blob
    plateR: 122,
    bowlR: 148,
    maxBlobOverPlate: 1.2,

    // --- tutorial / onboarding ---
    firstGuideClasses: 1,       // 1年1組: the very first kid shows a dashed "目安" ring at the fair share
    stepBuffer: true,           // a press that starts while the next kid steps up pours as soon as they're ready
                                // (a press during the beat still never pours: no leaking into the next kid)

    // --- staging / game feel (timing & presentation only; amounts are never touched) ---
    hitStop: 0.1,               // freeze-frame when a complaint lands
    markFlyTime: 0.42,          // the complaint mark flies from the kid to the HUD
    lastCallout: 3,             // "ラスト3人！" banner + heartbeat from this many people left
    heartInterval: 0.9,         // heartbeat period during the last few kids (seconds)
    heartDangerMul: 0.62,       // ... faster when the pot is short
    dangerShare: 0.8,           // pot can only give everyone left < this × the planned share → the line gets nervous
    overshootShout: 0.18,       // pouring this far past the allowed difference → the line shouts 多い多い！
    lastKidZoom: 0.035,         // camera push-in while serving the very last person
    finaleBeat: 1.85,           // last person served and the pot is empty: the scene celebrates before the class card
    finaleDropTime: 0.62,       // ... the "last drop" falls in slow motion, then ぴったり！
    leftoverBeat: 1.15,         // last person served with curry left over: a short "あまった…" beat
    classEndCardDelay: 0.3,     // class card after an in-scene finale (0.7 when there was none)
    crowdRise: 0.45,            // classmates' heads rising from the bottom edge
    emptyZoom: 0.12,            // 鍋が空: slow push-in on the empty plate
    resultPlates: 10            // result screen: how many of the last plates are shown in the 成績表
  };

  var W = CONFIG.W, H = CONFIG.H, DT = CONFIG.DT;
  var TAU = Math.PI * 2, PI = Math.PI;

  // =====================================================================
  // 2. LOOK DATA — palette, layout, text
  // =====================================================================
  var FONT = '"Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", sans-serif';
  var PAL = {
    ink: '#4A3222', ink2: '#3A2A20', inkSoft: '#8A6A4C',
    wall: '#F7EBD3', wainscot: '#E5C9A0', wainscotLine: '#D3B183',
    floor: '#D8A56C', floorLine: '#C48E56',
    counter: '#F2E1C3', counterEdge: '#D9BC92', counterDark: '#C9A577',
    hud: '#FFF6E3', hudLine: '#E9D2AC',
    red: '#E2463A', orange: '#F28C28', blue: '#3D8BD9', green: '#4FA34A', yellow: '#F7C548',
    cream: '#FFFBF1', paper: '#FFFDF6',
    metal: '#A9B3BF', metalDark: '#7B8694', metalLight: '#D7DDE4', potIn: '#4B525C',
    tray: '#A9D19A', trayIn: '#C6E3BA',
    plateRim: '#D6E2EC', plate: '#FFFFFF', plateIn: '#F4F8FB',
    smockLine: '#CCD5DF', cheek: 'rgba(240,120,110,0.33)',
    board: '#3E6A4F', boardFrame: '#B88553', sky: '#C4E6F6'
  };
  var HAIR_COLORS = ['#2B1E17', '#3B2A1F', '#4A3426', '#1E1A1A', '#5A3B26'];
  var SKINS = ['#FAD9BA', '#F5CBA4', '#EEC095', '#F8D2B0'];
  var TIE_COLORS = ['#F06A7A', '#4C9BE8', '#F7B733', '#7BC67B'];
  var APRONS = ['#F4A6B5', '#9ED39A', '#F7C873', '#A9C8F0'];
  var CONFETTI = ['#E2463A', '#F28C28', '#F7C548', '#4FA34A', '#3D8BD9', '#E06FB0'];

  var MENU_LOOK = {
    curry: { name: 'カレー', note: 'ふつうのとろみ。具がごろっと落ちる', color: '#B0601F', dark: '#7F3F12', light: '#D08840', chunks: ['meat', 'potato', 'carrot', 'carrot'], noise: 380, sfxWord: 'とろ〜', mini: '#B0601F', miniEdge: '#7F3F12' },
    stew:  { name: 'シチュー', note: 'さらさら！流れるのが速いよ', color: '#F4E6C8', dark: '#D3BD90', light: '#FFFBEF', chunks: ['carrot', 'potato', 'broccoli'], noise: 760, sfxWord: 'さら〜', mini: '#EBCF95', miniEdge: '#B89A5E' },
    rice:  { name: 'ごはん', note: 'かたまりで落ちるので量がブレる', color: '#FFFDF7', dark: '#D9CFB8', light: '#FFFFFF', chunks: ['rice'], noise: 0, lumpy: true, sfxWord: 'ぼてっ', mini: '#FFFFFF', miniEdge: '#B9AE94' }
  };
  var SHAPE_LOOK = {
    zundou:   { name: '寸胴鍋', note: 'まっすぐな鍋。液面の高さ＝残りの量' },
    marusoko: { name: '丸底鍋', note: '底が丸い！下のほうは見た目より少ない' },
    bowl:     { name: '上が広いボウル', note: '上が広い！上のほうは見た目より多い' }
  };

  var LINES = {
    less: ['えー少なっ！', '少なくない！？', 'ぼくのだけ少ない…'],
    tiny: ['これだけ！？'],
    more: ['あいつだけ多い！', 'ずるーい！', '多くない！？'],
    teacherLess: ['先生の、少なくない…？'],
    teacherMore: ['先生だけ多い！'],
    moreSeenByTeacher: ['ちょっと多くない？'],   // the 先生 is next in line and noticed
    same: ['そっくり！', 'おなじ！', 'ぴったし！'],
    // the line shouting while you keep pouring way too much (picked by position, no RNG)
    shout: ['多い多い多い！', '止めて〜！', 'え、まだ！？', 'ずるい〜！'],
    lastKid: '最後の1人！', lastTeacher: '最後は先生！',
    leftoverKid: 'あまっちゃった…',
    dryUnfair: 'ぴったり…ならず！',
    emptyBoy: 'ぼくの分は…？', emptyGirl: 'わたしの分は…？', emptyTeacher: '先生の分は…？'
  };

  var L = {
    hudH: 120, floorTop: 640, counterTop: 720,
    potCX: 178, potBottom: 744,
    prevX: 190, curX: 520, plateY: 958, trayTop: 828, trayW: 290, trayH: 262,
    ladleX: 484, ladleY: 792,
    labelY: 1126, hintY: 1212,
    slots: [
      { x: 520, y: 598, s: 1.00 },
      { x: 642, y: 548, s: 0.84 },
      { x: 650, y: 450, s: 0.72 },
      { x: 566, y: 412, s: 0.64 },
      { x: 484, y: 384, s: 0.58 },
      { x: 404, y: 358, s: 0.53 },
      { x: 452, y: 302, s: 0.48 },
      { x: 526, y: 284, s: 0.45 },
      { x: 600, y: 268, s: 0.42 },
      { x: 674, y: 254, s: 0.40 },
      { x: 770, y: 240, s: 0.38 }
    ],
    crowdN: 9, crowdS: 0.56,    // classmates peeking up from the bottom edge
    muteBtn: { x: 668, y: 60, r: 34 },
    retryBtn: { x: 56, y: 1086, w: 368, h: 120 },
    shareBtn: { x: 444, y: 1086, w: 220, h: 120 }
  };
  var VISIBLE_SLOTS = L.slots.length - 1;

  // =====================================================================
  // 3. UTILS & SEEDED RNG
  // =====================================================================
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function easeOutBack(t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function approach(cur, target, rate, dt) { return target + (cur - target) * Math.exp(-rate * dt); }
  function sum(arr, f) { var s = 0; for (var i = 0; i < arr.length; i++) s += f ? f(arr[i]) : arr[i]; return s; }

  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function parseSeed(v) {
    if (v == null || v === '') return null;
    var t = String(v).trim();
    if (/^\d+$/.test(t)) return (Number(t) % 4294967296) >>> 0;
    return hashString(t);
  }
  function randomSeed() { return Math.floor(Math.random() * 4294967296) >>> 0; }
  function pick(r, arr) { return arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))]; }

  var PARAMS = (function () {
    var o = {};
    try { new URLSearchParams(window.location.search).forEach(function (v, k) { o[k] = v; }); } catch (e) { /* ignore */ }
    return o;
  })();
  var TEST_MODE = PARAMS.test === '1';
  var SHOT = PARAMS.shot || null;
  var URL_SEED = parseSeed(PARAMS.seed);

  // =====================================================================
  // 4. STORAGE — every access guarded (private mode / blocked storage)
  // =====================================================================
  var KEY_BEST = 'pittariKyushoku.best';
  var KEY_MUTE = 'pittariKyushoku.muted';
  // ?shot= builds fake runs for screenshots: never read or write the player's real
  // best score / mute setting in that mode (it would plant a fake best score).
  var NO_PERSIST = !!SHOT;
  var Store = {
    get: function (key) {
      if (NO_PERSIST) return null;
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    set: function (key, value) {
      if (NO_PERSIST) return false;
      try { window.localStorage.setItem(key, String(value)); return true; } catch (e) { return false; }
    },
    remove: function (key) {
      if (NO_PERSIST) return false;
      try { window.localStorage.removeItem(key); return true; } catch (e) { return false; }
    }
  };
  function loadBest() {
    try {
      var raw = Store.get(KEY_BEST);
      if (!raw) return { score: 0, label: '' };
      var o = JSON.parse(raw);
      return { score: Math.max(0, Number(o.score) || 0), label: String(o.label || '') };
    } catch (e) { return { score: 0, label: '' }; }
  }
  function saveBest(score, label) {
    try { return Store.set(KEY_BEST, JSON.stringify({ score: score, label: label })); } catch (e) { return false; }
  }

  // =====================================================================
  // 5. AUDIO — synthesized with WebAudio, unlocked on first gesture
  // =====================================================================
  var Sfx = {
    ctx: null, master: null, noiseBuf: null, pourNodes: null,
    muted: Store.get(KEY_MUTE) === '1',
    disabled: TEST_MODE || !!SHOT,
    init: function () {
      if (this.disabled || this.ctx) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { this.disabled = true; return; }
        var ctx = new AC();
        this.ctx = ctx;
        this.master = ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.8;
        this.master.connect(ctx.destination);
        var len = Math.floor(ctx.sampleRate * 1.5);
        var buf = ctx.createBuffer(1, len, ctx.sampleRate);
        var d = buf.getChannelData(0), r = mulberry32(777);
        for (var i = 0; i < len; i++) d[i] = r() * 2 - 1;
        this.noiseBuf = buf;
        // continuous "とろ〜" pour loop: band-passed noise with a slow wobble
        var src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 400; bp.Q.value = 1.3;
        var lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
        var lfoGain = ctx.createGain(); lfoGain.gain.value = 110;
        lfo.connect(lfoGain); lfoGain.connect(bp.frequency);
        var g = ctx.createGain(); g.gain.value = 0;
        src.connect(bp); bp.connect(g); g.connect(this.master);
        src.start(); lfo.start();
        this.pourNodes = { bp: bp, g: g, level: 0 };
      } catch (e) { this.disabled = true; this.ctx = null; }
    },
    unlock: function () {
      this.init();
      // 'suspended' before the first gesture; iOS can also leave it 'interrupted' (calls, Siri)
      try {
        if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
          var pr = this.ctx.resume();
          if (pr && pr.catch) pr.catch(function () { /* not allowed yet: retried on the next gesture */ });
        }
      } catch (e) { /* ignore */ }
    },
    setMuted: function (m) {
      this.muted = !!m;
      Store.set(KEY_MUTE, this.muted ? '1' : '0');
      if (this.master) {
        try { this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.02); } catch (e) { /* ignore */ }
      }
    },
    ready: function () { return !!(this.ctx && !this.disabled && !this.muted && this.ctx.state === 'running'); },
    tone: function (f, dur, type, vol, f2, delay) {
      var ctx = this.ctx, t = ctx.currentTime + (delay || 0);
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.05);
    },
    noise: function (dur, vol, ftype, freq, q, delay) {
      var ctx = this.ctx, t = ctx.currentTime + (delay || 0);
      var s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
      var f = ctx.createBiquadFilter(); f.type = ftype || 'bandpass'; f.frequency.value = freq || 1000; f.Q.value = q || 1;
      var g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.master);
      s.start(t, Math.random() * 1.0); s.stop(t + dur + 0.05);
    },
    pour: function (level, freq) {
      if (!this.pourNodes || !this.ctx) return;
      if (Math.abs(level - this.pourNodes.level) < 0.005) return;
      this.pourNodes.level = level;
      try {
        var t = this.ctx.currentTime;
        this.pourNodes.g.gain.setTargetAtTime(level, t, 0.04);
        if (freq) this.pourNodes.bp.frequency.setTargetAtTime(freq, t, 0.05);
      } catch (e) { /* ignore */ }
    },
    play: function (name) {
      if (!this.ready()) return;
      try { if (SOUNDS[name]) SOUNDS[name](this); } catch (e) { /* ignore */ }
    }
  };
  var SOUNDS = {
    tap: function (a) { a.tone(660, 0.08, 'triangle', 0.22, 990); },
    step: function (a) { a.tone(320, 0.07, 'sine', 0.16, 420); },
    plop: function (a) { a.tone(240 + Math.random() * 90, 0.1, 'sine', 0.3, 110); },
    lump: function (a) { a.noise(0.07, 0.22, 'lowpass', 600, 0.7); a.tone(170 + Math.random() * 40, 0.09, 'sine', 0.28, 80); },
    clank: function (a) {
      a.tone(1260, 0.16, 'square', 0.06, 1190); a.tone(2490, 0.12, 'triangle', 0.07, 2400);
      a.noise(0.05, 0.12, 'highpass', 3200, 0.8);
    },
    complain: function (a) { a.tone(330, 0.16, 'sawtooth', 0.1, 220); a.tone(260, 0.28, 'sawtooth', 0.09, 160, 0.15); },
    good: function (a) { a.tone(880, 0.1, 'triangle', 0.18); a.tone(1320, 0.16, 'triangle', 0.16, null, 0.08); },
    ok: function (a) { a.tone(620, 0.08, 'sine', 0.14, 760); },
    leave: function (a) { a.tone(520, 0.22, 'triangle', 0.14, 300); },
    clear: function (a) { [523, 659, 784].forEach(function (f, i) { a.tone(f, 0.22, 'triangle', 0.18, null, i * 0.11); }); },
    pittari: function (a) {
      [523, 659, 784, 1047].forEach(function (f, i) { a.tone(f, 0.28, 'triangle', 0.2, null, i * 0.1); });
      a.tone(1568, 0.5, 'sine', 0.12, null, 0.42);
    },
    clap: function (a) {
      for (var i = 0; i < 34; i++) a.noise(0.05, 0.16 + Math.random() * 0.1, 'bandpass', 1100 + Math.random() * 900, 0.9, 0.2 + Math.random() * 2.0);
    },
    meeting: function (a) { a.tone(98, 1.4, 'sine', 0.4, 82); a.tone(196, 0.9, 'triangle', 0.14, 160); },
    sad: function (a) {
      a.tone(392, 0.4, 'sine', 0.18, 370); a.tone(330, 0.5, 'sine', 0.18, 300, 0.38); a.tone(262, 1.0, 'sine', 0.18, 230, 0.8);
    },
    turn: function (a) { a.noise(0.25, 0.08, 'bandpass', 500, 0.6); },
    end: function (a) { [392, 330, 262].forEach(function (f, i) { a.tone(f, 0.25, 'triangle', 0.14, null, i * 0.14); }); },
    best: function (a) { [659, 784, 988, 1319].forEach(function (f, i) { a.tone(f, 0.22, 'square', 0.07, null, i * 0.09); }); },
    // --- staging ---
    heart: function (a) { a.tone(78, 0.13, 'sine', 0.42, 52); a.tone(70, 0.12, 'sine', 0.3, 48, 0.17); },
    last: function (a) { a.tone(150, 0.3, 'triangle', 0.3, 95); a.noise(0.18, 0.16, 'lowpass', 700, 0.7); a.tone(587, 0.16, 'square', 0.05, null, 0.12); },
    shout: function (a) {
      for (var i = 0; i < 4; i++) {
        a.noise(0.16, 0.1, 'bandpass', 760 + i * 170, 2.2, i * 0.07);
        a.tone(300 + i * 40, 0.14, 'sawtooth', 0.035, 380 + i * 50, i * 0.07);
      }
    },
    stamp: function (a) { a.tone(210, 0.09, 'square', 0.1, 120); a.noise(0.05, 0.1, 'lowpass', 900, 0.8); },
    whistle: function (a) { a.tone(520, 0.55, 'sine', 0.09, 1500); },
    drip: function (a) { a.tone(1500, 0.11, 'sine', 0.26, 650); a.tone(950, 0.14, 'sine', 0.16, 500, 0.06); },
    aww: function (a) { a.tone(520, 0.55, 'triangle', 0.12, 330); a.tone(392, 0.6, 'sine', 0.06, 260, 0.08); },
    quiet: function (a) { a.noise(1.6, 0.045, 'lowpass', 420, 0.5); }
  };

  // =====================================================================
  // 6. POTS & CLASS GENERATION
  // =====================================================================
  // Each shape gives width(h) for h in [0,1] (bottom → top). Volume per height
  // slice ∝ width^exponent, integrated into a lookup table so the drawn liquid
  // level is honest (non-linear for the round-bottom pot and the bowl).
  var SHAPES = {
    zundou: {
      key: 'zundou',
      width: function (h) {
        var c = CONFIG.shapes.zundou.cornerH;
        return h < c ? 0.86 + 0.14 * Math.sqrt(h / c) : 1;
      }
    },
    marusoko: {
      key: 'marusoko',
      width: function (h) {
        var r = CONFIG.shapes.marusoko.roundH;
        if (h >= r) return 1;
        var d = (r - h) / r;
        return Math.max(0.04, Math.sqrt(1 - d * d));
      }
    },
    bowl: {
      key: 'bowl',
      width: function (h) {
        var b = CONFIG.shapes.bowl.bottomW;
        return b + (1 - b) * h;
      }
    }
  };
  function buildPotTable(shape) {
    var N = CONFIG.potTableSteps, cum = new Float64Array(N + 1), e = CONFIG.potVolumeExponent;
    for (var i = 1; i <= N; i++) cum[i] = cum[i - 1] + Math.pow(shape.width((i - 0.5) / N), e) / N;
    var total = cum[N];
    for (var j = 0; j <= N; j++) cum[j] /= total;
    shape.table = cum;
    shape.pxW = CONFIG.shapes[shape.key].pxW;
    shape.pxH = CONFIG.shapes[shape.key].pxH;
    shape.volumeForLevel = function (h) {
      h = clamp(h, 0, 1);
      var f = h * N, i = Math.floor(f);
      if (i >= N) return 1;
      return cum[i] + (cum[i + 1] - cum[i]) * (f - i);
    };
    shape.levelForVolume = function (v) {
      v = clamp(v, 0, 1);
      var lo = 0, hi = N;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= v) lo = mid; else hi = mid; }
      var span = cum[hi] - cum[lo];
      return (lo + (span > 0 ? (v - cum[lo]) / span : 0)) / N;
    };
  }
  Object.keys(SHAPES).forEach(function (k) { buildPotTable(SHAPES[k]); });

  function classLabel(ci) {
    return (Math.floor(ci / CONFIG.classesPerGrade) + 1) + '年' + (ci % CONFIG.classesPerGrade + 1) + '組';
  }
  function makeKid(r, id) {
    return {
      id: id, type: 'normal', expect: 1, teacher: false,
      hair: Math.floor(r() * 6), hairColor: pick(r, HAIR_COLORS), skin: pick(r, SKINS), tie: pick(r, TIE_COLORS),
      blink: r() * 5, expr: 'normal', exprT: 0, bubble: null, look: 0,
      dx: 0, dy: 0, ds: 1, tx: 0, ty: 0, ts: 1, alpha: 1, walkT: 0, moving: false
    };
  }
  function makeClass(ci, seed) {
    var r = mulberry32((seed ^ Math.imul(ci + 1, 0x9E3779B1)) >>> 0);
    var grade = Math.floor(ci / CONFIG.classesPerGrade) + 1;
    var size = CONFIG.classSizes[Math.min(ci, CONFIG.classSizes.length - 1)];
    var shapeKey = CONFIG.shapeCycle[ci % CONFIG.shapeCycle.length];
    var menuKey = ci < CONFIG.menuIntro.length ? CONFIG.menuIntro[ci] : pick(r, CONFIG.menuPool);
    var kids = [];
    for (var i = 0; i < size; i++) kids.push(makeKid(r, i));

    function assign(n, type, expect) {
      for (var j = 0, tries = 0; j < n && tries < 300; tries++) {
        var idx = 1 + Math.floor(r() * (size - 1));
        var k = kids[idx];
        if (k.type !== 'normal') continue;
        if ((kids[idx - 1] && kids[idx - 1].type !== 'normal') || (kids[idx + 1] && kids[idx + 1].type !== 'normal')) continue;
        k.type = type; k.expect = expect; j++;
      }
    }
    if (ci >= CONFIG.oomoriFrom) assign(Math.max(1, Math.round(size * CONFIG.oomoriRate)), 'oomori', CONFIG.oomoriExpect);
    if (ci >= CONFIG.sukunameFrom) assign(Math.max(1, Math.round(size * CONFIG.sukunameRate)), 'sukuname', CONFIG.sukunameExpect);

    var hasTeacher = ci >= CONFIG.teacherFrom;
    if (hasTeacher) {
      var t = makeKid(r, size);
      t.type = 'teacher'; t.teacher = true; t.expect = CONFIG.teacherExpect; t.apron = pick(r, APRONS);
      kids.push(t);
    }
    var nLeave = ci >= CONFIG.leaveTwoFrom ? 2 : ci >= CONFIG.leaveFrom ? 1 : 0;
    var leaves = [];
    for (var n = 0; n < nLeave; n++) {
      var at = Math.floor(size * lerp(CONFIG.leaveWindow[0], CONFIG.leaveWindow[1], r()));
      while (leaves.indexOf(at) >= 0) at++;
      leaves.push(at);
    }
    leaves.sort(function (a, b) { return a - b; });

    var sumW = sum(kids, function (k) { return k.expect; });
    var k = lerp(CONFIG.fairShareMin, CONFIG.fairShareMax, r());
    var V = k * sumW;
    var fill = lerp(CONFIG.fillMin, CONFIG.fillMax, r());
    var look = MENU_LOOK[menuKey];
    var potChunks = [];
    for (var m = 0; m < 64; m++) {
      potChunks.push({ u: r() * 2 - 1, h: r(), type: pick(r, look.chunks), rot: r() * TAU, size: 10 + r() * 8 });
    }
    return {
      ci: ci, label: classLabel(ci), grade: grade, kumi: ci % CONFIG.classesPerGrade + 1,
      size: size, shapeKey: shapeKey, menuKey: menuKey, kids: kids, hasTeacher: hasTeacher, leaves: leaves,
      sumW: sumW, k: k, V: V, fill: fill, capacity: V / fill, potChunks: potChunks,
      tolerance: CONFIG.toleranceByGrade[Math.min(grade - 1, CONFIG.toleranceByGrade.length - 1)],
      oomori: kids.filter(function (q) { return q.type === 'oomori'; }).length,
      sukuname: kids.filter(function (q) { return q.type === 'sukuname'; }).length
    };
  }

  // =====================================================================
  // 7. GAME FLOW
  // =====================================================================
  var G = {
    screen: 'title', t: 0, time: 0, frame: 0, frozen: false,
    runSeed: 0, ci: 0, cls: null,
    queue: [], exiting: [], leavers: [], served: [], leftCount: 0,
    pot: null, curPlate: null, prevPlate: null, oldPlates: [],
    phase: 'ready', phaseT: 0, beatLen: CONFIG.beatTime,
    pour: { active: false, owner: null, t: 0, ph1: 0, ph2: 0, emptyT: 0, scrapeT: 0, flow: 0 },
    complaints: 0, markPop: [], leaveIdx: 0, lunchT: 0,
    runScore: 0, classResults: [], totals: { served: 0, complaints: 0, pittari: 0 },
    overReason: null, overFlags: {}, result: null, lastClassResult: null,
    particles: [], popups: [], shake: 0, toast: null, hintMsg: null, hintT: 0,
    prng: mulberry32(1), vrng: mulberry32(2),
    resultPress: null, errors: [], best: loadBest(),
    // staging (presentation only)
    hitStop: 0, flyers: [], finale: null, crowd: null, heartT: 0, pendingPress: null, shouted: false,
    camZ: 1, camX: 360, camY: 860
  };
  var Input = { pointers: {}, ignore: {}, space: false };

  function lunchProgress() {
    if (!G.cls) return 0;
    return clamp(G.lunchT / (G.cls.kids.length * CONFIG.lunchSecPerKid), 0, 1);
  }
  function beatLength() {
    var base = Math.max(CONFIG.beatTimeMin, CONFIG.beatTime - G.ci * CONFIG.beatShrinkPerClass);
    return base * lerp(1, CONFIG.lunchRush, lunchProgress());
  }
  function slotFor(i, k) {
    var s = L.slots[Math.min(i, L.slots.length - 1)];
    if (k && k.teacher) return { x: s.x, y: s.y - 18 * s.s, s: s.s * 1.12 };
    return s;
  }
  function newPlate(kid) {
    return {
      kid: kid, amount: 0, expect: kid ? kid.expect : 1, bowl: !!(kid && kid.teacher),
      chunks: [], seed: G.vrng() * 100, x: W + 220, tx: L.curX, pop: 0, verdict: null, face: 'normal'
    };
  }
  function heldCount() { return Object.keys(Input.pointers).length + (Input.space ? 1 : 0); }
  function fairShareNow() {
    var w = sum(G.queue, function (k) { return k.expect; });
    return w > 0 ? G.pot.remaining / w : 0;
  }

  function startRun(seed, startCi) {
    G.runSeed = (seed == null ? randomSeed() : seed) >>> 0;
    G.ci = startCi || 0;
    G.runScore = 0; G.classResults = []; G.totals = { served: 0, complaints: 0, pittari: 0 };
    G.result = null; G.overReason = null; G.lastClassResult = null;
    G.prng = mulberry32((G.runSeed ^ 0x51ED270B) >>> 0);
    G.vrng = mulberry32((G.runSeed ^ 0x2545F491) >>> 0);
    G.particles = []; G.popups = []; G.toast = null; G.shake = 0;
    beginClassIntro();
  }
  function resetStaging() {
    G.hitStop = 0; G.flyers = []; G.finale = null; G.crowd = null; G.heartT = 0; G.pendingPress = null; G.shouted = false;
    G.camZ = 1; G.camX = W / 2; G.camY = 860;
  }
  // pause-free instant retry: straight back into 1年1組 (the rules card was seen on the first run)
  function retryRun() {
    Sfx.play('tap');
    startRun(URL_SEED);
    beginPlay();
  }
  function beginClassIntro() {
    var c = makeClass(G.ci, G.runSeed);
    G.cls = c;
    G.queue = c.kids.slice();
    G.queue.forEach(function (k, i) {
      var s = slotFor(i, k);
      k.dx = k.tx = s.x; k.dy = k.ty = s.y; k.ds = k.ts = s.s;
    });
    G.exiting = []; G.leavers = []; G.served = []; G.oldPlates = []; G.leftCount = 0;
    G.pot = { shape: SHAPES[c.shapeKey], capacity: c.capacity, V: c.V, remaining: c.V };
    G.complaints = 0; G.markPop = []; G.leaveIdx = 0; G.lunchT = 0;
    G.prevPlate = null;
    G.curPlate = newPlate(G.queue[0]);
    G.curPlate.x = L.curX;
    G.pour.active = false; G.pour.owner = null;
    G.phase = 'ready'; G.phaseT = 0; G.hintMsg = null; G.hintT = 0;
    resetStaging();
    G.screen = 'intro'; G.t = 0;
  }
  function beginPlay() {
    G.screen = 'play'; G.t = 0; G.phase = 'ready'; G.phaseT = 0;
    Sfx.play('tap');
  }
  function nextClass() {
    if (G.ci + 1 >= CONFIG.classesPerGrade * CONFIG.maxGrade) { toResult('graduate'); return; }
    G.ci++;
    beginClassIntro();
    Sfx.play('tap');
  }

  function startPour(owner) {
    var p = G.pour;
    p.active = true; p.owner = owner; p.t = 0; p.emptyT = 0; p.scrapeT = 0; p.flow = 0;
    p.ph1 = G.prng() * TAU; p.ph2 = G.prng() * TAU;
    G.phase = 'pour'; G.phaseT = 0; G.hintMsg = null;
    G.pendingPress = null; G.shouted = false;
    var ml = MENU_LOOK[G.cls.menuKey];
    popup(ml.sfxWord, L.ladleX + 118, L.ladleY + 40, { size: 32, color: ml.lumpy ? PAL.inkSoft : ml.dark, dur: 0.75, rise: 26 });
  }
  // Way past what the previous kid got (already deep in complaint territory, so it
  // gives nothing away): the line starts shouting, like a stream chat would.
  function checkOvershoot() {
    if (G.shouted || !G.served.length) return;
    var prev = G.served[G.served.length - 1], plate = G.curPlate;
    if (!(prev.norm > 0)) return;
    if (plate.amount / plate.expect < prev.norm * (1 + G.cls.tolerance + CONFIG.overshootShout)) return;
    G.shouted = true;
    var n = 0, spots = [1, 3, 2];
    for (var j = 0; j < spots.length && n < 2; j++) {
      var k = G.queue[spots[j]];
      if (!k || k.bubble) continue;
      k.expr = 'shock'; k.exprT = 1.6;
      k.bubble = { text: LINES.shout[(n + G.served.length) % LINES.shout.length], t: -n * 0.18, dur: 1.5 + n * 0.18, kind: 'shout' };
      n++;
    }
    var front = G.queue[0];
    if (front && !front.teacher) { front.expr = 'happy'; front.exprT = 1.2; }
    if (n) { Sfx.play('shout'); addShake(4); }
  }
  function updatePour(dt) {
    var p = G.pour, mc = CONFIG.menus[G.cls.menuKey], plate = G.curPlate, pot = G.pot;
    p.t += dt;
    var ramp = smoothstep(clamp(p.t / CONFIG.rampTime, 0, 1));
    var wob = 1 + CONFIG.wobble * (0.6 * Math.sin(p.t * TAU * CONFIG.wobbleHz[0] + p.ph1) + 0.4 * Math.sin(p.t * TAU * CONFIG.wobbleHz[1] + p.ph2));
    var rate = CONFIG.baseFlow * mc.flow * mc.cont * ramp * wob;
    var want = rate * dt;
    var chunk = 0;
    if (G.prng() < mc.chunkRate * ramp * dt) chunk = lerp(mc.chunkMin, mc.chunkMax, G.prng());
    var take = Math.min(want + chunk, pot.remaining);
    pot.remaining -= take;
    if (pot.remaining < 1e-9) pot.remaining = 0;
    plate.amount += take;
    p.flow = pot.remaining > 0 ? ramp * wob : 0;
    if (chunk > 0 && take > want * 0.5) spawnFallingChunk(plate, chunk);
    if (take > 0) spawnDrips(plate, ramp);
    checkOvershoot();

    // scraping the bottom: カンカン
    if (pot.remaining / pot.V < CONFIG.scrapeFrac) {
      p.scrapeT -= dt;
      if (p.scrapeT <= 0) {
        p.scrapeT = CONFIG.scrapeInterval;
        Sfx.play('clank');
        addShake(3);
        popup('カン', L.potCX + (G.vrng() - 0.5) * 120, L.potBottom - 60 - G.vrng() * 40, { size: 34, color: '#5F6B7A', dur: 0.5, rise: 40 });
      }
    }
    if (pot.remaining <= 0) {
      p.emptyT += dt;
      if (p.emptyT >= CONFIG.emptyAutoRelease) endPour(true);
    }
  }
  function endPour(forced) {
    var p = G.pour;
    if (!p.active) return;
    p.active = false; p.owner = null; p.flow = 0;
    if (!forced && G.curPlate.amount < CONFIG.minServe && G.pot.remaining > CONFIG.emptyEps) {
      G.phase = 'ready'; G.phaseT = 0;
      G.hintMsg = 'もうすこし長く押してね'; G.hintT = 1.6;
      return;
    }
    finalizeServing();
  }

  function finalizeServing() {
    var kid = G.queue[0], plate = G.curPlate, cls = G.cls;
    var norm = plate.amount / plate.expect;
    var prev = G.served.length ? G.served[G.served.length - 1] : null;
    var verdict = 'ok', ratio = null;
    if (prev && prev.norm > 0) {
      ratio = norm / prev.norm;
      if (ratio < 1 - cls.tolerance) verdict = 'less';
      else if (ratio > 1 + cls.tolerance) verdict = 'more';
      else if (Math.abs(ratio - 1) <= CONFIG.closeMatch) verdict = 'same';
    }
    if (verdict !== 'less' && verdict !== 'more' && norm < CONFIG.floorFrac * cls.k) verdict = 'tiny';
    G.served.push({ id: kid.id, type: kid.type, amount: plate.amount, expect: plate.expect, norm: norm, ratio: ratio, verdict: verdict });
    G.totals.served++;
    plate.verdict = verdict;
    var complained = verdict === 'less' || verdict === 'more' || verdict === 'tiny';

    plate.tag = verdictTag(verdict, ratio);
    if (verdict === 'less' || verdict === 'tiny') {
      kid.expr = kid.teacher ? 'sad' : 'angry'; kid.exprT = 3;
      var lines = kid.teacher ? LINES.teacherLess : verdict === 'tiny' ? LINES.tiny : LINES.less;
      kid.bubble = { text: pick(G.vrng, lines), t: 0, dur: 2.2, kind: 'bad' };
      plate.face = kid.expr;
      addComplaint(kid.dx + 40 * kid.ds, kidHeadTop(kid));
    } else if (verdict === 'more') {
      kid.expr = 'happy'; kid.exprT = 3;
      plate.face = 'happy';
      var who = G.queue[1] || null;
      var text = pick(G.vrng, kid.teacher ? LINES.teacherMore : (who && who.teacher) ? LINES.moreSeenByTeacher : LINES.more);
      if (who) {
        who.expr = 'angry'; who.exprT = 2.6;
        who.bubble = { text: text, t: 0, dur: 2.6, kind: 'bad' };
        addComplaint(who.dx + 40 * who.ds, kidHeadTop(who));
      } else if (G.prevPlate) {
        G.prevPlate.face = 'angry';
        G.prevPlate.bubble = { text: text, t: 0, dur: 2.2, kind: 'bad' };
        addComplaint(G.prevPlate.x - 108, L.trayTop - 30);
      } else {
        addComplaint(plate.x, L.plateY - 120);
      }
    } else if (verdict === 'same') {
      kid.expr = 'happy'; kid.exprT = 3; plate.face = 'happy';
      var lastDrop = G.queue.length === 1 && G.pot.remaining < CONFIG.pittariFrac * G.pot.V;
      var sameLine = pick(G.vrng, LINES.same);
      if (!lastDrop) {   // the last-drop finale stages its own moment
        popup(sameLine, plate.x, L.plateY - 150, { size: 44, color: PAL.orange, dur: 1.0 });
        sparkle(plate.x, L.plateY, 14);
        Sfx.play('good');
      }
    } else {
      kid.expr = 'happy'; kid.exprT = 3; plate.face = 'happy';
      Sfx.play('ok');
    }
    if (G.complaints >= CONFIG.maxComplaints) { startOver('meeting'); return; }
    G.phase = 'beat'; G.phaseT = 0;
    G.beatLen = beatLength() + (complained ? CONFIG.complainBeatExtra : 0);
    if (G.queue.length === 1) beginFinale(kid, plate);
  }
  // Last person served: stage it in the scene before the class card.
  //  pot empty → the last drop falls in slow motion, lands, ぴったり！, the class claps
  //  pot not empty → a short "あまっちゃった…" beat with the leftover shown on the pot
  function beginFinale(kid, plate) {
    var leftFrac = G.pot.V > 0 ? G.pot.remaining / G.pot.V : 0;
    var dry = leftFrac < CONFIG.pittariFrac;
    var pittari = dry && isFairVerdict(plate.verdict);
    var sulky = plate.verdict === 'less' || plate.verdict === 'tiny';
    G.finale = { kind: pittari ? 'pittari' : dry ? 'dry' : 'leftover', t: 0, landed: false, leftFrac: leftFrac, sulky: sulky };
    Sfx.pour(0);
    if (pittari) {
      G.beatLen = Math.max(G.beatLen, CONFIG.finaleBeat);
      Sfx.play('whistle');
      if (!sulky) { kid.expr = 'uru'; kid.exprT = 9; }
    } else if (dry) {
      // pot is empty but the last serving was unfair (e.g. dumped the rest on the last kid): no ぴったり
      G.beatLen = Math.max(G.beatLen, CONFIG.leftoverBeat);
      popup(LINES.dryUnfair, W / 2, 470, { size: 60, color: PAL.blue, dur: 1.5, rise: 20 });
    } else {
      G.beatLen = Math.max(G.beatLen, CONFIG.leftoverBeat);
      Sfx.play('aww');
      popup(LINES.leftoverKid, L.potCX, L.potBottom - G.pot.shape.pxH - 40, { size: 40, color: PAL.blue, dur: 1.5, rise: 20 });
      popup('のこり' + Math.max(1, Math.round(leftFrac * 100)) + '%', L.potCX, L.potBottom - 90, { size: 44, color: '#FFFFFF', dur: 1.5, rise: 10, stroke: PAL.blue });
    }
  }
  function updateFinale(dt) {
    var f = G.finale;
    if (!f) return;
    f.t += dt;
    if (f.kind === 'pittari' && !f.landed && f.t >= CONFIG.finaleDropTime) {
      f.landed = true;
      var kid = G.queue[0], plate = G.curPlate;
      if (plate) { plate.pop = 1; sparkle(plate.x, L.plateY, 22); }
      if (kid && !f.sulky) { kid.expr = 'happy'; kid.exprT = 9; kid.bubble = null; }
      Sfx.play('drip'); Sfx.play('pittari'); Sfx.play('clap');
      confetti(110);
      popup('ぴったり！', W / 2, 470, { size: 128, color: PAL.red, dur: 1.6, rise: 20, pop: true });
      addShake(12);
      G.crowd = { mode: 'clap', t: 0 };
    }
  }
  // ぴったり only counts when the last serving itself was fair
  function isFairVerdict(verdict) { return verdict === 'ok' || verdict === 'same'; }
  function verdictTag(verdict, ratio) {
    if (verdict === 'tiny') return { text: '少なすぎ！', bad: true, t: 0 };
    if (ratio == null) return null;
    var pct = Math.round((ratio - 1) * 100);
    var s = (pct > 0 ? '+' : pct < 0 ? '−' : '±') + Math.abs(pct) + '%';
    if (verdict === 'less' || verdict === 'more') return { text: '前の子と ' + s, bad: true, t: 0 };
    if (verdict === 'same') return { text: 'ほぼ同じ ' + s, bad: false, t: 0 };
    return { text: 'OK ' + s, bad: false, t: 0 };
  }
  // the complaint mark flies from the kid's head into its HUD slot, then stamps in
  function addComplaint(fromX, fromY) {
    G.complaints++;
    G.totals.complaints++;
    var i = G.complaints - 1;
    G.markPop[i] = -CONFIG.markFlyTime; // negative: still flying (counts up to 0, then pops)
    G.flyers.push({ x0: fromX != null ? fromX : W / 2, y0: fromY != null ? fromY : 640, x1: 300 + i * 68, y1: 72, t: 0, dur: CONFIG.markFlyTime });
    G.hitStop = Math.max(G.hitStop, CONFIG.hitStop);
    addShake(14);
    Sfx.play('complain');
  }

  function advanceQueue() {
    var served = G.queue.shift();
    served.tx = -230; served.ty = 640; served.ts = served.ds;
    G.exiting.push(served);
    if (G.prevPlate) { G.prevPlate.tx = -330; G.oldPlates.push(G.prevPlate); }
    G.prevPlate = G.curPlate;
    G.prevPlate.tx = L.prevX;
    G.prevPlate.bubble = null;
    maybeLeave();
    // nobody left: no current plate (it used to stay aliased to prevPlate, so the
    // same plate was moved twice per step and drawn twice)
    if (G.queue.length === 0) { G.curPlate = null; endClass(); return; }
    G.curPlate = newPlate(G.queue[0]);
    if (G.pot.remaining < CONFIG.emptyEps) { startOver('empty'); return; }
    G.phase = 'step'; G.phaseT = 0;
    Sfx.play('step');
    // end-of-line callouts (only in lines long enough for them to mean something)
    var n = G.queue.length;
    if (G.cls.kids.length > CONFIG.lastCallout + 1 && (n === CONFIG.lastCallout || n === 1)) {
      var txt = n === 1 ? (G.queue[0].teacher ? LINES.lastTeacher : LINES.lastKid) : 'ラスト' + n + '人！';
      popup(txt, W / 2, 420, { size: n === 1 ? 64 : 56, color: n === 1 ? PAL.red : PAL.orange, dur: 1.3, rise: 24, pop: true });
      Sfx.play('last');
      addShake(5);
      G.heartT = 0.5;
    }
  }
  function maybeLeave() {
    var c = G.cls;
    if (G.leaveIdx >= c.leaves.length) return;
    if (G.served.length < c.leaves[G.leaveIdx]) return;
    G.leaveIdx++;
    if (G.queue.length < 4) return;
    var cands = [];
    for (var i = 2; i <= Math.min(5, G.queue.length - 2); i++) if (G.queue[i].type === 'normal') cands.push(i);
    if (!cands.length) return;
    // gameplay RNG: who leaves changes the order of 大盛り/少なめ kids in the line
    var idx = pick(G.prng, cands);
    var k = G.queue.splice(idx, 1)[0];
    k.tx = W + 110; k.ty = k.dy - 20; k.ts = k.ds;
    k.expr = 'sad'; k.exprT = 9;
    k.bubble = { text: '早退します…', t: 0, dur: 2.4, kind: 'info' };
    G.leavers.push(k);
    G.leftCount++;
    popup('早退した子がいるよ！', W / 2, 250, { size: 40, color: PAL.blue, dur: 2.2, rise: 30 });
    popup('1人分がちょっと増える', W / 2, 300, { size: 30, color: PAL.ink, dur: 2.2, rise: 30 });
    Sfx.play('leave');
  }

  function computeClassResult() {
    var norms = G.served.map(function (s) { return s.norm; });
    var mean = norms.length ? sum(norms) / norms.length : 0;
    var variance = norms.length ? sum(norms, function (n) { return (n - mean) * (n - mean); }) / norms.length : 0;
    var cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
    var evenness = Math.round(100 * clamp(1 - cv / CONFIG.evennessZeroCV, 0, 1));
    var leftFrac = G.pot.V > 0 ? G.pot.remaining / G.pot.V : 0;
    var last = G.served[G.served.length - 1];
    var pittari = leftFrac < CONFIG.pittariFrac && !!last && isFairVerdict(last.verdict);
    var bonus = pittari ? CONFIG.pittariBonus : 0;
    var penalty = Math.round(leftFrac * 100 * CONFIG.leftoverPenaltyPerPct);
    return {
      ci: G.ci, label: G.cls.label, evenness: evenness, cv: cv, leftFrac: leftFrac, pittari: pittari,
      bonus: bonus, penalty: penalty, score: Math.max(0, evenness + bonus - penalty),
      served: G.served.length, complaints: G.complaints
    };
  }
  function endClass() {
    var r = computeClassResult();
    G.classResults.push(r);
    G.runScore += r.score;
    if (r.pittari) G.totals.pittari++;
    G.lastClassResult = r;
    G.screen = 'classEnd'; G.t = 0; G.phase = 'done';
    Sfx.pour(0);
    var staged = !!(G.finale && G.finale.landed);   // the scene already celebrated (in-scene finale)
    G.finale = null;
    if (r.pittari) {
      if (!staged) {
        Sfx.play('pittari'); Sfx.play('clap');
        confetti(110);
        popup('ぴったり！', W / 2, 470, { size: 120, color: PAL.red, dur: 1.5, rise: 20, pop: true });
        addShake(10);
      }
      if (!G.crowd) G.crowd = { mode: 'clap', t: 0 };
    } else {
      Sfx.play('clear');
    }
    r.staged = staged;
  }
  function startOver(reason) {
    G.screen = 'over'; G.overReason = reason; G.t = 0; G.overFlags = {};
    G.pour.active = false; G.pour.flow = 0;
    G.finale = null; G.pendingPress = null;
    Sfx.pour(0);
    if (reason === 'meeting') {
      G.queue.forEach(function (k) { k.expr = 'angry'; k.exprT = 99; });
    }
  }
  // the kid left with an empty plate (short hair: ぼく, long hair / pigtails: わたし)
  function emptyLine(k) {
    if (k.teacher) return LINES.emptyTeacher;
    return k.hair === 0 || k.hair === 4 ? LINES.emptyBoy : LINES.emptyGirl;
  }
  function updateOver(dt) {
    var f = G.overFlags, t = G.t;
    updateKids(dt); updatePlates(dt);
    if (G.overReason === 'empty') {
      if (!f.a && t > 0.35) { f.a = 1; Sfx.play('clank'); addShake(4); popup('カン', L.potCX - 30, L.potBottom - 70, { size: 38, color: '#5F6B7A', dur: 0.6 }); }
      if (!f.b && t > 0.7) { f.b = 1; Sfx.play('clank'); addShake(4); popup('カン', L.potCX + 30, L.potBottom - 80, { size: 38, color: '#5F6B7A', dur: 0.6 }); }
      if (!f.c && t > 1.2) {
        f.c = 1;
        var k = G.queue[0];
        if (k) { k.expr = 'uru'; k.exprT = 99; k.bubble = { text: emptyLine(k), t: 0, dur: 99, kind: 'sad' }; }
        Sfx.play('sad');
      }
      // the classmates who already ate peek up from the bottom edge (backs first) ...
      if (!f.e && t > 1.75) { f.e = 1; G.crowd = { mode: 'stare', t: 0 }; }
      if (!f.d && t > 2.2) {
        f.d = 1;
        var front = G.queue[0];
        G.queue.forEach(function (q, i) {
          if (i === 0) return;
          q.expr = 'stare'; q.exprT = 99;
          q.look = front ? (front.dx < q.dx ? -1 : 1) : 0;
          if (i >= 2 && i <= 6 && i % 2 === 0) q.bubble = { text: '…', t: -i * 0.08, dur: 99, kind: 'info' };
        });
        Sfx.play('turn');   // ... and the whole class turns around at once
      }
      if (!f.g && t > 2.5) { f.g = 1; Sfx.play('quiet'); }
    } else if (G.overReason === 'meeting') {
      if (!f.a && t > 0.5) { f.a = 1; addShake(20); Sfx.play('meeting'); }
      if (!f.b && t > 0.9) { f.b = 1; G.crowd = { mode: 'angry', t: 0 }; }
    }
    var dur = CONFIG.overDuration[G.overReason] || 3;
    if (t >= dur) toResult();
  }

  function teacherComment(r) {
    if (r.reason === 'graduate') return '6年間おつかれさま！あなたは給食当番の名人です。';
    var head = r.evenness >= 85 ? '盛りつけがとてもていねいでした。' : r.evenness >= 65 ? 'よくがんばりました。' : '';
    if (r.reason === 'empty') return head + '最初に多く入れすぎたかな？鍋の残りと、並んでいる人数をよく見よう。';
    if (r.reason === 'meeting') return head + 'となりのお皿とくらべながら、同じくらいをめざそう。';
    return head + 'また当番をよろしくね。';
  }
  function toResult(reason) {
    if (reason) G.overReason = reason;
    Sfx.pour(0);
    G.pour.active = false;
    var evens = G.classResults.map(function (c) { return c.evenness; });
    var evenness;
    if (evens.length) evenness = Math.round(sum(evens) / evens.length);
    else if (G.served.length > 1) evenness = computeClassResult().evenness;
    else evenness = 0;
    var r = {
      label: G.cls ? G.cls.label : '1年1組', reason: G.overReason || 'empty', score: G.runScore,
      cleared: G.classResults.length, served: G.totals.served, complaints: G.totals.complaints,
      pittari: G.totals.pittari, evenness: evenness
    };
    r.comment = teacherComment(r);
    r.plates = resultPlates();
    var fk = G.queue[0] || (G.cls && G.cls.kids[G.cls.kids.length - 1]) || TITLE_KID;
    r.face = { kid: fk, expr: r.reason === 'empty' ? 'uru' : r.reason === 'meeting' ? 'angry' : 'happy' };
    var prevBest = loadBest();
    var bestScore = Math.max(prevBest.score, G.best.score);
    r.newBest = r.score > bestScore;
    if (r.newBest) { saveBest(r.score, r.label); G.best = { score: r.score, label: r.label }; }
    r.best = Math.max(bestScore, r.score);
    G.result = r;
    G.screen = 'result'; G.t = 0; G.resultPress = null;
    Sfx.play(r.newBest ? 'best' : 'end');
  }
  // The last plates of the final class, for the 成績表: blob area ∝ (amount / expectation)
  // so 大盛り/少なめ compare fairly; an empty plate marks the kid who got nothing.
  function resultPlates() {
    var k = G.cls ? G.cls.k : 1, out = [];
    G.served.forEach(function (s) {
      var bad = s.verdict === 'less' || s.verdict === 'more' || s.verdict === 'tiny';
      out.push({ rel: k > 0 ? s.norm / k : 0, bad: bad, type: s.type });
    });
    if (G.overReason === 'empty' && G.queue.length) out.push({ rel: 0, bad: true, empty: true, type: G.queue[0].type });
    return out.slice(-CONFIG.resultPlates);
  }
  function shareText() {
    var r = G.result;
    if (!r) return '';
    if (r.reason === 'graduate') return 'ぴったり給食当番で6年3組まで完走して卒業した！（スコア' + r.score + '点） #ぴったり給食当番';
    return 'ぴったり給食当番で' + r.label + 'まで行けた！（スコア' + r.score + '点） #ぴったり給食当番';
  }
  function doShare() {
    var text = shareText();
    var done = function (msg) { G.toast = { text: msg, t: 0 }; };
    function legacyCopy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok ? 'コピーしました！' : 'コピーできませんでした');
      } catch (e3) { done('コピーできませんでした'); }
    }
    function copy() {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done('コピーしました！'); }, legacyCopy);
          return;
        }
      } catch (e2) { /* fall through */ }
      legacyCopy();
    }
    try {
      if (navigator.share) {
        navigator.share({ text: text }).then(function () { done('シェアしたよ！'); }, function (err) {
          // the player closed the share sheet: do nothing. Any other failure (not
          // allowed, unsupported data, desktop without a share target): copy instead.
          if (!err || err.name !== 'AbortError') copy();
        });
        return;
      }
    } catch (e) { /* fall through */ }
    copy();
  }

  // ---------- kids & plates movement ----------
  function moveKid(k, dt, rate) {
    var px = k.dx, py = k.dy;
    k.dx = approach(k.dx, k.tx, rate, dt);
    k.dy = approach(k.dy, k.ty, rate, dt);
    k.ds = approach(k.ds, k.ts, rate, dt);
    k.moving = Math.abs(k.dx - px) + Math.abs(k.dy - py) > 0.5;
    if (k.moving) k.walkT += dt;
  }
  function tickKid(k, dt) {
    if (k.exprT > 0) { k.exprT -= dt; if (k.exprT <= 0) { k.exprT = 0; k.expr = 'normal'; k.look = 0; } }
    if (k.bubble) { k.bubble.t += dt; if (k.bubble.t > k.bubble.dur) k.bubble = null; }
  }
  function updateKids(dt) {
    for (var i = 0; i < G.queue.length; i++) {
      var k = G.queue[i], s = slotFor(i, k);
      k.tx = s.x; k.ty = s.y; k.ts = s.s;
      moveKid(k, dt, CONFIG.kidEase);
      tickKid(k, dt);
    }
    G.exiting = G.exiting.filter(function (k) { moveKid(k, dt, 4.2); tickKid(k, dt); return k.dx > -150; });
    G.leavers = G.leavers.filter(function (k) {
      if (k.bubble && k.bubble.t < 0.9) { tickKid(k, dt); return true; } // say it before walking off
      moveKid(k, dt, 2.6); tickKid(k, dt); return k.dx < W + 90;
    });
  }
  function updatePlates(dt) {
    [G.prevPlate, G.curPlate].forEach(function (p) {
      if (!p) return;
      p.x = approach(p.x, p.tx, 10, dt);
      p.pop = Math.max(0, p.pop - dt * 5);
      if (p.bubble) { p.bubble.t += dt; if (p.bubble.t > p.bubble.dur) p.bubble = null; }
      if (p.tag) p.tag.t += dt;
    });
    G.oldPlates = G.oldPlates.filter(function (p) { p.x = approach(p.x, p.tx, 8, dt); return p.x > -220; });
  }

  // ---------- per-step update ----------
  function update(dt) {
    G.frame++;
    // hit-stop: a short freeze-frame when a complaint lands (the world holds still, the shake stays)
    if (G.hitStop > 0) {
      G.hitStop = Math.max(0, G.hitStop - dt);
      Sfx.pour(0);
      return;
    }
    G.t += dt;
    G.time += dt;
    updateFx(dt);
    for (var i = 0; i < G.markPop.length; i++) {
      var m = G.markPop[i];
      if (m < 0) { m += dt; if (m >= 0) { m = 0.0001; Sfx.play('stamp'); } }
      else if (m > 0 && m < 1) m = Math.min(1, m + dt / 0.4);
      G.markPop[i] = m;
    }
    G.flyers = G.flyers.filter(function (f) { f.t += dt; return f.t < f.dur; });
    if (G.crowd) G.crowd.t += dt;
    if (G.hintT > 0) { G.hintT -= dt; if (G.hintT <= 0) G.hintMsg = null; }
    if (G.toast) { G.toast.t += dt; if (G.toast.t > 2.2) G.toast = null; }

    switch (G.screen) {
      case 'title':
        if (G.vrng() < dt * 5) spawnSteam(L.potCX, L.potBottom - SHAPES.zundou.pxH);
        break;
      case 'intro':
        updateKids(dt); updatePlates(dt);
        if (G.t >= CONFIG.introAutoStart) beginPlay();
        break;
      case 'play':
        updatePlay(dt);
        break;
      case 'classEnd':
        updateKids(dt); updatePlates(dt);
        if (G.lastClassResult && G.lastClassResult.pittari && G.vrng() < dt * 6) confetti(2);
        break;
      case 'over':
        updateOver(dt);
        break;
      case 'result':
        break;
    }
    var pouring = G.screen === 'play' && G.phase === 'pour' && !MENU_LOOK[G.cls.menuKey].lumpy;
    Sfx.pour(pouring ? 0.32 * G.pour.flow : 0, G.cls ? MENU_LOOK[G.cls.menuKey].noise : 0);
    updateCamera(dt);
  }
  // Camera push-in (presentation only; no RNG): a touch closer for the very last
  // person, and a slow push onto the empty plate when the pot runs dry.
  function updateCamera(dt) {
    var z = 1, fx = W / 2, fy = 860, rate = 3;
    if (G.screen === 'play' && G.queue.length === 1 && G.cls && G.cls.kids.length > 1) {
      z = 1 + CONFIG.lastKidZoom * (G.finale && G.finale.landed ? 1.6 : 1);
    } else if (G.screen === 'over' && G.overReason === 'empty' && G.t > 1.2) {
      z = 1 + CONFIG.emptyZoom; fx = L.curX - 40; fy = 800; rate = 1.4;
    }
    G.camZ = approach(G.camZ, z, rate, dt);
    G.camX = approach(G.camX, fx, rate, dt);
    G.camY = approach(G.camY, fy, rate, dt);
  }
  function updatePlay(dt) {
    G.phaseT += dt;
    updateKids(dt);
    updatePlates(dt);
    var pot = G.pot;
    if (G.vrng() < dt * 4 * (0.3 + pot.remaining / pot.V)) {
      spawnSteam(L.potCX, L.potBottom - pot.shape.pxH);
    }
    G.lunchT += dt;
    updateFinale(dt);
    updateHeartbeat(dt);
    if (G.phase === 'pour') updatePour(dt);
    else if (G.phase === 'beat') { if (G.phaseT >= G.beatLen) advanceQueue(); }
    else if (G.phase === 'step') {
      if (G.phaseT >= CONFIG.stepTime) {
        G.phase = 'ready'; G.phaseT = 0;
        // a press that began while this kid was stepping up (and is still held) pours now
        var id = G.pendingPress;
        G.pendingPress = null;
        if (id != null && stillHeld(id)) startPour(id);
      }
    }
  }
  function stillHeld(id) { return id === 'key' ? Input.space : !!Input.pointers[id]; }
  // the last few people: a heartbeat under the pour, faster when the pot is short
  function inDanger() {
    if (G.screen !== 'play' || !G.queue.length || !G.cls) return false;
    return fairShareNow() < CONFIG.dangerShare * G.cls.k;
  }
  function updateHeartbeat(dt) {
    var n = G.queue.length;
    if (n === 0 || n > CONFIG.lastCallout || G.finale || (G.phase !== 'ready' && G.phase !== 'pour')) return;
    G.heartT -= dt;
    if (G.heartT <= 0) {
      G.heartT = CONFIG.heartInterval * (inDanger() ? CONFIG.heartDangerMul : 1);
      Sfx.play('heart');
    }
  }

  // ---------- input (shared by DOM events and test hooks) ----------
  function hitMute(x, y) {
    var b = L.muteBtn;
    return x != null && (x - b.x) * (x - b.x) + (y - b.y) * (y - b.y) <= (b.r + 10) * (b.r + 10);
  }
  function inBtn(b, x, y) { return x != null && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }
  function resultButtonAt(x, y) {
    if (inBtn(L.retryBtn, x, y)) return 'retry';
    if (inBtn(L.shareBtn, x, y)) return 'share';
    return null;
  }
  function toggleMute() { Sfx.setMuted(!Sfx.muted); if (!Sfx.muted) Sfx.play('tap'); }

  function pointerDown(x, y, id) {
    Sfx.unlock();
    if (id == null) id = 'p';
    // a new press with this id means any earlier press with it is over (the mouse is
    // always id 1): a stale "ignore" left by a mute press whose release was lost
    // (blur / alt-tab) must not swallow this press's release and leave a pour stuck on
    delete Input.ignore[id];
    if (hitMute(x, y)) { Input.ignore[id] = true; toggleMute(); return; }
    Input.pointers[id] = { x: x, y: y };
    pressStart(x, y, id);
  }
  function pointerMove(x, y, id) {
    if (id == null) id = 'p';
    if (Input.pointers[id]) { Input.pointers[id].x = x; Input.pointers[id].y = y; }
  }
  function pointerUp(x, y, id) {
    if (id == null) id = 'p';
    Sfx.unlock();
    if (Input.ignore[id]) { delete Input.ignore[id]; return; }
    if (!Input.pointers[id]) return;
    delete Input.pointers[id];
    pressEnd(x, y, id);
  }
  function keyDown(code) {
    Sfx.unlock();
    if (code === 'KeyM') { toggleMute(); return; }
    if (code !== 'Space' && code !== 'Enter') return;
    if (code === 'Space') {
      if (Input.space) return;
      Input.space = true;
    }
    if (G.screen === 'result') { if (G.t > CONFIG.resultMinTime) retryRun(); return; }
    pressStart(null, null, code === 'Space' ? 'key' : 'enter');
  }
  function keyUp(code) {
    if (code !== 'Space') return;
    if (!Input.space) return;
    Input.space = false;
    pressEnd(null, null, 'key');
  }
  function releaseAll() {
    Input.ignore = {};
    Object.keys(Input.pointers).forEach(function (id) { pointerUp(null, null, id); });
    if (Input.space) keyUp('Space');
  }

  function pressStart(x, y, id) {
    switch (G.screen) {
      case 'title':
        if (G.t > 0.2) { Sfx.play('tap'); startRun(URL_SEED); }
        break;
      case 'intro':
        if (G.t > CONFIG.introMinTime) beginPlay();
        break;
      case 'play':
        // Only a press that begins while the kid is ready pours. A hold started
        // during the beat never leaks into the next kid. A press that begins while
        // the next kid is already stepping up is remembered and pours once they're ready.
        if (id === 'enter' || G.pour.active) break;
        if (G.phase === 'ready') startPour(id);
        else if (G.phase === 'step' && CONFIG.stepBuffer && G.pendingPress == null) G.pendingPress = id;
        break;
      case 'classEnd':
        if (G.t > CONFIG.classEndMinTime) nextClass();
        break;
      case 'over':
        if (G.t > CONFIG.overSkipTime) toResult();
        break;
      case 'result':
        G.resultPress = resultButtonAt(x, y);
        break;
    }
  }
  function pressEnd(x, y, id) {
    if (G.pendingPress === id) G.pendingPress = null;
    if (G.screen === 'play' && G.pour.active && G.pour.owner === id) { endPour(false); return; }
    if (G.screen === 'result') {
      var b = resultButtonAt(x, y);
      if (b && b === G.resultPress && G.t > CONFIG.resultMinTime) {
        if (b === 'retry') retryRun();
        else if (b === 'share') { Sfx.play('tap'); doShare(); }
      }
      G.resultPress = null;
    }
  }
  function hintKey() {
    if (G.screen !== 'play' || G.finale) return null;
    if (G.phase === 'ready' && !G.pour.active && heldCount() > 0) return 'release';
    if (G.hintMsg) return 'msg';
    if (G.phase === 'ready') return 'hold';
    if (G.phase === 'pour') return 'pouring';
    return 'wait';
  }

  // =====================================================================
  // 8. FX — particles, pop-ups, shake
  // =====================================================================
  function addShake(a) { G.shake = Math.max(G.shake, a); }
  function popup(text, x, y, o) {
    o = o || {};
    G.popups.push({ text: text, x: x, y: y, t: 0, dur: o.dur || 1.2, color: o.color || PAL.ink, size: o.size || 40, rise: o.rise != null ? o.rise : 60, pop: o.pop, stroke: o.stroke });
  }
  function spawnSteam(cx, top) {
    G.particles.push({ type: 'steam', x: cx + (G.vrng() - 0.5) * 140, y: top + 6, vx: (G.vrng() - 0.5) * 14, vy: -40 - G.vrng() * 30, g: 0, life: 1.6, max: 1.6, size: 12 + G.vrng() * 10 });
  }
  function ladleLip() {
    var tilt = 0.55;
    return { x: L.ladleX + Math.cos(tilt) * 42, y: L.ladleY + Math.sin(tilt) * 42 };
  }
  function spawnFallingChunk(plate, amount) {
    var lip = ladleLip(), look = MENU_LOOK[G.cls.menuKey];
    G.particles.push({
      type: 'chunk', chunk: pick(G.vrng, look.chunks), x: lip.x + (G.vrng() - 0.5) * 8, y: lip.y + 4,
      vx: (G.vrng() - 0.5) * 50, vy: 60, g: 2400, life: 2, max: 2, size: look.lumpy ? 26 + amount * 120 : 13 + G.vrng() * 6,
      rot: G.vrng() * TAU, vr: (G.vrng() - 0.5) * 8, plate: plate, landY: L.plateY - 6 + (G.vrng() - 0.5) * 20
    });
  }
  function spawnDrips(plate, ramp) {
    if (MENU_LOOK[G.cls.menuKey].lumpy) return;
    if (G.vrng() > 0.55 * ramp) return;
    var look = MENU_LOOK[G.cls.menuKey];
    var r = Math.min(blobRadius(plate.amount), CONFIG.plateR);
    G.particles.push({
      type: 'drop', x: plate.x + (G.vrng() - 0.5) * 16, y: L.plateY - Math.min(10, r * 0.2),
      vx: (G.vrng() - 0.5) * 260, vy: -120 - G.vrng() * 160, g: 1500, life: 0.35, max: 0.35,
      size: 3 + G.vrng() * 4, color: look.color, edge: look.dark
    });
  }
  function sparkle(x, y, n) {
    for (var i = 0; i < n; i++) {
      var a = G.vrng() * TAU, sp = 120 + G.vrng() * 220;
      G.particles.push({ type: 'spark', x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, g: 300, life: 0.7, max: 0.7, size: 8 + G.vrng() * 8, rot: G.vrng() * TAU, vr: 6 });
    }
  }
  function confetti(n) {
    for (var i = 0; i < n; i++) {
      G.particles.push({
        type: 'confetti', x: G.vrng() * W, y: -20 - G.vrng() * 260, vx: (G.vrng() - 0.5) * 120, vy: 140 + G.vrng() * 240, g: 90,
        life: 3.2 + G.vrng() * 1.5, max: 4.7, size: 10 + G.vrng() * 10, rot: G.vrng() * TAU, vr: (G.vrng() - 0.5) * 10, color: pick(G.vrng, CONFETTI)
      });
    }
  }
  function updateFx(dt) {
    var ps = G.particles, keep = [];
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      p.life -= dt;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.vr) p.rot += p.vr * dt;
      if (p.type === 'steam') { p.size += dt * 14; p.vx *= 0.99; }
      if (p.type === 'confetti') p.vx += Math.sin(G.time * 3 + p.rot) * 30 * dt;
      if (p.type === 'chunk' && p.y >= p.landY) {
        var pl = p.plate;
        if (pl) {
          var a = G.vrng() * TAU, d = Math.sqrt(G.vrng()) * 0.85;
          if (p.chunk !== 'rice') pl.chunks.push({ a: a, d: d, type: p.chunk, rot: p.rot, size: p.size });
          pl.pop = 1;
        }
        Sfx.play(p.chunk === 'rice' ? 'lump' : 'plop');
        continue;
      }
      if (p.life > 0 && p.y < H + 80) keep.push(p);
    }
    G.particles = keep;
    G.popups = G.popups.filter(function (q) { q.t += dt; return q.t < q.dur; });
    G.shake *= Math.exp(-dt * 9);
    if (G.shake < 0.2) G.shake = 0;
  }

  // =====================================================================
  // 9. RENDER: scene pieces
  // =====================================================================
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var renderScale = 1;
  var shakeRng = mulberry32(0x5EED);

  function font(px, weight) { return (weight || '700') + ' ' + px + 'px ' + FONT; }
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function circle(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, TAU); }
  function fillCircle(c, x, y, r, color) { c.fillStyle = color; circle(c, x, y, r); c.fill(); }
  function fillEllipse(c, x, y, rx, ry, rot, color) { c.fillStyle = color; c.beginPath(); c.ellipse(x, y, rx, ry, rot || 0, 0, TAU); c.fill(); }
  function line(c, x1, y1, x2, y2) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
  function text(c, str, x, y, size, color, align, o) {
    o = o || {};
    c.font = font(size, o.weight);
    c.textAlign = align || 'center';
    c.textBaseline = o.baseline || 'middle';
    if (o.stroke) {
      c.lineWidth = o.strokeW || size * 0.2;
      c.strokeStyle = o.stroke;
      c.lineJoin = 'round';
      if (o.maxW) c.strokeText(str, x, y, o.maxW); else c.strokeText(str, x, y);
    }
    c.fillStyle = color;
    if (o.maxW) c.fillText(str, x, y, o.maxW); else c.fillText(str, x, y);
  }
  function wrapText(c, str, maxW) {
    var lines = [], cur = '';
    var noStart = '、。！？」）ー…っゃゅょ';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch === '\n') { lines.push(cur); cur = ''; continue; }
      var test = cur + ch;
      if (c.measureText(test).width > maxW && cur && noStart.indexOf(ch) < 0) { lines.push(cur); cur = ch; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function blobRadius(amount) { return CONFIG.servingRadius * Math.sqrt(Math.max(0, amount)); }

  function drawBackground(c, menuKey) {
    // wall
    c.fillStyle = PAL.wall; c.fillRect(0, 0, W, L.floorTop);
    // window
    c.fillStyle = '#FFFFFF'; rr(c, 330, 136, 372, 214, 12); c.fill();
    c.fillStyle = PAL.sky; c.fillRect(342, 148, 348, 190);
    fillEllipse(c, 430, 210, 46, 18, 0, '#FFFFFF');
    fillEllipse(c, 468, 198, 34, 16, 0, '#FFFFFF');
    fillEllipse(c, 612, 262, 40, 14, 0, '#FFFFFF');
    c.fillStyle = '#FFFFFF'; c.fillRect(512, 148, 8, 190); c.fillRect(342, 240, 348, 6);
    // menu board (こんだて)
    c.fillStyle = PAL.boardFrame; rr(c, 22, 140, 270, 182, 14); c.fill();
    c.fillStyle = PAL.board; rr(c, 32, 150, 250, 162, 8); c.fill();
    text(c, 'きょうのこんだて', 157, 182, 22, 'rgba(255,255,255,0.85)');
    if (menuKey) {
      var ml = MENU_LOOK[menuKey];
      text(c, ml.name, 157, 236, 46, '#FFFFFF');
      text(c, 'ぎゅうにゅう・サラダ', 157, 288, 18, 'rgba(255,255,255,0.7)');
    }
    // wainscot
    c.fillStyle = PAL.wainscot; c.fillRect(0, 560, W, L.floorTop - 560);
    c.strokeStyle = PAL.wainscotLine; c.lineWidth = 3;
    line(c, 0, 562, W, 562);
    for (var x = 40; x < W; x += 80) line(c, x, 566, x, L.floorTop);
    // floor
    c.fillStyle = PAL.floor; c.fillRect(0, L.floorTop, W, L.counterTop - L.floorTop);
    c.strokeStyle = PAL.floorLine; c.lineWidth = 3;
    line(c, 0, L.floorTop + 26, W, L.floorTop + 26); line(c, 0, L.floorTop + 54, W, L.floorTop + 54);
    for (var fx = 60; fx < W; fx += 150) { line(c, fx, L.floorTop, fx, L.floorTop + 26); line(c, fx + 75, L.floorTop + 26, fx + 75, L.floorTop + 54); }
  }
  function drawCounter(c) {
    c.fillStyle = PAL.counter; c.fillRect(0, L.counterTop, W, H - L.counterTop);
    c.fillStyle = PAL.counterEdge; c.fillRect(0, L.counterTop, W, 16);
    c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(0, L.counterTop + 16, W, 4);
    c.fillStyle = PAL.counterDark; c.fillRect(0, H - 18, W, 18);
    // subtle wood grain
    c.strokeStyle = 'rgba(190,150,100,0.18)'; c.lineWidth = 2;
    for (var y = L.counterTop + 60; y < H - 30; y += 72) {
      c.beginPath(); c.moveTo(0, y);
      for (var x = 0; x <= W; x += 60) c.lineTo(x, y + Math.sin(x * 0.02 + y) * 6);
      c.stroke();
    }
  }

  // ---------- kids ----------
  function drawSweat(c, x, y, s) {
    c.fillStyle = '#7EC8F0';
    c.beginPath();
    c.moveTo(x, y - s);
    c.quadraticCurveTo(x + s * 0.85, y + s * 0.25, x, y + s * 0.65);
    c.quadraticCurveTo(x - s * 0.85, y + s * 0.25, x, y - s);
    c.fill();
  }
  function drawAnger(c, x, y, r, color) {
    c.save(); c.translate(x, y);
    c.strokeStyle = color; c.lineWidth = r * 0.3; c.lineCap = 'round';
    for (var i = 0; i < 4; i++) {
      c.save(); c.rotate(i * PI / 2);
      c.beginPath(); c.arc(r * 0.95, r * 0.95, r * 0.62, PI * 1.02, PI * 1.48); c.stroke();
      c.restore();
    }
    c.restore();
  }
  function drawFace(c, expr, look, blink) {
    var lx = (look || 0) * 7;
    fillEllipse(c, -31, 24, 10, 6, 0, PAL.cheek);
    fillEllipse(c, 31, 24, 10, 6, 0, PAL.cheek);
    c.fillStyle = PAL.ink2; c.strokeStyle = PAL.ink2; c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = 4.5;
    if (expr === 'happy' || expr === 'clap') {
      c.beginPath(); c.arc(-17, 13, 7, PI * 1.15, PI * 1.85); c.stroke();
      c.beginPath(); c.arc(17, 13, 7, PI * 1.15, PI * 1.85); c.stroke();
      c.fillStyle = '#C8483C';
      c.beginPath(); c.moveTo(-11, 23); c.quadraticCurveTo(0, 41, 11, 23); c.closePath(); c.fill();
    } else if (expr === 'angry') {
      fillCircle(c, -17 + lx, 11, 5, PAL.ink2); fillCircle(c, 17 + lx, 11, 5, PAL.ink2);
      line(c, -28, -1, -9, 5); line(c, 28, -1, 9, 5);
      c.beginPath(); c.arc(0, 38, 9, PI * 1.2, PI * 1.8); c.stroke();
    } else if (expr === 'sad' || expr === 'uru') {
      if (expr === 'uru') {
        fillCircle(c, -17, 11, 9.5, PAL.ink2); fillCircle(c, 17, 11, 9.5, PAL.ink2);
        fillCircle(c, -20, 7, 3.6, '#FFFFFF'); fillCircle(c, 14, 7, 3.6, '#FFFFFF');
        fillCircle(c, -14, 15, 1.8, '#FFFFFF'); fillCircle(c, 20, 15, 1.8, '#FFFFFF');
      } else {
        fillCircle(c, -17, 11, 5, PAL.ink2); fillCircle(c, 17, 11, 5, PAL.ink2);
      }
      c.lineWidth = 4;
      line(c, -27, 0, -10, -5); line(c, 27, 0, 10, -5);
      c.beginPath(); c.moveTo(-9, 31); c.quadraticCurveTo(-4.5, 26, 0, 31); c.quadraticCurveTo(4.5, 36, 9, 31); c.stroke();
      drawSweat(c, -24, 30, 6); drawSweat(c, 24, 30, 6);
    } else if (expr === 'shock') {
      fillCircle(c, -17, 11, 9, '#FFFFFF'); fillCircle(c, 17, 11, 9, '#FFFFFF');
      c.lineWidth = 3; circle(c, -17, 11, 9); c.stroke(); circle(c, 17, 11, 9); c.stroke();
      fillCircle(c, -17, 11, 3.5, PAL.ink2); fillCircle(c, 17, 11, 3.5, PAL.ink2);
      fillEllipse(c, 0, 31, 7, 9, 0, PAL.ink2);
    } else if (expr === 'stare') {
      fillCircle(c, -17 + lx, 11, 5.5, PAL.ink2); fillCircle(c, 17 + lx, 11, 5.5, PAL.ink2);
      line(c, -7 + lx * 0.4, 30, 7 + lx * 0.4, 30);
    } else if (expr === 'worry') {
      // nervous: raised inner brows, small wavy mouth (the line watching an almost-empty pot)
      fillCircle(c, -17, 12, 5, PAL.ink2); fillCircle(c, 17, 12, 5, PAL.ink2);
      c.lineWidth = 3.5;
      line(c, -26, 0, -11, -4); line(c, 26, 0, 11, -4);
      c.beginPath(); c.moveTo(-8, 30); c.quadraticCurveTo(-4, 26, 0, 30); c.quadraticCurveTo(4, 34, 8, 30); c.stroke();
    } else {
      if (blink) { line(c, -23, 11, -11, 11); line(c, 11, 11, 23, 11); }
      else { fillCircle(c, -17 + lx, 11, 5.5, PAL.ink2); fillCircle(c, 17 + lx, 11, 5.5, PAL.ink2); }
      c.beginPath(); c.arc(0, 19, 9, PI * 0.2, PI * 0.8); c.stroke();
    }
  }
  function fillRR(c, x, y, w, h, r, color) { c.fillStyle = color; rr(c, x, y, w, h, r); c.fill(); }

  function drawKid(c, k, x, y, s, o) {
    o = o || {};
    var expr = o.expr || k.expr || 'normal';
    var blink = expr === 'normal' && ((G.time + k.blink) % 3.7) < 0.13;
    c.save();
    c.translate(x, y);
    c.scale(s, s);
    if (o.alpha != null) c.globalAlpha *= clamp(o.alpha, 0, 1);
    if (k.teacher) { drawTeacherFigure(c, k, expr, o, blink); c.restore(); return; }
    var hc = k.hairColor;
    // back hair
    if (k.hair === 1) fillRR(c, -58, -20, 116, 74, 28, hc);
    else if (k.hair === 5) fillRR(c, -57, -20, 114, o.headOnly ? 78 : 120, 32, hc);
    else if (k.hair === 3) fillEllipse(c, 58, 14, 15, 32, -0.5, hc);
    else if (k.hair === 2) { fillEllipse(c, -63, 22, 15, 22, 0.3, hc); fillEllipse(c, 63, 22, 15, 22, -0.3, hc); }
    if (!o.headOnly) {
      // smock body
      c.fillStyle = '#FFFFFF'; c.strokeStyle = PAL.smockLine; c.lineWidth = 3.5;
      c.beginPath();
      c.moveTo(-34, 38);
      c.bezierCurveTo(-60, 44, -72, 70, -74, 120);
      c.lineTo(-80, 240); c.lineTo(80, 240); c.lineTo(74, 120);
      c.bezierCurveTo(72, 70, 60, 44, 34, 38);
      c.closePath(); c.fill(); c.stroke();
      c.beginPath(); c.moveTo(-22, 42); c.lineTo(0, 68); c.lineTo(22, 42); c.stroke();
      fillCircle(c, 0, 150, 4, PAL.smockLine); fillCircle(c, 0, 186, 4, PAL.smockLine);
      if (o.tray) {
        fillRR(c, -76, 94, 152, 36, 10, PAL.tray);
        fillEllipse(c, -22, 108, 28, 10, 0, '#FFFFFF');
        fillEllipse(c, 32, 108, 18, 8, 0, '#F1F1F1');
        fillCircle(c, -76, 112, 12, k.skin); fillCircle(c, 76, 112, 12, k.skin);
      }
    }
    // ears + head
    fillCircle(c, -49, 8, 10, k.skin); fillCircle(c, 49, 8, 10, k.skin);
    fillCircle(c, 0, 0, 50, k.skin);
    // side hair under the cap
    if (k.hair === 0 || k.hair === 2 || k.hair === 3) { fillRR(c, -52, -12, 13, 26, 6, hc); fillRR(c, 39, -12, 13, 26, 6, hc); }
    else if (k.hair === 1) { fillRR(c, -56, -12, 17, 54, 8, hc); fillRR(c, 39, -12, 17, 54, 8, hc); }
    else if (k.hair === 5) { fillRR(c, -56, -12, 16, 70, 8, hc); fillRR(c, 40, -12, 16, 70, 8, hc); }
    else if (k.hair === 4) {
      c.fillStyle = hc;
      c.beginPath(); c.moveTo(-50, -10); c.lineTo(-68, 0); c.lineTo(-50, 6); c.lineTo(-64, 16); c.lineTo(-46, 18); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(50, -10); c.lineTo(68, 0); c.lineTo(50, 6); c.lineTo(64, 16); c.lineTo(46, 18); c.closePath(); c.fill();
    }
    if (k.hair === 2) { fillCircle(c, -54, 12, 6, k.tie); fillCircle(c, 54, 12, 6, k.tie); }
    if (k.hair === 3) fillCircle(c, 50, 0, 6, k.tie);
    // 給食帽
    c.fillStyle = '#FFFFFF'; c.strokeStyle = PAL.smockLine; c.lineWidth = 3.5;
    c.beginPath(); c.moveTo(-54, -6); c.bezierCurveTo(-64, -76, 64, -76, 54, -6); c.closePath(); c.fill(); c.stroke();
    rr(c, -55, -18, 110, 16, 7); c.fill(); c.stroke();
    // face
    drawFace(c, expr, o.look != null ? o.look : k.look, blink);
    if (expr === 'angry') drawAnger(c, 44, -44, 17, PAL.red);
    if (expr === 'stare' || expr === 'shock' || expr === 'worry') drawSweat(c, 52, -4, 9);
    if (o.clap != null) {
      var sp = Math.abs(Math.sin(o.clap));
      fillCircle(c, -14 - sp * 16, 56, 12, k.skin); fillCircle(c, 14 + sp * 16, 56, 12, k.skin);
    }
    c.restore();
  }
  function drawTeacherFigure(c, k, expr, o, blink) {
    if (!o.headOnly) {
      c.fillStyle = '#8DB7E0';
      c.beginPath();
      c.moveTo(-38, 40); c.bezierCurveTo(-70, 46, -84, 80, -86, 130); c.lineTo(-92, 270); c.lineTo(92, 270); c.lineTo(86, 130);
      c.bezierCurveTo(84, 80, 70, 46, 38, 40); c.closePath(); c.fill();
      fillRR(c, -56, 70, 112, 200, 22, k.apron);
      c.strokeStyle = 'rgba(0,0,0,0.12)'; c.lineWidth = 4;
      line(c, -40, 70, -24, 44); line(c, 40, 70, 24, 44);
      if (o.tray) {
        c.fillStyle = '#B9783F';
        c.beginPath(); c.ellipse(0, 104, 78, 46, 0, 0, PI); c.closePath(); c.fill();
        fillEllipse(c, 0, 104, 78, 16, 0, '#E5B47E');
        fillCircle(c, -80, 112, 13, k.skin); fillCircle(c, 80, 112, 13, k.skin);
      }
    }
    if (k.hair % 2 === 0) fillCircle(c, 0, -56, 22, k.hairColor);
    fillCircle(c, -47, 8, 10, k.skin); fillCircle(c, 47, 8, 10, k.skin);
    fillCircle(c, 0, 0, 48, k.skin);
    c.fillStyle = k.hairColor;
    c.beginPath();
    c.moveTo(-50, 10); c.bezierCurveTo(-60, -70, 60, -70, 50, 10);
    c.quadraticCurveTo(36, -24, 6, -20); c.quadraticCurveTo(-20, -30, -50, 10);
    c.fill();
    drawFace(c, expr, o.look != null ? o.look : k.look, blink);
    c.strokeStyle = '#5A4636'; c.lineWidth = 3;
    circle(c, -17, 11, 13); c.stroke(); circle(c, 17, 11, 13); c.stroke();
    line(c, -4, 9, 4, 9);
    if (expr === 'angry') drawAnger(c, 42, -42, 17, PAL.red);
  }
  function drawTag(c, str, x, y, bg, size) {
    size = size || 20;
    c.font = font(size);
    var w = c.measureText(str).width + size * 0.9, h = size * 1.5;
    fillRR(c, x - w / 2, y - h / 2, w, h, h / 2, bg);
    c.strokeStyle = '#FFFFFF'; c.lineWidth = 2.5; rr(c, x - w / 2, y - h / 2, w, h, h / 2); c.stroke();
    text(c, str, x, y + 1, size, '#FFFFFF');
  }
  function kidTagInfo(k) {
    if (k.type === 'oomori') return { text: '大盛り', bg: PAL.red };
    if (k.type === 'sukuname') return { text: '少なめ', bg: PAL.blue };
    if (k.type === 'teacher') return { text: '先生', bg: PAL.green };
    return null;
  }
  function drawBubble(c, str, x, y, o) {
    o = o || {};
    var size = o.size || 30;
    c.font = font(size);
    var tw = c.measureText(str).width, pw = tw + size * 1.2, ph = size * 1.85;
    var bx = clamp(x - pw / 2, 10, W - 10 - pw), by = y - ph - 14;
    var sc = o.scale != null ? o.scale : 1;
    var bg = o.bg || '#FFFFFF', border = o.border || PAL.ink;
    c.save();
    c.globalAlpha *= o.alpha != null ? o.alpha : 1;
    c.translate(x, y); c.scale(sc, sc); c.translate(-x, -y);
    var tx = clamp(x, bx + 22, bx + pw - 22);
    c.fillStyle = bg; c.strokeStyle = border; c.lineWidth = 4; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(tx - 11, by + ph - 2); c.lineTo(x, y); c.lineTo(tx + 11, by + ph - 2); c.closePath(); c.fill(); c.stroke();
    rr(c, bx, by, pw, ph, ph / 2.2); c.fill(); c.stroke();
    c.fillStyle = bg; c.fillRect(tx - 9, by + ph - 6, 18, 8);
    text(c, str, bx + pw / 2, by + ph / 2 + 1, size, o.color || PAL.ink);
    c.restore();
  }
  function bubbleStyle(b) {
    var a = b.t < 0 ? 0 : Math.min(1, (b.dur - b.t) / 0.25);
    var sc = b.t < 0 ? 0 : easeOutBack(clamp(b.t / 0.22, 0, 1));
    if (b.kind === 'bad') return { bg: '#FFF1EE', border: PAL.red, color: PAL.red, alpha: a, scale: sc, size: 32 };
    if (b.kind === 'sad') return { bg: '#FFFFFF', border: PAL.ink, color: PAL.ink, alpha: a, scale: sc, size: 36 };
    if (b.kind === 'shout') return { bg: '#FFF7D6', border: PAL.orange, color: '#C25E0A', alpha: a, scale: sc * (1 + 0.05 * Math.sin(b.t * 30)), size: 30 };
    if (b.kind === 'good') return { bg: '#FFFFFF', border: PAL.red, color: PAL.red, alpha: a, scale: sc, size: 36 };
    if (b.kind === 'ask') return { bg: '#FFFFFF', border: PAL.inkSoft, color: PAL.ink, alpha: a, scale: sc, size: 26 };
    return { bg: '#FFFFFF', border: PAL.inkSoft, color: PAL.ink, alpha: a, scale: sc, size: 28 };
  }
  function kidHeadTop(k) { return k.dy - (k.teacher ? 62 : 66) * k.ds; }

  function drawQueue(c) {
    // leavers & exiting kids behind everyone else
    G.leavers.forEach(function (k) {
      var a = clamp((W + 90 - k.dx) / 160, 0, 1);
      drawKid(c, k, k.dx, k.dy + walkBob(k), k.ds, { tray: true, alpha: a });
    });
    var n = Math.min(G.queue.length, VISIBLE_SLOTS);
    // the pot can't feed everyone left: the front kid holds out the tray with teary eyes,
    // the next few watch nervously (only while nobody is reacting to something else)
    var danger = inDanger() && !G.finale && (G.phase === 'ready' || G.phase === 'pour' || G.phase === 'step');
    for (var i = n - 1; i >= 0; i--) {
      var k = G.queue[i];
      var front = i === 0;
      var o = { tray: !front || k.moving };
      var tremble = 0;
      if (danger && k.expr === 'normal' && !k.moving) {
        if (front) { o.expr = 'uru'; tremble = Math.sin(G.time * 38) * 1.6; }
        else if (i <= 4) { o.expr = 'worry'; o.look = -1; }
      }
      // the last kid hops for joy when the last drop lands
      var hop = front && G.finale && G.finale.landed ? -Math.abs(Math.sin(G.finale.t * 9)) * 14 : 0;
      drawKid(c, k, k.dx + tremble, k.dy + walkBob(k) + hop, k.ds, o);
      var tag = kidTagInfo(k);
      if (tag && !front) drawTag(c, tag.text, k.dx, kidHeadTop(k) - 14 * k.ds - 6, tag.bg, 21 + 4 * k.ds);
    }
    G.exiting.forEach(function (k) { drawKid(c, k, k.dx, k.dy + walkBob(k), k.ds, { tray: true }); });
  }
  function walkBob(k) { return k.moving ? -Math.abs(Math.sin(k.walkT * 14)) * 8 * k.ds : 0; }
  function drawFrontArms(c, k, plate, handsOnly, force) {
    if (!k || !plate || (!force && G.queue[0] !== k)) return;
    if (Math.abs(k.dx - L.slots[0].x) > 30 || Math.abs(plate.x - L.curX) > 40) return;
    var s = k.ds, bowl = plate.bowl;
    var hx = bowl ? CONFIG.bowlR + 4 : L.trayW / 2 - 6;
    var hy = bowl ? L.plateY - 10 : L.trayTop + 30;
    var sides = [-1, 1];
    for (var i = 0; i < 2; i++) {
      var sd = sides[i];
      var sx = k.dx + sd * 64 * s, sy = k.dy + 104 * s;
      var ex = plate.x + sd * hx, ey = hy;
      if (!handsOnly) {
        c.lineCap = 'round';
        c.strokeStyle = k.teacher ? '#6E9CCB' : PAL.smockLine; c.lineWidth = 36 * s + 4; line(c, sx, sy, ex, ey - 6);
        c.strokeStyle = k.teacher ? '#8DB7E0' : '#FFFFFF'; c.lineWidth = 36 * s; line(c, sx, sy, ex, ey - 6);
      } else {
        fillCircle(c, ex, ey, 16, k.skin);
      }
    }
  }

  // ---------- pot ----------
  function drawChunk(c, type, x, y, size, rot) {
    c.save(); c.translate(x, y); c.rotate(rot || 0);
    var s = size;
    if (type === 'carrot') { fillRR(c, -s / 2, -s / 2, s, s, s * 0.25, '#F08A24'); fillRR(c, -s / 2, -s / 2, s, s * 0.35, s * 0.2, '#F7A650'); }
    else if (type === 'potato') { fillRR(c, -s * 0.6, -s / 2, s * 1.2, s, s * 0.35, '#F1D27C'); fillRR(c, -s * 0.5, -s / 2, s, s * 0.3, s * 0.2, '#F8E3A6'); }
    else if (type === 'meat') { fillEllipse(c, 0, 0, s * 0.65, s * 0.42, 0, '#6E3518'); fillEllipse(c, -s * 0.15, -s * 0.12, s * 0.3, s * 0.14, 0, '#8E4D2A'); }
    else if (type === 'broccoli') {
      fillRR(c, -s * 0.12, 0, s * 0.24, s * 0.5, 3, '#8CC56E');
      fillCircle(c, -s * 0.25, -s * 0.05, s * 0.3, '#4E9A3A'); fillCircle(c, s * 0.25, -s * 0.05, s * 0.3, '#4E9A3A'); fillCircle(c, 0, -s * 0.3, s * 0.32, '#5BAA45');
    } else if (type === 'rice') {
      fillEllipse(c, 0, 0, s * 0.55, s * 0.45, 0, '#FFFFFF');
      c.strokeStyle = '#DCD3BE'; c.lineWidth = 2; c.beginPath(); c.ellipse(0, 0, s * 0.55, s * 0.45, 0, 0, TAU); c.stroke();
      fillEllipse(c, -s * 0.15, -s * 0.1, s * 0.12, s * 0.06, 0.5, '#EFE8D8'); fillEllipse(c, s * 0.18, s * 0.08, s * 0.12, s * 0.06, -0.4, '#EFE8D8');
    }
    c.restore();
  }
  function potProfilePath(c, shape, cx, by, inflate) {
    var N = 40, Wp = shape.pxW / 2, Hp = shape.pxH;
    c.beginPath();
    for (var i = N; i >= 0; i--) {
      var h = i / N, w = shape.width(h) * Wp + (inflate || 0);
      if (i === N) c.moveTo(cx - w, by - h * Hp); else c.lineTo(cx - w, by - h * Hp);
    }
    for (var j = 0; j <= N; j++) {
      var h2 = j / N, w2 = shape.width(h2) * Wp + (inflate || 0);
      c.lineTo(cx + w2, by - h2 * Hp);
    }
  }
  // opt: { shape, frac (0..1 of capacity), menuKey, cx, bottom, chunks, chunkShow (0..1), agitate }
  function drawPot(c, o) {
    var sh = o.shape, cx = o.cx, by = o.bottom, Hp = sh.pxH, Wp = sh.pxW / 2, top = by - Hp;
    var look = MENU_LOOK[o.menuKey || 'curry'];
    // stand shadow
    fillEllipse(c, cx + 6, by + 14, Wp * 0.95, 14, 0, 'rgba(90,60,30,0.18)');
    // interior
    potProfilePath(c, sh, cx, by, 0); c.closePath();
    c.fillStyle = PAL.potIn; c.fill();
    // liquid
    var level = sh.levelForVolume(o.frac);
    if (o.frac > 0.0005) {
      c.save();
      potProfilePath(c, sh, cx, by, 0); c.closePath(); c.clip();
      var ly = by - level * Hp, amp = 2 + 4 * (o.agitate || 0), t = G.time;
      c.beginPath();
      c.moveTo(cx - Wp - 20, by + 20);
      for (var x = -Wp - 20; x <= Wp + 20; x += 10) {
        c.lineTo(cx + x, ly + Math.sin(x * 0.045 + t * 2.6) * amp + Math.sin(x * 0.11 - t * 3.3) * amp * 0.4);
      }
      c.lineTo(cx + Wp + 20, by + 20);
      c.closePath();
      c.fillStyle = look.color; c.fill();
      // surface highlight
      c.strokeStyle = look.light; c.lineWidth = 6; c.globalAlpha = 0.7;
      c.beginPath();
      for (var x2 = -Wp; x2 <= Wp; x2 += 10) {
        var yy = ly + 5 + Math.sin(x2 * 0.045 + t * 2.6) * amp + Math.sin(x2 * 0.11 - t * 3.3) * amp * 0.4;
        if (x2 === -Wp) c.moveTo(cx + x2, yy); else c.lineTo(cx + x2, yy);
      }
      c.stroke();
      c.globalAlpha = 1;
      // chunks floating in the liquid
      var chunks = o.chunks || [];
      var show = Math.floor(chunks.length * clamp(o.chunkShow != null ? o.chunkShow : 1, 0, 1));
      for (var i = 0; i < show; i++) {
        var ch = chunks[i];
        var hh = ch.h * level * 0.96;
        var wy = by - hh * Hp + 8;
        var ww = sh.width(hh) * Wp - 16;
        if (ww < 6) continue;
        var bob = Math.sin(t * 2 + i) * 2;
        drawChunk(c, look.lumpy ? 'rice' : ch.type, cx + ch.u * ww, wy + bob, look.lumpy ? ch.size * 0.9 : ch.size, ch.rot);
      }
      c.restore();
    }
    // height ticks on the inner wall (heights, not volumes!)
    c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 3;
    for (var k = 1; k < 10; k++) {
      var th = k / 10, tw = sh.width(th) * Wp;
      line(c, cx - tw + 4, by - th * Hp, cx - tw + (k % 5 === 0 ? 26 : 14), by - th * Hp);
    }
    // wall
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.strokeStyle = PAL.metalDark; c.lineWidth = 26;
    potProfilePath(c, sh, cx, by, 6); c.stroke();
    c.strokeStyle = PAL.metal; c.lineWidth = 18;
    potProfilePath(c, sh, cx, by, 6); c.stroke();
    c.strokeStyle = PAL.metalLight; c.lineWidth = 4;
    potProfilePath(c, sh, cx, by, 3); c.stroke();
    // rim + handles
    var tw2 = sh.width(1) * Wp;
    fillRR(c, cx - tw2 - 24, top - 12, 30, 18, 8, PAL.metalDark);
    fillRR(c, cx + tw2 - 6, top - 12, 30, 18, 8, PAL.metalDark);
    c.strokeStyle = PAL.metalDark; c.lineWidth = 9;
    c.beginPath(); c.arc(cx - tw2 - 16, top + 40, 20, PI * 0.5, PI * 1.5); c.stroke();
    c.beginPath(); c.arc(cx + tw2 + 16, top + 40, 20, -PI * 0.5, PI * 0.5); c.stroke();
  }

  // ---------- plates ----------
  function drawBlob(c, x, y, plate, look, maxR) {
    var r = Math.min(blobRadius(plate.amount) * (1 + plate.pop * 0.06), maxR * CONFIG.maxBlobOverPlate);
    if (r < 1) return;
    var sd = plate.seed;
    c.beginPath();
    for (var i = 0; i <= 48; i++) {
      var a = i / 48 * TAU;
      var rr2 = r * (1 + 0.05 * Math.sin(3 * a + sd) + 0.03 * Math.sin(5 * a + sd * 1.7) + 0.02 * Math.sin(8 * a + sd * 0.6));
      var px = x + Math.cos(a) * rr2, py = y + Math.sin(a) * rr2 * 0.96;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
    c.fillStyle = look.color; c.fill();
    c.lineWidth = 4; c.strokeStyle = look.dark; c.stroke();
    c.save();
    c.clip();
    c.globalAlpha = 0.6;
    fillEllipse(c, x - r * 0.3, y - r * 0.38, r * 0.45, r * 0.2, -0.4, look.light);
    c.globalAlpha = 1;
    if (look.lumpy) {
      var rg = mulberry32(Math.floor(sd * 1000));
      var n = Math.floor(r * r / 70);
      c.fillStyle = '#EDE5D2';
      for (var g = 0; g < n; g++) {
        var ga = rg() * TAU, gd = Math.sqrt(rg()) * r * 0.92;
        c.beginPath(); c.ellipse(x + Math.cos(ga) * gd, y + Math.sin(ga) * gd, 5, 2.6, rg() * PI, 0, TAU); c.fill();
      }
    }
    c.restore();
    var cs = clamp(r / 45, 0.6, 1);
    for (var j = 0; j < plate.chunks.length; j++) {
      var ch = plate.chunks[j];
      drawChunk(c, ch.type, x + Math.cos(ch.a) * ch.d * r * 0.8, y + Math.sin(ch.a) * ch.d * r * 0.8, ch.size * cs, ch.rot);
    }
  }
  function drawTrayPlate(c, plate, look) {
    var x = plate.x, y = L.plateY;
    if (!plate.bowl) {
      fillRR(c, x - L.trayW / 2 + 6, L.trayTop + 10, L.trayW, L.trayH, 26, 'rgba(90,60,30,0.15)');
      fillRR(c, x - L.trayW / 2, L.trayTop, L.trayW, L.trayH, 26, PAL.tray);
      fillRR(c, x - L.trayW / 2 + 10, L.trayTop + 10, L.trayW - 20, L.trayH - 20, 20, PAL.trayIn);
      var R = CONFIG.plateR;
      fillCircle(c, x + 4, y + 7, R, 'rgba(60,90,60,0.18)');
      fillCircle(c, x, y, R, PAL.plateRim);
      fillCircle(c, x, y, R - 10, PAL.plate);
      c.strokeStyle = '#E3ECF3'; c.lineWidth = 3; circle(c, x, y, R - 30); c.stroke();
      drawBlob(c, x, y, plate, look, R);
    } else {
      var B = CONFIG.bowlR;
      fillCircle(c, x + 6, y + 10, B, 'rgba(90,60,30,0.18)');
      fillCircle(c, x, y, B, '#B9783F');
      fillCircle(c, x, y, B - 12, '#E7BD8B');
      fillCircle(c, x, y, B - 22, '#F5DDB9');
      drawBlob(c, x, y, plate, look, B - 10);
    }
  }
  function drawPlates(c, look) {
    G.oldPlates.forEach(function (p) { drawTrayPlate(c, p, look); });
    if (G.prevPlate) drawTrayPlate(c, G.prevPlate, look);
    else drawEmptyPrevSlot(c);
    if (G.curPlate) {
      drawFrontArms(c, G.queue[0], G.curPlate, false);
      drawTrayPlate(c, G.curPlate, look);
      drawFrontArms(c, G.queue[0], G.curPlate, true);
      drawGuideRing(c, G.curPlate);
    }
    // labels & expectation badges
    if (G.prevPlate && Math.abs(G.prevPlate.x - L.prevX) < 60) drawPlateBadge(c, G.prevPlate);
    if (G.curPlate && Math.abs(G.curPlate.x - L.curX) < 60) drawPlateBadge(c, G.curPlate);
    if (G.prevPlate) drawPlateTag(c, G.prevPlate);
    if (G.curPlate) drawPlateTag(c, G.curPlate);
    if (G.screen !== 'over') {
      text(c, '前の子', L.prevX, L.labelY, 30, PAL.inkSoft);
      text(c, 'この子', L.curX, L.labelY, 30, PAL.ink);
    }
    // previous kid's mini face
    var pp = G.prevPlate;
    if (pp && pp.kid) {
      var fx = pp.x - 108, fy = L.trayTop - 4;
      drawKid(c, pp.kid, fx, fy, 0.5, { headOnly: true, expr: pp.face || 'normal', look: 0 });
      if (pp.bubble) {
        var st = bubbleStyle(pp.bubble);
        drawBubble(c, pp.bubble.text, fx + 20, fy - 30, st);
      }
    }
  }
  // Training wheels for 1年: where the blob would match the previous kid (scaled for 大盛り/少なめ).
  // The very first kid of 1年1組 has no plate to compare with: show the fair share instead.
  function drawGuideRing(c, plate) {
    if (G.screen !== 'play' || (G.phase !== 'ready' && G.phase !== 'pour')) return;
    if (Math.abs(plate.x - L.curX) > 20) return;
    var r, first = false;
    if (G.served.length && G.ci < CONFIG.guideRingUntilClass) {
      r = blobRadius(G.served[G.served.length - 1].norm * plate.expect);
    } else if (!G.served.length && G.ci < CONFIG.firstGuideClasses) {
      r = blobRadius(fairShareNow() * plate.expect); first = true;
    } else return;
    c.save();
    c.setLineDash([10, 9]);
    c.lineDashOffset = -G.time * 20;
    c.strokeStyle = 'rgba(242,140,40,0.9)'; c.lineWidth = 5;
    circle(c, plate.x, L.plateY, r); c.stroke();
    c.restore();
    if (first && G.phase === 'ready') text(c, '目安', plate.x, L.plateY, 30, 'rgba(242,140,40,0.95)', 'center', { stroke: '#FFFFFF', strokeW: 7 });
  }
  function drawEmptyPrevSlot(c) {
    var x = L.prevX;
    c.save();
    c.setLineDash([14, 10]); c.lineWidth = 4; c.strokeStyle = 'rgba(138,106,76,0.45)';
    rr(c, x - L.trayW / 2, L.trayTop, L.trayW, L.trayH, 26); c.stroke();
    c.restore();
    if (G.ci < CONFIG.firstGuideClasses) {
      text(c, 'さいしょの子は', x, L.plateY - 26, 26, PAL.inkSoft);
      text(c, '点線くらいが目安', x, L.plateY + 18, 26, PAL.orange);
    } else {
      text(c, 'さいしょの子は', x, L.plateY - 26, 26, PAL.inkSoft);
      text(c, '鍋を見て決めよう', x, L.plateY + 18, 26, PAL.inkSoft);
    }
  }
  // result of a serving, read at a glance: "OK +6%" (green) / "前の子と +38%" (red)
  function drawPlateTag(c, p) {
    var tg = p.tag;
    if (!tg || tg.t > 2.4) return;
    var a = clamp(Math.min(tg.t / 0.12, (2.4 - tg.t) / 0.4), 0, 1);
    var s = easeOutBack(clamp(tg.t / 0.25, 0, 1));
    c.save();
    c.globalAlpha *= a;
    c.translate(p.x, L.trayTop + L.trayH - 26); c.scale(s, s);
    drawTag(c, tg.text, 0, 0, tg.bad ? PAL.red : PAL.green, 26);
    c.restore();
  }
  function drawPlateBadge(c, p) {
    var label = null, bg = null;
    if (p.kid && p.kid.type === 'oomori') { label = '大盛り×2'; bg = PAL.red; }
    else if (p.kid && p.kid.type === 'sukuname') { label = '少なめ×½'; bg = PAL.blue; }
    else if (p.kid && p.kid.type === 'teacher') { label = '先生×3'; bg = PAL.green; }
    if (label) drawTag(c, label, p.x + 82, L.trayTop + 4, bg, 22);
  }

  // ---------- ladle & stream ----------
  function drawLadleAndStream(c, look) {
    var pouring = G.screen === 'play' && G.phase === 'pour';
    var fin = G.finale && G.finale.kind === 'pittari' && !G.finale.landed && G.screen === 'play' ? G.finale : null;
    var flow = pouring ? G.pour.flow : 0;
    var tilt = pouring || fin ? 0.55 : 0.05 + Math.sin(G.time * 2) * 0.03;
    var lx = L.ladleX, ly = L.ladleY + (pouring || fin ? 0 : Math.sin(G.time * 2.2) * 4 - 8);
    var hasPlate = G.curPlate && Math.abs(G.curPlate.x - L.curX) < 40;
    if (G.screen === 'over' && G.overReason === 'empty') { tilt = 0.7; }
    // the very last drop, in slow motion: it swells on the lip, lets go, falls ... ぴちょん
    if (fin && G.curPlate) {
      var lip0 = { x: lx + Math.cos(tilt) * 42, y: ly + Math.sin(tilt) * 42 };
      var swell = clamp(fin.t / 0.18, 0, 1);
      var u = clamp((fin.t - 0.18) / (CONFIG.finaleDropTime - 0.18), 0, 1);
      var endY0 = L.plateY - Math.min(12, blobRadius(G.curPlate.amount) * 0.2);
      var dx = lerp(lip0.x, G.curPlate.x + 2, u), dy = lerp(lip0.y + 6, endY0, u * u);
      var dr = 8 + 9 * swell;
      c.save(); c.translate(dx, dy);
      c.scale(1 - 0.12 * u, 1 + 0.25 * u);
      c.fillStyle = look.color; c.strokeStyle = look.dark; c.lineWidth = 3;
      c.beginPath(); c.moveTo(0, -dr * 1.9);
      c.quadraticCurveTo(dr * 1.05, -dr * 0.2, 0, dr); c.quadraticCurveTo(-dr * 1.05, -dr * 0.2, 0, -dr * 1.9);
      c.closePath();
      c.save(); c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 9; c.stroke(); c.restore();
      c.fill(); c.stroke();
      fillEllipse(c, -dr * 0.3, -dr * 0.2, dr * 0.22, dr * 0.35, 0.3, 'rgba(255,255,255,0.6)');
      c.restore();
    }
    // stream
    if (pouring && flow > 0.02 && hasPlate) {
      var lip = { x: lx + Math.cos(tilt) * 42, y: ly + Math.sin(tilt) * 42 };
      var r = Math.min(blobRadius(G.curPlate.amount), CONFIG.plateR);
      var endY = L.plateY - Math.min(12, r * 0.2);
      var mc = CONFIG.menus[G.cls.menuKey];
      var wv = (look.lumpy ? 5 : 8 + 12 * mc.flow) * clamp(flow, 0.2, 1.2);
      c.lineCap = 'round';
      c.strokeStyle = look.dark; c.lineWidth = wv + 5;
      streamPath(c, lip, endY); c.stroke();
      c.strokeStyle = look.color; c.lineWidth = wv;
      streamPath(c, lip, endY); c.stroke();
      c.strokeStyle = look.light; c.lineWidth = Math.max(2, wv * 0.25); c.globalAlpha = 0.7;
      streamPath(c, { x: lip.x - wv * 0.15, y: lip.y }, endY); c.stroke();
      c.globalAlpha = 1;
      fillEllipse(c, G.curPlate.x + 2, endY, wv * 1.4, wv * 0.5, 0, look.dark);
    }
    // ladle
    c.save();
    c.translate(lx, ly); c.rotate(tilt);
    c.lineCap = 'round';
    c.strokeStyle = PAL.metalDark; c.lineWidth = 14;
    c.beginPath(); c.moveTo(-36, -6); c.quadraticCurveTo(-110, -50, -176, -150); c.stroke();
    c.strokeStyle = PAL.metalLight; c.lineWidth = 5;
    c.beginPath(); c.moveTo(-40, -10); c.quadraticCurveTo(-110, -54, -172, -150); c.stroke();
    c.fillStyle = PAL.metal;
    c.beginPath(); c.ellipse(0, 0, 44, 32, 0, 0, PI); c.closePath(); c.fill();
    c.strokeStyle = PAL.metalDark; c.lineWidth = 3; c.stroke();
    var full = G.screen !== 'over' && G.pot && G.pot.remaining > 0.001;
    fillEllipse(c, 0, 0, 44, 10, 0, PAL.metalLight);
    if (full) fillEllipse(c, 0, 1, 36, 7, 0, look.color);
    c.restore();
  }
  function streamPath(c, lip, endY) {
    var t = G.time;
    c.beginPath();
    c.moveTo(lip.x, lip.y);
    var steps = 8;
    for (var i = 1; i <= steps; i++) {
      var f = i / steps;
      var x = lerp(lip.x, G.curPlate.x + 2, f * f) + Math.sin(t * 18 + f * 6) * 2.2 * f;
      c.lineTo(x, lerp(lip.y, endY, f));
    }
  }

  function drawParticles(c) {
    for (var i = 0; i < G.particles.length; i++) {
      var p = G.particles[i];
      var a = clamp(p.life / p.max, 0, 1);
      if (p.type === 'steam') {
        c.globalAlpha = 0.28 * a;
        fillCircle(c, p.x, p.y, p.size, '#FFFFFF');
        c.globalAlpha = 1;
      } else if (p.type === 'drop') {
        fillCircle(c, p.x, p.y, p.size, p.color);
      } else if (p.type === 'chunk') {
        drawChunk(c, p.chunk, p.x, p.y, p.size, p.rot);
      } else if (p.type === 'confetti') {
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot);
        c.globalAlpha = Math.min(1, p.life);
        c.fillStyle = p.color; c.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        c.restore();
      } else if (p.type === 'spark') {
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot); c.globalAlpha = a;
        drawStar(c, 0, 0, p.size, PAL.yellow);
        c.restore();
      }
    }
    c.globalAlpha = 1;
  }
  function drawStar(c, x, y, r, color) {
    c.fillStyle = color;
    c.beginPath();
    for (var i = 0; i < 10; i++) {
      var rad = i % 2 === 0 ? r : r * 0.45, a = i * PI / 5 - PI / 2;
      if (i === 0) c.moveTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad); else c.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    c.closePath(); c.fill();
  }
  function drawPopups(c) {
    G.popups.forEach(function (p) {
      var f = p.t / p.dur;
      var sc = p.pop ? easeOutBack(clamp(p.t / 0.35, 0, 1)) : easeOutBack(clamp(p.t / 0.2, 0, 1));
      var a = f > 0.7 ? 1 - (f - 0.7) / 0.3 : 1;
      c.save();
      c.globalAlpha = clamp(a, 0, 1);
      c.translate(p.x, p.y - p.rise * easeOutCubic(f));
      c.scale(sc, sc);
      text(c, p.text, 0, 0, p.size, p.color, 'center', { stroke: p.stroke || '#FFFFFF', strokeW: p.size * 0.22 });
      c.restore();
    });
  }
  // complaint marks flying from the kid to the HUD (drawn above the HUD)
  function drawFlyers(c) {
    G.flyers.forEach(function (f) {
      var u = clamp(f.t / f.dur, 0, 1), e = u * u * (3 - 2 * u);
      var x = lerp(f.x0, f.x1, e), y = lerp(f.y0, f.y1, e) - Math.sin(u * PI) * 120;
      var s = 1.25 - 0.25 * u;
      c.save(); c.translate(x, y); c.scale(s, s); c.rotate(u * 2.5);
      fillCircle(c, 0, 0, 26, PAL.red);
      c.strokeStyle = '#FFFFFF'; c.lineWidth = 4; circle(c, 0, 0, 26); c.stroke();
      drawAnger(c, 0, 0, 14, '#FFFFFF');
      c.restore();
    });
  }
  function drawSpeech(c) {
    var all = G.queue.slice(0, VISIBLE_SLOTS).concat(G.exiting, G.leavers);
    all.forEach(function (k) {
      if (!k.bubble || k.bubble.t < 0) return;
      var st = bubbleStyle(k.bubble);
      drawBubble(c, k.bubble.text, k.dx + 10 * k.ds, kidHeadTop(k) - 6, st);
    });
    // the kid at the front states a special request
    var f = G.queue[0];
    if (f && !f.bubble && (G.screen === 'play' || G.screen === 'intro') && (G.phase === 'ready' || G.phase === 'pour') && !f.moving) {
      var req = f.type === 'oomori' ? '大盛りで！（2倍）' : f.type === 'sukuname' ? '少なめで…（半分）' : f.type === 'teacher' ? '先生のは3人分ね' : null;
      if (req) {
        var tag = kidTagInfo(f);
        drawBubble(c, req, f.dx + 10, kidHeadTop(f) - 6, { bg: '#FFFFFF', border: tag.bg, color: tag.bg, size: 30 });
      }
    }
  }

  // =====================================================================
  // 10. RENDER: HUD, cards, screens
  // =====================================================================
  function drawMuteButton(c) {
    var b = L.muteBtn;
    fillCircle(c, b.x, b.y, b.r, '#FFFFFF');
    c.strokeStyle = PAL.hudLine; c.lineWidth = 4; circle(c, b.x, b.y, b.r); c.stroke();
    c.fillStyle = PAL.ink;
    c.beginPath();
    c.moveTo(b.x - 16, b.y - 7); c.lineTo(b.x - 7, b.y - 7); c.lineTo(b.x + 4, b.y - 17); c.lineTo(b.x + 4, b.y + 17); c.lineTo(b.x - 7, b.y + 7); c.lineTo(b.x - 16, b.y + 7);
    c.closePath(); c.fill();
    c.strokeStyle = PAL.ink; c.lineWidth = 3.5; c.lineCap = 'round';
    if (Sfx.muted) {
      c.strokeStyle = PAL.red;
      line(c, b.x + 10, b.y - 9, b.x + 22, b.y + 9); line(c, b.x + 22, b.y - 9, b.x + 10, b.y + 9);
    } else {
      c.beginPath(); c.arc(b.x + 6, b.y, 9, -0.9, 0.9); c.stroke();
      c.beginPath(); c.arc(b.x + 6, b.y, 16, -0.9, 0.9); c.stroke();
    }
  }
  function drawHUD(c) {
    c.fillStyle = PAL.hud; c.fillRect(0, 0, W, L.hudH);
    c.fillStyle = PAL.hudLine; c.fillRect(0, L.hudH - 5, W, 5);
    if (G.cls) {
      text(c, G.cls.label, 24, 50, 48, PAL.ink, 'left');
      text(c, MENU_LOOK[G.cls.menuKey].name + '・' + SHAPE_LOOK[G.cls.shapeKey].name, 26, 97, 24, PAL.inkSoft, 'left', { maxW: 236 });
      // complaint marks (a mark still flying in from the kid isn't lit yet)
      var lit = 0;
      for (var j = 0; j < G.complaints; j++) if (!(G.markPop[j] < 0)) lit++;
      var lastOne = lit === CONFIG.maxComplaints - 1 && G.screen === 'play';
      if (lastOne) {
        var pl = 0.5 + 0.5 * Math.sin(G.time * 8);
        text(c, 'あと1つで学級会！', 368, 24, 22, 'rgba(226,70,58,' + (0.75 + 0.25 * pl) + ')');
      } else {
        text(c, 'ふまん', 368, 24, 22, PAL.inkSoft);
      }
      for (var i = 0; i < CONFIG.maxComplaints; i++) {
        var mx = 300 + i * 68, my = 72;
        var on = i < lit;
        var pop = G.markPop[i] > 0 ? easeOutBack(clamp(G.markPop[i], 0, 1)) : 1;
        c.save(); c.translate(mx, my); c.scale(on ? pop : 1, on ? pop : 1);
        fillCircle(c, 0, 0, 26, on ? PAL.red : '#F1E1C6');
        drawAnger(c, 0, 0, 14, on ? '#FFFFFF' : '#DCC7A4');
        if (lastOne && i === lit) {
          c.strokeStyle = 'rgba(226,70,58,' + (0.35 + 0.45 * (0.5 + 0.5 * Math.sin(G.time * 8))) + ')';
          c.lineWidth = 5; circle(c, 0, 0, 31 + 2 * Math.sin(G.time * 8)); c.stroke();
        }
        c.restore();
      }
      text(c, 'スコア', 556, 26, 22, PAL.inkSoft);
      text(c, String(G.runScore), 556, 76, 44, PAL.orange);
    }
    drawMuteButton(c);
  }
  // 昼休みの時計 on the classroom wall (behind the line): 12:20 → 12:50 as the class goes on
  function drawLunchClock(c) {
    var x = 612, y = 182, r = 30;
    var p = lunchProgress(), minutes = CONFIG.lunchStartMin + CONFIG.lunchSpanMin * p;
    fillCircle(c, x + 3, y + 4, r + 5, 'rgba(90,60,30,0.18)');
    fillCircle(c, x, y, r + 5, p >= 1 ? PAL.red : PAL.boardFrame);
    fillCircle(c, x, y, r, '#FFFFFF');
    c.strokeStyle = PAL.ink; c.lineCap = 'round';
    for (var i = 0; i < 12; i++) {
      var a = i / 12 * TAU, l = i % 3 === 0 ? 7 : 4;
      c.lineWidth = i % 3 === 0 ? 3 : 2;
      line(c, x + Math.sin(a) * (r - 3), y - Math.cos(a) * (r - 3), x + Math.sin(a) * (r - 3 - l), y - Math.cos(a) * (r - 3 - l));
    }
    var ha = (minutes / 60) / 12 * TAU, ma = minutes / 60 * TAU;
    c.lineWidth = 4.5; line(c, x, y, x + Math.sin(ha) * r * 0.5, y - Math.cos(ha) * r * 0.5);
    c.strokeStyle = p >= 1 ? PAL.red : PAL.ink; c.lineWidth = 3;
    line(c, x, y, x + Math.sin(ma) * r * 0.78, y - Math.cos(ma) * r * 0.78);
    fillCircle(c, x, y, 3.5, PAL.ink);
  }
  function drawRemainingBadge(c) {
    // the kid just served counts as done right away (they leave the line after the beat)
    var n = Math.max(0, G.queue.length - (G.screen === 'play' && G.phase === 'beat' ? 1 : 0));
    var x = 340, y = 146, w = 190, h = 58;
    var hot = n > 0 && n <= CONFIG.lastCallout && G.cls.kids.length > CONFIG.lastCallout + 1 && G.screen === 'play';
    var ps = hot ? 1 + 0.06 * Math.abs(Math.sin(G.time * 4)) : 1;
    c.save(); c.translate(x + 85, y + h / 2); c.scale(ps, ps); c.translate(-(x + 85), -(y + h / 2));
    fillRR(c, x - 6, y + 4, w, h, 29, 'rgba(90,60,30,0.15)');
    fillRR(c, x - 10, y, w, h, 29, hot ? '#FFF1EE' : '#FFFFFF');
    c.strokeStyle = hot ? PAL.red : PAL.hudLine; c.lineWidth = hot ? 4 : 3; rr(c, x - 10, y, w, h, 29); c.stroke();
    text(c, '残り', x + 32, y + h / 2 + 1, 24, hot ? PAL.red : PAL.inkSoft);
    text(c, n + '人', x + 118, y + h / 2 + 1, 38, hot ? PAL.red : PAL.ink);
    c.restore();
    var hasT = G.queue.some(function (k) { return k.teacher; });
    if (hasT) drawTag(c, '最後に先生（3人分）', x + 85, y + h + 24, PAL.green, 22);
  }
  function drawHint(c) {
    var k = hintKey();
    if (!k) return;
    var y = L.hintY;
    if (k === 'release') {
      var keyOnly = Input.space && !Object.keys(Input.pointers).length;
      text(c, keyOnly ? 'いったんキーをはなしてね' : 'いったん指をはなしてね', W / 2, y, 30, PAL.red);
      return;
    }
    if (k === 'msg') { text(c, G.hintMsg, W / 2, y, 30, PAL.red); return; }
    var tutorial = G.ci === 0 && G.served.length < 2;
    if (k === 'hold') {
      if (tutorial) {
        var pr = 1 + 0.08 * Math.sin(G.time * 6);
        c.strokeStyle = 'rgba(242,140,40,0.75)'; c.lineWidth = 6;
        circle(c, L.curX, L.plateY, (CONFIG.plateR + 18) * pr); c.stroke();
        drawTutorialPill(c, G.served.length === 0 ? 'どこでも長押しでよそう' : '点線と同じくらいまで長押し', y - 4, true);
        return;
      }
      var a = 0.65 + 0.35 * Math.sin(G.time * 5);
      c.globalAlpha = a;
      text(c, '長押しでよそう・はなすと決定', W / 2, y, 30, PAL.ink);
      c.globalAlpha = 1;
      return;
    }
    if (k === 'pouring') {
      if (tutorial) { drawTutorialPill(c, '点線くらいで、はなす！', y - 4, false); return; }
      text(c, 'はなすと決定！', W / 2, y, 30, PAL.orange); return;
    }
    text(c, 'つぎの子…', W / 2, y, 28, PAL.inkSoft);
  }

  // first servings of the run: a big pill with a finger that presses (or lifts) in a loop
  function drawTutorialPill(c, str, y, press) {
    c.font = font(32);
    var tw = c.measureText(str).width, w = tw + 120, h = 70, x = W / 2 - w / 2;
    var bob = Math.sin(G.time * 5) * 2;
    fillRR(c, x + 4, y - h / 2 + 6 + bob, w, h, h / 2, 'rgba(120,60,10,0.25)');
    fillRR(c, x, y - h / 2 + bob, w, h, h / 2, press ? PAL.orange : PAL.red);
    text(c, str, x + 84 + tw / 2, y + 1 + bob, 32, '#FFFFFF');
    // finger: presses down (hold) or springs up (release)
    var ph = (G.time * 1.2) % 1, down = press ? ph < 0.6 : ph > 0.6;
    var fx = x + 46, fy = y + bob + (down ? 4 : -6);
    fillCircle(c, fx, y + bob + 12, down ? 20 : 14, 'rgba(255,255,255,0.35)');
    fillRR(c, fx - 9, fy - 26, 18, 40, 9, '#FAD9BA');
    fillRR(c, fx - 18, fy, 36, 26, 12, '#FAD9BA');
  }
  function drawPlayScene(c) {
    var look = MENU_LOOK[G.cls.menuKey];
    var sx = 0, sy = 0;
    // render-only RNG: drawing must never consume the simulation's random streams,
    // or the frame rate would change the run (same seed + inputs ≠ same game)
    if (G.shake > 0) { sx = (shakeRng() * 2 - 1) * G.shake; sy = (shakeRng() * 2 - 1) * G.shake; }
    c.save();
    c.translate(sx, sy);
    if (Math.abs(G.camZ - 1) > 0.0005) {
      c.translate(G.camX, G.camY); c.scale(G.camZ, G.camZ); c.translate(-G.camX, -G.camY);
    }
    drawBackground(c, G.cls.menuKey);
    drawLunchClock(c);
    drawQueue(c);
    drawCounter(c);
    var pot = G.pot;
    drawPot(c, {
      shape: pot.shape, frac: pot.remaining / pot.capacity, menuKey: G.cls.menuKey, cx: L.potCX, bottom: L.potBottom,
      chunks: G.cls.potChunks, chunkShow: pot.remaining / pot.V, agitate: G.phase === 'pour' ? G.pour.flow : 0
    });
    drawPlates(c, look);
    drawLadleAndStream(c, look);
    drawSpotlight(c);
    drawParticles(c);
    drawSpeech(c);
    drawRemainingBadge(c);
    if (G.screen === 'play') drawHint(c);
    drawPopups(c);
    c.restore();
  }
  // Slow-motion spotlight while the last drop falls; a faint pulsing edge when the pot is short.
  function drawSpotlight(c) {
    var f = G.finale, a = 0, cx = L.curX, cy = L.plateY - 120;
    if (f && f.kind === 'pittari' && G.screen === 'play') {
      a = f.landed ? 0 : 0.42 * clamp(f.t / 0.15, 0, 1);
    } else if (inDanger() && G.queue.length <= CONFIG.lastCallout) {
      a = 0.16 + 0.08 * Math.sin(G.time * 7);
      cx = W / 2; cy = 760;
    }
    if (a <= 0) return;
    var g = c.createRadialGradient(cx, cy, 160, cx, cy, 820);
    g.addColorStop(0, 'rgba(30,15,5,0)');
    g.addColorStop(1, 'rgba(30,15,5,' + a + ')');
    c.fillStyle = g; c.fillRect(-40, L.hudH - 40, W + 80, H - L.hudH + 80);
  }

  // cinematic letterbox while the last drop falls in slow motion
  function drawCinemaBars(c) {
    var f = G.finale;
    if (!f || f.kind !== 'pittari' || G.screen !== 'play') return;
    var a = Math.min(clamp(f.t / 0.14, 0, 1), 1 - clamp((f.t - CONFIG.finaleDropTime) / 0.2, 0, 1));
    if (a <= 0) return;
    var bh = 96 * easeOutCubic(a);
    c.fillStyle = '#1B120C';
    c.fillRect(0, 0, W, bh); c.fillRect(0, H - bh, W, bh);
    c.globalAlpha = a;
    text(c, 'さいごの一滴…', W / 2, H - bh / 2, 34, '#FFFFFF');
    c.globalAlpha = 1;
  }

  // ---------- classmates peeking up from the bottom edge (ぴったり clap / 鍋が空 stare / 学級会) ----------
  function crowdKids() {
    var all = G.cls.kids.filter(function (k) { return !k.teacher; });
    var inLine = {};
    G.queue.forEach(function (q) { inLine[q.id] = 1; });
    var pool = all.filter(function (k) { return !inLine[k.id]; }).concat(all.filter(function (k) { return inLine[k.id]; }));
    var n = Math.min(L.crowdN, pool.length), out = [];
    for (var i = 0; i < n; i++) out.push(pool[Math.floor(i * pool.length / n)]);
    return out;
  }
  function drawKidBack(c, k, x, y, s) {
    c.save(); c.translate(x, y); c.scale(s, s);
    c.fillStyle = '#FFFFFF'; c.strokeStyle = PAL.smockLine; c.lineWidth = 3.5;
    c.beginPath();
    c.moveTo(-34, 38); c.bezierCurveTo(-60, 44, -72, 70, -74, 120);
    c.lineTo(-80, 240); c.lineTo(80, 240); c.lineTo(74, 120);
    c.bezierCurveTo(72, 70, 60, 44, 34, 38);
    c.closePath(); c.fill(); c.stroke();
    fillRR(c, -16, 26, 32, 22, 8, k.skin);
    fillCircle(c, -49, 8, 10, k.skin); fillCircle(c, 49, 8, 10, k.skin);
    fillCircle(c, 0, 2, 50, k.hairColor);
    if (k.hair === 1 || k.hair === 5) fillRR(c, -50, 0, 100, k.hair === 5 ? 70 : 48, 24, k.hairColor);
    if (k.hair === 2) { fillEllipse(c, -60, 22, 15, 22, 0.3, k.hairColor); fillEllipse(c, 60, 22, 15, 22, -0.3, k.hairColor); fillCircle(c, -54, 12, 6, k.tie); fillCircle(c, 54, 12, 6, k.tie); }
    if (k.hair === 3) { fillEllipse(c, 0, 46, 14, 26, 0, k.hairColor); fillCircle(c, 0, 28, 6, k.tie); }
    c.fillStyle = '#FFFFFF'; c.strokeStyle = PAL.smockLine; c.lineWidth = 3.5;
    c.beginPath(); c.moveTo(-54, -6); c.bezierCurveTo(-64, -76, 64, -76, 54, -6); c.closePath(); c.fill(); c.stroke();
    rr(c, -55, -18, 110, 16, 7); c.fill(); c.stroke();
    c.restore();
  }
  function drawCrowd(c) {
    var cr = G.crowd;
    if (!cr || !G.cls) return;
    var kids = crowdKids(), n = kids.length, s = L.crowdS;
    for (var i = 0; i < n; i++) {
      var k = kids[i];
      var delay = (i % 3) * 0.07 + i * 0.012;
      var u = clamp((cr.t - delay) / CONFIG.crowdRise, 0, 1);
      if (u <= 0) continue;
      var x = 46 + i * (W - 92) / Math.max(1, n - 1);
      var y = H - 62 + (i % 2) * 18 + (1 - easeOutBack(u)) * 190;
      if (cr.mode === 'clap') {
        var bob = -Math.abs(Math.sin(G.time * 9 + i * 1.3)) * 9;
        drawKid(c, k, x, y + bob, s, { expr: 'happy', look: 0, clap: G.time * 13 + i });
      } else if (cr.mode === 'stare') {
        // backs first, then everyone turns around at once to look at the empty plate
        var p = clamp((cr.t - 0.45 - i * 0.015) / 0.24, 0, 1);
        var sxk = Math.max(0.06, Math.abs(Math.cos(p * PI)));
        c.save(); c.translate(x, y); c.scale(sxk, 1); c.translate(-x, -y);
        if (p < 0.5) drawKidBack(c, k, x, y, s);
        else drawKid(c, k, x, y, s, { expr: 'stare', look: x < L.curX ? 1 : -1 });
        c.restore();
      } else {
        // 学級会: arms up, angry
        if (i % 2 === 0) {
          var side = i % 4 === 0 ? 1 : -1, wave = Math.sin(G.time * 10 + i) * 6;
          c.lineCap = 'round';
          c.strokeStyle = PAL.smockLine; c.lineWidth = 34 * s + 4; line(c, x + side * 46 * s, y + 70 * s, x + side * 70 * s + wave, y - 96 * s);
          c.strokeStyle = '#FFFFFF'; c.lineWidth = 34 * s; line(c, x + side * 46 * s, y + 70 * s, x + side * 70 * s + wave, y - 96 * s);
          fillCircle(c, x + side * 70 * s + wave, y - 110 * s, 16 * s, k.skin);
        }
        drawKid(c, k, x, y, s, { expr: 'angry', look: 0 });
      }
    }
  }

  function drawCard(c, x, y, w, h) {
    fillRR(c, x + 8, y + 12, w, h, 30, 'rgba(60,40,20,0.25)');
    fillRR(c, x, y, w, h, 30, PAL.cream);
    c.strokeStyle = '#E2C79A'; c.lineWidth = 5; rr(c, x, y, w, h, 30); c.stroke();
    c.strokeStyle = 'rgba(226,199,154,0.5)'; c.lineWidth = 2; rr(c, x + 12, y + 12, w - 24, h - 24, 22); c.stroke();
  }
  function drawIntroCard(c) {
    var cls = G.cls, ml = MENU_LOOK[cls.menuKey], sl = SHAPE_LOOK[cls.shapeKey];
    var a = easeOutBack(clamp(G.t / 0.35, 0, 1));
    c.fillStyle = 'rgba(40,25,15,' + (0.45 * clamp(G.t / 0.2, 0, 1)) + ')';
    c.fillRect(0, L.hudH, W, H - L.hudH);
    c.save();
    c.translate(W / 2, 640); c.scale(a, a); c.translate(-W / 2, -640);
    var x = 50, y = 210, w = 620, h = 860;
    drawCard(c, x, y, w, h);
    text(c, 'きょうの給食当番', W / 2, y + 62, 28, PAL.inkSoft);
    text(c, cls.label, W / 2, y + 140, 92, PAL.ink);
    if (G.ci === 0) {
      // first class: a 3-step picture how-to instead of a list of rules
      drawHowTo(c, x, y + 218, w);
      text(c, cls.size + '人・' + ml.name + '・' + sl.name, W / 2, y + 620, 30, PAL.ink);
      text(c, 'ふまんマークが3つで学級会！', W / 2, y + 670, 26, PAL.red);
      text(c, '1年生の間は、目安の点線が出るよ', W / 2, y + 712, 24, PAL.orange);
      c.globalAlpha = 0.55 + 0.45 * Math.sin(G.time * 5);
      text(c, 'タップで配膳スタート', W / 2, y + h - 56, 36, PAL.orange);
      c.globalAlpha = 1;
      c.restore();
      return;
    }
    // menu row
    var ry = y + 250;
    c.save(); c.translate(x + 92, ry + 18); c.scale(0.2, 0.2);
    drawPot(c, { shape: SHAPES.zundou, frac: 0.8, menuKey: cls.menuKey, cx: 0, bottom: 180, chunks: cls.potChunks.slice(0, 20) });
    c.restore();
    text(c, 'メニュー：' + ml.name, x + 160, ry - 14, 34, PAL.ink, 'left');
    text(c, ml.note, x + 160, ry + 30, 24, PAL.inkSoft, 'left', { maxW: w - 190 });
    ry += 120;
    c.save(); c.translate(x + 92, ry + 18); c.scale(0.2, 0.2);
    drawPot(c, { shape: SHAPES[cls.shapeKey], frac: 0.7, menuKey: cls.menuKey, cx: 0, bottom: 180, chunks: [] });
    c.restore();
    text(c, 'なべ：' + sl.name, x + 160, ry - 14, 34, PAL.ink, 'left');
    text(c, sl.note, x + 160, ry + 30, 24, PAL.inkSoft, 'left', { maxW: w - 190 });
    ry += 120;
    text(c, '人数：' + cls.size + '人' + (cls.hasTeacher ? '＋先生' : ''), x + 160, ry, 34, PAL.ink, 'left');
    fillCircle(c, x + 92, ry, 30, '#FFE7C2');
    drawKid(c, cls.kids[0], x + 92, ry + 4, 0.42, { headOnly: true, expr: 'happy' });
    // notes
    var notes = [];
    if (G.ci === 0) {
      notes.push(['前の子と同じくらいずつ、よそってね', PAL.ink]);
      notes.push(['最後の1人で鍋が空になれば大成功！', PAL.ink]);
    }
    if (G.ci < CONFIG.guideRingUntilClass) notes.push(['1年生の間は、目安の点線が出るよ', PAL.orange]);
    else if (G.ci === CONFIG.guideRingUntilClass) notes.push(['ここからは目安の点線なし！', PAL.orange]);
    if (cls.oomori || cls.sukuname) notes.push(['大盛りの子は2倍、少なめの子は半分', PAL.red]);
    if (cls.hasTeacher) notes.push(['最後に先生が大きな器で来るよ（3人分）', PAL.green]);
    if (cls.leaves.length) notes.push(['途中で早退する子がいるかも…', PAL.blue]);
    if (G.ci === 1) notes.push(['昼休みの時計が進むと、列が早く進むよ', PAL.inkSoft]);
    if (!notes.length) notes.push(['不満マークが3つたまると学級会！', PAL.ink]);
    ry += 76;
    c.font = font(25);
    notes.forEach(function (n) {
      var lines = wrapText(c, n[0], w - 120);
      fillCircle(c, x + 58, ry, 7, n[1]);
      lines.forEach(function (ln, i) { text(c, ln, x + 78, ry + i * 34, 25, n[1], 'left'); });
      ry += 34 * lines.length + 14;
    });
    var blink = 0.55 + 0.45 * Math.sin(G.time * 5);
    c.globalAlpha = blink;
    text(c, 'タップで配膳スタート', W / 2, y + h - 56, 36, PAL.orange);
    c.globalAlpha = 1;
    c.restore();
  }
  // あそびかた: three pictures, one short caption each
  function drawHowTo(c, x, y, w) {
    var pw = (w - 64) / 3, ph = 330, t = G.time;
    var look = MENU_LOOK.curry;
    for (var i = 0; i < 3; i++) {
      var px = x + 22 + i * (pw + 10), cx = px + pw / 2;
      fillRR(c, px, y, pw, ph, 22, '#FFFFFF');
      c.strokeStyle = '#EAD7B5'; c.lineWidth = 3; rr(c, px, y, pw, ph, 22); c.stroke();
      fillCircle(c, px + 26, y + 26, 17, PAL.orange);
      text(c, String(i + 1), px + 26, y + 27, 22, '#FFFFFF');
      var iy = y + 128;
      if (i === 0) {
        // finger holding down; a stream fills a plate while held
        var hold = (t * 0.7) % 1, held = hold < 0.7;
        fillCircle(c, cx + 10, iy + 60, 52, PAL.plateRim); fillCircle(c, cx + 10, iy + 60, 44, PAL.plate);
        var amt = held ? hold / 0.7 : 1;
        drawBlob(c, cx + 10, iy + 60, { amount: 0.42 * amt, pop: 0, seed: 2.1, chunks: [] }, look, 36);
        if (held) { c.strokeStyle = look.color; c.lineWidth = 8; c.lineCap = 'round'; line(c, cx + 10, iy - 40, cx + 10, iy + 56); }
        c.save(); c.translate(cx - 38, iy - 22 + (held ? 6 : 0));
        if (held) { c.strokeStyle = 'rgba(242,140,40,0.7)'; c.lineWidth = 4; circle(c, 0, 34, 20 + 10 * Math.sin(t * 6)); c.stroke(); }
        fillRR(c, -10, -22, 20, 50, 10, '#F5CBA4'); fillRR(c, -24, 12, 48, 40, 18, '#F5CBA4');
        c.strokeStyle = 'rgba(160,110,70,0.5)'; c.lineWidth = 2.5; rr(c, -10, -22, 20, 50, 10); c.stroke();
        c.restore();
        text(c, '長押しで', cx, y + ph - 76, 26, PAL.ink);
        text(c, 'よそう', cx, y + ph - 40, 32, PAL.orange);
      } else if (i === 1) {
        // two plates, same size: ＝
        [-1, 1].forEach(function (sd, j) {
          var qx = cx + sd * 42;
          fillCircle(c, qx, iy + 40, 36, PAL.plateRim); fillCircle(c, qx, iy + 40, 30, PAL.plate);
          drawBlob(c, qx, iy + 40, { amount: 0.17, pop: 0, seed: 1 + j * 3, chunks: [] }, look, 24);
        });
        text(c, '＝', cx, iy + 40, 30, PAL.orange, 'center', { stroke: '#FFFFFF', strokeW: 6 });
        text(c, '前の子', cx - 42, iy + 98, 18, PAL.inkSoft);
        text(c, 'この子', cx + 42, iy + 98, 18, PAL.ink);
        text(c, '前の子と', cx, y + ph - 76, 26, PAL.ink);
        text(c, '同じくらい', cx, y + ph - 40, 30, PAL.orange);
      } else {
        // an empty pot + ぴったり！
        c.save(); c.translate(cx, iy + 92); c.scale(0.3, 0.3);
        drawPot(c, { shape: SHAPES.zundou, frac: 0.004, menuKey: 'curry', cx: 0, bottom: 0, chunks: [] });
        c.restore();
        var sp = 1 + 0.08 * Math.sin(t * 5);
        c.save(); c.translate(cx, iy - 50); c.rotate(-0.12); c.scale(sp, sp);
        text(c, 'ぴったり！', 0, 0, 30, PAL.red, 'center', { stroke: '#FFFFFF', strokeW: 7 });
        c.restore();
        text(c, '最後の1人で', cx, y + ph - 76, 26, PAL.ink);
        text(c, '鍋を空に', cx, y + ph - 40, 30, PAL.orange);
      }
    }
  }
  function drawClassEndCard(c) {
    var r = G.lastClassResult;
    if (!r) return;
    var t = G.t - (r.staged ? CONFIG.classEndCardDelay : r.pittari ? 0.7 : 0.25);
    c.fillStyle = 'rgba(40,25,15,' + (0.4 * clamp(G.t / 0.3, 0, 1)) + ')';
    c.fillRect(0, L.hudH, W, H - L.hudH);
    if (t < 0) return;
    var a = easeOutBack(clamp(t / 0.35, 0, 1));
    c.save();
    c.translate(W / 2, 640); c.scale(a, a); c.translate(-W / 2, -640);
    var x = 50, y = 160, w = 620, h = 980;
    drawCard(c, x, y, w, h);
    text(c, r.label, W / 2, y + 66, 44, PAL.inkSoft);
    text(c, 'ごちそうさまでした！', W / 2, y + 132, 48, PAL.ink);
    if (r.pittari) {
      c.save(); c.translate(W / 2 + 196, y + 46); c.rotate(-0.18);
      c.strokeStyle = PAL.red; c.lineWidth = 6; rr(c, -96, -38, 192, 76, 18); c.stroke();
      text(c, 'ぴったり！', 0, 2, 38, PAL.red);
      c.restore();
    }
    var rows = [
      ['均等度', r.evenness + '点', PAL.ink],
      ['ぴったり完食ボーナス', (r.bonus ? '+' : '') + r.bonus, r.bonus ? PAL.orange : PAL.inkSoft],
      ['残りペナルティ（' + Math.round(r.leftFrac * 100) + '%残り）', r.penalty ? '−' + r.penalty : '0', r.penalty ? PAL.blue : PAL.inkSoft]
    ];
    var ry = y + 220;
    rows.forEach(function (row, i) {
      var show = clamp((t - 0.25 - i * 0.18) / 0.2, 0, 1);
      c.globalAlpha = show;
      text(c, row[0], x + 50, ry, 28, PAL.ink, 'left');
      text(c, row[1], x + w - 50, ry, 36, row[2], 'right');
      c.strokeStyle = 'rgba(138,106,76,0.25)'; c.lineWidth = 2; c.setLineDash([6, 8]);
      line(c, x + 50, ry + 30, x + w - 50, ry + 30); c.setLineDash([]);
      ry += 72;
      c.globalAlpha = 1;
    });
    var show2 = clamp((t - 0.9) / 0.25, 0, 1);
    c.globalAlpha = show2;
    text(c, 'このクラス', x + 50, ry + 12, 32, PAL.ink, 'left');
    text(c, r.score + '点', x + w - 50, ry + 12, 54, PAL.orange, 'right');
    text(c, '合計 ' + G.runScore + '点', W / 2, ry + 82, 30, PAL.inkSoft);
    c.globalAlpha = 1;
    // class faces (clapping when ぴったり), fitted into the space between the totals
    // and the "tap" line so a 40-person class doesn't cover the 合計 line
    var kids = G.cls.kids, cols = kids.length > 30 ? 12 : 10;
    var rows2 = Math.ceil(kids.length / cols);
    var areaTop = ry + 82 + 96, areaBottom = y + h - 122; // first / last possible row centers
    var gy = Math.min(74, rows2 > 1 ? (areaBottom - areaTop) / (rows2 - 1) : 74);
    var gx = Math.min(56, (w - 60) / cols);
    var sz = Math.min(0.42, 0.42 * gx / 56, 0.42 * gy / 74);
    var startY = areaTop + Math.max(0, (areaBottom - areaTop - (rows2 - 1) * gy) / 2);
    if (r.pittari) text(c, 'みんなで拍手！', W / 2, startY - 38 - 34 * sz / 0.42, 28, PAL.red);
    for (var i = 0; i < kids.length; i++) {
      var col = i % cols, row = Math.floor(i / cols);
      var inRow = Math.min(cols, kids.length - row * cols);
      var kx = W / 2 - (inRow - 1) * gx / 2 + col * gx, ky = startY + row * gy;
      var happy = r.pittari || r.evenness >= 70;
      var bob = happy ? -Math.abs(Math.sin(G.time * 8 + i)) * 4 : 0;
      drawKid(c, kids[i], kx, ky + bob, kids[i].teacher ? sz * 1.1 : sz, { headOnly: true, expr: happy ? 'happy' : 'normal', look: 0, clap: r.pittari ? G.time * 12 + i : null });
    }
    if (G.t > CONFIG.classEndMinTime) {
      c.globalAlpha = 0.55 + 0.45 * Math.sin(G.time * 5);
      var lastClass = G.ci + 1 >= CONFIG.classesPerGrade * CONFIG.maxGrade;
      text(c, lastClass ? 'タップで卒業式へ' : 'タップで次のクラスへ', W / 2, y + h - 44, 34, PAL.orange);
      c.globalAlpha = 1;
    }
    c.restore();
  }
  function drawOverOverlay(c) {
    var t = G.t;
    if (G.overReason === 'empty') {
      var d = clamp((t - 1.6) / 1.2, 0, 1);
      if (d > 0) {
        var g = c.createRadialGradient(L.curX, 640, 120, L.curX, 640, 900);
        g.addColorStop(0, 'rgba(20,10,5,' + (0.1 * d) + ')');
        g.addColorStop(1, 'rgba(20,10,5,' + (0.6 * d) + ')');
        c.fillStyle = g; c.fillRect(0, L.hudH, W, H - L.hudH);
      }
      if (t > 2.5) {
        var a = clamp((t - 2.5) / 0.4, 0, 1);
        c.globalAlpha = a;
        text(c, 'シーン…', L.potCX, 560, 60, '#FFFFFF', 'center', { stroke: PAL.ink2, strokeW: 11 });
        c.globalAlpha = 1;
      }
      if (t > 1.3) {
        // banner for viewers: what happened, readable at a glance
        var a2 = clamp((t - 1.3) / 0.3, 0, 1);
        c.save(); c.globalAlpha = a2;
        c.translate(W / 2, 214); c.scale(0.9 + 0.1 * easeOutBack(a2), 0.9 + 0.1 * easeOutBack(a2));
        fillRR(c, -250, -46, 500, 92, 46, 'rgba(58,42,32,0.92)');
        text(c, '鍋が空っぽ…！', 0, 2, 50, '#FFFFFF');
        c.restore();
      }
    } else if (G.overReason === 'meeting') {
      var d2 = clamp(t / 0.5, 0, 1);
      c.fillStyle = 'rgba(40,20,10,' + (0.45 * d2) + ')'; c.fillRect(0, L.hudH, W, H - L.hudH);
      if (t > 0.5) {
        var s = easeOutBack(clamp((t - 0.5) / 0.3, 0, 1));
        c.save(); c.translate(W / 2, 560); c.rotate(-0.12); c.scale(s * 1.0, s * 1.0);
        fillRR(c, -230, -90, 460, 180, 26, '#FFFFFF');
        c.strokeStyle = PAL.red; c.lineWidth = 12; rr(c, -230, -90, 460, 180, 26); c.stroke();
        text(c, '学級会！', 0, 6, 104, PAL.red);
        c.restore();
      }
      if (t > 1.1) {
        c.globalAlpha = clamp((t - 1.1) / 0.3, 0, 1);
        fillRR(c, 90, 720, 540, 110, 14, PAL.board);
        c.strokeStyle = PAL.boardFrame; c.lineWidth = 8; rr(c, 90, 720, 540, 110, 14); c.stroke();
        text(c, '議題：給食の盛りかたについて', W / 2, 776, 32, '#FFFFFF');
        c.globalAlpha = 1;
      }
    }
  }

  function drawTitle(c) {
    drawBackground(c, 'curry');
    // a happy kid holding out a tray, next to the pot
    var kid = TITLE_KID;
    kid.dx = L.slots[0].x; kid.dy = L.slots[0].y + Math.sin(G.time * 2) * 3; kid.ds = 1;
    drawKid(c, kid, kid.dx, kid.dy, 1, { expr: 'happy' });
    drawCounter(c);
    drawPot(c, { shape: SHAPES.zundou, frac: 0.62, menuKey: 'curry', cx: L.potCX, bottom: L.potBottom, chunks: TITLE_CHUNKS, chunkShow: 0.7 });
    var plate = TITLE_PLATE;
    plate.x = L.curX;
    drawFrontArms(c, kid, plate, false, true);
    drawTrayPlate(c, plate, MENU_LOOK.curry);
    drawFrontArms(c, kid, plate, true, true);
    drawParticles(c);
    drawBubble(c, 'みんな同じくらいね！', kid.dx + 10, kid.dy - 72, { size: 28, border: PAL.orange, color: PAL.ink });
    // how-to card on the counter
    var hx = 34, hy = 846, hw = 316, hh = 236;
    fillRR(c, hx + 6, hy + 8, hw, hh, 24, 'rgba(90,60,30,0.15)');
    fillRR(c, hx, hy, hw, hh, 24, 'rgba(255,255,255,0.95)');
    c.strokeStyle = PAL.hudLine; c.lineWidth = 3; rr(c, hx, hy, hw, hh, 24); c.stroke();
    var fx = hx + 70, fy = hy + 84, ring = (G.time * 0.9) % 1;
    c.strokeStyle = 'rgba(242,140,40,' + (1 - ring) + ')'; c.lineWidth = 5;
    circle(c, fx, fy + 30, 16 + ring * 30); c.stroke();
    fillRR(c, fx - 12, fy - 26, 24, 62, 12, '#F5CBA4');
    fillRR(c, fx - 30, fy + 14, 60, 50, 22, '#F5CBA4');
    c.strokeStyle = 'rgba(160,110,70,0.5)'; c.lineWidth = 3; rr(c, fx - 12, fy - 26, 24, 62, 12); c.stroke();
    text(c, '長押しで', hx + 120, hy + 64, 28, PAL.ink, 'left');
    text(c, 'よそう', hx + 120, hy + 102, 34, PAL.orange, 'left');
    text(c, 'はなすと決定', hx + 120, hy + 142, 26, PAL.ink, 'left');
    text(c, '前の子とくらべて', hx + hw / 2, hy + 194, 24, PAL.inkSoft);
    // banner
    var by = 150;
    fillRR(c, 48, by + 10, 624, 236, 34, 'rgba(60,40,20,0.25)');
    fillRR(c, 40, by, 624, 236, 34, PAL.cream);
    c.strokeStyle = PAL.orange; c.lineWidth = 8; rr(c, 40, by, 624, 236, 34); c.stroke();
    var wob = Math.sin(G.time * 3) * 0.02;
    c.save(); c.translate(352, by + 70); c.rotate(wob);
    text(c, 'ぴったり', 0, 0, 72, PAL.orange, 'center', { stroke: '#FFFFFF', strokeW: 12 });
    c.restore();
    text(c, '給食当番', 352, by + 168, 104, PAL.ink, 'center', { stroke: '#FFFFFF', strokeW: 12 });
    // rule box
    var ry = 1102;
    fillRR(c, 34, ry, 652, 104, 22, 'rgba(255,255,255,0.95)');
    c.strokeStyle = PAL.hudLine; c.lineWidth = 3; rr(c, 34, ry, 652, 104, 22); c.stroke();
    c.font = font(27);
    var lines = wrapText(c, '鍋のカレーをクラス全員に同じ量ずつよそって、最後の一人でぴったり空にしよう！', 600);
    lines.forEach(function (ln, i) { text(c, ln, W / 2, ry + 34 + i * 38, 27, PAL.ink); });
    c.globalAlpha = 0.55 + 0.45 * Math.sin(G.time * 4.5);
    text(c, 'タップでスタート', W / 2, 1246, 42, PAL.orange, 'center', { stroke: '#FFFFFF', strokeW: 9 });
    c.globalAlpha = 1;
    if (G.best.score > 0) {
      fillRR(c, 24, 36, 260, 52, 26, 'rgba(255,255,255,0.92)');
      c.strokeStyle = PAL.hudLine; c.lineWidth = 3; rr(c, 24, 36, 260, 52, 26); c.stroke();
      text(c, 'ベスト ' + G.best.score + '点', 154, 63, 26, PAL.ink);
    }
    drawMuteButton(c);
  }
  var TITLE_KID = (function () { var k = makeKid(mulberry32(42), 0); k.hair = 2; k.hairColor = '#3B2A1F'; k.tie = '#F06A7A'; return k; })();
  var TITLE_PLATE = { kid: TITLE_KID, amount: 1.05, expect: 1, bowl: false, seed: 3.3, x: L.curX, tx: L.curX, pop: 0,
    chunks: [{ a: 0.4, d: 0.5, type: 'carrot', rot: 0.3, size: 15 }, { a: 2.2, d: 0.6, type: 'potato', rot: 1, size: 16 }, { a: 4.1, d: 0.4, type: 'meat', rot: 0.2, size: 16 }, { a: 5.3, d: 0.7, type: 'carrot', rot: 2, size: 13 }] };
  var TITLE_CHUNKS = (function () {
    var r = mulberry32(9), a = [];
    for (var i = 0; i < 40; i++) a.push({ u: r() * 2 - 1, h: r(), type: pick(r, MENU_LOOK.curry.chunks), rot: r() * TAU, size: 10 + r() * 8 });
    return a;
  })();

  function drawResult(c) {
    var r = G.result;
    c.fillStyle = '#FFF4DF'; c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(242,140,40,0.08)';
    for (var yy = 0; yy < H; yy += 64) for (var xx = (yy / 64) % 2 ? 32 : 0; xx < W; xx += 64) { circle(c, xx, yy, 10); c.fill(); }
    var a = easeOutBack(clamp(G.t / 0.4, 0, 1));
    c.save(); c.translate(W / 2, 96); c.scale(a, a);
    var title = r.reason === 'graduate' ? '卒業おめでとう！' : r.label + 'で終了';
    text(c, title, 0, 0, 66, PAL.ink, 'center', { stroke: '#FFFFFF', strokeW: 12 });
    c.restore();
    var reasonText = r.reason === 'graduate' ? '6年3組まで、ぜんぶ配りきった！' : r.reason === 'meeting' ? '不満がたまって学級会になっちゃった…' : '鍋が空っぽで、給食が足りなかった…';
    text(c, reasonText, W / 2, 164, 28, r.reason === 'graduate' ? PAL.orange : PAL.inkSoft);
    text(c, 'スコア', W / 2, 212, 26, PAL.inkSoft);
    var shown = Math.round(r.score * easeOutCubic(clamp((G.t - 0.2) / 0.8, 0, 1)));
    text(c, shown + '点', W / 2, 274, 92, PAL.orange, 'center', { stroke: '#FFFFFF', strokeW: 12 });
    if (r.newBest) {
      c.save(); c.translate(W / 2 + 232, 214); c.rotate(0.15 + Math.sin(G.time * 4) * 0.04);
      drawTag(c, 'ベスト更新！', 0, 0, PAL.red, 28);
      c.restore();
    }
    text(c, 'ベスト ' + r.best + '点', W / 2, 340, 28, PAL.ink);
    if (r.face) {
      var fs = easeOutBack(clamp((G.t - 0.35) / 0.35, 0, 1));
      if (fs > 0) {
        var fbx = 98, fby = 268 + Math.sin(G.time * 3) * 3;
        fillCircle(c, fbx, fby + 4, 64 * fs, r.reason === 'graduate' ? '#FFE3B0' : r.reason === 'meeting' ? '#FFD9D3' : '#DCEAF5');
        drawKid(c, r.face.kid, fbx, fby + 6, 0.86 * fs, { headOnly: true, expr: r.face.expr, look: 0, clap: r.reason === 'graduate' ? G.time * 12 : null });
        if (r.reason === 'empty' && fs >= 1) { drawSweat(c, fbx - 30, fby + 40, 7); }
      }
    }

    // 成績表 (report card)
    var x = 46, y = 378, w = 628, h = 684;
    fillRR(c, x + 8, y + 12, w, h, 24, 'rgba(60,40,20,0.2)');
    fillRR(c, x, y, w, h, 24, PAL.paper);
    c.strokeStyle = '#7FB6D8'; c.lineWidth = 6; rr(c, x, y, w, h, 24); c.stroke();
    fillRR(c, x, y, w, 76, 24, '#7FB6D8'); c.fillStyle = '#7FB6D8'; c.fillRect(x, y + 40, w, 36);
    text(c, '給食当番 せいせきひょう', W / 2, y + 40, 34, '#FFFFFF');
    drawFlower(c, x + 44, y + 38, 18, '#FFD3DF');
    var stamp = r.evenness >= 80 || r.pittari > 0 || r.reason === 'graduate';
    if (!stamp) drawFlower(c, x + w - 44, y + 38, 18, '#FFE9A8');
    var grade = r.evenness >= 85 ? ['◎', 'よくできました', PAL.red] : r.evenness >= 65 ? ['○', 'できました', PAL.orange] : ['△', 'もうすこし', PAL.blue];
    // the last plates of the run: evenness at a glance (and the empty one, if it ran out)
    var ry = y + 104;
    text(c, r.reason === 'graduate' ? '6年3組のさいごのお皿' : 'さいごのお皿', x + 40, ry, 24, '#5E93B5', 'left');
    drawResultPlates(c, r.plates || [], x + 40, ry + 58, w - 80);
    ry += 140;
    var rows = [
      ['いけたクラス', r.reason === 'graduate' ? '6年3組 完走' : r.label],
      ['よそった人数', r.served + '人'],
      ['均等度（平均）', r.evenness + '点'],
      ['ぴったり完食', r.pittari + '回'],
      ['不満マーク', r.complaints + 'こ']
    ];
    rows.forEach(function (row) {
      text(c, row[0], x + 40, ry, 28, PAL.ink, 'left');
      text(c, row[1], x + w - 40, ry, 32, PAL.ink, 'right');
      c.strokeStyle = 'rgba(127,182,216,0.6)'; c.lineWidth = 2; line(c, x + 30, ry + 25, x + w - 30, ry + 25);
      ry += 50;
    });
    // overall mark
    text(c, 'もりつけ', x + 40, ry + 4, 28, PAL.ink, 'left');
    text(c, grade[0] + ' ' + grade[1], x + w - 40, ry + 4, 34, grade[2], 'right');
    ry += 40;
    // teacher's comment
    fillRR(c, x + 26, ry, w - 52, 128, 14, '#F3F8FB');
    text(c, '先生より', x + 46, ry + 22, 20, '#5E93B5', 'left');
    c.font = font(23);
    var lines = wrapText(c, r.comment, w - 100);
    lines.slice(0, 3).forEach(function (ln, i) { text(c, ln, x + 46, ry + 52 + i * 30, 23, PAL.ink, 'left'); });
    // はなまる stamp on the card corner
    if (stamp) drawHanamaru(c, x + w - 60, y + 36, clamp((G.t - 0.6) / 0.3, 0, 1), 0.62);

    drawButton(c, L.retryBtn, 'もう一回', PAL.orange, G.resultPress === 'retry');
    drawButton(c, L.shareBtn, 'シェア', PAL.blue, G.resultPress === 'share');
    if (G.toast) {
      var ta = clamp(Math.min(G.toast.t / 0.15, (2.2 - G.toast.t) / 0.3), 0, 1);
      c.globalAlpha = ta;
      fillRR(c, W / 2 - 170, 1218, 340, 52, 26, 'rgba(58,42,32,0.9)');
      text(c, G.toast.text, W / 2, 1245, 26, '#FFFFFF');
      c.globalAlpha = 1;
    }
    drawMuteButton(c);
  }
  // mini plates, blob area ∝ (amount ÷ expectation ÷ fair share): even serving = even blobs
  function drawResultPlates(c, plates, x, cy, w) {
    var n = plates.length;
    if (!n) { text(c, '（まだだれもよそっていない）', x + w / 2, cy, 22, PAL.inkSoft); return; }
    var gap = Math.min(58, w / n), R = Math.min(27, gap * 0.46);
    var x0 = x + w / 2 - (n - 1) * gap / 2;
    var look = MENU_LOOK[G.cls ? G.cls.menuKey : 'curry'];
    for (var i = 0; i < n; i++) {
      var p = plates[i], px = x0 + i * gap;
      var show = clamp((G.t - 0.3 - i * 0.05) / 0.2, 0, 1);
      if (show <= 0) continue;
      var s = easeOutBack(show);
      c.save(); c.translate(px, cy); c.scale(s, s);
      fillCircle(c, 2, 3, R, 'rgba(90,60,30,0.15)');
      fillCircle(c, 0, 0, R, p.bad ? '#F2B8B0' : '#C9D6E2');
      fillCircle(c, 0, 0, R - 4, '#EDF2F7');   // tinted well so white rice / cream stew still read
      if (p.empty) {
        text(c, '？', 0, 1, R * 1.1, PAL.red);
      } else {
        var br = Math.min(R * 1.02, R * 0.7 * Math.sqrt(Math.max(0, p.rel)));
        if (br > 0.8) {
          fillCircle(c, 0, 0, br, look.mini);
          c.strokeStyle = look.miniEdge; c.lineWidth = 2.5; circle(c, 0, 0, br); c.stroke();
          fillEllipse(c, -br * 0.3, -br * 0.35, br * 0.35, br * 0.16, -0.4, 'rgba(255,255,255,0.45)');
        }
      }
      if (p.bad) { fillCircle(c, R * 0.74, -R * 0.8, 10, PAL.red); drawAnger(c, R * 0.74, -R * 0.8, 5.5, '#FFFFFF'); }
      c.restore();
    }
  }
  function drawButton(c, b, label, color, pressed) {
    var off = pressed ? 6 : 0;
    fillRR(c, b.x, b.y + 10, b.w, b.h, 30, 'rgba(60,40,20,0.3)');
    fillRR(c, b.x, b.y + off, b.w, b.h, 30, color);
    fillRR(c, b.x + 8, b.y + off + 8, b.w - 16, b.h * 0.38, 20, 'rgba(255,255,255,0.22)');
    text(c, label, b.x + b.w / 2, b.y + off + b.h / 2 + 2, 44, '#FFFFFF');
  }
  function drawFlower(c, x, y, r, color) {
    for (var i = 0; i < 5; i++) { var a = i * TAU / 5; fillCircle(c, x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.5, color); }
    fillCircle(c, x, y, r * 0.35, '#FFFFFF');
  }
  function drawHanamaru(c, x, y, s, size) {
    if (s <= 0) return;
    var k = easeOutBack(s) * (size || 1);
    c.save(); c.translate(x, y); c.scale(k, k); c.rotate(-0.2);
    fillEllipse(c, 0, 0, 92, 78, 0, 'rgba(255,255,255,0.92)');
    c.strokeStyle = PAL.red; c.lineWidth = 6; c.lineCap = 'round';
    c.beginPath();
    for (var i = 0; i <= 80; i++) {
      var a = i / 80 * TAU * 2.2, rad = 26 + i * 0.35;
      var px = Math.cos(a) * rad, py = Math.sin(a) * rad * 0.8;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.stroke();
    for (var p = 0; p < 6; p++) {
      var pa = p * TAU / 6;
      c.beginPath(); c.ellipse(Math.cos(pa) * 70, Math.sin(pa) * 58, 18, 10, pa, 0, TAU); c.stroke();
    }
    c.restore();
  }

  function render() {
    var c = ctx;
    c.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    c.clearRect(0, 0, W, H);
    try {
      if (G.screen === 'title') drawTitle(c);
      else if (G.screen === 'result') drawResult(c);
      else if (G.cls) {
        drawPlayScene(c);
        drawHUD(c);
        if (G.screen === 'intro') drawIntroCard(c);
        else if (G.screen === 'classEnd') drawClassEndCard(c);
        else if (G.screen === 'over') drawOverOverlay(c);
        drawCrowd(c);          // in front of the overlays: the class is watching
        drawFlyers(c);
        drawCinemaBars(c);
        if (G.screen === 'over' && G.t > CONFIG.overSkipTime) {
          // a pill just above the classmates (the plate labels are hidden during the game over)
          var fa = clamp((G.t - CONFIG.overSkipTime) / 0.3, 0, 1);
          c.globalAlpha = fa;
          fillRR(c, W / 2 - 150, 1118, 300, 56, 28, 'rgba(27,18,12,0.82)');
          c.globalAlpha = fa * (0.75 + 0.25 * Math.sin(G.time * 5));
          text(c, 'タップで結果へ ▶', W / 2, 1147, 30, '#FFFFFF');
          c.globalAlpha = 1;
        }
      }
    } catch (e) {
      G.errors.push('render: ' + (e && e.stack || e));
      if (G.errors.length > 50) G.errors.length = 50;
    }
  }

  // =====================================================================
  // 11. MAIN LOOP, RESIZE, DOM INPUT
  // =====================================================================
  function resize() {
    // inside a #stage wrapper (a page that keeps clear of phone safe areas) fit the wrapper, otherwise the window
    var st = canvas.parentElement && canvas.parentElement.id === 'stage' ? canvas.parentElement : null;
    var vw = (st ? st.clientWidth : window.innerWidth) || W, vh = (st ? st.clientHeight : window.innerHeight) || H;
    var scale = Math.min(vw / W, vh / H);
    var cssW = Math.max(1, Math.floor(W * scale)), cssH = Math.max(1, Math.floor(H * scale));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    renderScale = canvas.width / W;
    render();
  }
  function toLogical(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / (r.width || 1) * W, y: (e.clientY - r.top) / (r.height || 1) * H };
  }
  function bindDom() {
    var opts = { passive: false };
    document.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      try { if (e.target && e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      var p = toLogical(e);
      pointerDown(p.x, p.y, e.pointerId);
    }, opts);
    var up = function (e) { var p = toLogical(e); pointerUp(p.x, p.y, e.pointerId); };
    document.addEventListener('pointermove', function (e) {
      var p = toLogical(e);
      // the mouse button came up somewhere we never heard about (outside the window
      // without capture): treat it as the release instead of pouring forever
      if (e.pointerType === 'mouse' && e.buttons === 0 && Input.pointers[e.pointerId]) { up(e); return; }
      pointerMove(p.x, p.y, e.pointerId);
    }, opts);
    document.addEventListener('pointerup', up, opts);
    document.addEventListener('pointercancel', up, opts);
    document.addEventListener('lostpointercapture', function (e) { if (Input.pointers[e.pointerId]) up(e); }, opts);
    ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange', 'dblclick', 'contextmenu', 'selectstart'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); }, opts);
    });
    // trackpad pinch / ctrl+wheel would zoom the page on desktop
    document.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, opts);
    window.addEventListener('keydown', function (e) {
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyM') e.preventDefault();
      if (e.repeat) return;
      keyDown(e.code);
    });
    window.addEventListener('keyup', function (e) { keyUp(e.code); });
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', function () { if (document.hidden) releaseAll(); });
    window.addEventListener('resize', resize);
  }
  var lastTs = 0, acc = 0, lastRafWall = 0;
  function frame() {
    requestAnimationFrame(frame);
    lastRafWall = performance.now();
    tick(lastRafWall); // one clock (performance.now) for both rAF and the watchdog
  }
  // Fallback for environments where rAF is starved while the page is visible
  // (some webviews / headless runs). Hidden tabs stay paused.
  function startWatchdog() {
    setInterval(function () {
      if (document.hidden) return;
      var now = performance.now();
      if (now - lastRafWall > 250) tick(now);
    }, 1000 / 30);
  }
  function tick(ts) {
    if (!lastTs) lastTs = ts;
    var dt = clamp((ts - lastTs) / 1000, 0, CONFIG.maxFrameDt);
    lastTs = ts;
    if (!G.frozen && !TEST_MODE) {
      acc += dt;
      var n = 0;
      while (acc >= DT && n < 30) {
        try { update(DT); } catch (e) { if (G.errors.length < 50) G.errors.push('update: ' + (e && e.stack || e)); }
        acc -= DT; n++;
      }
      if (n >= 30) acc = 0;
    }
    render();
  }

  // =====================================================================
  // 12. TEST HOOKS — window.__game, ?test=1, ?shot=
  // =====================================================================
  // one handler (the old pair logged every error twice); capped so a per-frame error can't grow memory
  window.onerror = function (msg, src, line) {
    if (G.errors.length < 50) G.errors.push('onerror: ' + msg + ' @' + line);
    return false;
  };
  window.addEventListener('unhandledrejection', function (e) {
    if (G.errors.length < 50) G.errors.push('unhandledrejection: ' + (e && e.reason && (e.reason.stack || e.reason)));
  });

  function stepN(n) {
    n = n || 1;
    for (var i = 0; i < n; i++) update(DT);
    return snapshot();
  }
  function snapshot() {
    var pot = G.pot, plate = G.curPlate;
    return {
      screen: G.screen, phase: G.phase, frame: G.frame, seed: G.runSeed,
      classIndex: G.ci, classLabel: G.cls ? G.cls.label : null,
      menu: G.cls ? G.cls.menuKey : null, shape: G.cls ? G.cls.shapeKey : null,
      remainingKids: G.queue.length, servedCount: G.served.length, leftCount: G.leftCount,
      complaints: G.complaints, runScore: G.runScore, muted: Sfx.muted,
      holding: heldCount() > 0, hint: hintKey(),
      pot: pot ? { remaining: pot.remaining, V: pot.V, capacity: pot.capacity, level: pot.shape.levelForVolume(pot.remaining / pot.capacity) } : null,
      plate: plate ? { amount: plate.amount, expect: plate.expect } : null,
      prevPlate: G.prevPlate ? { amount: G.prevPlate.amount, expect: G.prevPlate.expect } : null,
      served: G.served.map(function (s) { return { amount: s.amount, expect: s.expect, norm: s.norm, verdict: s.verdict }; }),
      classResults: G.classResults.slice(),
      endReason: G.overReason, result: G.result, best: G.best.score,
      particles: G.particles.length
    };
  }
  // Simple bot used by the self-test and screenshot setups.
  function botWaitReady(maxSteps) {
    var g = 0;
    while (!(G.screen === 'play' && G.phase === 'ready') && g++ < (maxSteps || 900)) {
      if (G.screen !== 'play') return false;
      update(DT);
    }
    return G.screen === 'play' && G.phase === 'ready';
  }
  function botServeAmount(target) {
    if (!botWaitReady()) return false;
    pointerDown(W / 2, 950, 'bot');
    var g = 0;
    while (G.screen === 'play' && G.phase === 'pour' && G.curPlate.amount < target && g++ < 3000) update(DT);
    pointerUp(W / 2, 950, 'bot');
    return true;
  }
  // serve `norm` servings per unit of expectation (2x for 大盛り etc.)
  function botServeNorm(norm) {
    if (!botWaitReady()) return false;
    return botServeAmount(norm * G.curPlate.expect);
  }
  function botServeFair(mult) {
    if (!botWaitReady()) return false;
    return botServeAmount((mult || 1) * fairShareNow() * G.curPlate.expect);
  }
  function botServeRel(mult) {
    if (!botWaitReady()) return false;
    var prev = G.served[G.served.length - 1];
    var base = prev ? prev.norm : G.cls.k;
    return botServeAmount(mult * base * G.curPlate.expect);
  }

  window.__game = {
    config: CONFIG,
    shapes: SHAPES,
    start: function (o) {
      o = o || {};
      Input.pointers = {}; Input.ignore = {}; Input.space = false;
      startRun(o.seed != null ? o.seed : (URL_SEED != null ? URL_SEED : 1), o.classIndex || 0);
      return snapshot();
    },
    step: stepN,
    render: render,
    state: snapshot,
    input: {
      down: function (x, y, id) { pointerDown(x, y, id == null ? 'test' : id); },
      move: function (x, y, id) { pointerMove(x, y, id == null ? 'test' : id); },
      up: function (x, y, id) { pointerUp(x, y, id == null ? 'test' : id); },
      tap: function (x, y, id) { var k = id == null ? 'tap' : id; pointerDown(x, y, k); update(DT); pointerUp(x, y, k); }
    },
    key: {
      down: function (code) { keyDown(code || 'Space'); },
      up: function (code) { keyUp(code || 'Space'); }
    },
    forceGameOver: function (reason) {
      if (G.screen === 'title' || !G.cls) startRun(URL_SEED != null ? URL_SEED : 1);
      if (G.screen === 'intro') beginPlay();
      startOver(reason === 'meeting' ? 'meeting' : 'empty');
      return snapshot();
    },
    debug: {
      botServeFair: botServeFair, botServeAmount: botServeAmount, botServeRel: botServeRel, botServeNorm: botServeNorm,
      fairShare: fairShareNow,
      classInfo: function () { var c = G.cls; return c ? { k: c.k, V: c.V, size: c.size, sumW: c.sumW, hasTeacher: c.hasTeacher, leaves: c.leaves.slice(), types: c.kids.map(function (q) { return q.type; }), tolerance: c.tolerance } : null; },
      buttons: function () { return { retry: L.retryBtn, share: L.shareBtn, mute: { x: L.muteBtn.x, y: L.muteBtn.y } }; },
      saveBest: saveBest, loadBest: loadBest, toggleMute: toggleMute,
      Sfx: Sfx, SOUNDS: SOUNDS, Input: Input, retry: retryRun, shareText: shareText, doShare: doShare,
      blur: releaseAll, nextClass: nextClass, beginPlay: beginPlay,
      setScreen: function (s) { G.screen = s; G.t = 0; },
      G: G
    }
  };

  function runSelfTest() {
    var g = window.__game;
    var seed = URL_SEED != null ? URL_SEED : 1;
    var rep = { game: 'ぴったり給食当番', seed: seed, pass: false, checks: [], errors: [], summary: {} };
    function check(name, ok, detail) { rep.checks.push({ name: name, ok: !!ok, detail: detail === undefined ? null : detail }); }
    function servedSum(st) { return sum(st.served, function (s) { return s.amount; }); }
    var savedBest = Store.get(KEY_BEST), savedMute = Store.get(KEY_MUTE);
    try {
      check('api present', g && typeof g.start === 'function' && typeof g.step === 'function' && typeof g.state === 'function' && g.input && typeof g.input.down === 'function' && typeof g.input.up === 'function' && typeof g.input.move === 'function');
      check('title screen on load', g.state().screen === 'title');

      // --- pot level<->volume tables ---
      Object.keys(SHAPES).forEach(function (k) {
        var s = SHAPES[k], mono = true, maxErr = 0, prev = -1;
        for (var i = 0; i <= 200; i++) {
          var h = i / 200, v = s.volumeForLevel(h);
          if (v < prev - 1e-12) mono = false;
          prev = v;
          maxErr = Math.max(maxErr, Math.abs(s.levelForVolume(v) - h));
        }
        check('pot table ' + k + ' monotonic & invertible', mono && maxErr < 0.01 && Math.abs(s.volumeForLevel(1) - 1) < 1e-9 && s.volumeForLevel(0) === 0,
          { maxRoundTripErr: +maxErr.toFixed(5), volumeAtHalfHeight: +s.volumeForLevel(0.5).toFixed(3) });
      });
      check('寸胴 is linear', Math.abs(SHAPES.zundou.volumeForLevel(0.5) - 0.5) < 0.03);
      check('丸底 is non-linear (30% height < 22% volume)', SHAPES.marusoko.volumeForLevel(0.3) < 0.22, SHAPES.marusoko.volumeForLevel(0.3));
      check('ボウル is non-linear (half height < 40% volume)', SHAPES.bowl.volumeForLevel(0.5) < 0.4, SHAPES.bowl.volumeForLevel(0.5));

      // --- start + first serving ---
      var st = g.start({ seed: seed });
      check('start → intro 1年1組', st.screen === 'intro' && st.classLabel === '1年1組', st.classLabel);
      g.step(30); g.input.tap(360, 640); g.step(2);
      st = g.state();
      check('tap → play / ready', st.screen === 'play' && st.phase === 'ready', st.phase);
      var V = st.pot.V;
      g.input.down(360, 900, 1); g.step(10);
      var early = g.state().plate.amount;
      g.step(62);
      st = g.state();
      check('flow ramps up then pours while held', st.phase === 'pour' && early > 0 && early < 0.12 && st.plate.amount > 0.6, { after10: +early.toFixed(3), after72: +st.plate.amount.toFixed(3) });
      check('pot level drops while pouring', st.pot.remaining < V);
      g.input.up(360, 900, 1);
      st = g.state();
      check('release finalizes serving', st.servedCount === 1 && st.phase === 'beat', { served: st.servedCount, phase: st.phase });
      check('volume conserved (pot + plates)', Math.abs(st.pot.remaining + servedSum(st) - V) < 1e-9);

      // --- hold during the beat must not leak into next kid ---
      g.input.down(360, 900, 2);
      check('press during beat does not pour', g.state().phase === 'beat');
      g.step(70);
      st = g.state();
      check('early hold does not leak into next kid', st.phase === 'ready' && st.plate.amount === 0 && st.holding === true, { phase: st.phase, amount: st.plate.amount });
      check('hint asks to release', st.hint === 'release', st.hint);
      g.step(20);
      check('still nothing poured while early hold continues', g.state().plate.amount === 0);
      g.input.up(360, 900, 2); g.step(2);
      st = g.state();
      check('release of early hold does not serve', st.servedCount === 1 && st.plate.amount === 0);

      // --- tiny tap does not finalize ---
      g.input.down(360, 900, 3); g.step(2); g.input.up(360, 900, 3);
      st = g.state();
      check('tiny tap keeps the same kid waiting', st.servedCount === 1 && st.phase === 'ready', { phase: st.phase });

      // --- fairness ---
      g.debug.botServeRel(1.0);
      st = g.state();
      check('matching the previous plate → no complaint', st.complaints === 0 && st.servedCount === 2, st.served[1]);
      g.debug.botServeRel(0.6);
      st = g.state();
      check('much less than previous → complaint (えー少なっ)', st.complaints === 1 && st.served[2].verdict === 'less', st.served[2]);
      g.debug.botServeRel(1.4);
      st = g.state();
      check('much more than previous → complaint (あいつだけ多い)', st.complaints === 2 && st.served[3].verdict === 'more', st.served[3]);
      g.debug.botServeRel(0.6);
      st = g.state();
      check('3 complaint marks → 学級会', st.screen === 'over' && st.endReason === 'meeting', { screen: st.screen, reason: st.endReason });
      g.step(60 * 4);
      st = g.state();
      check('学級会 → result screen', st.screen === 'result' && st.result && st.result.label === '1年1組' && st.result.reason === 'meeting', st.result && st.result.label);
      g.render();

      // --- retry button ---
      g.step(60);
      var b = g.debug.buttons().retry;
      g.input.tap(b.x + b.w / 2, b.y + b.h / 2);
      st = g.state();
      check('もう一回 → instantly back in 1年1組', st.screen === 'play' && st.phase === 'ready' && st.classIndex === 0 && st.complaints === 0 && st.runScore === 0 && st.servedCount === 0, { screen: st.screen, phase: st.phase });

      // --- full class with an even-handed bot ---
      var n = 0;
      while (g.state().screen === 'play' && n++ < 200) g.debug.botServeFair(1.0);
      st = g.state();
      var cr = st.classResults[0];
      check('even serving clears 1年1組', st.screen === 'classEnd' && !!cr, { screen: st.screen, complaints: st.complaints });
      check('even serving → high 均等度 and ぴったり', cr && cr.evenness >= 85 && cr.pittari, cr);
      check('class score added to run', cr && st.runScore === cr.score);
      g.render();
      g.step(70); g.input.tap(360, 640);
      st = g.state();
      check('next class → 1年2組 intro', st.screen === 'intro' && st.classLabel === '1年2組' && st.shape === 'marusoko', { label: st.classLabel, shape: st.shape });
      var info = g.debug.classInfo();
      check('1年2組 has a 大盛り kid (2x)', info.types.indexOf('oomori') > 0);

      // --- running the pot dry ---
      g.step(30); g.input.tap(360, 640);
      n = 0;
      while (g.state().screen === 'play' && n++ < 200) g.debug.botServeNorm(1.3 * info.k);
      st = g.state();
      check('over-serving empties the pot → game over (ぼくの分は…？)', st.screen === 'over' && st.endReason === 'empty' && st.remainingKids > 0, { screen: st.screen, reason: st.endReason, left: st.remainingKids });
      g.step(30);
      g.render();
      g.step(60 * 6);
      st = g.state();
      check('empty → result "1年2組で終了"', st.screen === 'result' && st.result.label === '1年2組' && st.result.reason === 'empty', st.result);
      check('best score kept (>= run score)', st.best >= st.result.score, { best: st.best, score: st.result.score });
      g.render();

      // --- teacher + early leaver class ---
      g.start({ seed: seed, classIndex: 4 });
      info = g.debug.classInfo();
      check('2年2組: teacher announced at end + early leaver scheduled', info.hasTeacher && info.types[info.types.length - 1] === 'teacher' && info.leaves.length >= 1, info.leaves);
      g.step(30); g.input.tap(360, 640);
      n = 0;
      while (g.state().screen === 'play' && n++ < 200) g.debug.botServeFair(1.0);
      st = g.state();
      check('early leaver left the line', st.leftCount >= 1, st.leftCount);
      check('teacher class cleared by even bot', st.screen === 'classEnd', { screen: st.screen, reason: st.endReason, complaints: st.complaints });
      check('served = kids − leavers + teacher', st.servedCount === info.size - st.leftCount + 1, { served: st.servedCount, size: info.size, left: st.leftCount });

      // --- determinism ---
      var scripted = function () {
        g.start({ seed: 99 }); g.step(30); g.input.tap(360, 640); g.step(3);
        for (var i = 0; i < 5; i++) { g.input.down(360, 900, 7); g.step(55 + i * 9); g.input.up(360, 900, 7); g.step(65); }
        return g.state();
      };
      var s1 = scripted(), s2 = scripted();
      check('same seed + same inputs → same result', s1.pot.remaining === s2.pot.remaining && s1.servedCount === s2.servedCount && s1.complaints === s2.complaints, { remaining: s1.pot.remaining, served: s1.servedCount });

      // --- storage that throws ---
      var proto = window.Storage && window.Storage.prototype;
      var og = proto && proto.getItem, os = proto && proto.setItem;
      var okThrow = true;
      try {
        if (proto) {
          proto.getItem = function () { throw new Error('blocked'); };
          proto.setItem = function () { throw new Error('blocked'); };
        }
        try {
          g.debug.saveBest(1, 'x'); g.debug.loadBest(); g.debug.toggleMute(); g.debug.toggleMute();
          g.forceGameOver('empty'); g.step(60 * 6);
          okThrow = g.state().screen === 'result';
        } catch (e) { okThrow = false; rep.errors.push('storage: ' + e); }
      } finally { if (proto) { proto.getItem = og; proto.setItem = os; } }
      check('throwing localStorage is tolerated', okThrow);

      // --- mute button does not pour; space key pours ---
      g.start({ seed: 5 }); g.step(30); g.input.tap(360, 640); g.step(2);
      var m0 = g.state().muted, mb = g.debug.buttons().mute;
      g.input.down(mb.x, mb.y, 9); g.step(40); g.input.up(mb.x, mb.y, 9);
      st = g.state();
      check('mute button toggles without pouring', st.muted !== m0 && st.plate.amount === 0 && st.servedCount === 0);
      g.debug.toggleMute();
      g.key.down('Space'); g.step(60); g.key.up('Space');
      st = g.state();
      check('space key hold-to-pour works', st.servedCount === 1, st.served[0]);

      // --- forced game over ---
      g.forceGameOver('meeting'); g.step(60 * 5);
      st = g.state();
      check('forceGameOver → result', st.screen === 'result' && st.endReason === 'meeting');

      // =============== review additions ===============
      var freshPlay = function (s, ci) { g.start({ seed: s, classIndex: ci || 0 }); g.step(30); g.input.tap(360, 640); g.step(2); return g.state(); };
      var waitReady = function () { var k = 0; while (G.screen === 'play' && G.phase !== 'ready' && k++ < 600) g.step(1); return G.screen === 'play' && G.phase === 'ready'; };
      var stepWhile = function (cond, max) { var k = 0; while (cond() && k++ < max) g.step(1); };
      // fair-serve until `left` people (incl. the one at the front) are waiting at the counter
      var serveUntil = function (left) {
        var k = 0;
        while (G.screen === 'play' && k++ < 200) { waitReady(); if (G.screen !== 'play' || G.queue.length <= left) break; g.debug.botServeFair(1.0); }
        return G.screen === 'play' && G.phase === 'ready' && G.queue.length === left;
      };

      // --- retry fully resets a messy run ---
      freshPlay(seed, 4);
      n = 0; while (G.screen === 'play' && G.leftCount < 1 && n++ < 60) g.debug.botServeFair(1.0);
      g.debug.botServeRel(0.6);                       // a complaint, popups, a leaver already gone
      G.toast = { text: 'x', t: 0 };
      g.forceGameOver('empty'); g.step(60 * 6);
      var wasResult = G.screen === 'result';
      b = g.debug.buttons().retry;
      g.forceGameOver('meeting'); stepWhile(function () { return G.screen !== 'result'; }, 600);
      g.input.tap(b.x + b.w / 2, b.y + b.h / 2);       // too soon after the result appears: ignored
      var earlyTapIgnored = G.screen === 'result';
      g.step(60);
      g.input.tap(b.x + b.w / 2, b.y + b.h / 2);
      var fresh = {
        screen: G.screen, phase: G.phase, ci: G.ci, complaints: G.complaints, marks: G.markPop.length, served: G.served.length,
        exiting: G.exiting.length, leavers: G.leavers.length, oldPlates: G.oldPlates.length, prevPlate: !!G.prevPlate,
        plate: G.curPlate && G.curPlate.amount, potFull: G.pot.remaining === G.pot.V, runScore: G.runScore,
        classResults: G.classResults.length, totals: G.totals.served + G.totals.complaints + G.totals.pittari,
        popups: G.popups.length, particles: G.particles.length, overReason: G.overReason, result: G.result,
        lastClassResult: G.lastClassResult, leaveIdx: G.leaveIdx, leftCount: G.leftCount, pour: G.pour.active,
        toast: G.toast, lunchT: G.lunchT, queue: G.queue.length, seed: G.runSeed
      };
      var expectFresh = {
        screen: 'play', phase: 'ready', ci: 0, complaints: 0, marks: 0, served: 0, exiting: 0, leavers: 0, oldPlates: 0, prevPlate: false,
        plate: 0, potFull: true, runScore: 0, classResults: 0, totals: 0, popups: 0, particles: 0, overReason: null, result: null,
        lastClassResult: null, leaveIdx: 0, leftCount: 0, pour: false, toast: null, lunchT: 0, queue: CONFIG.classSizes[0], seed: G.runSeed
      };
      var resetDiff = Object.keys(expectFresh).filter(function (k) { return fresh[k] !== expectFresh[k]; });
      check('もう一回 after a messy run (2年, complaints, leaver, toast) resets every piece of run state', wasResult && earlyTapIgnored && resetDiff.length === 0, { diff: resetDiff.map(function (k) { return k + '=' + JSON.stringify(fresh[k]); }) });
      check('retry keeps the URL seed (?seed=) so a run can be replayed', URL_SEED == null || G.runSeed === URL_SEED, G.runSeed);

      // --- a mute press whose release is lost (blur) must not swallow the next release ---
      freshPlay(seed);
      var mb2 = g.debug.buttons().mute, muted0 = Sfx.muted;
      g.input.down(mb2.x, mb2.y, 1);                  // the mouse is always pointer id 1
      g.debug.blur();                                 // alt-tab before releasing
      g.input.down(360, 900, 1); g.step(40); g.input.up(360, 900, 1); g.step(1);
      st = g.state();
      check('mute press + lost release, then a normal press/release: the pour ends (not stuck on)', st.phase === 'beat' && st.servedCount === 1 && !G.pour.active, { phase: st.phase, served: st.servedCount });
      if (Sfx.muted !== muted0) g.debug.toggleMute();

      // --- a mouseup that never arrived: the next buttonless mouse move releases ---
      freshPlay(seed);
      g.input.down(360, 900, 31); g.step(30);
      var wasPouring = G.phase === 'pour', moveOk = true;
      try { document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 31, pointerType: 'mouse', buttons: 0, clientX: 5, clientY: 5, bubbles: true })); } catch (e) { moveOk = false; }
      st = g.state();
      check('missed mouseup: a buttonless mouse move ends the pour', !moveOk || (wasPouring && st.phase === 'beat' && st.servedCount === 1), { supported: moveOk, phase: st.phase });

      // --- multi-touch: only the finger that started the pour can end it ---
      freshPlay(seed);
      g.input.down(300, 900, 51); g.step(20);
      g.input.down(500, 900, 52); g.step(10);
      var stillPouring1 = G.phase === 'pour';
      g.input.up(500, 900, 52); g.step(10);
      var stillPouring2 = G.phase === 'pour';
      g.input.up(300, 900, 51);
      st = g.state();
      check('multi-touch: a second finger neither starts a second pour nor ends the first', stillPouring1 && stillPouring2 && st.phase === 'beat' && st.servedCount === 1, { phase: st.phase });

      // --- Space pressed during the beat and held into the next kid ---
      freshPlay(seed);
      g.input.down(360, 900, 61); g.step(50); g.input.up(360, 900, 61);
      g.key.down('Space'); g.step(100);
      st = g.state();
      var spaceHeld = st.phase === 'ready' && st.plate.amount === 0 && st.hint === 'release';
      g.key.up('Space'); g.step(2);
      st = g.state();
      check('Space held from the beat into the next kid never pours', spaceHeld && st.plate.amount === 0 && st.servedCount === 1, { phase: st.phase, amount: st.plate.amount });

      // --- last kid empties the pot while held → ぴったり clear; the held finger never pours into the next class ---
      freshPlay(seed);
      var atLast = serveUntil(1);
      g.input.down(360, 900, 71);
      var lastPours = G.phase === 'pour';
      stepWhile(function () { return G.screen === 'play'; }, 60 * 30);
      st = g.state();
      check('pot emptied on the very last kid (held until dry) → class clear with ぴったり, not 鍋が空', atLast && lastPours && st.screen === 'classEnd' && st.pot.remaining === 0 && st.classResults[0] && st.classResults[0].pittari, { atLast: atLast, screen: st.screen, reason: st.endReason });
      g.render();
      g.step(70); g.input.tap(360, 640, 72);           // another finger: next class
      g.step(30); g.input.tap(360, 640, 73);           // start serving
      g.step(120);
      st = g.state();
      var heldNoPour = st.screen === 'play' && st.classIndex === 1 && st.phase === 'ready' && st.plate.amount === 0 && st.hint === 'release';
      g.input.up(360, 900, 71); g.step(2);
      st = g.state();
      check('a finger held since the previous class never pours into the new one', heldNoPour && st.servedCount === 0 && st.plate.amount === 0, { phase: st.phase, served: st.servedCount });

      // --- pot runs dry with kids waiting ---
      freshPlay(seed);
      g.input.down(360, 900, 81);
      stepWhile(function () { return G.screen === 'play' && G.phase === 'pour'; }, 60 * 60);
      var autoReleased = G.phase === 'beat';
      g.input.up(360, 900, 81);
      stepWhile(function () { return G.screen === 'play'; }, 300);
      var overEmpty = G.screen === 'over' && G.overReason === 'empty' && G.queue.length > 0;
      g.step(Math.ceil(2.5 * 60));
      var waiting = G.queue[0];
      var stares = G.queue.length > 1 && G.queue.slice(1).every(function (q) { return q.expr === 'stare'; });
      check('pot dry with kids waiting → 鍋が空: pour auto-ends, next kid asks ぼくの分は…？ over an empty plate, the line turns to stare',
        autoReleased && overEmpty && waiting && waiting.bubble && waiting.bubble.text === emptyLine(waiting) && /の分は…？$/.test(waiting.bubble.text) && G.curPlate.amount === 0 && stares,
        { autoReleased: autoReleased, overEmpty: overEmpty, bubble: waiting && waiting.bubble && waiting.bubble.text });
      g.render();

      // --- the 先生 left without food; teacher-appropriate lines ---
      freshPlay(seed, 3);
      G.cls.tolerance = 0.5;                           // keep the fair bot complaint-free here
      var atTeacher = serveUntil(2) && G.queue[1].teacher;
      g.input.down(360, 900, 82);
      stepWhile(function () { return G.screen === 'play' && G.phase === 'pour'; }, 60 * 60);
      g.input.up(360, 900, 82);
      var teacherLine = G.queue[1] && G.queue[1].teacher && G.queue[1].bubble ? G.queue[1].bubble.text : null;
      stepWhile(function () { return G.screen === 'play'; }, 300);
      g.step(Math.ceil(1.3 * 60));
      var tq = G.queue[0];
      check('先生 next in line reacts with a teacher line; left without food → 先生の分は…？',
        atTeacher && teacherLine === LINES.moreSeenByTeacher[0] && G.screen === 'over' && G.overReason === 'empty' && tq && tq.teacher && tq.bubble && tq.bubble.text === LINES.emptyTeacher,
        { complaintLine: teacherLine, screen: G.screen, bubble: tq && tq.bubble && tq.bubble.text });

      // --- これだけ！？ floor on the first kid ---
      freshPlay(seed);
      g.debug.botServeAmount(0.2 * G.cls.k);
      st = g.state();
      check('a tiny first serving → これだけ！？ complaint', st.complaints === 1 && st.served[0].verdict === 'tiny', st.served[0]);

      // --- determinism: drawing must not consume the gameplay RNG ---
      var detRun = function (withRender) {
        g.start({ seed: 21, classIndex: 4 }); g.step(30); g.input.tap(360, 640); g.step(2);
        var k = 0;
        while (G.screen === 'play' && k++ < 200) {
          g.debug.botServeFair(1.0);
          if (withRender) { G.shake = 5; for (var i = 0; i < 1 + k % 3; i++) g.render(); }
        }
        // the served line (ids, types, amounts) and both RNG streams must end in the same state
        return G.screen + '|' + G.prng() + '|' + G.vrng() + '|' + G.served.map(function (q) { return q.id + q.type + ':' + q.amount.toFixed(6); }).join(',');
      };
      var dA = detRun(false), dB = detRun(true);
      check('same seed + same inputs → same run even with extra renders (frame rate cannot change the line)', dA === dB, dA === dB ? null : [dA.slice(0, 200), dB.slice(0, 200)]);

      // --- 昼休みの時計: the line speeds up as the clock runs ---
      freshPlay(seed);
      g.debug.botServeFair(1.0);
      var beat1 = G.beatLen - (G.served[0].verdict === 'ok' || G.served[0].verdict === 'same' ? 0 : CONFIG.complainBeatExtra);
      waitReady();
      g.step(Math.ceil(G.cls.kids.length * CONFIG.lunchSecPerKid * 60) + 5);   // dawdle until 12:50
      g.debug.botServeRel(1.0);
      var v2 = G.served[1].verdict;
      var beat2 = G.beatLen - (v2 === 'ok' || v2 === 'same' ? 0 : CONFIG.complainBeatExtra);
      check('昼休みの時計 runs during a class and the beat between kids shrinks with it', Math.abs(beat2 - beat1 * CONFIG.lunchRush) < 0.02 && beat1 > beat2, { beat1: +beat1.toFixed(3), beat2: +beat2.toFixed(3) });
      g.render();

      // --- best score: a higher run saves, a lower run keeps it ---
      Store.remove(KEY_BEST); G.best = { score: 0, label: '' };
      freshPlay(seed); G.runScore = 123; g.forceGameOver('meeting'); stepWhile(function () { return G.screen !== 'result'; }, 600);
      var r1 = G.result;
      freshPlay(seed); G.runScore = 50; g.forceGameOver('meeting'); stepWhile(function () { return G.screen !== 'result'; }, 600);
      var r2 = G.result;
      check('best score: higher run → ベスト更新 + saved; lower run keeps the best', r1.newBest && r1.best === 123 && !r2.newBest && r2.best === 123 && loadBest().score === 123 && G.best.score === 123,
        { r1: [r1.score, r1.best, r1.newBest], r2: [r2.score, r2.best, r2.newBest], stored: loadBest().score });

      // --- graduation after 6年3組 ---
      freshPlay(seed, CONFIG.classesPerGrade * CONFIG.maxGrade - 1);
      G.cls.tolerance = 0.5;
      n = 0; while (G.screen === 'play' && n++ < 300) g.debug.botServeFair(1.0);
      var gradClear = G.screen === 'classEnd';
      g.render();
      g.step(70); g.input.tap(360, 640);
      st = g.state();
      check('clearing 6年3組 → 卒業 result and share text', gradClear && st.screen === 'result' && st.result.reason === 'graduate' && st.result.label === '6年3組' && /卒業/.test(g.debug.shareText()),
        { screen: st.screen, reason: st.result && st.result.reason });
      g.render();

      // --- localStorage whose getter itself throws (Safari with blocked site data) ---
      var lsDesc = Object.getOwnPropertyDescriptor(window, 'localStorage'), lsDefined = false, lsOk = true;
      try {
        Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { throw new Error('SecurityError'); } });
        lsDefined = true;
        g.debug.saveBest(5, 'x'); g.debug.loadBest(); g.debug.toggleMute(); g.debug.toggleMute();
        freshPlay(seed); G.runScore = 7; g.forceGameOver('meeting'); stepWhile(function () { return G.screen !== 'result'; }, 600);
        lsOk = G.screen === 'result' && G.result.best >= 7;
      } catch (e) { lsOk = false; rep.errors.push('localStorage getter: ' + e); }
      finally {
        if (lsDefined) { try { if (lsDesc) Object.defineProperty(window, 'localStorage', lsDesc); else delete window.localStorage; } catch (e) { /* ignore */ } }
      }
      check('localStorage getter that throws is tolerated (result still shows a best)', lsOk, { overridden: lsDefined });

      // --- audio: silent no-ops before the first gesture, synthesis paths don't throw after ---
      var sv = { disabled: Sfx.disabled, ctx: Sfx.ctx, master: Sfx.master, noiseBuf: Sfx.noiseBuf, pourNodes: Sfx.pourNodes };
      var audioErrs = [], hadAudio = false;
      try {
        Sfx.disabled = false; Sfx.ctx = null; Sfx.pourNodes = null;
        Object.keys(SOUNDS).forEach(function (k) { Sfx.play(k); });
        Sfx.pour(0.3, 400);
        Sfx.unlock();
        hadAudio = !!Sfx.ctx;
        if (hadAudio) {
          Object.keys(SOUNDS).forEach(function (k) { try { SOUNDS[k](Sfx); } catch (e) { audioErrs.push(k + ': ' + e); } });
          Sfx.pour(0.3, 400); Sfx.pour(0, 0);
        }
      } catch (e) { audioErrs.push('audio: ' + e); }
      finally {
        try { if (Sfx.ctx && Sfx.ctx.close) { var cp = Sfx.ctx.close(); if (cp && cp.catch) cp.catch(function () {}); } } catch (e) { /* ignore */ }
        Sfx.disabled = sv.disabled; Sfx.ctx = sv.ctx; Sfx.master = sv.master; Sfx.noiseBuf = sv.noiseBuf; Sfx.pourNodes = sv.pourNodes;
      }
      check('sound: no-op before unlock; every synthesized SFX runs without errors after', audioErrs.length === 0, { audioContext: hadAudio, errors: audioErrs });

      // --- random-input soak: NaN / volume / stuck states ---
      var nonFinite = function (o, path, depth) {
        if (typeof o === 'number') return isFinite(o) ? [] : [path];
        if (!o || typeof o !== 'object' || depth > 4) return [];
        var out = [];
        Object.keys(o).forEach(function (k) { out = out.concat(nonFinite(o[k], path + '.' + k, depth + 1)); });
        return out;
      };
      var soak = [];
      for (var sd = 1; sd <= 3; sd++) {
        var rr3 = mulberry32(sd * 7919 + seed);
        g.start({ seed: sd, classIndex: sd });
        var held = {}, sameKey = '', sameT = 0;
        for (var stp = 0; stp < 3600 && soak.length < 5; stp++) {
          var x = rr3();
          if (x < 0.02) { var pid = 1 + Math.floor(rr3() * 3); if (!held[pid]) { held[pid] = 1; g.input.down(rr3() * W, rr3() * H, pid); } }
          else if (x < 0.045) { var hk = Object.keys(held); if (hk.length) { var hid = hk[Math.floor(rr3() * hk.length)]; delete held[hid]; g.input.up(rr3() * W, rr3() * H, +hid); } }
          else if (x < 0.05) { if (Input.space) g.key.up('Space'); else g.key.down('Space'); }
          else if (x < 0.0505) { g.debug.blur(); held = {}; }
          if (G.screen === 'result' && rr3() < 0.03) { b = g.debug.buttons().retry; g.input.tap(b.x + 5, b.y + 5, 99); }
          g.step(1);
          var key = G.screen + '/' + G.phase;
          if (key === sameKey) sameT++; else { sameKey = key; sameT = 0; }
          var lim = { 'intro': 6.3, 'over': 5, 'beat': 2.5, 'step': 0.6 }[G.screen === 'play' ? G.phase : G.screen];
          if (lim && sameT * DT > lim) soak.push('stuck ' + key + ' seed ' + sd);
          if (G.pot) {
            var tot = G.pot.remaining + sum(G.served, function (q) { return q.amount; }) + (G.curPlate && G.curPlate.verdict == null ? G.curPlate.amount : 0);
            if ((G.screen === 'play' || G.screen === 'over') && Math.abs(tot - G.pot.V) > 1e-6) soak.push('volume ' + tot + ' vs ' + G.pot.V);
            if (!isFinite(G.pot.remaining) || G.pot.remaining < 0) soak.push('pot ' + G.pot.remaining);
          }
          if (stp % 50 === 0) {
            var bad = nonFinite(g.state(), 'state', 0).concat(nonFinite(G.pour, 'pour', 0));
            if (bad.length) soak.push('non-finite: ' + bad.join(','));
            if (!isFinite(G.shake) || !isFinite(G.lunchT)) soak.push('non-finite shake/lunchT');
            render();
          }
        }
        if (Input.space) g.key.up('Space');
        g.debug.blur();
      }
      check('random-input soak (multi-touch, Space, blur, retries): no NaN, volume conserved, nothing stuck, no errors', soak.length === 0 && G.errors.length === 0, soak.slice(0, 5));

      // =============== game-feel / staging additions ===============
      // --- a press that starts while the next kid steps up pours once they're ready ---
      freshPlay(seed);
      g.debug.botServeFair(1.0);
      stepWhile(function () { return G.phase !== 'step'; }, 300);
      g.input.down(360, 900, 101); g.step(2);
      var bufPending = G.pendingPress === 101 && G.phase === 'step';
      stepWhile(function () { return G.phase === 'step'; }, 120);
      var bufPours = G.phase === 'pour' && G.pour.owner === 101;
      g.step(40); g.input.up(360, 900, 101);
      var bufServed = G.served.length === 2 && G.phase === 'beat';
      stepWhile(function () { return G.phase !== 'step'; }, 300);
      g.input.down(360, 900, 102); g.step(1); g.input.up(360, 900, 102);   // tapped and released during the step
      stepWhile(function () { return G.phase === 'step'; }, 120);
      check('press during the step-up pours when the kid is ready; a tap released during the step does nothing',
        bufPending && bufPours && bufServed && G.phase === 'ready' && G.curPlate.amount === 0 && G.pendingPress == null,
        { bufPending: bufPending, bufPours: bufPours, bufServed: bufServed, phase: G.phase });

      // --- pouring far past the previous plate: the line shouts (presentation only) ---
      freshPlay(seed);
      g.debug.botServeFair(1.0);
      waitReady();
      var shoutAt = G.served[0].norm * (1 + G.cls.tolerance + CONFIG.overshootShout) * G.curPlate.expect;
      g.input.down(360, 900, 103);
      stepWhile(function () { return G.phase === 'pour' && G.curPlate.amount < shoutAt * 0.97; }, 600);
      var quietBefore = !G.shouted;
      stepWhile(function () { return G.phase === 'pour' && !G.shouted; }, 120);
      g.step(20);
      var shoutBubbles = G.queue.filter(function (q) { return q.bubble && q.bubble.kind === 'shout'; }).length;
      g.input.up(360, 900, 103);
      check('pouring far past the previous plate makes the line shout 多い多い！ (not before)', quietBefore && G.shouted && shoutBubbles >= 1 && G.served[1].verdict === 'more',
        { quietBefore: quietBefore, shouted: G.shouted, bubbles: shoutBubbles, verdict: G.served[1] && G.served[1].verdict });

      // --- complaint: short hit-stop; the HUD mark lights up when the flying mark arrives ---
      freshPlay(seed);
      g.debug.botServeFair(1.0); g.debug.botServeRel(0.5);
      var hsT = G.t, hsHit = G.hitStop > 0, flying = G.flyers.length === 1 && G.markPop[0] < 0;
      g.step(Math.round(CONFIG.hitStop * 60) - 1);
      var frozen = G.t === hsT;
      g.step(Math.round(CONFIG.markFlyTime * 60) + 4);
      check('complaint: hit-stop freezes the world briefly, the mark flies to the HUD and then lights up', hsHit && flying && frozen && G.markPop[0] > 0 && G.flyers.length === 0 && G.complaints === 1,
        { hitStop: hsHit, flying: flying, frozen: frozen, markPop: G.markPop[0] });

      // --- "ラスト3人！", then the last kid: slow last drop → ぴったり！ → class claps → card ---
      freshPlay(seed);
      G.cls.tolerance = 0.5;
      var sawLast3 = false;
      for (var q3 = 0; q3 < 200 && waitReady() && G.queue.length > 1; q3++) {
        g.debug.botServeFair(1.0);
        stepWhile(function () { return G.phase === 'beat'; }, 300);
        if (G.queue.length === CONFIG.lastCallout && G.popups.some(function (p) { return p.text === 'ラスト' + CONFIG.lastCallout + '人！'; })) sawLast3 = true;
      }
      waitReady();
      var zoomLast = G.camZ > 1.01;
      g.input.down(360, 900, 104);
      stepWhile(function () { return G.phase === 'pour'; }, 60 * 30);
      g.input.up(360, 900, 104);
      var fin = G.finale && G.finale.kind === 'pittari' && !G.finale.landed;
      var hintHidden = hintKey() === null;
      g.step(Math.ceil(CONFIG.finaleDropTime * 60) + 1);
      var landed = G.finale && G.finale.landed && G.crowd && G.crowd.mode === 'clap' && G.popups.some(function (p) { return p.text === 'ぴったり！'; });
      g.render();
      stepWhile(function () { return G.screen === 'play'; }, 300);
      var cr2 = G.lastClassResult;
      check('ラスト3人！ callout, then the last drop falls in slow motion → ぴったり！ + the class claps in the scene → class card',
        sawLast3 && zoomLast && fin && hintHidden && landed && G.screen === 'classEnd' && cr2 && cr2.pittari && cr2.staged && G.crowd,
        { sawLast3: sawLast3, zoomLast: zoomLast, finale: fin, landed: landed, screen: G.screen });
      g.render();

      // --- last kid with curry left over: a short あまっちゃった… beat, no ぴったり ---
      freshPlay(seed);
      G.cls.tolerance = 0.9;
      while (waitReady() && G.queue.length > 1) g.debug.botServeFair(0.85);
      g.debug.botServeFair(0.6);
      var lo = G.finale && G.finale.kind === 'leftover' && G.popups.some(function (p) { return p.text === LINES.leftoverKid; });
      stepWhile(function () { return G.screen === 'play'; }, 300);
      check('last kid with leftovers → あまっちゃった… beat, then a class card without ぴったり', lo && G.screen === 'classEnd' && !G.lastClassResult.pittari && !G.crowd,
        { leftover: lo, screen: G.screen });

      // --- dumping the rest on the last kid empties the pot but is unfair → no ぴったり ---
      freshPlay(seed);
      G.cls.tolerance = 0.5;
      while (waitReady() && G.queue.length > 1) g.debug.botServeFair(0.7);
      g.input.down(360, 900, 74);
      stepWhile(function () { return G.screen === 'play' && G.phase === 'pour'; }, 60 * 30);
      var lastV = G.served.length ? G.served[G.served.length - 1].verdict : null;
      var dryFin = G.finale && G.finale.kind === 'dry' && G.popups.some(function (p) { return p.text === LINES.dryUnfair; });
      g.input.up(360, 900, 74);
      stepWhile(function () { return G.screen === 'play'; }, 300);
      check('pot dumped on the last kid (unfair serving) → ぴったり…ならず, no bonus', lastV === 'more' && dryFin && G.screen === 'classEnd' && !G.lastClassResult.pittari && G.lastClassResult.bonus === 0,
        { lastVerdict: lastV, dryFinale: dryFin, screen: G.screen });

      // --- 鍋が空: the classmates turn around, the camera pushes in; result shows the empty plate ---
      freshPlay(seed);
      g.input.down(360, 900, 105);
      stepWhile(function () { return G.screen === 'play' && G.phase === 'pour'; }, 60 * 60);
      g.input.up(360, 900, 105);
      stepWhile(function () { return G.screen === 'play'; }, 300);
      g.step(Math.ceil(3.0 * 60));
      var stareCrowd = G.screen === 'over' && G.crowd && G.crowd.mode === 'stare' && G.camZ > 1.05;
      g.render();
      stepWhile(function () { return G.screen !== 'result'; }, 600);
      var plates = G.result && G.result.plates;
      check('鍋が空: the class turns around, the camera pushes in, and the 成績表 ends with the empty plate',
        stareCrowd && plates && plates.length >= 1 && plates.length <= CONFIG.resultPlates && plates[plates.length - 1].empty === true,
        { stareCrowd: stareCrowd, plates: plates && plates.length });
      g.render();
      b = g.debug.buttons().retry;
      g.step(60); g.input.tap(b.x + b.w / 2, b.y + b.h / 2);
      check('retry resets the staging (camera, crowd, finale, flyers)', G.screen === 'play' && G.camZ === 1 && G.crowd === null && G.finale === null && G.flyers.length === 0 && G.hitStop === 0,
        { camZ: G.camZ, crowd: G.crowd });

      // --- every screen / overlay phase renders without errors ---
      var errBefore = G.errors.length, drawn = [], tried = 0;
      var rend = function (name) { tried++; var e0 = G.errors.length; render(); if (G.errors.length === e0) drawn.push(name); };
      G.screen = 'title'; G.t = 1; rend('title');
      g.start({ seed: seed, classIndex: 3 }); g.step(20); rend('intro');
      g.input.tap(360, 640); g.step(2); rend('play');
      g.input.down(360, 900, 95); g.step(30); rend('pour'); g.input.up(360, 900, 95); rend('beat');
      g.forceGameOver('empty'); [0.2, 0.8, 1.4, 2.0, 2.6, 3.4, 4.2].forEach(function (t) { while (G.screen === 'over' && G.t < t) g.step(1); rend('empty@' + t); });
      stepWhile(function () { return G.screen !== 'result'; }, 600); g.step(40); rend('result-empty');
      g.start({ seed: seed }); g.step(30); g.input.tap(360, 640);
      g.forceGameOver('meeting'); [0.3, 0.7, 1.3, 2.5].forEach(function (t) { while (G.screen === 'over' && G.t < t) g.step(1); rend('meeting@' + t); });
      stepWhile(function () { return G.screen !== 'result'; }, 600); G.toast = { text: 'コピーしました！', t: 0.5 }; rend('result-meeting');
      check('every screen and overlay phase renders without errors', tried === 18 && drawn.length === tried && G.errors.length === errBefore, drawn);

      // --- every screen renders ---
      var renderOk = true;
      try {
        g.start({ seed: 3 }); g.render(); g.step(30); g.input.tap(360, 640); g.render();
        g.input.down(360, 900, 4); g.step(30); g.render(); g.input.up(360, 900, 4); g.render();
        g.debug.setScreen('title'); g.render();
      } catch (e) { renderOk = false; rep.errors.push('render: ' + e); }
      check('all screens render', renderOk && G.errors.length === 0);
    } catch (e) {
      rep.errors.push('exception: ' + (e && e.stack || e));
    }
    // async part (share sheet → clipboard fallback), then the report
    var finished = false;
    var finish = function () { if (finished) return; finished = true; writeSelfTestReport(rep, savedBest, savedMute); };
    setTimeout(function () { if (!finished) { rep.errors.push('async checks timed out'); finish(); } }, 3000);
    try { shareSelfTest(check, finish); } catch (e) { rep.errors.push('share test: ' + (e && e.stack || e)); finish(); }
  }

  // navigator.share rejects (not allowed / desktop) → copy to the clipboard; a cancelled sheet → nothing
  function shareSelfTest(check, done) {
    var g = window.__game;
    var shareDesc = Object.getOwnPropertyDescriptor(navigator, 'share');
    var clipDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    var copied = null;
    var restore = function () {
      try { if (shareDesc) Object.defineProperty(navigator, 'share', shareDesc); else delete navigator.share; } catch (e) { /* ignore */ }
      try { if (clipDesc) Object.defineProperty(navigator, 'clipboard', clipDesc); else delete navigator.clipboard; } catch (e) { /* ignore */ }
    };
    var rejectWith = function (name) { return function () { var e = new Error(name); e.name = name; return Promise.reject(e); }; };
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function (t) { copied = t; return Promise.resolve(); } } });
      Object.defineProperty(navigator, 'share', { configurable: true, value: rejectWith('NotAllowedError') });
    } catch (e) { restore(); check('share falls back to the clipboard', true, 'skipped: navigator not patchable'); done(); return; }
    g.start({ seed: 1 }); g.forceGameOver('meeting');
    while (G.screen !== 'result') g.step(1);
    G.toast = null;
    doShare();
    setTimeout(function () {
      var toast1 = G.toast && G.toast.text, copied1 = copied;
      copied = null; G.toast = null;
      try { Object.defineProperty(navigator, 'share', { configurable: true, value: rejectWith('AbortError') }); } catch (e) { /* ignore */ }
      doShare();
      setTimeout(function () {
        check('share: a failed share sheet copies the text instead; a cancelled one does nothing',
          toast1 === 'コピーしました！' && /#ぴったり給食当番/.test(copied1 || '') && copied === null && G.toast === null,
          { toast: toast1, copied: copied1 });
        restore();
        done();
      }, 50);
    }, 50);
  }

  function writeSelfTestReport(rep, savedBest, savedMute) {
    // restore the user's storage state
    if (savedBest == null) Store.remove(KEY_BEST); else Store.set(KEY_BEST, savedBest);
    if (savedMute == null) Store.remove(KEY_MUTE); else Store.set(KEY_MUTE, savedMute);
    Sfx.muted = savedMute === '1';
    G.best = loadBest();
    Input.pointers = {}; Input.ignore = {}; Input.space = false;

    rep.errors = rep.errors.concat(G.errors);
    var failed = rep.checks.filter(function (c) { return !c.ok; });
    rep.summary = { total: rep.checks.length, passed: rep.checks.length - failed.length, failed: failed.map(function (c) { return c.name; }) };
    rep.pass = rep.errors.length === 0 && failed.length === 0;
    var pre = document.getElementById('test-report');
    if (pre) pre.textContent = JSON.stringify(rep, null, 2);
    document.body.classList.add('test');
    document.title = rep.pass ? 'TEST PASS' : 'TEST FAIL';
    G.screen = 'title'; G.t = 1;
    render();
  }

  // ?shot=title|play|result (required), plus: intro (&class=), first, warn, shout, last,
  // finale (&at= seconds into the last-drop finale), classend (&class=), over, meeting
  function setupShot(kind) {
    var seed = URL_SEED != null ? URL_SEED : 3;
    var vr = mulberry32(seed ^ 0xBEEF);
    if (kind === 'title') {
      G.screen = 'title';
      for (var i = 0; i < 90; i++) update(DT);
      G.t = 1.0; G.time = Math.PI; // "タップでスタート" at full brightness
    } else if (kind === 'intro') {
      startRun(seed, PARAMS['class'] != null ? Math.max(0, parseInt(PARAMS['class'], 10) || 0) : 3);
      for (var j = 0; j < 30; j++) update(DT);
    } else if (kind === 'play') {
      // optional: &class=<index> &served=<n> (served=all → the last person in line)
      var sci = PARAMS['class'] != null ? Math.max(0, parseInt(PARAMS['class'], 10) || 0) : 3;
      startRun(seed, sci); beginPlay();
      var nServe = PARAMS.served === 'all' ? 999 : (PARAMS.served != null ? parseInt(PARAMS.served, 10) || 0 : 7);
      for (var a = 0; a < nServe; a++) {
        if (!botWaitReady() || G.queue.length <= 2) break;
        botServeFair(1 + (vr() - 0.5) * 0.12);
      }
      if (botWaitReady() && G.queue.length > 1) botServeFair(PARAMS.served != null ? 1 : 1.45);
      botWaitReady();
      pointerDown(W / 2, 950, 'shot');
      for (var b = 0; b < (parseInt(PARAMS.hold, 10) || 40); b++) update(DT);
    } else if (kind === 'last') {
      // the streamer moment: 3 left, the pot is short, the line is nervous, scraping the bottom
      startRun(seed, PARAMS['class'] != null ? Math.max(0, parseInt(PARAMS['class'], 10) || 0) : 1); beginPlay();
      G.cls.tolerance = 0.5;
      var kl = G.cls.k, gl = 0;
      while (gl++ < 100 && botWaitReady() && G.queue.length > CONFIG.lastCallout) botServeNorm((parseFloat(PARAMS.over) || 1.07) * kl);
      botWaitReady();
      pointerDown(W / 2, 950, 'shot');
      for (var bl = 0; bl < (parseInt(PARAMS.hold, 10) || 30); bl++) update(DT);
    } else if (kind === 'finale') {
      // last person, pot emptied: the slow last drop (&at=0.3) or the ぴったり！ clap (default)
      startRun(seed, PARAMS['class'] != null ? Math.max(0, parseInt(PARAMS['class'], 10) || 0) : 0); beginPlay();
      G.cls.tolerance = 0.5;
      var gf = 0;
      while (gf++ < 100 && botWaitReady() && G.queue.length > 1) botServeFair(1);
      botWaitReady();
      pointerDown(W / 2, 950, 'shot');
      gf = 0; while (G.screen === 'play' && G.phase === 'pour' && gf++ < 3000) update(DT);
      pointerUp(W / 2, 950, 'shot');
      var at = PARAMS.at != null ? parseFloat(PARAMS.at) : 1.1;
      gf = 0; while (G.finale && G.finale.t < at && gf++ < 600) update(DT);
    } else if (kind === 'first') {
      // the very first kid of a fresh run: 目安 ring + "どこでも長押し！"
      startRun(seed, 0); beginPlay();
      for (var f0 = 0; f0 < 40; f0++) update(DT);
    } else if (kind === 'warn') {
      // two complaint marks: "あと1つで学級会！"
      startRun(seed, 0); beginPlay();
      botServeFair(1); botServeRel(0.6); botServeRel(1.6);
      botWaitReady();
      pointerDown(W / 2, 950, 'shot');
      for (var w0 = 0; w0 < 30; w0++) update(DT);
    } else if (kind === 'shout') {
      startRun(seed, PARAMS['class'] != null ? Math.max(0, parseInt(PARAMS['class'], 10) || 0) : 3); beginPlay();
      for (var sh = 0; sh < 4; sh++) botServeFair(1 + (vr() - 0.5) * 0.1);
      botWaitReady();
      pointerDown(W / 2, 950, 'shot');
      var gs = 0; while (!G.shouted && G.phase === 'pour' && gs++ < 600) update(DT);
      for (var s2 = 0; s2 < 24; s2++) update(DT);
    } else if (kind === 'classend') {
      startRun(seed, PARAMS['class'] != null ? Math.max(0, parseInt(PARAMS['class'], 10) || 0) : 0); beginPlay();
      G.cls.tolerance = 0.5; // the screenshot bot should finish the class
      var g1 = 0; while (G.screen === 'play' && g1++ < 100) botServeFair(1);
      for (var c1 = 0; c1 < 150; c1++) update(DT);
    } else if (kind === 'over' || kind === 'empty') {
      startRun(seed, 1); beginPlay();
      var k = G.cls.k, g2 = 0;
      while (G.screen === 'play' && g2++ < 100) botServeNorm(1.3 * k);
      for (var d = 0; d < 60 * 3.2; d++) update(DT);
    } else if (kind === 'meeting') {
      startRun(seed, 0); beginPlay();
      botServeFair(1); botServeRel(0.6); botServeRel(1.5); botServeRel(0.6);
      for (var e = 0; e < 60 * 1.6; e++) update(DT);
    } else if (kind === 'result') {
      startRun(seed, 0); beginPlay();
      var g3 = 0; while (G.screen === 'play' && g3++ < 100) botServeFair(1);
      nextClass(); beginPlay();
      g3 = 0; while (G.screen === 'play' && g3++ < 100) botServeFair(1 + (vr() - 0.5) * 0.16);
      if (G.screen === 'classEnd') { nextClass(); beginPlay(); }
      var k2 = G.cls.k; g3 = 0;
      while (G.screen === 'play' && g3++ < 100) botServeNorm(1.25 * k2);
      g3 = 0; while (G.screen !== 'result' && g3++ < 600) update(DT);
      for (var f = 0; f < 90; f++) update(DT);
    }
    G.shake = 0;
    G.frozen = true;
    render();
  }

  // ---------- boot ----------
  bindDom();
  resize();
  if (TEST_MODE) {
    setTimeout(function () {
      try { runSelfTest(); } catch (e) {
        var pre = document.getElementById('test-report');
        if (pre) pre.textContent = JSON.stringify({ pass: false, errors: ['fatal: ' + (e && e.stack || e)] }, null, 2);
        document.body.classList.add('test');
        document.title = 'TEST FAIL';
      }
    }, 0);
  } else if (SHOT) {
    try { setupShot(SHOT); } catch (e) { G.errors.push('shot: ' + (e && e.stack || e)); }
  }
  requestAnimationFrame(frame);
  startWatchdog();
})();
