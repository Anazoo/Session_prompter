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
