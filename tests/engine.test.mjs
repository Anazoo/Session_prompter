import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSession,
  isCompatible,
  makeRng,
  optionWeight,
  pruneLocks,
  resolve,
  weightedPick,
} from '../js/engine.js';
import { DEVICE_DECISION, FX_DECISION, FX_NONE, TRACK_DECISION, buildDecisions, findDecision } from '../js/tree.js';
import { BUILT_IN_CONSTRAINTS, matchesScope } from '../js/constraints.js';

const config = {
  hardware: [
    { id: 'p6', name: 'Prophet-6', type: 'synth', weight: 5 },
    { id: 'tr8', name: 'TR-8S', type: 'drums', weight: 5 },
    { id: 'sp404', name: 'SP-404', type: 'sampler', weight: 5 },
    { id: 'nord', name: 'Nord Piano', type: 'keys', weight: 5 },
    { id: 'micro', name: 'Microcosm', type: 'fx', weight: 5 },
  ],
  tracks: [
    { id: 't1', name: 'Blue Hour' },
    { id: 't2', name: 'Drift' },
  ],
  bpm: { min: 90, max: 120 },
};

function runMany(args, n = 400) {
  const rng = makeRng(42);
  const out = [];
  for (let i = 0; i < n; i++) out.push(generateSession({ ...args, rng }));
  return out;
}

test('weightedPick honours zero weights and never returns unpickable items', () => {
  const rng = makeRng(1);
  const items = [
    { id: 'a', w: 0 },
    { id: 'b', w: 3 },
    { id: 'c', w: 0 },
  ];
  for (let i = 0; i < 200; i++) {
    assert.equal(weightedPick(items, (x) => x.w, rng)?.id, 'b');
  }
  assert.equal(
    weightedPick(items, () => 0, rng),
    null,
  );
});

test('weightedPick follows the weights roughly', () => {
  const rng = makeRng(7);
  const items = [
    { id: 'a', w: 1 },
    { id: 'b', w: 3 },
  ];
  let b = 0;
  const n = 5000;
  for (let i = 0; i < n; i++) if (weightedPick(items, (x) => x.w, rng).id === 'b') b++;
  const share = b / n;
  assert.ok(share > 0.7 && share < 0.8, `expected ~0.75, got ${share}`);
});

test('optionWeight applies overrides and clamps negatives', () => {
  const decisions = buildDecisions();
  const category = findDecision(decisions, 'category');
  const jamming = category.options[1];
  assert.equal(optionWeight(category, jamming, {}), 5);
  assert.equal(optionWeight(category, jamming, { category: { jamming: 2 } }), 2);
  assert.equal(optionWeight(category, jamming, { category: { jamming: -4 } }), 0);
});

test('resolve fills every applicable decision and nothing else', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 300; i++) {
    const { selections, conflicts } = resolve({ config, rng });
    assert.deepEqual(conflicts, []);
    assert.ok(selections.category);
    if (selections.category === 'assets') {
      assert.ok(selections.assetType);
      assert.equal(selections.jamType, undefined);
      assert.equal(selections.trackType, undefined);
      if (selections.assetType === 'loop') {
        assert.ok(selections.loopKind && selections.loopMethod);
        assert.equal(selections.soundKind, undefined);
      } else {
        assert.ok(selections.soundKind && selections.soundMethod);
        assert.equal(selections.loopKind, undefined);
      }
    }
    if (selections.category === 'jamming') assert.ok(selections.jamType);
    if (selections.category === 'tracks') {
      assert.ok(selections.trackType);
      if (selections.trackType === 'new') assert.ok(selections.startPoint);
      if (selections.startPoint === 'bpmsig') assert.ok(selections.timeSig);
      else assert.equal(selections.timeSig, undefined);
    }
  }
});

test('live recording for sound design only happens with one-shots', () => {
  const rng = makeRng(11);
  let seenLive = false;
  for (let i = 0; i < 500; i++) {
    const { selections } = resolve({ locks: { category: 'assets', assetType: 'sound' }, config, rng });
    if (selections.soundMethod === 'live') {
      seenLive = true;
      assert.equal(selections.soundKind, 'oneshot');
    }
  }
  assert.ok(seenLive, 'live recording should still be reachable');
});

test('locking live recording forces the one-shot target', () => {
  const rng = makeRng(5);
  for (let i = 0; i < 50; i++) {
    const { selections, locked, conflicts } = resolve({
      locks: { category: 'assets', assetType: 'sound', soundMethod: 'live' },
      config,
      rng,
    });
    assert.deepEqual(conflicts, []);
    assert.equal(selections.soundKind, 'oneshot');
    assert.equal(locked.soundMethod, true);
    assert.equal(locked.soundKind, undefined);
  }
});

test('locking preset excludes live recording', () => {
  const rng = makeRng(9);
  for (let i = 0; i < 200; i++) {
    const { selections } = resolve({
      locks: { category: 'assets', assetType: 'sound', soundKind: 'preset' },
      config,
      rng,
    });
    assert.notEqual(selections.soundMethod, 'live');
  }
});

test('a conflicting pair of locks is reported and rerolled instead of crashing', () => {
  const { selections, conflicts } = resolve({
    locks: { category: 'assets', assetType: 'sound', soundKind: 'preset', soundMethod: 'live' },
    config,
    rng: makeRng(2),
  });
  assert.equal(conflicts.length, 1);
  assert.equal(selections.soundKind, 'preset');
  assert.notEqual(selections.soundMethod, 'live');
});

test('gear is picked to suit the task', () => {
  const rng = makeRng(21);
  for (let i = 0; i < 300; i++) {
    const { selections } = resolve({
      locks: { category: 'assets', assetType: 'loop', loopMethod: 'hardware' },
      config,
      rng,
    });
    const device = selections[DEVICE_DECISION];
    if (selections.loopKind === 'drums') {
      assert.ok(['tr8', 'sp404'].includes(device), `drums picked ${device}`);
    } else {
      assert.notEqual(device, 'tr8');
    }
    assert.notEqual(device, 'micro', 'pedals are never the main instrument');
  }
});

test('locking a drum machine narrows the loop type to drums', () => {
  const rng = makeRng(8);
  for (let i = 0; i < 50; i++) {
    const { selections, conflicts } = resolve({
      locks: { category: 'assets', assetType: 'loop', loopMethod: 'hardware', [DEVICE_DECISION]: 'tr8' },
      config,
      rng,
    });
    assert.deepEqual(conflicts, []);
    assert.equal(selections.loopKind, 'drums');
  }
});

test('piano jam picks keys when available, otherwise no gear', () => {
  const rng = makeRng(13);
  for (let i = 0; i < 50; i++) {
    const { selections } = resolve({ locks: { category: 'jamming', jamType: 'piano' }, config, rng });
    assert.equal(selections[DEVICE_DECISION], 'nord');
  }
  const noKeys = { ...config, hardware: config.hardware.filter((h) => h.type !== 'keys') };
  const { selections, conflicts } = resolve({ locks: { category: 'jamming', jamType: 'piano' }, config: noKeys, rng });
  assert.deepEqual(conflicts, []);
  assert.equal(selections[DEVICE_DECISION], undefined);
});

test('gear is not chosen for software or live sessions', () => {
  const rng = makeRng(17);
  for (let i = 0; i < 100; i++) {
    const { selections } = resolve({
      locks: { category: 'assets', assetType: 'loop', loopMethod: 'software' },
      config,
      rng,
    });
    assert.equal(selections[DEVICE_DECISION], undefined);
  }
});

test('weights of zero remove an option; all-zero falls back to an even pick', () => {
  const rng = makeRng(19);
  for (let i = 0; i < 200; i++) {
    const { selections } = resolve({ weights: { category: { jamming: 0, tracks: 0 } }, config, rng });
    assert.equal(selections.category, 'assets');
  }
  const { selections } = resolve({ weights: { category: { assets: 0, jamming: 0, tracks: 0 } }, config, rng });
  assert.ok(selections.category);
});

test('pruneLocks drops locks whose parent changed', () => {
  const decisions = buildDecisions(config);
  const pruned = pruneLocks(decisions, { category: 'jamming', assetType: 'loop', loopKind: 'pad', jamType: 'synth' });
  assert.deepEqual(pruned, { category: 'jamming', jamType: 'synth' });
});

test('isCompatible mirrors requirements in both directions', () => {
  const decisions = buildDecisions(config);
  const soundKind = findDecision(decisions, 'soundKind');
  const preset = soundKind.options.find((o) => o.id === 'preset');
  const oneshot = soundKind.options.find((o) => o.id === 'oneshot');
  assert.equal(isCompatible(decisions, soundKind, preset, { soundMethod: 'live' }), false);
  assert.equal(isCompatible(decisions, soundKind, oneshot, { soundMethod: 'live' }), true);
  assert.equal(isCompatible(decisions, soundKind, preset, { soundMethod: 'hardware' }), true);
});

test('generateSession produces text for every outcome', () => {
  const results = runMany({ config }, 600);
  const titles = new Set();
  for (const r of results) {
    assert.ok(r.title.length > 0);
    assert.ok(r.prompt.length > 10, r.prompt);
    assert.ok(Array.isArray(r.detail) && r.detail.length > 0);
    assert.ok(!r.prompt.includes('undefined'), r.prompt);
    assert.ok(!r.prompt.includes('  '), `double space in "${r.prompt}"`);
    titles.add(r.title);
    if (r.selections.startPoint === 'bpmsig') {
      assert.ok(r.bpm >= 90 && r.bpm <= 120);
      assert.match(r.prompt, /\d+ BPM in \d+\/\d+/);
    } else {
      assert.equal(r.bpm, undefined);
    }
    if (r.twist) assert.match(r.twist, /Microcosm/);
  }
  assert.deepEqual([...titles].sort(), [
    'Existing track',
    'Free jam',
    'Loop creation',
    'New track',
    'Piano jam',
    'Sound design',
    'Synth jam',
  ]);
});

test('generateSession names gear and tracks in the prompt', () => {
  const rng = makeRng(23);
  const loop = generateSession({
    locks: { category: 'assets', assetType: 'loop', loopKind: 'pad', loopMethod: 'hardware' },
    config,
    rng,
  });
  assert.match(loop.prompt, /on the (Prophet-6|Nord Piano|SP-404)/);
  const existing = generateSession({
    locks: { category: 'tracks', trackType: 'existing', [TRACK_DECISION]: 't2' },
    config,
    rng,
  });
  assert.match(existing.prompt, /"Drift"/);
  const empty = generateSession({
    locks: { category: 'assets', assetType: 'loop', loopMethod: 'hardware' },
    config: {},
    rng,
  });
  assert.match(empty.prompt, /on hardware\.$/);
});

test('effects twist can be locked off or on', () => {
  const rng = makeRng(29);
  const off = generateSession({ locks: { category: 'assets', [FX_DECISION]: FX_NONE }, config, rng });
  assert.equal(off.twist, undefined);
  const on = generateSession({ locks: { category: 'assets', [FX_DECISION]: 'micro' }, config, rng });
  assert.match(on.twist, /Microcosm/);
  const jam = generateSession({ locks: { category: 'jamming', [FX_DECISION]: 'micro' }, config, rng });
  assert.equal(jam.twist, undefined, 'twists do not apply to jams');
});

test('software list names plugins for software sessions only', () => {
  const rng = makeRng(31);
  const withSoftware = {
    ...config,
    software: [
      { id: 'serum', name: 'Serum', type: 'synth', weight: 5 },
      { id: 'valhalla', name: 'Valhalla', type: 'fx', weight: 5 },
    ],
  };
  for (let i = 0; i < 100; i++) {
    const soft = generateSession({
      locks: { category: 'assets', assetType: 'loop', loopKind: 'pad', loopMethod: 'software' },
      config: withSoftware,
      rng,
    });
    assert.match(soft.prompt, /in Serum\.$/);
    assert.equal(soft.selections[DEVICE_DECISION], undefined);
    const hard = generateSession({
      locks: { category: 'assets', assetType: 'loop', loopMethod: 'hardware' },
      config: withSoftware,
      rng,
    });
    assert.equal(hard.selections.software, undefined);
    if (hard.twist) assert.match(hard.twist, /Microcosm|Valhalla/);
  }
  const drums = generateSession({
    locks: { category: 'assets', assetType: 'loop', loopKind: 'drums', loopMethod: 'software' },
    config: withSoftware,
    rng,
  });
  assert.match(drums.prompt, /in the box \(software\)\.$/, 'a synth plugin is not offered for drum loops');
});

test('creative constraints are rolled only when chosen and always fit the session', () => {
  const rng = makeRng(37);
  const ids = new Map(BUILT_IN_CONSTRAINTS.map((c) => [c.id, c]));
  for (let i = 0; i < 400; i++) {
    const r = generateSession({ config, rng, withConstraint: true });
    assert.ok(r.constraint, 'a constraint text is picked');
    assert.equal(r.selections.constraint, undefined, 'the constraint is not a tree decision');
    const c = ids.get(r.constraintId);
    assert.ok(c && matchesScope(c.scope, r.selections), `${r.constraintId} fits ${JSON.stringify(r.selections)}`);
  }
  const off = generateSession({ config, rng });
  assert.equal(off.constraint, undefined, 'off by default');
  const drums = generateSession({
    locks: { category: 'assets', assetType: 'loop', loopKind: 'drums' },
    config,
    rng,
    withConstraint: true,
  });
  assert.ok(drums.constraint);
  assert.notEqual(drums.constraintId, 'c-mode', 'melodic rules never land on drum loops');
});

test('constraints respect switches and custom additions', () => {
  const rng = makeRng(41);
  const custom = { id: 'mine', text: 'Only the white keys.', scope: 'jamming' };
  const disabled = ['c-one-hand', 'c-one-chord', 'c-play-along', 'c-never-stop'];
  const cfg = { ...config, constraints: { disabled: [...disabled, 'c-three-sounds'], custom: [custom] } };
  let sawCustom = false;
  for (let i = 0; i < 300; i++) {
    const r = generateSession({ locks: { category: 'jamming' }, config: cfg, rng, withConstraint: true });
    assert.ok(!disabled.includes(r.constraintId) && r.constraintId !== 'c-three-sounds');
    if (r.constraintId === 'mine') {
      sawCustom = true;
      assert.equal(r.constraint, 'Only the white keys.');
    }
  }
  assert.ok(sawCustom);
  const everythingOff = {
    ...config,
    constraints: { disabled: BUILT_IN_CONSTRAINTS.map((c) => c.id), custom: [] },
  };
  const none = generateSession({ config: everythingOff, rng, withConstraint: true });
  assert.equal(none.constraint, undefined, 'no pool means no line, no crash');
});

test('pickConstraint avoids the current rule when it can', async () => {
  const { pickConstraint } = await import('../js/engine.js');
  const rng = makeRng(43);
  const sel = { category: 'jamming', jamType: 'synth' };
  for (let i = 0; i < 50; i++) {
    assert.notEqual(pickConstraint(config, sel, rng, 'c-one-hand').id, 'c-one-hand');
  }
  const single = {
    constraints: { disabled: BUILT_IN_CONSTRAINTS.filter((c) => c.id !== 'c-one-hand').map((c) => c.id), custom: [] },
  };
  assert.equal(pickConstraint(single, sel, rng, 'c-one-hand').id, 'c-one-hand', 'a pool of one still returns it');
  assert.equal(pickConstraint({ constraints: { disabled: BUILT_IN_CONSTRAINTS.map((c) => c.id) } }, sel, rng), null);
});
