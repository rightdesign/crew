/**
 * Forge credentials (CREW-2783): the ship's own token for each git host, kept
 * out of the host's git configuration and out of every file git would read.
 *
 * `ship.forges` in crew.yaml is keyed by host. Each entry names where the
 * token lives (`TOKEN_SOURCES`, an open registry so a cloud secrets service
 * can be added without touching any caller). `crew credential` answers git's
 * credential-helper protocol from it, and `gitCredentialEnv` hands git the
 * helper through `GIT_CONFIG_COUNT`-style environment, so no `.gitconfig`,
 * `.git-credentials`, remote URL or argv ever carries the token.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ForgeError extends Error {}

/** Where a forge's token is read from. Discriminated on `source`. */
export type ForgeTokenSource =
  | { source: 'env'; var: string }
  | { source: 'file'; path?: string }
  | { source: 'keychain'; service?: string };

export interface ForgeEntry {
  /** The HTTP username git sends with the token. GitHub accepts any non-empty one for a PAT. */
  username: string;
  token: ForgeTokenSource;
}

/** `ship.forges`: host (lowercase, no scheme) -> entry. */
export type ForgesConfig = Record<string, ForgeEntry>;

export const DEFAULT_FORGE_USERNAME = 'x-access-token';

/** The host a Repos row without a `forge_host` lives on (CREW-2798). */
export const DEFAULT_FORGE_HOST = 'github.com';

/**
 * What differs between forge kinds for cloning and pushing (CREW-2798): the
 * URL shapes and the HTTP username the credential helper presents with a
 * token. GitHub and GitLab share the `<host>/<path>.git` shape, so a
 * self-hosted GitLab is the GitLab descriptor at another host; `remote` may
 * carry more than two path segments there (nested groups).
 */
export interface ForgeDescriptor {
  kind: 'github' | 'gitlab';
  httpsUrl(host: string, remote: string): string;
  sshUrl(host: string, remote: string): string;
  /** The username a personal/project access token is presented with. */
  credentialUsername: string;
}

export const FORGE_DESCRIPTORS: Record<ForgeDescriptor['kind'], ForgeDescriptor> = {
  github: {
    kind: 'github',
    httpsUrl: (host, remote) => `https://${host}/${remote}.git`,
    sshUrl: (host, remote) => `git@${host}:${remote}.git`,
    credentialUsername: DEFAULT_FORGE_USERNAME,
  },
  gitlab: {
    kind: 'gitlab',
    httpsUrl: (host, remote) => `https://${host}/${remote}.git`,
    sshUrl: (host, remote) => `git@${host}:${remote}.git`,
    credentialUsername: 'oauth2',
  },
};

/** Lowercased bare host; blank or missing reads as `github.com`. */
export function normalizeForgeHost(host: string | null | undefined): string {
  const h = host?.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/+$/, '');
  return h || DEFAULT_FORGE_HOST;
}

/**
 * The descriptor for a host: GitLab for `gitlab.com` or any host whose name
 * contains `gitlab` (the usual self-hosted naming), GitHub otherwise.
 */
export function forgeDescriptorFor(host: string | null | undefined): ForgeDescriptor {
  return normalizeForgeHost(host).includes('gitlab') ? FORGE_DESCRIPTORS.gitlab : FORGE_DESCRIPTORS.github;
}
export const DEFAULT_KEYCHAIN_SERVICE = 'crew-forge';

/** One way of keeping a token. Add a new entry to `TOKEN_SOURCES` to add a backend. */
export interface TokenSourceImpl<S extends ForgeTokenSource = ForgeTokenSource> {
  /** The token, or null when nothing is stored. Throws ForgeError for a source that is unsafe to read. */
  read(s: S, ctx: SourceContext): string | null;
  /** Stores a token. Not every source can (an environment variable cannot be persisted). */
  write?(s: S, token: string, ctx: SourceContext): void;
  /** Removes the stored token (CREW-2882, `crew deprovision`). Absent for a source crew does not own. */
  erase?(s: S, ctx: SourceContext): void;
  /** One line for `crew doctor` / `crew forge`: where the token comes from, never the token. */
  describe(s: S, ctx: SourceContext): string;
}

export interface SourceContext {
  host: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

/** `<stateDir>/forges/<host>.token`, the default for `source: file`. */
export function defaultTokenFilePath(stateDir: string, host: string): string {
  return join(stateDir, 'forges', `${host.replace(/[^a-z0-9.-]/gi, '_')}.token`);
}

const envSource: TokenSourceImpl<Extract<ForgeTokenSource, { source: 'env' }>> = {
  read: (s, c) => c.env[s.var]?.trim() || null,
  describe: (s) => `environment variable ${s.var}`,
};

const fileSource: TokenSourceImpl<Extract<ForgeTokenSource, { source: 'file' }>> = {
  read(s, c) {
    const path = s.path ?? defaultTokenFilePath(c.stateDir, c.host);
    if (!existsSync(path)) return null;
    const mode = statSync(path).mode & 0o777;
    // Group- or world-readable means someone else may already have the token.
    if (mode & 0o077) {
      throw new ForgeError(
        `${path} is mode ${mode.toString(8).padStart(3, '0')}; a forge token file must be owner-only (chmod 600 ${path})`,
      );
    }
    return readFileSync(path, 'utf8').trim() || null;
  },
  write(s, token, c) {
    const path = s.path ?? defaultTokenFilePath(c.stateDir, c.host);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // `mode` only applies on creation, so chmod too: a replaced file may predate it.
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  },
  erase(s, c) {
    rmSync(s.path ?? defaultTokenFilePath(c.stateDir, c.host), { force: true });
  },
  describe: (s, c) => `key file ${s.path ?? defaultTokenFilePath(c.stateDir, c.host)}`,
};

const keychainService = (s: { service?: string }) => s.service ?? DEFAULT_KEYCHAIN_SERVICE;

const keychainSource: TokenSourceImpl<Extract<ForgeTokenSource, { source: 'keychain' }>> = {
  read(s, c) {
    try {
      if (process.platform === 'darwin') {
        return execFileSync('security', ['find-generic-password', '-s', keychainService(s), '-a', c.host, '-w'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
      }
      return execFileSync('secret-tool', ['lookup', 'service', keychainService(s), 'account', c.host],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null; // not found, or no secret store on this host
    }
  },
  write(s, token, c) {
    try {
      if (process.platform === 'darwin') {
        // `security -i` reads its command from stdin, so the token is not in argv.
        const q = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`;
        execFileSync('security', ['-i'], {
          input: `add-generic-password -U -s ${q(keychainService(s))} -a ${q(c.host)} -w ${q(token)}\n`,
          stdio: ['pipe', 'ignore', 'pipe'],
        });
      } else {
        execFileSync('secret-tool', ['store', '--label', `crew ${c.host}`, 'service', keychainService(s), 'account', c.host],
          { input: token, stdio: ['pipe', 'ignore', 'pipe'] });
      }
    } catch (e) {
      throw new ForgeError(`could not write to the OS secret store: ${(e as Error).message.split('\n')[0]}`);
    }
  },
  erase(s, c) {
    try {
      if (process.platform === 'darwin') {
        execFileSync('security', ['delete-generic-password', '-s', keychainService(s), '-a', c.host], { stdio: 'ignore' });
      } else {
        execFileSync('secret-tool', ['clear', 'service', keychainService(s), 'account', c.host], { stdio: 'ignore' });
      }
    } catch {
      // Nothing stored under that name, or no secret store on this host: either way there is nothing to remove.
    }
  },
  describe: (s) => `OS secret store (service ${keychainService(s)})`,
};

export const TOKEN_SOURCES: Record<ForgeTokenSource['source'], TokenSourceImpl<never>> = {
  env: envSource as TokenSourceImpl<never>,
  file: fileSource as TokenSourceImpl<never>,
  keychain: keychainSource as TokenSourceImpl<never>,
};

function impl(s: ForgeTokenSource): TokenSourceImpl {
  const found = TOKEN_SOURCES[s.source] as TokenSourceImpl | undefined;
  if (!found) throw new ForgeError(`unknown token source "${(s as { source: string }).source}"`);
  return found;
}

/** The host part of a credential request's `host` (git sends `host:port` for a non-default port). */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '');
}

/** The entry for `host` (case-insensitive, port ignored), or undefined. */
export function forgeFor(forges: ForgesConfig | undefined, host: string): { host: string; entry: ForgeEntry } | undefined {
  const want = bareHost(host);
  for (const [h, entry] of Object.entries(forges ?? {})) {
    if (bareHost(h) === want) return { host: h, entry };
  }
  return undefined;
}

export function readForgeToken(
  forges: ForgesConfig | undefined, host: string, stateDir: string, env: NodeJS.ProcessEnv = process.env,
): string | null {
  const f = forgeFor(forges, host);
  if (!f) return null;
  return impl(f.entry.token).read(f.entry.token, { host: f.host, stateDir, env });
}

export function describeForgeSource(forges: ForgesConfig | undefined, host: string, stateDir: string): string | null {
  const f = forgeFor(forges, host);
  return f ? impl(f.entry.token).describe(f.entry.token, { host: f.host, stateDir, env: process.env }) : null;
}

/** True when a token for `host` is configured AND readable. Never throws. */
export function hasForgeToken(
  forges: ForgesConfig | undefined, host: string, stateDir: string, env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return !!readForgeToken(forges, host, stateDir, env);
  } catch {
    return false;
  }
}

/** Stores a token through the host's configured source. */
export function storeForgeToken(
  forges: ForgesConfig | undefined, host: string, token: string, stateDir: string, env: NodeJS.ProcessEnv = process.env,
): void {
  const f = forgeFor(forges, host);
  if (!f) throw new ForgeError(`no forges.${host} entry in crew.yaml`);
  const i = impl(f.entry.token);
  if (!i.write) throw new ForgeError(`forges.${host} reads its token from ${i.describe(f.entry.token, { host: f.host, stateDir, env })}, which crew cannot write`);
  if (!token.trim()) throw new ForgeError('empty token');
  i.write(f.entry.token, token.trim(), { host: f.host, stateDir, env });
  // The store is proof the helper can now answer; a miss recorded before it (CREW-2991) is stale.
  noteForgeMiss(stateDir, f.host, null);
}

/**
 * Removes the token for `host` from where crew keeps it. `'env'` when the
 * entry reads an environment variable (nothing crew can remove), `'absent'`
 * when there is no entry; the caller reports the first as KEPT.
 */
export function eraseForgeToken(
  forges: ForgesConfig | undefined, host: string, stateDir: string, env: NodeJS.ProcessEnv = process.env,
): 'erased' | 'env' | 'absent' {
  const f = forgeFor(forges, host);
  if (!f) return 'absent';
  const i = impl(f.entry.token);
  if (!i.erase) return 'env';
  i.erase(f.entry.token, { host: f.host, stateDir, env });
  return 'erased';
}

// --- git credential-helper protocol ---------------------------------------

/** Parses `key=value` lines (git's helper input) up to the first blank line. */
export function parseCredentialInput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line === '') break;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Answers one helper call. Only `get` ever produces output: `store` and
 * `erase` are accepted and ignored, because the forge block is the single
 * source of truth and git must never write a token back anywhere. No match
 * (other protocol, other host, no token) answers nothing, which git treats
 * as "ask the next helper".
 */
export function answerCredential(
  action: string,
  input: Record<string, string>,
  forges: ForgesConfig | undefined,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (action !== 'get') return '';
  if (input.protocol && input.protocol !== 'https') return '';
  if (!input.host) return '';
  const f = forgeFor(forges, input.host);
  if (!f) return '';
  const token = impl(f.entry.token).read(f.entry.token, { host: f.host, stateDir, env });
  if (!token) return '';
  return `username=${f.entry.username}\npassword=${token}\n`;
}

// --- forge hosts the helper could not answer (CREW-2903) -------------------

export interface MissingForgeHost { host: string; lastMissAt: string }

const missesPath = (stateDir: string) => join(stateDir, 'forge-misses.json');

/** The recorded misses, oldest first by host name; an unreadable or absent file is an empty list. */
export function readForgeMisses(stateDir: string): MissingForgeHost[] {
  try {
    const raw = JSON.parse(readFileSync(missesPath(stateDir), 'utf8')) as Record<string, unknown>;
    return Object.entries(raw)
      .filter(([, t]) => typeof t === 'string')
      .map(([host, lastMissAt]) => ({ host, lastMissAt: lastMissAt as string }))
      .sort((a, b) => a.host.localeCompare(b.host));
  } catch {
    return [];
  }
}

/**
 * Records (`at` given) or clears (`at` null) a miss for `host`. The file holds
 * the bare host and a time only: never a URL path, username or token. Best
 * effort: bookkeeping must never make git's credential lookup fail.
 */
export function noteForgeMiss(stateDir: string, host: string, at: string | null): void {
  try {
    const bare = bareHost(host);
    const cur: Record<string, string> = {};
    for (const m of readForgeMisses(stateDir)) cur[m.host] = m.lastMissAt;
    if (at === null) { if (!(bare in cur)) return; delete cur[bare]; } else cur[bare] = at;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(missesPath(stateDir), JSON.stringify(cur), { mode: 0o600 });
  } catch { /* best effort */ }
}

// --- environment handed to git (crew's own, and every agent run's) --------

/**
 * `GIT_CONFIG_COUNT`-style environment that makes git consult `crew
 * credential`. The first entry blanks any inherited helper list so the
 * host's own helpers (a stale keychain entry, `gh`) cannot answer first.
 * `crewCommand` is the shell-quoted invocation of this crew, and
 * `configFile` is pinned in the same environment so the helper finds the
 * same crew.yaml wherever git runs it from.
 */
export function gitCredentialEnv(
  o: { crewCommand: string; configFile?: string },
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const start = Number.parseInt(base.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  const helper = `!${o.crewCommand} credential`;
  // Already applied (crew's own process env feeds the agent plan's): do not stack a second pair.
  for (let i = 0; i < start; i++) {
    if (base[`GIT_CONFIG_KEY_${i}`] === 'credential.helper' && base[`GIT_CONFIG_VALUE_${i}`] === helper) {
      return { GIT_TERMINAL_PROMPT: '0', ...(o.configFile ? { CREW_CONFIG: o.configFile } : {}) };
    }
  }
  const out: Record<string, string> = {
    GIT_CONFIG_COUNT: String(start + 2),
    [`GIT_CONFIG_KEY_${start}`]: 'credential.helper',
    [`GIT_CONFIG_VALUE_${start}`]: '',
    [`GIT_CONFIG_KEY_${start + 1}`]: 'credential.helper',
    [`GIT_CONFIG_VALUE_${start + 1}`]: helper,
    GIT_TERMINAL_PROMPT: '0',
  };
  if (o.configFile) out.CREW_CONFIG = o.configFile;
  return out;
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** How a shell (git runs helpers through one) re-invokes this crew: node, its flags, the entry script. */
export function crewCommandLine(): string {
  return [process.execPath, ...process.execArgv, process.argv[1] ?? 'crew'].map(shq).join(' ');
}

/** Environment variables a forge token is exported as for an agent run (`gh` and friends read these). */
export function tokenEnvFor(host: string, token: string): Record<string, string> {
  const out: Record<string, string> = { CREW_FORGE_TOKEN: token };
  if (bareHost(host) === 'github.com') {
    out.GH_TOKEN = token;
    out.GITHUB_TOKEN = token;
  }
  return out;
}

/**
 * Everything an agent run needs from its ship's forges: the helper
 * configuration plus each readable token. Empty when no forge is
 * configured, so a ship without a `forges:` block behaves exactly as before.
 * A token that cannot be read (a permissions refusal) is skipped; the doctor
 * is where that is reported.
 */
export function forgeRunEnv(
  forges: ForgesConfig | undefined,
  o: { crewCommand: string; configFile?: string; stateDir: string },
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const hosts = Object.keys(forges ?? {});
  if (hosts.length === 0) return {};
  const out = gitCredentialEnv(o, base);
  // The first readable token wins the single-valued variables.
  for (const h of hosts) {
    let token: string | null = null;
    try { token = readForgeToken(forges, h, o.stateDir, base); } catch { /* reported by the doctor */ }
    if (token) {
      Object.assign(out, tokenEnvFor(h, token));
      break;
    }
  }
  return out;
}

// --- config parsing --------------------------------------------------------

/** Parses `ship.forges`. Throws ForgeError naming the offending key. */
export function parseForges(raw: unknown): ForgesConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ForgeError('ship.forges must be a map of host to entry');
  const out: ForgesConfig = {};
  for (const [host, v] of Object.entries(raw as Record<string, unknown>)) {
    const where = `ship.forges.${host}`;
    if (/[/:@\s]/.test(host)) throw new ForgeError(`${where}: the key must be a bare host name like github.com`);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ForgeError(`${where} must be a map`);
    const e = v as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!['username', 'token'].includes(k)) throw new ForgeError(`${where}: unknown key "${k}" (have: username, token)`);
    }
    const t = e.token;
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw new ForgeError(`${where}.token must be a map with a "source"`);
    const tok = t as Record<string, unknown>;
    const source = tok.source;
    let token: ForgeTokenSource;
    if (source === 'env') {
      if (typeof tok.var !== 'string' || !tok.var) throw new ForgeError(`${where}.token.var is required for source "env"`);
      token = { source: 'env', var: tok.var };
    } else if (source === 'file') {
      token = typeof tok.path === 'string' && tok.path ? { source: 'file', path: tok.path } : { source: 'file' };
    } else if (source === 'keychain') {
      token = typeof tok.service === 'string' && tok.service ? { source: 'keychain', service: tok.service } : { source: 'keychain' };
    } else {
      throw new ForgeError(`${where}.token.source must be one of: ${Object.keys(TOKEN_SOURCES).join(', ')}`);
    }
    out[host.toLowerCase()] = {
      username: typeof e.username === 'string' && e.username ? e.username : forgeDescriptorFor(host).credentialUsername,
      token,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The `host` of a remote URL (https or scp-style / ssh), lowercase; null when unparseable. */
export function hostOfRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url) ?? /^[\w.-]+@([\w.-]+):/.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

/** The forge a push probe should name: configured for the remote's host, plus whether its token is readable. */
export function forgeOfRemote(
  forges: ForgesConfig | undefined, remoteUrl: string | null, hasToken: (host: string) => boolean,
): { host: string; hasToken: boolean } | undefined {
  const host = hostOfRemote(remoteUrl);
  const f = host ? forgeFor(forges, host) : undefined;
  return f ? { host: f.host, hasToken: hasToken(f.host) } : undefined;
}
