/**
 * Sandbox images (CREW-2794): nothing installs inside a sandbox at run time.
 * Everything an agent needs is baked into an image built on the ship from the
 * repo's `.crew.yaml` `sandbox:` section.
 *
 * Three layers, each its own image so a change rebuilds only what it touches:
 *
 *   base   the OpenShell base image at the harness version crew pins
 *   crew   Claude Code at the version crew pins, the credential helper, MCP configuration and the environment
 *          contract (`/opt/crew`), identical for every repository
 *   repo   the repository's own declaration: packages, then setup commands
 *
 * Tags are content hashes (the declaration plus the pinned base), so an
 * unchanged declaration reuses the existing tag and a changed one builds a new
 * tag while the old one stays in use until the new build succeeds. Builds run
 * in the background between daemon passes (`sandboxBuildTick`), never on the
 * cycle path; every container-engine call goes through an injectable runner so
 * this module is testable without Docker.
 *
 * Measured costs behind that choice (CREW-2787, OpenShell 0.1.6, 18-core Mac):
 * crew layer 21 s, a cold synthesis repo layer 78 s, 54 s when only the
 * lockfile changes. About double on a 4-vCPU cloud instance.
 *
 * Spike findings the layers encode, so a repo author does not rediscover them:
 *  - The sandbox's HOME is its workdir (`/sandbox`), not the image user's home.
 *    A cache warmed under `~` at build time is invisible at run time, so every
 *    cache lives at an absolute path under `/opt/crew` and the crew layer
 *    exports the tools' cache variables pointing there.
 *  - The base image has uid 1000 as `ubuntu` and no `/sandbox`; the repo layer
 *    creates the directories and ownership for that uid.
 *  - A run-time download fails with EACCES under the default policy, so every
 *    toolchain download is a bake-time `setup:` step or a declared policy host.
 *    Install a package manager with the system `npm -g` at build time rather
 *    than through a shim that fetches it per user.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { RepoSandbox } from './repo-config.ts';
import { realExec, type Exec } from './passenger-containers.ts';
import type { ShipAttentionItem } from './ship-attention.ts';

/** The OpenShell base image, and the OpenShell version crew pins into it. A bump rebuilds every repo's image. */
export const SANDBOX_BASE_IMAGE = 'nvcr.io/nvidia/base/ubuntu:24.04';
export const SANDBOX_OPENSHELL_VERSION = '0.1.6';
/**
 * The Claude Code version the crew layer bakes into `/opt/crew/bin/claude`
 * (CREW-2909), never `latest`. A run has no route to the download host under
 * the generated policy, so the binary is fetched at build time and verified
 * against the checksums below, copied from the release's published
 * `manifest.json` (`<dist>/claude-code-releases/<version>/manifest.json`).
 * A bump rebuilds the crew layer and so every repo's image; changing the
 * version means replacing both checksums with the new release's.
 */
export const SANDBOX_CLAUDE_VERSION = '2.1.309';
export const SANDBOX_CLAUDE_DIST = 'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';
/** sha256 of the glibc Linux binary, by `uname -m`. */
export const SANDBOX_CLAUDE_SHA256: Record<string, { platform: string; sha256: string }> = {
  x86_64: { platform: 'linux-x64', sha256: '4d704a8aecbe038affa3000f498ae17c1b4f753add8facb8764120affc99b658' },
  aarch64: { platform: 'linux-arm64', sha256: '9796dd26899337f687739a0b39a7353b639f062a3436a7b941fcf19a1b757a9b' },
};
/** The uid the base image runs as. */
export const SANDBOX_UID = 1000;
/** Where the crew layer puts everything it adds; caches live under it at absolute paths. */
export const CREW_PREFIX = '/opt/crew';
/** Where the crew layer puts the in-sandbox symbol bridge (CREW-2922); a run starts it with the image's `node`. */
export const SANDBOX_BRIDGE_PATH = `${CREW_PREFIX}/bin/intel-bridge`;

/**
 * The bundled bridge (`tsup.config.ts` writes `dist/sandbox-intel-bridge.cjs` beside `dist/cli.js`),
 * or undefined when this process runs without a build beside it. A repository that declares
 * `intel` has it copied into its image; one that does not keeps the image it always had.
 */
export function readBridgeBundle(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, 'sandbox-intel-bridge.cjs'), join(here, '..', 'dist', 'sandbox-intel-bridge.cjs')]) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return undefined;
}
/**
 * What `hooks.intel: serena` adds to the crew layer (CREW-2915): `uv` from PyPI into a venv, then
 * the bridge as a uv tool, both pinned. Build time has network; a run has none.
 */
export const SANDBOX_UV_VERSION = '0.13.6';
export const SANDBOX_SERENA_VERSION = '2.1.0';
/** The bridge's home in the image; its `language_servers/` is where the servers it downloads land. */
export const SERENA_IMAGE_HOME = `${CREW_PREFIX}/serena`;
/** Read by the built-in starter (`startSerena`) to link the shared servers into a run's own home. */
export const SERENA_LANGUAGE_SERVERS_ENV = 'CREW_SERENA_LANGUAGE_SERVERS';

/** A failed build is not retried for the same declaration until this long has passed (or a forced build). */
export const SANDBOX_RETRY_AFTER_MS = 60 * 60 * 1000;
/** Newest tags kept per repo after a successful build: the current one and the one it replaced. */
const KEEP_TAGS = 2;

export const CREDENTIAL_HELPER = `#!/bin/sh
# git credential helper: answers from the environment the runner passes in, so
# no token is ever written into an image layer.
[ "$1" = get ] || exit 0
[ -n "$CREW_FORGE_TOKEN" ] || exit 0
echo "username=\${CREW_FORGE_USER:-x-access-token}"
echo "password=$CREW_FORGE_TOKEN"
`;

export const MCP_CONFIG = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;

export interface SandboxLayer {
  name: 'base' | 'crew' | 'repo';
  tag: string;
  dockerfile: string;
  /** Build-context files, relative path to content. */
  files: Record<string, string>;
  /** Build-context file name that receives the host's CA bundle at build time (CREW-2995). Kept out of `files` so the tag does not depend on the host. */
  caBundleFile?: string;
}

export interface SandboxPlan {
  repo: string;
  /** The repo layer's tag, which is the image a sandbox runs. */
  tag: string;
  /** The Claude Code version this plan bakes in. */
  claude: string;
  layers: SandboxLayer[];
}

const hash = (parts: unknown): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
const run = (cmd: string): string => `RUN ["/bin/bash", "-c", ${JSON.stringify(`set -euo pipefail; ${cmd}`)}]`;

/** The environment contract the crew layer exports; the runner relies on these names. */
export const CREW_ENV: Record<string, string> = {
  CREW_SANDBOX: '1',
  CREW_CACHE_DIR: `${CREW_PREFIX}/cache`,
  XDG_CACHE_HOME: `${CREW_PREFIX}/cache`,
  npm_config_cache: `${CREW_PREFIX}/cache/npm`,
  npm_config_store_dir: `${CREW_PREFIX}/pnpm-store`,
  // pnpm 11 ignores npm_config_store_dir and reads only this spelling (CREW-2973): without it `pnpm fetch`
  // at build time fills the builder's home store, and a run's offline install finds /opt/crew/pnpm-store empty.
  pnpm_config_store_dir: `${CREW_PREFIX}/pnpm-store`,
  PNPM_HOME: `${CREW_PREFIX}/pnpm`,
  // A run cannot reach the download host, so an in-run update attempt is only noise.
  DISABLE_AUTOUPDATER: '1',
};

/**
 * A shell prelude exporting the crew layer's variables (CREW_ENV and the Serena ones). The image
 * sets them with `ENV`, but `openshell sandbox exec` starts the process without them (CREW-2968).
 */
export function sandboxEnvExports(): string {
  const vars: Record<string, string> = {
    ...CREW_ENV,
    [SERENA_LANGUAGE_SERVERS_ENV]: `${SERENA_IMAGE_HOME}/language_servers`,
    UV_PYTHON_INSTALL_DIR: `${CREW_PREFIX}/uv/python`,
  };
  return Object.entries(vars).map(([k, v]) => `${k}=${v}; export ${k}; `).join('');
}

/** Build-time install of the pinned Claude Code binary, checksum-verified, refusing any unknown architecture. */
export function claudeInstallCommand(): string {
  const cases = Object.entries(SANDBOX_CLAUDE_SHA256)
    .map(([arch, { platform, sha256 }]) => `${arch}) p=${platform}; sum=${sha256};;`).join(' ');
  return [
    `case "$(uname -m)" in ${cases} *) echo "no pinned Claude Code binary for $(uname -m)" >&2; exit 1;; esac`,
    `mkdir -p ${CREW_PREFIX}/bin`,
    `curl -fsSL --retry 3 -o ${CREW_PREFIX}/bin/claude "${SANDBOX_CLAUDE_DIST}/${SANDBOX_CLAUDE_VERSION}/$p/claude"`,
    `echo "$sum  ${CREW_PREFIX}/bin/claude" | sha256sum -c -`,
    `chmod 0755 ${CREW_PREFIX}/bin/claude`,
    `${CREW_PREFIX}/bin/claude --version | grep -F "${SANDBOX_CLAUDE_VERSION}"`,
  ].join('; ');
}

/** Build-time install of the `serena` flavor's prerequisites into `/opt/crew`, pinned. */
export function serenaInstallCommand(): string {
  return [
    `python3 -m venv ${CREW_PREFIX}/uv-venv`,
    `${CREW_PREFIX}/uv-venv/bin/pip install --no-cache-dir uv==${SANDBOX_UV_VERSION}`,
    `ln -sf ${CREW_PREFIX}/uv-venv/bin/uv ${CREW_PREFIX}/bin/uv`,
    `UV_TOOL_DIR=${CREW_PREFIX}/uv/tools UV_TOOL_BIN_DIR=${CREW_PREFIX}/bin UV_PYTHON_INSTALL_DIR=${CREW_PREFIX}/uv/python UV_CACHE_DIR=${CREW_PREFIX}/cache/uv ${CREW_PREFIX}/bin/uv tool install -p 3.13 serena-agent==${SANDBOX_SERENA_VERSION}`,
    `${CREW_PREFIX}/bin/serena --help >/dev/null`,
  ].join('; ');
}

/**
 * Runs the bridge's project indexing once over the warmed source tree, with its home in the
 * image, so language detection happens and the servers it needs are downloaded while the build
 * still has network. Serena writes its own default `serena_config.yml` into the home on first
 * use: a hand-written partial config lacks keys it requires (`projects`) and fails the build.
 * The index lands in the warm tree's `.serena/`, which the repo layer removes with the tree.
 */
export function serenaWarmCommand(): string {
  return [
    `mkdir -p ${SERENA_IMAGE_HOME}`,
    `SERENA_HOME=${SERENA_IMAGE_HOME} serena project index ${WARM_DIR}`,
  ].join('; ');
}

function baseLayer(): SandboxLayer {
  const dockerfile = [
    `FROM ${SANDBOX_BASE_IMAGE}`,
    `LABEL io.crew.sandbox.layer="base" io.crew.sandbox.openshell="${SANDBOX_OPENSHELL_VERSION}"`,
    '',
  ].join('\n');
  return { name: 'base', tag: `crew-sandbox-base:${hash({ SANDBOX_BASE_IMAGE, SANDBOX_OPENSHELL_VERSION })}`, dockerfile, files: {} };
}

// A managed sandbox host allows egress on TCP 443 only, and Ubuntu's stock apt
// sources are http://. Rewriting them to https before any `apt-get update`
// (the same sed the host image applies to the host's own sources) keeps image
// builds off port 80. No-op where the file is absent (non-Ubuntu images).
// Any *.ubuntu.com host is rewritten, not just archive/security: arm64 images
// use http://ports.ubuntu.com.
export const APT_HTTPS_COMMAND = "sed -i -E 's#http://([a-z0-9.-]*\\.)?ubuntu\\.com#https://\\1ubuntu.com#g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true";

/** Build-context name of the host CA bundle the crew layer seeds its trust store with. */
const CA_BUNDLE_FILE = 'ca-certificates.crt';
const HOST_CA_BUNDLES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];

/**
 * The host's CA bundle, or '' when none is readable. The OpenShell base image
 * ships no trust store, so apt cannot verify the https mirrors that
 * APT_HTTPS_COMMAND switches to and never reaches `install ca-certificates`;
 * on a 443-only host there is no http fallback. The public bundle seeds the
 * layer, and the distribution's own `ca-certificates` package replaces it.
 */
export function readHostCaBundle(paths: string[] = HOST_CA_BUNDLES): string {
  for (const path of paths) {
    try { return readFileSync(path, 'utf8'); } catch { /* try the next location */ }
  }
  return '';
}

function crewLayer(base: SandboxLayer, intel?: 'serena', bridge?: string): SandboxLayer {
  const files: Record<string, string> = { 'credential-helper': CREDENTIAL_HELPER, 'mcp.json': MCP_CONFIG, ...(bridge ? { 'intel-bridge': bridge } : {}) };
  const env = Object.entries(CREW_ENV).map(([k, v]) => `${k}=${v}`).join(' ');
  const dockerfile = [
    `FROM ${base.tag}`,
    'USER root',
    `COPY ${CA_BUNDLE_FILE} /etc/ssl/certs/ca-certificates.crt`,
    run(APT_HTTPS_COMMAND),
    run(`apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git${intel ? ' python3 python3-venv nodejs' : ''} && rm -rf /var/lib/apt/lists/*`),
    `COPY credential-helper ${CREW_PREFIX}/bin/credential-helper`,
    `COPY mcp.json ${CREW_PREFIX}/mcp/mcp.json`,
    ...(bridge ? [`COPY intel-bridge ${SANDBOX_BRIDGE_PATH}`] : []),
    run(claudeInstallCommand()),
    ...(intel ? [run(`mkdir -p ${CREW_PREFIX}/cache && ${serenaInstallCommand()}`)] : []),
    run(`chmod 0755 ${CREW_PREFIX}/bin/credential-helper && git config --system credential.helper ${CREW_PREFIX}/bin/credential-helper`),
    run(`mkdir -p ${CREW_PREFIX}/cache ${CREW_PREFIX}/pnpm-store ${CREW_PREFIX}/pnpm /sandbox && chown -R ${SANDBOX_UID}:${SANDBOX_UID} ${CREW_PREFIX} /sandbox`),
    ...(intel ? [`ENV ${SERENA_LANGUAGE_SERVERS_ENV}=${SERENA_IMAGE_HOME}/language_servers UV_PYTHON_INSTALL_DIR=${CREW_PREFIX}/uv/python`] : []),
    `ENV ${env} PATH=${CREW_PREFIX}/pnpm:${CREW_PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `LABEL io.crew.sandbox.layer="crew" io.crew.sandbox.claude="${SANDBOX_CLAUDE_VERSION}"`,
    '',
  ].join('\n');
  return { name: 'crew', tag: `crew-sandbox-crew:${hash({ base: base.tag, dockerfile, files })}`, dockerfile, files, caBundleFile: CA_BUNDLE_FILE };
}

/** Where warm files are copied during the repo layer's setup steps; removed afterwards. */
export const WARM_DIR = '/tmp/crew-warm';
/** A repo's warm files, relative path to content. */
export type WarmFiles = Record<string, string>;
export const WARM_MAX_BYTES = 64 * 1024 * 1024;

export const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

/**
 * Reads the files `patterns` match from git `ref` of the checkout at `dir` (the
 * committed tree, never the working directory, which may be mid-edit). A
 * pattern that matches nothing is skipped: a repo without `pnpm-workspace.yaml`
 * can still share a declaration. Throws if the ref is unreadable or the files
 * exceed a sane size.
 */
export function readWarmFiles(dir: string, ref: string, patterns: string[]): WarmFiles {
  if (patterns.length === 0) return {};
  const git = (args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: WARM_MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  const all = git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);
  const res = patterns.map(globToRegExp);
  const out: WarmFiles = {};
  let total = 0;
  for (const path of all.filter((f) => res.some((re) => re.test(f))).sort()) {
    const content = git(['show', `${ref}:${path}`]);
    total += content.length;
    if (total > WARM_MAX_BYTES) throw new Error(`sandbox.warm files exceed ${WARM_MAX_BYTES} bytes`);
    out[path] = content;
  }
  return out;
}

function repoLayer(repo: string, decl: RepoSandbox, crew: SandboxLayer, warm: WarmFiles): SandboxLayer {
  const env = Object.entries(CREW_ENV).map(([k, v]) => `${k}=${v}`).join(' ');
  const lines: string[] = [];
  if (decl.image) {
    // A published image replaces the crew layer's filesystem, so the contract
    // is copied in from the crew layer rather than inherited.
    lines.push(`FROM ${crew.tag} AS crew`, `FROM ${decl.image}`, 'USER root',
      `COPY --from=crew ${CREW_PREFIX} ${CREW_PREFIX}`,
      `ENV ${env} PATH=${CREW_PREFIX}/pnpm:${CREW_PREFIX}/bin:$PATH`);
  } else {
    lines.push(`FROM ${crew.tag}`, 'USER root');
  }
  if (decl.packages.length > 0) {
    lines.push(run(APT_HTTPS_COMMAND));
    lines.push(run(`apt-get update && apt-get install -y --no-install-recommends ${decl.packages.join(' ')} && rm -rf /var/lib/apt/lists/*`));
  }
  lines.push(run(`mkdir -p /sandbox && chown -R ${SANDBOX_UID}:${SANDBOX_UID} /sandbox ${CREW_PREFIX}`),
    `USER ${SANDBOX_UID}`, 'WORKDIR /sandbox');
  const files: Record<string, string> = {};
  const warming = Object.keys(warm).length > 0;
  if (warming) {
    for (const [path, content] of Object.entries(warm)) files[`warm/${path}`] = content;
    lines.push(`COPY --chown=${SANDBOX_UID}:${SANDBOX_UID} warm/ ${WARM_DIR}/`, `WORKDIR ${WARM_DIR}`);
  }
  // One RUN per step so a changed trailing step reuses every cached layer before it.
  for (const step of decl.setup) lines.push(run(step));
  // After the repo's own steps, while the warm tree still exists. A declaration without warm files has no tree to index.
  if (warming && decl.intel) lines.push(run(serenaWarmCommand()));
  if (warming) lines.push('WORKDIR /sandbox', run(`rm -rf ${WARM_DIR}`));
  lines.push(`LABEL io.crew.sandbox.layer="repo" io.crew.sandbox.repo=${JSON.stringify(repo)}`, '');
  const dockerfile = lines.join('\n');
  return { name: 'repo', tag: `crew-sandbox/${slug(repo)}:${hash({ crew: crew.tag, dockerfile, files })}`, dockerfile, files };
}

/** The three layers and the tag a repo's declaration builds to. `bridge` is the bundled symbol bridge, passed only for a repository that declares `intel` (CREW-2922). */
export function planSandbox(repo: string, decl: RepoSandbox, warm: WarmFiles = {}, bridge?: string): SandboxPlan {
  const base = baseLayer();
  const crew = crewLayer(base, decl.intel, bridge);
  const layer = repoLayer(repo, decl, crew, warm);
  return { repo, tag: layer.tag, claude: SANDBOX_CLAUDE_VERSION, layers: [base, crew, layer] };
}

/**
 * The ship's own image (CREW-2956). Sandboxing is a ship property: on a
 * `ship.runner: sandbox` ship every run starts from the crew layer (git, curl,
 * the credential helper, Claude Code), whether or not the ticket's repository
 * declares `sandbox:`. A declaration only adds that repository's layer on top.
 * The `@` keeps the state key from ever equalling a repository name.
 */
export const SHIP_SANDBOX_KEY = '@ship';
export const shipSandboxRef = (): SandboxRepoRef => ({ name: SHIP_SANDBOX_KEY, decl: { packages: [], setup: [] } });

// --- state -----------------------------------------------------------------

export interface BuiltTag {
  tag: string;
  builtAt: string;
  /** The Claude Code version baked into this image (absent on tags built before CREW-2909). */
  claude?: string;
}
export interface SandboxFailure { tag: string; at: string; logPath: string }
export interface SandboxRepoState {
  /** Newest first. `tags[0]` is the image a sandbox runs. */
  tags: BuiltTag[];
  failure?: SandboxFailure;
}
export type SandboxImageState = Record<string, SandboxRepoState>;

export const sandboxStatePath = (stateDir: string): string => join(stateDir, 'sandbox-images.json');

export function readSandboxState(stateDir: string): SandboxImageState {
  try {
    const v = JSON.parse(readFileSync(sandboxStatePath(stateDir), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SandboxImageState) : {};
  } catch {
    return {};
  }
}

export function writeSandboxState(stateDir: string, state: SandboxImageState): void {
  mkdirSync(stateDir, { recursive: true });
  const file = sandboxStatePath(stateDir);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * The image a sandbox for `repo` should run: the newest successfully built tag,
 * which is the PREVIOUS declaration's while a new build is pending or has
 * failed. null when nothing was ever built — the caller waits on the attention
 * item rather than starting a bare sandbox.
 */
export function sandboxImageFor(state: SandboxImageState, repo: string): string | null {
  return state[repo]?.tags[0]?.tag ?? null;
}

/**
 * The image a run for `repo` starts from on a sandbox ship: the repository's own layer when it
 * declares `sandbox:` and that layer has built, otherwise the ship's crew layer. null only when
 * neither has been built yet (the first build tick has not finished).
 */
export function sandboxImageForRun(state: SandboxImageState, repo: string | null | undefined, declares: boolean): string | null {
  return (declares && repo ? sandboxImageFor(state, repo) : null) ?? sandboxImageFor(state, SHIP_SANDBOX_KEY);
}

export type SandboxImageStatus = 'ok' | 'stale' | 'missing' | 'failed';

/** What `crew doctor` reports for a repo that declares a sandbox. */
export function sandboxImageStatus(state: SandboxImageState, plan: SandboxPlan): { status: SandboxImageStatus; detail: string } {
  const s = state[plan.repo];
  const current = s?.tags[0];
  if (s?.failure && s.failure.tag === plan.tag) {
    return { status: 'failed', detail: `last build of ${plan.tag} failed at ${s.failure.at}; log ${s.failure.logPath}${current ? `; running ${current.tag}` : ''}` };
  }
  if (!current) return { status: 'missing', detail: `no image built yet (wants ${plan.tag}); run \`crew sandbox build\`` };
  if (current.tag !== plan.tag) return { status: 'stale', detail: `running ${current.tag} (claude ${current.claude ?? 'unknown'}), declaration now builds ${plan.tag} (claude ${plan.claude})` };
  return { status: 'ok', detail: `${current.tag} built ${current.builtAt}, claude ${current.claude ?? 'unknown'}` };
}

// --- building --------------------------------------------------------------

/** Runs a container-engine command, appending its output to `logPath`. Resolves the exit code. */
export type BuildRunner = (args: string[], logPath: string) => Promise<number>;

export const spawnBuildRunner = (engine = 'docker'): BuildRunner => (args, logPath) =>
  new Promise((resolve) => {
    const child = spawn(engine, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => chunks.push(d));
    const done = (code: number, extra = ''): void => {
      writeFileSync(logPath, `$ ${engine} ${args.join(' ')}\n${Buffer.concat(chunks).toString('utf8')}${extra}`, { flag: 'a' });
      resolve(code);
    };
    child.on('error', (e) => done(127, `${e.message}\n`));
    child.on('close', (code) => done(code ?? 1));
  });

export interface BuildDeps {
  stateDir: string;
  run: BuildRunner;
  /** Does the engine already hold this tag? */
  hasImage: (tag: string) => boolean;
  removeImage: (tag: string) => void;
  /** The host CA bundle copied into a layer that asks for one; defaults to the host's own. */
  caBundle?: () => string;
  now?: () => Date;
}

export const engineHasImage = (engine = 'docker', exec: Exec = realExec) => (tag: string): boolean => {
  try { exec(engine, ['image', 'inspect', tag], { timeoutMs: 20_000 }); return true; } catch { return false; }
};
export const engineRemoveImage = (engine = 'docker', exec: Exec = realExec) => (tag: string): void => {
  try { exec(engine, ['image', 'rm', tag], { timeoutMs: 60_000 }); } catch { /* still in use or already gone */ }
};

export type BuildOutcome =
  | { kind: 'reused'; tag: string }
  | { kind: 'built'; tag: string; builtLayers: string[] }
  | { kind: 'failed'; tag: string; logPath: string; layer: string };

export const sandboxLogDir = (stateDir: string): string => join(stateDir, 'sandbox-logs');

/**
 * Builds whatever layers of `plan` the engine lacks, then records the repo
 * layer as current. The previous tag stays current until the repo layer
 * succeeds; a failure records where the log is and changes nothing else.
 */
export async function buildSandboxImage(plan: SandboxPlan, deps: BuildDeps): Promise<BuildOutcome> {
  const now = deps.now ?? (() => new Date());
  const state = readSandboxState(deps.stateDir);
  const entry: SandboxRepoState = state[plan.repo] ?? { tags: [] };

  if (entry.tags[0]?.tag === plan.tag && deps.hasImage(plan.tag)) {
    return { kind: 'reused', tag: plan.tag };
  }

  const logDir = sandboxLogDir(deps.stateDir);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${slug(plan.repo)}-${now().toISOString().replace(/[:.]/g, '-')}.log`);
  const builtLayers: string[] = [];

  for (const layer of plan.layers) {
    if (deps.hasImage(layer.tag)) continue;
    const ctx = join(tmpdir(), `crew-sandbox-${hash([layer.tag, process.pid, Date.now()])}`);
    mkdirSync(ctx, { recursive: true });
    try {
      writeFileSync(join(ctx, 'Dockerfile'), layer.dockerfile);
      for (const [name, content] of Object.entries(layer.files)) {
        mkdirSync(dirname(join(ctx, name)), { recursive: true });
        writeFileSync(join(ctx, name), content);
      }
      if (layer.caBundleFile) writeFileSync(join(ctx, layer.caBundleFile), (deps.caBundle ?? readHostCaBundle)());
      const code = await deps.run(['build', '--tag', layer.tag, '--file', join(ctx, 'Dockerfile'), ctx], logPath);
      if (code !== 0) {
        state[plan.repo] = { ...entry, failure: { tag: plan.tag, at: now().toISOString(), logPath } };
        writeSandboxState(deps.stateDir, state);
        return { kind: 'failed', tag: plan.tag, logPath, layer: layer.name };
      }
      builtLayers.push(layer.name);
    } finally {
      rmSync(ctx, { recursive: true, force: true });
    }
  }

  const tags = [{ tag: plan.tag, builtAt: now().toISOString(), claude: plan.claude }, ...entry.tags.filter((t) => t.tag !== plan.tag)];
  const dropped = tags.slice(KEEP_TAGS);
  state[plan.repo] = { tags: tags.slice(0, KEEP_TAGS) };
  writeSandboxState(deps.stateDir, state);
  for (const t of dropped) deps.removeImage(t.tag);
  return { kind: 'built', tag: plan.tag, builtLayers };
}

// --- background tick ---------------------------------------------------------

export const sandboxFailedKey = (repo: string): string => `sandbox_build_failed:${repo}`;

export function sandboxFailedItem(repo: string, tag: string, layer: string, logPath: string, nowIso = new Date().toISOString()): ShipAttentionItem {
  return {
    kind: 'sandbox_build_failed', key: sandboxFailedKey(repo), since: nowIso,
    message: `${repo}: sandbox image ${tag} failed to build at the ${layer} layer (log: ${logPath}); sandboxes keep running the previous image. Retries automatically after the declaration changes or in an hour; \`crew sandbox build\` forces it`,
  };
}

export interface SandboxRepoRef { name: string; decl: RepoSandbox; /** Files read for `decl.warm`, at the base ref. */ warm?: WarmFiles; /** The bundled symbol bridge, set only when the repository declares `intel` (CREW-2922). */ bridge?: string }

export interface TickDeps extends BuildDeps {
  raise: (item: ShipAttentionItem) => void;
  clear: (key: string) => void;
  log: (message: string) => void;
}

/**
 * One background step: builds the first declared repo whose image is not the
 * one its declaration wants. At most one build per call, so a tick is bounded
 * and a caller can run it fire-and-forget behind an in-flight guard.
 * A repo that failed on this exact declaration waits `SANDBOX_RETRY_AFTER_MS`
 * unless `force` is set. Returns the repo it worked on, or null if idle.
 */
export async function sandboxBuildTick(repos: SandboxRepoRef[], deps: TickDeps, force = false): Promise<string | null> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  for (const r of repos) {
    const plan = planSandbox(r.name, r.decl, r.warm, r.bridge);
    const state = readSandboxState(deps.stateDir)[r.name];
    const upToDate = state?.tags[0]?.tag === plan.tag && deps.hasImage(plan.tag);
    if (upToDate) { deps.clear(sandboxFailedKey(r.name)); continue; }
    if (!force && state?.failure?.tag === plan.tag && nowMs - Date.parse(state.failure.at) < SANDBOX_RETRY_AFTER_MS) continue;
    deps.log(`sandbox image for ${r.name}: building ${plan.tag}`);
    const out = await buildSandboxImage(plan, deps);
    if (out.kind === 'failed') {
      deps.raise(sandboxFailedItem(r.name, out.tag, out.layer, out.logPath));
      deps.log(`sandbox image for ${r.name}: build failed at the ${out.layer} layer, log ${out.logPath}`);
    } else {
      deps.clear(sandboxFailedKey(r.name));
      deps.log(`sandbox image for ${r.name}: ${out.kind === 'built' ? `built ${out.tag}` : `${out.tag} already built`}`);
    }
    return r.name;
  }
  return null;
}
