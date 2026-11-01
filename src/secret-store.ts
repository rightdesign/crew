/**
 * Where crew keeps secrets: the ship key, per-seat agent keys and forge tokens
 * (CREW-2785, EPIC-075 §5).
 *
 * `@tablation/client`'s `getSessionStore` shells out to the desktop's secret
 * service (macOS Keychain, Linux libsecret, Windows Credential Manager). A
 * headless Linux host has no desktop session, so every call there fails. This
 * module wraps it with a file-backed store under `<stateDir>/keys` (owner-only
 * permissions) and a `ship.secretStore` setting that picks between them:
 *
 *   auto  the OS store where one is reachable, the file store otherwise
 *         (only Linux without a D-Bus session or `secret-tool` ever falls back)
 *   os    always the OS store; a failure is reported, never papered over
 *   file  always the file store
 *
 * macOS and Windows resolve to the OS store under `auto`, so their behavior is
 * unchanged. Every caller that used to import `getSessionStore` from the client
 * imports it from here, so one setting governs all of them.
 */

import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionStore as getOsSessionStore, type SessionStore, type StoredSession } from '@tablation/client';

export type SecretStoreMode = 'auto' | 'os' | 'file';
export const SECRET_STORE_MODES: readonly SecretStoreMode[] = ['auto', 'os', 'file'];

export function isSecretStoreMode(v: unknown): v is SecretStoreMode {
  return typeof v === 'string' && (SECRET_STORE_MODES as readonly string[]).includes(v);
}

export interface SecretStoreConfig {
  mode: SecretStoreMode;
  /** The ship's state directory; the file store lives in `<stateDir>/keys`. */
  stateDir: string;
}

let configured: SecretStoreConfig | undefined;

/** Called once the ship config is loaded; later `getSessionStore()` calls follow it. */
export function configureSecretStore(c: SecretStoreConfig | undefined): void {
  configured = c;
}

export function keysDir(stateDir: string): string {
  return join(stateDir, 'keys');
}

/**
 * A file named for a hash of the address, so no slug character (`#`, `/`) can
 * reach the filesystem as a path component.
 */
function entryName(host: string, slug: string): string {
  return `${createHash('sha256').update(`${host}\0${slug}`).digest('hex')}.json`;
}

/** Owner-only JSON files in one directory. Throws on any filesystem problem; a missing entry is `undefined`. */
export class FileSessionStore implements SessionStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask and ignored for an existing directory.
    if ((statSync(this.dir).mode & 0o077) !== 0) chmodSync(this.dir, 0o700);
  }

  async get(host: string, slug: string): Promise<StoredSession | undefined> {
    const file = join(this.dir, entryName(host, slug));
    // A missing directory is "nothing stored"; an unreadable one must throw.
    if (!existsSync(this.dir)) return undefined;
    accessSync(this.dir, constants.R_OK | constants.X_OK);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as StoredSession;
  }

  async set(host: string, slug: string, session: StoredSession): Promise<void> {
    this.ensureDir();
    const file = join(this.dir, entryName(host, slug));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
    renameSync(tmp, file);
  }

  async clear(host: string, slug: string): Promise<void> {
    if (!existsSync(this.dir)) return;
    rmSync(join(this.dir, entryName(host, slug)), { force: true });
  }

  /** Whether a key could be written here right now, without leaving anything behind. */
  writable(): { ok: true } | { ok: false; reason: string } {
    try {
      this.ensureDir();
      accessSync(this.dir, constants.R_OK | constants.W_OK | constants.X_OK);
      const probe = join(this.dir, `.probe.${process.pid}`);
      writeFileSync(probe, '', { mode: 0o600 });
      rmSync(probe, { force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
    }
  }
}

/** The OS store's own advice names a variable crew does not read; say crew's instead. */
export function crewifyStoreError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/TABLATION_API_KEY/.test(msg)) return e instanceof Error ? e : new Error(msg);
  const out = new Error(
    msg.replace(/Set TABLATION_API_KEY instead of running `login`\./,
      'Set CREW_API_KEY for the ship key, or set `ship.secretStore: file` in crew.yaml to keep keys under the state directory.'),
    { cause: e },
  );
  return out;
}

class CrewHintedStore implements SessionStore {
  private readonly inner: SessionStore;
  constructor(inner: SessionStore) { this.inner = inner; }
  async get(host: string, slug: string): Promise<StoredSession | undefined> {
    try { return await this.inner.get(host, slug); } catch (e) { throw crewifyStoreError(e); }
  }
  async set(host: string, slug: string, s: StoredSession): Promise<void> {
    try { await this.inner.set(host, slug, s); } catch (e) { throw crewifyStoreError(e); }
  }
  async clear(host: string, slug: string): Promise<void> {
    try { await this.inner.clear(host, slug); } catch (e) { throw crewifyStoreError(e); }
  }
}

/**
 * Whether a desktop secret service is plausibly reachable. Only Linux can lack
 * one: it needs `secret-tool` on PATH and a session bus. Other platforms ship
 * their store with the OS.
 */
export function osStoreReachable(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  hasBinary: (name: string) => boolean = onPath,
): boolean {
  if (platform !== 'linux') return true;
  if (!hasBinary('secret-tool')) return false;
  if (env.DBUS_SESSION_BUS_ADDRESS) return true;
  return !!env.XDG_RUNTIME_DIR && existsSync(join(env.XDG_RUNTIME_DIR, 'bus'));
}

function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, name))) return true;
  }
  return false;
}

export type ResolvedStore = { kind: 'os' | 'file'; mode: SecretStoreMode; dir?: string };

/** Which backend `mode` selects here. */
export function resolveStoreKind(mode: SecretStoreMode, reachable: boolean = osStoreReachable()): 'os' | 'file' {
  if (mode === 'file') return 'file';
  if (mode === 'os') return 'os';
  return reachable ? 'os' : 'file';
}

export function describeSecretStore(c: SecretStoreConfig | undefined = configured): ResolvedStore {
  const mode = c?.mode ?? 'auto';
  // Without a ship config there is no state directory to keep files in.
  const kind = c ? resolveStoreKind(mode) : 'os';
  return kind === 'file' && c ? { kind, mode, dir: keysDir(c.stateDir) } : { kind: 'os', mode };
}

/** The store crew reads and writes secrets through. Throws only where the OS store itself does (no backend on this platform). */
export function getSessionStore(c: SecretStoreConfig | undefined = configured): SessionStore {
  const r = describeSecretStore(c);
  if (r.kind === 'file' && r.dir) return new FileSessionStore(r.dir);
  return new CrewHintedStore(getOsSessionStore());
}

/** `crew doctor`'s one-line answer: which store is in use (and why), and whether a key can be written to it. */
export function describeKeyStore(ship: { secretStore?: SecretStoreMode; stateDir: string }): string {
  const c: SecretStoreConfig = { mode: ship.secretStore ?? 'auto', stateDir: ship.stateDir };
  const r = describeSecretStore(c);
  const why = c.mode === 'auto' ? ' (auto: no desktop secret service reachable)' : ` (ship.secretStore: ${c.mode})`;
  if (r.kind === 'file' && r.dir) {
    const w = new FileSessionStore(r.dir).writable();
    return `file ${r.dir}${why} — ${w.ok ? 'writable' : `NOT writable (${w.reason})`}`;
  }
  return `OS secret store${c.mode === 'auto' ? '' : why}`;
}
