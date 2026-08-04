(() => {
  const ROUND_SECONDS = 60;
  const TILT_DOWN_THRESHOLD = 50;   // beta below this = correct
  const TILT_UP_THRESHOLD = 130;    // beta above this = pass
  const NEUTRAL_LOW = 70;           // must return inside [NEUTRAL_LOW, NEUTRAL_HIGH]
  const NEUTRAL_HIGH = 110;         // before another trigger can fire

  const screens = {};
  document.querySelectorAll('.screen').forEach(el => screens[el.id] = el);

  function showScreen(id) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[id].classList.add('active');
  }

  // ---------- STATE ----------
  let currentCategory = null;
  let deck = [];
  let deckIndex = 0;
  let timerInterval = null;
  let secondsLeft = ROUND_SECONDS;
  let armed = true; // whether a new trigger is allowed (hysteresis gate)
  let orientationHandlerAttached = false;

  // ---------- HOME: build category grid ----------
  const grid = document.getElementById('category-grid');

  if (typeof CATEGORIES === 'undefined' || !Array.isArray(CATEGORIES) || CATEGORIES.length === 0) {
    grid.innerHTML = '<p style="color:#FF4D5E;grid-column:1/-1;font-size:14px;">' +
      'Couldn\'t load categories — data.js is missing or failed to load. ' +
      'Check that data.js sits in the repo root alongside index.html.</p>';
    return;
  }

  CATEGORIES.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'category-card';
    btn.style.background = `linear-gradient(160deg, ${cat.accent}, ${shade(cat.accent, -18)})`;
    btn.innerHTML = `<span class="card-count">${cat.words.length}</span>${cat.name}`;
    btn.addEventListener('click', () => selectCategory(cat));
    grid.appendChild(btn);
  });

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
    document.getElementById('over-category-label').textContent = cat.name;
    document.documentElement.style.setProperty('--accent', cat.accent);
    showScreen('screen-ready');
  }

  document.getElementById('btn-back-from-ready').addEventListener('click', () => showScreen('screen-home'));
  document.getElementById('btn-back-from-permission').addEventListener('click', () => showScreen('screen-home'));

  // ---------- PERMISSION HANDLING (iOS-safe, no-op on Android) ----------
  function needsExplicitPermission() {
    return typeof DeviceOrientationEvent !== 'undefined' &&
           typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  document.getElementById('btn-start-round').addEventListener('click', () => {
    tryEnterFullscreen(); // best-effort, must be called from a direct user gesture
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
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    if (request && !document.fullscreenElement) {
      request.call(el).catch(() => {});
    }
  }

  function exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit && document.fullscreenElement) {
      exit.call(document).catch(() => {});
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
    deck = shuffledDeck(currentCategory.words);
    deckIndex = 0;
    secondsLeft = ROUND_SECONDS;
    armed = true;

    document.getElementById('screen-game').style.background = shade(currentCategory.accent, -85);
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
  }

  function showWord() {
    if (deckIndex >= deck.length) {
      deck = shuffledDeck(currentCategory.words);
      deckIndex = 0;
    }
    document.getElementById('game-word').textContent = deck[deckIndex];
    deckIndex += 1;
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
    flash(kind);
    showWord();
  }

  // ---------- TILT DETECTION ----------
  function attachOrientationListener() {
    if (orientationHandlerAttached) return;
    window.addEventListener('deviceorientation', onOrientation);
    orientationHandlerAttached = true;
  }
  function detachOrientationListener() {
    window.removeEventListener('deviceorientation', onOrientation);
    orientationHandlerAttached = false;
  }

  function getScreenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    if (typeof window.orientation === 'number') {
      return window.orientation; // older Safari-style API, still seen on some Android WebViews
    }
    return 0;
  }

  // Returns a single "forward tilt" angle (~90 = phone vertical/neutral,
  // trending toward 0 = tilted forward/down, toward 180 = tilted back/up).
  // Tuned for standard portrait and both landscape orientations. Upside-down
  // portrait (screen angle 180) falls back to the portrait formula untuned —
  // an edge case not worth the risk of shipping unverified trig for.
  function computeTilt(beta, gamma, angle) {
    switch (angle) {
      case 90:   return 90 - gamma;   // landscape, rotated left
      case -90:
      case 270:  return 90 + gamma;   // landscape, rotated right
      default:   return beta;         // standard portrait (and upside-down portrait, untuned)
    }
  }

  function onOrientation(e) {
    if (e.beta === null || e.beta === undefined || e.gamma === null || e.gamma === undefined) return;
    const angle = getScreenAngle();
    const tilt = computeTilt(e.beta, e.gamma, angle);

    if (!armed) {
      if (tilt > NEUTRAL_LOW && tilt < NEUTRAL_HIGH) {
        armed = true;
      }
      return;
    }

    if (tilt < TILT_DOWN_THRESHOLD) {
      nextCard('correct');
    } else if (tilt > TILT_UP_THRESHOLD) {
      nextCard('pass');
    }
  }

  // ---------- TAP FALLBACK ----------
  document.getElementById('tap-correct').addEventListener('click', () => nextCard('correct'));
  document.getElementById('tap-pass').addEventListener('click', () => nextCard('pass'));

  // ---------- END ROUND ----------
  function endRound() {
    clearInterval(timerInterval);
    detachOrientationListener();
    showScreen('screen-over');
  }

  document.getElementById('btn-play-again').addEventListener('click', () => beginCountdown());
  document.getElementById('btn-change-category').addEventListener('click', () => showScreen('screen-home'));

  showScreen('screen-home');
})();