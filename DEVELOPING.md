# Developing Session Prompter

A guide for editing the app by hand. Keep it current: every change that adds
or moves a feature should update the relevant section here.

## Stack and layout

No build step and no dependencies. Plain HTML, CSS and ES modules served as
static files. Node 22 runs the tests; Python 3 (standard library only) renders
the icons.

```
index.html               shell, iOS meta tags, loads js/app.js as a module
manifest.webmanifest     PWA manifest (start_url and scope are "./" for GitHub Pages)
sw.js                    service worker: network first, cache fallback. SHELL lists every file to cache;
                         bump CACHE when you add a file or want clients to refetch
css/styles.css           all styles; CSS variables at the top, light theme under prefers-color-scheme
js/tree.js               the decision tree, device types and their rules
js/engine.js             weighted resolution, constraint checking, prompt text, rotation, tempo and key rolls
js/rigs.js               jam rig constraints: defaults, normalisation, enumeration, weighted pick
js/constraints.js        creative constraint pool and scope matching
js/music.js              scales, roots, tap tempo, beats per bar
js/metronome.js          Web Audio click with accented downbeat and volume
js/media.js              microphone capture helpers and readable error messages
js/version.js            APP_VERSION, bumped with every release
js/store.js              settings shape, defaults and normalisation (localStorage)
js/journal.js            IndexedDB journal, stats, filters, recent usage, backup format
js/timer.js              countdown timer, wake lock, chime
js/app.js                all UI: state, rendering, event handling
tests/*.test.mjs         node:test suites for everything outside app.js
scripts/serve.mjs        dev server (npm start)
scripts/make_icons.py    icon generator (npm run icons)
.github/workflows/       tests + GitHub Pages deploy on push to main
```

## How the app works

1. `js/app.js` holds one `state` object and re-renders the whole `#app` with
   template strings on every change (`render()`). Event handling is delegated:
   elements carry `data-action="..."` and the three listeners at the bottom of
   the file (`click`, `submit`, `input`, `change`) switch on it. Open
   `<details data-key>` panels survive re-renders.
2. Generating a session calls `generateSession()` in `js/engine.js` with the
   user's locks, the weight overrides, a config (settings plus per-session rig
   constraints plus recent usage) and the builder switches (`withConstraint`,
   `withTempo`, `withKey`).
3. `resolve()` walks `buildDecisions(config)` in order. A decision applies when
   its `parent` or `anyOf` matches what is already chosen. Locked values are
   kept when compatible; everything else is a weighted pick among options
   compatible with all fixed choices (`requires` maps are checked both ways).
4. After the tree, `generateSession()` adds the pieces that are not tree
   choices: the jam rig and its routing, BPM, tempo and key lines, the twist,
   the creative constraint, and finally the prompt text and detail chips.
5. The result is persisted in localStorage so a reload shows the same prompt.

### Storage keys

| Key | Contents |
| --- | --- |
| `sessionPrompter.settings.v1` | everything under Settings (`normalizeSettings` shape) |
| `sessionPrompter.session.v1` | current locks, last result, one-off session length |
| `sessionPrompter.rig.v1` | this session's rig constraints |
| `sessionPrompter.timer.v1` | running timer state |
| IndexedDB `sessionPrompter` / store `sessions` | journal entries, including audio blobs |

Settings always pass through `normalizeSettings()` on load and on import, so
new fields need a default in `DEFAULT_SETTINGS` and a line in the normaliser.

## Recipes

### Add an option to an existing decision

In `js/tree.js`, add `{ id, label }` (optional `weight`, optional `requires`)
to the decision's `options`. Then teach the prompt about it in
`generateSession()` (`js/engine.js`), usually a lookup table keyed by option id.
Settings → Probabilities picks it up automatically. Add a case to the
"generateSession produces text for every outcome" test if the text differs.

### Add a new decision (a new level in the tree)

Append to `STATIC_DECISIONS` in `js/tree.js` with `parent: [decisionId, optionId]`
(or `anyOf: [[...], [...]]`). Order matters: a decision must come after the
ones it depends on. The builder, settings and resolver need no changes. Write
the prompt text in `generateSession()`.

### Constrain one option by another

Use `requires` on the option: `{ id: 'live', label: 'Live recording', requires: { soundKind: ['oneshot'] } }`.
The engine enforces it in both directions and the builder greys out
incompatible chips.

### Add a device type

In `js/tree.js` add an entry to `DEVICE_TYPES`: `label`, optional `jam: true`
(can lead a synth jam), optional `role: 'fx' | 'sequencer'`, and `requires`
saying where the type may appear (an empty array means never for that
decision). Effects and sequencers only join rigs; the engine's `onRig()` wording
lists them after the instruments.

### Add a creative constraint or a scope

Rules live in `BUILT_IN_CONSTRAINTS` in `js/constraints.js` with a `scope`.
New scopes need a label in `SCOPES` and a case in `matchesScope()`. The
`rig` scope receives `rigSize` alongside the selections.

### Change rig generation

`js/rigs.js`: `defaultRigConstraints()` derives the per-session starting point
from Settings; `enumerateRigs()` lists every device set that satisfies size,
per-type limits, must/never and the lead-device rule; `pickRig()` weights them
by device weight and rotation. Routing (which effect goes on which instrument
or a send) is `routeRig()` in `js/engine.js`.

### Add a scale, tempo rule or musical extra

Scales are `SCALE_DECISION.options` in `js/music.js` (weights editable under
Probabilities → Scale). Tempo uses the BPM range and the `timeSig` decision.
`musicApplies()` in the engine decides which sessions get tempo and key lines.

### Add a setting

1. Default in `DEFAULT_SETTINGS` and parsing in `normalizeSettings()` (`js/store.js`).
2. Controls in `renderSettings()` (or a sub-section) in `js/app.js` with a
   `data-action`, and a handler in the matching listener.
3. Read it where it matters (engine config, timer, metronome...).
4. A test in `tests/journal.test.mjs` (settings normalisation lives there).

### Add a field to journal entries

Set it in `makeEntry()` from the session, parse it in `parseBackup()`
(`js/journal.js`), show it in `renderEntry()` and `renderLogForm()`, and add it
to `sessionLines()` if it belongs in a share.

### Change prompt wording

All sentences are in `generateSession()` in `js/engine.js`. Keep the prompt
itself to one sentence; routing, tempo, key, twist and constraint are separate
lines the UI renders under it.

## iOS notes

- Audio: the chime and metronome use Web Audio, unlocked by the tap that starts
  them. `navigator.audioSession.type = 'playback'` lets them play with the mute
  switch on, but that category blocks the microphone, so `js/media.js` switches
  to `play-and-record` before `getUserMedia` and back afterwards.
- Background: JavaScript pauses when the app is not on screen. The timer keeps
  an absolute end time and the wake lock keeps the screen on.
- Storage: Safari may evict site data after seven days without use; the
  installed app is exempt and the journal asks for persistent storage.
- Recording in the home-screen app needs a recent iOS; older versions have no
  `getUserMedia` there, and the app says so.
- Sharing: when a Web Share payload contains a file, most targets (WhatsApp
  among them) keep the file and drop the text. Journal entries therefore share
  text and the clip as two separate actions (`shareEntry`, `shareEntryClip`
  in `js/app.js`); never put both in one `navigator.share` call.

## Testing

```sh
npm test      # node:test suites in tests/
npm start     # http://localhost:8080
```

Unit tests cover the engine, rigs, constraints, music, media helpers, store and
journal logic. UI behaviour was checked with Playwright scripts against
Chromium at an iPhone viewport; keep `app.js` free of logic that cannot be
exercised that way, and prefer moving pure logic into a module with a test.

Formatting is Prettier with the repo's `.prettierrc`:
`npx prettier --write "js/**/*.js" "css/*.css" "tests/*.mjs"`.

## Releasing

1. Bump `APP_VERSION` in `js/version.js` and `CACHE` in `sw.js` (every
   release, not only when files are added). The version shows under
   Settings → About; the cache name makes installed apps refetch the shell.
2. Push to `main`. The workflow runs the tests and deploys the repository root
   to GitHub Pages.

How updates reach a phone: the service worker fetches with `cache: 'no-cache'`,
so each open revalidates against the server. When a new worker installs,
`js/app.js` shows a "Reload" toast and Settings → About offers "Update now"
(it posts `skipWaiting` and reloads on `controllerchange`). Opening the app
also triggers an update check when it becomes visible. An installed iOS app
that was never closed can still run old code until it is relaunched.
