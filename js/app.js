import { generateSession, isApplicable, isCompatible, optionWeight, pruneLocks } from './engine.js';
import {
  DEFAULT_WEIGHT,
  DEVICE_DECISION,
  DEVICE_TYPES,
  DEVICE_TYPE_IDS,
  FX_DECISION,
  FX_NONE,
  STATIC_DECISIONS,
  TRACK_DECISION,
  buildDecisions,
  findDecision,
} from './tree.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, uid } from './store.js';
import { SessionTimer, formatClock } from './timer.js';

const SESSION_KEY = 'sessionPrompter.session.v1';
const RING_RADIUS = 100;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const state = {
  view: 'session',
  settings: loadSettings(),
  locks: {},
  result: null,
  toast: null,
};

const root = document.getElementById('app');
let lastTimerStatus = 'idle';
let toastHandle = null;

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

// ---------- rendering ----------

function render() {
  const timerStatus = timer.state.status;
  root.innerHTML = `
    <header class="topbar">
      <h1>Session Prompter</h1>
      ${timerStatus !== 'idle' ? `<button class="timer-pill ${timerStatus}" data-action="go-timer" aria-label="Show timer">${timerStatus === 'done' ? 'Done' : '⏱'} <span class="pill-clock">${formatClock(timer.remainingMs)}</span></button>` : ''}
    </header>
    <main class="view">
      ${state.view === 'settings' ? renderSettings() : renderSessionView()}
    </main>
    <nav class="tabbar" aria-label="Main">
      <div class="tabbar-inner">
        <button class="tab ${state.view === 'session' ? 'active' : ''}" data-action="view" data-view="session" aria-current="${state.view === 'session' ? 'page' : 'false'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          Session
        </button>
        <button class="tab ${state.view === 'settings' ? 'active' : ''}" data-action="view" data-view="settings" aria-current="${state.view === 'settings' ? 'page' : 'false'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
          Settings
        </button>
      </div>
    </nav>
  `;
  renderToast();
  updateTimerDisplay();
}

function renderSessionView() {
  const parts = [];
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
  return `
    <section class="card result">
      <p class="eyebrow">${esc(r.categoryLabel)} · ${esc(r.title)}</p>
      <h2 class="prompt">${esc(r.prompt)}</h2>
      ${r.twist ? `<p class="twist">${esc(r.twist)}</p>` : ''}
      <ul class="chips">${tags.join('')}</ul>
      ${r.conflicts?.length ? `<p class="notice">${r.conflicts.map(esc).join('<br>')}</p>` : ''}
      <div class="btn-row">
        ${timerIdle ? `<button class="btn primary" data-action="start-timer">Start ${minutes} min session</button>` : ''}
        <button class="btn" data-action="generate">🎲 Reroll</button>
      </div>
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
    buttons.push(`<button class="btn primary" data-action="next-session">New session</button>`);
    buttons.push(`<button class="btn" data-action="extend">+10 min</button>`);
    buttons.push(`<button class="btn ghost" data-action="reset-timer">Done</button>`);
  } else {
    buttons.push(`<button class="btn" data-action="extend">+10 min</button>`);
    buttons.push(`<button class="btn ghost danger" data-action="reset-timer">End</button>`);
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
      <p class="timer-prompt">${status === 'done' ? 'Session complete. Save your work and take a breath.' : esc(promptText)}</p>
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
    const hint =
      decision.id === DEVICE_DECISION
        ? 'from your hardware list'
        : decision.id === TRACK_DECISION
          ? 'from your track list'
          : decision.id === FX_DECISION
            ? 'optional'
            : '';
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

function renderSettings() {
  const s = state.settings;
  const decisions = currentDecisions();
  const hasPedals = s.hardware.some((h) => DEVICE_TYPES[h.type]?.role === 'fx');

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

  const fxDecision = findDecision(decisions, FX_DECISION);
  const fxGroup =
    hasPedals && fxDecision
      ? `
      <h3>Effects twist<span class="path">Assets · Tracks</span></h3>
      <p class="muted">How often a session gets an extra "run it through a pedal" line. Raise "No twist" to make it rarer; each pedal's own weight is set in the hardware list.</p>
      <label class="slider-row">
        <span>No twist</span>
        <input type="range" min="0" max="10" step="1" value="${optionWeight(fxDecision, fxDecision.options[0], s.weights)}" data-action="weight" data-decision="${FX_DECISION}" data-option="${FX_NONE}" aria-label="No twist weight">
        <output data-pct="${FX_DECISION}:${FX_NONE}">${percentLabels(fxDecision)[FX_NONE]}</output>
      </label>`
      : '';

  const hardwareList = s.hardware.length
    ? `<ul class="list">${s.hardware
        .map(
          (h) => `
        <li data-id="${h.id}">
          <span class="name">${esc(h.name)}</span>
          <button class="delete" data-action="remove-hardware" data-id="${h.id}" aria-label="Remove ${esc(h.name)}">Remove</button>
          <div class="controls">
            <select data-action="hardware-type" data-id="${h.id}" aria-label="Type of ${esc(h.name)}">
              ${DEVICE_TYPE_IDS.map((t) => `<option value="${t}" ${h.type === t ? 'selected' : ''}>${DEVICE_TYPES[t].label}</option>`).join('')}
            </select>
            <label class="slider-row inline">
              <span>Weight</span>
              <input type="range" min="0" max="10" step="1" value="${h.weight}" data-action="hardware-weight" data-id="${h.id}" aria-label="Weight of ${esc(h.name)}">
              <output>${h.weight}</output>
            </label>
          </div>
        </li>`,
        )
        .join('')}</ul>`
    : `<p class="empty">No hardware yet. Prompts will just say "hardware" until you add some.</p>`;

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
      <h2>Hardware</h2>
      <p class="muted">List your gear and prompts will name it. The type decides where a device can show up: a drum machine gets drum loops and kits, keys get piano jams and chords, pedals become optional twists.</p>
      ${hardwareList}
      <form class="add-row" data-action="add-hardware">
        <input type="text" name="name" placeholder="e.g. Prophet-6" maxlength="60" autocomplete="off" autocapitalize="words" aria-label="Hardware name" required>
        <select name="type" aria-label="Hardware type">
          ${DEVICE_TYPE_IDS.map((t) => `<option value="${t}">${DEVICE_TYPES[t].label}</option>`).join('')}
        </select>
        <button class="btn primary" type="submit">Add</button>
      </form>
    </section>

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
      <div class="btn-row"><button class="btn ghost danger" data-action="reset-all">Reset all settings</button></div>
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

function updateHardware(id, patch) {
  state.settings = {
    ...state.settings,
    hardware: state.settings.hardware.map((h) => (h.id === id ? { ...h, ...patch } : h)),
  };
  persistSettings();
}

// ---------- events ----------

root.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'FORM') return;
  const action = target.dataset.action;
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
    case 'timer-preset': {
      const minutes = Number(target.dataset.minutes);
      state.settings = { ...state.settings, timer: { ...state.settings.timer, minutes } };
      persistSettings();
      render();
      break;
    }
    case 'remove-hardware':
      state.settings = {
        ...state.settings,
        hardware: state.settings.hardware.filter((h) => h.id !== target.dataset.id),
      };
      persistSettings();
      state.locks = pruneLocks(currentDecisions(), state.locks);
      render();
      break;
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
      if (window.confirm('Reset all settings, hardware and tracks?')) {
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
  if (form.dataset.action === 'add-hardware') {
    const type = DEVICE_TYPE_IDS.includes(data.get('type')) ? data.get('type') : 'other';
    state.settings = {
      ...state.settings,
      hardware: [...state.settings.hardware, { id: uid(), name, type, weight: DEFAULT_WEIGHT }],
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
    case 'hardware-weight': {
      const value = Number(el.value);
      updateHardware(el.dataset.id, { weight: value });
      const out = el.parentElement?.querySelector('output');
      if (out) out.textContent = String(value);
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
    case 'toggle-chime':
      state.settings = { ...state.settings, timer: { ...state.settings.timer, chime: el.checked } };
      persistSettings();
      break;
    case 'hardware-type':
      updateHardware(el.dataset.id, { type: el.value });
      state.locks = pruneLocks(currentDecisions(), state.locks);
      render();
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

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
