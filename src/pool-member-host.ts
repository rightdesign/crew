/**
 * The real machine behind `crew pool-member` (CREW-2882): provisioning through
 * `runProvision`, the wipe through a `crew deprovision` child, and the ship's
 * machine id and relay URL read from the config the provision just wrote.
 * `pool-member.ts` holds the loop and is tested with fakes; this is the part
 * that spawns processes and touches disk.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { crewVersion, findConfigFile, loadConfig } from './config.ts';
import { eraseForgeToken, readForgeMisses } from './forges.ts';
import { crewInvocation } from './install.ts';
import { ensureMachineId } from './machine-id.ts';
import { hostArchitecture, type LeasePayload, type PoolApi, type PoolMemberDeps, type MemberStore } from './pool-member.ts';
import { runActivity } from './live-runs.ts';
import { PROVISION_EXIT, realProvisionDeps, runProvision } from './provision.ts';
import { readPersistedTunnel, relayBaseUrlFor } from './tunnel.ts';

export interface RealPoolMemberOptions {
  crewHome: string;
  api: PoolApi;
  store: MemberStore;
  /** The pool URL (the platform's API prefix, e.g. `https://host/api`); a lease's routes are connected against `platformBaseUrl` of it. */
  platformUrl: string;
  env?: NodeJS.ProcessEnv;
  /** Raised by SIGTERM/SIGINT. */
  stopping(): boolean;
  log(line: string): void;
}

/**
 * The Tablation base URL for `crew provision --base-url`, from the pool URL. The pool URL is the API prefix
 * (`CREW_POOL_URL=https://host/api`); the tracker client appends `/api/...` itself, so a trailing `/api` is
 * stripped here or every connect would hit `/api/api/...`.
 */
export function platformBaseUrl(poolUrl: string): string {
  return poolUrl.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
}

function loadShip(crewHome: string) {
  try { return loadConfig(crewHome, undefined, { allowNoRoutes: true }); } catch { return null; }
}

export function realPoolMemberDeps(o: RealPoolMemberOptions): PoolMemberDeps {
  const env = o.env ?? process.env;
  const provisionDeps = realProvisionDeps(o.crewHome);
  return {
    api: o.api,
    store: o.store,
    host: {
      // The first-boot hook writes the cloud's instance id; a host without one is identified by its hostname.
      cloudInstanceId: env.CREW_POOL_INSTANCE_ID?.trim() || hostname(),
      architecture: hostArchitecture(),
      crewVersion: crewVersion(o.crewHome),
      hostname: hostname(),
    },
    hasShipConfig: () => existsSync(findConfigFile(o.crewHome)),

    async provision(lease: LeasePayload, instanceClass: string, shipKind: string) {
      const hosts = lease.forges.map((f) => f.host.toLowerCase());
      const lines: string[] = [];
      // The payload goes straight into the in-process options: never argv, never a file, never a log line.
      const outcome = await runProvision({
        key: lease.connectKey,
        keys: Object.fromEntries((lease.connectKeys ?? []).map((k) => [k.workspace, k.key])),
        routes: lease.routes.map((r) => `${r.workspace}/${r.project}`),
        shipName: lease.shipName,
        shipKind,
        instanceClass,
        relayHost: lease.relayHost,
        relayHttpPort: lease.relayHttpPort,
        maxConcurrentAgents: lease.maxConcurrentAgents,
        baseUrl: platformBaseUrl(o.platformUrl),
        forgeHosts: hosts,
        tokens: Object.fromEntries(lease.forges.map((f) => [f.host.toLowerCase(), f.token])),
        json: false, dryRun: false, choices: [],
      }, provisionDeps, () => {}, (l) => { lines.push(l.trim()); });
      for (const l of lines) o.log(`provision: ${l}`);
      if (outcome.code === PROVISION_EXIT.ok) return { ok: true };
      return { ok: false, reason: `crew provision exited ${outcome.code}: ${lines.at(-1) ?? 'no detail'}` };
    },

    async applyTokens(forges) {
      const want = new Map(forges.map((f) => [f.host.toLowerCase(), f.token]));
      // Tokens never reach argv or a log line: they go to `crew forge` on stdin.
      for (const [host, token] of want) {
        const stored = provisionDeps.storedToken(host);
        if (stored === token) continue;
        const res = provisionDeps.crew(['forge', stored === null ? 'set' : 'rotate', host, '--token-stdin'], { input: `${token}\n` });
        if (res.status !== 0) return { ok: false, reason: `forge ${host}: ${res.stderr.trim() || `crew forge exited ${res.status}`}` };
      }
      const cfg = loadShip(o.crewHome);
      if (!cfg) return { ok: false, reason: 'no ship config to apply forge tokens to' };
      for (const host of Object.keys(cfg.ship.forges ?? {})) {
        if (want.has(host.toLowerCase())) continue;
        try { eraseForgeToken(cfg.ship.forges, host, cfg.ship.stateDir, env); } catch (e) { return { ok: false, reason: `forge ${host}: ${(e as Error).message}` }; }
      }
      return { ok: true };
    },

    async reconcile() {
      const before = provisionDeps.installState();
      if (before.unitsStale || !before.running || !before.lingering) {
        const res = provisionDeps.crew(['install']);
        if (res.status !== 0) return { ok: false, reason: `crew install exited ${res.status}` };
      }
      const after = provisionDeps.installState();
      return after.running ? { ok: true } : { ok: false, reason: `the ${after.mechanism} daemon unit is not running after install` };
    },

    async deprovision() {
      const res = provisionDeps.crew(['deprovision', '--json']);
      if (res.status === 0) return { ok: true };
      const last = res.stdout.trim().split('\n').filter(Boolean).at(-1) ?? res.stderr.trim().split('\n').at(-1) ?? '';
      let reason = `crew deprovision exited ${res.status}`;
      try {
        const parsed = JSON.parse(last) as { remaining?: string[] };
        if (parsed.remaining?.length) reason += `; remaining: ${parsed.remaining.slice(0, 5).join(', ')}`;
      } catch { /* not the summary line */ }
      return { ok: false, reason };
    },

    machineId() {
      const cfg = loadShip(o.crewHome);
      return cfg ? ensureMachineId(cfg.ship.stateDir) ?? null : null;
    },
    relayUrl() {
      const cfg = loadShip(o.crewHome);
      if (!cfg?.ship.relayHost) return null;
      for (const r of cfg.routes) {
        const ws = r.resolved?.workspaceId;
        const slug = ws ? readPersistedTunnel(cfg.ship.stateDir, ws)?.slug : undefined;
        if (slug) return relayBaseUrlFor(slug, cfg.ship.relayHost, cfg.ship.relayHttpPort, cfg.ship.relayPublicDomain);
      }
      return null;
    },

    missingForgeHosts() {
      const cfg = loadShip(o.crewHome);
      return cfg ? readForgeMisses(cfg.ship.stateDir) : [];
    },
    activity() {
      const cfg = loadShip(o.crewHome);
      return cfg ? runActivity(cfg.ship.stateDir) : { activeRuns: 0, lastRunEndedAt: null };
    },
    watch(onTick) {
      const t = setInterval(onTick, 2_000);
      return () => { clearInterval(t); };
    },

    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: o.log,
    stopping: o.stopping,
  };
}
