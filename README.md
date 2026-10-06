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
- A **countdown timer** (60 minutes by default, changeable per session from the
  Session tab) with a chime, a screen wake lock, and state that survives reloads.
- Optional **tempo & meter** and **key & scale** lines for jams and loops, with
  a built-in **metronome** at the rolled BPM.
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
hardware, with effects, pedals and sequencers included ("Synth jam on the
Prophet-6 with the TR-8S, sequenced by the Hapax, through the Microcosm").
Every effect in a rig gets a **routing**: onto one instrument or onto a send
channel ("Routing: Microcosm on a send."), with "different rig" and
"different routing" links on the result.

Rigs are generated from **constraints**, not picked from a list. Settings →
Jam rig defaults holds the starting point: devices per jam (1 to 4), a minimum
and maximum per device type, whether send channels are allowed and how likely
they are, and whether a groovebox counts as the rig's sequencer. In the Session
tab a collapsible **Rig constraints** panel starts from those defaults and lets
you tighten them for this session: tap a device once to require it, twice to
rule it out, pin a required pedal to an instrument or a send, and adjust the
counts. The panel shows how many rigs fit, and named **presets** save a set of
constraints for one-tap recall. A rig always contains at least one synth-type
device; sequencers and effects never lead a session on their own.

**Gear rotation** (Settings, off by default) makes gear, rigs, twists and
constraints that appeared in your last few logged sessions less likely, with a
look-back count and a strength from "slightly less likely" to "almost never".

The result card has a **Share** button that puts the prompt, routing, tempo,
key, twist and constraint on the iOS share sheet (or copies them where sharing
is not available). Journal entries have their own Share, which adds the date,
time worked, rating and notes, plus a separate "Share clip" for the recording
(share targets drop the text when a file is attached, so the two go separately).

**Tempo & meter** and **Key & scale** are switches in the session builder. On,
a jam or loop-creation session gets a "Tempo: 112 BPM in 4/4" line (from the
BPM range and time-signature weights) and a "Key: F# dorian" line (any root,
scale by weight, set under Probabilities → Scale). Both have reroll links, "tap"
sets the BPM by tapping, and a "click" button runs a metronome at that tempo
with an accented downbeat, a volume slider, and a memory of whether you left it
on so it follows each new roll. A new track started from a BPM prompt gets the
same tempo line and metronome.

**Session length** can be changed from the header, five minutes at a time, for
the next session only; the Settings value stays the default and the override
clears once that session ends.

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
reloads that session's choices as locks, and can be filtered by session type,
minimum rating ("Keepers only" is five stars) and a text search over notes,
prompts and gear.

Clips are capped at 100 MB each. iOS may evict site data from Safari after a
week without use; the installed home-screen app is exempt from that rule, and
the app asks the browser for persistent storage on the first save.

## Settings

- **Timer**: default session length in minutes (presets for 25, 45, 60, 90),
  keep screen awake, chime on/off. A per-session length lives in the header.
- **Sounds & recording**: metronome volume and a microphone test that reports
  whether this device can record for the journal.
- **Hardware** and **Software**: name, type (synth, drum machine, sampler,
  groovebox, keys/piano, effects/pedal, sequencer, other) and a weight from 0
  to 10 for how often it gets picked.
- **Jam rig defaults**: devices per synth jam, per-type minimums and maximums,
  send channel settings, grooveboxes as sequencers. Per-session constraints and
  presets live in the Session tab.
- **Gear rotation**: on/off, look-back, strength, and whether constraints and
  twists rotate too.
- **Tracks in progress**: optional list used by "Existing track" sessions.
- **Creative constraints**: your own rules with a scope, and on/off switches
  for the built-in ones.
- **Probabilities**: a 0–10 weight per option in every group, shown with the
  resulting percentage. 0 removes an option from random rolls but you can still
  lock it by hand. Includes the time-signature weights, the "no twist" weight for
  effects, and the BPM range.
- **Backup**: export or import a JSON backup (settings plus journal notes).

## Editing the app

See [DEVELOPING.md](DEVELOPING.md) for how the code is organised and recipes
for adding options, device types, constraints, scales and settings.

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
js/rigs.js               jam rig constraints and generation
js/music.js              scales, roots, tempo helpers
js/metronome.js          Web Audio metronome
js/media.js              microphone helpers and recording error messages
DEVELOPING.md            developer guide
js/app.js                UI
tests/                   engine and journal tests
scripts/serve.mjs        tiny static server for development
scripts/make_icons.py    icon generator (no image libraries needed)
```
