# Session Prompter

A small web app for music producers. It turns "what should I do today?" into a
concrete, randomly generated session prompt, then runs a one-hour timer so you
actually do it.

- Three session types: **Assets creation**, **Jamming**, **Working on tracks**.
- Every choice in the tree can be **locked by hand or left to chance**. Lock the
  parts you already know, leave the rest on Random, and the app fills in the gaps.
- **Weighted probabilities** for every option, adjustable in Settings.
- **Hardware and software lists** so prompts name your actual gear ("Create a
  pad loop on the Prophet-6", "Design a preset in Serum").
- A **countdown timer** (60 minutes by default) with a chime, a screen wake lock,
  and state that survives reloads.
- A **journal**: log each finished session with a 1 to 5 star rating, notes on
  what you made and an optional audio clip (pick a bounce from Files or record
  straight from the mic). Shows totals per session type, your average rating
  and when you last did each one.
- A pool of **creative constraints** ("No kick on beat one", "Only three
  sounds") added as an extra line when you flip the switch, matched to the
  session type. Switch built-in rules off or add your own.
- **Backup export and import** of settings, gear lists, tracks and journal notes.
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
│       │   └── Preset type: instrument preset · effect preset
│       └── Method:     hardware · software · live recording (one-shot only)
├── Jamming:            synth jam · piano jam · other
│   └── Synth jam:      a jam rig, one device or a combination of your hardware
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

For "software" loops and sound design the same happens with your software
list: a synth plugin gets pads and presets, a drum plugin gets drum loops.
Effects from either list feed the twist, and they are the only devices that
can be the target of an **effect preset** ("Design an effect preset on the
Microcosm"). The effect you are designing on is never also the twist, and
"different twist" on the result swaps the twist for another effect.

**Synth jams** pick a **jam rig**: one device or a combination of your
hardware. Settings → Jam rigs sets how many devices a jam may use (1 to 4),
lists every generated combination with an on/off switch, and lets you add
combinations of your own. A generated combination always contains at least one
synth-type device (synth, groovebox, keys or other instrument); a custom rig
can be anything.

A **Creative constraint** switch in the session builder decides whether a roll
also gets an extra rule. The app picks one that fits the session: drum-loop
rules for drum loops, drum-kit rules for kits, separate rules for instrument
and effect presets, one-shots, melodic loops, jams, multi-device rigs and
tracks. Tap "different rule" on the result to swap it. The switch is remembered
between sessions. The built-in pool lives in `js/constraints.js`; Settings lets
you switch any rule off and add your own with a scope.

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

Settings, gear, tracks, the last generated session and a running timer are
stored in localStorage; the journal (notes and audio clips) lives in IndexedDB.
Nothing leaves the phone. Use **Settings → Backup** to export a JSON file you
can import on another device; audio clips are not included in the file.

### iOS notes

- iOS suspends web apps in the background, so the timer keeps an absolute end
  time and re-syncs whenever the app comes back. The countdown is always correct,
  but the chime can only play while the app is on screen. "Keep screen awake"
  (on by default, Safari 16.4+) uses the Screen Wake Lock so the display stays on
  during a session.
- The chime is generated with Web Audio and is unlocked by the tap that starts
  the timer. On iOS 17+ it also asks for the "playback" audio session so it can
  play with the mute switch on.

## Logging a session

When the timer ends (or you tap "End & log" early) the app opens a log form
with the prompt and the time actually worked. Rate it, add notes, attach a clip with
"Choose file" (Files, Voice Memos exports, a bounce from your DAW) or tap
"Record" to capture straight from the microphone, then save. Sessions run
without the timer can be logged from the result card. The Journal tab lists
everything with playback, editing, deletion and "Roll this again", which
reloads that session's choices as locks.

Clips are capped at 100 MB each. iOS may evict site data from Safari after a
week without use; the installed home-screen app is exempt from that rule, and
the app asks the browser for persistent storage on the first save.

## Settings

- **Timer**: session length in minutes (presets for 25, 45, 60, 90), keep screen
  awake, chime on/off.
- **Hardware** and **Software**: name, type (synth, drum machine, sampler,
  groovebox, keys/piano, effects/pedal, other) and a weight from 0 to 10 for how
  often it gets picked.
- **Jam rigs**: devices per synth jam, switches for each generated
  combination, and your own combinations.
- **Tracks in progress**: optional list used by "Existing track" sessions.
- **Creative constraints**: your own rules with a scope, and on/off switches
  for the built-in ones.
- **Probabilities**: a 0–10 weight per option in every group, shown with the
  resulting percentage. 0 removes an option from random rolls but you can still
  lock it by hand. Includes the time-signature weights, the "no twist" weight for
  effects, and the BPM range.
- **Backup**: export or import a JSON backup (settings plus journal notes).

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
js/journal.js            IndexedDB journal, stats, backup format
js/constraints.js        creative constraint pool and scope matching
js/app.js                UI
tests/                   engine and journal tests
scripts/serve.mjs        tiny static server for development
scripts/make_icons.py    icon generator (no image libraries needed)
```
