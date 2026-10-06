import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMediaError } from '../js/media.js';
import { bpmFromTaps } from '../js/music.js';
import { normalizeSettings } from '../js/store.js';

test('describeMediaError gives an actionable sentence per failure', () => {
  assert.match(describeMediaError({ name: 'NotAllowedError' }), /denied/);
  assert.match(describeMediaError({ name: 'NotAllowedError' }, { standalone: true }), /Settings → Session Prompter/);
  assert.match(describeMediaError({ name: 'NotFoundError' }), /No microphone/);
  assert.match(describeMediaError({ name: 'NotReadableError' }), /busy/);
  assert.match(describeMediaError({ name: 'NotSupportedError' }), /format/);
  assert.match(describeMediaError(null, { supported: false, standalone: true }), /home-screen app/);
  assert.match(describeMediaError(null, { supported: false }), /not supported/);
  assert.match(describeMediaError(null, { secure: false }), /https/);
  assert.match(describeMediaError({ name: 'WeirdError' }), /\(WeirdError\)/);
  assert.match(describeMediaError(new Error('x')), /Could not start recording/);
});

test('bpmFromTaps averages the recent taps and ignores stale ones', () => {
  assert.equal(bpmFromTaps([]), null);
  assert.equal(bpmFromTaps([1000]), null);
  assert.equal(bpmFromTaps([0, 500, 1000, 1500]), 120);
  assert.equal(bpmFromTaps([0, 600, 1200]), 100);
  assert.equal(bpmFromTaps([0, 10000, 10500, 11000]), 120, 'a long gap starts a new run');
  assert.equal(bpmFromTaps([0, 10000]), null, 'only the stale tap and one new tap: not enough');
  assert.equal(bpmFromTaps([0, 100]), 300, 'clamped to 300');
  assert.equal(bpmFromTaps([0, 2400]), 25);
  const many = Array.from({ length: 20 }, (_, i) => i * 400);
  assert.equal(bpmFromTaps(many), 150, 'uses the last eight taps');
});

test('metronome settings normalise', () => {
  assert.deepEqual(normalizeSettings({}).metronome, { volume: 7, on: false });
  assert.deepEqual(normalizeSettings({ metronome: { volume: 42, on: true } }).metronome, { volume: 10, on: true });
  assert.deepEqual(normalizeSettings({ metronome: { volume: -1, on: 'yes' } }).metronome, { volume: 0, on: false });
});
