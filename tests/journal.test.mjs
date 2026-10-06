import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, makeBackup, makeEntry, parseBackup, summarize } from '../js/journal.js';
import { normalizeSettings } from '../js/store.js';

const session = {
  categoryLabel: 'Jamming',
  title: 'Synth jam',
  prompt: 'Synth jam on the Prophet-6.',
  detail: ['Synth jam', 'Prophet-6'],
  selections: { category: 'jamming', jamType: 'synth', device: 'p6' },
};

test('makeEntry snapshots the session and trims notes', () => {
  const entry = makeEntry(session, { notes: '  great take  ', elapsedMs: 60000, plannedMs: 3600000 });
  assert.equal(entry.prompt, session.prompt);
  assert.equal(entry.notes, 'great take');
  assert.deepEqual(entry.selections, session.selections);
  assert.notEqual(entry.selections, session.selections, 'selections are copied');
  assert.equal(entry.audio, null);
  assert.ok(entry.id && entry.createdAt);
});

test('summarize totals time and counts by category', () => {
  const entries = [
    makeEntry(session, { elapsedMs: 30 * 60000, createdAt: 3 }),
    makeEntry({ ...session, categoryLabel: 'Assets creation' }, { elapsedMs: 60 * 60000, createdAt: 2 }),
    makeEntry(session, { elapsedMs: null, createdAt: 1 }),
  ];
  const s = summarize(entries);
  assert.equal(s.count, 3);
  assert.equal(s.totalMs, 90 * 60000);
  assert.deepEqual(s.byCategory, { Jamming: 2, 'Assets creation': 1 });
  assert.equal(s.lastByCategory.Jamming, 3);
  assert.equal(s.last, entries[0]);
});

test('formatDuration is readable', () => {
  assert.equal(formatDuration(0), '0 min');
  assert.equal(formatDuration(45000), '45 s');
  assert.equal(formatDuration(25 * 60000), '25 min');
  assert.equal(formatDuration(60 * 60000), '1 h');
  assert.equal(formatDuration(95 * 60000), '1 h 35 min');
});

test('backup round-trips settings and journal without audio', () => {
  const settings = normalizeSettings({
    hardware: [{ name: 'TR-8S', type: 'drums' }],
    software: [{ name: 'Serum', type: 'synth' }],
  });
  const entry = makeEntry(session, {
    notes: 'keeper',
    audio: { name: 'take.m4a', type: 'audio/mp4', size: 1234, blob: new Blob(['x']) },
  });
  const backup = makeBackup(settings, [entry]);
  assert.equal(backup.journal[0].audio.omitted, true);
  assert.equal(backup.journal[0].audio.blob, undefined);
  const text = JSON.stringify(backup);
  const parsed = parseBackup(JSON.parse(text));
  assert.equal(parsed.settings.hardware[0].name, 'TR-8S');
  assert.equal(parsed.settings.software[0].name, 'Serum');
  assert.equal(parsed.journal.length, 1);
  assert.equal(parsed.journal[0].notes, 'keeper');
  assert.deepEqual(parsed.journal[0].audio, { name: 'take.m4a', type: 'audio/mp4', size: 1234, omitted: true });
  assert.equal(normalizeSettings(parsed.settings).software[0].type, 'synth');
});

test('parseBackup accepts a bare settings object and rejects junk', () => {
  const parsed = parseBackup({ weights: { category: { jamming: 0 } } });
  assert.equal(parsed.settings.weights.category.jamming, 0);
  assert.deepEqual(parsed.journal, []);
  assert.throws(() => parseBackup({ hello: 'world' }));
  assert.throws(() => parseBackup('nope'));
});

test('settings keep rig defaults, presets and rotation options', () => {
  const s = normalizeSettings({
    hardware: [
      { id: 'p6', name: 'Prophet-6', type: 'synth' },
      { id: 'micro', name: 'Microcosm', type: 'fx' },
      { id: 'hapax', name: 'Hapax', type: 'sequencer' },
    ],
    rigs: {
      min: 2,
      max: 9,
      perType: { fx: { min: 3, max: 1 }, bogus: { min: 1, max: 1 } },
      sends: { enabled: false, chance: 42 },
      grooveboxSequences: true,
    },
    rigPresets: [
      { name: ' Minimal ', constraints: { min: 1, max: 1, must: ['p6'], pins: { micro: 'send' } } },
      { name: '', constraints: {} },
    ],
    rotation: { enabled: true, lookBack: 99, strength: -3 },
  });
  assert.equal(s.hardware[2].type, 'sequencer');
  assert.deepEqual(s.rigs, {
    min: 2,
    max: 4,
    perType: { fx: { min: 1, max: 3 } },
    sends: { enabled: false, chance: 10 },
    grooveboxSequences: true,
  });
  assert.equal(s.rigPresets.length, 1);
  assert.equal(s.rigPresets[0].name, 'Minimal');
  assert.deepEqual(s.rigPresets[0].constraints.must, ['p6']);
  assert.deepEqual(s.rigPresets[0].constraints.pins, {}, 'a pin on a device that is not a must is dropped');
  assert.deepEqual(s.rotation, { enabled: true, lookBack: 20, strength: 0, includeConstraints: true });
  const entry = makeEntry({
    prompt: 'x',
    routingText: 'Microcosm on a send.',
    rig: ['p6', 'micro'],
    constraintId: 'c-mono',
  });
  assert.deepEqual(entry.rigDevices, ['p6', 'micro']);
  const parsed = parseBackup(makeBackup(s, [entry]));
  assert.equal(parsed.journal[0].routingText, 'Microcosm on a send.');
  assert.deepEqual(parsed.journal[0].rigDevices, ['p6', 'micro']);
  assert.equal(parsed.journal[0].constraintId, 'c-mono');
});

test('recentUsage and filterEntries', async () => {
  const { recentUsage, filterEntries } = await import('../js/journal.js');
  const entries = [
    makeEntry(
      {
        prompt: 'Synth jam',
        categoryLabel: 'Jamming',
        rig: ['p6', 'micro'],
        constraintId: 'c-mono',
        selections: { fxTwist: 'none' },
      },
      { rating: 5, notes: 'keeper take', createdAt: 3 },
    ),
    makeEntry(
      { prompt: 'Pad loop', categoryLabel: 'Assets creation', selections: { device: 'nord', fxTwist: 'cxm' } },
      { rating: 3, notes: 'meh', createdAt: 2 },
    ),
    makeEntry({ prompt: 'Old', categoryLabel: 'Jamming', selections: { device: 'tr8' } }, { createdAt: 1 }),
  ];
  const recent = recentUsage(entries, 2);
  assert.deepEqual([...recent.devices].sort(), ['micro', 'nord', 'p6']);
  assert.deepEqual([...recent.constraints], ['c-mono']);
  assert.deepEqual([...recent.twists], ['cxm']);
  assert.ok(!recent.devices.has('tr8'), 'older than lookBack is ignored');
  assert.equal(filterEntries(entries, { type: 'Jamming' }).length, 2);
  assert.equal(filterEntries(entries, { minRating: 4 }).length, 1);
  assert.equal(filterEntries(entries, { query: 'KEEPER' }).length, 1);
  assert.equal(filterEntries(entries, { query: 'pad' }).length, 1);
  assert.equal(filterEntries(entries, {}).length, 3);
});
