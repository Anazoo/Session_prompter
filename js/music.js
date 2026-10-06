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

export function formatKey(root, scaleId) {
  const scale = SCALE_DECISION.options.find((o) => o.id === scaleId);
  return `${root} ${scale ? scale.label.toLowerCase() : scaleId}`;
}
