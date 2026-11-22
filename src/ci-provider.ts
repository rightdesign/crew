/**
 * What the CI provider says about the runs a release started (CREW-3470).
 *
 * In `ci_auto`/`ci_manual` the crew pushes the release commit and tag and then
 * learns the outcome only from the repo's `released` hook. A run that fails is
 * then indistinguishable from one that is slow. `release.ci.provider` names a
 * provider the crew can ask: this module is the interface behind that key and
 * the one implementation (`github`) that exists today. `buildkite` is declared
 * and has no implementation, so it behaves exactly as `other` and `none`:
 * never queried.
 *
 * Runs are matched by commit and ref, never by workflow name, so nothing has
 * to be configured: every run the provider reports for the release commit is a
 * candidate, and the ref says whether the tag started it or the push to the
 * base branch did.
 *
 * Failing to ask is not a CI failure. Every problem reaching the provider
 * (no credential, no permission, rate limiting, unreachable) comes back as
 * `{ ok: false, why }`, and the caller falls back to today's behavior.
 */

export type CiRunState = 'pending' | 'passed' | 'failed' | 'other';

export interface CiRun {
  id: string;
  name: string;
  url: string;
  state: CiRunState;
  /** `tag`: started by the release tag. `base`: started by the push to the base branch. */
  ref: 'tag' | 'base' | 'other';
}

/** A failed run with what could be learned about where it failed; every detail is best effort. */
export interface CiRunFailure {
  run: CiRun;
  job?: string;
  step?: string;
  /** The last lines of the failing job's log. */
  logTail?: string;
}

export interface CiQuery {
  /** The forge host, `github.com` unless the repository lives elsewhere. */
  host: string;
  /** `owner/name`. */
  remote: string;
  /** The release commit. */
  sha: string;
  /** The release tag, when the release cut one. */
  tag?: string;
  base: string;
  /** The provider's own pipeline identifier (Buildkite: `org/slug`), for providers that are not keyed by repository. */
  pipeline?: string;
}

export type CiQueryOutcome = { ok: true; runs: CiRun[] } | { ok: false; why: string };

export interface CiProvider {
  readonly name: string;
  /** Every run reported for the release commit. Never throws. */
  runs(q: CiQuery): Promise<CiQueryOutcome>;
  /** Where `run` failed. Never throws; returns the bare run when nothing more is known. */
  failure(q: CiQuery, run: CiRun): Promise<CiRunFailure>;
}

export interface CiProviderDeps {
  /** The ship's forge token for `host`; null when none is configured or readable. */
  token(host: string): string | null;
  fetch?: typeof fetch;
}

/** Providers a `ci_*` release can query. `buildkite`, `other` and `none` are never queried by it. */
export function ciProviderFor(name: string, deps: CiProviderDeps): CiProvider | null {
  return name === 'github' ? githubProvider(deps) : null;
}

/** The provider `release.mode: pipeline` reads its runs from (CREW-2290); only Buildkite has one. */
export function pipelineProviderFor(name: string, deps: CiProviderDeps): CiProvider | null {
  return name === 'buildkite' ? buildkiteProvider(deps) : null;
}

/**
 * True when a `ci_auto`/`ci_manual` release (and `crew doctor`) can query the
 * provider by repository and commit. Buildkite is keyed by a pipeline instead
 * and is read only by `release.mode: pipeline` (`isPipelineCiProvider`), so a
 * `ci_*` repo that names it behaves exactly as before (CREW-2290).
 */
export const isQueryableCiProvider = (name: string): boolean => name === 'github';

/** True when `release.mode: pipeline` can read this provider's runs. */
export const isPipelineCiProvider = (name: string): boolean => name === 'buildkite';

/** The last `n` non-empty lines of a log, with the timestamp prefix GitHub puts on each stripped. */
export function logTail(log: string, n = 40): string {
  return log.split('\n')
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').replace(/\r$/, ''))
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n');
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const PASSED = new Set(['success', 'skipped', 'neutral']);

interface GhRun {
  id: number; name?: string | null; html_url?: string; status?: string | null;
  conclusion?: string | null; head_branch?: string | null; event?: string;
}
interface GhJob {
  id: number; name: string; conclusion?: string | null;
  steps?: Array<{ name: string; conclusion?: string | null }>;
}

export function githubApiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

export function githubProvider(deps: CiProviderDeps): CiProvider {
  const doFetch = deps.fetch ?? fetch;
  const get = async (q: CiQuery, path: string, accept = 'application/vnd.github+json'): Promise<Response> => {
    const token = deps.token(q.host);
    if (!token) throw new CiAccessError(`no readable forge credential for ${q.host}`);
    return doFetch(`${githubApiBase(q.host)}/repos/${q.remote}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept, 'user-agent': 'crew', 'x-github-api-version': '2022-11-28' },
      redirect: 'follow',
    });
  };

  return {
    name: 'github',

    async runs(q) {
      let res: Response;
      try {
        res = await get(q, `/actions/runs?head_sha=${encodeURIComponent(q.sha)}&per_page=100`);
      } catch (e) {
        if (e instanceof CiAccessError) return { ok: false, why: e.message };
        return { ok: false, why: `${q.host} unreachable: ${(e as Error).message}` };
      }
      if (!res.ok) return { ok: false, why: describeHttp(res, q) };
      let body: { workflow_runs?: GhRun[] };
      try { body = await res.json() as { workflow_runs?: GhRun[] }; } catch { return { ok: false, why: `${q.host} sent a reply that is not JSON` }; }
      const runs: CiRun[] = [];
      for (const r of body.workflow_runs ?? []) {
        if (r.event === 'pull_request' || r.event === 'pull_request_target') continue;
        runs.push({
          id: String(r.id),
          name: r.name ?? `run ${r.id}`,
          url: r.html_url ?? '',
          state: r.status !== 'completed' ? 'pending'
            : FAILED.has(r.conclusion ?? '') ? 'failed'
            : PASSED.has(r.conclusion ?? '') ? 'passed' : 'other',
          ref: q.tag && r.head_branch === q.tag ? 'tag' : r.head_branch === q.base ? 'base' : 'other',
        });
      }
      return { ok: true, runs };
    },

    async failure(q, run) {
      const out: CiRunFailure = { run };
      try {
        const res = await get(q, `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
        if (!res.ok) return out;
        const jobs = ((await res.json()) as { jobs?: GhJob[] }).jobs ?? [];
        const job = jobs.find((j) => FAILED.has(j.conclusion ?? ''));
        if (!job) return out;
        out.job = job.name;
        out.step = job.steps?.find((s) => FAILED.has(s.conclusion ?? ''))?.name;
        const log = await get(q, `/actions/jobs/${job.id}/logs`, '*/*');
        if (log.ok) out.logTail = logTail(await log.text());
      } catch { /* the run alone is still worth reporting */ }
      return out;
    },
  };
}

class CiAccessError extends Error {}

interface BkJob { id?: string; name?: string | null; label?: string | null; type?: string; state?: string | null; log_url?: string | null }
interface BkBuild { id: string; number?: number; state?: string; web_url?: string; branch?: string | null; commit?: string; jobs?: BkJob[] }

export const BUILDKITE_HOST = 'buildkite.com';
const BUILDKITE_API = 'https://api.buildkite.com/v2';

/**
 * A Buildkite build's state as a run state.
 *
 * `blocked` counts as passed: a build whose every non-block step finished and
 * that now waits on a manual block is the normal resting place of a pipeline
 * with a gated production button (CREW-2290), and the gate is a person's, not a
 * failure. A canceled build will never deploy, so it is failed rather than slow.
 */
export function buildkiteState(state: string | undefined): CiRunState {
  switch (state) {
    case 'passed': case 'blocked': case 'finished': return 'passed';
    case 'failed': case 'failing': case 'canceled': case 'canceling': return 'failed';
    case 'skipped': case 'not_run': return 'other';
    default: return 'pending';
  }
}

/**
 * Buildkite, read through its REST API with the token the ship holds for
 * `buildkite.com` (a read-only API access token with the `read_builds`,
 * `read_build_logs` scopes). A run is a build; builds are found by commit in the
 * pipeline `q.pipeline` (`org/slug`).
 */
export function buildkiteProvider(deps: CiProviderDeps): CiProvider {
  const doFetch = deps.fetch ?? fetch;
  const get = async (path: string, accept = 'application/json'): Promise<Response> => {
    const token = deps.token(BUILDKITE_HOST);
    if (!token) throw new CiAccessError(`no readable credential for ${BUILDKITE_HOST}`);
    return doFetch(path.startsWith('http') ? path : `${BUILDKITE_API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept, 'user-agent': 'crew' },
      redirect: 'follow',
    });
  };
  const slug = (q: CiQuery): string | null => {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(q.pipeline ?? '');
    return m ? `/organizations/${m[1]}/pipelines/${m[2]}` : null;
  };
  const describe = (res: Response, q: CiQuery): string => {
    if (res.status === 429) return `${BUILDKITE_HOST} is rate limiting this token`;
    if (res.status === 401 || res.status === 403) return `the ${BUILDKITE_HOST} token cannot read ${q.pipeline}'s builds (HTTP ${res.status})`;
    if (res.status === 404) return `pipeline ${q.pipeline} is not visible to the ${BUILDKITE_HOST} token (HTTP 404)`;
    return `${BUILDKITE_HOST} answered HTTP ${res.status}`;
  };

  return {
    name: 'buildkite',

    async runs(q) {
      const base = slug(q);
      if (!base) return { ok: false, why: `release.pipeline.pipeline "${q.pipeline ?? ''}" is not org/slug` };
      let res: Response;
      try {
        res = await get(`${base}/builds?commit=${encodeURIComponent(q.sha)}&per_page=100`);
      } catch (e) {
        if (e instanceof CiAccessError) return { ok: false, why: e.message };
        return { ok: false, why: `${BUILDKITE_HOST} unreachable: ${(e as Error).message}` };
      }
      if (!res.ok) return { ok: false, why: describe(res, q) };
      let builds: BkBuild[];
      try { builds = await res.json() as BkBuild[]; } catch { return { ok: false, why: `${BUILDKITE_HOST} sent a reply that is not JSON` }; }
      if (!Array.isArray(builds)) return { ok: false, why: `${BUILDKITE_HOST} sent a reply that is not a list of builds` };
      return {
        ok: true,
        runs: builds
          // `commit=` is a prefix match on some accounts; a build for another commit is not this release's.
          .filter((b) => !b.commit || b.commit.startsWith(q.sha) || q.sha.startsWith(b.commit))
          .map((b): CiRun => ({
            // The REST path addresses a build by its number, so that is the id `failure` needs.
            id: String(b.number ?? b.id),
            name: `${q.pipeline} #${b.number ?? b.id}`,
            url: b.web_url ?? '',
            state: buildkiteState(b.state),
            ref: q.tag && b.branch === q.tag ? 'tag' : b.branch === q.base ? 'base' : 'other',
          })),
      };
    },

    async failure(q, run) {
      const out: CiRunFailure = { run };
      const base = slug(q);
      if (!base) return out;
      try {
        const res = await get(`${base}/builds/${run.id}`);
        if (!res.ok) return out;
        const job = ((await res.json()) as BkBuild).jobs?.find((j) => j.type === 'script' && (j.state === 'failed' || j.state === 'timed_out'));
        if (!job) return out;
        out.job = job.name ?? job.label ?? undefined;
        if (job.log_url) {
          const log = await get(job.log_url, 'text/plain');
          if (log.ok) out.logTail = logTail(await log.text());
        }
      } catch { /* the run alone is still worth reporting */ }
      return out;
    },
  };
}

function describeHttp(res: Response, q: CiQuery): string {
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    return `${q.host} is rate limiting this credential`;
  }
  if (res.status === 401 || res.status === 403) return `the forge credential cannot read ${q.remote}'s runs (HTTP ${res.status})`;
  if (res.status === 404) return `${q.remote}'s runs are not visible to the forge credential (HTTP 404)`;
  return `${q.host} answered HTTP ${res.status}`;
}

/** One line naming a failed run, for the event stream and the attention item. */
export function describeCiFailure(f: CiRunFailure): string {
  const where = f.job ? ` — job "${f.job}"${f.step ? `, step "${f.step}"` : ''}` : '';
  return `${f.run.name}${where}${f.run.url ? ` (${f.run.url})` : ''}`;
}

/** The forge host and `owner/name` of a remote URL (https or scp-style), or null when it is not one. */
export function ciRemoteOf(url: string | null | undefined): { host: string; remote: string } | null {
  if (!url) return null;
  const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url.trim())
    ?? /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { host: m[1]!.toLowerCase(), remote: m[2]! } : null;
}
