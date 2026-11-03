/**
 * CREW-3023: a persona brief (`personas/lane-<role>.md`) may open with a YAML
 * front matter block declaring settings for the persona's Agents row. Only
 * `chat_enabled` is read today. The block is never part of the prompt: the
 * row's prompt, and the prompt a run assembles, is the body after it, so a
 * brief that gains front matter does not look edited to a workspace that
 * synced the bare body earlier.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface PersonaFile {
  /** The brief with any leading front matter block removed. */
  body: string;
  /** `chat_enabled` as declared in the front matter; undefined when not declared. */
  chatEnabled?: boolean;
}

export function parsePersonaText(text: string, path: string): PersonaFile {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) return { body: text };
  const meta = (parseYaml(match[1]!) ?? {}) as { chat_enabled?: unknown };
  if (meta.chat_enabled !== undefined && meta.chat_enabled !== null && typeof meta.chat_enabled !== 'boolean') {
    throw new Error(`${path}: front matter "chat_enabled" must be true or false`);
  }
  return { body: match[2]!, ...(typeof meta.chat_enabled === 'boolean' ? { chatEnabled: meta.chat_enabled } : {}) };
}

export function readPersonaFile(path: string): PersonaFile {
  return parsePersonaText(readFileSync(path, 'utf8'), path);
}
