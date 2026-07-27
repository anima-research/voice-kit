// AssemblyAI provider conformance against a mock v3 server: the mappings the
// docs warn about — double finals under format_turns, replace-not-append turn
// revisions, end-of-session SpeakerRevision re-emission, and the Terminate
// handshake (revisions arrive AFTER Terminate; a naive close loses them).
import { test, expect, afterAll } from 'bun:test';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { AssemblyAiSttProvider } from '../src/providers/assemblyai.js';
import type { SttTranscript } from '../src/types.js';

const PORT = 8957;
const wss = new WebSocketServer({ port: PORT });
let script: (ws: WsSocket) => void = () => {};
wss.on('connection', (ws) => script(ws));
afterAll(() => wss.close());

function patchedProvider(): AssemblyAiSttProvider {
  const p = new AssemblyAiSttProvider('test-key');
  // point the provider at the mock (module const — patch via session monkey):
  return p;
}

// The provider hardcodes the prod URL; patch WebSocket target through a tiny
// subclass-free trick: rewire global URL by overriding the module is heavier
// than needed — instead we accept the provider's URL param and intercept via
// a local resolver is not available. Pragmatic: expose base override.
// (Set in provider via env for tests.)
process.env.ASSEMBLYAI_WS_BASE = `ws://127.0.0.1:${PORT}`;

function collect(session: ReturnType<AssemblyAiSttProvider['openSession']>): SttTranscript[] {
  const out: SttTranscript[] = [];
  session.onTranscript((t) => out.push({ ...t }));
  return out;
}

const turn = (o: Record<string, unknown>) => JSON.stringify({ type: 'Turn', words: [], ...o });

test('double-final rule + replace semantics + speaker revision after Terminate', async () => {
  script = (ws) => {
    ws.send(JSON.stringify({ type: 'Begin', id: 's1', configuration: { model: 'universal-3-5-pro' } }));
    // turn 0: partial → unformatted final → formatted final (non-Pro shape)
    ws.send(turn({ turn_order: 0, end_of_turn: false, turn_is_formatted: false, transcript: 'hello wor', end_of_turn_confidence: 0, speaker_label: 'A' }));
    ws.send(turn({ turn_order: 0, end_of_turn: true, turn_is_formatted: false, transcript: 'hello world', end_of_turn_confidence: 1, speaker_label: 'A' }));
    ws.send(turn({ turn_order: 0, end_of_turn: true, turn_is_formatted: true, transcript: 'Hello, world.', end_of_turn_confidence: 1, speaker_label: 'A' }));
    // turn 1: attributed to A live — will be revised to B at close
    ws.send(turn({ turn_order: 1, end_of_turn: true, turn_is_formatted: true, transcript: 'Second turn.', end_of_turn_confidence: 1, speaker_label: 'A' }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(String(raw));
      if (m.type === 'Terminate') {
        ws.send(JSON.stringify({ type: 'SpeakerRevision', revisions: [{ turn_order: 1, speaker_label: 'B', words: [] }] }));
        ws.send(JSON.stringify({ type: 'Termination', audio_duration_seconds: 1, session_duration_seconds: 2 }));
      }
    });
  };

  const session = patchedProvider().openSession({ sampleRateHz: 16000, diarize: true });
  const got = collect(session);
  await new Promise((r) => setTimeout(r, 250));
  session.close();
  await new Promise((r) => setTimeout(r, 250));

  const t0 = got.filter((t) => t.utteranceId === 't0');
  expect(t0.length).toBe(3);
  expect(t0[0]).toMatchObject({ text: 'hello wor', final: false, speaker: 'A' });
  expect(t0[1]).toMatchObject({ text: 'hello world', final: false }); // unformatted final ≠ final
  expect(t0[2]).toMatchObject({ text: 'Hello, world.', final: true });

  const t1 = got.filter((t) => t.utteranceId === 't1');
  expect(t1[0]).toMatchObject({ text: 'Second turn.', final: true, speaker: 'A' });
  // revision arrived after Terminate: same id, same text, corrected speaker
  expect(t1[t1.length - 1]).toMatchObject({ text: 'Second turn.', final: true, speaker: 'B' });
});

test('audio is re-buffered to legal binary chunks; UNKNOWN speaker omitted', async () => {
  const frames: number[] = [];
  script = (ws) => {
    ws.send(JSON.stringify({ type: 'Begin', id: 's2', configuration: { model: 'universal-3-5-pro' } }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) { frames.push((raw as Buffer).length); return; }
      const m = JSON.parse(String(raw));
      if (m.type === 'Terminate') {
        ws.send(turn({ turn_order: 0, end_of_turn: true, turn_is_formatted: true, transcript: 'Short.', end_of_turn_confidence: 1, speaker_label: 'UNKNOWN' }));
        ws.send(JSON.stringify({ type: 'Termination' }));
      }
    });
  };

  const session = patchedProvider().openSession({ sampleRateHz: 16000 });
  const got = collect(session);
  await new Promise((r) => setTimeout(r, 150));
  // 16kHz ⇒ 100ms chunk = 3200 bytes. Send 10 dribbles of 500B (5000B total):
  for (let i = 0; i < 10; i++) session.sendAudio(Buffer.alloc(500));
  await new Promise((r) => setTimeout(r, 150));
  session.close();
  await new Promise((r) => setTimeout(r, 250));

  expect(frames[0]).toBe(3200);          // re-buffered up to the chunk size
  expect(frames[1]).toBe(1800);          // close() flushed the ≥50ms remainder
  expect(got[0]?.speaker).toBeUndefined(); // UNKNOWN → unattributed
});
