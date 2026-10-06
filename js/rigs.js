// Jam rigs: a set of hardware devices picked to satisfy constraints.
//
// Constraints come from Settings (the starting point) and can be tightened per
// session: device count range, per-type counts, send chance, devices that must
// or must never be in the rig, and pinned routing for must-have effects.
import {
  DEFAULT_WEIGHT,
  DEVICE_TYPES,
  DEVICE_TYPE_IDS,
  RANDOM_ROUTE,
  RIG_MAX_SIZE,
  ROLE_OF,
  SEND,
  isValidRig,
  jamDevices,
} from './tree.js';

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The constraints a fresh session starts from, derived from Settings. */
export function defaultRigConstraints(settings = {}) {
  const rigs = settings.rigs || {};
  const perType = {};
  for (const [type, lim] of Object.entries(rigs.perType || {}))
    perType[type] = { min: lim.min ?? 0, max: lim.max ?? RIG_MAX_SIZE };
  return {
    min: rigs.min ?? 1,
    max: rigs.max ?? 2,
    perType,
    sendChance: rigs.sends?.enabled === false ? 0 : (rigs.sends?.chance ?? 3),
    must: [],
    never: [],
    pins: {},
  };
}

/** Clean up stored or imported constraints against the current hardware list. */
export function normalizeRigConstraints(raw, settings = {}) {
  const base = defaultRigConstraints(settings);
  if (!raw || typeof raw !== 'object') return base;
  const hardware = settings.hardware || [];
  const byId = new Map(hardware.map((h) => [h.id, h]));
  const min = clampInt(raw.min, 1, RIG_MAX_SIZE, base.min);
  const max = clampInt(raw.max, 1, RIG_MAX_SIZE, base.max);
  const perType = {};
  for (const type of DEVICE_TYPE_IDS) {
    const lim = raw.perType?.[type];
    if (!lim) continue;
    const lo = clampInt(lim.min, 0, RIG_MAX_SIZE, 0);
    const hi = clampInt(lim.max, 0, RIG_MAX_SIZE, RIG_MAX_SIZE);
    perType[type] = { min: Math.min(lo, hi), max: Math.max(lo, hi) };
  }
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((id) => byId.has(id)))];
  const must = ids(raw.must);
  const never = ids(raw.never).filter((id) => !must.includes(id));
  const pins = {};
  for (const [fx, target] of Object.entries(raw.pins || {})) {
    if (!must.includes(fx) || ROLE_OF(byId.get(fx)) !== 'fx') continue;
    if (target === SEND || (must.includes(target) && ROLE_OF(byId.get(target)) === 'instrument')) pins[fx] = target;
  }
  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    perType,
    sendChance: clampInt(raw.sendChance, 0, 10, base.sendChance),
    must,
    never,
    pins,
  };
}

function combinations(items, size) {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items;
  return [...combinations(rest, size - 1).map((c) => [first, ...c]), ...combinations(rest, size)];
}

function withinTypeLimits(devices, perType) {
  const counts = {};
  for (const d of devices) counts[d.type] = (counts[d.type] || 0) + 1;
  for (const [type, limit] of Object.entries(perType || {})) {
    const n = counts[type] || 0;
    if (n < (limit.min ?? 0) || n > (limit.max ?? RIG_MAX_SIZE)) return false;
  }
  return true;
}

/** Every rig that satisfies the constraints, as arrays of devices. */
export function enumerateRigs(hardware = [], constraints) {
  const c = constraints || defaultRigConstraints();
  const pool = jamDevices(hardware).filter((d) => !c.never.includes(d.id));
  const must = c.must.filter((id) => pool.some((d) => d.id === id));
  if (must.length < c.must.length) return []; // a must-have device is missing or excluded
  const fixed = pool.filter((d) => must.includes(d.id));
  const free = pool.filter((d) => !must.includes(d.id));
  const out = [];
  const lo = Math.max(c.min, fixed.length);
  for (let size = lo; size <= c.max; size++) {
    for (const extra of combinations(free, size - fixed.length)) {
      const rig = [...fixed, ...extra].sort((a, b) => hardware.indexOf(a) - hardware.indexOf(b));
      if (!isValidRig(rig)) continue;
      if (!rig.some((d) => DEVICE_TYPES[d.type]?.jam)) continue; // a synth jam needs a lead
      if (!withinTypeLimits(rig, c.perType)) continue;
      out.push(rig);
    }
  }
  return out;
}

/** Pick one rig at random, weighting by device weights and (optionally) recent use. */
export function pickRig(hardware, constraints, rng = Math.random, penalty = () => 1) {
  const rigs = enumerateRigs(hardware, constraints);
  if (!rigs.length) return null;
  const weightOf = (rig) => {
    const base = rig.reduce((sum, d) => sum + (d.weight ?? DEFAULT_WEIGHT), 0) / rig.length;
    const rot = Math.min(...rig.map((d) => penalty(d.id)));
    return Math.max(0, base * rot);
  };
  const total = rigs.reduce((sum, r) => sum + weightOf(r), 0);
  if (total <= 0) return rigs[Math.floor(rng() * rigs.length)];
  let r = rng() * total;
  for (const rig of rigs) {
    r -= weightOf(rig);
    if (r < 0) return rig;
  }
  return rigs[rigs.length - 1];
}

export function rigLabel(rig) {
  return rig.map((d) => d.name).join(' + ');
}

/** Short human summary for the collapsed constraints panel. */
export function summarizeConstraints(c, hardware = []) {
  const parts = [c.min === c.max ? `${c.min} device${c.min > 1 ? 's' : ''}` : `${c.min} to ${c.max} devices`];
  if (c.must.length) parts.push(`${c.must.length} must`);
  if (c.never.length) parts.push(`${c.never.length} never`);
  const typeRules = Object.entries(c.perType).filter(([, l]) => l.min > 0 || l.max < RIG_MAX_SIZE).length;
  if (typeRules) parts.push(`${typeRules} type rule${typeRules > 1 ? 's' : ''}`);
  parts.push(c.sendChance ? `${c.sendChance * 10}% sends` : 'no sends');
  void hardware;
  return parts.join(' · ');
}

export { RANDOM_ROUTE, SEND };
