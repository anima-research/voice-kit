/**
 * ElevenLabs Scribe v2 Realtime — STT provider. Wire protocol live-verified
 * 2026-07-26 (TTS→Scribe round-trip): session_started / partial_transcript /
 * committed_transcript, base64 PCM input messages, manual commit via
 * empty-audio + commit:true. No realtime diarization: `speaker` never set;
 * per-speaker sources should run one session per speaker.
 *
 * Utterance model: one Scribe session = one utterance stream; committed
 * segments accumulate within an utterance (a partial's text is everything
 * committed so far plus the mutable tail). We mint a fresh utteranceId per
 * commit cycle so consumers get clean replace-in-place keys.
 */
import WebSocket from 'ws';
import type { SttProvider, SttSession, SttSessionOptions, SttTranscript } from '../types.js';

const URL_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const SUPPORTED_RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);

export class ScribeSttProvider implements SttProvider {
  readonly name = 'scribe';
  constructor(private apiKey: string) {}

  openSession(opts: SttSessionOptions): SttSession {
    if (!SUPPORTED_RATES.has(opts.sampleRateHz)) {
      throw new Error(`scribe: unsupported sample rate ${opts.sampleRateHz}`);
    }
    return new ScribeSession(this.apiKey, opts);
  }
}

class ScribeSession implements SttSession {
  private ws: WebSocket;
  private ready: Promise<void>;
  private transcriptFns: Array<(t: SttTranscript) => void> = [];
  private errorFns: Array<(e: Error) => void> = [];
  private utterN = 1;
  private committedText = '';
  private startedAt = Date.now();
  private firstChunkSent = false;
  private closed = false;

  constructor(private apiKey: string, private opts: SttSessionOptions) {
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: `pcm_${opts.sampleRateHz}`,
      commit_strategy: 'vad', // backstop; commit() is the authoritative boundary
    });
    if (opts.language) params.set('language_code', opts.language);
    this.ws = new WebSocket(`${URL_BASE}?${params}`, { headers: { 'xi-api-key': apiKey } });
    this.ready = new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ready.catch(() => { /* surfaced via the persistent handler below */ });
    // Persistent handler: pre-open failures AND mid-session socket errors both
    // surface via onError; without this, a post-open error event crashes the
    // process (EventEmitter unhandled 'error').
    this.ws.on('error', (e) => this.emitError(e as Error));

    this.ws.on('message', (raw) => {
      let msg: { message_type?: string; text?: string; error?: string };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const type = msg.message_type ?? '';
      if (type === 'partial_transcript' || type.startsWith('committed_transcript')) {
        const partialTail = type === 'partial_transcript' ? (msg.text ?? '') : '';
        if (type.startsWith('committed_transcript')) {
          this.committedText = `${this.committedText} ${msg.text ?? ''}`.trim();
        }
        const text = `${this.committedText} ${partialTail}`.trim();
        if (!text) return;
        this.emit({
          utteranceId: `u${this.utterN}`,
          text,
          final: false, // finality is decided by commit()/close of the cycle
          startedAt: this.startedAt,
        });
      } else if (type.includes('error') || /exceeded|throttled|limited|overflow|exhausted/.test(type)) {
        this.emitError(new Error(`scribe ${type}: ${msg.error ?? ''}`));
      }
    });
  }

  sendAudio(pcm: Buffer): void {
    const payload: Record<string, unknown> = {
      message_type: 'input_audio_chunk',
      audio_base_64: pcm.toString('base64'),
      commit: false,
      sample_rate: this.opts.sampleRateHz,
    };
    if (!this.firstChunkSent) {
      this.firstChunkSent = true;
      if (this.opts.context) payload.previous_text = this.opts.context.slice(-300);
    }
    this.send(payload);
  }

  commit(): void {
    this.send({
      message_type: 'input_audio_chunk',
      audio_base_64: '',
      commit: true,
      sample_rate: this.opts.sampleRateHz,
    });
    // Settle the current utterance and start a fresh revision key. The
    // final text arrives as one more committed_transcript; emit final now
    // with what we have and again (same id, revised) when it lands.
    const id = `u${this.utterN}`;
    if (this.committedText) {
      this.emit({ utteranceId: id, text: this.committedText, final: true, startedAt: this.startedAt });
    }
    // Delay the cycle rollover so the post-commit transcript revises the SAME id.
    setTimeout(() => {
      if (this.committedText) {
        this.emit({ utteranceId: id, text: this.committedText, final: true, startedAt: this.startedAt });
      }
      this.utterN++;
      this.committedText = '';
      this.startedAt = Date.now();
    }, 1500);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // let trailing transcripts drain before the socket drops
    setTimeout(() => { try { this.ws.close(); } catch { /* fine */ } }, 5000);
  }

  onTranscript(fn: (t: SttTranscript) => void): void { this.transcriptFns.push(fn); }
  onError(fn: (e: Error) => void): void { this.errorFns.push(fn); }

  private send(payload: Record<string, unknown>): void {
    void this.ready.then(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    }).catch(() => { /* connect failure already surfaced */ });
  }

  private emit(t: SttTranscript): void {
    for (const fn of this.transcriptFns) { try { fn(t); } catch { /* consumer's problem */ } }
  }
  private emitError(e: Error): void {
    for (const fn of this.errorFns) { try { fn(e); } catch { /* ditto */ } }
  }
}
