/**
 * AssemblyAI v3 Universal-Streaming — STT provider. Written from docs
 * (verified 2026-07-26); NEEDS one live run with ASSEMBLYAI_API_KEY before
 * production. Doc gotchas this file deliberately encodes:
 *
 *  - Audio is RAW BINARY frames (never JSON/base64); chunks must be
 *    50–1000 ms or the server closes with 3007 → we re-buffer to ~100 ms.
 *  - Every Turn message re-transcribes the whole turn: REPLACE, never append.
 *    Maps 1:1 onto SttTranscript's utteranceId revision contract
 *    (utteranceId = `t${turn_order}`).
 *  - With format_turns, non-Pro models send TWO finals per turn (unformatted
 *    then formatted): a turn is final only when end_of_turn AND
 *    turn_is_formatted. The unformatted final is emitted as a non-final
 *    revision — harmless, the formatted one settles it. (Pro always formats.)
 *  - Speaker labels (beta, opts.diarize → speaker_labels=true) are
 *    provisional live and batch-revised ONLY at session end: SpeakerRevision
 *    arrives after Terminate, before Termination. So close() must do the
 *    full handshake — send Terminate, keep reading until Termination —
 *    or the last transcript AND all label corrections are silently lost.
 *    Revisions re-emit each affected utteranceId with the corrected speaker.
 *  - Unknown query params are silently ignored — we check Begin.configuration
 *    echoes the requested model and surface a mismatch as an error.
 *  - Billing is per session-open hour (idle bills!): sessions must be closed
 *    eagerly, never parked.
 */
import WebSocket from 'ws';
import type { SttProvider, SttSession, SttSessionOptions, SttTranscript } from '../types.js';

const URL_BASE = 'wss://streaming.assemblyai.com/v3/ws';
const CHUNK_MS = 100;

export interface AssemblyAiOptions {
  /** universal-3-5-pro (default) | universal-streaming-english | universal-streaming-multilingual */
  model?: string;
}

export class AssemblyAiSttProvider implements SttProvider {
  readonly name = 'assemblyai';
  constructor(private apiKey: string, private opts: AssemblyAiOptions = {}) {}

  openSession(opts: SttSessionOptions): SttSession {
    return new AssemblyAiSession(this.apiKey, this.opts.model ?? 'universal-3-5-pro', opts);
  }
}

class AssemblyAiSession implements SttSession {
  private ws: WebSocket;
  private ready: Promise<void>;
  private transcriptFns: Array<(t: SttTranscript) => void> = [];
  private errorFns: Array<(e: Error) => void> = [];
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private chunkBytes: number;
  private sessionEpoch = Date.now();
  /** Latest text per turn, for re-emitting speaker revisions at close. */
  private turnText = new Map<number, string>();
  private terminated = false;

  constructor(apiKey: string, model: string, private opts: SttSessionOptions) {
    this.chunkBytes = Math.floor((opts.sampleRateHz * 2 * CHUNK_MS) / 1000);
    const params = new URLSearchParams({
      speech_model: model,
      encoding: 'pcm_s16le',
      sample_rate: String(opts.sampleRateHz),
      format_turns: 'true',
    });
    if (opts.diarize) params.set('speaker_labels', 'true');
    if (opts.language) params.set('language_codes', opts.language);
    // ASSEMBLYAI_WS_BASE: regional endpoints (streaming.eu/…us…) or test mocks.
    const base = process.env.ASSEMBLYAI_WS_BASE ?? URL_BASE;
    // NOTE: `Authorization: <key>` — no Bearer prefix (docs).
    this.ws = new WebSocket(`${base}?${params}`, { headers: { Authorization: apiKey } });
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
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      switch (msg.type) {
        case 'Begin': {
          const conf = (msg.configuration ?? {}) as { model?: string };
          // Unknown params are ignored, not rejected — verify we got the model
          // we asked for instead of a silent fallback.
          if (conf.model && conf.model !== model) {
            this.emitError(new Error(`assemblyai: requested model ${model}, session runs ${conf.model}`));
          }
          this.sessionEpoch = Date.now();
          break;
        }
        case 'Turn': {
          const turnOrder = msg.turn_order as number;
          const endOfTurn = Boolean(msg.end_of_turn);
          const formatted = Boolean(msg.turn_is_formatted);
          const text = String(msg.transcript ?? '').trim();
          if (!text) return;
          this.turnText.set(turnOrder, text);
          const words = (msg.words ?? []) as Array<{ start?: number }>;
          const speaker = typeof msg.speaker_label === 'string' && msg.speaker_label !== 'UNKNOWN'
            ? msg.speaker_label : undefined;
          this.emit({
            utteranceId: `t${turnOrder}`,
            text,
            // double-final rule: complete only when end_of_turn AND formatted
            final: endOfTurn && formatted,
            ...(speaker ? { speaker } : {}),
            ...(words[0]?.start !== undefined ? { startedAt: this.sessionEpoch + words[0].start } : {}),
          });
          return;
        }
        case 'SpeakerRevision': {
          // End-of-session batch label corrections: re-emit each affected
          // utterance with its corrected speaker (text unchanged by contract).
          const revisions = (msg.revisions ?? []) as Array<{ turn_order: number; speaker_label?: string }>;
          for (const rev of revisions) {
            const text = this.turnText.get(rev.turn_order);
            if (!text) continue;
            this.emit({
              utteranceId: `t${rev.turn_order}`,
              text,
              final: true,
              ...(rev.speaker_label && rev.speaker_label !== 'UNKNOWN' ? { speaker: rev.speaker_label } : {}),
            });
          }
          return;
        }
        case 'Termination':
          try { this.ws.close(); } catch { /* fine */ }
          return;
        case 'Error':
          this.emitError(new Error(`assemblyai: ${JSON.stringify(msg)}`));
          return;
      }
    });
  }

  sendAudio(pcm: Buffer): void {
    if (this.terminated) return;
    // Re-buffer to the 50–1000ms window (violations close the session, 3007).
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    while (this.pendingBytes >= this.chunkBytes) {
      const chunk = Buffer.concat(this.pending);
      this.pending = chunk.length > this.chunkBytes ? [chunk.subarray(this.chunkBytes)] : [];
      this.pendingBytes = this.pending[0]?.length ?? 0;
      this.sendBinary(chunk.subarray(0, this.chunkBytes));
    }
  }

  commit(): void {
    if (this.terminated) return;
    this.sendJson({ type: 'ForceEndpoint' });
  }

  close(): void {
    if (this.terminated) return;
    this.terminated = true;
    // Flush sub-chunk remainder if it meets the 50ms floor; below it, drop.
    const rest = Buffer.concat(this.pending);
    this.pending = []; this.pendingBytes = 0;
    if (rest.length >= this.chunkBytes / 2) this.sendBinary(rest);
    // Full termination handshake: Terminate → keep reading (SpeakerRevision
    // rides in here) → Termination closes the socket in the handler above.
    this.sendJson({ type: 'Terminate' });
    // Safety net if Termination never arrives (unclean server): force-close.
    setTimeout(() => { try { this.ws.close(); } catch { /* fine */ } }, 10_000);
  }

  onTranscript(fn: (t: SttTranscript) => void): void { this.transcriptFns.push(fn); }
  onError(fn: (e: Error) => void): void { this.errorFns.push(fn); }

  private sendBinary(buf: Buffer): void {
    void this.ready.then(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
    }).catch(() => { /* surfaced */ });
  }
  private sendJson(obj: Record<string, unknown>): void {
    void this.ready.then(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    }).catch(() => { /* surfaced */ });
  }
  private emit(t: SttTranscript): void {
    for (const fn of this.transcriptFns) { try { fn(t); } catch { /* consumer's */ } }
  }
  private emitError(e: Error): void {
    for (const fn of this.errorFns) { try { fn(e); } catch { /* ditto */ } }
  }
}
