/**
 * Voice-registry types + loader (the shared speaker→voice registry migrated
 * from the melodeus relay config; see ~/connectome-local/voice-registry).
 */
import { readFileSync } from 'node:fs';
import type { TtsVoice } from './types.js';

export interface RegistryVoice {
  voiceId: string;
  voiceSettings?: { speed?: number; stability?: number; similarityBoost?: number };
  discordName?: string;
  enabled?: boolean;
  narratorVoiceId?: string;
  narratorVoiceSettings?: { speed?: number; stability?: number; similarityBoost?: number };
}

export interface VoiceRegistry {
  ttsModel?: string;
  voices: Record<string, RegistryVoice>;
  speakers?: Record<string, { discordUsername?: string; discordUserId?: string; aliases?: string[] }>;
  defaultBotVoice?: RegistryVoice;
  defaultHumanVoice?: RegistryVoice;
}

export function loadRegistry(path: string): VoiceRegistry {
  return JSON.parse(readFileSync(path, 'utf8')) as VoiceRegistry;
}

/** Resolve a speaker name to a TtsVoice: registry key first, then
 *  discordName, both case-insensitive; disabled voices never match;
 *  defaultBotVoice as fallback. Null = this speaker has no voice. */
export function resolveVoice(registry: VoiceRegistry, name: string): TtsVoice | null {
  const want = name.toLowerCase();
  let v: RegistryVoice | undefined;
  for (const [key, entry] of Object.entries(registry.voices)) {
    if (entry.enabled === false) continue;
    if (key.toLowerCase() === want || entry.discordName?.toLowerCase() === want) { v = entry; break; }
  }
  v ??= registry.defaultBotVoice ?? undefined;
  if (!v) return null;
  return {
    voiceId: v.voiceId,
    model: registry.ttsModel,
    settings: v.voiceSettings,
  };
}
