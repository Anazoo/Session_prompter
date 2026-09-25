// Creative constraints: an optional extra rule rolled on top of a session.
//
// Each constraint has a `scope` that decides which sessions it fits:
//   any       every session
//   assets    loop creation and sound design
//   loop      loop creation
//   melodic   pad, chord progression and melodic loops
//   drums     drum loops and drum kits
//   sound     sound design
//   jamming   any jam
//   tracks    existing and new tracks
//   newtrack  new tracks
//   existing  existing tracks

export const SCOPES = {
  any: 'Any session',
  assets: 'Assets creation',
  loop: 'Loop creation',
  melodic: 'Melodic loops',
  drums: 'Drums',
  sound: 'Sound design',
  jamming: 'Jamming',
  tracks: 'Working on tracks',
  newtrack: 'New track',
  existing: 'Existing track',
};

export const BUILT_IN_CONSTRAINTS = [
  { id: 'c-three-sounds', scope: 'any', text: 'Use only three sounds.' },
  { id: 'c-no-quantise', scope: 'any', text: 'No quantise. Play everything in by hand.' },
  { id: 'c-mono', scope: 'any', text: 'Work in mono until the last ten minutes.' },
  { id: 'c-init', scope: 'any', text: 'No presets. Start every sound from init.' },
  { id: 'c-ten-min', scope: 'any', text: 'Ten minutes per idea. When it is up, move on.' },
  { id: 'c-commit', scope: 'any', text: 'Commit to audio. No MIDI left by the end.' },
  { id: 'c-first-sound', scope: 'any', text: 'Use the first sound you land on. No browsing.' },
  { id: 'c-odd-tempo', scope: 'any', text: 'Work at a tempo you never use.' },
  { id: 'c-one-octave', scope: 'any', text: 'Stay inside one octave.' },
  { id: 'c-shared-fx', scope: 'any', text: 'Every sound must pass through one shared effect.' },
  { id: 'c-mistake', scope: 'any', text: 'Keep one mistake on purpose and build around it.' },
  { id: 'c-no-undo', scope: 'any', text: 'No undo for the first twenty minutes.' },
  { id: 'c-variations', scope: 'assets', text: 'Make three variations before you judge any of them.' },
  { id: 'c-render-delete', scope: 'assets', text: 'Render it, close the project, keep only the audio.' },
  { id: 'c-tag', scope: 'assets', text: 'Name and tag it properly before you stop.' },
  { id: 'c-odd-length', scope: 'loop', text: 'Odd length: six or ten bars instead of eight.' },
  { id: 'c-hole', scope: 'loop', text: 'Leave a two-beat hole somewhere in the loop.' },
  { id: 'c-one-sample', scope: 'loop', text: 'Build it from one sample only, resampled as much as you like.' },
  { id: 'c-mode', scope: 'melodic', text: 'Use a mode you rarely touch: Lydian, Phrygian or Dorian.' },
  { id: 'c-no-root', scope: 'melodic', text: 'No root note in the bass for the whole loop.' },
  { id: 'c-top-line', scope: 'melodic', text: 'Write the top line first, harmony last.' },
  { id: 'c-no-kick-one', scope: 'drums', text: 'No kick on beat one.' },
  { id: 'c-noise-hats', scope: 'drums', text: 'Only found sounds or layered noise for the hats.' },
  { id: 'c-swing', scope: 'drums', text: 'Swing above sixty percent.' },
  { id: 'c-two-osc', scope: 'sound', text: 'Two oscillators and one filter, nothing else.' },
  { id: 'c-one-lfo', scope: 'sound', text: 'Modulate at least three parameters from one LFO.' },
  { id: 'c-five-octaves', scope: 'sound', text: 'Make it playable across five octaves without breaking.' },
  { id: 'c-one-hand', scope: 'jamming', text: 'One hand only for the first ten minutes.' },
  { id: 'c-one-chord', scope: 'jamming', text: 'Stay on one chord for as long as you can bear.' },
  { id: 'c-play-along', scope: 'jamming', text: 'Play along to a field recording or the radio.' },
  { id: 'c-never-stop', scope: 'jamming', text: 'Record everything and never stop the transport.' },
  { id: 'c-no-mixer', scope: 'tracks', text: 'Do not open the mixer until the arrangement is done.' },
  { id: 'c-mute-fav', scope: 'tracks', text: 'Mute the element you like most and make it work without it.' },
  { id: 'c-rough-arr', scope: 'newtrack', text: 'Reach a full-length rough arrangement, however ugly.' },
  { id: 'c-steal-structure', scope: 'newtrack', text: 'Borrow the structure of a track you love, bar for bar.' },
  { id: 'c-only-remove', scope: 'existing', text: 'Only remove things today. Add nothing.' },
  { id: 'c-transition', scope: 'existing', text: 'Finish the transition you keep skipping.' },
  {
    id: 'c-phone-speaker',
    scope: 'existing',
    text: 'Bounce it and listen on a phone speaker before you change anything.',
  },
];

/** Does a constraint scope fit the resolved selections? */
export function matchesScope(scope, sel) {
  const isLoop = sel.assetType === 'loop';
  const isSound = sel.assetType === 'sound';
  switch (scope) {
    case 'any':
      return true;
    case 'assets':
      return sel.category === 'assets';
    case 'loop':
      return isLoop;
    case 'melodic':
      return isLoop && ['pad', 'chords', 'melodic'].includes(sel.loopKind);
    case 'drums':
      return (isLoop && sel.loopKind === 'drums') || (isSound && sel.soundKind === 'drumkit');
    case 'sound':
      return isSound;
    case 'jamming':
      return sel.category === 'jamming';
    case 'tracks':
      return sel.category === 'tracks';
    case 'newtrack':
      return sel.trackType === 'new';
    case 'existing':
      return sel.trackType === 'existing';
    default:
      return false;
  }
}

/**
 * The constraints available for a session, after the user's on/off switches and additions.
 * @param {{constraints?: {disabled?: string[], custom?: Array<{id:string,text:string,scope:string}>}}} config
 */
export function constraintPool(config = {}, sel = {}) {
  const disabled = new Set(config.constraints?.disabled || []);
  const custom = config.constraints?.custom || [];
  return [...BUILT_IN_CONSTRAINTS, ...custom].filter((c) => !disabled.has(c.id) && matchesScope(c.scope, sel));
}
