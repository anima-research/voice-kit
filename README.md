# voice-kit

A TypeScript library for streaming speech in Node.js. It has one set of interfaces for speech-to-text (STT) and text-to-speech (TTS) providers, adapters for ElevenLabs and AssemblyAI, an energy-based voice activity detector, PCM helpers, and a registry that maps speakers to voices. It doesn't connect to Discord or Portal itself. The programs that use it bring their own audio in and out.

[discord-mcpl](https://github.com/anima-research/discord-mcpl) and `portal-relay`, in [portal](https://github.com/anima-research/portal), use it for Discord voice.

## Installing

voice-kit isn't published on npm. Clone it beside your project and build it, since its `main`, `types` and `exports` point into `dist/`:

```sh
git clone https://github.com/anima-research/voice-kit.git
cd voice-kit
npm ci
npm run build
```

Then depend on it by path, as discord-mcpl does:

```json
{
  "dependencies": {
    "@animalabs/voice-kit": "file:../voice-kit"
  }
}
```

It's an ES module (`"type": "module"`, with no CommonJS build). It needs Node.js 20 or later, and its one runtime dependency is `ws`.

## What's in it

| Export | What it is |
|---|---|
| `SttProvider`, `SttSession`, `SttSessionOptions`, `SttTranscript` | The STT interfaces. A provider opens a session, you feed it audio, and it reports transcripts. |
| `TtsProvider`, `TtsStream`, `TtsVoice`, `TtsAlignment` | The TTS interfaces. A provider opens a stream for a voice, you feed it text as you have it, and it reports audio. |
| `ScribeSttProvider` | STT with ElevenLabs Scribe v2 Realtime |
| `AssemblyAiSttProvider` | STT with AssemblyAI v3 Universal-Streaming |
| `ElevenLabsTtsProvider` | TTS with ElevenLabs' stream-input API |
| `EnergyVad`, `dbfs` | Voice activity detection by audio level, and the level of a buffer in dBFS |
| `downmixStereoToMono`, `monoTo48kStereo` | PCM conversions between interleaved stereo and mono |
| `loadRegistry`, `resolveVoice`, `VoiceRegistry`, `RegistryVoice` | A JSON registry of voices, and the lookup of a speaker's voice in it |

Each provider takes its API key as its first constructor argument. voice-kit reads no keys from the environment.

## How the interfaces behave

All audio is 16-bit little-endian PCM. An STT session takes mono audio at the `sampleRateHz` it was opened with. A TTS stream produces mono audio at its provider's `outputRateHz`. `downmixStereoToMono(pcm)` averages interleaved stereo to mono, and `monoTo48kStereo(pcm, fromHz)` resamples mono at `fromHz` to 48 kHz stereo, the format Discord plays.

A transcript event carries the whole current text of one utterance, keyed by `utteranceId`. A later event with the same id replaces the earlier one, and may change its `text`, its `speaker` or its `final` flag. `final: true` means the provider considers the utterance ended, not that it won't change. AssemblyAI, for one, corrects speaker labels when its session ends, so keep the latest event for each id. Ids are unique within a session, not across sessions, so keep each session's events apart.

A TTS stream takes text in pieces with `sendText`, and `end()` says no more is coming. `onAudio` delivers the audio, and `onEnd` fires once all of it has been delivered. When the provider sends character timing, `onAlignment` fires before the audio it describes, with each character's start and duration in milliseconds from the start of the stream's audio. A program that stops playback partway and calls `abort()` can use that timing to work out which characters had been heard. They're characters of the text it sent only when the provider aligns that text, as the ElevenLabs row below explains.

## Providers

| Class | Notes |
|---|---|
| `ScribeSttProvider(apiKey)` | Model `scribe_v2_realtime`. Takes 8000, 16000, 22050, 24000, 44100 or 48000 Hz, and `openSession` throws for any other rate. Reports no speakers, so give each speaker a session of their own. Only `commit()` makes an utterance `final`. It reports the text committed so far as final at once, and again 1.5 seconds later, under the same id, with what Scribe has committed by then. Text that Scribe commits on its own arrives with `final: false`. |
| `AssemblyAiSttProvider(apiKey, { model })` | Model `universal-3-5-pro` unless `model` names another. For speaker labels, open the session with `diarize: true`. AssemblyAI corrects labels when the session ends. After `close()`, the session asks AssemblyAI to end it and keeps reading, so the corrections arrive as transcript events. Ten seconds after `close()` it also starts closing the WebSocket, in case AssemblyAI doesn't end the session. If `ASSEMBLYAI_WS_BASE` is set, it replaces the endpoint `wss://streaming.assemblyai.com/v3/ws`. |
| `ElevenLabsTtsProvider(apiKey, defaultModel)` | Model `eleven_multilingual_v2` unless `defaultModel` or the voice's `model` names another. Produces 44.1 kHz audio. Its character timing is for your text as sent when ElevenLabs reports that, and otherwise for ElevenLabs' normalized text, with durations of 0 when ElevenLabs sends none. Whether ElevenLabs' times count from each chunk or from the stream's start, it decides by a heuristic (`alignmentBase`), which its comment says to check against the live service. |

The ElevenLabs providers' header comments say their wire protocols were checked against the live service on 26 July 2026. The AssemblyAI provider's says it was written from AssemblyAI's documentation and needs one live run with an API key before production use.

## Example

`pcm` stands for audio your program receives, and `play` for however it plays audio.

```ts
import { ElevenLabsTtsProvider, ScribeSttProvider } from '@animalabs/voice-kit';

const apiKey = process.env.ELEVENLABS_API_KEY!;

// Speech to text: feed 16 kHz mono PCM, and keep the latest text of each utterance.
const stt = new ScribeSttProvider(apiKey);
const session = stt.openSession({ sampleRateHz: 16000, language: 'en' });
const utterances = new Map<string, string>();
session.onTranscript((t) => {
  utterances.set(t.utteranceId, t.text);
  if (t.final) console.log(t.utteranceId, t.text); // the same id can come again, revised
});
session.onError((err) => console.error(err));
session.sendAudio(pcm); // each time audio arrives
session.commit(); // when your own silence detection says the speaker stopped
session.close();

// Text to speech: send text as you have it, and play the audio as it comes.
const tts = new ElevenLabsTtsProvider(apiKey);
const stream = tts.openStream({ voiceId: 'YOUR_VOICE_ID' });
stream.onAudio((chunk) => play(chunk, tts.outputRateHz));
stream.onEnd(() => console.log('done speaking'));
stream.onError((err) => console.error(err));
stream.sendText('Hello, ');
stream.sendText('world.');
stream.end();
```

## Voice activity detection

`EnergyVad` splits PCM into 20 ms frames and compares each frame's level with `thresholdDb` (default -45 dBFS). Speech starts after `onsetMs` (default 60 ms) of consecutive frames at or above it, and ends after `hangoverMs` (default 300 ms) of consecutive frames below it. It counts time by the audio it's fed, not the clock, so when the audio stops, call `end()`, which closes an open utterance and fires `onSpeechEnd`. `onSpeechSustained(ms, fn)` fires once per utterance, when the utterance's frames at or above the threshold add up to `ms`.

```ts
import { EnergyVad } from '@animalabs/voice-kit';

const vad = new EnergyVad({ rateHz: 48000, channels: 2 });
vad.onSpeechStart(() => console.log('speaking'));
vad.onSpeechEnd(() => console.log('stopped'));
vad.feed(pcm); // each time audio arrives
vad.end(); // when the audio stops
```

## Voice registry

`loadRegistry(path)` reads a JSON file shaped as `VoiceRegistry`. `resolveVoice(registry, name)` reads only its `voices`, `ttsModel` and `defaultBotVoice`. It returns a `TtsVoice` made from the first voice whose key or `discordName` matches the name, ignoring case and skipping voices with `enabled: false`. Without a match it uses `defaultBotVoice`, enabled or not, and it returns `null` if the registry has none. The returned voice's model is the registry's `ttsModel`.

## Building and testing

```sh
npm ci
npm run build      # tsc, into dist/
npm run typecheck
npm test           # bun test, so Bun must be installed
```

The tests cover `EnergyVad` on mono audio, and the AssemblyAI provider against a mock server on local port 8957. None calls a real service, and the ElevenLabs providers have no tests.

## License

MIT. See [LICENSE](LICENSE).
