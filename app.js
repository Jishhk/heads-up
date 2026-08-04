(() => {
  const APP_VERSION = 'v5';
  const ROUND_SECONDS = 60;
  const DELTA_TRIGGER = 4.5;  // m/s^2 change from baseline to trigger — tuned for a deliberate nod
  const DELTA_NEUTRAL = 2.0;  // m/s^2 — must return within this band before re-arming
  const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
  const SESSION_KEY = 'headsup_session_v1';
  const NOD_DOWN_SIGN = 1; // flip to -1 if a downward nod ever registers as pass instead of correct

  let debugEnabled = false;

  // ---------- DIAGNOSTICS ----------
  // A general event log (screen transitions, round lifecycle, orientation
  // lock outcomes) plus a per-round motion sample log, downloadable from
  // the results screen. This exists because reading a live overlay while
  // physically nodding a phone against your forehead isn't practical —
  // better to capture everything and inspect it after the fact.
  let eventLog = [];
  let motionLog = [];

  function logEvent(name, data) {
    eventLog.push({ t: Math.round(performance.now()), name, data: data === undefined ? null : data });
    if (eventLog.length > 500) eventLog.shift();
  }

  document.getElementById('version-tag').textContent = 'Heads Up · ' + APP_VERSION;

  const screens = {};
  document.querySelectorAll('.screen').forEach(el => screens[el.id] = el);

  function showScreen(id) {
    logEvent('showScreen', id);
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[id].classList.add('active');
    if (id === 'screen-home' && typeof renderCategoryGrid === 'function') {
      renderCategoryGrid();
    }
  }

  // ---------- STATE ----------
  let currentCategory = null;
  let deck = [];
  let deckIndex = 0;
  let currentWord = null;
  let roundLog = []; // { word, result: 'correct' | 'pass' }
  let timerInterval = null;
  let secondsLeft = ROUND_SECONDS;
  let armed = true; // whether a new trigger is allowed (hysteresis gate)
  let orientationHandlerAttached = false;
  let roundActive = false;

  // ---------- SESSION / NO-REPEAT TRACKING ----------
  // Avoids repeating words within a TTL window using localStorage, so
  // multiple rounds back-to-back (even across closing/reopening the tab)
  // won't reshow the same words until the window expires or a category's
  // whole pool has been exhausted, at which point that category resets.
  let sessionData = loadSession();

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now()) {
          return parsed;
        }
      }
    } catch (e) { /* localStorage unavailable — fall through to a fresh session */ }
    return { expiresAt: Date.now() + SESSION_TTL_MS, seen: {}, correctCounts: {} };
  }

  function saveSession() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
    } catch (e) { /* storage full or blocked — tracking just won't persist */ }
  }

  function resetSession() {
    sessionData = { expiresAt: Date.now() + SESSION_TTL_MS, seen: {}, correctCounts: {} };
    saveSession();
    if (typeof renderCategoryGrid === 'function') renderCategoryGrid();
  }

  function getSeen(categoryId) {
    return sessionData.seen[categoryId] || [];
  }

  function markSeen(categoryId, word) {
    if (!sessionData.seen[categoryId]) sessionData.seen[categoryId] = [];
    if (!sessionData.seen[categoryId].includes(word)) {
      sessionData.seen[categoryId].push(word);
      saveSession();
    }
  }

  function getCorrectCount(categoryId) {
    if (!sessionData.correctCounts) return 0;
    return sessionData.correctCounts[categoryId] || 0;
  }

  function incrementCorrectCount(categoryId) {
    if (!sessionData.correctCounts) sessionData.correctCounts = {};
    sessionData.correctCounts[categoryId] = (sessionData.correctCounts[categoryId] || 0) + 1;
    saveSession();
  }

  function buildDeck(category) {
    const seen = new Set(getSeen(category.id));
    let pool = category.words.filter(w => !seen.has(w));
    if (pool.length === 0) {
      // whole category exhausted within the TTL window — start a fresh cycle
      sessionData.seen[category.id] = [];
      saveSession();
      pool = category.words.slice();
    }
    return shuffledDeck(pool);
  }

  // ---------- HOME: build category grid ----------
  const grid = document.getElementById('category-grid');

  if (typeof CATEGORIES === 'undefined' || !Array.isArray(CATEGORIES) || CATEGORIES.length === 0) {
    grid.innerHTML = '<p style="color:#FF4D5E;grid-column:1/-1;font-size:14px;">' +
      'Couldn\'t load categories — data.js is missing or failed to load. ' +
      'Check that data.js sits in the repo root alongside index.html.</p>';
    return;
  }

  function renderCategoryGrid() {
    grid.innerHTML = '';
    CATEGORIES.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = 'category-card';
      btn.style.background = `linear-gradient(160deg, ${cat.accent}, ${shade(cat.accent, -18)})`;
      const correctCount = getCorrectCount(cat.id);
      const badgeHtml = correctCount > 0
        ? `<span class="card-badge">✓ ${correctCount}</span>`
        : '';
      btn.innerHTML = `${badgeHtml}<span class="card-count">${cat.words.length}</span>${cat.name}`;
      btn.addEventListener('click', () => selectCategory(cat));
      grid.appendChild(btn);
    });
  }

  function shade(hex, percent) {
    const num = parseInt(hex.slice(1), 16);
    let r = (num >> 16) + Math.round(255 * (percent / 100));
    let g = ((num >> 8) & 0x00FF) + Math.round(255 * (percent / 100));
    let b = (num & 0x0000FF) + Math.round(255 * (percent / 100));
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    return `rgb(${r},${g},${b})`;
  }

  function selectCategory(cat) {
    currentCategory = cat;
    document.getElementById('ready-category-label').textContent = cat.name;
    document.documentElement.style.setProperty('--accent', cat.accent);
    showScreen('screen-ready');
  }

  document.getElementById('btn-back-from-ready').addEventListener('click', () => showScreen('screen-home'));
  document.getElementById('btn-back-from-permission').addEventListener('click', () => showScreen('screen-home'));

  document.getElementById('btn-reset-progress').addEventListener('click', () => {
    if (confirm('Clear no-repeat word tracking and correct-count badges for every category?')) {
      resetSession();
    }
  });

  const debugToggleBtn = document.getElementById('btn-debug-toggle');
  debugToggleBtn.addEventListener('click', () => {
    debugEnabled = !debugEnabled;
    debugToggleBtn.textContent = 'Debug Tilt: ' + (debugEnabled ? 'On' : 'Off');
  });

  // ---------- PERMISSION HANDLING (iOS-safe, no-op on Android) ----------
  function needsExplicitPermission() {
    return (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') ||
           (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function');
  }

  document.getElementById('btn-start-round').addEventListener('click', () => {
    tryEnterFullscreen(); // best-effort, must be called from a direct user gesture
    ensureAudioContext(); // must also be unlocked from a direct user gesture
    // Orientation lock (and the fullscreen it depends on) needs a beat to
    // actually engage on Android Chrome before attempting it.
    setTimeout(() => {
      if (needsExplicitPermission()) {
        showScreen('screen-permission');
      } else {
        lockLandscapeThenProceed();
      }
    }, 150);
  });

  document.getElementById('btn-request-permission').addEventListener('click', () => {
    const requests = [];
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      requests.push(DeviceMotionEvent.requestPermission());
    }
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      requests.push(DeviceOrientationEvent.requestPermission());
    }
    Promise.all(requests).then(results => {
      if (results.some(r => r !== 'granted')) {
        alert('Motion access was denied. You can still play using the on-screen tap zones.');
      }
      lockLandscapeThenProceed();
    }).catch(() => lockLandscapeThenProceed());
  });

  // ---------- FULLSCREEN ----------
  const fsBtn = document.getElementById('btn-fullscreen');

  function tryEnterFullscreen() {
    const el = document.documentElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen ||
                     el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!request) {
      alert('This browser does not support the Fullscreen API. Try "Add to Home screen" instead for a chrome-less launch.');
      return;
    }
    if (document.fullscreenElement) return;
    const result = request.call(el);
    if (result && typeof result.catch === 'function') {
      result.catch(err => {
        alert('Fullscreen request was blocked: ' + (err && err.message ? err.message : err));
      });
    }
  }

  function exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen ||
                 document.mozCancelFullScreen || document.msExitFullscreen;
    if (exit && document.fullscreenElement) {
      const result = exit.call(document);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }
  }

  function updateFullscreenIcon() {
    fsBtn.textContent = document.fullscreenElement ? '⤡' : '⛶';
  }

  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      exitFullscreen();
    } else {
      tryEnterFullscreen();
    }
  });

  document.addEventListener('fullscreenchange', updateFullscreenIcon);
  document.addEventListener('webkitfullscreenchange', updateFullscreenIcon);

  // ---------- AUDIO (countdown beeps, no asset files needed) ----------
  let audioCtx = null;

  function ensureAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

  function beep(freq, durationMs) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  }

  // ---------- ORIENTATION LOCK (landscape for gameplay only) ----------
  let orientationWasLocked = false;

  function lockLandscapeThenProceed() {
    const orientation = screen.orientation;
    if (orientation && typeof orientation.lock === 'function') {
      orientation.lock('landscape').then(() => {
        orientationWasLocked = true;
        logEvent('orientationLock', 'succeeded');
        beginCountdown();
      }).catch((err) => {
        logEvent('orientationLock', 'failed: ' + (err && err.message ? err.message : String(err)));
        waitForManualLandscapeRotation();
      });
    } else {
      logEvent('orientationLock', 'unsupported');
      waitForManualLandscapeRotation();
    }
  }

  function waitForManualLandscapeRotation() {
    const mq = window.matchMedia('(orientation: landscape)');
    if (mq.matches) {
      beginCountdown();
      return;
    }
    showScreen('screen-rotate');
    const handler = (ev) => {
      if (ev.matches) {
        mq.removeEventListener('change', handler);
        beginCountdown();
      }
    };
    mq.addEventListener('change', handler);
  }

  function unlockOrientation() {
    if (orientationWasLocked && screen.orientation && typeof screen.orientation.unlock === 'function') {
      try { screen.orientation.unlock(); } catch (e) { /* ignore */ }
    }
    orientationWasLocked = false;
  }

  // ---------- COUNTDOWN ----------
  function beginCountdown() {
    showScreen('screen-countdown');
    let n = 3;
    const el = document.getElementById('countdown-number');
    el.textContent = n;
    const iv = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(iv);
        startRound();
      } else {
        el.textContent = n;
      }
    }, 800);
  }

  // ---------- ROUND ----------
  function shuffledDeck(words) {
    const arr = words.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function startRound() {
    logEvent('startRound', currentCategory ? currentCategory.id : null);
    roundActive = true;
    deck = buildDeck(currentCategory);
    deckIndex = 0;
    secondsLeft = ROUND_SECONDS;
    armed = true;
    roundLog = [];
    motionLog = [];

    const gameScreen = document.getElementById('screen-game');
    gameScreen.style.background = shade(currentCategory.accent, -85);
    document.getElementById('timer-bar-fill').style.background = currentCategory.accent;
    document.documentElement.style.setProperty('--accent', currentCategory.accent);

    showWord();
    updateTimerUI();
    showScreen('screen-game');
    attachMotionListener();

    if (timerInterval) clearInterval(timerInterval); // defensive: never let two intervals run
    const thisInterval = setInterval(() => {
      if (!roundActive || timerInterval !== thisInterval) {
        clearInterval(thisInterval); // stale interval from a prior round — stop it
        return;
      }
      secondsLeft -= 1;
      updateTimerUI();
      if (secondsLeft <= 0) {
        endRound();
      }
    }, 1000);
    timerInterval = thisInterval;
  }

  function updateTimerUI() {
    document.getElementById('timer-seconds').textContent = secondsLeft;
    const pct = Math.max(0, (secondsLeft / ROUND_SECONDS) * 100);
    document.getElementById('timer-bar-fill').style.width = pct + '%';
    if (secondsLeft <= 10) {
      document.getElementById('timer-bar-fill').style.background = 'var(--pass)';
    }
    if (secondsLeft > 0 && secondsLeft <= 5) {
      beep(880, 120);
    } else if (secondsLeft === 0) {
      beep(440, 300);
    }
  }

  function showWord() {
    if (deckIndex >= deck.length) {
      deck = buildDeck(currentCategory);
      deckIndex = 0;
    }
    currentWord = deck[deckIndex];
    document.getElementById('game-word').textContent = currentWord;
    deckIndex += 1;
    markSeen(currentCategory.id, currentWord);
  }

  function flash(kind) {
    const el = document.getElementById('game-flash');
    el.classList.add(kind === 'correct' ? 'show-correct' : 'show-pass');
    if (navigator.vibrate) navigator.vibrate(kind === 'correct' ? 40 : [20, 40, 20]);
    setTimeout(() => {
      el.classList.remove('show-correct', 'show-pass');
    }, 180);
  }

  function nextCard(kind) {
    if (!armed || secondsLeft <= 0) return;
    armed = false;
    roundLog.push({ word: currentWord, result: kind });
    if (kind === 'correct') incrementCorrectCount(currentCategory.id);
    flash(kind);
    showWord();
  }

  // ---------- TILT DETECTION (landscape-only, gravity-vector based) ----------
  // Orientation is locked to landscape before a round starts (see
  // lockLandscapeThenProceed above), so there is exactly one physical
  // orientation to handle here — no per-frame axis-guessing needed.
  //
  // Using devicemotion's accelerationIncludingGravity instead of
  // deviceorientation's beta/gamma angles deliberately: Euler angles have a
  // singularity (gimbal lock) right around beta = 90°, which is exactly
  // where a phone sits when held vertically — i.e. this whole game's use
  // case sat right in the least stable part of that math. The raw gravity
  // vector has no such singularity, so it should behave predictably.
  //
  // accelerationIncludingGravity is reported in the phone's fixed physical
  // frame, which does not rotate with the screen — so landscape-primary
  // vs. landscape-secondary can read the same physical nod with opposite
  // sign on this axis. That's corrected below using screen.orientation.type,
  // read once per round (stable, not noisy, unlike per-frame angle math).
  let calibrated = false;
  let baselineAx = null;
  let baselineAy = null;
  let baselineAz = null;
  let motionLogStartTime = null;

  function attachMotionListener() {
    if (orientationHandlerAttached) return;
    calibrated = false;
    baselineAx = null;
    baselineAy = null;
    baselineAz = null;
    motionLogStartTime = performance.now();
    window.addEventListener('devicemotion', onMotion);
    orientationHandlerAttached = true;
  }
  function detachMotionListener() {
    window.removeEventListener('devicemotion', onMotion);
    orientationHandlerAttached = false;
    document.getElementById('debug-overlay').classList.remove('show');
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  // One piece we can't verify without live hardware: which raw sign means
  // "nodded down." NOD_DOWN_SIGN at the top of the file is the single spot
  // to flip if correct/pass ever come out backwards. The log below records
  // baseline-relative deltas for all three raw axes (not just the X axis
  // this build actually triggers on), specifically so a downloaded log can
  // reveal which axis really correlates with a nod if X turns out wrong.
  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.x === undefined) return;

    const type = (screen.orientation && screen.orientation.type) || '';
    const orientSign = type.indexOf('landscape-secondary') !== -1 ? -1 : 1;
    const ax = g.x * orientSign * NOD_DOWN_SIGN;

    let note = '';
    let delta = null;

    if (!calibrated) {
      baselineAx = ax;
      baselineAy = g.y;
      baselineAz = g.z;
      calibrated = true;
      armed = true;
      note = 'calibrated';
    } else {
      delta = ax - baselineAx;
      if (!armed) {
        if (Math.abs(delta) < DELTA_NEUTRAL) {
          armed = true;
          note = 'rearmed';
        }
      } else if (delta > DELTA_TRIGGER) {
        note = 'trigger:correct';
        nextCard('correct');
      } else if (delta < -DELTA_TRIGGER) {
        note = 'trigger:pass';
        nextCard('pass');
      }
    }

    if (motionLog.length < 5000) {
      motionLog.push({
        t: Math.round(performance.now() - motionLogStartTime),
        gx: round3(g.x), gy: round3(g.y