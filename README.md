# @animalabs/voice-kit

A provider seam for speech in Connectome. It defines one set of STT and TTS
interfaces, adapters for the vendors we use, and the audio helpers around them.
It knows nothing about Discord or any other surface: consumers such as
`@animalabs/discord-mcpl`'s voice leg open sessions and streams through these
interfaces and never touch a vendor API directly.

```sh
npm install @animalabs/voice-kit
```

## What's in it

| Export | What it is |
|---|---|
| `SttProvider`, `SttSession`, `SttTranscript`, `SttSessionOptions` | Speech-to-text interfaces |
| `TtsProvider`, `TtsStream`, `TtsVoice`, `TtsAlignment` | Text-to-speech interfaces |
| `ScribeSttProvider` | ElevenLabs Scribe realtime STT |
| `AssemblyAiSttProvider` | AssemblyAI realtime STT |
| `ElevenLabsTtsProvider` | ElevenLabs streaming TTS (stream-input), with character timing |
| `EnergyVad`, `dbfs` | An energy-based voice activity detector |
| `downmixStereoToMono`, `monoTo48kStereo` | PCM conversion to and from Discord's 48 kHz stereo |
| `loadRegistry`, `resolveVoice`, `VoiceRegistry`, `RegistryVoice` | The speaker-to-voice registry format |

Each provider takes its API key in its constructor.

## Contracts

- **Transcripts can be revised.** A transcript event is keyed by `utteranceId`,
  and any field (text, speaker, even `final`) may arrive again for the same id.
  Treat the latest event per id as the truth. AssemblyAI revises text and
  speaker labels after an utterance is final; Scribe sends growing partials and
  then a commit.
- **Speaker labels are optional.** A per-speaker source, such as Discord's
  receiver streams, runs one session per speaker and leaves `speaker` unset. On
  a mixed feed, a diarizing provider fills `speaker` with its own opaque label,
  which can also be revised.
- **PCM in, PCM out.** Audio is PCM16LE mono. An STT session declares its input
  rate when it opens, and a TTS provider declares its output rate
  (`outputRateHz`). Converting to and from a surface's format is the consumer's
  job; `audio.ts` has the helpers.
- **TTS timing is optional.** When a provider has character timing for a chunk,
  `onAlignment` fires before that chunk's `onAudio`, with times in milliseconds
  from the start of the stream and characters matching the text as it was sent.
  A provider without timing never fires it.

## Development

```sh
npm install
npm run build      # tsc → dist/
npm test           # bun test
npm run test:node  # the same tests under Node
```

Releases publish from a `v*` tag through GitHub Actions with npm trusted
publishing (see `.github/workflows/publish.yml`).

## License

MIT
