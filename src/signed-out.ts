/**
 * A lane run whose harness answered with its own sign-out error (CREW-2958).
 *
 * The harness exits 0 after one `result` turn reading `Failed to authenticate: OAuth session
 * expired and could not be refreshed`, so the exit code alone logs the run a success, leaves the
 * ticket held and the ship engaged, and says nothing to the operator. This module classifies
 * the stream the way `streamShowsAllowanceRefusal` does (only the harness's own error reporting
 * counts, never a phrase inside a tool result or a user turn) and names the remedy for the
 * toolchain's auth mode.
 */
import { readFileSync } from 'node:fs';
import type { ToolchainSpec } from './toolchain.ts';
import type { ShipAttentionItem } from './ship-attention.ts';

/**
 * What a sign-out message says: the claude.ai wording (`Please run /login`, `Invalid API key`)
 * and the Vertex wording (`OAuth session expired`, `could not be refreshed`,
 * `Reauthentication is needed`, `application default credentials`).
 */
export const SIGNED_OUT_PATTERN =
  /not logged in|please run \/?login|\/login|invalid api key|failed to authenticate|oauth session expired|could not be refreshed|reauthentication is needed|application default credentials/i;

export type AuthMode = 'vertex' | 'api-key' | 'login';

/** Which credential a toolchain's runs depend on: Vertex's ADC, an API key, or the claude.ai login. */
export function authModeOf(spec: Pick<ToolchainSpec, 'env' | 'auth'>, hostEnv: NodeJS.ProcessEnv = process.env): AuthMode {
  const env = { ...hostEnv, ...spec.env };
  const on = (v: string | undefined): boolean => !!v && v !== '0' && v.toLowerCase() !== 'false';
  if (spec.auth === 'subscription') return 'login';
  if (on(env.CLAUDE_CODE_USE_VERTEX)) return 'vertex';
  if (env.ANTHROPIC_API_KEY) return 'api-key';
  return 'login';
}

export const SIGNED_OUT_REMEDY: Record<AuthMode, string> = {
  vertex: 'run `gcloud auth application-default login` on this Mac',
  'api-key': 'check the API key the toolchain uses (ANTHROPIC_API_KEY) is valid and unrevoked',
  login: 'run `claude` in a terminal on this Mac and `/login`',
};

/** The sentence a ship-attention item, `crew doctor` and `crew selftest` all share. */
export function signedOutMessage(toolchain: string, mode: AuthMode): string {
  return `toolchain ${toolchain} is signed out — its runs end at the harness's sign-out error. To fix: ${SIGNED_OUT_REMEDY[mode]}`;
}

export const signedOutKey = (toolchain: string): string => `signed_out:${toolchain}`;

export function signedOutItem(toolchain: string, mode: AuthMode, nowIso = new Date().toISOString()): ShipAttentionItem {
  return { kind: 'signed_out', key: signedOutKey(toolchain), since: nowIso, message: signedOutMessage(toolchain, mode) };
}

const textOf = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

/**
 * Whether the parsed stream shows a sign-out. Counts only the final `result` event flagged
 * `is_error`, an assistant message the harness flagged as an API error, or a run whose single
 * assistant turn is that message with no tool use. A phrase in a tool result or user turn is
 * run content.
 */
export function eventsShowSignedOut(events: unknown[]): boolean {
  let assistantTurns = 0;
  let toolUse = false;
  let onlyTurnSignedOut = false;
  for (const ev of events) {
    if (typeof ev !== 'object' || ev === null) continue;
    const e = ev as { type?: unknown; is_error?: unknown; isApiErrorMessage?: unknown; error?: unknown; result?: unknown; message?: { content?: unknown } };
    if (e.type === 'result') {
      if (e.is_error === true && SIGNED_OUT_PATTERN.test(textOf(e.result))) return true;
    } else if (e.type === 'assistant') {
      assistantTurns++;
      const content = Array.isArray(e.message?.content) ? (e.message!.content as Array<{ type?: string }>) : [];
      if (content.some((b) => b?.type === 'tool_use')) toolUse = true;
      if (SIGNED_OUT_PATTERN.test(textOf(e.message))) {
        if (e.isApiErrorMessage === true || e.error !== undefined) return true;
        onlyTurnSignedOut = true;
      }
    }
  }
  return assistantTurns === 1 && onlyTurnSignedOut && !toolUse;
}

/** `eventsShowSignedOut` over a run's stream file; unreadable or unparseable lines count as nothing. */
export function streamShowsSignedOut(streamPath: string): boolean {
  let raw: string;
  try { raw = readFileSync(streamPath, 'utf8'); } catch { return false; }
  if (!SIGNED_OUT_PATTERN.test(raw)) return false;
  const events: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* not an event */ }
  }
  return eventsShowSignedOut(events);
}

/** A stream with at least one assistant turn that is not the sign-out message: the toolchain works again. */
export function streamShowsRealTurn(streamPath: string): boolean {
  let raw: string;
  try { raw = readFileSync(streamPath, 'utf8'); } catch { return false; }
  return raw.split('\n').some((line) => {
    if (!line.includes('"assistant"')) return false;
    try {
      const e = JSON.parse(line) as { type?: string; isApiErrorMessage?: boolean; error?: unknown; message?: unknown };
      return e.type === 'assistant' && e.isApiErrorMessage !== true && e.error === undefined && !SIGNED_OUT_PATTERN.test(textOf(e.message));
    } catch { return false; }
  });
}

/** Thrown by the daemon after a run ended at the sign-out error, so the role pauses and the item is raised. */
export class SignedOutError extends Error {
  readonly toolchain: string;
  readonly mode: AuthMode;
  constructor(toolchain: string, mode: AuthMode) {
    super(signedOutMessage(toolchain, mode));
    this.toolchain = toolchain;
    this.mode = mode;
  }
}

/** How long a role stays paused on a signed-out toolchain before one run tries it again. */
export const SIGNED_OUT_PAUSE_MS = 15 * 60 * 1000;
