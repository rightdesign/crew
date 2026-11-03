/**
 * The ship diagnostic bundle (CREW-3008): `GET /diagnostics` on the control
 * API, which the relay's control path carries to a managed ship.
 *
 * It runs a FIXED allow-listed set of read-only probes and returns them as
 * one JSON document. There is no request parameter that names a command, a
 * unit or a path: the caller can only ask for the bundle, never for a shell.
 *
 *  - `doctor`   `crew doctor --json --offline` (via `ControlDeps.doctor`)
 *  - `units`    systemd state of this checkout's crew units
 *  - `journal`  the last `JOURNAL_LINES` lines of those units
 *  - `tunnel`   the persisted tunnel record of each served workspace
 *  - `sandbox`  `ship.runner` and what `openshell sandbox list` reports
 *
 * Each section succeeds or fails alone (`{ ok: false, error }`), so a partial
 * bundle is usable, and the whole collection is bounded by `BUNDLE_BUDGET_MS`
 * (30 s): a section still running at the deadline is reported as timed out.
 *
 * Redaction happens HERE, before the response leaves the ship (a second pass
 * server-side is a separate ticket). `redactValue` replaces the value of any
 * key whose name matches token/key/secret/password/authorization with
 * `[redacted]` at any depth, and `redactText` rewrites `sk_...` keys and
 * bearer credentials inside strings (journal lines, error text, free-form
 * doctor detail). Everything in the bundle goes through both.
 */

import { execFile } from 'node:child_process';
import { readPersistedTunnel } from './tunnel.ts';

export const BUNDLE_BUDGET_MS = 30_000;
export const JOURNAL_LINES = 200;
const MAX_SECTION_BYTES = 256 * 1024;
export const REDACTED = '[redacted]';

const SENSITIVE_KEY_RE = /token|key|secret|password|authorization/i;
const SK_RE = /\bsk_[A-Za-z0-9_-]{4,}/g;
// "Bearer <credential>", also the value of an `Authorization:` header written as `Authorization: Basic xyz`.
const BEARER_RE = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const AUTH_HEADER_RE = /\b(authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+(?:\s+[^\s"',}]+)?/gi;
// `token=abc`, `"api_key": "abc"`, `password: abc` in log text.
const KV_RE = /\b([A-Za-z0-9_.-]*(?:token|key|secret|password)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi;

export function redactText(s: string): string {
  return s
    .replace(AUTH_HEADER_RE, (_m, k: string, sep: string) => `${k}${sep}${REDACTED}`)
    .replace(BEARER_RE, (_m, b: string) => `${b} ${REDACTED}`)
    .replace(SK_RE, REDACTED)
    .replace(KV_RE, (m, k: string, sep: string) => (m.endsWith(REDACTED) ? m : `${k}${sep}${REDACTED}`));
}

export function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [
      k, SENSITIVE_KEY_RE.test(k) && x !== null && x !== undefined && x !== '' ? REDACTED : redactValue(x),
    ]));
  }
  return v;
}

export type Section = { ok: true; data: unknown } | { ok: false; error: string };

export interface Exec { (bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; code: number }> }

export const defaultExec: Exec = (bin, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (e, stdout) => {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(`${bin} is not installed`));
    if (e && (e as { killed?: boolean }).killed) return reject(new Error(`${bin} timed out`));
    resolve({ stdout: String(stdout), code: typeof (e as { code?: unknown } | null)?.code === 'number' ? ((e as { code: number }).code) : 0 });
  });
});

export interface DiagnosticsDeps {
  stateDir: string;
  workspaceIds: string[];
  /** `ship.runner`, as configured. */
  runner: string;
  /** This checkout's systemd unit stems (`labelFor` of each job); empty on a host with no systemd. */
  unitStems: string[];
  /** Whether units live under `systemctl --user` (false: system scope). */
  userScope: boolean;
  doctor: () => Promise<unknown | null>;
  exec?: Exec;
  budgetMs?: number;
  now?: () => number;
}

const clip = (s: string): string => (s.length > MAX_SECTION_BYTES ? `${s.slice(0, MAX_SECTION_BYTES)}\n[truncated]` : s);

export async function collectDiagnostics(d: DiagnosticsDeps): Promise<Record<string, unknown>> {
  const exec = d.exec ?? defaultExec;
  const budget = d.budgetMs ?? BUNDLE_BUDGET_MS;
  const now = d.now ?? Date.now;
  const started = now();
  const left = (): number => Math.max(1, budget - (now() - started));
  const ctl = d.userScope ? ['systemctl', '--user'] : ['systemctl'];
  const jctl = d.userScope ? ['--user'] : [];
  const units = d.unitStems.flatMap((s) => [`${s}.service`, `${s}.timer`]);

  const sections: Record<string, () => Promise<unknown>> = {
    doctor: async () => {
      const doc = await d.doctor();
      if (!doc) throw new Error('could not produce the doctor report');
      return doc;
    },
    units: async () => {
      if (!units.length) throw new Error('no systemd units on this host');
      const out: Record<string, unknown> = {};
      for (const u of units) {
        const r = await exec(ctl[0]!, [...ctl.slice(1), 'show', u, '--no-pager', '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ActiveEnterTimestamp'], left());
        out[u] = Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      }
      return out;
    },
    journal: async () => {
      if (!units.length) throw new Error('no systemd units on this host');
      const r = await exec('journalctl', [...jctl, ...units.flatMap((u) => ['-u', u]), '-n', String(JOURNAL_LINES), '--no-pager', '-o', 'short-iso'], left());
      return { lines: clip(r.stdout).split('\n').filter((l) => l.length) };
    },
    tunnel: async () => Object.fromEntries(d.workspaceIds.map((w) => [w, readPersistedTunnel(d.stateDir, w) ?? null])),
    sandbox: async () => {
      if (d.runner !== 'sandbox') return { runner: d.runner };
      const r = await exec('openshell', ['sandbox', 'list'], left());
      return { runner: d.runner, list: clip(r.stdout).split('\n').filter((l) => l.length), exitCode: r.code };
    },
  };

  const deadline = new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), budget).unref(); });
  const entries = await Promise.all(Object.entries(sections).map(async ([name, run]): Promise<[string, Section]> => {
    try {
      const out = await Promise.race([run(), deadline]);
      if (out === 'timeout') return [name, { ok: false, error: `timed out after ${Math.round(budget / 1000)}s` }];
      return [name, { ok: true, data: redactValue(out) }];
    } catch (e) {
      return [name, { ok: false, error: redactText((e as Error).message) }];
    }
  }));
  return { collectedAt: new Date(started).toISOString(), budgetMs: budget, sections: Object.fromEntries(entries) };
}
