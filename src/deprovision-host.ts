/**
 * The real machine behind `crew deprovision` (CREW-2882): live runs from the run
 * sidecars, containers and Docker resources through the `docker` binary, forge
 * tokens through `forges.ts`, Ships rows through the tracker. `deprovision.ts`
 * holds the order and is tested with fakes.
 *
 * DOCKER LABELS. crew removes only what it labeled itself, so a volume or image
 * someone else made is never touched. Everything crew creates for a route
 * carries `crew.owner=crew`; a cache volume also `crew.kind=cache`, an image
 * `crew.layer=base|crew|repo`. Only `repo` image layers and cache volumes are
 * removed, plus every `crew-sandbox/*` tag (the repository layers and the ship layer):
 * the base and crew layers are what the next lease boots from. The
 * labels are applied where the volumes and layers are built (CREW-2794,
 * CREW-2799); a host that has none simply has nothing to remove here.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { eraseForgeToken, hasForgeToken } from './forges.ts';
import { status as gitWorkingTreeStatus, worktreeForNumber } from './git.ts';
import { interruptedComment } from './interrupted.ts';
import { loadedCrewLabels, planInstall, detectSystemd, installContext } from './install.ts';
import { liveRuns } from './live-runs.ts';
import { killRunGroup } from './run-limit.ts';
import { hostPlatform } from './platform.ts';
import { dockerAvailable, listPassengerContainers, stopContainer } from './passenger-containers.ts';
import { keysDir } from './secret-store.ts';
import type { SessionStore } from '@tablation/client';
import { resolveSeatKey } from './seat-keys.ts';
import { Tracker } from './tracker.ts';
import { repoTargetFor, routeSlug, type CrewConfig, type RoleName } from './config.ts';
import type { Emitter } from './events.ts';
import type { DeprovisionDeps, LabeledDockerResources } from './deprovision.ts';

export const DOCKER_LABEL_OWNER = 'crew.owner=crew';
export const DOCKER_LABEL_CACHE = 'crew.kind=cache';
export const DOCKER_LABEL_REPO_LAYER = 'crew.layer=repo';

function docker(args: string[]): string {
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  if (res.error || res.status !== 0) throw new Error(`docker ${args[0]} ${args[1] ?? ''} failed: ${(res.stderr || String(res.error ?? '')).trim().split('\n').pop()}`);
  return res.stdout;
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

export function labeledDocker(): LabeledDockerResources {
  if (!dockerAvailable()) return { volumes: [], images: [] };
  return {
    volumes: lines(docker(['volume', 'ls', '-q', '--filter', `label=${DOCKER_LABEL_OWNER}`, '--filter', `label=${DOCKER_LABEL_CACHE}`])),
    // CREW-2984: the repository and ship layers are tagged `crew-sandbox/<name>:<hash>` but carry only an `io.crew.sandbox.*` label,
    // so the label filter alone missed them. The tag namespace is crew's own; the base and crew layers are `crew-sandbox-base`/`-crew`.
    images: [...new Set([
      ...lines(docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=crew-sandbox/*'])),
      ...lines(docker(['image', 'ls', '-q', '--filter', `label=${DOCKER_LABEL_OWNER}`, '--filter', `label=${DOCKER_LABEL_REPO_LAYER}`])),
    ])],
  };
}

export function realDeprovisionDeps(
  cfg: CrewConfig, emit: Emitter, crewHome: string, getStore: () => SessionStore,
): DeprovisionDeps {
  const stateDir = cfg.ship.stateDir;
  const forgeHosts = () => Object.keys(cfg.ship.forges ?? {});
  const routeFor = (label: string) => cfg.routes.find((r) => routeSlug(r.route) === label);
  const sandboxes = (): string[] => (dockerAvailable() ? listPassengerContainers().map((c) => c.name) : []);
  const unitPaths = (): string[] => {
    const host = hostPlatform();
    if (host === 'windows') return [];
    const ctx = installContext();
    const systemd = detectSystemd();
    return (['run', 'release', 'passengers'] as const)
      .flatMap((job) => planInstall(cfg.ship, crewHome, host, systemd, job, ctx).unitPaths)
      .filter((p) => existsSync(p));
  };

  return {
    liveRuns: () => liveRuns(stateDir).map((r) => ({ role: r.role, route: r.route, pid: r.pid, ticketRecordId: r.ticketRecordId ?? undefined, streamPath: r.streamPath })),
    killRun: (run) => killRunGroup(run.pid),
    recordKill(run) {
      emit.emit(`run_killed: ${run.role} run on ${run.route} stopped by crew deprovision`, {
        step: 'agent', role: run.role as RoleName, data: { event: 'run_killed', reason: 'deprovision', pid: run.pid },
      });
    },
    async handBack(run) {
      const route = routeFor(run.route);
      if (!run.ticketRecordId || !route) return;
      const memberId = route.resolved?.seats[run.role as RoleName];
      if (!memberId) return;
      const identity = await resolveSeatKey(route, run.role as RoleName, getStore);
      const tracker = new Tracker(route, cfg.ship, { apiKey: identity.apiKey });
      const t = await tracker.ticket(run.ticketRecordId);
      const target = repoTargetFor(route, t.repo_id as string | null | undefined);
      const num = String(t[tracker.contract.columns.key] ?? '').replace(/^\D+/, '');
      const wt = target && num ? worktreeForNumber(target.dir, num) : null;
      let dirty: boolean | null = null;
      // The checkout is removed next, so the comment says what the branch held while it can still be read.
      try { if (wt) dirty = gitWorkingTreeStatus(wt.path).length > 0; } catch { /* unreadable: say so */ }
      await tracker.postEvent(run.ticketRecordId, interruptedComment({
        branch: wt?.branch ?? null, dirty, reason: 'the host was released and wiped',
      }), memberId, 'interrupted');
    },
    sandboxes,
    removeSandbox: (name) => { stopContainer(name); },
    async clearShipRows() {
      const out: Array<{ route: string; ok: boolean; detail: string }> = [];
      for (const r of cfg.routes.filter((x) => x.resolved?.shipsModelId)) {
        try {
          const found = await new Tracker(r, cfg.ship).clearForRelease(cfg.ship.name);
          out.push({ route: r.route, ok: true, detail: found ? 'cleared engaged, tunnel_status, relay_url' : 'no Ships row for this ship' });
        } catch (e) {
          out.push({ route: r.route, ok: false, detail: (e as Error).message });
        }
      }
      return out;
    },
    forgeHosts,
    eraseForgeToken: (host) => eraseForgeToken(cfg.ship.forges, host, stateDir),
    labeled: labeledDocker,
    removeVolume: (name) => { docker(['volume', 'rm', '-f', name]); },
    removeImage: (name) => { docker(['image', 'rm', '-f', name]); },
    remaining() {
      const left: string[] = [];
      if (existsSync(cfg.configFile)) left.push(`config ${cfg.configFile}`);
      for (const h of forgeHosts()) if (hasForgeToken(cfg.ship.forges, h, stateDir)) left.push(`forge token for ${h}`);
      try { for (const k of readdirSync(keysDir(stateDir))) left.push(`seat key ${k}`); } catch { /* no key directory */ }
      for (const s of sandboxes()) left.push(`sandbox ${s}`);
      try {
        const { volumes, images } = labeledDocker();
        for (const v of volumes) left.push(`volume ${v}`);
        for (const i of images) left.push(`image ${i}`);
      } catch (e) { left.push(`docker could not be checked (${(e as Error).message})`); }
      for (const u of unitPaths()) left.push(`unit ${u}`);
      if (loadedCrewLabels().length) left.push(`loaded units ${loadedCrewLabels().join(', ')}`);
      return left;
    },
  };
}
