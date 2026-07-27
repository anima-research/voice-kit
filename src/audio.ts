/** PCM helpers shared by voice consumers. All PCM is 16-bit little-endian. */

/** Interleaved stereo → mono by averaging channels. */
export function downmixStereoToMono(stereo: Buffer): Buffer {
  const mono = Buffer.allocUnsafe(stereo.length / 2);
  for (let i = 0; i + 3 < stereo.length; i += 4) {
    const l = stereo.readInt16LE(i);
    const r = stereo.readInt16LE(i + 2);
    mono.writeInt16LE((l + r) >> 1, i / 2);
  }
  return mono;
}

/** Mono at `fromHz` → 48 kHz stereo (Discord playback), linear interpolation.
 *  Speech-grade; the alternative is an ffmpeg host dependency. */
export function monoTo48kStereo(mono: Buffer, fromHz: number): Buffer {
  const inSamples = mono.length / 2;
  const outSamples = Math.floor((inSamples * 48000) / fromHz);
  const out = Buffer.allocUnsafe(outSamples * 4);
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * fromHz) / 48000;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = pos - i0;
    const s = ((1 - frac) * mono.readInt16LE(i0 * 2) + frac * mono.readInt16LE(i1 * 2)) | 0;
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}
