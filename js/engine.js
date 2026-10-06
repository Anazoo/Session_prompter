// Resolution engine: turns the user's locked choices plus weights into a full session.
import { constraintPool } from './constraints.js';
import { defaultRigConstraints, pickRig } from './rigs.js';
import { ROOTS, SCALE_DECISION, formatKey, scaleWeight } from './music.js';
import {
  DEFAULT_WEIGHT,
  DEVICE_DECISION,
  DEVICE_TYPES,
  FX_DECISION,
  FX_NONE,
  RANDOM_ROUTE,
  ROLE_OF,
  SEND,
  SOFTWARE_DECISION,
  TRACK_DECISION,
  buildDecisions,
  findDecision,
  findOption,
} from './tree.js';

/** Small seedable PRNG (mulberry32) so tests are deterministic. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Effective weight for an option after user overrides. */
export function optionWeight(decision, option, weights = {}) {
  const override = weights?.[decision.id]?.[option.id];
  if (typeof override === 'number' && Number.isFinite(override)) return Math.max(0, override);
  return option.weight ?? DEFAULT_WEIGHT;
}

/**
 * Rotation: a multiplier for options used in recent sessions.
 * `recent` is { devices: Set, constraints: Set, twists: Set } built from the journal.
 */
export function rotationPenalty(config = {}) {
  const rot = config.rotation || {};
  const recent = config.recent || {};
  if (!rot.enabled) return () => 1;
  const factor = Math.max(0, 1 - Math.min(10, Math.max(0, rot.strength ?? 7)) / 10);
  const mult = factor === 0 ? 0.05 : factor;
  return (id, kind = 'devices') => {
    if (kind === 'constraints' && rot.includeConstraints === false) return 1;
    if (kind === 'twists' && rot.includeConstraints === false) return 1;
    return recent[kind]?.has?.(id) ? mult : 1;
  };
}

/** Pick one item from `items` using `weightOf(item)`; returns null when nothing is pickable. */
export function weightedPick(items, weightOf, rng = Math.random) {
  const total = items.reduce((sum, item) => sum + Math.max(0, weightOf(item)), 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const item of items) {
    r -= Math.max(0, weightOf(item));
    if (r < 0) return item;
  }
  return items[items.length - 1];
}

/** Is `decision` relevant given the choices made so far? */
export function isApplicable(decision, selections) {
  if (decision.parent) {
    const [id, value] = decision.parent;
    return selections[id] === value;
  }
  if (decision.anyOf) {
    return decision.anyOf.some(([id, value]) => selections[id] === value);
  }
  return true;
}

/**
 * Can `option` be chosen for `decision` given everything else that is fixed?
 * `fixed` maps decisionId -> optionId for both locked and already-resolved choices.
 */
export function isCompatible(decisions, decision, option, fixed) {
  // The option's own requirements against what is already fixed.
  for (const [otherId, allowed] of Object.entries(option.requires || {})) {
    const value = fixed[otherId];
    if (value !== undefined && !allowed.includes(value)) return false;
  }
  // Requirements that fixed options impose on this decision.
  for (const [otherId, value] of Object.entries(fixed)) {
    if (otherId === decision.id || value === undefined) continue;
    const otherOption = findOption(findDecision(decisions, otherId), value);
    const allowed = otherOption?.requires?.[decision.id];
    if (allowed && !allowed.includes(option.id)) return false;
  }
  return true;
}

/**
 * Drop locks whose decision no longer applies, or whose option no longer exists.
 * Keeps the lock map tidy when a parent choice changes.
 */
export function pruneLocks(decisions, locks) {
  const kept = {};
  const applicable = {};
  for (const decision of decisions) {
    if (!isApplicable(decision, applicable)) continue;
    const value = locks[decision.id];
    if (value === undefined) continue;
    if (!findOption(decision, value)) continue;
    kept[decision.id] = value;
    applicable[decision.id] = value;
  }
  return kept;
}

/**
 * Resolve a full session.
 * @returns {{selections: Object, locked: Object, conflicts: string[]}}
 */
export function resolve({ locks = {}, weights = {}, config = {}, rng = Math.random }) {
  const decisions = buildDecisions(config);
  const penalty = rotationPenalty(config);
  const selections = {};
  const locked = {};
  const conflicts = [];
  const cleanLocks = pruneLocks(decisions, locks);

  for (const decision of decisions) {
    if (!isApplicable(decision, selections)) continue;

    // A lock is checked against what is already decided, so earlier choices win.
    const lockValue = cleanLocks[decision.id];
    if (lockValue !== undefined) {
      const option = findOption(decision, lockValue);
      if (option && isCompatible(decisions, decision, option, selections)) {
        selections[decision.id] = lockValue;
        locked[decision.id] = true;
        continue;
      }
      conflicts.push(
        `${decision.label}: "${option?.label ?? lockValue}" clashes with another locked choice, so it was rerolled.`,
      );
    }

    // A random pick must also respect locks further down the tree.
    const fixed = { ...cleanLocks, ...selections };
    delete fixed[decision.id];
    const compatible = decision.options.filter((o) => isCompatible(decisions, decision, o, fixed));
    const rotated = (o) => {
      if (decision.id === DEVICE_DECISION || decision.id === SOFTWARE_DECISION) return penalty(o.id, 'devices');
      if (decision.id === FX_DECISION && o.id !== FX_NONE) return penalty(o.id, 'twists');
      return 1;
    };
    let pick = weightedPick(compatible, (o) => optionWeight(decision, o, weights) * rotated(o), rng);
    if (!pick && compatible.length && !decision.optional) {
      // Every compatible option has weight 0: fall back to an even pick rather than fail.
      pick = weightedPick(compatible, () => 1, rng);
    }
    if (pick) {
      selections[decision.id] = pick.id;
    } else if (!decision.optional) {
      conflicts.push(`${decision.label}: no option fits the locked choices.`);
    }
  }

  return { selections, locked, conflicts };
}

function randomInt(rng, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Add the details that are not tree choices (BPM), then produce readable text.
 * @returns {{selections, locked, conflicts, bpm?: number, title: string, prompt: string, detail: string[], twist?: string}}
 */
/**
 * Pick a creative constraint that fits the selections, avoiding `excludeId` when the pool allows it.
 * @returns {{id: string, text: string} | null}
 */
export function pickConstraint(config, selections, rng = Math.random, excludeId = null) {
  const pool = constraintPool(config, selections);
  const candidates = pool.length > 1 && excludeId ? pool.filter((c) => c.id !== excludeId) : pool;
  const penalty = rotationPenalty(config);
  const picked =
    weightedPick(candidates, (c) => penalty(c.id, 'constraints'), rng) || weightedPick(candidates, () => 1, rng);
  return picked ? { id: picked.id, text: picked.text } : null;
}

/**
 * Decide where each effect in a jam rig goes: on one instrument or on a send.
 * Fixed routes from a custom rig are kept; everything else is rolled.
 * @returns {Array<{fx: object, target: 'send' | object}>}
 */
export function routeRig(rig, fixed = {}, config = {}, rng = Math.random) {
  const instruments = rig.filter((d) => ROLE_OF(d) === 'instrument');
  const effects = rig.filter((d) => ROLE_OF(d) === 'fx');
  if (!instruments.length) return [];
  const sends = config.rigs?.sends || {};
  const sendChance = sends.enabled === false ? 0 : Math.min(10, Math.max(0, sends.chance ?? 3)) / 10;
  return effects.map((fx) => {
    const want = fixed[fx.id];
    if (want === SEND && sendChance >= 0) return { fx, target: SEND };
    const fixedTarget = want && want !== RANDOM_ROUTE ? instruments.find((d) => d.id === want) : null;
    if (fixedTarget) return { fx, target: fixedTarget };
    if (sendChance > 0 && rng() < sendChance) return { fx, target: SEND };
    return { fx, target: weightedPick(instruments, () => 1, rng) };
  });
}

export function routingText(routes) {
  if (!routes.length) return '';
  return (
    routes
      .map(({ fx, target }) => (target === SEND ? `${fx.name} on a send` : `${fx.name} on the ${target.name}`))
      .join(', ')
      .replace(/^./, (c) => c.toUpperCase()) + '.'
  );
}

/** Roll a tempo and meter using the time-signature weights. */
export function pickTempo(config = {}, weights = {}, rng = Math.random) {
  const range = config.bpm || { min: 70, max: 160 };
  const bpm = randomInt(rng, range.min ?? 70, range.max ?? 160);
  const decision = findDecision(buildDecisions(config), 'timeSig');
  const sig = weightedPick(decision.options, (o) => optionWeight(decision, o, weights), rng) || decision.options[0];
  return { bpm, timeSig: sig.id };
}

/** Roll a key: any root, a scale by weight. */
export function pickKey(weights = {}, rng = Math.random, exclude = null) {
  const root = ROOTS[Math.floor(rng() * ROOTS.length)];
  const options = SCALE_DECISION.options.filter((o) => o.id !== exclude);
  const scale = weightedPick(options, (o) => scaleWeight(o, weights), rng) || weightedPick(options, () => 1, rng);
  return { root, scale: scale.id, text: formatKey(root, scale.id) };
}

/** Sessions where a tempo or key line makes sense: jams and loop creation. */
export function musicApplies(selections) {
  return selections.category === 'jamming' || (selections.category === 'assets' && selections.assetType === 'loop');
}

/**
 * @param {{locks?: object, weights?: object, config?: object, rng?: Function, withConstraint?: boolean, withTempo?: boolean, withKey?: boolean}} args
 */
export function generateSession({
  locks = {},
  weights = {},
  config = {},
  rng = Math.random,
  withConstraint = false,
  withTempo = false,
  withKey = false,
}) {
  const result = resolve({ locks, weights, config, rng });
  const sel = result.selections;
  const decisions = buildDecisions(config);
  const hardware = config.hardware || [];
  const software = config.software || [];
  const tracks = config.tracks || [];

  const device = hardware.find((h) => h.id === sel[DEVICE_DECISION]) || null;
  const plugin = software.find((h) => h.id === sel[SOFTWARE_DECISION]) || null;
  const track = tracks.find((t) => t.id === sel[TRACK_DECISION]) || null;
  const rigConstraints = config.rigConstraints || defaultRigConstraints(config);
  const rig =
    sel.jamType === 'synth'
      ? pickRig(hardware, rigConstraints, rng, (id) => rotationPenalty(config)(id, 'devices')) || []
      : [];
  if (sel.jamType === 'synth' && hardware.length && !rig.length)
    result.rigNotice = 'No rig fits the current rig constraints.';
  let pedal =
    sel[FX_DECISION] && sel[FX_DECISION] !== FX_NONE
      ? [...hardware, ...software].find((h) => h.id === sel[FX_DECISION])
      : null;
  // The effect you are designing a preset on is not also the twist.
  if (pedal && (pedal.id === device?.id || pedal.id === plugin?.id)) {
    pedal = null;
    sel[FX_DECISION] = FX_NONE;
  }

  if (sel.startPoint === 'bpmsig') {
    const range = config.bpm || { min: 70, max: 160 };
    result.bpm = randomInt(rng, range.min ?? 70, range.max ?? 160);
  }

  const label = (decisionId) => findOption(findDecision(decisions, decisionId), sel[decisionId])?.label ?? '';
  const onDevice = (fallback) => (device ? `on the ${device.name}` : fallback);
  const listNames = (items) => {
    const names = items.map((d) => `the ${d.name}`);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  };
  const onRig = () => {
    let instruments = rig.filter((d) => ROLE_OF(d) === 'instrument');
    const effects = rig.filter((d) => ROLE_OF(d) === 'fx');
    let sequencers = rig.filter((d) => ROLE_OF(d) === 'sequencer');
    // Optionally let a groovebox act as the rig's sequencer when there is something else to play.
    if (config.rigs?.grooveboxSequences && instruments.length > 1 && !sequencers.length) {
      const box = instruments.find((d) => d.type === 'groovebox');
      if (box) {
        instruments = instruments.filter((d) => d !== box);
        sequencers = [box];
      }
    }
    if (!instruments.length) return 'on any synth';
    let text = `on the ${instruments[0].name}`;
    if (instruments.length > 1) text += ` with ${listNames(instruments.slice(1))}`;
    if (sequencers.length) text += `, sequenced by ${listNames(sequencers)}`;
    if (effects.length) text += `, through ${listNames(effects)}`;
    return text;
  };

  const methodPhrase = (method) => {
    switch (method) {
      case 'hardware':
        return onDevice('on hardware');
      case 'software':
        return plugin ? `in ${plugin.name}` : 'in the box (software)';
      case 'live':
        return 'from a live recording';
      default:
        return '';
    }
  };

  let title = '';
  let prompt = '';
  const detail = [];

  if (sel.category === 'assets' && sel.assetType === 'loop') {
    title = 'Loop creation';
    const kind = {
      pad: 'a pad loop',
      chords: 'a chord progression loop',
      melodic: 'a melodic loop',
      drums: 'a drum loop',
      soundscape: 'a soundscape loop',
    }[sel.loopKind];
    prompt = `Create ${kind} ${methodPhrase(sel.loopMethod)}.`;
    detail.push(label('loopKind'), label('loopMethod'));
  } else if (sel.category === 'assets' && sel.assetType === 'sound') {
    title = 'Sound design';
    const target = {
      drumkit: 'a drum kit',
      preset: sel.presetKind === 'effect' ? 'an effect preset' : 'an instrument preset',
      oneshot: 'a one-shot',
    }[sel.soundKind];
    if (sel.soundMethod === 'live') {
      prompt = 'Record a one-shot from a live source: a mic, an acoustic instrument, or a found sound.';
    } else if (sel.presetKind === 'effect' && sel.soundMethod === 'hardware' && !device) {
      prompt = `Design an effect preset on a hardware effect.`;
    } else {
      prompt = `Design ${target} ${methodPhrase(sel.soundMethod)}.`;
    }
    detail.push(label('soundKind'));
    if (sel.presetKind) detail.push(label('presetKind'));
    detail.push(label('soundMethod'));
  } else if (sel.category === 'jamming') {
    title = { synth: 'Synth jam', piano: 'Piano jam', other: 'Free jam' }[sel.jamType] || 'Jam';
    if (sel.jamType === 'synth') {
      prompt = `Synth jam ${onRig()}. No goal, just play and record everything.`;
      const routes = routeRig(
        rig,
        rigConstraints.pins || {},
        { rigs: { sends: { enabled: true, chance: rigConstraints.sendChance } } },
        rng,
      );
      result.rig = rig.map((d) => d.id);
      result.rigLabel = rig.map((d) => d.name).join(' + ');
      if (routes.length) {
        result.routing = routes.map((r) => ({ fx: r.fx.id, target: r.target === SEND ? SEND : r.target.id }));
        result.routingText = routingText(routes);
      }
    } else if (sel.jamType === 'piano') {
      prompt = `Piano jam${device ? ` on the ${device.name}` : ''}. Sit down, play, and keep the recorder running.`;
    } else {
      prompt =
        'Jam on something else: a guitar, your voice, a sampler, found sounds, anything that is not a synth or a piano.';
    }
    detail.push(label('jamType'));
  } else if (sel.category === 'tracks' && sel.trackType === 'existing') {
    title = 'Existing track';
    prompt = track
      ? `Work on "${track.name}". Move it one clear step forward.`
      : 'Pick an existing track that has been waiting and move it one clear step forward.';
    detail.push(label('trackType'));
  } else if (sel.category === 'tracks' && sel.trackType === 'new') {
    title = 'New track';
    const start = {
      hardware: `Start a new track from a hardware idea ${onDevice('')}`.trim() + '.',
      assets: 'Start a new track from your existing assets. Dig through your loops and samples first.',
      jam: 'Start a new track from a jam. Record first, arrange later.',
      bpmsig: `Start a new track at ${result.bpm} BPM in ${sel.timeSig}.`,
    }[sel.startPoint];
    prompt = start;
    detail.push(label('trackType'), label('startPoint'));
    if (sel.startPoint === 'bpmsig') detail.push(`${result.bpm} BPM`, sel.timeSig);
  } else {
    title = 'Session';
    prompt = 'Roll again.';
  }

  if (device && !detail.includes(device.name)) detail.push(device.name);
  for (const d of rig) if (!detail.includes(d.name)) detail.push(d.name);
  if (plugin && !detail.includes(plugin.name)) detail.push(plugin.name);
  if (track && !detail.includes(track.name)) detail.push(track.name);
  if (pedal) result.twist = `Twist: run something through the ${pedal.name}.`;

  // Musical extras: a tempo and meter line for jams and loops (new tracks from BPM already have one), and a key.
  if (sel.startPoint === 'bpmsig') {
    result.timeSig = sel.timeSig;
    result.tempoText = `${result.bpm} BPM in ${sel.timeSig}`;
  } else if (withTempo && musicApplies(sel)) {
    const tempo = pickTempo(config, weights, rng);
    result.bpm = tempo.bpm;
    result.timeSig = tempo.timeSig;
    result.tempoText = `${tempo.bpm} BPM in ${tempo.timeSig}`;
    detail.push(`${tempo.bpm} BPM`, tempo.timeSig);
  }
  if (withKey && musicApplies(sel)) {
    const key = pickKey(weights, rng);
    result.key = { root: key.root, scale: key.scale };
    result.keyText = key.text;
    detail.push(key.text);
  }

  if (withConstraint) {
    const picked = pickConstraint(config, { ...sel, rigSize: rig.length }, rng);
    if (picked) {
      result.constraint = picked.text;
      result.constraintId = picked.id;
    }
  }

  result.title = title;
  result.prompt = prompt;
  result.detail = detail.filter(Boolean);
  result.categoryLabel = label('category');
  return result;
}

export { DEVICE_TYPES };
