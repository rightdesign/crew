/**
 * Sorting a run's tool calls into the four kinds EPIC-078 measures
 * (CREW-2879): text `search`, `symbol` lookup, file `edit`, and `other`. The
 * count of each before the run's first edit is what shows whether a
 * repository's `intel` and `map` hooks save the agent from searching.
 *
 * Works from the mapped event's `tool` and `target` alone, which is all
 * every harness adapter yields: for a shell tool the target is the command's
 * first word, so a command is a search only when it plainly starts with one.
 */

export type ToolKind = 'search' | 'symbol' | 'edit' | 'other';

/** The MCP server name crew registers the `intel` service under (CREW-2872). */
export const INTEL_SERVER_NAME = 'code';

const SEARCH_TOOLS = new Set([
  'Grep', 'Glob', 'LS',                                  // Claude
  'search_file_content', 'glob', 'list_directory',       // Gemini
  'grep_search', 'file_search',
]);
const EDIT_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',          // Claude
  'file_change',                                         // Codex
  'replace', 'write_file',                               // Gemini
]);
const SHELL_TOOLS = new Set(['Bash', 'command', 'run_shell_command']);
const SEARCH_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'find', 'ls', 'fd', 'ag']);

export function classifyTool(tool: string | undefined, target: string | undefined): ToolKind {
  if (!tool) return 'other';
  if (tool.startsWith(`mcp__${INTEL_SERVER_NAME}__`)) return 'symbol';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (SEARCH_TOOLS.has(tool)) return 'search';
  if (SHELL_TOOLS.has(tool)) {
    const first = (target ?? '').split('/').pop();
    return first && SEARCH_COMMANDS.has(first) ? 'search' : 'other';
  }
  return 'other';
}

export interface BeforeFirstEdit {
  /** Calls made before the first edit, or all calls when the run never edited. */
  calls: { search: number; symbol: number; other: number };
  /** False for a run that never edited: the counts are then totals. */
  edited: boolean;
  /** Seconds from session start to the first edit; undefined when no edit happened or its time is unknown. */
  secondsToFirstEdit?: number;
}

/** Counts a run's tool calls up to its first edit. Feed every tool event in order. */
export class BeforeFirstEditTracker {
  private readonly calls = { search: 0, symbol: 0, other: 0 };
  private edited = false;
  private seconds: number | undefined;

  /** `elapsedMs` is the time since session start, when known (not on a replayed stream). */
  note(tool: string | undefined, target: string | undefined, elapsedMs?: number): void {
    if (this.edited) return;
    const kind = classifyTool(tool, target);
    if (kind === 'edit') {
      this.edited = true;
      if (elapsedMs !== undefined) this.seconds = Math.max(0, Math.round(elapsedMs / 1000));
    } else {
      this.calls[kind]++;
    }
  }

  result(): BeforeFirstEdit {
    return {
      calls: { ...this.calls },
      edited: this.edited,
      ...(this.seconds !== undefined ? { secondsToFirstEdit: this.seconds } : {}),
    };
  }
}
