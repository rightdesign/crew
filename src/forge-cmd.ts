/**
 * `crew credential` and `crew forge` (CREW-2783), kept out of cli.ts so the
 * helper protocol and the set/rotate flow can be driven by tests with plain
 * strings and a temp state directory.
 */

import { parseDocument } from 'yaml';
import {
  answerCredential, describeForgeSource, forgeDescriptorFor, forgeFor, hasForgeToken, parseCredentialInput, storeForgeToken,
  ForgeError, TOKEN_SOURCES, type ForgesConfig, type ForgeTokenSource,
} from './forges.ts';

export interface CmdResult { code: number; out: string; err: string }

/** `crew credential get|store|erase`: git's helper protocol, answering from the forge block. */
export function runCredential(
  action: string | undefined, stdin: string, forges: ForgesConfig | undefined, stateDir: string, env: NodeJS.ProcessEnv = process.env,
): CmdResult {
  try {
    return { code: 0, out: answerCredential(action ?? '', parseCredentialInput(stdin), forges, stateDir, env), err: '' };
  } catch (e) {
    // A helper that errors makes git fail the whole operation; say why on stderr and answer nothing.
    return { code: 0, out: '', err: `crew credential: ${(e as Error).message}\n` };
  }
}

export interface ForgeArgs {
  /** positional after `forge`: [sub, host]. */
  sub?: string;
  host?: string;
  token?: string;
  tokenStdin: boolean;
  source?: string;
  var?: string;
  path?: string;
  service?: string;
}

export interface ForgeIo {
  forges: ForgesConfig | undefined;
  stateDir: string;
  configFile: string;
  readFile: (p: string) => string;
  writeFile: (p: string, text: string) => void;
  stdin: () => string;
  env: NodeJS.ProcessEnv;
}

/** The `token:` map for `--source`, or an error message. */
function sourceFromArgs(a: ForgeArgs): ForgeTokenSource | string {
  const source = a.source ?? 'file';
  if (!(source in TOKEN_SOURCES)) return `--source must be one of: ${Object.keys(TOKEN_SOURCES).join(', ')}`;
  if (source === 'env') return a.var ? { source: 'env', var: a.var } : '--source env needs --var NAME';
  if (source === 'file') return a.path ? { source: 'file', path: a.path } : { source: 'file' };
  return a.service ? { source: 'keychain', service: a.service } : { source: 'keychain' };
}

export function runForge(a: ForgeArgs, io: ForgeIo): CmdResult {
  const fail = (m: string, code = 2): CmdResult => ({ code, out: '', err: `crew forge: ${m}\n` });
  const sub = a.sub ?? 'list';

  if (sub === 'list') {
    const rows = Object.keys(io.forges ?? {}).map((h) => {
      let state: string;
      try { state = hasForgeToken(io.forges, h, io.stateDir, io.env) ? 'token present' : 'NO TOKEN'; } catch { state = 'unreadable'; }
      return `${h.padEnd(20)} ${state.padEnd(14)} ${describeForgeSource(io.forges, h, io.stateDir)}`;
    });
    return { code: 0, out: rows.length ? `${rows.join('\n')}\n` : 'no forges configured (ship.forges in crew.yaml)\n', err: '' };
  }

  if (sub !== 'set' && sub !== 'rotate') return fail(`unknown subcommand "${sub}" (have: set, rotate, list)`);
  if (!a.host) return fail(`crew forge ${sub} <host> [--token T | --token-stdin] [--source file|keychain|env] [--var NAME] [--path P] [--service S]`);
  const host = a.host.toLowerCase();

  let existing = forgeFor(io.forges, host);
  if (sub === 'rotate' && !existing) return fail(`no forges.${host} entry to rotate; use \`crew forge set ${host}\``);

  if (!existing) {
    const tok = sourceFromArgs(a);
    if (typeof tok === 'string') return fail(tok);
    const doc = parseDocument(io.readFile(io.configFile));
    doc.setIn(['ship', 'forges', host, 'token'], tok);
    io.writeFile(io.configFile, doc.toString());
    io.forges = { ...(io.forges ?? {}), [host]: { username: forgeDescriptorFor(host).credentialUsername, token: tok } };
    existing = forgeFor(io.forges, host);
  }

  if (existing!.entry.token.source === 'env') {
    return { code: 0, out: `forges.${host} reads ${describeForgeSource(io.forges, host, io.stateDir)}; export it where crew runs\n`, err: '' };
  }

  // The token never comes from a positional argument; the flag, stdin and the environment all work non-interactively.
  const token = a.tokenStdin ? io.stdin().trim() : a.token ?? io.env.CREW_FORGE_TOKEN;
  if (!token?.trim()) return fail('no token given (use --token, --token-stdin or CREW_FORGE_TOKEN in the environment)');
  try {
    storeForgeToken(io.forges, host, token, io.stateDir, io.env);
  } catch (e) {
    if (e instanceof ForgeError) return fail(e.message, 1);
    throw e;
  }
  return { code: 0, out: `${sub === 'rotate' ? 'rotated' : 'stored'} the ${host} token in ${describeForgeSource(io.forges, host, io.stateDir)}\n`, err: '' };
}
