(() => {
  const APP_VERSION = 'v3';
  const ROUND_SECONDS = 60;
  const DELTA_TRIGGER = 22;   // degrees of tilt away from calibrated neutral to trigger
  const DELTA_NEUTRAL = 10;   // must return within this band of neutral before re-arming
  const BASELINE_DRIFT_TAU_MS = 1500; // safety-net re-centering speed if the phone's base pose changes
  const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
  const SESSION_KEY = 'headsup_session_v1';

  document.getElementById('version-tag').textContent = 'Heads Up · ' + APP_VERSION;

  const screens = {};
  document.querySelectorAll('.screen').forEach(el => screens[el.id] = el);

  function showScreen(id) {
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

  // ---------- PERMISSION HANDLING (iOS-safe, no-op on Android) ----------
  function needsExplicitPermission() {
    return typeof DeviceOrientationEvent !== 'undefined' &&
           typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  document.getElementById('btn-start-round').addEventListener('click', () => {
    tryEnterFullscreen(); // best-effort, must be called from a direct user gesture
    ensureAudioContext(); // must also be unlocked from a direct user gesture
    if (needsExplicitPermission()) {
      showScreen('screen-permission');
    } else {
      beginCountdown();
    }
  });

  document.getElementById('btn-request-permission').addEventListener('click', () => {
    DeviceOrientationEvent.requestPermission().then(result => {
      if (result === 'granted') {
        beginCountdown();
      } else {
        alert('Motion access was denied. You can still play using the on-screen tap zones.');
        beginCountdown();
      }
    }).catch(() => beginCountdown());
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
    deck = buildDeck(currentCategory);
    deckIndex = 0;
    secondsLeft = ROUND_SECONDS;
    armed = true;
    roundLog = [];

    const gameScreen = document.getElementById('screen-game');
    gameScreen.style.background = shade(currentCategory.accent, -85);
    document.getElementById('timer-bar-fill').style.background = currentCategory.accent;
    document.documentElement.style.setProperty('--accent', currentCategory.accent);

    showWord();
    updateTimerUI();
    showScreen('screen-game');
    attachOrientationListener();

    timerInterval = setInterval(() => {
      secondsLeft -= 1;
      updateTimerUI();
      if (secondsLeft <= 0) {
        endRound();
      }
    }, 1000);
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

  // ---------- TILT DETECTION ----------
  let calibrated = false;
  let baselineBeta = null;
  let baselineGamma = null;
  let lastEventTime = null;

  function attachOrientationListener() {
    if (orientationHandlerAttached) return;
    calibrated = false;
    baselineBeta = null;
    baselineGamma = null;
    lastEventTime = null;
    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('orientationchange', forceRecalibrate);
    orientationHandlerAttached = true;
  }
  function detachOrientationListener() {
    window.removeEventListener('deviceorientation', onOrientation);
    window.removeEventListener('orientationchange', forceRecalibrate);
    orientationHandlerAttached = false;
  }

  // Forces the very next orientation reading to become the new baseline.
  // Fires when the phone physically rotates mid-round (e.g. category picked
  // and Start tapped in portrait, then rotated to landscape to actually
  // play) — without this, the baseline stays anchored to the old pose and
  // the delta from it never returns to neutral, which locks up detection.
  function forceRecalibrate() {
    calibrated = false;
    armed = true;
  }

  // The instant a round starts (or the phone rotates — see forceRecalibrate
  // above), whatever tilt the phone is reporting becomes "neutral." Every
  // reading after that is measured as a change from that baseline on BOTH
  // axes (beta = front-back tilt in a portrait grip, gamma = front-back
  // tilt in a landscape grip), and whichever axis is actually moving more
  // is treated as active — so it auto-detects which axis matters without
  // needing to know screen orientation in advance.
  //
  // The baseline also drifts slowly toward the current reading over time
  // (BASELINE_DRIFT_TAU_MS), as a safety net in case a rotation happens
  // without a clean orientationchange event — a real gameplay tilt is
  // quick enough that this barely affects it, but a phone left resting in
  // a new orientation will self-correct within a couple of seconds instead
  // of staying stuck.
  //
  // One piece we can't verify without live hardware: landscape rotated
  // left vs. right can flip gamma's sign. This flip is isolated to the
  // block below — if correct/pass comes out backwards specifically in
  // landscape, that's the line to invert.
  function onOrientation(e) {
    if (e.beta === null || e.beta === undefined || e.gamma === null || e.gamma === undefined) return;
    const now = performance.now();

    if (!calibrated) {
      baselineBeta = e.beta;
      baselineGamma = e.gamma;
      calibrated = true;
      lastEventTime = now;
      armed = true;
      return;
    }

    const dt = lastEventTime !== null ? (now - lastEventTime) : 0;
    lastEventTime = now;

    const deltaBeta = e.beta - baselineBeta;
    let deltaGamma = e.gamma - baselineGamma;

    const angle = (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle : 0;
    if (angle === -90 || angle === 270) {
      deltaGamma = -deltaGamma; // flip here if landscape ever tests backwards
    }

    const dominant = Math.abs(deltaBeta) >= Math.abs(deltaGamma) ? deltaBeta : deltaGamma;

    // Safety-net drift, applied after using this frame's delta for
    // detection so a real tilt still measures against the pre-drift
    // baseline.
    if (dt > 0 && dt < 2000) {
      const alpha = 1 - Math.exp(-dt / BASELINE_DRIFT_TAU_MS);
      baselineBeta += deltaBeta * alpha;
      baselineGamma += (e.gamma - baselineGamma) * alpha;
    }

    if (!armed) {
      if (Math.abs(dominant) < DELTA_NEUTRAL) {
        armed = true;
      }
      return;
    }

    if (dominant < -DELTA_TRIGGER) {
      nextCard('pass');
    } else if (dominant > DELTA_TRIGGER) {
      nextCard('correct');
    }
  }

  // ---------- TAP FALLBACK ----------
  document.getElementById('tap-correct').addEventListener('click', () => nextCard('correct'));
  document.getElementById('tap-pass').addEventListener('click', () => nextCard('pass'));

  // ---------- END ROUND ----------
  function endRound() {
    clearInterval(timerInterval);
    detachOrientationListener();
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

  showScreen('screen-home');
})();