/**
 * The OpenShell policy crew writes for every sandboxed run (CREW-2801).
 *
 * The policy is what makes the Tablation inference endpoint the only route to a
 * model on a managed ship, so it is derived from the run rather than kept in a
 * hand-maintained file: the forge host(s) of the route's repositories, the
 * route's Tablation host (the tracker, and under `auth: workspace` the inference
 * endpoint too) and, under `subscription`/`inherit`, the model provider's hosts.
 * Everything else is denied. A repository's `sandbox:` section can add hosts (a
 * test that reaches a public API) and name the toolchains whose run-time
 * downloads it needs.
 *
 * Findings from the CREW-2787 spike this rests on:
 * - OpenShell binds a network rule to binary paths inside the sandbox, so every
 *   rule below names the binaries allowed to use it, not the sandbox as a whole.
 * - Toolchains download at run time more often than their docs admit; a missing
 *   rule fails with a bare `EACCES`, so `TOOLCHAIN_HOSTS` carries the known ones.
 * - The cloud metadata address must never be reachable. OpenShell denies by
 *   default, so no allow rule may match it: `assertReachable` refuses a declared
 *   host that is (or is named like) one, and the rendered file records the deny.
 * - Landlock is generated as `hard_requirement`, so a host that cannot enforce
 *   fails the run instead of running unconfined.
 */

import { basename } from 'node:path';
import { stringify } from 'yaml';

export type SandboxAuthMode = 'workspace' | 'subscription' | 'inherit';

/** What the policy is derived from. Plain data so `planAgentRun` can carry it on the plan. */
export interface SandboxPolicyInput {
  /** Forge hosts of the route's repositories (`github.com`, `git.example.com`). */
  forgeHosts: string[];
  /** The route's Tablation base URL: the tracker, and the inference endpoint under `workspace`. */
  tablationUrl: string;
  authMode: SandboxAuthMode;
  /** `adapter.provider` of the run's toolchain; picks the provider hosts for `subscription`/`inherit`. */
  provider: string;
  /** The harness binary's name inside the image (`claude`). */
  harnessBin: string;
  /** Hosts the repository's `sandbox:` section declares, `host` or `host:port`. */
  extraHosts?: string[];
  /** Toolchain names the repository declares; each contributes its known download hosts. */
  toolchains?: string[];
  /** Read-only mirror mount. */
  mirrorDir?: string;
  workDir?: string;
}

export interface PolicyEndpoint { host: string; port: number }

/** One rule group as rendered, kept so a caller can describe it without parsing the YAML. */
export interface PolicyGroup {
  name: string;
  purpose: string;
  endpoints: PolicyEndpoint[];
  binaries: string[];
}

export interface SandboxPolicy {
  yaml: string;
  groups: PolicyGroup[];
  /** The extra hosts the repository declared, for the run log. */
  extraHosts: string[];
}

export class SandboxPolicyError extends Error {}

/** The model provider's hosts, for a run that talks to the provider itself. */
export const PROVIDER_HOSTS: Record<string, string[]> = {
  anthropic: ['api.anthropic.com', 'claude.ai', 'platform.claude.com'],
  openai: ['api.openai.com', 'auth.openai.com', 'chatgpt.com'],
  google: ['generativelanguage.googleapis.com', 'oauth2.googleapis.com', 'cloudcode-pa.googleapis.com'],
};

/** Hosts a declared toolchain fetches from at run time, beyond what its docs say. */
export const TOOLCHAIN_HOSTS: Record<string, string[]> = {
  corepack: ['registry.npmjs.org'],
  pnpm: ['registry.npmjs.org'],
  yarn: ['registry.npmjs.org'],
  npm: ['registry.npmjs.org'],
  prisma: ['binaries.prisma.sh'],
  playwright: ['cdn.playwright.dev', 'playwright.download.prss.microsoft.com'],
  pip: ['pypi.org', 'files.pythonhosted.org'],
  cargo: ['index.crates.io', 'static.crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
  swift: ['download.swift.org'],
};

/** Addresses a run must never reach, whatever a repository declares. */
const FORBIDDEN_HOSTS = new Set(['169.254.169.254', 'fd00:ec2::254', 'metadata.google.internal', 'metadata', 'localhost']);

export const IMDS_ADDRESS = '169.254.169.254';

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isForbiddenIp(host: string): boolean {
  const m = IPV4.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 0 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return host.includes(':');   // an IPv6 literal: never a reasonable declared host
}

/**
 * A host whose labels are all numeric or hex (`0xa9fea9fe`, `2852039166`, `0251.0376.0251.0376`, `169.254.43518`)
 * that is not a canonical dotted quad. Resolvers and URL parsers read these as IPv4 addresses, so they could name the
 * metadata address in another notation; a real DNS name never has an all-numeric final label.
 */
function isAmbiguousNumericHost(host: string): boolean {
  const labels = host.split('.');
  if (!labels.every((l) => /^(0x[0-9a-f]*|\d+)$/.test(l))) return false;
  const canonical = labels.length === 4 && labels.every((l) => /^(0|[1-9]\d{0,2})$/.test(l) && Number(l) <= 255);
  return !canonical;
}

/** Parses `host` or `host:port`; refuses anything the sandbox must not reach. */
export function parseEndpoint(raw: string, defaultPort = 443): PolicyEndpoint {
  const s = raw.trim().toLowerCase();
  const m = /^([^:/\s]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) throw new SandboxPolicyError(`"${raw}" is not a host or host:port`);
  const host = m[1]!;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (port < 1 || port > 65535) throw new SandboxPolicyError(`"${raw}" has an invalid port`);
  if (FORBIDDEN_HOSTS.has(host) || isForbiddenIp(host)) {
    throw new SandboxPolicyError(`"${raw}" is never reachable from a sandbox (loopback, private, link-local and cloud metadata addresses are always denied)`);
  }
  if (isAmbiguousNumericHost(host)) {
    throw new SandboxPolicyError(`"${raw}" is a numeric host in a non-canonical form (hex, octal, integer or short dotted); write an IPv4 address as four plain decimal octets or use a DNS name`);
  }
  if (!IPV4.test(host) && !HOST.test(host)) throw new SandboxPolicyError(`"${raw}" is not a valid host name`);
  return { host, port };
}

function dedupe(eps: PolicyEndpoint[]): PolicyEndpoint[] {
  const seen = new Set<string>();
  return eps.filter((e) => { const k = `${e.host}:${e.port}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The Tablation endpoint of a base URL, tolerating a self-hosted install on a LAN address or custom port. */
function tablationEndpoint(url: string): PolicyEndpoint {
  let u: URL;
  try { u = new URL(url); } catch { throw new SandboxPolicyError(`the route's base URL "${url}" is not a URL`); }
  const port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443;
  const host = u.hostname.toLowerCase();
  if (host !== 'localhost' && (FORBIDDEN_HOSTS.has(host) || host.startsWith('169.254.'))) {
    throw new SandboxPolicyError(`the route's base URL host "${host}" is never reachable from a sandbox`);
  }
  return { host, port };
}

/** Where the crew layer (sandbox-image.ts) puts Claude Code, and where a repository's `sandbox.setup` may put its own node. */
// Not imported from sandbox-image.ts (CREW_PREFIX): that module reaches seat-keys, and the import cycle breaks module load. A test pins the two together.
export const CREW_BIN = '/opt/crew/bin';

const TOOL_BINARIES = ['/usr/bin/curl', `${CREW_BIN}/node`, '/usr/bin/node', '/usr/local/bin/node', '/usr/bin/npm', '/usr/local/bin/npm', '/usr/local/bin/pnpm', '/usr/bin/corepack', '/usr/local/bin/corepack'];
const GIT_BINARIES = ['/usr/bin/git', '/usr/lib/git-core/git-remote-http', '/usr/lib/git-core/git-remote-https'];

/** The rule groups for a run, before rendering. */
export function policyGroups(input: SandboxPolicyInput): PolicyGroup[] {
  const harness = `/usr/local/bin/${basename(input.harnessBin)}`;
  const harnessBins = [...new Set([`${CREW_BIN}/${basename(input.harnessBin)}`, harness, `/usr/bin/${basename(input.harnessBin)}`, `${CREW_BIN}/node`, '/usr/bin/node', '/usr/local/bin/node'])];
  const groups: PolicyGroup[] = [];

  const tablation = tablationEndpoint(input.tablationUrl);
  groups.push({
    name: 'tablation',
    purpose: input.authMode === 'workspace' ? 'the tracker and the inference endpoint (the only route to a model)' : 'the tracker',
    endpoints: [tablation],
    // curl too: the lane briefs drive the tracker API with it.
    binaries: [...harnessBins, '/usr/bin/curl'],
  });

  const forge = dedupe((input.forgeHosts.length > 0 ? input.forgeHosts : ['github.com']).map((h) => parseEndpoint(h)));
  groups.push({ name: 'forge', purpose: 'clone and push the ticket branch', endpoints: forge, binaries: GIT_BINARIES });

  if (input.authMode !== 'workspace') {
    const hosts = PROVIDER_HOSTS[input.provider];
    if (hosts) {
      groups.push({ name: 'model', purpose: `the ${input.provider} model route (auth: ${input.authMode})`, endpoints: hosts.map((h) => parseEndpoint(h)), binaries: harnessBins });
    }
  }

  const toolHosts = (input.toolchains ?? []).flatMap((t) => {
    const hosts = TOOLCHAIN_HOSTS[t.toLowerCase()];
    if (!hosts) throw new SandboxPolicyError(`sandbox toolchain "${t}" is not one crew knows the download hosts of (known: ${Object.keys(TOOLCHAIN_HOSTS).join(', ')}); declare its hosts under sandbox.hosts instead`);
    return hosts.map((h) => parseEndpoint(h));
  });
  if (toolHosts.length > 0) {
    groups.push({ name: 'toolchains', purpose: 'run-time downloads of the declared toolchains', endpoints: dedupe(toolHosts), binaries: TOOL_BINARIES });
  }

  const extras = dedupe((input.extraHosts ?? []).map((h) => parseEndpoint(h)));
  if (extras.length > 0) {
    groups.push({ name: 'declared', purpose: "hosts the repository's sandbox: section declares", endpoints: extras, binaries: [...new Set([...TOOL_BINARIES, ...harnessBins])] });
  }
  return groups;
}

/** The generated policy for a run: YAML for `openshell sandbox create --policy`. */
export function generateSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const groups = policyGroups(input);
  const mirror = input.mirrorDir ?? '/cache';
  const work = input.workDir ?? '/sandbox/work';
  const doc = {
    version: 1,
    // Fixed to the image's defaults; only the cache mount is added, read-only.
    filesystem_policy: {
      include_workdir: true,
      read_only: ['/usr', '/lib', '/proc', '/dev/urandom', '/app', '/etc', '/var/log', '/opt/crew', mirror],
      read_write: ['/sandbox', '/tmp', '/dev/null', work],
    },
    // A host that cannot enforce fails the run instead of running unconfined.
    landlock: { compatibility: 'hard_requirement' },
    network_policies: Object.fromEntries(groups.map((g) => [g.name, {
      name: g.name,
      endpoints: g.endpoints.map((e) => ({ host: e.host, port: e.port })),
      binaries: g.binaries.map((path) => ({ path })),
    }])),
  };
  const header = [
    '# Generated by crew for one sandboxed run. Do not edit: the next run replaces it.',
    `# Auth mode: ${input.authMode}. Everything not listed below is denied, including package registries.`,
    `# The cloud metadata address ${IMDS_ADDRESS} is denied; no rule here can match it.`,
    ...groups.map((g) => `# ${g.name}: ${g.purpose}`),
    '',
  ].join('\n');
  return { yaml: header + stringify(doc), groups, extraHosts: (input.extraHosts ?? []).map((h) => h.trim().toLowerCase()) };
}

/** Where a run's generated policy is written: beside its stream file. */
export function policyPathFor(streamPath: string): string {
  return streamPath.replace(/\.jsonl$/, '') + '.policy.yaml';
}

/** `sandbox.hosts` / `sandbox.toolchains` out of a `.crew.yaml` mapping; anything else in it is another ticket's. */
export function parseSandboxNetwork(raw: unknown, file: string, fail: (msg: string) => Error): { hosts: string[]; toolchains: string[] } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw fail(`${file}: sandbox must be a mapping`);
  const r = raw as Record<string, unknown>;
  const list = (v: unknown, where: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) throw fail(`${file}: ${where} must be a list of non-empty strings`);
    return v as string[];
  };
  const hosts = list(r.hosts, 'sandbox.hosts');
  const toolchains = list(r.toolchains, 'sandbox.toolchains');
  for (const h of hosts) {
    try { parseEndpoint(h); } catch (e) { throw fail(`${file}: sandbox.hosts entry ${(e as Error).message}`); }
  }
  for (const t of toolchains) {
    if (!TOOLCHAIN_HOSTS[t.toLowerCase()]) throw fail(`${file}: sandbox.toolchains entry "${t}" is not known (known: ${Object.keys(TOOLCHAIN_HOSTS).join(', ')})`);
  }
  if (hosts.length === 0 && toolchains.length === 0) return undefined;
  return { hosts, toolchains };
}

/** One request the policy refused, as read from the sandbox log. */
export interface DeniedRequest { host: string; port?: number; binary?: string; count: number; line: string }

/**
 * Denied-request lines out of `openshell logs` output. The log format is the
 * gateway's own, so this keys on the word "deny"/"denied" and pulls host, port
 * and binary out of `key=value` pairs when they are there; a line it cannot
 * read still comes back as itself (host `?`), because a block that is not
 * diagnosable from the stream is the failure this exists to prevent.
 */
export function parseDeniedRequests(log: string): DeniedRequest[] {
  const out = new Map<string, DeniedRequest>();
  for (const line of log.split('\n')) {
    if (!/\bden(y|ied|ies|ying)\b/i.test(line)) continue;
    const pick = (keys: string[]): string | undefined => {
      for (const k of keys) {
        const m = new RegExp(`\\b${k}[=:]\\s*"?([^\\s",}]+)`, 'i').exec(line);
        if (m) return m[1];
      }
      return undefined;
    };
    const host = pick(['dst_host', 'destination_host', 'host']) ?? '?';
    const portRaw = pick(['dst_port', 'destination_port', 'port']);
    const binary = pick(['binary', 'bin', 'exe', 'process']);
    const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : undefined;
    const key = `${host}|${port ?? ''}|${binary ?? ''}`;
    const prior = out.get(key);
    if (prior) prior.count++;
    else out.set(key, { host, ...(port !== undefined ? { port } : {}), ...(binary ? { binary } : {}), count: 1, line: line.trim().slice(0, 400) });
  }
  return [...out.values()];
}
