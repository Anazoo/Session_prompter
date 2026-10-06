// A small Web Audio metronome with an accented first beat.
export class Metronome {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.running = false;
    this.bpm = 120;
    this.beats = 4;
    this.nextBeatTime = 0;
    this.beatIndex = 0;
    this.onTick = () => {};
  }

  start(bpm, beats = 4) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return false;
    if (!this.ctx) this.ctx = new Ctx();
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.bpm = Math.max(20, Math.min(300, bpm));
    this.beats = Math.max(1, beats);
    this.beatIndex = 0;
    this.nextBeatTime = this.ctx.currentTime + 0.05;
    this.running = true;
    this.stopTimer();
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
    return true;
  }

  stop() {
    this.running = false;
    this.stopTimer();
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  schedule() {
    if (!this.running || !this.ctx) return;
    const lookahead = 0.12;
    const secondsPerBeat = 60 / this.bpm;
    while (this.nextBeatTime < this.ctx.currentTime + lookahead) {
      this.click(this.nextBeatTime, this.beatIndex === 0);
      this.beatIndex = (this.beatIndex + 1) % this.beats;
      this.nextBeatTime += secondsPerBeat;
    }
  }

  click(time, accent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1760 : 1175;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.08);
  }
}
