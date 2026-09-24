// Countdown timer that survives reloads and background tabs.
//
// iOS Safari pauses JavaScript while the app is in the background, so the timer
// keeps an absolute end time and recomputes the remaining time whenever it ticks
// or the page becomes visible again. A screen wake lock (Safari 16.4+) keeps the
// display on so the chime can actually fire at the end.

export const TIMER_KEY = 'sessionPrompter.timer.v1';

export class SessionTimer {
  constructor({ storage = globalThis.localStorage, onChange = () => {}, onDone = () => {} } = {}) {
    this.storage = storage;
    this.onChange = onChange;
    this.onDone = onDone;
    this.state = { status: 'idle', durationMs: 0, endAt: null, remainingMs: 0 };
    this.interval = null;
    this.wakeLock = null;
    this.keepAwake = true;
    this.chimeEnabled = true;
    this.audio = null;
    this.restore();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.tick();
          if (this.state.status === 'running') this.requestWakeLock();
        }
      });
    }
  }

  restore() {
    try {
      const raw = this.storage?.getItem(TIMER_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      this.state = { ...this.state, ...saved };
      if (this.state.status === 'running') {
        this.startInterval();
        this.tick();
      }
    } catch {
      /* ignore corrupt state */
    }
  }

  persist() {
    try {
      this.storage?.setItem(TIMER_KEY, JSON.stringify(this.state));
    } catch {
      /* storage may be unavailable in private mode */
    }
  }

  get remainingMs() {
    if (this.state.status === 'running' && this.state.endAt) {
      return Math.max(0, this.state.endAt - Date.now());
    }
    return Math.max(0, this.state.remainingMs || 0);
  }

  start(durationMs) {
    this.state = {
      status: 'running',
      durationMs,
      endAt: Date.now() + durationMs,
      remainingMs: durationMs,
    };
    this.unlockAudio();
    this.requestWakeLock();
    this.startInterval();
    this.persist();
    this.onChange(this.state);
  }

  pause() {
    if (this.state.status !== 'running') return;
    this.state = { ...this.state, status: 'paused', remainingMs: this.remainingMs, endAt: null };
    this.stopInterval();
    this.releaseWakeLock();
    this.persist();
    this.onChange(this.state);
  }

  resume() {
    if (this.state.status !== 'paused') return;
    this.state = { ...this.state, status: 'running', endAt: Date.now() + this.state.remainingMs };
    this.unlockAudio();
    this.requestWakeLock();
    this.startInterval();
    this.persist();
    this.onChange(this.state);
  }

  reset() {
    this.state = { status: 'idle', durationMs: 0, endAt: null, remainingMs: 0 };
    this.stopInterval();
    this.releaseWakeLock();
    this.persist();
    this.onChange(this.state);
  }

  extend(ms) {
    if (this.state.status === 'done') {
      this.start(ms);
      return;
    }
    if (this.state.status === 'running') {
      this.state = { ...this.state, endAt: this.state.endAt + ms, durationMs: this.state.durationMs + ms };
    } else if (this.state.status === 'paused') {
      this.state = { ...this.state, remainingMs: this.state.remainingMs + ms, durationMs: this.state.durationMs + ms };
    }
    this.persist();
    this.onChange(this.state);
  }

  startInterval() {
    this.stopInterval();
    this.interval = setInterval(() => this.tick(), 250);
  }

  stopInterval() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  tick() {
    if (this.state.status !== 'running') return;
    if (this.remainingMs <= 0) {
      this.state = { ...this.state, status: 'done', remainingMs: 0, endAt: null };
      this.stopInterval();
      this.releaseWakeLock();
      this.persist();
      if (this.chimeEnabled) this.playChime();
      this.onChange(this.state);
      this.onDone(this.state);
      return;
    }
    this.onChange(this.state);
  }

  async requestWakeLock() {
    if (!this.keepAwake || !navigator?.wakeLock || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
    } catch {
      this.wakeLock = null;
    }
  }

  async releaseWakeLock() {
    try {
      await this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }

  /** Must be called from a user gesture so iOS lets us play sound later. */
  unlockAudio() {
    if (!this.chimeEnabled) return;
    try {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) return;
      if (!this.audio) this.audio = new Ctx();
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      if (this.audio.state === 'suspended') this.audio.resume();
      // A silent buffer "primes" playback on iOS.
      const buffer = this.audio.createBuffer(1, 1, 22050);
      const source = this.audio.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audio.destination);
      source.start(0);
    } catch {
      /* no audio available */
    }
  }

  playChime() {
    try {
      if (!this.audio) this.unlockAudio();
      const ctx = this.audio;
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      const notes = [659.25, 783.99, 987.77, 1318.51]; // E5 G5 B5 E6
      for (let repeat = 0; repeat < 3; repeat++) {
        notes.forEach((freq, i) => {
          const t = now + repeat * 1.6 + i * 0.18;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 1);
        });
      }
    } catch {
      /* ignore */
    }
  }
}

export function formatClock(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
