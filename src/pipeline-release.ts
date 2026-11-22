/**
 * `release.mode: pipeline` (CREW-2290).
 *
 * A pushed release commit starts a CI pipeline that builds it and deploys it to
 * QA by itself; production is released from the same pipeline by a person
 * pressing a gated button, much less often. So one event becomes two, and the
 * crew never triggers or deploys anything:
 *
 *   - `settlePipeline` follows the run for the newest release commit. While it
 *     runs, the release step pushes nothing more. On a passed run it asks QA
 *     whether it answers (`/api/ready`) and reports that commit
 *     (`/api/health-check`), on every role, and only then marks the release's
 *     tickets released to QA. A failed run, or QA not reporting within a bound,
 *     is reported with the pipeline link and leaves the tickets where they were.
 *   - `watchProduction` reads production's `health-check` and marks every ticket
 *     released to QA whose merged work production's commit contains as deployed.
 *     A commit that does not contain a ticket's work leaves it alone, so a
 *     rollback closes nothing; a ticket already deployed whose work production no
 *     longer contains is flagged for the operator and never reopened.
 *
 * Waiting happens across release cycles, not inside one: a run takes tens of
 * minutes and the release lock must not be held for them. Both functions are
 * stateless apart from the production commit last seen (rollback detection), so
 * any ship's next cycle picks up where another left off: which tickets a run
 * carries is read from the tickets themselves (`verified` with a `commit_sha`
 * that the release commit contains), as `release.mode: ci_*` does after a restart.
 *
 * Everything outside the repo and the clock is injected so the whole mode is
 * tested against stubs.
 */

import type { PipelineRole, PipelineSettings } from './repo-config.ts';
import type { CiProvider, CiQuery, CiRun, CiRunFailure } from './ci-provider.ts';
import { describeCiFailure } from './ci-provider.ts';
import type { Contract } from './contract.ts';
import type { Emitter } from './events.ts';
import type { ShipAttentionItem } from './ship-attention.ts';
import { displayKey, type Ticket } from './tracker.ts';

/** One HTTP answer; `null` when the address could not be reached at all. */
export type Probe = (url: string) => Promise<{ status: number; body: string } | null>;

export const defaultProbe: Probe = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow', headers: { accept: 'application/json' } });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  }
};

export interface PipelineContext {
  /** The release scope, `route/repo`, for attention keys and messages. */
  scope: string;
  settings: PipelineSettings;
  provider: CiProvider;
  /** What the provider needs besides the commit. */
  query: Omit<CiQuery, 'sha' | 'tag' | 'pipeline'>;
  contract: Contract;
  emit: Emitter;
  attention?: {
    raise(item: ShipAttentionItem): Promise<unknown> | void;
    clear(key: string): void;
  };
  probe?: Probe;
  /** Whether `ancestor` is contained in `descendant`; false when either is unknown to this checkout. */
  isAncestor(ancestor: string, descendant: string): boolean;
  /** The committer date of a commit, ISO, or null. */
  commitDate(sha: string): string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** True the first time `key` is asked in this process; keeps a standing failure from repeating its log line every cycle. */
  firstReport?: (key: string) => boolean;
}

/** The newest release commit, and what the pipeline has to say about it. */
export interface PipelineRelease {
  sha: string;
  /** The version the release carried; absent for a repo that does not version. */
  version?: string;
  tag?: string;
}

export type PipelineState =
  /** Nothing to follow: every ticket the release carried is already released to QA (or none was verified). */
  | { kind: 'idle' }
  /** A run is still going, or its status cannot be read; no further release may be pushed. */
  | { kind: 'in-flight'; why: string; url?: string }
  | { kind: 'released-to-qa'; tickets: Ticket[] }
  /** The run failed, never appeared, or QA did not report the commit; the tickets stay verified. */
  | { kind: 'failed'; why: string; url?: string };

const sleepFor = (c: PipelineContext, ms: number): Promise<void> => (c.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
const nowOf = (c: PipelineContext): number => (c.now ?? Date.now)();
const failKey = (c: PipelineContext, sha: string): string => `ci_run_failed:${c.scope}/pipeline-${sha.slice(0, 8)}`;
const rollbackKey = (c: PipelineContext): string => `ci_run_failed:${c.scope}/production-rollback`;

/** The commit a service reports on `/api/health-check`, or null when it reports none. */
export function commitFromHealth(body: string): string | null {
  try {
    const json = JSON.parse(body) as { commit?: unknown };
    const c = typeof json.commit === 'string' ? json.commit.trim() : '';
    return /^[0-9a-f]{7,40}$/i.test(c) ? c.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Two commit ids name the same commit when one is a prefix of the other and both are at least seven characters. */
export const sameCommit = (a: string, b: string): boolean =>
  a.length >= 7 && b.length >= 7 && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));

interface RoleReading { role: string; url: string; ready?: boolean; commit: string | null; reachable: boolean }

async function readRole(c: PipelineContext, r: PipelineRole, withReady: boolean): Promise<RoleReading> {
  const probe = c.probe ?? defaultProbe;
  const health = await probe(`${r.url}/api/health-check`);
  const reading: RoleReading = {
    role: r.role, url: r.url, reachable: !!health,
    commit: health && health.status >= 200 && health.status < 300 ? commitFromHealth(health.body) : null,
  };
  if (withReady) {
    const ready = await probe(`${r.url}/api/ready`);
    reading.ready = !!ready && ready.status >= 200 && ready.status < 300;
  }
  return reading;
}

/**
 * Whether QA answers and reports `sha` on every role, polled for up to
 * `qaTimeoutSeconds`. The pipeline's own deploy step may finish a little after
 * the run is green, so a first miss is not yet a failure.
 */
export async function qaReports(c: PipelineContext, sha: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const { qa, qaTimeoutSeconds, qaIntervalSeconds } = c.settings;
  const deadline = nowOf(c) + qaTimeoutSeconds * 1000;
  let lastWhy = '';
  for (;;) {
    const readings = await Promise.all(qa.map((r) => readRole(c, r, true)));
    const problems = readings.flatMap((r) => {
      if (!r.reachable) return [`${r.role} (${r.url}) is unreachable`];
      if (!r.ready) return [`${r.role} (${r.url}) is not ready`];
      if (!r.commit) return [`${r.role} (${r.url}) reports no commit`];
      return sameCommit(r.commit, sha) ? [] : [`${r.role} (${r.url}) reports ${r.commit.slice(0, 8)}`];
    });
    if (problems.length === 0) return { ok: true };
    lastWhy = problems.join('; ');
    if (nowOf(c) >= deadline) return { ok: false, why: `QA did not report ${sha.slice(0, 8)} within ${qaTimeoutSeconds}s: ${lastWhy}` };
    await sleepFor(c, qaIntervalSeconds * 1000);
  }
}

async function reportFailure(c: PipelineContext, rel: PipelineRelease, headline: string, url?: string): Promise<void> {
  const label = rel.version ?? rel.sha.slice(0, 8);
  const key = failKey(c, rel.sha);
  if (!c.firstReport || c.firstReport(key)) {
    c.emit.error(`pipeline release ${label}: ${headline}${url ? ` (${url})` : ''} — its tickets stay verified`, { step: 'release', data: { sha: rel.sha, ...(url ? { url } : {}) } });
  }
  await c.attention?.raise({
    kind: 'ci_run_failed', key,
    message: `${c.scope}: pipeline release ${label} — ${headline}`,
    since: new Date().toISOString(),
    ci: { ...(url ? { url } : {}), blocking: true, repo: c.scope, version: label },
  });
}

/**
 * Follows the pipeline run for release `rel`. `carried` are the tickets still at
 * `verified` whose merged work `rel.sha` contains; `markReleasedToQa` writes them
 * (and is only called for a run that passed and a QA that reports the commit).
 */
export async function settlePipeline(
  c: PipelineContext, rel: PipelineRelease, carried: Ticket[],
  markReleasedToQa: (tickets: Ticket[], rel: PipelineRelease) => Promise<void>,
): Promise<PipelineState> {
  if (carried.length === 0) return { kind: 'idle' };
  const q: CiQuery = { ...c.query, sha: rel.sha, ...(rel.tag ? { tag: rel.tag } : {}), pipeline: c.settings.pipeline };
  const got = await c.provider.runs(q);
  if (!got.ok) {
    c.emit.warn(`pipeline release ${rel.version ?? rel.sha.slice(0, 8)}: cannot read the ${c.provider.name} runs (${got.why}) — not releasing again until it can be read`, { step: 'release' });
    return { kind: 'in-flight', why: `cannot read the ${c.provider.name} runs: ${got.why}` };
  }
  const runs: CiRun[] = got.runs;
  const link = runs.find((r) => r.url)?.url;

  if (runs.length === 0) {
    const at = c.commitDate(rel.sha);
    const age = at ? nowOf(c) - new Date(at).getTime() : 0;
    if (age < c.settings.startTimeoutSeconds * 1000) {
      return { kind: 'in-flight', why: `no ${c.provider.name} run for ${rel.sha.slice(0, 8)} yet` };
    }
    const why = `no ${c.provider.name} run appeared for ${rel.sha.slice(0, 8)} within ${c.settings.startTimeoutSeconds}s of the push`;
    await reportFailure(c, rel, why);
    return { kind: 'failed', why };
  }
  const pending = runs.filter((r) => r.state === 'pending');
  if (pending.length) return { kind: 'in-flight', why: `${pending[0]!.name} is running`, url: pending[0]!.url || undefined };

  const failed = runs.filter((r) => r.state === 'failed');
  if (failed.length) {
    const details: CiRunFailure[] = [];
    for (const r of failed) details.push(await c.provider.failure(q, r));
    const why = details.map(describeCiFailure).join('; ');
    await reportFailure(c, rel, `run failed: ${why}`, failed.find((r) => r.url)?.url);
    return { kind: 'failed', why, url: failed.find((r) => r.url)?.url };
  }

  const qa = await qaReports(c, rel.sha);
  if (!qa.ok) {
    await reportFailure(c, rel, qa.why, link);
    return { kind: 'failed', why: qa.why, ...(link ? { url: link } : {}) };
  }
  c.attention?.clear(failKey(c, rel.sha));
  await markReleasedToQa(carried, rel);
  c.emit.emit(
    `pipeline release ${rel.version ?? rel.sha.slice(0, 8)}: QA reports ${rel.sha.slice(0, 8)} — ${carried.length} ticket(s) released to QA`,
    { step: 'release', data: { sha: rel.sha, tickets: carried.map(displayKey) } },
  );
  return { kind: 'released-to-qa', tickets: carried };
}

export type ProductionReading =
  | { kind: 'unreadable'; why: string }
  | { kind: 'mixed'; commits: string[] }
  | { kind: 'commit'; sha: string };

/** What production reports: one commit when every role agrees on it. */
export async function readProduction(c: PipelineContext): Promise<ProductionReading> {
  const readings = await Promise.all(c.settings.production.map((r) => readRole(c, r, false)));
  const bad = readings.filter((r) => !r.commit);
  if (bad.length) return { kind: 'unreadable', why: `${bad.map((r) => `${r.role} (${r.url})`).join(', ')} reports no commit` };
  const commits = [...new Set(readings.map((r) => r.commit!))];
  // A rollout in progress has one role ahead of the other; nothing is concluded until they agree.
  if (commits.length > 1 && !commits.every((x) => sameCommit(x, commits[0]!))) return { kind: 'mixed', commits };
  return { kind: 'commit', sha: commits[0]! };
}

export interface ProductionOps {
  /** The production commit seen on the previous look, or null the first time. */
  lastSeen(): string | null;
  noteSeen(sha: string): void;
  /** Tickets at released-to-QA. */
  releasedToQa(): Promise<Ticket[]>;
  /** Tickets deployed recently enough to be worth checking against a rollback. */
  recentlyDeployed(): Promise<Ticket[]>;
  markDeployed(tickets: Ticket[], productionSha: string): Promise<void>;
}

export interface ProductionResult {
  reading: ProductionReading;
  deployed: Ticket[];
  /** Tickets at released-to-QA that production's commit does not contain. */
  waiting: Ticket[];
  /** Deployed tickets whose work production no longer contains. */
  flagged: Ticket[];
}

const commitOf = (t: Ticket): string | null => (typeof t.commit_sha === 'string' && t.commit_sha ? t.commit_sha : null);

/**
 * One look at production. A ticket moves to deployed when production's commit
 * contains its merged work; one it does not contain stays released to QA. When
 * the reported commit has changed since the last look, deployed tickets whose
 * work it does not contain are flagged (attention, never a status change).
 */
export async function watchProduction(c: PipelineContext, ops: ProductionOps): Promise<ProductionResult> {
  const reading = await readProduction(c);
  const none: ProductionResult = { reading, deployed: [], waiting: [], flagged: [] };
  if (reading.kind === 'unreadable') {
    if (!c.firstReport || c.firstReport(`${c.scope}:production-unreadable`)) {
      c.emit.warn(`production health-check: ${reading.why} — not changing any ticket`, { step: 'release' });
    }
    return none;
  }
  if (reading.kind === 'mixed') {
    c.emit.emit(`production roles report different commits (${reading.commits.map((x) => x.slice(0, 8)).join(', ')}) — a rollout is in progress; waiting`, { step: 'release' });
    return none;
  }
  const prod = reading.sha;
  const contained = (t: Ticket): boolean => {
    const sha = commitOf(t);
    return !!sha && (sameCommit(sha, prod) || c.isAncestor(sha, prod));
  };
  const queued = await ops.releasedToQa();
  const deployed = queued.filter(contained);
  const waiting = queued.filter((t) => !contained(t));
  if (deployed.length) {
    await ops.markDeployed(deployed, prod);
    c.emit.emit(`production reports ${prod.slice(0, 8)} — ${deployed.length} ticket(s) deployed: ${deployed.map(displayKey).join(', ')}`, { step: 'release', data: { sha: prod } });
  }

  let flagged: Ticket[] = [];
  if (ops.lastSeen() !== prod) {
    flagged = (await ops.recentlyDeployed()).filter((t) => commitOf(t) && !contained(t));
    if (flagged.length) {
      const names = flagged.map(displayKey).join(', ');
      c.emit.warn(`production now reports ${prod.slice(0, 8)}, which does not contain the work of ${names} — they stay deployed; a person decides`, { step: 'release' });
      await c.attention?.raise({
        kind: 'ci_run_failed', key: rollbackKey(c),
        message: `${c.scope}: production reports ${prod.slice(0, 8)}, which does not contain the work of ${names} (already deployed, left as they are)`,
        since: new Date().toISOString(),
        ci: { blocking: false, repo: c.scope, version: prod.slice(0, 8) },
      });
    } else {
      c.attention?.clear(rollbackKey(c));
    }
    ops.noteSeen(prod);
  }
  return { reading, deployed, waiting, flagged };
}

export interface SweepOps extends ProductionOps {
  /** Writes released-to-QA on the tickets the run carried. */
  markReleasedToQa(tickets: Ticket[], rel: PipelineRelease): Promise<void>;
}

export interface SweepResult {
  state: PipelineState;
  production: ProductionResult;
}

/**
 * One look at a pipeline route, before any release is decided: settle the run
 * for the newest release commit, then read production. `verified` is the
 * repo's tickets at the verified status (open tickets, so QA-released ones are
 * not among them); `latest` is the newest release commit, or null when the repo
 * has none yet.
 */
export async function sweepPipeline(
  c: PipelineContext, latest: PipelineRelease | null, verified: Ticket[], ops: SweepOps,
): Promise<SweepResult> {
  let state: PipelineState = { kind: 'idle' };
  if (latest) {
    const carried = verified.filter((t) => {
      const sha = commitOf(t);
      return !!sha && (sameCommit(sha, latest.sha) || c.isAncestor(sha, latest.sha));
    });
    state = await settlePipeline(c, latest, carried, ops.markReleasedToQa);
  }
  const production = await watchProduction(c, ops);
  return { state, production };
}
