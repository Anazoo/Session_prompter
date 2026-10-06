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
    assert.ok(
      c && matchesScope(c.scope, { ...r.selections, rigSize: (r.rig || []).length }),
      `${r.constraintId} fits ${JSON.stringify(r.selections)}`,
    );
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

test('presets split into instrument and effect, and effects units only design effect presets', () => {
  const rng = makeRng(47);
  let sawEffect = false;
  for (let i = 0; i < 300; i++) {
    const r = generateSession({
      locks: { category: 'assets', assetType: 'sound', soundKind: 'preset', soundMethod: 'hardware' },
      config,
      rng,
    });
    assert.ok(['instrument', 'effect'].includes(r.selections.presetKind));
    if (r.selections.presetKind === 'effect') {
      sawEffect = true;
      assert.equal(r.selections[DEVICE_DECISION], 'micro', 'the pedal is the target');
      assert.match(r.prompt, /^Design an effect preset on the Microcosm\.$/);
      assert.equal(r.twist, undefined, 'the target pedal is not also the twist');
    } else {
      assert.notEqual(r.selections[DEVICE_DECISION], 'micro');
      assert.match(r.prompt, /^Design an instrument preset on the (Prophet-6|Nord Piano)\.$/);
    }
  }
  assert.ok(sawEffect);
  const noPedal = { ...config, hardware: config.hardware.filter((h) => h.type !== 'fx') };
  const bare = generateSession({
    locks: {
      category: 'assets',
      assetType: 'sound',
      soundKind: 'preset',
      presetKind: 'effect',
      soundMethod: 'hardware',
    },
    config: noPedal,
    rng,
  });
  assert.equal(bare.prompt, 'Design an effect preset on a hardware effect.');
  for (let i = 0; i < 100; i++) {
    const other = generateSession({
      locks: { category: 'assets', assetType: 'loop', loopMethod: 'hardware' },
      config,
      rng,
    });
    assert.notEqual(other.selections[DEVICE_DECISION], 'micro', 'pedals never lead a loop');
  }
  const soft = generateSession({
    locks: {
      category: 'assets',
      assetType: 'sound',
      soundKind: 'preset',
      presetKind: 'effect',
      soundMethod: 'software',
    },
    config: { ...config, software: [{ id: 'valhalla', name: 'Valhalla', type: 'fx', weight: 5 }] },
    rng,
  });
  assert.equal(soft.prompt, 'Design an effect preset in Valhalla.');
  assert.equal(soft.twist, undefined);
});

test('constraint scopes tell drum loops from drum kits and presets from each other', () => {
  const sel = (extra) => ({ category: 'assets', ...extra });
  assert.equal(matchesScope('drumloop', sel({ assetType: 'loop', loopKind: 'drums' })), true);
  assert.equal(matchesScope('drumkit', sel({ assetType: 'loop', loopKind: 'drums' })), false);
  assert.equal(matchesScope('drumkit', sel({ assetType: 'sound', soundKind: 'drumkit' })), true);
  assert.equal(matchesScope('drumloop', sel({ assetType: 'sound', soundKind: 'drumkit' })), false);
  assert.equal(
    matchesScope('instpreset', sel({ assetType: 'sound', soundKind: 'preset', presetKind: 'instrument' })),
    true,
  );
  assert.equal(
    matchesScope('fxpreset', sel({ assetType: 'sound', soundKind: 'preset', presetKind: 'instrument' })),
    false,
  );
  assert.equal(matchesScope('fxpreset', sel({ assetType: 'sound', soundKind: 'preset', presetKind: 'effect' })), true);
  assert.equal(matchesScope('oneshot', sel({ assetType: 'sound', soundKind: 'oneshot' })), true);
  assert.equal(matchesScope('rig', { category: 'jamming', jamType: 'synth', rigSize: 2 }), true);
  assert.equal(matchesScope('rig', { category: 'jamming', jamType: 'synth', rigSize: 1 }), false);
  const scopes = new Set(BUILT_IN_CONSTRAINTS.map((c) => c.scope));
  for (const s of ['drumloop', 'drumkit', 'instpreset', 'fxpreset', 'oneshot', 'rig']) assert.ok(scopes.has(s), s);
  assert.ok(!scopes.has('drums'), 'old combined scope is gone');
});

test('effects in a rig are routed onto an instrument or a send', async () => {
  const { routeRig, routingText } = await import('../js/engine.js');
  const byId = Object.fromEntries(config.hardware.map((h) => [h.id, h]));
  const rig = [byId.p6, byId.tr8, byId.micro];
  const rng = makeRng(61);
  let sends = 0;
  let onP6 = 0;
  for (let i = 0; i < 1000; i++) {
    const routes = routeRig(rig, {}, { rigs: { sends: { enabled: true, chance: 3 } } }, rng);
    assert.equal(routes.length, 1);
    if (routes[0].target === 'send') sends++;
    else if (routes[0].target.id === 'p6') onP6++;
    else assert.equal(routes[0].target.id, 'tr8');
  }
  assert.ok(sends > 220 && sends < 380, `about 30% sends (${sends})`);
  assert.ok(onP6 > 280 && onP6 < 420, `the rest split between instruments (${onP6})`);
  for (let i = 0; i < 50; i++) {
    assert.notEqual(routeRig(rig, {}, { rigs: { sends: { enabled: false, chance: 10 } } }, rng)[0].target, 'send');
    assert.equal(routeRig(rig, {}, { rigs: { sends: { enabled: true, chance: 10 } } }, rng)[0].target, 'send');
    assert.equal(
      routeRig(rig, { micro: 'tr8' }, { rigs: { sends: { enabled: true, chance: 10 } } }, rng)[0].target.id,
      'tr8',
    );
    assert.equal(routeRig(rig, { micro: 'send' }, { rigs: { sends: { enabled: false } } }, rng)[0].target, 'send');
  }
  assert.deepEqual(routeRig([byId.micro], {}, {}, rng), [], 'no instruments, no routing');
  assert.equal(routingText([{ fx: byId.micro, target: 'send' }]), 'Microcosm on a send.');
  assert.equal(routingText([{ fx: byId.micro, target: byId.p6 }]), 'Microcosm on the Prophet-6.');

  const cfg = { ...config, rigs: { min: 2, max: 3, sends: { enabled: true, chance: 5 } } };
  let sawRouting = false;
  for (let i = 0; i < 200; i++) {
    const r = generateSession({ locks: { category: 'jamming', jamType: 'synth' }, config: cfg, rng });
    if (r.rig.includes('micro')) {
      sawRouting = true;
      assert.match(r.routingText, /^Microcosm on (a send|the .+)\.$/);
      assert.equal(r.routing.length, 1);
    } else {
      assert.equal(r.routingText, undefined);
    }
  }
  assert.ok(sawRouting);
  const pinned = generateSession({
    locks: { category: 'jamming', jamType: 'synth' },
    config: {
      ...config,
      rigConstraints: {
        min: 2,
        max: 2,
        perType: {},
        sendChance: 0,
        must: ['p6', 'micro'],
        never: [],
        pins: { micro: 'send' },
      },
    },
    rng,
  });
  assert.equal(pinned.routingText, 'Microcosm on a send.', 'a pinned send route wins even with send chance 0');
  assert.match(pinned.prompt, /^Synth jam on the Prophet-6, through the Microcosm\./);
});

test('rigs are generated from constraints: size, per type, must, never, and a lead device', async () => {
  const { enumerateRigs, pickRig, normalizeRigConstraints, defaultRigConstraints } = await import('../js/rigs.js');
  const hw = [...config.hardware, { id: 'hapax', name: 'Hapax', type: 'sequencer', weight: 5 }];
  const base = { ...defaultRigConstraints({ rigs: { min: 1, max: 2 } }) };
  const ids = (rigs) =>
    rigs
      .map((r) =>
        r
          .map((d) => d.id)
          .sort()
          .join('+'),
      )
      .sort();
  const all = ids(enumerateRigs(hw, base));
  assert.ok(all.includes('p6') && all.includes('nord') && all.includes('micro+p6') && all.includes('hapax+p6'));
  assert.ok(!all.includes('tr8') && !all.includes('micro') && !all.includes('hapax'), 'no rig without a lead device');
  assert.ok(!all.includes('micro+tr8') && !all.includes('hapax+tr8') && !all.includes('sp404+tr8'));
  const mustTr8 = ids(enumerateRigs(hw, { ...base, must: ['tr8'] }));
  assert.ok(mustTr8.length > 0 && mustTr8.every((id) => id.includes('tr8')), 'must-have devices are in every rig');
  const neverP6 = ids(enumerateRigs(hw, { ...base, never: ['p6'] }));
  assert.ok(neverP6.length > 0 && neverP6.every((id) => !id.includes('p6')), 'excluded devices never appear');
  assert.deepEqual(
    enumerateRigs(hw, { ...base, must: ['p6'], never: ['p6'] }),
    [],
    'contradictory must/never gives nothing',
  );
  const noFx = enumerateRigs(hw, { ...base, max: 3, perType: { fx: { min: 0, max: 0 } } });
  assert.ok(noFx.length && noFx.every((r) => !r.some((d) => d.type === 'fx')));
  const oneFx = enumerateRigs(hw, { ...base, max: 3, perType: { fx: { min: 1, max: 1 } } });
  assert.ok(oneFx.length && oneFx.every((r) => r.filter((d) => d.type === 'fx').length === 1));
  const exactlyThree = enumerateRigs(hw, { ...base, min: 3, max: 3 });
  assert.ok(exactlyThree.length && exactlyThree.every((r) => r.length === 3));
  assert.equal(
    pickRig(hw, { ...base, must: ['p6', 'tr8', 'micro', 'nord', 'hapax'] }, makeRng(1)),
    null,
    'more musts than max',
  );

  const rng = makeRng(67);
  let sawPenalised = 0;
  for (let i = 0; i < 300; i++) {
    const rig = pickRig(hw, base, rng, (id) => (id === 'p6' ? 0.05 : 1));
    if (rig.some((d) => d.id === 'p6')) sawPenalised++;
  }
  assert.ok(sawPenalised < 60, `rotation penalty makes p6 rare (${sawPenalised}/300)`);

  const norm = normalizeRigConstraints(
    {
      min: 9,
      max: 0,
      perType: { fx: { min: 2, max: 1 }, nope: { min: 1 } },
      sendChance: 99,
      must: ['p6', 'ghost', 'micro'],
      never: ['p6', 'tr8'],
      pins: { micro: 'send', p6: 'send' },
    },
    { hardware: hw, rigs: { min: 1, max: 2 } },
  );
  assert.deepEqual(norm, {
    min: 1,
    max: 4,
    perType: { fx: { min: 1, max: 2 } },
    sendChance: 10,
    must: ['p6', 'micro'],
    never: ['tr8'],
    pins: { micro: 'send' },
  });
});

test('synth jams use the rig constraints and name every device, sequencers and grooveboxes included', () => {
  const rng = makeRng(53);
  const hw = [
    ...config.hardware,
    { id: 'hapax', name: 'Hapax', type: 'sequencer', weight: 5 },
    { id: 'deluge', name: 'Deluge', type: 'groovebox', weight: 5 },
  ];
  const cfg = { ...config, hardware: hw, rigs: { min: 2, max: 3, sends: { enabled: true, chance: 5 } } };
  let sawThree = false;
  let sawPedal = false;
  for (let i = 0; i < 300; i++) {
    const r = generateSession({
      locks: { category: 'jamming', jamType: 'synth' },
      config: cfg,
      rng,
      withConstraint: true,
    });
    assert.match(r.prompt, /^Synth jam on the .+ (with|through|sequenced by) the .+\. No goal/);
    assert.ok(r.rig.length >= 2 && r.rig.length <= 3);
    assert.equal(r.selections[DEVICE_DECISION], undefined, 'single-device pick is not used for synth jams');
    if (r.rig.length === 3) sawThree = true;
    if (r.rig.includes('micro')) {
      sawPedal = true;
      assert.match(r.prompt, /through the Microcosm\./);
    }
    for (const id of r.rig) assert.ok(r.detail.includes(hw.find((d) => d.id === id).name));
  }
  assert.ok(sawThree && sawPedal);
  const lock = (must, extra = {}) => ({
    ...cfg,
    rigConstraints: { min: must.length, max: must.length, perType: {}, sendChance: 0, must, never: [], pins: {} },
    ...extra,
  });
  const seq = generateSession({ locks: { category: 'jamming', jamType: 'synth' }, config: lock(['p6', 'hapax']), rng });
  assert.equal(
    seq.prompt,
    'Synth jam on the Prophet-6, sequenced by the Hapax. No goal, just play and record everything.',
  );
  assert.equal(seq.routingText, undefined);
  const three = generateSession({
    locks: { category: 'jamming', jamType: 'synth' },
    config: lock(['p6', 'tr8', 'micro']),
    rng,
  });
  assert.equal(
    three.prompt,
    'Synth jam on the Prophet-6 with the TR-8S, through the Microcosm. No goal, just play and record everything.',
  );
  const boxPlain = generateSession({
    locks: { category: 'jamming', jamType: 'synth' },
    config: lock(['p6', 'deluge']),
    rng,
  });
  assert.equal(
    boxPlain.prompt,
    'Synth jam on the Prophet-6 with the Deluge. No goal, just play and record everything.',
  );
  const boxSeq = generateSession({
    locks: { category: 'jamming', jamType: 'synth' },
    config: lock(['p6', 'deluge'], { rigs: { ...cfg.rigs, grooveboxSequences: true } }),
    rng,
  });
  assert.equal(
    boxSeq.prompt,
    'Synth jam on the Prophet-6, sequenced by the Deluge. No goal, just play and record everything.',
  );
  const boxAlone = generateSession({
    locks: { category: 'jamming', jamType: 'synth' },
    config: lock(['deluge'], { rigs: { ...cfg.rigs, grooveboxSequences: true } }),
    rng,
  });
  assert.equal(
    boxAlone.prompt,
    'Synth jam on the Deluge. No goal, just play and record everything.',
    'a lone groovebox still plays',
  );
  const impossible = generateSession({
    locks: { category: 'jamming', jamType: 'synth' },
    config: {
      ...cfg,
      rigConstraints: { min: 1, max: 1, perType: {}, sendChance: 0, must: ['p6', 'tr8'], never: [], pins: {} },
    },
    rng,
  });
  assert.match(impossible.prompt, /^Synth jam on any synth\./);
  assert.ok(impossible.rigNotice);
  for (let i = 0; i < 100; i++) {
    const loop = generateSession({
      locks: { category: 'assets', assetType: 'loop', loopMethod: 'hardware' },
      config: cfg,
      rng,
    });
    assert.notEqual(loop.selections[DEVICE_DECISION], 'hapax', 'sequencers never lead a loop');
  }
});

test('gear rotation lowers the odds of recently used gear, constraints and twists', () => {
  const rng = makeRng(71);
  const recent = { devices: new Set(['p6']), constraints: new Set(['c-one-hand']), twists: new Set(['micro']) };
  const on = { ...config, rotation: { enabled: true, strength: 10, includeConstraints: true }, recent };
  const off = { ...config, rotation: { enabled: false }, recent };
  let p6On = 0;
  let p6Off = 0;
  for (let i = 0; i < 400; i++) {
    const a = generateSession({
      locks: { category: 'assets', assetType: 'loop', loopKind: 'pad', loopMethod: 'hardware' },
      config: on,
      rng,
    });
    const b = generateSession({
      locks: { category: 'assets', assetType: 'loop', loopKind: 'pad', loopMethod: 'hardware' },
      config: off,
      rng,
    });
    if (a.selections[DEVICE_DECISION] === 'p6') p6On++;
    if (b.selections[DEVICE_DECISION] === 'p6') p6Off++;
  }
  assert.ok(p6On < 60 && p6Off > 150, `rotation on ${p6On}, off ${p6Off}`);
  let oneHand = 0;
  for (let i = 0; i < 300; i++) {
    const r = generateSession({
      locks: { category: 'jamming', jamType: 'piano' },
      config: on,
      rng,
      withConstraint: true,
    });
    if (r.constraintId === 'c-one-hand') oneHand++;
  }
  assert.ok(oneHand < 15, `recent constraint rare (${oneHand})`);
  const noConstraintRotation = { ...on, rotation: { ...on.rotation, includeConstraints: false } };
  let oneHandPlain = 0;
  for (let i = 0; i < 300; i++) {
    const r = generateSession({
      locks: { category: 'jamming', jamType: 'piano' },
      config: noConstraintRotation,
      rng,
      withConstraint: true,
    });
    if (r.constraintId === 'c-one-hand') oneHandPlain++;
  }
  assert.ok(oneHandPlain > 25, `constraint rotation can be switched off (${oneHandPlain})`);
});
