(() => {
  const APP_VERSION = 'v9';
  const ROUND_SECONDS = 60;
  const DELTA_TRIGGER = 7.0;  // m/s^2 — widened above the measured resting noise floor (~stdev 2.6)
  const DELTA_NEUTRAL = 3.0;  // m/s^2 — must return within this band before re-arming
  const CALIBRATION_WINDOW_MS = 400; // average samples over this window instead of trusting one noisy reading
  const MIN_TRIGGER_INTERVAL_MS = 500; // debounce — real data showed follow-through/rebound firing a second flip within ~100-200ms
  const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
  const SESSION_KEY = 'headsup_session_v1';
  const NOD_DOWN_SIGN = -1; // flipped based on your report that direction was backwards

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
    if (id === 'screen-home') {
      startTapped = false;
      if (typeof renderCategoryGrid === 'function') renderCategoryGrid();
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

  document.getElementById('btn-back-from-permission').addEventListener('click', () => {
    showScreen('screen-home');
  });

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

  let startTapped = false;

  document.getElementById('btn-start-round').addEventListener('click', () => {
    if (startTapped) return; // guards against a rapid double-tap firing two overlapping lock attempts
    startTapped = true;
    ensureAudioContext(); // must be unlocked from a direct user gesture

    let resolved = false;
    function proceedOnce() {
      if (resolved) return;
      resolved = true;
      if (needsExplicitPermission()) {
        showScreen('screen-permission');
      } else {
        lockLandscapeThenProceed();
      }
    }

    // Safety net: if fullscreen/orientation-lock never settles for some
    // reason, don't leave the player stuck — this is what previously
    // required an unrelated tap (like exiting fullscreen) to un-stick.
    const stuckTimeout = setTimeout(() => {
      logEvent('startSequence', 'timed out — forcing fallback');
      proceedOnce();
    }, 4000);

    enterFullscreenForStart().then(() => {
      clearTimeout(stuckTimeout);
      proceedOnce();
    });
  });

  document.getElementById('btn-back-from-ready').addEventListener('click', () => {
    showScreen('screen-home');
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

  // Used only by the Start flow — waits for fullscreen to actually settle
  // (success or failure) instead of guessing with a fixed delay, which was
  // the root cause of the lock/Start sequence occasionally getting stuck.
  function enterFullscreenForStart() {
    const el = document.documentElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen ||
                     el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!request || document.fullscreenElement) {
      return Promise.resolve();
    }
    const result = request.call(el);
    if (result && typeof result.then === 'function') {
      return result.then(() => {}).catch(() => {});
    }
    return new Promise(resolve => setTimeout(resolve, 200));
  }

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
      let settled = false;

      // screen.orientation.lock() has been observed to hang indefinitely
      // (neither resolving nor rejecting) on some Android Chrome builds,
      // particularly right after entering fullscreen. Without this timeout
      // that leaves the player stuck with no fallback ever firing — this
      // is what previously required exiting fullscreen manually to un-stick
      // (which likely invalidated the pending lock request as a side effect).
      const lockTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logEvent('orientationLock', 'timed out — falling back to manual rotation');
        waitForManualLandscapeRotation();
      }, 2500);

      orientation.lock('landscape').then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(lockTimeout);
        orientationWasLocked = true;
        logEvent('orientationLock', 'succeeded');
        beginCountdown();
      }).catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(lockTimeout);
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
    let n = 5;
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
  // vector has no such singularity, so it behaves predictably.
  //
  // AXIS: originally triggered on the phone's local X-axis, based on a
  // theoretical guess about which axis rotates during a landscape nod.
  // A real downloaded motion log proved that guess wrong: X barely moved
  // positive at all (99th percentile +1.4, essentially never crossing a
  // "correct" threshold) while drifting hard negative — which is exactly
  // why every trigger came back "pass." The same log showed the phone's
  // Z-axis swinging ±15 m/s^2 and clearly alternating with each nod — the
  // real gesture signal. Switched to Z based on that data.
  //
  // accelerationIncludingGravity is reported in the phone's fixed physical
  // frame, which does not rotate with the screen — so landscape-primary
  // vs. landscape-secondary can read the same physical nod with opposite
  // sign. That's corrected below using screen.orientation.type, read once
  // per round (stable, not noisy, unlike per-frame angle math).
  let calibrated = false;
  let baselineAx = null;
  let baselineAy = null;
  let baselineAz = null;
  let motionLogStartTime = null;
  let lastTriggerTime = -Infinity;
  let calibrationSamples = [];
  let calibrationStartTime = null;

  function attachMotionListener() {
    if (orientationHandlerAttached) return;
    calibrated = false;
    baselineAx = null;
    baselineAy = null;
    baselineAz = null;
    motionLogStartTime = performance.now();
    lastTriggerTime = -Infinity;
    calibrationSamples = [];
    calibrationStartTime = null;
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

  // One piece we still can't verify without live hardware: which raw sign
  // means "nodded down." NOD_DOWN_SIGN at the top of the file is the single
  // spot to flip if correct/pass ever come out backwards — but which AXIS
  // to read is now backed by real data, not a guess.
  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.z === null || g.z === undefined) return;

    const type = (screen.orientation && screen.orientation.type) || '';
    const orientSign = type.indexOf('landscape-secondary') !== -1 ? -1 : 1;
    const az = g.z * orientSign * NOD_DOWN_SIGN;

    let note = '';
    let delta = null;

    if (!calibrated) {
      baselineAx = g.x;
      baselineAy = g.y;
      // A single sample here was proven noisy by real data (resting reads
      // drifted ~1.5-4 m/s^2 off from one snapshot, skewing correct/pass
      // odds). Average over a short window instead of trusting one sample.
      if (calibrationStartTime === null) calibrationStartTime = performance.now();
      calibrationSamples.push(az);
      if (performance.now() - calibrationStartTime >= CALIBRATION_WINDOW_MS) {
        baselineAz = calibrationSamples.reduce((a, b) => a + b, 0) / calibrationSamples.length;
        calibrated = true;
        armed = true;
        note = 'calibrated';
      } else {
        note = 'calibrating';
      }
    } else {
      delta = az - baselineAz;
      const now = performance.now();
      const debounceOk = (now - lastTriggerTime) >= MIN_TRIGGER_INTERVAL_MS;
      if (!armed) {
        if (Math.abs(delta) < DELTA_NEUTRAL) {
          armed = true;
          note = 'rearmed';
        }
      } else if (!debounceOk) {
        // amplitude says it would trigger, but too soon after the last one —
        // almost always the same physical nod's follow-through/rebound
        note = 'debounced';
      } else if (delta > DELTA_TRIGGER) {
        note = 'trigger:correct';
        lastTriggerTime = now;
        nextCard('correct');
      } else if (delta < -DELTA_TRIGGER) {
        note = 'trigger:pass';
        lastTriggerTime = now;
        nextCard('pass');
      }
    }

    if (motionLog.length < 5000) {
      motionLog.push({
        t: Math.round(performance.now() - motionLogStartTime),
        gx: round3(g.x), gy: round3(g.y), gz: round3(g.z),
        type: type,
        deltaX: baselineAx === null ? 0 : round3(g.x - baselineAx),
        deltaY: baselineAy === null ? 0 : round3(g.y - baselineAy),
        deltaZ: delta === null ? 0 : round3(delta),
        armed: armed,
        note: note
      });
    }

    if (debugEnabled) {
      const overlay = document.getElementById('debug-overlay');
      overlay.classList.add('show');
      overlay.textContent =
        'type: ' + type + '\n' +
        'raw x/y/z: ' + g.x.toFixed(2) + ' / ' + g.y.toFixed(2) + ' / ' + g.z.toFixed(2) + '\n' +
        'baseline z: ' + (baselineAz === null ? '-' : baselineAz.toFixed(2)) + '\n' +
        'delta: ' + (delta === null ? '-' : delta.toFixed(2)) + '\n' +
        'armed: ' + armed + (note ? ' [' + note + ']' : '') + '\n' +
        'trigger/neutral: ' + DELTA_TRIGGER + ' / ' + DELTA_NEUTRAL;
    }
  }

  // ---------- TAP FALLBACK ----------
  document.getElementById('tap-correct').addEventListener('click', () => nextCard('correct'));
  document.getElementById('tap-pass').addEventListener('click', () => nextCard('pass'));

  // ---------- END ROUND ----------
  function endRound() {
    if (!roundActive) {
      logEvent('endRound-ignored-already-inactive');
      return; // already ended once — never let a stray second call re-show results
    }
    roundActive = false;
    logEvent('endRound');
    clearInterval(timerInterval);
    detachMotionListener();
    unlockOrientation();
    try {
      renderResults();
    } catch (err) {
      // Even if results rendering fails for some reason, still show the
      // screen rather than leaving the player stuck on the game view.
    }
    showScreen('screen-over');
  }

  function renderResults() {
    const correctCount = roundLog.filter(r => r.result === 'correct').length;
    const totalCount = roundLog.length;
    document.getElementById('over-score-label').textContent =
      totalCount === 0 ? 'No words flipped this round' : `${correctCount} correct out of ${totalCount}`;

    const list = document.getElementById('results-list');
    list.innerHTML = '';

    if (totalCount === 0) {
      list.innerHTML = '<p class="results-empty">Nothing flipped — try tilting further next time.</p>';
      return;
    }

    roundLog.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'result-row ' + (entry.result === 'correct' ? 'result-correct' : 'result-pass');
      const word = document.createElement('span');
      word.textContent = entry.word;
      const icon = document.createElement('span');
      icon.className = 'result-icon';
      icon.textContent = entry.result === 'correct' ? '✓' : '✕';
      row.appendChild(word);
      row.appendChild(icon);
      list.appendChild(row);
    });
  }

  document.getElementById('btn-play-again').addEventListener('click', () => beginCountdown());
  document.getElementById('btn-change-category').addEventListener('click', () => showScreen('screen-home'));

  document.getElementById('btn-download-diagnostics').addEventListener('click', () => {
    const payload = {
      appVersion: APP_VERSION,
      downloadedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      screen: { width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio },
      orientationType: (screen.orientation && screen.orientation.type) || null,
      category: currentCategory ? currentCategory.id : null,
      tiltConfig: { DELTA_TRIGGER, DELTA_NEUTRAL, NOD_DOWN_SIGN },
      roundResults: roundLog,
      motionSampleCount: motionLog.length,
      motionLog: motionLog,
      eventLog: eventLog
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'headsup-diagnostics-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  showScreen('screen-home');
})();
