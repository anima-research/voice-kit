// EnergyVad: onset, hangover, hot-mic noise rejection — audio-time driven,
// no wall clock, no network.
import { describe, expect, test } from 'bun:test';
import { EnergyVad, dbfs } from '../src/vad.js';

const RATE = 48000;

/** ms of mono PCM16 sine at the given peak amplitude (0..32767). */
function tone(ms: number, amplitude: number, freq = 200): Buffer {
  const n = Math.floor((RATE * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / RATE)), i * 2);
  }
  return buf;
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.floor((RATE * ms) / 1000) * 2);
}

function vad(thresholdDb = -45) {
  const v = new EnergyVad({ rateHz: RATE, thresholdDb, onsetMs: 60, hangoverMs: 300 });
  const events: string[] = [];
  v.onSpeechStart(() => events.push('start'));
  v.onSpeechEnd(() => events.push('end'));
  return { v, events };
}

test('dbfs: full-scale sine ≈ -3 dB, silence = -Inf', () => {
  expect(dbfs(tone(100, 32767))).toBeGreaterThan(-4);
  expect(dbfs(tone(100, 32767))).toBeLessThan(-2);
  expect(dbfs(silence(100))).toBe(-Infinity);
});

test('speech opens after onset, closes after hangover', () => {
  const { v, events } = vad();
  v.feed(tone(40, 8000));          // -12 dB but only 40ms — below onset
  expect(events).toEqual([]);
  v.feed(tone(40, 8000));          // cumulative 80ms voiced → open
  expect(events).toEqual(['start']);
  v.feed(silence(200));            // inside hangover — still open
  expect(events).toEqual(['start']);
  v.feed(silence(200));            // 400ms total silence → close
  expect(events).toEqual(['start', 'end']);
});

test('hot mic: continuous low-level noise never opens', () => {
  const { v, events } = vad();
  // ~-50 dBFS noise floor, minutes of it — the antra_tessera scenario.
  for (let i = 0; i < 100; i++) v.feed(tone(100, 100, 731));
  expect(events).toEqual([]);
  expect(v.speaking).toBe(false);
});

test('click/pop rejection: isolated voiced blips reset at silence', () => {
  const { v, events } = vad();
  v.feed(tone(20, 20000));   // one loud frame (unmute pop)
  v.feed(silence(100));      // gap resets onset accumulation
  v.feed(tone(20, 20000));   // another pop
  v.feed(silence(100));
  expect(events).toEqual([]);
});

test('intra-word gaps do not flap: hangover bridges them', () => {
  const { v, events } = vad();
  v.feed(tone(80, 8000));    // open
  v.feed(silence(150));      // inter-word gap < hangover
  v.feed(tone(80, 8000));    // still one utterance
  v.feed(silence(150));
  v.feed(tone(80, 8000));
  expect(events).toEqual(['start']);
  v.end();                   // stream closed → force end
  expect(events).toEqual(['start', 'end']);
});

test('sustained fires on cumulative VOICED time — hangover never counts', () => {
  const v = new EnergyVad({ rateHz: RATE, thresholdDb: -45, onsetMs: 60, hangoverMs: 300 });
  const events: string[] = [];
  v.onSpeechStart(() => events.push('start'));
  v.onSpeechSustained(250, () => events.push('sustained'));

  // The antra unmute regression: an 80 ms transient opens speech, then the
  // signal returns to floor. Presence lingers 300 ms on hangover — but
  // voiced time is only 80 ms, so sustained must NOT fire.
  v.feed(tone(80, 20000));
  v.feed(silence(280)); // deep into hangover, speech still "open"
  expect(events).toEqual(['start']);

  // Real speech: keep talking — sustained fires at 250 ms of voiced audio.
  v.feed(tone(200, 8000));
  expect(events).toEqual(['start', 'sustained']);
});

test('sustained re-arms per utterance', () => {
  const v = new EnergyVad({ rateHz: RATE, thresholdDb: -45, onsetMs: 60, hangoverMs: 300 });
  let fired = 0;
  v.onSpeechSustained(100, () => fired++);
  v.feed(tone(150, 8000));   // utterance 1 → fires
  v.feed(silence(400));      // close
  expect(fired).toBe(1);
  v.feed(tone(150, 8000));   // utterance 2 → fires again
  expect(fired).toBe(2);
  v.feed(tone(500, 8000));   // same utterance — once only
  expect(fired).toBe(2);
});

test('end() without open speech emits nothing', () => {
  const { v, events } = vad();
  v.feed(tone(100, 100));
  v.end();
  expect(events).toEqual([]);
});
