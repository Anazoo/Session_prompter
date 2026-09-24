# Session Prompter

A small web app for music producers. It turns "what should I do today?" into a
concrete, randomly generated session prompt, then runs a one-hour timer so you
actually do it.

- Three session types: **Assets creation**, **Jamming**, **Working on tracks**.
- Every choice in the tree can be **locked by hand or left to chance**. Lock the
  parts you already know, leave the rest on Random, and the app fills in the gaps.
- **Weighted probabilities** for every option, adjustable in Settings.
- A **hardware list** so prompts name your actual gear ("Create a pad loop on
  the Prophet-6").
- A **countdown timer** (60 minutes by default) with a chime, a screen wake lock,
  and state that survives reloads.
- Installable on **iPhone** as a home-screen app; works offline.

No build step, no dependencies. Plain HTML, CSS and ES modules.

## The decision tree

```
Session type
├── Assets creation
│   ├── Loop creation
│   │   ├── Loop type:  pad · chord progression · melodic · drum loop · soundscape
│   │   └── Method:     hardware · software · live recording
│   └── Sound design
│       ├── Target:     drum kit · preset · one-shot
│       └── Method:     hardware · software · live recording (one-shot only)
├── Jamming:            synth jam · piano jam · other
└── Working on tracks
    ├── Existing track  (optionally picked from your tracks-in-progress list)
    └── New track
        └── Starting point: hardware · your assets · a jam · BPM & time signature
            └── Time signature: 4/4 · 3/4 · 6/8 · 5/4 · 7/8  (+ a random BPM in your range)
```

When a hardware context comes up (a hardware loop, hardware sound design, a
synth or piano jam, a new track from hardware) the app also picks a **device**
from your hardware list, filtered by what fits: drum machines get drum loops and
drum kits, keys get piano jams and chord work, synths get pads, melodies and
presets, and so on. If you own effects units or pedals, sessions that create
assets or work on tracks may get an optional **"twist"** line telling you to run
something through one of them.

Locks are validated against each other. Lock "Live recording" for sound design
and the target becomes a one-shot; lock a drum machine and the loop type becomes
a drum loop. Incompatible chips are greyed out.

## Running it locally

```sh
npm start        # serves the folder at http://localhost:8080
npm test         # runs the engine tests (node:test, no dependencies)
npm run icons    # regenerates icons/ from scripts/make_icons.py
```

Any static file server works; there is nothing to compile.

## Putting it on your phone

The app is a Progressive Web App, so it needs to be served over HTTPS to install.
The easiest host is GitHub Pages:

1. In the repository, open **Settings → Pages** and set **Source** to
   **GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/deploy-pages.yml` runs the
   tests and publishes the site at `https://<user>.github.io/Session_prompter/`.
3. On the iPhone, open that URL in **Safari**, tap **Share → Add to Home
   Screen**. Launch it from the home screen for the full-screen version.

Settings, hardware, tracks, the last generated session and a running timer are
all stored on the device (localStorage). Nothing leaves the phone.

### iOS notes

- iOS suspends web apps in the background, so the timer keeps an absolute end
  time and re-syncs whenever the app comes back. The countdown is always correct,
  but the chime can only play while the app is on screen. "Keep screen awake"
  (on by default, Safari 16.4+) uses the Screen Wake Lock so the display stays on
  during a session.
- The chime is generated with Web Audio and is unlocked by the tap that starts
  the timer. On iOS 17+ it also asks for the "playback" audio session so it can
  play with the mute switch on.

## Settings

- **Timer**: session length in minutes (presets for 25, 45, 60, 90), keep screen
  awake, chime on/off.
- **Hardware**: name, type (synth, drum machine, sampler, groovebox, keys/piano,
  effects/pedal, other) and a weight from 0 to 10 for how often it gets picked.
- **Tracks in progress**: optional list used by "Existing track" sessions.
- **Probabilities**: a 0–10 weight per option in every group, shown with the
  resulting percentage. 0 removes an option from random rolls but you can still
  lock it by hand. Includes the time-signature weights, the "no twist" weight for
  effects, and the BPM range.

## Project layout

```
index.html               app shell and iOS meta tags
manifest.webmanifest     PWA manifest
sw.js                    service worker (offline cache)
css/styles.css           styles, dark and light themes
js/tree.js               the decision tree and device-type rules
js/engine.js             weighted resolution, constraints, prompt text
js/store.js              settings persistence and validation
js/timer.js              countdown timer, wake lock, chime
js/app.js                UI
tests/engine.test.mjs    engine tests
scripts/serve.mjs        tiny static server for development
scripts/make_icons.py    icon generator (no image libraries needed)
```
