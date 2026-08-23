#!/usr/bin/env node
/**
 * `crew` — the CLI.
 *
 * Every command that could change something takes `--dry-run`, and the
 * interlock (`enabled: false` per connection) refuses anything that writes
 * until an operator arms it deliberately.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, connection, type RoleName } from './config.ts';
import { State } from './state.ts';
import { Emitter, eventFileFor } from './events.ts';
import { decideCycle, rosterFor } from './poll.ts';
import { planAgentRun, describePlan, spawnAgent } from './agent.ts';
import { hostPlatform, satisfies, explain } from './platform.ts';

const CREW_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(): never {
  process.stderr.write(`crew — a standing team of headless agents

  crew poll [conn]              decide a cycle and report it; writes nothing
  crew run [conn] [--role R]    run the winning role's session
  crew status [conn]            paused/running state
  crew doctor [conn]            read-only preflight

Options:
  --dry-run     decide everything, perform nothing
  --role NAME   force a role instead of the poll's choice
`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const command = positional[0];
if (!command) usage();

const cfg = loadConfig(CREW_HOME);
const conn = connection(cfg, positional[1]);
const state = new State(cfg.ship.stateDir);
const dryRun = flag('dry-run');

const emit = new Emitter({
  connection: conn.name,
  eventFile: eventFileFor(cfg.ship.stateDir),
  logFile: cfg.ship.logFile,
  console: (l) => process.stderr.write(`${l}\n`),
});

/**
 * The interlock. A dry run is exempt because it writes nothing — being able
 * to inspect a disarmed installation is the point of having one.
 */
function requireArmed(what: string): void {
  if (dryRun || conn.enabled) return;
  process.stderr.write(
    `crew: connection "${conn.name}" is not enabled in ${cfg.configFile} — refusing to ${what}.\n` +
      `      Add --dry-run to see what it would do.\n`,
  );
  process.exit(0);
}

switch (command) {
  case 'poll':
  case 'run': {
    // A ship that cannot satisfy the project's platform must not take its
    // work: it would fail at the first hook, having already claimed a ticket.
    if (!satisfies(cfg.ship.platform, conn.platform)) {
      emit.error(`refusing this connection — ${explain(cfg.ship.platform, conn.platform)}`);
      process.exit(1);
    }
    if (state.isPaused()) {
      emit.emit('the crew is paused');
      break;
    }
    const decision = await decideCycle({ conn, ship: cfg.ship, state, emit });

    if (decision.sweep.length) {
      const verb = dryRun ? 'would' : 'will';
      for (const s of decision.sweep) {
        emit.emit(`${verb} ${s.action} ${s.ticket.issue_id} -> ${s.to} (blockers: ${s.blockers})`, {
          ticket: s.ticket.issue_id, step: 'sweep',
        });
      }
    }

    const role = (value('role') as RoleName | undefined) ?? decision.selection.selected;
    if (command === 'poll' || !role) {
      if (!role) emit.emit('nothing to run this cycle');
      break;
    }

    requireArmed(`run the ${role} role`);
    const plan = planAgentRun({
      role, conn, ship: cfg.ship, crewHome: CREW_HOME,
      stateDir: cfg.ship.stateDir, roster: rosterFor(decision, conn, role),
    });
    if (dryRun) {
      process.stdout.write(`${describePlan(plan)}\n`);
      break;
    }
    emit.enter('agent', role);
    emit.emit('starting agent run');
    await spawnAgent(plan, emit);
    break;
  }

  case 'status': {
    process.stdout.write(
      `ship:       ${cfg.ship.name} (${cfg.ship.platform})\n` +
        `connection: ${conn.name} -> ${conn.dir}\n` +
        `enabled:    ${conn.enabled}\n` +
        `crew:       ${state.isPaused() ? 'paused' : 'active'}\n` +
        `watermark:  ${state.watermark()}\n`,
    );
    for (const r of ['dev', 'design', 'qa'] as RoleName[]) {
      if (state.isRolePaused(r)) process.stdout.write(`role ${r}: paused\n`);
    }
    break;
  }

  case 'doctor': {
    const host = hostPlatform();
    process.stdout.write(
      `ship platform:     ${host}\n` +
        `project requires:  ${conn.platform} — ${satisfies(host, conn.platform) ? 'OK' : 'MISMATCH'}\n` +
        `connections:       ${cfg.connections.map((c) => c.name).join(', ')}\n`,
    );
    break;
  }

  default:
    usage();
}
