// Decision tree for a session.
//
// A session is resolved by walking DECISIONS in order. Each decision applies only
// when its `parent` (a [decisionId, optionId] pair) or `anyOf` (a list of such
// pairs) matches what has already been chosen. Options can carry `requires`, a map
// of decisionId -> allowed option ids, which constrains other decisions in both
// directions (an option that requires X limits X, and a chosen X limits it).
//
// Options carry a default `weight`; the user overrides weights in Settings.

export const DEFAULT_WEIGHT = 5;

export const DEVICE_TYPES = {
  synth: {
    label: 'Synth',
    jam: true,
    requires: {
      loopKind: ['pad', 'chords', 'melodic', 'soundscape'],
      soundKind: ['preset', 'oneshot'],
      presetKind: ['instrument'],
      jamType: ['synth'],
    },
  },
  drums: {
    label: 'Drum machine',
    requires: {
      loopKind: ['drums'],
      soundKind: ['drumkit', 'oneshot'],
      jamType: [],
    },
  },
  sampler: {
    label: 'Sampler',
    requires: {
      soundKind: ['oneshot'],
      jamType: [],
    },
  },
  groovebox: {
    label: 'Groovebox',
    jam: true,
    requires: {
      presetKind: ['instrument'],
      jamType: ['synth'],
    },
  },
  keys: {
    label: 'Keys / piano',
    jam: true,
    requires: {
      loopKind: ['pad', 'chords', 'melodic'],
      soundKind: ['preset'],
      presetKind: ['instrument'],
      jamType: ['piano', 'synth'],
    },
  },
  fx: {
    label: 'Effects / pedal',
    role: 'fx',
    // Effects only ever star in one place: designing an effect preset.
    requires: {
      loopMethod: [],
      loopKind: [],
      soundKind: ['preset'],
      presetKind: ['effect'],
      jamType: [],
      startPoint: [],
    },
  },
  other: {
    label: 'Other instrument',
    jam: true,
    requires: {
      presetKind: ['instrument'],
      jamType: ['synth'],
    },
  },
};

export const DEVICE_TYPE_IDS = Object.keys(DEVICE_TYPES);

// Static decisions. `hint` is shown in Settings next to the group.
export const STATIC_DECISIONS = [
  {
    id: 'category',
    label: 'Session type',
    options: [
      { id: 'assets', label: 'Assets creation' },
      { id: 'jamming', label: 'Jamming' },
      { id: 'tracks', label: 'Working on tracks' },
    ],
  },
  {
    id: 'assetType',
    label: 'Asset type',
    parent: ['category', 'assets'],
    options: [
      { id: 'loop', label: 'Loop creation' },
      { id: 'sound', label: 'Sound design' },
    ],
  },
  {
    id: 'loopKind',
    label: 'Loop type',
    parent: ['assetType', 'loop'],
    options: [
      { id: 'pad', label: 'Pad' },
      { id: 'chords', label: 'Chord progression' },
      { id: 'melodic', label: 'Melodic' },
      { id: 'drums', label: 'Drum loop' },
      { id: 'soundscape', label: 'Soundscape' },
    ],
  },
  {
    id: 'loopMethod',
    label: 'Method',
    parent: ['assetType', 'loop'],
    options: [
      { id: 'hardware', label: 'Hardware' },
      { id: 'software', label: 'Software' },
      { id: 'live', label: 'Live recording' },
    ],
  },
  {
    id: 'soundKind',
    label: 'Sound design target',
    parent: ['assetType', 'sound'],
    options: [
      { id: 'drumkit', label: 'Drum kit' },
      { id: 'preset', label: 'Preset' },
      { id: 'oneshot', label: 'One-shot' },
    ],
  },
  {
    id: 'presetKind',
    label: 'Preset type',
    parent: ['soundKind', 'preset'],
    options: [
      { id: 'instrument', label: 'Instrument preset' },
      { id: 'effect', label: 'Effect preset' },
    ],
  },
  {
    id: 'soundMethod',
    label: 'Method',
    parent: ['assetType', 'sound'],
    hint: 'Live recording is only offered for one-shots.',
    options: [
      { id: 'hardware', label: 'Hardware' },
      { id: 'software', label: 'Software' },
      { id: 'live', label: 'Live recording', requires: { soundKind: ['oneshot'] } },
    ],
  },
  {
    id: 'jamType',
    label: 'Jam type',
    parent: ['category', 'jamming'],
    options: [
      { id: 'synth', label: 'Synth jam' },
      { id: 'piano', label: 'Piano jam' },
      { id: 'other', label: 'Other' },
    ],
  },
  {
    id: 'trackType',
    label: 'Track',
    parent: ['category', 'tracks'],
    options: [
      { id: 'existing', label: 'Existing track' },
      { id: 'new', label: 'New track' },
    ],
  },
  {
    id: 'startPoint',
    label: 'Starting point',
    parent: ['trackType', 'new'],
    options: [
      { id: 'hardware', label: 'Hardware' },
      { id: 'assets', label: 'Your assets' },
      { id: 'jam', label: 'A jam' },
      { id: 'bpmsig', label: 'BPM & time signature' },
    ],
  },
  {
    id: 'timeSig',
    label: 'Time signature',
    parent: ['startPoint', 'bpmsig'],
    options: [
      { id: '4/4', label: '4/4', weight: 8 },
      { id: '3/4', label: '3/4', weight: 3 },
      { id: '6/8', label: '6/8', weight: 3 },
      { id: '5/4', label: '5/4', weight: 1 },
      { id: '7/8', label: '7/8', weight: 1 },
    ],
  },
];

// Ids of the decisions that are generated from user lists (hardware, software, tracks).
export const DEVICE_DECISION = 'device';
export const RIG_DECISION = 'rig';
export const SOFTWARE_DECISION = 'software';
export const TRACK_DECISION = 'track';
export const FX_DECISION = 'fxTwist';
export const FX_NONE = 'none';

const HARDWARE_CONTEXTS = [
  ['loopMethod', 'hardware'],
  ['soundMethod', 'hardware'],
  ['startPoint', 'hardware'],
  ['jamType', 'piano'],
];

export const RIG_MAX_SIZE = 4;

/** Everything that can be part of a jam rig: instruments, rhythm boxes and effects. */
export function jamDevices(hardware = []) {
  return hardware.filter((h) => DEVICE_TYPES[h.type]);
}

/** Can this set of devices be a rig at all? It needs at least one instrument (not only effects). */
export function isValidRig(devices) {
  return devices.length > 0 && devices.some((d) => DEVICE_TYPES[d.type]?.role !== 'fx');
}

function combinations(items, size) {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items;
  return [...combinations(rest, size - 1).map((c) => [first, ...c]), ...combinations(rest, size)];
}

export function rigId(deviceIds) {
  return [...deviceIds].sort().join('+');
}

/**
 * Every hardware jam rig: generated combinations within the size range plus custom rigs,
 * each flagged with whether the user switched it off.
 * @returns {Array<{id: string, devices: object[], label: string, weight: number, custom: boolean, excluded: boolean}>}
 */
export function allJamRigs(config = {}) {
  const hardware = config.hardware || [];
  const rigs = config.rigs || {};
  const min = Math.max(1, Math.min(RIG_MAX_SIZE, rigs.min ?? 1));
  const max = Math.max(min, Math.min(RIG_MAX_SIZE, rigs.max ?? 2));
  const excluded = new Set(rigs.excluded || []);
  const byId = new Map(hardware.map((h) => [h.id, h]));
  const pool = jamDevices(hardware);
  const seen = new Set();
  const out = [];
  const push = (devices, custom) => {
    const id = rigId(devices.map((d) => d.id));
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      devices,
      label: devices.map((d) => d.name).join(' + '),
      weight: Math.round(devices.reduce((sum, d) => sum + (d.weight ?? DEFAULT_WEIGHT), 0) / devices.length),
      custom,
      excluded: excluded.has(id),
    });
  };
  for (let size = min; size <= max; size++) {
    for (const combo of combinations(pool, size)) {
      // A synth jam needs at least one device that can lead it.
      if (combo.some((d) => DEVICE_TYPES[d.type]?.jam)) push(combo, false);
    }
  }
  for (const rig of rigs.custom || []) {
    const devices = (rig.devices || []).map((id) => byId.get(id)).filter(Boolean);
    if (isValidRig(devices)) push(devices, true);
  }
  return out;
}

/** The rigs that can actually be rolled. */
export function jamRigs(config = {}) {
  return allJamRigs(config).filter((r) => !r.excluded);
}

const SOFTWARE_CONTEXTS = [
  ['loopMethod', 'software'],
  ['soundMethod', 'software'],
];

function toOption(item) {
  return {
    id: item.id,
    label: item.name,
    weight: item.weight ?? DEFAULT_WEIGHT,
    requires: DEVICE_TYPES[item.type]?.requires || {},
    deviceType: item.type,
  };
}

/**
 * Build the full ordered decision list for a given configuration.
 * @param {{hardware?: Array<{id:string,name:string,type:string,weight?:number}>, software?: Array<{id:string,name:string,type:string,weight?:number}>, tracks?: Array<{id:string,name:string}>}} config
 */
export function buildDecisions(config = {}) {
  const hardware = config.hardware || [];
  const software = config.software || [];
  const tracks = config.tracks || [];
  const decisions = [...STATIC_DECISIONS];

  if (hardware.length) {
    decisions.push({
      id: DEVICE_DECISION,
      label: 'Gear',
      dynamic: true,
      optional: true,
      anyOf: HARDWARE_CONTEXTS,
      options: hardware.map(toOption),
    });
  }

  const rigs = jamRigs(config);
  if (rigs.length) {
    decisions.push({
      id: RIG_DECISION,
      label: 'Jam rig',
      dynamic: true,
      optional: true,
      parent: ['jamType', 'synth'],
      options: rigs.map((r) => ({ id: r.id, label: r.label, weight: r.weight, devices: r.devices.map((d) => d.id) })),
    });
  }

  const plugins = software;
  if (plugins.length) {
    decisions.push({
      id: SOFTWARE_DECISION,
      label: 'Software',
      dynamic: true,
      optional: true,
      anyOf: SOFTWARE_CONTEXTS,
      options: plugins.map(toOption),
    });
  }

  if (tracks.length) {
    decisions.push({
      id: TRACK_DECISION,
      label: 'Which track',
      dynamic: true,
      optional: true,
      parent: ['trackType', 'existing'],
      options: tracks.map((t) => ({ id: t.id, label: t.name, weight: DEFAULT_WEIGHT })),
    });
  }

  const effects = [...hardware, ...software].filter((h) => DEVICE_TYPES[h.type]?.role === 'fx');
  if (effects.length) {
    decisions.push({
      id: FX_DECISION,
      label: 'Effects twist',
      dynamic: true,
      optional: true,
      hint: 'An optional extra: run something through one of your effects.',
      anyOf: [
        ['category', 'assets'],
        ['category', 'tracks'],
      ],
      options: [
        { id: FX_NONE, label: 'No twist', weight: 10 },
        ...effects.map((h) => ({
          id: h.id,
          label: h.name,
          weight: h.weight ?? DEFAULT_WEIGHT,
          deviceType: h.type,
        })),
      ],
    });
  }

  return decisions;
}

export function findDecision(decisions, id) {
  return decisions.find((d) => d.id === id);
}

export function findOption(decision, optionId) {
  return decision?.options.find((o) => o.id === optionId);
}
