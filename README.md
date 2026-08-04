# Heads Up Clone

Tilt-controlled Heads Up party game for your Android phone. Pure HTML/CSS/JS, no build step, no dependencies beyond a Google Fonts CDN link.

## How it works

- Pick a category on the home screen.
- Hold the phone to your forehead, screen facing your friends.
- Tilt the top of the phone **down** for correct, tilt it **back/up** to pass.
- 60-second round, no scorekeeping — just continuous flipping through the deck (it reshuffles if you run out of words).
- Tap zones on the game screen work as a fallback if tilt isn't cooperating.

## Deploying to GitHub Pages

1. Create a new repo on GitHub (e.g. `heads-up`).
2. Push these files to the repo root (`index.html`, `style.css`, `app.js`, `data.js`):
   ```bash
   git init
   git add .
   git commit -m "Heads Up clone"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/heads-up.git
   git push -u origin main
   ```
3. In the repo on GitHub: **Settings → Pages → Source → Deploy from a branch → main / (root)**.
4. After a minute, your game is live at `https://YOUR_USERNAME.github.io/heads-up/`.
5. On your Android phone, open that URL in Chrome, then use the browser menu → **Add to Home screen** for a full-screen app feel.

## Important: HTTPS is required for tilt

The `deviceorientation` API only fires in a secure context. GitHub Pages serves over HTTPS automatically, so this works out of the box — but it will **not** work if you just open `index.html` from local disk (`file://`) or over plain `http://`.

## Editing categories / words

All content lives in `data.js` — each category is an object with `id`, `name`, `accent` (hex color), and a `words` array. Add, remove, or edit entries there; no other file needs to change.

## Tuning tilt sensitivity

In `app.js`, near the top:
- `TILT_DOWN_THRESHOLD` (default 50) — lower = more forward tilt required for "correct"
- `TILT_UP_THRESHOLD` (default 130) — higher = more backward tilt required for "pass"
- `NEUTRAL_LOW` / `NEUTRAL_HIGH` (70/110) — the phone must swing back through this zone before the next tilt can register, preventing double-triggers.
