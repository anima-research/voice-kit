/**
 * Energy VAD: classifies PCM16LE audio into speech / not-speech by frame
 * RMS energy. Deliberately dumb — no spectral features, no ML, certainly no
 * STT. Its job is one distinction the raw packet layer cannot make: a hot
 * mic transmitting room noise vs. a person actually talking. (Live finding
 * 2026-07-26: a client with noise suppression off transmits continuously;
 * packet-presence carrier-sense then reads "speaking" forever, muting every
 * polite agent in the channel and false-triggering barge-in on unmute.)
 *
 * Semantics:
 *  - ONSET: speech starts after `onsetMs` of cumulative voiced frames with
 *    no intervening silence reset — a single click/pop frame never trips it.
 *  - HANGOVER: speech ends after `hangoverMs` of continuous below-threshold
 *    audio — intra-word gaps don't flap the state.
 *  - Time is AUDIO time (computed from samples fed), not wall clock:
 *    deterministic and testable.
 *
 * Feed it decoded PCM as it arrives; it emits speechStart/speechEnd
 * transitions. `end()` force-closes (stream ended). `onLevel` exposes the
 * per-frame dBFS for live calibration UIs.
 */

export interface EnergyVadOptions {
  /** Sample rate of fed PCM (Hz). */
  rateHz: number;
  /** Interleaved channels in fed PCM (default 1). */
  channels?: number;
  /** Voiced threshold in dBFS (default -45). Raise (e.g. -35) for noisy
   *  rooms, lower for quiet mics. */
  thresholdDb?: number;
  /** Cumulative voiced audio required to open (default 60 ms). */
  onsetMs?: number;
  /** Continuous silence required to close (default 300 ms). */
  hangoverMs?: number;
}

const FRAME_MS = 20;

export class EnergyVad {
  private readonly rateHz: number;
  private readonly channels: number;
  private readonly thresholdDb: number;
  private readonly onsetMs: number;
  private readonly hangoverMs: number;
  private readonly frameBytes: number;

  private carry: Buffer = Buffer.alloc(0);
  private voicedRunMs = 0;
  private silenceRunMs = 0;
  private utteranceVoicedMs = 0;
  private _speaking = false;
  private startFns: Array<() => void> = [];
  private endFns: Array<() => void> = [];
  private levelFns: Array<(db: number) => void> = [];
  private sustainedFns: Array<{ ms: number; fn: () => void; fired: boolean }> = [];

  constructor(opts: EnergyVadOptions) {
    this.rateHz = opts.rateHz;
    this.channels = opts.channels ?? 1;
    this.thresholdDb = opts.thresholdDb ?? -45;
    this.onsetMs = opts.onsetMs ?? 60;
    this.hangoverMs = opts.hangoverMs ?? 300;
    this.frameBytes = Math.floor((this.rateHz * FRAME_MS) / 1000) * this.channels * 2;
  }

  get speaking(): boolean { return this._speaking; }

  onSpeechStart(fn: () => void): void { this.startFns.push(fn); }
  onSpeechEnd(fn: () => void): void { this.endFns.push(fn); }
  /** Per-frame dBFS as audio flows — for live threshold calibration. */
  onLevel(fn: (db: number) => void): void { this.levelFns.push(fn); }
  /**
   * Fires once per utterance when cumulative VOICED audio (frames above
   * threshold since speech opened) reaches `ms`. This — not speech-open
   * duration — is the barge-in qualifier: hangover keeps an utterance open
   * across word gaps but contributes NOTHING here, so a short transient
   * (unmute spike, mic bump) that opens speech and then coasts on hangover
   * never qualifies. Live finding 2026-07-26: a presence-based sustain
   * check is vacuous when the hangover outlives it.
   */
  onSpeechSustained(ms: number, fn: () => void): void {
    this.sustainedFns.push({ ms, fn, fired: false });
  }

  feed(pcm: Buffer): void {
    this.carry = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    while (this.carry.length >= this.frameBytes) {
      const frame = this.carry.subarray(0, this.frameBytes);
      this.carry = this.carry.subarray(this.frameBytes);
      this.processFrame(frame);
    }
  }

  /** Source stream ended: flush state; emits speechEnd if currently open. */
  end(): void {
    this.carry = Buffer.alloc(0);
    this.silenceRunMs = 0;
    if (this._speaking) this.closeSpeech();
    else this.voicedRunMs = 0;
  }

  private processFrame(frame: Buffer): void {
    const db = dbfs(frame);
    for (const fn of this.levelFns) { try { fn(db); } catch { /* consumer's */ } }
    if (db >= this.thresholdDb) {
      this.voicedRunMs += FRAME_MS;
      this.silenceRunMs = 0;
      if (!this._speaking && this.voicedRunMs >= this.onsetMs) {
        this._speaking = true;
        this.utteranceVoicedMs = this.voicedRunMs; // onset frames count
        for (const fn of this.startFns) { try { fn(); } catch { /* consumer's */ } }
      } else if (this._speaking) {
        this.utteranceVoicedMs += FRAME_MS;
      }
      if (this._speaking) {
        for (const s of this.sustainedFns) {
          if (!s.fired && this.utteranceVoicedMs >= s.ms) {
            s.fired = true;
            try { s.fn(); } catch { /* consumer's */ }
          }
        }
      }
    } else {
      this.silenceRunMs += FRAME_MS;
      if (!this._speaking) {
        this.voicedRunMs = 0; // onset must be (near-)contiguous
      } else if (this.silenceRunMs >= this.hangoverMs) {
        this.closeSpeech();
      }
    }
  }

  private closeSpeech(): void {
    this._speaking = false;
    this.voicedRunMs = 0;
    this.utteranceVoicedMs = 0;
    for (const s of this.sustainedFns) s.fired = false; // re-arm per utterance
    for (const fn of this.endFns) { try { fn(); } catch { /* consumer's */ } }
  }
}

/** RMS level of a PCM16LE buffer in dBFS (0 = full scale; silence → -Inf). */
export function dbfs(pcm: Buffer): number {
  const samples = pcm.length >> 1;
  if (samples === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i << 1);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}
