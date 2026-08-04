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
  let currentWord = null;
  let roundLog = []; // { word, result: 'correct' | 'pass' }
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
    roundLog = [];

    const gameScreen = document.getElementById('screen-game');
    gameScreen.classList.add('force-landscape');
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
  }

  function showWord() {
    if (deckIndex >= deck.length) {
      deck = shuffledDeck(currentCategory.words);
      deckIndex = 0;
    }
    currentWord = deck[deckIndex];
    document.getElementById('game-word').textContent = currentWord;
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
    roundLog.push({ word: currentWord, result: kind });
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

  // The phone is always sensed as held in a natural vertical (portrait)
  // grip against the forehead — this is the only orientation we read tilt
  // from, regardless of what the game screen looks like visually (the
  // "landscape" presentation is a pure CSS rotation, see .force-landscape).
  // Mapping is inverted from the first version based on real-device
  // testing: tilting the top of the phone DOWN now registers as pass,
  // tilting it UP/back registers as correct.
  function onOrientation(e) {
    if (e.beta === null || e.beta === undefined) return;
    const tilt = e.beta;

    if (!armed) {
      if (tilt > NEUTRAL_LOW && tilt < NEUTRAL_HIGH) {
        armed = true;
      }
      return;
    }

    if (tilt < TILT_DOWN_THRESHOLD) {
      nextCard('pass');
    } else if (tilt > TILT_UP_THRESHOLD) {
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
    document.getElementById('screen-game').classList.remove('force-landscape');
    renderResults();
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