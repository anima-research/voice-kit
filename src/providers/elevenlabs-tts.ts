/**
 * ElevenLabs stream-input — TTS provider. Wire protocol live-verified
 * 2026-07-26: incremental `{text, try_trigger_generation}` messages in,
 * `{audio: base64, isFinal}` out; `{text: ""}` closes input. ~0.7s to first
 * audio on eleven_multilingual_v2 (flash models roughly halve it).
 * Output: PCM16LE mono 44.1 kHz.
 *
 * Alignment: messages may carry `alignment` (input-text chars) and/or
 * `normalizedAlignment` (provider-normalized chars); we prefer `alignment`
 * so chars map onto what the consumer sent. Char times in a message are
 * relative to THAT message's audio chunk; we re-base them onto the stream's
 * cumulative audio timeline before emitting (TtsAlignment contract is
 * stream-absolute). Defensive: if a message's first char time already sits
 * at/past our cumulative offset, the server sent stream-absolute times and
 * we re-base by 0 instead (heuristic documented at `alignmentBase`).
 */
import WebSocket from 'ws';
import type { TtsAlignment, TtsProvider, TtsStream, TtsVoice } from '../types.js';

interface WireAlignment {
  chars?: string[];
  charStartTimesMs?: number[];
  charDurationsMs?: number[];
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = 'elevenlabs';
  readonly outputRateHz = 44100;
  constructor(private apiKey: string, private defaultModel = 'eleven_multilingual_v2') {}

  openStream(voice: TtsVoice): TtsStream {
    return new ElevenStream(this.apiKey, voice, voice.model ?? this.defaultModel);
  }
}

class ElevenStream implements TtsStream {
  private ws: WebSocket;
  private ready: Promise<void>;
  private audioFns: Array<(pcm: Buffer) => void> = [];
  private alignFns: Array<(a: TtsAlignment) => void> = [];
  private endFns: Array<() => void> = [];
  private errorFns: Array<(e: Error) => void> = [];
  private first = true;
  private aborted = false;
  /** Cumulative audio already emitted, ms — the re-base offset for
   *  chunk-relative alignment times. 44.1k mono PCM16: bytes/2/44.1 = ms. */
  private audioMs = 0;

  constructor(apiKey: string, voice: TtsVoice, model: string) {
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}/stream-input` +
      `?model_id=${encodeURIComponent(model)}&output_format=pcm_44100`;
    this.ws = new WebSocket(url, { headers: { 'xi-api-key': apiKey } });
    this.ready = new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ready.catch((e) => this.emitError(e as Error));

    const settings = voice.settings ?? {};
    this.voiceSettings = {
      stability: settings.stability ?? 0.5,
      similarity_boost: settings.similarityBoost ?? 0.8,
      speed: settings.speed ?? 1.0,
    };

    this.ws.on('message', (raw) => {
      if (this.aborted) return;
      let msg: {
        audio?: string; isFinal?: boolean; error?: string; message?: string;
        alignment?: WireAlignment; normalizedAlignment?: WireAlignment;
      };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      // Alignment BEFORE audio (TtsStream contract): consumers snapshot
      // their cumulative-audio state before this chunk's PCM lands.
      const wire = msg.alignment ?? msg.normalizedAlignment;
      if (wire?.chars?.length && wire.charStartTimesMs?.length === wire.chars.length) {
        const base = this.alignmentBase(wire.charStartTimesMs[0]!);
        const a: TtsAlignment = {
          chars: wire.chars,
          startMs: wire.charStartTimesMs.map((t) => t + base),
          durationMs: wire.charDurationsMs?.length === wire.chars.length
            ? wire.charDurationsMs
            : wire.chars.map(() => 0),
        };
        for (const fn of this.alignFns) { try { fn(a); } catch { /* consumer's */ } }
      }
      if (msg.audio) {
        const pcm = Buffer.from(msg.audio, 'base64');
        this.audioMs += pcm.length / 2 / 44.1; // PCM16 mono 44.1k
        for (const fn of this.audioFns) { try { fn(pcm); } catch { /* consumer's */ } }
      }
      if (msg.isFinal) {
        for (const fn of this.endFns) { try { fn(); } catch { /* consumer's */ } }
        try { this.ws.close(); } catch { /* fine */ }
      }
      if (msg.error) this.emitError(new Error(msg.message ?? msg.error));
    });
  }

  private voiceSettings: Record<string, number>;

  sendText(delta: string): void {
    if (this.aborted || !delta) return;
    const payload: Record<string, unknown> = { text: delta, try_trigger_generation: true };
    if (this.first) { this.first = false; payload.voice_settings = this.voiceSettings; }
    this.send(payload);
  }

  end(): void {
    if (this.aborted) return;
    this.send({ text: '' });
  }

  abort(): void {
    this.aborted = true;
    try { this.ws.close(); } catch { /* fine */ }
  }

  onAudio(fn: (pcm: Buffer) => void): void { this.audioFns.push(fn); }
  onAlignment(fn: (a: TtsAlignment) => void): void { this.alignFns.push(fn); }
  onEnd(fn: () => void): void { this.endFns.push(fn); }
  onError(fn: (e: Error) => void): void { this.errorFns.push(fn); }

  /**
   * Re-base offset for a message's char times. Chunk-relative times start
   * near 0 on every message; stream-absolute times start near our cumulative
   * audio count. So: first char time within 100 ms of cumulative → already
   * absolute (base 0); otherwise chunk-relative (base = cumulative). On the
   * very first chunk both readings coincide at 0 and either branch is
   * correct. Verify against live wire when convenient; both shapes have been
   * seen in the wild across ElevenLabs API revisions.
   */
  private alignmentBase(firstCharMs: number): number {
    if (Math.abs(firstCharMs - this.audioMs) <= 100) return 0;
    return this.audioMs;
  }

  private send(payload: Record<string, unknown>): void {
    void this.ready.then(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    }).catch(() => { /* surfaced via onError */ });
  }
  private emitError(e: Error): void {
    for (const fn of this.errorFns) { try { fn(e); } catch { /* ditto */ } }
  }
}
