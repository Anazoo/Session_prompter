// Musical extras rolled on top of a session: tempo and meter, key and scale.
import { DEFAULT_WEIGHT } from './tree.js';

export const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Pseudo-decision so scale weights can live in Settings like any other group. */
export const SCALE_DECISION = {
  id: 'scale',
  label: 'Scale',
  options: [
    { id: 'major', label: 'Major', weight: 8 },
    { id: 'minor', label: 'Natural minor', weight: 8 },
    { id: 'dorian', label: 'Dorian', weight: 4 },
    { id: 'mixolydian', label: 'Mixolydian', weight: 4 },
    { id: 'lydian', label: 'Lydian', weight: 3 },
    { id: 'phrygian', label: 'Phrygian', weight: 3 },
    { id: 'harmonicMinor', label: 'Harmonic minor', weight: 2 },
    { id: 'pentMajor', label: 'Major pentatonic', weight: 3 },
    { id: 'pentMinor', label: 'Minor pentatonic', weight: 3 },
    { id: 'blues', label: 'Blues', weight: 2 },
    { id: 'wholeTone', label: 'Whole tone', weight: 1 },
    { id: 'locrian', label: 'Locrian', weight: 1 },
  ],
};

export function scaleWeight(option, weights = {}) {
  const override = weights?.[SCALE_DECISION.id]?.[option.id];
  if (typeof override === 'number' && Number.isFinite(override)) return Math.max(0, override);
  return option.weight ?? DEFAULT_WEIGHT;
}

/** Beats per bar for a time signature such as "6/8". */
export function beatsPerBar(timeSig) {
  const n = Number.parseInt(String(timeSig || '4/4').split('/')[0], 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

/**
 * Tempo from tap timestamps (ms). Uses the last few taps; gaps over 2.5 s start a new run.
 * @returns {number|null} rounded BPM, or null with fewer than two usable taps
 */
export function bpmFromTaps(times) {
  if (!Array.isArray(times) || times.length < 2) return null;
  const sorted = [...times].sort((a, b) => a - b);
  let run = [sorted[sorted.length - 1]];
  for (let i = sorted.length - 2; i >= 0 && run.length < 8; i--) {
    if (run[run.length - 1] - sorted[i] > 2500) break;
    run.push(sorted[i]);
  }
  if (run.length < 2) return null;
  const span = run[0] - run[run.length - 1];
  const bpm = Math.round((60000 * (run.length - 1)) / span);
  return Math.min(300, Math.max(20, bpm));
}

export function formatKey(root, scaleId) {
  const scale = SCALE_DECISION.options.find((o) => o.id === scaleId);
  return `${root} ${scale ? scale.label.toLowerCase() : scaleId}`;
}
