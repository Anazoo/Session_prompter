import {
  generateSession,
  isApplicable,
  pickKey,
  pickTempo,
  isCompatible,
  optionWeight,
  pickConstraint,
  pruneLocks,
  routeRig,
  routingText,
  rotationPenalty,
  weightedPick,
} from './engine.js';
import {
  defaultRigConstraints,
  enumerateRigs,
  normalizeRigConstraints,
  pickRig,
  summarizeConstraints,
} from './rigs.js';
import { SCALE_DECISION, beatsPerBar, bpmFromTaps, scaleWeight } from './music.js';
import { Metronome } from './metronome.js';
import { describeMediaError, isStandaloneIOS, pickRecordingType, prepareCapture, releaseCapture } from './media.js';
import { APP_VERSION } from './version.js';
import { BUILT_IN_CONSTRAINTS, SCOPES } from './constraints.js';
import {
  DEFAULT_WEIGHT,
  DEVICE_DECISION,
  DEVICE_TYPES,
  DEVICE_TYPE_IDS,
  FX_DECISION,
  FX_NONE,
  RANDOM_ROUTE,
  RIG_MAX_SIZE,
  ROLE_OF,
  SEND,
  SOFTWARE_DECISION,
  STATIC_DECISIONS,
  TRACK_DECISION,
  buildDecisions,
  findDecision,
  jamDevices,
} from './tree.js';
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings, uid } from './store.js';
import { SessionTimer, formatClock } from './timer.js';
import {
  MAX_AUDIO_BYTES,
  clearEntries,
  deleteEntry,
  filterEntries,
  formatBytes,
  formatDuration,
  listEntries,
  makeBackup,
  makeEntry,
  parseBackup,
  putEntry,
  recentUsage,
  requestPersistence,
  summarize,
} from './journal.js';

const SESSION_KEY = 'sessionPrompter.session.v1';
const RIG_KEY = 'sessionPrompter.rig.v1';
const RING_RADIUS = 100;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const state = {
  view: 'session',
  settings: loadSettings(),
  locks: {},
  result: null,
  toast: null,
  journal: { entries: [], loaded: false, error: null },
  // Pending "log this session" form: { session, startedAt, elapsedMs, plannedMs, notes, audio, entryId }
  logDraft: null,
  recording: null,
  // Per-session jam rig constraints, started from the Settings defaults.
  rigConstraints: null,
  journalFilter: { type: '', minRating: 0, query: '' },
  // One-off session length in minutes (null = the Settings default).
  sessionMinutes: null,
  metronomeOn: false,
  tapTimes: [],
  updateReady: false,
};
let swRegistration = null;
let tapFadeHandle = null;
const metronome = new Metronome();

const root = document.getElementById('app');
const audioUrls = new Map(); // entry id -> { blob, url }
let lastTimerStatus = 'idle';
let toastHandle = null;
let recordingTicker = null;

const timer = new SessionTimer({
  onChange: (timerState) => {
    if (timerState.status !== lastTimerStatus) {
      lastTimerStatus = timerState.status;
      render();
    } else {
      updateTimerDisplay();
    }
  },
  onDone: () => {
    showToast("Time's up. Nice work.");
  },
});
applyTimerSettings();
lastTimerStatus = timer.state.status;
restoreSession();
restoreRigConstraints();

// ---------- helpers ----------

function esc(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function applyTimerSettings() {
  timer.keepAwake = state.settings.timer.keepAwake;
  timer.chimeEnabled = state.settings.timer.chime;
  metronome.setVolume(state.settings.metronome.volume / 10);
}

function persistSettings() {
  saveSettings(state.settings);
  applyTimerSettings();
}

function persistSession() {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ locks: state.locks, result: state.result, sessionMinutes: state.sessionMinutes }),
    );
  } catch {
    /* ignore */
  }
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      state.locks = pruneLocks(currentDecisions(), saved.locks || {});
      state.result = saved.result && typeof saved.result === 'object' ? saved.result : null;
      const m = Number.parseInt(saved.sessionMinutes, 10);
      state.sessionMinutes = Number.isFinite(m) && m >= 1 && m <= 240 ? m : null;
    }
  } catch {
    /* ignore */
  }
}

function restoreRigConstraints() {
  try {
    const raw = localStorage.getItem(RIG_KEY);
    state.rigConstraints = normalizeRigConstraints(raw ? JSON.parse(raw) : null, state.settings);
  } catch {
    state.rigConstraints = defaultRigConstraints(state.settings);
  }
}

function setRigConstraints(next) {
  state.rigConstraints = normalizeRigConstraints(next, state.settings);
  try {
    localStorage.setItem(RIG_KEY, JSON.stringify(state.rigConstraints));
  } catch {
    /* ignore */
  }
}

/** Everything the engine needs: settings plus this session's rig constraints and recent usage. */
function engineConfig() {
  return {
    ...state.settings,
    rigConstraints: state.rigConstraints,
    recent: recentUsage(state.journal.entries, state.settings.rotation.lookBack),
  };
}

function sessionMinutes() {
  return state.sessionMinutes ?? state.settings.timer.minutes;
}

function setSessionMinutes(minutes) {
  state.sessionMinutes = minutes === null ? null : Math.min(240, Math.max(1, minutes));
  persistSession();
  render();
}

function stopMetronome() {
  if (state.metronomeOn) metronome.stop();
  state.metronomeOn = false;
}

/** Keep the click in step with the current result when the user left it on. */
function syncMetronome() {
  const r = state.result;
  if (!state.settings.metronome.on || !r?.bpm) {
    stopMetronome();
    return;
  }
  if (state.metronomeOn) metronome.retune(r.bpm, beatsPerBar(r.timeSig));
  else state.metronomeOn = metronome.start(r.bpm, beatsPerBar(r.timeSig));
}

function setMetronomePreference(on) {
  state.settings = { ...state.settings, metronome: { ...state.settings.metronome, on } };
  persistSettings();
}

function setResultTempo(bpm, timeSig) {
  const r = state.result;
  const detail = (r.detail || []).filter((d) => d !== `${r.bpm} BPM` && d !== r.timeSig);
  state.result = {
    ...r,
    bpm,
    timeSig,
    tempoText: `${bpm} BPM in ${timeSig}`,
    detail: [...detail, `${bpm} BPM`, timeSig],
  };
  if (state.metronomeOn) metronome.retune(bpm, beatsPerBar(timeSig));
  persistSession();
  render();
}

function tapTempo() {
  const now = Date.now();
  const last = state.tapTimes[state.tapTimes.length - 1];
  state.tapTimes = last && now - last > 2500 ? [now] : [...state.tapTimes, now].slice(-8);
  // Light the button while a tap run is in progress; it fades once taps stop.
  clearTimeout(tapFadeHandle);
  tapFadeHandle = setTimeout(() => {
    state.tapTimes = [];
    document.querySelector('button[data-action="tap-tempo"]')?.classList.remove('active');
  }, 2500);
  const bpm = bpmFromTaps(state.tapTimes);
  if (!bpm) {
    document.querySelector('button[data-action="tap-tempo"]')?.classList.add('active');
    return;
  }
  if (state.result?.tempoText) setResultTempo(bpm, state.result.timeSig || '4/4');
}

function currentDecisions() {
  return buildDecisions(state.settings);
}

function showToast(message, ms = 2600, action = null) {
  state.toast = { message, action };
  renderToast();
  clearTimeout(toastHandle);
  if (ms > 0) {
    toastHandle = setTimeout(() => {
      state.toast = null;
      renderToast();
    }, ms);
  }
}

function renderToast() {
  let el = document.querySelector('.toast');
  if (!state.toast) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = state.toast.message;
  if (state.toast.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = state.toast.action.label;
    btn.addEventListener('click', state.toast.action.onClick);
    el.append(' ', btn);
  }
}

function pathLabel(decisions, decision) {
  const parts = [];
  let current = decision;
  while (current?.parent) {
    const [parentId, optionId] = current.parent;
    const parent = findDecision(decisions, parentId);
    const option = parent?.options.find((o) => o.id === optionId);
    if (option) parts.unshift(option.label);
    current = parent;
  }
  return parts.join(' › ');
}

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ts).toISOString();
  }
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

function audioUrl(id, blob) {
  if (!blob) return null;
  const cached = audioUrls.get(id);
  if (cached && cached.blob === blob) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(blob);
  audioUrls.set(id, { blob, url });
  return url;
}

function dropAudioUrl(id) {
  const cached = audioUrls.get(id);
  if (cached) URL.revokeObjectURL(cached.url);
  audioUrls.delete(id);
}

function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- journal data ----------

async function loadJournal() {
  try {
    state.journal.entries = await listEntries();
    state.journal.loaded = true;
    state.journal.error = null;
  } catch (err) {
    state.journal.loaded = true;
    state.journal.error = err?.message || 'Could not open the journal';
  }
  render();
}

function lastLogged(title) {
  return state.journal.entries.find((e) => e.title === title) || null;
}

// ---------- actions ----------

function setLock(decisionId, optionId) {
  const locks = { ...state.locks };
  if (!optionId || locks[decisionId] === optionId) delete locks[decisionId];
  else locks[decisionId] = optionId;
  state.locks = pruneLocks(currentDecisions(), locks);
  persistSession();
  render();
}

function generate() {
  const result = generateSession({
    locks: state.locks,
    weights: state.settings.weights,
    config: engineConfig(),
    withConstraint: state.settings.constraints.enabled,
    withTempo: state.settings.music.tempo,
    withKey: state.settings.music.key,
  });
  state.result = result;
  state.tapTimes = [];
  syncMetronome();
  persistSession();
  render();
  document.querySelector('.result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startTimer() {
  if (!state.result) generate();
  timer.start(sessionMinutes() * 60 * 1000);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Open the "log this session" form, optionally taking the elapsed time from the timer. */
function openLogDraft({ fromTimer }) {
  if (!state.result) return;
  const draft = {
    session: state.result,
    startedAt: fromTimer ? timer.state.startedAt : null,
    elapsedMs: fromTimer ? timer.elapsedMs : null,
    plannedMs: fromTimer ? timer.state.durationMs : sessionMinutes() * 60 * 1000,
    notes: '',
    rating: null,
    audio: null,
    entryId: null,
  };
  if (fromTimer) {
    timer.reset();
    state.sessionMinutes = null; // a one-off length lasts for one session
  }
  state.logDraft = draft;
  state.view = 'session';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openEditDraft(entry) {
  state.logDraft = {
    session: entry,
    startedAt: entry.startedAt,
    elapsedMs: entry.elapsedMs,
    plannedMs: entry.plannedMs,
    notes: entry.notes || '',
    rating: entry.rating || null,
    audio: entry.audio || null,
    entryId: entry.id,
    createdAt: entry.createdAt,
  };
  render();
  document.querySelector('.log-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveLogDraft() {
  const d = state.logDraft;
  if (!d) return;
  stopRecording(false);
  const entry = makeEntry(d.session, {
    id: d.entryId || undefined,
    createdAt: d.createdAt || undefined,
    startedAt: d.startedAt,
    elapsedMs: d.elapsedMs,
    plannedMs: d.plannedMs,
    notes: d.notes,
    rating: d.rating,
    audio: d.audio,
  });
  try {
    await putEntry(entry);
    requestPersistence();
    dropAudioUrl(entry.id);
    dropAudioUrl('draft');
    state.logDraft = null;
    await loadJournal();
    showToast(d.entryId ? 'Session updated' : 'Saved to journal');
    if (!d.entryId) {
      state.view = 'journal';
      render();
      window.scrollTo({ top: 0 });
    }
  } catch (err) {
    showToast(`Could not save: ${err?.message || 'storage error'}`);
  }
}

function discardLogDraft() {
  stopRecording(false);
  dropAudioUrl('draft');
  state.logDraft = null;
  render();
}

function setDraftAudio(file) {
  if (!state.logDraft || !file) return;
  if (file.size > MAX_AUDIO_BYTES) {
    showToast(`That file is ${formatBytes(file.size)}. Keep clips under ${formatBytes(MAX_AUDIO_BYTES)}.`);
    return;
  }
  state.logDraft.audio = { name: file.name || 'recording', type: file.type || 'audio/*', size: file.size, blob: file };
  render();
}

// In-app recording via MediaRecorder (Safari 14.1+, Chrome, Firefox).
async function startRecording() {
  const env = { standalone: isStandaloneIOS(), secure: window.isSecureContext !== false };
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast(describeMediaError(null, { ...env, supported: false }), 6000);
    return;
  }
  // Playback-only audio sessions (timer chime, metronome) block the mic on iOS: switch first.
  stopMetronome();
  prepareCapture();
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickRecordingType();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      recorder = new MediaRecorder(stream); // let the browser choose its default format
    }
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onerror = (e) => {
      showToast(describeMediaError(e?.error || e, env), 6000);
      stopRecording(false);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      releaseCapture();
      const type = recorder.mimeType || mime || 'audio/webm';
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const blob = new Blob(chunks, { type });
      const keep = state.recording?.keep !== false;
      state.recording = null;
      clearInterval(recordingTicker);
      if (keep && state.logDraft && blob.size) {
        state.logDraft.audio = {
          name: `session-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.${ext}`,
          type,
          size: blob.size,
          blob,
        };
      } else if (keep && state.logDraft) {
        showToast('The recording came back empty. Try again or use "Choose file".', 5000);
      }
      render();
    };
    recorder.start(1000);
    state.recording = { recorder, startedAt: Date.now(), keep: true };
    render();
    recordingTicker = setInterval(() => {
      const el = document.querySelector('.rec-clock');
      if (el && state.recording) el.textContent = formatClock(Date.now() - state.recording.startedAt);
    }, 500);
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    releaseCapture();
    showToast(describeMediaError(err, env), 7000);
  }
}

function stopRecording(keep = true) {
  const rec = state.recording;
  if (!rec) return;
  rec.keep = keep;
  try {
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  } catch {
    state.recording = null;
  }
}

async function removeEntry(id) {
  if (!window.confirm('Delete this session from the journal?')) return;
  try {
    await deleteEntry(id);
    dropAudioUrl(id);
    if (state.logDraft?.entryId === id) state.logDraft = null;
    await loadJournal();
    showToast('Session deleted');
  } catch (err) {
    showToast(`Could not delete: ${err?.message || 'storage error'}`);
  }
}

function rollLikeEntry(entry) {
  state.locks = pruneLocks(currentDecisions(), entry.selections || {});
  state.result = null;
  persistSession();
  state.view = 'session';
  render();
  window.scrollTo({ top: 0 });
  showToast('Choices loaded. Roll when ready.');
}

/** Re-roll where the rig's effects go, keeping any routes fixed by a custom rig. */
/** Re-roll where the rig's effects go, keeping routes pinned in the rig constraints. */
function rerollRouting() {
  const r = state.result;
  if (!r?.routing?.length) return;
  const rig = (r.rig || []).map((id) => state.settings.hardware.find((h) => h.id === id)).filter(Boolean);
  const pins = state.rigConstraints.pins || {};
  const canChange = rig.some((d) => ROLE_OF(d) === 'fx' && !pins[d.id]);
  const instruments = rig.filter((d) => ROLE_OF(d) === 'instrument').length;
  if (!canChange || (instruments < 2 && !state.rigConstraints.sendChance)) {
    showToast('Nothing else to route this rig through.');
    return;
  }
  const cfg = { rigs: { sends: { enabled: true, chance: state.rigConstraints.sendChance } } };
  const before = r.routingText;
  for (let i = 0; i < 20; i++) {
    const routes = routeRig(rig, pins, cfg);
    const text = routingText(routes);
    if (text !== before || i === 19) {
      state.result = {
        ...r,
        routing: routes.map((x) => ({ fx: x.fx.id, target: x.target === SEND ? SEND : x.target.id })),
        routingText: text,
      };
      break;
    }
  }
  persistSession();
  render();
}

/** Pick another rig that satisfies the current constraints, then route it. */
function rerollRig() {
  const r = state.result;
  if (!r || r.selections?.jamType !== 'synth') return;
  const hardware = state.settings.hardware;
  const options = enumerateRigs(hardware, state.rigConstraints);
  if (options.length < 2) {
    showToast(options.length ? 'Only one rig fits these constraints.' : 'No rig fits these constraints.');
    return;
  }
  const penalty = rotationPenalty(engineConfig());
  const current = (r.rig || []).slice().sort().join('+');
  let rig = null;
  for (let i = 0; i < 30 && !rig; i++) {
    const candidate = pickRig(hardware, state.rigConstraints, Math.random, (id) => penalty(id, 'devices'));
    if (
      candidate &&
      candidate
        .map((d) => d.id)
        .sort()
        .join('+') !== current
    )
      rig = candidate;
  }
  if (!rig) {
    showToast('Could not find a different rig.');
    return;
  }
  const fresh = generateSession({
    locks: { ...r.selections },
    weights: state.settings.weights,
    config: {
      ...engineConfig(),
      rigConstraints: {
        ...state.rigConstraints,
        must: rig.map((d) => d.id),
        max: Math.max(state.rigConstraints.max, rig.length),
        min: Math.min(state.rigConstraints.min, rig.length),
      },
    },
    withConstraint: false,
  });
  state.result = {
    ...r,
    prompt: fresh.prompt,
    detail: fresh.detail,
    rig: fresh.rig,
    rigLabel: fresh.rigLabel,
    routing: fresh.routing,
    routingText: fresh.routingText,
    rigNotice: fresh.rigNotice,
  };
  persistSession();
  render();
}

/** Put the session on the share sheet, or copy it when sharing is unavailable. */
async function shareResult() {
  const r = state.result;
  if (!r) return;
  await shareText(`Session Prompter: ${r.title}`, sessionLines(r).join('\n'));
}

/** The lines that describe a session or a journal entry. */
function sessionLines(r) {
  const lines = [r.prompt];
  if (r.routingText) lines.push(`Routing: ${r.routingText}`);
  if (r.tempoText) lines.push(`Tempo: ${r.tempoText}`);
  if (r.keyText) lines.push(`Key: ${r.keyText}`);
  if (r.twist) lines.push(r.twist);
  if (r.constraint) lines.push(`Constraint: ${r.constraint}`);
  if (r.detail?.length) lines.push(r.detail.join(' · '));
  return lines;
}

/** Share text via the share sheet, or copy it. Resolves true when it went somewhere. */
async function shareText(title, text) {
  try {
    if (navigator.share) {
      await navigator.share({ title, text });
      return true;
    }
    await navigator.clipboard.writeText(text);
    showToast('Copied to the clipboard');
    return true;
  } catch (err) {
    if (err?.name !== 'AbortError') showToast('Could not share this.');
    return false;
  }
}

/**
 * Share a logged session as text. The clip goes separately (see shareEntryClip): when a share
 * carries a file, apps such as WhatsApp keep the file and drop the text.
 */
async function shareEntry(entry) {
  const lines = [
    `${formatDate(entry.createdAt)} · ${entry.categoryLabel}${entry.title && entry.title !== entry.categoryLabel ? ` · ${entry.title}` : ''}`,
  ];
  lines.push(...sessionLines(entry));
  if (entry.elapsedMs) lines.push(`Worked: ${formatDuration(entry.elapsedMs)}`);
  if (entry.rating) lines.push(`Rating: ${'★'.repeat(entry.rating)}${'☆'.repeat(5 - entry.rating)}`);
  if (entry.notes) lines.push('', entry.notes);
  const shared = await shareText(`Session: ${entry.title || entry.categoryLabel}`, lines.join('\n'));
  if (shared && entry.audio?.blob) showToast('Text sent. Tap "Share clip" to send the recording too.', 5000);
}

/** Share only the recording of a logged session, as a file. */
async function shareEntryClip(entry) {
  if (!entry.audio?.blob || typeof File === 'undefined') return;
  const file = new File([entry.audio.blob], entry.audio.name || 'session-audio', {
    type: entry.audio.type || entry.audio.blob.type,
  });
  if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
    // No file sharing here: hand the clip over as a download instead.
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('Sharing files is not available here, so the clip was downloaded.', 4000);
    return;
  }
  try {
    await navigator.share({ files: [file], title: file.name });
  } catch (err) {
    if (err?.name !== 'AbortError') showToast('Could not share the clip.');
  }
}

function rerollTempo() {
  const r = state.result;
  if (!r?.tempoText || r.selections?.startPoint === 'bpmsig') return;
  let tempo = pickTempo(state.settings, state.settings.weights);
  for (let i = 0; i < 10 && tempo.bpm === r.bpm && tempo.timeSig === r.timeSig; i++) {
    tempo = pickTempo(state.settings, state.settings.weights);
  }
  setResultTempo(tempo.bpm, tempo.timeSig);
}

function rerollKey() {
  const r = state.result;
  if (!r?.keyText) return;
  const key = pickKey(state.settings.weights, Math.random, r.key?.scale);
  const detail = (r.detail || []).filter((d) => d !== r.keyText);
  state.result = { ...r, key: { root: key.root, scale: key.scale }, keyText: key.text, detail: [...detail, key.text] };
  persistSession();
  render();
}

function toggleMetronome() {
  const r = state.result;
  if (!r?.bpm) return;
  if (state.metronomeOn) {
    stopMetronome();
    setMetronomePreference(false);
  } else {
    state.metronomeOn = metronome.start(r.bpm, beatsPerBar(r.timeSig));
    if (!state.metronomeOn) showToast('Audio is not available here.');
    else setMetronomePreference(true);
  }
  render();
}

/** Ask for the microphone once and report whether recording would work. */
async function testMicrophone() {
  const env = { standalone: isStandaloneIOS(), secure: window.isSecureContext !== false };
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast(describeMediaError(null, { ...env, supported: false }), 6000);
    return;
  }
  stopMetronome();
  prepareCapture();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const label = stream.getAudioTracks()[0]?.label || 'microphone';
    stream.getTracks().forEach((t) => t.stop());
    const type = pickRecordingType();
    showToast(
      type === null || type === undefined
        ? 'Microphone works, but this browser cannot record audio.'
        : `Microphone works: ${label}. Format: ${type || 'browser default'}.`,
      5000,
    );
  } catch (err) {
    showToast(describeMediaError(err, env), 7000);
  } finally {
    releaseCapture();
  }
}

/** Swap the effects twist for another effect that fits, keeping everything else. */
function rerollTwist() {
  const r = state.result;
  if (!r) return;
  const decisions = currentDecisions();
  const fx = findDecision(decisions, FX_DECISION);
  const current = r.selections?.[FX_DECISION];
  const used = new Set([r.selections?.[DEVICE_DECISION], r.selections?.[SOFTWARE_DECISION], current]);
  const candidates = (fx?.options || []).filter((o) => o.id !== FX_NONE && !used.has(o.id));
  const pick =
    weightedPick(candidates, (o) => optionWeight(fx, o, state.settings.weights)) || weightedPick(candidates, () => 1);
  if (!pick) {
    showToast('No other effect to twist with. Add more in Settings.');
    return;
  }
  state.result = {
    ...r,
    selections: { ...r.selections, [FX_DECISION]: pick.id },
    twist: `Twist: run something through the ${pick.label}.`,
  };
  persistSession();
  render();
}

async function exportBackup() {
  const entries = state.journal.loaded ? state.journal.entries : await listEntries().catch(() => []);
  const backup = makeBackup(state.settings, entries);
  downloadJson(`session-prompter-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
  showToast('Backup downloaded (audio clips are not included)');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const parsed = parseBackup(JSON.parse(await file.text()));
    const parts = [];
    if (parsed.settings) parts.push('replace your settings, hardware, software and tracks');
    if (parsed.journal.length) parts.push(`add ${parsed.journal.length} journal entries that are not already here`);
    if (!parts.length) throw new Error('Nothing to import');
    if (!window.confirm(`This will ${parts.join(' and ')}. Continue?`)) return;
    if (parsed.settings) {
      state.settings = normalizeSettings(parsed.settings);
      persistSettings();
      state.locks = pruneLocks(currentDecisions(), state.locks);
      setRigConstraints(state.rigConstraints);
      persistSession();
    }
    let added = 0;
    if (parsed.journal.length) {
      const existing = new Set((await listEntries()).map((e) => e.id));
      for (const entry of parsed.journal) {
        if (existing.has(entry.id)) continue;
        await putEntry(entry);
        added++;
      }
      await loadJournal();
    }
    render();
    showToast(`Imported${parsed.settings ? ' settings' : ''}${added ? ` and ${added} sessions` : ''}`);
  } catch (err) {
    showToast(`Import failed: ${err?.message || 'invalid file'}`);
  }
}

// ---------- rendering ----------

function render() {
  const timerStatus = timer.state.status;
  // Keep collapsible panels open across re-renders.
  const openPanels = new Set([...root.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key));
  const tabs = [
    ['session', 'Session', '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'],
    [
      'journal',
      'Journal',
      '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="16" y2="7"/><line x1="9" y1="11" x2="14" y2="11"/>',
    ],
    [
      'settings',
      'Settings',
      '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    ],
  ];
  root.innerHTML = `
    <header class="topbar">
      <h1>Session Prompter</h1>
      ${timerStatus !== 'idle' ? `<button class="timer-pill ${timerStatus}" data-action="go-timer" aria-label="Show timer">${timerStatus === 'done' ? 'Done' : '⏱'} <span class="pill-clock">${formatClock(timer.remainingMs)}</span></button>` : renderLengthControl()}
    </header>
    <main class="view">
      ${state.view === 'settings' ? renderSettings() : state.view === 'journal' ? renderJournal() : renderSessionView()}
    </main>
    <nav class="tabbar" aria-label="Main">
      <div class="tabbar-inner">
        ${tabs
          .map(
            ([id, label, icon]) => `
        <button class="tab ${state.view === id ? 'active' : ''}" data-action="view" data-view="${id}" aria-current="${state.view === id ? 'page' : 'false'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
          ${label}
        </button>`,
          )
          .join('')}
      </div>
    </nav>
  `;
  for (const d of root.querySelectorAll('details[data-key]')) if (openPanels.has(d.dataset.key)) d.open = true;
  renderToast();
  updateTimerDisplay();
}

function renderSessionView() {
  const parts = [];
  if (state.logDraft && !state.logDraft.entryId) parts.push(renderLogForm(state.logDraft));
  if (timer.state.status !== 'idle') parts.push(renderTimerCard());
  parts.push(state.result ? renderResult() : renderIntro());
  parts.push(renderBuilder());
  return parts.join('');
}

function renderIntro() {
  return `
    <section class="card">
      <p class="eyebrow">Ready when you are</p>
      <h2>What are you making today?</h2>
      <p class="muted">Lock in the parts you already know, leave the rest on Random, and let the app decide. Then start the ${state.settings.timer.minutes}-minute timer and go.</p>
    </section>
  `;
}

function renderResult() {
  const r = state.result;
  const decisions = currentDecisions();
  const tags = [];
  for (const decision of decisions) {
    const value = r.selections?.[decision.id];
    if (value === undefined) continue;
    if (decision.id === 'category') continue;
    if (decision.id === FX_DECISION && value === FX_NONE) continue;
    const option = decision.options.find((o) => o.id === value);
    if (!option) continue;
    tags.push(
      `<li class="chip tag ${r.locked?.[decision.id] ? 'locked' : ''}" title="${r.locked?.[decision.id] ? 'Your choice' : 'Rolled'}">${r.locked?.[decision.id] ? '🔒 ' : ''}${esc(option.label)}</li>`,
    );
  }
  if (r.bpm) tags.push(`<li class="chip tag">${r.bpm} BPM</li>`);
  if (r.rigLabel) tags.push(`<li class="chip tag">${esc(r.rigLabel)}</li>`);
  const minutes = sessionMinutes();
  const timerIdle = timer.state.status === 'idle';
  const previous = lastLogged(r.title);
  const canRerollTempo = r.tempoText && r.selections?.startPoint !== 'bpmsig';
  return `
    <section class="card result">
      <p class="eyebrow">${esc(r.categoryLabel)} · ${esc(r.title)}</p>
      <h2 class="prompt">${esc(r.prompt)}</h2>
      ${r.rig?.length ? `<p class="rig-line">Rig: ${esc(r.rigLabel)} <button type="button" class="link" data-action="new-rig" aria-label="Pick a different rig">↻ different rig</button></p>` : ''}
      ${r.rigNotice ? `<p class="notice">${esc(r.rigNotice)} Open "Rig constraints" below to loosen them.</p>` : ''}
      ${r.routingText ? `<p class="routing">Routing: ${esc(r.routingText)} <button type="button" class="link" data-action="new-routing" aria-label="Pick a different routing">↻ different routing</button></p>` : ''}
      ${
        r.tempoText
          ? `<p class="tempo">Tempo: ${esc(r.tempoText)} ${canRerollTempo ? `<button type="button" class="link" data-action="new-tempo" aria-label="Pick a different tempo">↻ different tempo</button>` : ''} <button type="button" class="link tap ${state.tapTimes.length ? 'active' : ''}" data-action="tap-tempo" aria-label="Tap a tempo">tap</button> <button type="button" class="link metro ${state.metronomeOn ? 'on' : ''}" data-action="metronome" aria-pressed="${state.metronomeOn}">${state.metronomeOn ? '■ stop click' : '▶ click'}</button></p>
             ${state.metronomeOn ? `<label class="slider-row inline metro-volume"><span>Volume</span><input type="range" min="0" max="10" step="1" value="${state.settings.metronome.volume}" data-action="metro-volume" aria-label="Metronome volume"><output>${state.settings.metronome.volume * 10}%</output></label>` : ''}`
          : ''
      }
      ${r.keyText ? `<p class="key">Key: ${esc(r.keyText)} <button type="button" class="link" data-action="new-key" aria-label="Pick a different key">↻ different key</button></p>` : ''}
      ${r.twist ? `<p class="twist">${esc(r.twist)} <button type="button" class="link" data-action="new-twist" aria-label="Pick a different effect">↻ different twist</button></p>` : ''}
      ${r.constraint ? `<p class="constraint">Constraint: ${esc(r.constraint)} <button type="button" class="link" data-action="new-constraint" aria-label="Pick a different rule">↻ different rule</button></p>` : ''}
      <ul class="chips">${tags.join('')}</ul>
      ${previous ? `<p class="last-done">Last ${esc(r.title.toLowerCase())} session: ${timeAgo(previous.createdAt)}.</p>` : ''}
      ${r.conflicts?.length ? `<p class="notice">${r.conflicts.map(esc).join('<br>')}</p>` : ''}
      <div class="btn-row">
        ${timerIdle ? `<button class="btn primary" data-action="start-timer">Start ${minutes} min session</button>` : ''}
        <button class="btn" data-action="generate">🎲 Reroll</button>
        <button class="btn" data-action="share" aria-label="Share this session">Share</button>
      </div>
      ${timerIdle && !state.logDraft ? `<div class="btn-row"><button class="btn ghost" data-action="log-session">Log this session without the timer</button></div>` : ''}
    </section>
  `;
}

function renderTimerCard() {
  const t = timer.state;
  const status = t.status;
  const label = status === 'done' ? "Time's up" : status === 'paused' ? 'Paused' : 'Remaining';
  const promptText = state.result?.prompt ?? 'Focused session';
  const buttons = [];
  if (status === 'running') buttons.push(`<button class="btn" data-action="pause">Pause</button>`);
  if (status === 'paused') buttons.push(`<button class="btn primary" data-action="resume">Resume</button>`);
  if (status === 'done') {
    buttons.push(`<button class="btn primary" data-action="log-timer">Log session</button>`);
    buttons.push(`<button class="btn" data-action="extend">+10 min</button>`);
    buttons.push(`<button class="btn" data-action="next-session">New session</button>`);
    buttons.push(`<button class="btn ghost" data-action="reset-timer">Dismiss</button>`);
  } else {
    buttons.push(`<button class="btn" data-action="extend">+10 min</button>`);
    buttons.push(`<button class="btn ghost danger" data-action="log-timer">End &amp; log</button>`);
  }
  return `
    <section class="card timer-card ${status}" aria-live="polite">
      <div class="timer-ring">
        <svg viewBox="0 0 220 220" aria-hidden="true">
          <circle class="track" cx="110" cy="110" r="${RING_RADIUS}"></circle>
          <circle class="progress" cx="110" cy="110" r="${RING_RADIUS}" stroke-dasharray="${RING_LENGTH}" stroke-dashoffset="0"></circle>
        </svg>
        <div class="timer-clock"><span class="clock">${formatClock(timer.remainingMs)}</span><small>${label}</small></div>
      </div>
      <p class="timer-prompt">${status === 'done' ? 'Session complete. Log it while it is fresh.' : esc(promptText)}</p>
      <div class="btn-row">${buttons.join('')}</div>
    </section>
  `;
}

function updateTimerDisplay() {
  const remaining = timer.remainingMs;
  const clock = formatClock(remaining);
  const clockEl = document.querySelector('.timer-clock .clock');
  if (clockEl) clockEl.textContent = clock;
  const pill = document.querySelector('.pill-clock');
  if (pill) pill.textContent = clock;
  const progress = document.querySelector('.timer-ring .progress');
  if (progress) {
    const duration = timer.state.durationMs || 1;
    const fraction = Math.min(1, Math.max(0, remaining / duration));
    progress.style.strokeDashoffset = String(RING_LENGTH * (1 - fraction));
  }
  const status = timer.state.status;
  document.title =
    status === 'running' || status === 'paused'
      ? `${clock} · Session Prompter`
      : status === 'done'
        ? "Time's up · Session Prompter"
        : 'Session Prompter';
}

function renderBuilder() {
  const decisions = currentDecisions();
  const rows = [];
  const hints = {
    [DEVICE_DECISION]: 'from your hardware list',
    [SOFTWARE_DECISION]: 'from your software list',
    [TRACK_DECISION]: 'from your track list',
    [FX_DECISION]: 'optional',
  };
  for (const decision of decisions) {
    if (!isApplicable(decision, state.locks)) continue;
    const others = { ...state.locks };
    delete others[decision.id];
    const locked = state.locks[decision.id];
    const chips = [
      `<button type="button" class="chip random ${locked === undefined ? 'active' : ''}" data-action="lock" data-decision="${decision.id}" data-option="">🎲 Random</button>`,
    ];
    for (const option of decision.options) {
      const compatible = isCompatible(decisions, decision, option, others);
      const zeroWeight = optionWeight(decision, option, state.settings.weights) === 0;
      chips.push(
        `<button type="button" class="chip ${locked === option.id ? 'active' : ''}" data-action="lock" data-decision="${decision.id}" data-option="${esc(option.id)}" ${compatible ? '' : 'disabled'} ${zeroWeight && compatible ? 'title="Weight is 0, only picked when you lock it"' : ''}>${esc(option.label)}</button>`,
      );
    }
    const hint = hints[decision.id] || '';
    rows.push(`
      <div class="row">
        <div class="row-label"><span>${esc(decision.label)}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>
        <div class="chips">${chips.join('')}</div>
      </div>
    `);
  }
  const hasLocks = Object.keys(state.locks).length > 0;
  return `
    <section class="card builder">
      <h2>${state.result ? 'Adjust and reroll' : 'Build your session'}</h2>
      <p class="muted">Lock what you want. Everything left on Random gets rolled with your weights.</p>
      ${rows.join('')}
      ${renderRigPanel()}
      <div class="field toggle-row">
        <span class="label">Creative constraint<span class="sub">Add one extra rule to this session</span></span>
        <label class="switch"><input type="checkbox" data-action="toggle-constraints" ${state.settings.constraints.enabled ? 'checked' : ''} aria-label="Add a creative constraint"><span></span></label>
      </div>
      <div class="field">
        <span class="label">Tempo &amp; meter<span class="sub">A BPM and time signature for jams and loops</span></span>
        <label class="switch"><input type="checkbox" data-action="toggle-tempo" ${state.settings.music.tempo ? 'checked' : ''} aria-label="Add a tempo and meter"><span></span></label>
      </div>
      <div class="field">
        <span class="label">Key &amp; scale<span class="sub">A root and scale for jams and loops</span></span>
        <label class="switch"><input type="checkbox" data-action="toggle-key" ${state.settings.music.key ? 'checked' : ''} aria-label="Add a key and scale"><span></span></label>
      </div>
      <div class="btn-row">
        <button class="btn primary big" data-action="generate">${state.result ? 'Roll again' : 'Generate session'}</button>
      </div>
      ${hasLocks ? `<div class="btn-row"><button class="btn ghost" data-action="clear-locks">Clear my choices</button></div>` : ''}
    </section>
  `;
}

/** Header control: the next session's length, five minutes at a time. One-off; Settings keeps the default. */
function renderLengthControl() {
  const minutes = sessionMinutes();
  const isDefault = state.sessionMinutes === null;
  return `
    <div class="length-control" role="group" aria-label="Session length">
      <button type="button" data-action="length-step" data-delta="-5" aria-label="Five minutes shorter" ${minutes <= 5 ? 'disabled' : ''}>−</button>
      <button type="button" class="length-value ${isDefault ? '' : 'override'}" data-action="length-default" aria-label="${isDefault ? `Session length ${minutes} minutes (default)` : `Session length ${minutes} minutes for this session, tap to use the default ${state.settings.timer.minutes}`}" ${isDefault ? 'disabled' : ''}>${minutes} min${isDefault ? '' : ' •'}</button>
      <button type="button" data-action="length-step" data-delta="5" aria-label="Five minutes longer" ${minutes >= 240 ? 'disabled' : ''}>+</button>
    </div>
  `;
}

// ---------- jam rig constraints (per session) ----------

function numberSelect(attrs, current, from, to) {
  return `<select ${attrs}>${Array.from({ length: to - from + 1 }, (_, i) => from + i)
    .map((n) => `<option value="${n}" ${current === n ? 'selected' : ''}>${n}</option>`)
    .join('')}</select>`;
}

function renderRigPanel() {
  const hardware = jamDevices(state.settings.hardware);
  if (!hardware.length) return '';
  const c = state.rigConstraints;
  const matches = enumerateRigs(state.settings.hardware, c).length;
  const ownedTypes = DEVICE_TYPE_IDS.filter((t) => hardware.some((d) => d.type === t));
  const sizeRow = `
    <div class="field">
      <span class="label">Devices per jam<span class="sub">Fewest to most</span></span>
      <span class="range-pair">${numberSelect(`data-action="rigc-size" data-key="min" aria-label="Fewest devices"`, c.min, 1, RIG_MAX_SIZE)}<span class="muted">to</span>${numberSelect(`data-action="rigc-size" data-key="max" aria-label="Most devices"`, c.max, 1, RIG_MAX_SIZE)}</span>
    </div>`;
  const typeRows = ownedTypes
    .map((t) => {
      const lim = c.perType[t] || { min: 0, max: RIG_MAX_SIZE };
      return `
      <div class="field">
        <span class="label">${esc(DEVICE_TYPES[t].label)}<span class="sub">${hardware.filter((d) => d.type === t).length} owned</span></span>
        <span class="range-pair">${numberSelect(`data-action="rigc-type" data-type="${t}" data-key="min" aria-label="Fewest ${esc(DEVICE_TYPES[t].label)}"`, lim.min, 0, RIG_MAX_SIZE)}<span class="muted">to</span>${numberSelect(`data-action="rigc-type" data-type="${t}" data-key="max" aria-label="Most ${esc(DEVICE_TYPES[t].label)}"`, lim.max, 0, RIG_MAX_SIZE)}</span>
      </div>`;
    })
    .join('');
  const deviceChips = hardware
    .map((d) => {
      const mode = c.must.includes(d.id) ? 'must' : c.never.includes(d.id) ? 'never' : 'any';
      const label = mode === 'must' ? '✓ ' : mode === 'never' ? '✕ ' : '';
      return `<button type="button" class="chip tri ${mode}" data-action="rigc-device" data-id="${d.id}" aria-label="${esc(d.name)}: ${mode === 'any' ? 'may be used' : mode === 'must' ? 'must be used' : 'never used'}">${label}${esc(d.name)}</button>`;
    })
    .join('');
  const mustInstruments = hardware.filter((d) => c.must.includes(d.id) && ROLE_OF(d) === 'instrument');
  const pinRows = hardware
    .filter((d) => c.must.includes(d.id) && ROLE_OF(d) === 'fx')
    .map((fx) => {
      const value = c.pins[fx.id] || RANDOM_ROUTE;
      return `
      <div class="field">
        <span class="label">${esc(fx.name)}<span class="sub">goes on</span></span>
        <select data-action="rigc-pin" data-fx="${fx.id}" aria-label="Where ${esc(fx.name)} goes">
          <option value="${RANDOM_ROUTE}" ${value === RANDOM_ROUTE ? 'selected' : ''}>Rolled each time</option>
          <option value="${SEND}" ${value === SEND ? 'selected' : ''}>A send channel</option>
          ${mustInstruments.map((d) => `<option value="${d.id}" ${value === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
      </div>`;
    })
    .join('');
  const presets = state.settings.rigPresets
    .map(
      (p) =>
        `<span class="preset"><button type="button" class="chip" data-action="rigc-preset" data-id="${p.id}">${esc(p.name)}</button><button type="button" class="preset-x" data-action="rigc-preset-remove" data-id="${p.id}" aria-label="Remove preset ${esc(p.name)}">×</button></span>`,
    )
    .join('');
  return `
    <details class="rig-panel" data-key="rigpanel">
      <summary>
        <span class="row-label"><span>Rig constraints</span><span class="hint">synth jams</span></span>
        <span class="summary-line">${esc(summarizeConstraints(c))} · <strong class="${matches ? '' : 'error'}">${matches} rig${matches === 1 ? '' : 's'} fit</strong></span>
      </summary>
      <p class="muted">Starts from your Settings defaults. Tighten it for this session: tap a device once to require it, twice to rule it out.</p>
      ${presets ? `<div class="presets">${presets}</div>` : ''}
      ${sizeRow}
      <h3>Per type</h3>
      ${typeRows}
      <label class="slider-row">
        <span>Send chance</span>
        <input type="range" min="0" max="10" step="1" value="${c.sendChance}" data-action="rigc-send" aria-label="Chance an effect lands on a send">
        <output>${c.sendChance * 10}%</output>
      </label>
      <h3>Devices<span class="path">tap: any → must → never</span></h3>
      <div class="chips">${deviceChips}</div>
      ${pinRows ? `<h3>Pinned routing</h3>${pinRows}` : ''}
      ${matches ? '' : `<p class="notice">No rig can satisfy these constraints. Loosen the counts or the device rules.</p>`}
      <div class="btn-row">
        <button type="button" class="btn ghost" data-action="rigc-reset">Back to defaults</button>
        <button type="button" class="btn ghost" data-action="rigc-preset-save">Save as preset</button>
      </div>
    </details>
  `;
}

// ---------- logging a session ----------

function renderLogForm(d) {
  const s = d.session;
  const rec = state.recording;
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
  const url = d.audio?.blob ? audioUrl(d.entryId || 'draft', d.audio.blob) : null;
  const meta = [];
  if (d.elapsedMs) meta.push(`<span>⏱ ${formatDuration(d.elapsedMs)} worked</span>`);
  if (d.plannedMs) meta.push(`<span>${formatDuration(d.plannedMs)} planned</span>`);
  if (d.createdAt) meta.push(`<span>${formatDate(d.createdAt)}</span>`);
  return `
    <section class="card log-form">
      <p class="eyebrow">${d.entryId ? 'Edit session' : 'Log this session'}</p>
      <p class="summary">${esc(s.prompt)}</p>
      ${s.routingText ? `<p class="routing">Routing: ${esc(s.routingText)}</p>` : ''}
      ${s.tempoText ? `<p class="tempo">Tempo: ${esc(s.tempoText)}</p>` : ''}
      ${s.keyText ? `<p class="key">Key: ${esc(s.keyText)}</p>` : ''}
      ${s.constraint ? `<p class="constraint">Constraint: ${esc(s.constraint)}</p>` : ''}
      ${meta.length ? `<p class="meta">${meta.join('')}</p>` : ''}
      <label class="block">How did it go?</label>
      ${renderStars(d.rating, true)}
      <label class="block" for="log-notes">Notes on what you made</label>
      <textarea id="log-notes" data-action="draft-notes" placeholder="What came out of it? Where did you save it? What is worth coming back to?">${esc(d.notes)}</textarea>
      <label class="block">Audio of the result (optional)</label>
      <div class="audio-box">
        ${
          rec
            ? `<div class="audio-actions">
                 <span class="recording">● Recording <span class="rec-clock">00:00</span></span>
                 <button class="btn primary" data-action="stop-recording">Stop</button>
                 <button class="btn ghost" data-action="cancel-recording">Cancel</button>
               </div>`
            : `<div class="audio-actions">
                 <label class="btn file-btn">Choose file<input type="file" accept="audio/*" data-action="draft-audio-file"></label>
                 ${canRecord ? `<button class="btn" data-action="start-recording">Record</button>` : ''}
                 ${d.audio ? `<button class="btn ghost danger" data-action="draft-audio-remove">Remove</button>` : ''}
               </div>`
        }
        ${url ? `<audio controls preload="metadata" src="${url}"></audio>` : ''}
        ${d.audio ? `<p class="file-meta">${esc(d.audio.name)}${d.audio.size ? ` · ${formatBytes(d.audio.size)}` : ''}${d.audio.omitted ? ' · not included in this backup' : ''}</p>` : `<p class="file-meta">Pick a bounce from Files or Voice Memos, or record straight from the mic.</p>`}
      </div>
      <div class="btn-row">
        <button class="btn primary" data-action="save-log">${d.entryId ? 'Save changes' : 'Save to journal'}</button>
        <button class="btn ghost" data-action="discard-log">${d.entryId ? 'Cancel' : 'Discard'}</button>
      </div>
    </section>
  `;
}

const RATING_LABELS = ['', 'Rough', 'Meh', 'Solid', 'Good', 'Keeper'];

function renderStars(rating, interactive) {
  const stars = [1, 2, 3, 4, 5]
    .map((n) =>
      interactive
        ? `<button type="button" class="star ${rating >= n ? 'on' : ''}" data-action="rate" data-value="${n}" aria-label="${n} star${n > 1 ? 's' : ''}" aria-pressed="${rating === n}">★</button>`
        : `<span class="star ${rating >= n ? 'on' : ''}">★</span>`,
    )
    .join('');
  const label = rating ? RATING_LABELS[rating] : interactive ? 'Tap to rate' : '';
  return `<div class="stars ${interactive ? 'interactive' : ''}" role="${interactive ? 'group' : 'img'}" aria-label="${rating ? `${rating} out of 5` : 'Not rated'}">${stars}${label ? `<span class="star-label">${label}</span>` : ''}</div>`;
}

// ---------- journal view ----------

function renderJournal() {
  const j = state.journal;
  if (!j.loaded) return `<section class="card"><p class="muted">Loading your journal…</p></section>`;
  if (j.error)
    return `<section class="card"><h2>Journal</h2><p class="muted error">${esc(j.error)}. Private browsing on iOS can block storage; try the installed app instead.</p></section>`;
  const stats = summarize(j.entries);
  const categories = Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]);
  const f = state.journalFilter;
  const shown = filterEntries(j.entries, f);
  const filtering = f.type || f.minRating || f.query.trim();
  const summary = `
    <section class="card">
      <h2>Journal</h2>
      <p class="muted">Every session you logged, newest first. Notes and clips stay on this device.</p>
      <div class="stats">
        <div class="stat"><div class="value">${stats.count}</div><div class="label">Sessions</div></div>
        <div class="stat"><div class="value">${esc(formatDuration(stats.totalMs))}</div><div class="label">Time logged</div></div>
        ${stats.avgRating ? `<div class="stat"><div class="value">★ ${stats.avgRating.toFixed(1)}</div><div class="label">Avg rating · ${stats.ratedCount} rated</div></div>` : ''}
      </div>
      ${
        categories.length
          ? `<ul class="cat-list">${categories
              .map(
                ([name, count]) =>
                  `<li><span>${esc(name)} · ${count}</span><span>last ${timeAgo(stats.lastByCategory[name])}</span></li>`,
              )
              .join('')}</ul>`
          : ''
      }
    </section>
  `;
  if (!j.entries.length) {
    return `${summary}<section class="card"><p class="muted">No sessions logged yet. Finish a session and tap "Log session", or use "Log this session" on a generated prompt.</p></section>`;
  }
  const filters = `
    <section class="card filters">
      <input type="search" value="${esc(f.query)}" placeholder="Search notes, prompts, gear…" data-action="jf-query" aria-label="Search the journal" autocomplete="off">
      <div class="chips">
        <button type="button" class="chip ${f.type ? '' : 'active'}" data-action="jf-type" data-type="">All types</button>
        ${categories.map(([name]) => `<button type="button" class="chip ${f.type === name ? 'active' : ''}" data-action="jf-type" data-type="${esc(name)}">${esc(name)}</button>`).join('')}
      </div>
      <div class="chips">
        ${[
          [0, 'Any rating'],
          [3, '★ 3+'],
          [4, '★ 4+'],
          [5, 'Keepers only'],
        ]
          .map(
            ([n, label]) =>
              `<button type="button" class="chip ${f.minRating === n ? 'active' : ''}" data-action="jf-rating" data-min="${n}">${label}</button>`,
          )
          .join('')}
      </div>
      ${filtering ? `<p class="muted">Showing ${shown.length} of ${j.entries.length}. <button type="button" class="link" data-action="jf-clear">Clear filters</button></p>` : ''}
    </section>
  `;
  const list = shown.length
    ? shown.map((e) => (state.logDraft?.entryId === e.id ? renderLogForm(state.logDraft) : renderEntry(e))).join('')
    : `<section class="card"><p class="muted">Nothing matches these filters.</p></section>`;
  return summary + filters + list;
}

function renderEntry(e) {
  const url = e.audio?.blob ? audioUrl(e.id, e.audio.blob) : null;
  const chips = (e.detail || []).map((d) => `<li class="chip tag">${esc(d)}</li>`);
  if (e.elapsedMs) chips.push(`<li class="chip tag">⏱ ${esc(formatDuration(e.elapsedMs))}</li>`);
  return `
    <article class="card entry" data-id="${e.id}">
      <p class="when">${esc(formatDate(e.createdAt))} · ${esc(timeAgo(e.createdAt))}</p>
      <p class="eyebrow">${esc(e.categoryLabel)}${e.title && e.title !== e.categoryLabel ? ` · ${esc(e.title)}` : ''}</p>
      <p class="prompt">${esc(e.prompt)}</p>
      ${e.routingText ? `<p class="routing">Routing: ${esc(e.routingText)}</p>` : ''}
      ${e.tempoText ? `<p class="tempo">Tempo: ${esc(e.tempoText)}</p>` : ''}
      ${e.keyText ? `<p class="key">Key: ${esc(e.keyText)}</p>` : ''}
      ${e.twist ? `<p class="twist">${esc(e.twist)}</p>` : ''}
      ${e.constraint ? `<p class="constraint">Constraint: ${esc(e.constraint)}</p>` : ''}
      <ul class="chips">${chips.join('')}</ul>
      ${e.rating ? renderStars(e.rating, false) : ''}
      ${e.notes ? `<p class="notes">${esc(e.notes)}</p>` : `<p class="notes muted">No notes.</p>`}
      ${url ? `<audio controls preload="metadata" src="${url}"></audio>` : ''}
      ${e.audio && !url ? `<p class="file-meta muted">Clip "${esc(e.audio.name)}" was not restored with this backup.</p>` : ''}
      <div class="btn-row">
        <button class="btn" data-action="edit-entry" data-id="${e.id}">Edit</button>
        <button class="btn" data-action="share-entry" data-id="${e.id}" aria-label="Share this entry as text">Share</button>
        ${e.audio?.blob ? `<button class="btn" data-action="share-clip" data-id="${e.id}" aria-label="Share the recording">Share clip</button>` : ''}
        <button class="btn" data-action="roll-like" data-id="${e.id}">Roll this again</button>
        <button class="btn ghost danger" data-action="delete-entry" data-id="${e.id}">Delete</button>
      </div>
    </article>
  `;
}

// ---------- settings ----------

function percentLabels(decision) {
  const total = decision.options.reduce((sum, o) => sum + optionWeight(decision, o, state.settings.weights), 0);
  return Object.fromEntries(
    decision.options.map((o) => {
      const w = optionWeight(decision, o, state.settings.weights);
      return [o.id, total > 0 ? `${Math.round((w / total) * 100)}%` : '–'];
    }),
  );
}

function renderGearSection(kind) {
  const s = state.settings;
  const items = s[kind];
  const isHardware = kind === 'hardware';
  const list = items.length
    ? `<ul class="list">${items
        .map(
          (h) => `
        <li data-id="${h.id}">
          <span class="name">${esc(h.name)}</span>
          <button class="delete" data-action="remove-gear" data-kind="${kind}" data-id="${h.id}" aria-label="Remove ${esc(h.name)}">Remove</button>
          <div class="controls">
            <select data-action="gear-type" data-kind="${kind}" data-id="${h.id}" aria-label="Type of ${esc(h.name)}">
              ${DEVICE_TYPE_IDS.map((t) => `<option value="${t}" ${h.type === t ? 'selected' : ''}>${DEVICE_TYPES[t].label}</option>`).join('')}
            </select>
            <label class="slider-row inline">
              <span>Weight</span>
              <input type="range" min="0" max="10" step="1" value="${h.weight}" data-action="gear-weight" data-kind="${kind}" data-id="${h.id}" aria-label="Weight of ${esc(h.name)}">
              <output>${h.weight}</output>
            </label>
          </div>
        </li>`,
        )
        .join('')}</ul>`
    : `<p class="empty">${isHardware ? 'No hardware yet. Prompts will just say "hardware" until you add some.' : 'No software yet. Prompts will just say "in the box" until you add some.'}</p>`;
  return `
    <section class="card">
      <h2>${isHardware ? 'Hardware' : 'Software'}</h2>
      <p class="muted">${
        isHardware
          ? 'List your gear and prompts will name it. The type decides where a device can show up: a drum machine gets drum loops and kits, keys get piano jams and chords, pedals design effect presets, join jam rigs and become optional twists.'
          : 'Instruments and plugins for "software" sessions. Same types as hardware: a drum plugin gets drum loops and kits, a synth gets pads and presets, effects become optional twists.'
      }</p>
      ${list}
      <form class="add-row" data-action="add-gear" data-kind="${kind}">
        <input type="text" name="name" placeholder="${isHardware ? 'e.g. Prophet-6' : 'e.g. Serum'}" maxlength="60" autocomplete="off" autocapitalize="words" aria-label="${isHardware ? 'Hardware' : 'Software'} name" required>
        <select name="type" aria-label="${isHardware ? 'Hardware' : 'Software'} type">
          ${DEVICE_TYPE_IDS.map((t) => `<option value="${t}">${DEVICE_TYPES[t].label}</option>`).join('')}
        </select>
        <button class="btn primary" type="submit">Add</button>
      </form>
    </section>
  `;
}

function renderRigSection() {
  const s = state.settings;
  const devices = jamDevices(s.hardware);
  if (!devices.length) {
    return `
    <section class="card">
      <h2>Jam rig defaults</h2>
      <p class="muted">Add hardware above and synth jams can suggest one device or a combination of them, with effects routed onto instruments or sends.</p>
    </section>`;
  }
  const ownedTypes = DEVICE_TYPE_IDS.filter((t) => devices.some((d) => d.type === t));
  const typeRows = ownedTypes
    .map((t) => {
      const lim = s.rigs.perType[t] || { min: 0, max: RIG_MAX_SIZE };
      return `
      <div class="field">
        <span class="label">${esc(DEVICE_TYPES[t].label)}<span class="sub">${devices.filter((d) => d.type === t).length} owned</span></span>
        <span class="range-pair">${numberSelect(`data-action="rig-type-limit" data-type="${t}" data-key="min" aria-label="Fewest ${esc(DEVICE_TYPES[t].label)} per rig"`, lim.min, 0, RIG_MAX_SIZE)}<span class="muted">to</span>${numberSelect(`data-action="rig-type-limit" data-type="${t}" data-key="max" aria-label="Most ${esc(DEVICE_TYPES[t].label)} per rig"`, lim.max, 0, RIG_MAX_SIZE)}</span>
      </div>`;
    })
    .join('');
  return `
    <section class="card">
      <h2>Jam rig defaults</h2>
      <p class="muted">The starting point for every session's rig constraints. Tighten them per session in the Session tab under "Rig constraints"; a rig is then generated to fit.</p>
      <div class="field">
        <span class="label">Devices per jam<span class="sub">Fewest to most</span></span>
        <span class="range-pair">${numberSelect(`data-action="rig-size" data-key="min" aria-label="Fewest devices per jam"`, s.rigs.min, 1, RIG_MAX_SIZE)}<span class="muted">to</span>${numberSelect(`data-action="rig-size" data-key="max" aria-label="Most devices per jam"`, s.rigs.max, 1, RIG_MAX_SIZE)}</span>
      </div>
      <h3>Per type<span class="path">how many of each in a rig</span></h3>
      ${typeRows}
      <h3>Effects routing</h3>
      <div class="field">
        <span class="label">Allow send channels<span class="sub">Otherwise effects always sit on one instrument</span></span>
        <label class="switch"><input type="checkbox" data-action="toggle-sends" ${s.rigs.sends.enabled ? 'checked' : ''} aria-label="Allow effects on send channels"><span></span></label>
      </div>
      ${
        s.rigs.sends.enabled
          ? `<label class="slider-row">
        <span>Send chance</span>
        <input type="range" min="0" max="10" step="1" value="${s.rigs.sends.chance}" data-action="send-chance" aria-label="Chance an effect lands on a send">
        <output>${s.rigs.sends.chance * 10}%</output>
      </label>`
          : ''
      }
      <div class="field">
        <span class="label">Grooveboxes can sequence<span class="sub">In a rig with other instruments, a groovebox is named as the sequencer</span></span>
        <label class="switch"><input type="checkbox" data-action="toggle-groovebox-seq" ${s.rigs.grooveboxSequences ? 'checked' : ''} aria-label="Grooveboxes act as sequencers"><span></span></label>
      </div>
      <div class="btn-row"><button class="btn ghost" data-action="rigc-reset">Apply defaults to the current session</button></div>
    </section>

    <section class="card">
      <h2>Gear rotation</h2>
      <p class="muted">Make gear, rigs, twists and constraints that showed up in your last few logged sessions less likely, so prompts spread across your setup.</p>
      <div class="field">
        <span class="label">Rotate</span>
        <label class="switch"><input type="checkbox" data-action="toggle-rotation" ${s.rotation.enabled ? 'checked' : ''} aria-label="Enable gear rotation"><span></span></label>
      </div>
      ${
        s.rotation.enabled
          ? `
      <div class="field">
        <label for="rotation-lookback">Look back<span class="sub">Logged sessions that count as recent</span></label>
        <input id="rotation-lookback" type="number" inputmode="numeric" min="1" max="20" value="${s.rotation.lookBack}" data-action="rotation-lookback">
      </div>
      <label class="slider-row">
        <span>Strength</span>
        <input type="range" min="0" max="10" step="1" value="${s.rotation.strength}" data-action="rotation-strength" aria-label="Rotation strength">
        <output>${s.rotation.strength === 10 ? 'almost never' : s.rotation.strength === 0 ? 'off' : `${100 - s.rotation.strength * 10}% as likely`}</output>
      </label>
      <div class="field">
        <span class="label">Also rotate constraints and twists</span>
        <label class="switch"><input type="checkbox" data-action="toggle-rotation-constraints" ${s.rotation.includeConstraints ? 'checked' : ''} aria-label="Rotate constraints and twists too"><span></span></label>
      </div>`
          : ''
      }
    </section>
  `;
}

function renderConstraintsSection() {
  const { disabled, custom } = state.settings.constraints;
  const off = new Set(disabled);
  const groups = Object.keys(SCOPES)
    .map((scope) => {
      const items = BUILT_IN_CONSTRAINTS.filter((c) => c.scope === scope);
      if (!items.length) return '';
      return `
        <h3>${esc(SCOPES[scope])}</h3>
        ${items
          .map(
            (c) => `
          <div class="field">
            <span class="label constraint-text">${esc(c.text)}</span>
            <label class="switch"><input type="checkbox" data-action="toggle-constraint" data-id="${c.id}" ${off.has(c.id) ? '' : 'checked'} aria-label="Enable: ${esc(c.text)}"><span></span></label>
          </div>`,
          )
          .join('')}`;
    })
    .join('');
  const customList = custom.length
    ? `<ul class="list">${custom
        .map(
          (c) => `
        <li data-id="${c.id}">
          <span class="name">${esc(c.text)}<span class="sub">${esc(SCOPES[c.scope] || 'Any session')}</span></span>
          <button class="delete" data-action="remove-constraint" data-id="${c.id}" aria-label="Remove constraint">Remove</button>
        </li>`,
        )
        .join('')}</ul>`
    : '';
  const enabledCount = BUILT_IN_CONSTRAINTS.length - disabled.length + custom.length;
  return `
    <section class="card">
      <h2>Creative constraints</h2>
      <p class="muted">Extra rules matched to what you are doing, ${enabledCount} active. Turn the "Creative constraint" switch on in the session builder to get one with each roll.</p>
      <h3>Your own</h3>
      ${customList || '<p class="empty">Add rules of your own below. They join the pool for the session type you pick.</p>'}
      <form class="add-row" data-action="add-constraint">
        <input type="text" name="text" placeholder="e.g. Only the white keys" maxlength="160" autocomplete="off" aria-label="Constraint text" required>
        <select name="scope" aria-label="Applies to">
          ${Object.entries(SCOPES)
            .map(([id, label]) => `<option value="${id}">${esc(label)}</option>`)
            .join('')}
        </select>
        <button class="btn primary" type="submit">Add</button>
      </form>
      <details class="built-ins" data-key="constraints">
        <summary>Built-in rules (${BUILT_IN_CONSTRAINTS.length})</summary>
        ${groups}
      </details>
    </section>
  `;
}

function renderSettings() {
  const s = state.settings;
  const decisions = currentDecisions();
  const fxDecision = findDecision(decisions, FX_DECISION);

  const weightGroups = STATIC_DECISIONS.map((decision) => {
    const pct = percentLabels(decision);
    const path = pathLabel(decisions, decision);
    return `
      <h3>${esc(decision.label)}${path ? `<span class="path">${esc(path)}</span>` : ''}</h3>
      ${decision.hint ? `<p class="muted">${esc(decision.hint)}</p>` : ''}
      ${decision.options
        .map(
          (o) => `
        <label class="slider-row">
          <span>${esc(o.label)}</span>
          <input type="range" min="0" max="10" step="1" value="${optionWeight(decision, o, s.weights)}" data-action="weight" data-decision="${decision.id}" data-option="${esc(o.id)}" aria-label="${esc(decision.label)}: ${esc(o.label)} weight">
          <output data-pct="${decision.id}:${esc(o.id)}">${pct[o.id]}</output>
        </label>`,
        )
        .join('')}
    `;
  }).join('');

  const fxGroup = fxDecision
    ? `
      <h3>Effects twist<span class="path">Assets · Tracks</span></h3>
      <p class="muted">How often a session gets an extra "run it through an effect" line. Raise "No twist" to make it rarer; each effect's own weight is set in its list.</p>
      <label class="slider-row">
        <span>No twist</span>
        <input type="range" min="0" max="10" step="1" value="${optionWeight(fxDecision, fxDecision.options[0], s.weights)}" data-action="weight" data-decision="${FX_DECISION}" data-option="${FX_NONE}" aria-label="No twist weight">
        <output data-pct="${FX_DECISION}:${FX_NONE}">${percentLabels(fxDecision)[FX_NONE]}</output>
      </label>`
    : '';

  const trackList = s.tracks.length
    ? `<ul class="list">${s.tracks
        .map(
          (t) => `
        <li data-id="${t.id}">
          <span class="name">${esc(t.name)}</span>
          <button class="delete" data-action="remove-track" data-id="${t.id}" aria-label="Remove ${esc(t.name)}">Remove</button>
        </li>`,
        )
        .join('')}</ul>`
    : `<p class="empty">No tracks listed. "Existing track" sessions will leave the pick to you.</p>`;

  return `
    <section class="card">
      <h2>Timer</h2>
      <div class="field">
        <label for="timer-minutes">Session length<span class="sub">Minutes per session</span></label>
        <input id="timer-minutes" type="number" inputmode="numeric" min="1" max="240" value="${s.timer.minutes}" data-action="timer-minutes">
      </div>
      <div class="presets">
        ${[25, 45, 60, 90].map((m) => `<button type="button" class="chip ${s.timer.minutes === m ? 'active' : ''}" data-action="timer-preset" data-minutes="${m}">${m} min</button>`).join('')}
      </div>
      <div class="field">
        <span class="label">Keep screen awake<span class="sub">So the chime can fire when the app is open</span></span>
        <label class="switch"><input type="checkbox" data-action="toggle-awake" ${s.timer.keepAwake ? 'checked' : ''} aria-label="Keep screen awake"><span></span></label>
      </div>
      <div class="field">
        <span class="label">Chime when time is up</span>
        <label class="switch"><input type="checkbox" data-action="toggle-chime" ${s.timer.chime ? 'checked' : ''} aria-label="Chime when time is up"><span></span></label>
      </div>
    </section>

    <section class="card">
      <h2>Sounds &amp; recording</h2>
      <label class="slider-row">
        <span>Metronome volume</span>
        <input type="range" min="0" max="10" step="1" value="${s.metronome.volume}" data-action="metro-volume" aria-label="Metronome volume">
        <output>${s.metronome.volume * 10}%</output>
      </label>
      <p class="muted">The click remembers whether you left it running and follows the tempo of each new roll.</p>
      <div class="btn-row"><button class="btn" data-action="test-mic">Test microphone</button></div>
      <p class="muted">Checks that this device can record for the journal. On iPhone the first tap asks for permission.</p>
    </section>

    ${renderGearSection('hardware')}
    ${renderGearSection('software')}

    <section class="card">
      <h2>Tracks in progress</h2>
      <p class="muted">Optional. When a session lands on "Existing track", one of these gets picked.</p>
      ${trackList}
      <form class="add-row" data-action="add-track">
        <input type="text" name="name" placeholder="Track name" maxlength="80" autocomplete="off" aria-label="Track name" required>
        <button class="btn primary" type="submit">Add</button>
      </form>
    </section>

    ${renderRigSection()}
    ${renderConstraintsSection()}

    <section class="card">
      <h2>Probabilities</h2>
      <p class="muted">Weights run from 0 to 10. The percentage is each option's chance within its group. 0 removes an option from the roll (you can still lock it by hand).</p>
      ${weightGroups}
      ${fxGroup}
      <h3>Scale<span class="path">Key &amp; scale switch · jams and loops</span></h3>
      <p class="muted">Any of the twelve roots is equally likely; these weights pick the scale.</p>
      ${SCALE_DECISION.options
        .map(
          (o) => `
        <label class="slider-row">
          <span>${esc(o.label)}</span>
          <input type="range" min="0" max="10" step="1" value="${scaleWeight(o, s.weights)}" data-action="weight" data-decision="${SCALE_DECISION.id}" data-option="${esc(o.id)}" aria-label="Scale: ${esc(o.label)} weight">
          <output data-pct="${SCALE_DECISION.id}:${esc(o.id)}">${scalePercent(o)}</output>
        </label>`,
        )
        .join('')}
      <h3>BPM range<span class="path">New track › BPM &amp; time signature</span></h3>
      <div class="field">
        <label for="bpm-min">Minimum BPM</label>
        <input id="bpm-min" type="number" inputmode="numeric" min="20" max="300" value="${s.bpm.min}" data-action="bpm-min">
      </div>
      <div class="field">
        <label for="bpm-max">Maximum BPM</label>
        <input id="bpm-max" type="number" inputmode="numeric" min="20" max="300" value="${s.bpm.max}" data-action="bpm-max">
      </div>
      <div class="btn-row"><button class="btn ghost" data-action="reset-weights">Reset probabilities to defaults</button></div>
    </section>

    <section class="card">
      <h2>Backup</h2>
      <p class="muted">Export your settings, gear lists, tracks and journal notes as a file you can move to another device. Audio clips are too large for the file and stay where they were recorded.</p>
      <div class="btn-row">
        <button class="btn" data-action="export-backup">Export backup</button>
        <label class="btn file-btn">Import backup<input type="file" accept="application/json,.json" data-action="import-backup"></label>
      </div>
    </section>

    <section class="card">
      <h2>Install on iPhone</h2>
      <ol class="steps">
        <li>Open this page in Safari.</li>
        <li>Tap the Share button, then "Add to Home Screen".</li>
        <li>Launch it from the home screen for a full-screen, offline-capable app.</li>
      </ol>
      <p class="muted">iOS pauses web apps in the background. Keep the app open (screen awake is on by default) if you want the chime at the end.</p>
    </section>

    <section class="card">
      <h2>About</h2>
      <div class="field">
        <span class="label">Version<span class="sub">Session Prompter ${esc(APP_VERSION)}</span></span>
        <button class="btn" data-action="check-update">Check for updates</button>
      </div>
      ${state.updateReady ? `<div class="btn-row"><button class="btn primary" data-action="apply-update">Update now</button></div>` : '<p class="muted">The app refreshes itself on the next open after a new release. If it looks stale, check here or close it fully and reopen.</p>'}
    </section>

    <section class="card">
      <h2>Danger zone</h2>
      <div class="btn-row">
        <button class="btn ghost danger" data-action="reset-all">Reset all settings</button>
        <button class="btn ghost danger" data-action="clear-journal">Delete the whole journal</button>
      </div>
    </section>
  `;
}

function scalePercent(option) {
  const total = SCALE_DECISION.options.reduce((sum, o) => sum + scaleWeight(o, state.settings.weights), 0);
  return total > 0 ? `${Math.round((scaleWeight(option, state.settings.weights) / total) * 100)}%` : '–';
}

function refreshPercentLabels(decisionId) {
  if (decisionId === SCALE_DECISION.id) {
    for (const o of SCALE_DECISION.options) {
      const out = document.querySelector(`output[data-pct="${SCALE_DECISION.id}:${o.id}"]`);
      if (out) out.textContent = scalePercent(o);
    }
    return;
  }
  const decision = findDecision(currentDecisions(), decisionId);
  if (!decision) return;
  const pct = percentLabels(decision);
  for (const [optionId, label] of Object.entries(pct)) {
    const out = document.querySelector(`output[data-pct="${decisionId}:${optionId}"]`);
    if (out) out.textContent = label;
  }
}

function setWeight(decisionId, optionId, value) {
  const weights = { ...state.settings.weights, [decisionId]: { ...(state.settings.weights[decisionId] || {}) } };
  weights[decisionId][optionId] = value;
  state.settings = { ...state.settings, weights };
  persistSettings();
  refreshPercentLabels(decisionId);
}

function updateGear(kind, id, patch) {
  state.settings = {
    ...state.settings,
    [kind]: state.settings[kind].map((h) => (h.id === id ? { ...h, ...patch } : h)),
  };
  persistSettings();
}

// ---------- events ----------

root.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || ['INPUT', 'SELECT', 'FORM', 'TEXTAREA'].includes(target.tagName)) return;
  const action = target.dataset.action;
  const entry = target.dataset.id ? state.journal.entries.find((e) => e.id === target.dataset.id) : null;
  switch (action) {
    case 'view':
      state.view = target.dataset.view;
      if (state.view !== 'session') stopMetronome();
      else syncMetronome();
      render();
      window.scrollTo({ top: 0 });
      break;
    case 'go-timer':
      state.view = 'session';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      break;
    case 'lock':
      setLock(target.dataset.decision, target.dataset.option);
      break;
    case 'generate':
      generate();
      break;
    case 'clear-locks':
      state.locks = {};
      persistSession();
      render();
      break;
    case 'start-timer':
      startTimer();
      break;
    case 'pause':
      timer.pause();
      break;
    case 'resume':
      timer.resume();
      break;
    case 'extend':
      timer.extend(10 * 60 * 1000);
      showToast('Added 10 minutes');
      break;
    case 'reset-timer':
      timer.reset();
      state.sessionMinutes = null;
      persistSession();
      render();
      break;
    case 'next-session':
      timer.reset();
      state.sessionMinutes = null;
      generate();
      break;
    case 'log-timer':
      openLogDraft({ fromTimer: true });
      break;
    case 'log-session':
      openLogDraft({ fromTimer: false });
      break;
    case 'save-log':
      saveLogDraft();
      break;
    case 'discard-log':
      discardLogDraft();
      break;
    case 'draft-audio-remove':
      if (state.logDraft) {
        state.logDraft.audio = null;
        dropAudioUrl(state.logDraft.entryId || 'draft');
        render();
      }
      break;
    case 'rate':
      if (state.logDraft) {
        const value = Number(target.dataset.value);
        state.logDraft.rating = state.logDraft.rating === value ? null : value;
        const form = target.closest('.log-form');
        const stars = form?.querySelector('.stars');
        if (stars) stars.outerHTML = renderStars(state.logDraft.rating, true);
      }
      break;
    case 'new-twist':
      rerollTwist();
      break;
    case 'new-routing':
      rerollRouting();
      break;
    case 'new-constraint':
      if (state.result) {
        const picked = pickConstraint(state.settings, state.result.selections, Math.random, state.result.constraintId);
        if (picked) {
          state.result = { ...state.result, constraint: picked.text, constraintId: picked.id };
          persistSession();
          render();
        } else {
          showToast('No other rule fits this session.');
        }
      }
      break;
    case 'new-rig':
      rerollRig();
      break;
    case 'new-tempo':
      rerollTempo();
      break;
    case 'new-key':
      rerollKey();
      break;
    case 'metronome':
      toggleMetronome();
      break;
    case 'tap-tempo':
      tapTempo();
      break;
    case 'test-mic':
      testMicrophone();
      break;
    case 'check-update':
      checkForUpdates(true);
      break;
    case 'apply-update':
      applyUpdate();
      break;
    case 'share-entry':
      if (entry) shareEntry(entry);
      break;
    case 'share-clip':
      if (entry) shareEntryClip(entry);
      break;
    case 'length-preset':
      setSessionMinutes(Number(target.dataset.minutes));
      break;
    case 'length-step':
      setSessionMinutes(sessionMinutes() + Number(target.dataset.delta));
      break;
    case 'length-default':
      setSessionMinutes(null);
      break;
    case 'share':
      shareResult();
      break;
    case 'rigc-device': {
      const id = target.dataset.id;
      const c = state.rigConstraints;
      let must = c.must.filter((x) => x !== id);
      let never = c.never.filter((x) => x !== id);
      if (c.must.includes(id)) never = [...never, id];
      else if (!c.never.includes(id)) must = [...must, id];
      setRigConstraints({ ...c, must, never });
      render();
      break;
    }
    case 'rigc-reset':
      setRigConstraints(defaultRigConstraints(state.settings));
      render();
      showToast('Rig constraints reset to defaults');
      break;
    case 'rigc-preset':
      {
        const preset = state.settings.rigPresets.find((p) => p.id === target.dataset.id);
        if (preset) {
          setRigConstraints(preset.constraints);
          render();
          showToast(`Preset "${preset.name}" applied`);
        }
      }
      break;
    case 'rigc-preset-save': {
      const name = window.prompt('Name this rig constraint preset', '');
      if (!name || !name.trim()) break;
      state.settings = {
        ...state.settings,
        rigPresets: [
          ...state.settings.rigPresets,
          { id: uid(), name: name.trim().slice(0, 40), constraints: state.rigConstraints },
        ],
      };
      persistSettings();
      render();
      showToast('Preset saved');
      break;
    }
    case 'rigc-preset-remove':
      state.settings = {
        ...state.settings,
        rigPresets: state.settings.rigPresets.filter((p) => p.id !== target.dataset.id),
      };
      persistSettings();
      render();
      break;
    case 'jf-type':
      state.journalFilter = { ...state.journalFilter, type: target.dataset.type || '' };
      render();
      break;
    case 'jf-rating':
      state.journalFilter = { ...state.journalFilter, minRating: Number(target.dataset.min) || 0 };
      render();
      break;
    case 'jf-clear':
      state.journalFilter = { type: '', minRating: 0, query: '' };
      render();
      break;
    case 'remove-constraint':
      state.settings = {
        ...state.settings,
        constraints: {
          ...state.settings.constraints,
          custom: state.settings.constraints.custom.filter((c) => c.id !== target.dataset.id),
        },
      };
      persistSettings();
      render();
      break;
    case 'start-recording':
      startRecording();
      break;
    case 'stop-recording':
      stopRecording(true);
      break;
    case 'cancel-recording':
      stopRecording(false);
      break;
    case 'edit-entry':
      if (entry) openEditDraft(entry);
      break;
    case 'delete-entry':
      removeEntry(target.dataset.id);
      break;
    case 'roll-like':
      if (entry) rollLikeEntry(entry);
      break;
    case 'export-backup':
      exportBackup();
      break;
    case 'clear-journal':
      if (window.confirm('Delete every logged session, including audio clips? This cannot be undone.')) {
        clearEntries()
          .then(() => {
            for (const id of [...audioUrls.keys()]) dropAudioUrl(id);
            state.logDraft = null;
            return loadJournal();
          })
          .then(() => showToast('Journal deleted'))
          .catch((err) => showToast(`Could not delete: ${err?.message || 'storage error'}`));
      }
      break;
    case 'timer-preset': {
      const minutes = Number(target.dataset.minutes);
      state.settings = { ...state.settings, timer: { ...state.settings.timer, minutes } };
      persistSettings();
      render();
      break;
    }
    case 'remove-gear': {
      const kind = target.dataset.kind;
      state.settings = normalizeSettings({
        ...state.settings,
        [kind]: state.settings[kind].filter((h) => h.id !== target.dataset.id),
      });
      setRigConstraints(state.rigConstraints);
      persistSettings();
      state.locks = pruneLocks(currentDecisions(), state.locks);
      render();
      break;
    }
    case 'remove-track':
      state.settings = { ...state.settings, tracks: state.settings.tracks.filter((t) => t.id !== target.dataset.id) };
      persistSettings();
      state.locks = pruneLocks(currentDecisions(), state.locks);
      render();
      break;
    case 'reset-weights':
      state.settings = { ...state.settings, weights: {}, bpm: { ...DEFAULT_SETTINGS.bpm } };
      persistSettings();
      render();
      showToast('Probabilities reset');
      break;
    case 'reset-all':
      if (window.confirm('Reset all settings, hardware, software and tracks? The journal is kept.')) {
        state.settings = structuredClone(DEFAULT_SETTINGS);
        state.locks = {};
        state.result = null;
        setRigConstraints(null);
        persistSettings();
        persistSession();
        render();
        showToast('Settings reset');
      }
      break;
    default:
      break;
  }
});

root.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const name = String(data.get('name') || data.get('text') || '').trim();
  if (!name) return;
  if (form.dataset.action === 'add-gear') {
    const kind = form.dataset.kind === 'software' ? 'software' : 'hardware';
    const type = DEVICE_TYPE_IDS.includes(data.get('type')) ? data.get('type') : 'other';
    state.settings = {
      ...state.settings,
      [kind]: [...state.settings[kind], { id: uid(), name, type, weight: DEFAULT_WEIGHT }],
    };
  } else if (form.dataset.action === 'add-track') {
    state.settings = { ...state.settings, tracks: [...state.settings.tracks, { id: uid(), name }] };
  } else if (form.dataset.action === 'add-constraint') {
    const scope = SCOPES[data.get('scope')] ? data.get('scope') : 'any';
    state.settings = {
      ...state.settings,
      constraints: {
        ...state.settings.constraints,
        custom: [...state.settings.constraints.custom, { id: uid(), text: name.slice(0, 160), scope }],
      },
    };
  }
  persistSettings();
  render();
});

root.addEventListener('input', (event) => {
  const el = event.target;
  const action = el.dataset?.action;
  if (!action) return;
  switch (action) {
    case 'weight':
      setWeight(el.dataset.decision, el.dataset.option, Number(el.value));
      break;
    case 'gear-weight': {
      const value = Number(el.value);
      updateGear(el.dataset.kind, el.dataset.id, { weight: value });
      const out = el.parentElement?.querySelector('output');
      if (out) out.textContent = String(value);
      break;
    }
    case 'draft-notes':
      if (state.logDraft) state.logDraft.notes = el.value;
      break;
    case 'rigc-send': {
      const sendChance = Number(el.value);
      setRigConstraints({ ...state.rigConstraints, sendChance });
      const out = el.parentElement?.querySelector('output');
      if (out) out.textContent = `${sendChance * 10}%`;
      const line = document.querySelector('.rig-panel .summary-line');
      if (line)
        line.innerHTML = `${esc(summarizeConstraints(state.rigConstraints))} · <strong>${enumerateRigs(state.settings.hardware, state.rigConstraints).length} rigs fit</strong>`;
      break;
    }
    case 'metro-volume': {
      const volume = Number(el.value);
      state.settings = { ...state.settings, metronome: { ...state.settings.metronome, volume } };
      persistSettings();
      for (const out of document.querySelectorAll('input[data-action="metro-volume"]')) {
        const o = out.parentElement?.querySelector('output');
        if (o) o.textContent = `${volume * 10}%`;
        if (out !== el) out.value = String(volume);
      }
      break;
    }
    case 'rotation-strength': {
      const strength = Number(el.value);
      state.settings = { ...state.settings, rotation: { ...state.settings.rotation, strength } };
      persistSettings();
      const out = el.parentElement?.querySelector('output');
      if (out)
        out.textContent =
          strength === 10 ? 'almost never' : strength === 0 ? 'off' : `${100 - strength * 10}% as likely`;
      break;
    }
    case 'jf-query': {
      state.journalFilter = { ...state.journalFilter, query: el.value };
      const main = document.querySelector('main.view');
      const focusPos = el.selectionStart;
      render();
      const again = document.querySelector('input[data-action="jf-query"]');
      if (again) {
        again.focus();
        try {
          again.setSelectionRange(focusPos, focusPos);
        } catch {
          /* ignore */
        }
      }
      void main;
      break;
    }
    case 'send-chance': {
      const chance = Number(el.value);
      state.settings = {
        ...state.settings,
        rigs: { ...state.settings.rigs, sends: { ...state.settings.rigs.sends, chance } },
      };
      persistSettings();
      const out = el.parentElement?.querySelector('output');
      if (out) out.textContent = `${chance * 10}%`;
      break;
    }
    default:
      break;
  }
});

root.addEventListener('change', (event) => {
  const el = event.target;
  const action = el.dataset?.action;
  if (!action) return;
  switch (action) {
    case 'timer-minutes': {
      const minutes = Math.min(240, Math.max(1, Number.parseInt(el.value, 10) || 60));
      state.settings = { ...state.settings, timer: { ...state.settings.timer, minutes } };
      persistSettings();
      render();
      break;
    }
    case 'toggle-awake':
      state.settings = { ...state.settings, timer: { ...state.settings.timer, keepAwake: el.checked } };
      persistSettings();
      if (el.checked && timer.state.status === 'running') timer.requestWakeLock();
      if (!el.checked) timer.releaseWakeLock();
      break;
    case 'rigc-size': {
      const value = Math.min(RIG_MAX_SIZE, Math.max(1, Number(el.value) || 1));
      const c = { ...state.rigConstraints, [el.dataset.key]: value };
      if (c.min > c.max) {
        if (el.dataset.key === 'min') c.max = c.min;
        else c.min = c.max;
      }
      setRigConstraints(c);
      render();
      break;
    }
    case 'rigc-type': {
      const type = el.dataset.type;
      const value = Math.min(RIG_MAX_SIZE, Math.max(0, Number(el.value) || 0));
      const lim = { ...(state.rigConstraints.perType[type] || { min: 0, max: RIG_MAX_SIZE }), [el.dataset.key]: value };
      if (lim.min > lim.max) {
        if (el.dataset.key === 'min') lim.max = lim.min;
        else lim.min = lim.max;
      }
      setRigConstraints({ ...state.rigConstraints, perType: { ...state.rigConstraints.perType, [type]: lim } });
      render();
      break;
    }
    case 'rigc-pin':
      setRigConstraints({ ...state.rigConstraints, pins: { ...state.rigConstraints.pins, [el.dataset.fx]: el.value } });
      render();
      break;
    case 'toggle-groovebox-seq':
      state.settings = { ...state.settings, rigs: { ...state.settings.rigs, grooveboxSequences: el.checked } };
      persistSettings();
      break;
    case 'toggle-rotation':
      state.settings = { ...state.settings, rotation: { ...state.settings.rotation, enabled: el.checked } };
      persistSettings();
      render();
      break;
    case 'toggle-rotation-constraints':
      state.settings = { ...state.settings, rotation: { ...state.settings.rotation, includeConstraints: el.checked } };
      persistSettings();
      break;
    case 'rotation-lookback': {
      const lookBack = Math.min(20, Math.max(1, Number.parseInt(el.value, 10) || 3));
      state.settings = { ...state.settings, rotation: { ...state.settings.rotation, lookBack } };
      persistSettings();
      render();
      break;
    }
    case 'rig-type-limit': {
      const type = el.dataset.type;
      const value = Math.min(RIG_MAX_SIZE, Math.max(0, Number(el.value) || 0));
      const current = state.settings.rigs.perType[type] || { min: 0, max: RIG_MAX_SIZE };
      const limit = { ...current, [el.dataset.key]: value };
      if (limit.min > limit.max) {
        if (el.dataset.key === 'min') limit.max = limit.min;
        else limit.min = limit.max;
      }
      state.settings = {
        ...state.settings,
        rigs: { ...state.settings.rigs, perType: { ...state.settings.rigs.perType, [type]: limit } },
      };
      persistSettings();
      state.locks = pruneLocks(currentDecisions(), state.locks);
      render();
      break;
    }
    case 'toggle-sends':
      state.settings = {
        ...state.settings,
        rigs: { ...state.settings.rigs, sends: { ...state.settings.rigs.sends, enabled: el.checked } },
      };
      persistSettings();
      render();
      break;
    case 'rig-size': {
      const value = Math.min(RIG_MAX_SIZE, Math.max(1, Number(el.value) || 1));
      const rigs = { ...state.settings.rigs, [el.dataset.key]: value };
      if (rigs.min > rigs.max) {
        if (el.dataset.key === 'min') rigs.max = rigs.min;
        else rigs.min = rigs.max;
      }
      state.settings = { ...state.settings, rigs };
      persistSettings();
      state.locks = pruneLocks(currentDecisions(), state.locks);
      render();
      break;
    }
    case 'toggle-tempo':
      state.settings = { ...state.settings, music: { ...state.settings.music, tempo: el.checked } };
      persistSettings();
      showToast(el.checked ? 'Next roll adds a tempo and meter' : 'Tempo off');
      break;
    case 'toggle-key':
      state.settings = { ...state.settings, music: { ...state.settings.music, key: el.checked } };
      persistSettings();
      showToast(el.checked ? 'Next roll adds a key' : 'Key off');
      break;
    case 'toggle-constraints':
      state.settings = {
        ...state.settings,
        constraints: { ...state.settings.constraints, enabled: el.checked },
      };
      persistSettings();
      showToast(el.checked ? 'Next roll adds a constraint' : 'Constraints off');
      break;
    case 'toggle-constraint': {
      const id = el.dataset.id;
      const disabled = state.settings.constraints.disabled.filter((d) => d !== id);
      if (!el.checked) disabled.push(id);
      state.settings = { ...state.settings, constraints: { ...state.settings.constraints, disabled } };
      persistSettings();
      break;
    }
    case 'toggle-chime':
      state.settings = { ...state.settings, timer: { ...state.settings.timer, chime: el.checked } };
      persistSettings();
      break;
    case 'gear-type':
      updateGear(el.dataset.kind, el.dataset.id, { type: el.value });
      state.locks = pruneLocks(currentDecisions(), state.locks);
      render();
      break;
    case 'draft-audio-file':
      setDraftAudio(el.files?.[0]);
      break;
    case 'import-backup':
      importBackup(el.files?.[0]);
      el.value = '';
      break;
    case 'bpm-min':
    case 'bpm-max': {
      const value =
        Math.min(300, Math.max(20, Number.parseInt(el.value, 10) || 0)) || (action === 'bpm-min' ? 70 : 160);
      const bpm = { ...state.settings.bpm, [action === 'bpm-min' ? 'min' : 'max']: value };
      if (bpm.min > bpm.max) [bpm.min, bpm.max] = [bpm.max, bpm.min];
      state.settings = { ...state.settings, bpm };
      persistSettings();
      render();
      break;
    }
    default:
      break;
  }
});

// ---------- boot ----------

render();
loadJournal();

// ---------- updates ----------

function offerUpdate() {
  state.updateReady = true;
  showToast(`Version update ready.`, 0, { label: 'Reload', onClick: applyUpdate });
  if (state.view === 'settings') render();
}

function applyUpdate() {
  const waiting = swRegistration?.waiting;
  if (waiting) waiting.postMessage('skipWaiting');
  else window.location.reload();
}

async function checkForUpdates(announce = false) {
  if (!swRegistration) {
    if (announce) window.location.reload();
    return;
  }
  try {
    await swRegistration.update();
    if (swRegistration.waiting) {
      offerUpdate();
    } else if (announce) {
      showToast(`You are on the latest version (${APP_VERSION}).`);
    }
  } catch {
    if (announce) showToast('Could not check for updates right now.');
  }
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', async () => {
    try {
      swRegistration = await navigator.serviceWorker.register('./sw.js');
      if (swRegistration.waiting && navigator.serviceWorker.controller) offerUpdate();
      swRegistration.addEventListener('updatefound', () => {
        const installing = swRegistration.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) offerUpdate();
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdates(false);
      });
    } catch {
      /* offline or unsupported */
    }
  });
}
