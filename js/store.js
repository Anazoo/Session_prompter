// Persistent settings, kept in localStorage.
import { DEFAULT_WEIGHT, DEVICE_TYPE_IDS, RIG_MAX_SIZE } from './tree.js';
import { normalizeRigConstraints } from './rigs.js';
import { SCOPES } from './constraints.js';

export const STORAGE_KEY = 'sessionPrompter.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  // decisionId -> optionId -> weight (0..10). Missing entries use the tree defaults.
  weights: {},
  hardware: [],
  software: [],
  tracks: [],
  bpm: { min: 70, max: 160 },
  timer: { minutes: 60, keepAwake: true, chime: true },
  // Built-in constraint ids switched off, plus user-written constraints.
  constraints: { enabled: false, disabled: [], custom: [] },
  // Hardware jam rigs: how many devices per jam, which generated combos are off, custom combos.
  // Default jam rig constraints: the starting point for each session.
  rigs: { min: 1, max: 2, perType: {}, sends: { enabled: true, chance: 3 }, grooveboxSequences: false },
  // Named rig constraint sets the user saved from the Session tab.
  rigPresets: [],
  // Gear rotation: make recently used gear, constraints and twists less likely.
  rotation: { enabled: false, lookBack: 3, strength: 7, includeConstraints: true },
  // Musical extras switched on in the session builder.
  music: { tempo: false, key: false },
});

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalise whatever was stored into a valid settings object. */
export function normalizeSettings(raw) {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return base;

  const weights = {};
  for (const [decisionId, group] of Object.entries(raw.weights || {})) {
    if (!group || typeof group !== 'object') continue;
    weights[decisionId] = {};
    for (const [optionId, w] of Object.entries(group)) {
      weights[decisionId][optionId] = clampInt(w, 0, 10, DEFAULT_WEIGHT);
    }
  }

  const gearList = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((h) => h && typeof h.name === 'string' && h.name.trim())
      .map((h) => ({
        id: typeof h.id === 'string' && h.id ? h.id : uid(),
        name: h.name.trim().slice(0, 60),
        type: DEVICE_TYPE_IDS.includes(h.type) ? h.type : 'other',
        weight: clampInt(h.weight, 0, 10, DEFAULT_WEIGHT),
      }));
  const hardware = gearList(raw.hardware);
  const software = gearList(raw.software);

  const tracks = (Array.isArray(raw.tracks) ? raw.tracks : [])
    .filter((t) => t && typeof t.name === 'string' && t.name.trim())
    .map((t) => ({ id: typeof t.id === 'string' && t.id ? t.id : uid(), name: t.name.trim().slice(0, 80) }));

  const disabled = (Array.isArray(raw.constraints?.disabled) ? raw.constraints.disabled : []).filter(
    (id) => typeof id === 'string',
  );
  const custom = (Array.isArray(raw.constraints?.custom) ? raw.constraints.custom : [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
    .map((c) => ({
      id: typeof c.id === 'string' && c.id ? c.id : uid(),
      text: c.text.trim().slice(0, 160),
      scope: SCOPES[c.scope] ? c.scope : 'any',
    }));

  const rigMin = clampInt(raw.rigs?.min, 1, RIG_MAX_SIZE, base.rigs.min);
  const rigMax = clampInt(raw.rigs?.max, 1, RIG_MAX_SIZE, base.rigs.max);
  const rigs = {
    min: Math.min(rigMin, rigMax),
    max: Math.max(rigMin, rigMax),
    perType: Object.fromEntries(
      DEVICE_TYPE_IDS.filter((t) => raw.rigs?.perType?.[t]).map((t) => {
        const lim = raw.rigs.perType[t];
        const min = clampInt(lim.min, 0, RIG_MAX_SIZE, 0);
        const max = clampInt(lim.max, 0, RIG_MAX_SIZE, RIG_MAX_SIZE);
        return [t, { min: Math.min(min, max), max: Math.max(min, max) }];
      }),
    ),
    sends: {
      enabled: raw.rigs?.sends?.enabled !== false,
      chance: clampInt(raw.rigs?.sends?.chance, 0, 10, 3),
    },
    grooveboxSequences: raw.rigs?.grooveboxSequences === true,
  };
  const rotation = {
    enabled: raw.rotation?.enabled === true,
    lookBack: clampInt(raw.rotation?.lookBack, 1, 20, base.rotation.lookBack),
    strength: clampInt(raw.rotation?.strength, 0, 10, base.rotation.strength),
    includeConstraints: raw.rotation?.includeConstraints !== false,
  };
  const partial = { hardware, rigs };
  const rigPresets = (Array.isArray(raw.rigPresets) ? raw.rigPresets : [])
    .filter((p) => p && typeof p.name === 'string' && p.name.trim())
    .map((p) => ({
      id: typeof p.id === 'string' && p.id ? p.id : uid(),
      name: p.name.trim().slice(0, 40),
      constraints: normalizeRigConstraints(p.constraints, partial),
    }));

  const bpmMin = clampInt(raw.bpm?.min, 20, 300, base.bpm.min);
  const bpmMax = clampInt(raw.bpm?.max, 20, 300, base.bpm.max);

  return {
    version: 1,
    weights,
    hardware,
    software,
    tracks,
    bpm: { min: Math.min(bpmMin, bpmMax), max: Math.max(bpmMin, bpmMax) },
    timer: {
      minutes: clampInt(raw.timer?.minutes, 1, 240, base.timer.minutes),
      keepAwake: raw.timer?.keepAwake !== false,
      chime: raw.timer?.chime !== false,
    },
    constraints: { enabled: raw.constraints?.enabled === true, disabled, custom },
    rigs,
    rigPresets,
    rotation,
    music: { tempo: raw.music?.tempo === true, key: raw.music?.key === true },
  };
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeSettings(null);
  }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
