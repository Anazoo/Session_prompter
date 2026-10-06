// Microphone capture helpers and human-readable reasons when it fails.

/** iOS needs the audio session in a capture-capable category before getUserMedia. */
export function prepareCapture() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
  } catch {
    /* ignore */
  }
}

/** Back to a playback-friendly session once recording is done. */
export function releaseCapture() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'auto';
  } catch {
    /* ignore */
  }
}

export function isStandaloneIOS() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  return ios && (navigator.standalone === true || globalThis.matchMedia?.('(display-mode: standalone)')?.matches);
}

/**
 * Turn a getUserMedia / MediaRecorder failure into a sentence the user can act on.
 * @param {any} err
 * @param {{standalone?: boolean, secure?: boolean, supported?: boolean}} env
 */
export function describeMediaError(err, env = {}) {
  const name = err?.name || '';
  if (env.supported === false) {
    return env.standalone
      ? 'Recording is not available in the home-screen app on this iOS version. Open the site in Safari to record, or use "Choose file".'
      : 'Recording is not supported in this browser. Use "Choose file" instead.';
  }
  if (env.secure === false) return 'Recording needs a secure (https) page.';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return env.standalone
        ? 'Microphone access is blocked. Allow it under Settings → Session Prompter → Microphone, then try again.'
        : 'Microphone access was denied. Allow it for this site in your browser settings, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'The microphone is busy or could not start. Close other apps using it and try again.';
    case 'OverconstrainedError':
      return 'No microphone matches the requested settings.';
    case 'SecurityError':
      return 'Recording is blocked here. It needs a secure (https) page.';
    case 'NotSupportedError':
      return 'This browser cannot record in a supported audio format. Use "Choose file" instead.';
    case 'InvalidStateError':
      return 'Recording is already running. Stop it first.';
    default:
      return `Could not start recording${name ? ` (${name})` : ''}. Try again, or use "Choose file".`;
  }
}

/** The recording format this browser supports, if any. */
export function pickRecordingType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
}
