// A stand-in daemon (CREW-1775): spawns the agent described by the JSON plan
// in argv[2] and waits for it forever, so a test can kill this process (and its
// process group) the way launchd does when it relaunches the real daemon.
import { readFileSync } from 'node:fs';
import { spawnAgent } from '../../src/agent.ts';
import { Emitter } from '../../src/events.ts';

const plan = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const emit = new Emitter({ route: 'proj', cycleId: 'c1', console: () => {} });
emit.enter('agent', plan.role);
await spawnAgent(plan, emit);
