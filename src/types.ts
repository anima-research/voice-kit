/**
 * Provider seam for voice: one set of interfaces every STT/TTS vendor adapts
 * to, so consumers (portal-relay's channel listener, discord-mcpl's voice
 * leg, a future self-contained agent) never touch a vendor API shape.
 *
 * Design constraints these interfaces encode:
 *
 *  - REVISION IS NORMAL. Providers differ most in what they promise about
 *    already-delivered output. ElevenLabs Scribe emits growing partials then
 *    an immutable commit; AssemblyAI revises turn text AND speaker labels
 *    after delivery. So a transcript event is keyed by `utteranceId` and any
 *    field — text, speaker, even `final` — may be re-emitted for the same id.
 *    Consumers MUST treat (utteranceId → latest event) as the truth and
 *    render/replace accordingly. A consumer that needs immutability (e.g.
 *    forwarding finals into an append-only stream) applies its own settling
 *    policy (e.g. act on `final` + a quiet period, or accept later revisions
 *    as edits).
 *
 *  - SPEAKER ATTRIBUTION IS OPTIONAL AND LAYERED. When the audio source is
 *    already per-speaker (Discord receiver streams), the consumer knows the
 *    speaker and providers run one session per speaker (`speaker` stays
 *    unset). When the source is a mixed feed, diarizing providers fill
 *    `speaker` with an opaque provider label ("A", "spk_1") — mutable like
 *    everything else — and the consumer maps labels to identities if it can.
 *
 *  - PCM IN, PCM OUT. Sessions declare their input rate at open; TTS streams
 *    declare their output rate. Conversion to/from surface formats (Discord
 *    48k stereo opus, browser formats) is consumer-side (audio.ts helpers).
 */

// ── STT ──────────────────────────────────────────────────────────────────────

export interface SttTranscript {
  /** Stable revision key: events with the same id replace one another. */
  utteranceId: string;
  /** Current best text for this utterance (full text, not a delta). */
  text: string;
  /**
   * Provider considers this utterance ended. NOT a promise of immutability:
   * some providers (AssemblyAI) may still revise text/speaker afterwards —
   * such revisions arrive as another event with the same utteranceId.
   */
  final: boolean;
  /** Opaque provider speaker label, for diarizing providers on mixed audio.
   *  MUTABLE: may appear or change in later events for the same utterance. */
  speaker?: string;
  /** ms epoch when this utterance's audio began, if the provider reports it. */
  startedAt?: number;
}

export interface SttSessionOptions {
  /** Input PCM16LE mono sample rate (Hz). */
  sampleRateHz: number;
  /** BCP-47-ish language hint, provider-interpreted. */
  language?: string;
  /** Prior conversational text, for providers that condition on context. */
  context?: string;
  /** Ask the provider to diarize (mixed-feed sources). Providers without
   *  realtime diarization ignore this; `speaker` simply never appears. */
  diarize?: boolean;
}

export interface SttSession {
  /** Feed PCM16LE mono audio at the session's declared rate. */
  sendAudio(pcm: Buffer): void;
  /** Force an utterance boundary (e.g. the surface's own silence detector
   *  fired). Providers with only automatic segmentation treat it as a hint. */
  commit(): void;
  /** Flush and close. Pending transcripts may still fire briefly after. */
  close(): void;
  onTranscript(fn: (t: SttTranscript) => void): void;
  onError(fn: (err: Error) => void): void;
}

export interface SttProvider {
  readonly name: string;
  openSession(opts: SttSessionOptions): SttSession;
}

// ── TTS ──────────────────────────────────────────────────────────────────────

/** What to sound like — registry-shaped, vendor fields optional. */
export interface TtsVoice {
  /** Provider voice id (e.g. an ElevenLabs voice id). */
  voiceId: string;
  /** Provider model id override (falls back to provider default). */
  model?: string;
  settings?: { speed?: number; stability?: number; similarityBoost?: number };
}

/**
 * Character-level timing for a span of synthesized audio. Times are
 * MILLISECONDS FROM THE START OF THE STREAM'S AUDIO (absolute within the
 * utterance, never chunk-relative — providers normalize before emitting).
 * `chars` correspond to the INPUT text as sent via sendText (not the
 * provider's internal normalization), so consumers can map a playback
 * position back to "which characters of my text were actually heard" —
 * the raw material for interruption accounting.
 */
export interface TtsAlignment {
  chars: string[];
  /** Per-char audio start, ms from stream audio start. Same length as chars. */
  startMs: number[];
  /** Per-char audio duration, ms. Same length as chars. */
  durationMs: number[];
}

export interface TtsStream {
  /** Feed incremental text as the source generates it. */
  sendText(delta: string): void;
  /** No more text; provider flushes remaining audio then ends. */
  end(): void;
  /** Abandon the stream (interruption): stop synthesis, drop pending audio. */
  abort(): void;
  /** PCM16LE mono audio at the provider's declared output rate. */
  onAudio(fn: (pcm: Buffer) => void): void;
  /**
   * Char timing for audio about to be delivered. OPTIONAL SIGNAL: providers
   * without timing data simply never fire it — consumers needing "what was
   * voiced" must fall back to estimating from audio duration alone. When a
   * provider has timing for a chunk, the alignment event fires BEFORE that
   * chunk's onAudio, so consumers can snapshot cumulative-audio offsets.
   */
  onAlignment(fn: (a: TtsAlignment) => void): void;
  /** All audio delivered (fires after end(); not after abort()). */
  onEnd(fn: () => void): void;
  onError(fn: (err: Error) => void): void;
}

export interface TtsProvider {
  readonly name: string;
  /** Output PCM sample rate of every stream this provider opens. */
  readonly outputRateHz: number;
  openStream(voice: TtsVoice): TtsStream;
}
