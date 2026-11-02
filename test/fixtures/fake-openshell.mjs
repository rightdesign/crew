#!/usr/bin/env node
// Stands in for the `openshell` CLI in sandbox-runner tests. State lives in
// $FAKE_OS_DIR: `calls.jsonl` (one line per invocation: argv plus which of the
// named secrets were visible in the environment), `sandboxes/<name>` for each
// live sandbox, and `exec-<name>.pid` for the running exec client. An `exec`
// whose command is not the `git clone` prep step runs the command locally, so the
// harness fixture behaves as it would inside the sandbox.
import { appendFileSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const dir = process.env.FAKE_OS_DIR;
mkdirSync(join(dir, 'sandboxes'), { recursive: true });
const argv = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ argv, env: { CREW_API_KEY: process.env.CREW_API_KEY ?? null } }) + '\n');
const [group, verb] = argv;
const dash = argv.indexOf('--');
const nameOf = () => argv[(argv.includes('-n') ? argv.indexOf('-n') : argv.indexOf('--name')) + 1];

if (argv[0] === '--version') { console.log('openshell 0.1.6'); process.exit(0); }
if (argv[0] === 'status') { process.exit(process.env.FAKE_OS_DOWN ? 1 : 0); }
if (group === 'sandbox' && verb === 'create') {
  if (process.env.FAKE_OS_CREATE_FAILS) { console.error('ControlSupervisorStartFailed'); process.exit(1); }
  writeFileSync(join(dir, 'sandboxes', nameOf()), '');
  process.exit(0);
}
if (group === 'logs') {   // FAKE_OS_LOG_FILE: what the sandbox log would say
  if (process.env.FAKE_OS_LOG_FILE && existsSync(process.env.FAKE_OS_LOG_FILE)) process.stdout.write(readFileSync(process.env.FAKE_OS_LOG_FILE, 'utf8'));
  process.exit(0);
}
if (group === 'sandbox' && verb === 'upload') process.exit(0);
if (group === 'sandbox' && verb === 'delete') {
  const name = argv[2];
  rmSync(join(dir, 'sandboxes', name), { force: true });
  const pidFile = join(dir, `exec-${name}.pid`);
  if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* gone */ } }
  process.exit(0);
}
if (group === 'sandbox' && verb === 'exec') {
  const cmd = argv.slice(dash + 1);
  // The uploaded prompt file only exists inside a real sandbox.
  if (cmd[0] === 'sh' && cmd[2]) cmd[2] = cmd[2].replace('/sandbox/prompt.txt', '/dev/null');
  if (cmd[0] === 'sh' && /^git (clone|config --global --add safe\.directory)/.test(cmd[2] ?? '')) process.exit(0);   // the clone/checkout prep step
  // FAKE_OS_STDIN_LOG: swallow the client's stdin and record how many bytes arrived.
  const log = process.env.FAKE_OS_STDIN_LOG;
  const child = spawn(cmd[0], cmd.slice(1), { stdio: [log ? 'ignore' : 'inherit', 'inherit', 'inherit'], env: process.env });
  if (log) {
    let n = 0;
    process.stdin.on('data', (b) => { n += b.length; });
    process.stdin.on('end', () => writeFileSync(log, String(n)));
  }
  writeFileSync(join(dir, `exec-${nameOf()}.pid`), String(child.pid));
  child.on('close', (code, sig) => process.exit(sig ? 143 : code ?? 1));
} else process.exit(2);
