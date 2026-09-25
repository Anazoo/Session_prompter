import { generateSession, isApplicable, isCompatible, optionWeight, pruneLocks } from './engine.js';
import {
  DEFAULT_WEIGHT,
  DEVICE_DECISION,
  DEVICE_TYPES,
  DEVICE_TYPE_IDS,
  FX_DECISION,
  FX_NONE,
  SOFTWARE_DECISION,
  STATIC_DECISIONS,
  TRACK_DECISION,
  buildDecisions,
  findDecision,
} from './tree.js';
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings, uid } from './store.js';
import { SessionTimer, formatClock } from './timer.js';
import {
  MAX_AUDIO_BYTES,
  clearEntries,
  deleteEntry,
  formatBytes,
  formatDuration,
  listEntries,
  makeBackup,
  makeEntry,
  parseBackup,
  putEntry,
  requestPersistence,
  summarize,
} from './journal.js';

const SESSION_KEY = 'sessionPrompter.session.v1';
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
};

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
}

function persistSettings() {
  saveSettings(state.settings);
  applyTimerSettings();
}

function persistSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ locks: state.locks, result: state.result }));
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
    }
  } catch {
    /* ignore */
  }
}

function currentDecisions() {
  return buildDecisions(state.settings);
}

function showToast(message) {
  state.toast = message;
  renderToast();
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => {
    state.toast = null;
    renderToast();
  }, 2600);
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
  el.textContent = state.toast;
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
  const result = generateSession({ locks: state.locks, weights: state.settings.weights, config: state.settings });
  state.result = result;
  persistSession();
  render();
  document.querySelector('.result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startTimer() {
  if (!state.result) generate();
  timer.start(state.settings.timer.minutes * 60 * 1000);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Open the "log this session" form, optionally taking the elapsed time from the timer. */
function openLogDraft({ fromTimer }) {
  if (!state.result) return;
  const draft = {
    session: state.result,
    startedAt: fromTimer ? timer.state.startedAt : null,
    elapsedMs: fromTimer ? timer.elapsedMs : null,
    plannedMs: fromTimer ? timer.state.durationMs : state.settings.timer.minutes * 60 * 1000,
    notes: '',
    audio: null,
    entryId: null,
  };
  if (fromTimer) timer.reset();
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
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('Recording is not supported here. Use "Choose file" instead.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
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
    showToast(err?.name === 'NotAllowedError' ? 'Microphone access was denied.' : 'Could not start recording.');
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
      ${timerStatus !== 'idle' ? `<button class="timer-pill ${timerStatus}" data-action="go-timer" aria-label="Show timer">${timerStatus === 'done' ? 'Done' : '⏱'} <span class="pill-clock">${formatClock(timer.remainingMs)}</span></button>` : ''}
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
  const minutes = state.settings.timer.minutes;
  const timerIdle = timer.state.status === 'idle';
  const previous = lastLogged(r.title);
  return `
    <section class="card result">
      <p class="eyebrow">${esc(r.categoryLabel)} · ${esc(r.title)}</p>
      <h2 class="prompt">${esc(r.prompt)}</h2>
      ${r.twist ? `<p class="twist">${esc(r.twist)}</p>` : ''}
      <ul class="chips">${tags.join('')}</ul>
      ${previous ? `<p class="last-done">Last ${esc(r.title.toLowerCase())} session: ${timeAgo(previous.createdAt)}.</p>` : ''}
      ${r.conflicts?.length ? `<p class="notice">${r.conflicts.map(esc).join('<br>')}</p>` : ''}
      <div class="btn-row">
        ${timerIdle ? `<button class="btn primary" data-action="start-timer">Start ${minutes} min session</button>` : ''}
        <button class="btn" data-action="generate">🎲 Reroll</button>
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
      <div class="btn-row">
        <button class="btn primary big" data-action="generate">${state.result ? 'Roll again' : 'Generate session'}</button>
      </div>
      ${hasLocks ? `<div class="btn-row"><button class="btn ghost" data-action="clear-locks">Clear my choices</button></div>` : ''}
    </section>
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
      ${meta.length ? `<p class="meta">${meta.join('')}</p>` : ''}
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

// ---------- journal view ----------

function renderJournal() {
  const j = state.journal;
  if (!j.loaded) return `<section class="card"><p class="muted">Loading your journal…</p></section>`;
  if (j.error)
    return `<section class="card"><h2>Journal</h2><p class="muted error">${esc(j.error)}. Private browsing on iOS can block storage; try the installed app instead.</p></section>`;
  const stats = summarize(j.entries);
  const categories = Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]);
  const summary = `
    <section class="card">
      <h2>Journal</h2>
      <p class="muted">Every session you logged, newest first. Notes and clips stay on this device.</p>
      <div class="stats">
        <div class="stat"><div class="value">${stats.count}</div><div class="label">Sessions</div></div>
        <div class="stat"><div class="value">${esc(formatDuration(stats.totalMs))}</div><div class="label">Time logged</div></div>
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
  return (
    summary +
    j.entries.map((e) => (state.logDraft?.entryId === e.id ? renderLogForm(state.logDraft) : renderEntry(e))).join('')
  );
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
      ${e.twist ? `<p class="twist">${esc(e.twist)}</p>` : ''}
      <ul class="chips">${chips.join('')}</ul>
      ${e.notes ? `<p class="notes">${esc(e.notes)}</p>` : `<p class="notes muted">No notes.</p>`}
      ${url ? `<audio controls preload="metadata" src="${url}"></audio>` : ''}
      ${e.audio && !url ? `<p class="file-meta muted">Clip "${esc(e.audio.name)}" was not restored with this backup.</p>` : ''}
      <div class="btn-row">
        <button class="btn" data-action="edit-entry" data-id="${e.id}">Edit</button>
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
          ? 'List your gear and prompts will name it. The type decides where a device can show up: a drum machine gets drum loops and kits, keys get piano jams and chords, pedals become optional twists.'
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

    <section class="card">
      <h2>Probabilities</h2>
      <p class="muted">Weights run from 0 to 10. The percentage is each option's chance within its group. 0 removes an option from the roll (you can still lock it by hand).</p>
      ${weightGroups}
      ${fxGroup}
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
      <h2>Danger zone</h2>
      <div class="btn-row">
        <button class="btn ghost danger" data-action="reset-all">Reset all settings</button>
        <button class="btn ghost danger" data-action="clear-journal">Delete the whole journal</button>
      </div>
    </section>
  `;
}

function refreshPercentLabels(decisionId) {
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
      break;
    case 'next-session':
      timer.reset();
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
      state.settings = { ...state.settings, [kind]: state.settings[kind].filter((h) => h.id !== target.dataset.id) };
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
  const name = String(data.get('name') || '').trim();
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

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
