export class GameAudio {
  constructor() { this.context = null; this.muted = false; }

  unlock() {
    if (this.muted) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      this.context ||= new Audio();
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    } catch { /* The visual feedback still works when audio is unavailable. */ }
  }

  move() {
    if (this.muted || !this.context || this.context.state !== 'running') return;
    const time = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(420, time);
    oscillator.frequency.exponentialRampToValueAtTime(180, time + 0.055);
    gain.gain.setValueAtTime(0.07, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.07);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(time);
    oscillator.stop(time + 0.08);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }

  buzz() {
    this.unlock();
    if (this.muted || !this.context) return;
    const time = this.context.currentTime;
    const master = this.context.createGain();
    const compressor = this.context.createDynamicsCompressor();
    master.gain.setValueAtTime(0, time);
    master.gain.linearRampToValueAtTime(0.52, time + 0.008);
    master.gain.setValueAtTime(0.52, time + 0.55);
    master.gain.exponentialRampToValueAtTime(0.001, time + 0.95);
    master.connect(compressor).connect(this.context.destination);
    for (const frequency of [95, 143]) {
      const oscillator = this.context.createOscillator();
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(frequency, time);
      oscillator.frequency.linearRampToValueAtTime(frequency * 0.72, time + 0.9);
      oscillator.connect(master);
      oscillator.start(time);
      oscillator.stop(time + 1);
      oscillator.onended = () => oscillator.disconnect();
    }
    setTimeout(() => { master.disconnect(); compressor.disconnect(); }, 1200);
  }
}
