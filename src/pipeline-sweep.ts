/**
 * The cli's side of `release.mode: pipeline` (CREW-2290): builds the context
 * `pipeline-release.ts` works against from the ship's configuration, the
 * repository and the tracker. Kept apart from cli.ts so the mode is one module
 * to read.
 */

import type { Route, Ship } from './config.ts';
import { pipelineProviderFor, ciRemoteOf, isPipelineCiProvider, BUILDKITE_HOST } from './ci-provider.ts';
import type { EffectiveRepoConfig } from './repo-config.ts';
import type { Emitter } from './events.ts';
import { fetchRemote, gitOk, isAncestor, commitDate, latestReleaseTag, resolve, tagCommit } from './git.ts';
import { readForgeToken } from './forges.ts';
import { applyQaStamp, applyStamp } from './stamp.ts';
import { raiseShipAttention, clearShipAttention } from './ship-attention.ts';
import { sweepPipeline, type PipelineContext, type PipelineRelease, type PipelineState } from './pipeline-release.ts';
import type { State } from './state.ts';
import type { Tracker, Ticket } from './tracker.ts';

/** How far back a deployed ticket is checked against what production reports (a rollback older than this is not looked for). */
export const ROLLBACK_LOOKBACK_DAYS = 30;

export interface PipelineSweepInput {
  route: Route;
  ship: Ship;
  scope: string;
  dir: string;
  repo: EffectiveRepoConfig;
  tracker: Tracker;
  state: State;
  emit: Emitter;
  seat?: string;
  /** This repository's open tickets (the cli's `ticketsByRepo` split); the sweep keeps the verified ones. */
  repoTickets: () => Promise<Ticket[]>;
  firstReport: (key: string) => boolean;
}

export type PipelineSweepOutcome =
  /** The release step cannot go on, and why. Nothing was pushed. */
  | { stop: string }
  | { inFlight?: { why: string; url?: string }; state: PipelineState };

/** The newest release commit on `<remote>/<base>`, from its tag; the branch tip when the repo keeps no tag. */
export function latestPipelineRelease(dir: string, repo: EffectiveRepoConfig): PipelineRelease | null {
  const ref = `${repo.branch.remote}/${repo.branch.base}`;
  const tag = latestReleaseTag(dir, repo.release.tagPattern ?? 'v*', ref);
  if (tag) {
    const sha = tagCommit(dir, tag);
    return sha ? { sha, tag, version: tag.replace(/^v/, '') } : null;
  }
  const sha = resolve(dir, ref);
  return sha ? { sha } : null;
}

/**
 * The message for a tracker whose status list lacks the released-to-QA value,
 * or null when it has it (or the list cannot be read, which is not "missing").
 */
export async function missingStatusProblem(tracker: Pick<Tracker, 'contract' | 'statusOptionExists'>): Promise<string | null> {
  const needs = tracker.contract.statuses.releasedToQa;
  if (await tracker.statusOptionExists(needs) !== false) return null;
  return `the tracker's status list has no "${needs}" status, which release.mode "pipeline" needs for tickets released to QA — a person adds it to the Issues app (docs/REPO_SPEC.md, release.pipeline)`;
}

export async function sweepPipelineRoute(i: PipelineSweepInput): Promise<PipelineSweepOutcome> {
  const { repo, tracker, emit, scope } = i;
  const settings = repo.release.pipeline;
  if (!settings) return { stop: `release.mode "pipeline" has no release.pipeline settings in ${repo.file}` };
  if (!isPipelineCiProvider(repo.release.ci.provider)) {
    return { stop: `release.mode "pipeline" reads its runs from release.ci.provider "buildkite"; this repo names "${repo.release.ci.provider}"` };
  }
  const missing = await missingStatusProblem(tracker);
  if (missing) {
    emit.error(`${scope}: ${missing}`, { step: 'release' });
    return { stop: missing };
  }

  const provider = pipelineProviderFor('buildkite', {
    token: (h) => { try { return readForgeToken(i.ship.forges, h, i.ship.stateDir); } catch { return null; } },
  });
  if (!provider) return { stop: 'no buildkite provider' };
  const remote = ciRemoteOf(gitOk(i.dir, ['remote', 'get-url', repo.branch.remote])) ?? { host: BUILDKITE_HOST, remote: scope };
  fetchRemote(i.dir, repo.branch.remote);

  const verifiedStatus = tracker.contract.statuses.verified;
  const verified = (await i.repoTickets()).filter((t) => t.status === verifiedStatus);
  const rel = i.state.release(i.scope);
  const ctx: PipelineContext = {
    scope, settings, provider,
    query: { host: remote.host, remote: remote.remote, base: repo.branch.base },
    contract: tracker.contract, emit,
    attention: {
      raise: (item) => raiseShipAttention({ state: i.state, emit, route: i.route, ship: i.ship }, item),
      clear: (key) => clearShipAttention(i.state, key),
    },
    isAncestor: (a, b) => isAncestor(i.dir, a, b),
    commitDate: (sha) => commitDate(i.dir, sha),
    firstReport: i.firstReport,
  };
  const { state } = await sweepPipeline(ctx, latestPipelineRelease(i.dir, repo), verified, {
    markReleasedToQa: async (tickets, r) => { await applyQaStamp(tracker, tickets, r.version, tracker.contract, emit, i.seat); },
    lastSeen: () => rel.pipelineProductionSeen(),
    noteSeen: (sha) => rel.notePipelineProductionSeen(sha),
    releasedToQa: () => tracker.ticketsAtStatus(tracker.contract.statuses.releasedToQa),
    recentlyDeployed: () => tracker.ticketsAtStatus(tracker.contract.statuses.deployed, [{
      columnName: 'released_at', operator: 'GTE', value: new Date(Date.now() - ROLLBACK_LOOKBACK_DAYS * 86_400_000).toISOString(),
    }]),
    markDeployed: async (tickets: Ticket[]) => {
      await applyStamp(tracker, tickets.map((ticket) => ({ ticket, reason: 'production reports its commit' })), undefined, tracker.contract, emit, false, i.dir, i.seat);
    },
  });
  return state.kind === 'in-flight' ? { inFlight: { why: state.why, ...(state.url ? { url: state.url } : {}) }, state } : { state };
}
