/**
 * `{{skill: Name}}` includes in persona briefs (CREW-1534).
 *
 * A brief can pull in an Agent Skill's prompt at run time instead of having
 * the skill's text copied into the Agents row. That keeps an admin edit to a
 * lane's own sentences from forking the shared policy: the policy is its own
 * skill row, synced and diverged on its own terms.
 *
 * Deliberately NOT a `[[table:key]]` record link. Personas and skills are
 * control-plane records, not rows of a workspace table, and `[[Skills:…]]`
 * would collide with any workspace that has a table named Skills. The marker
 * is a grammar only this expander (and the Tablation app's own prompt
 * assembly, which implements the same one) recognizes.
 *
 * Grammar: `{{skill:`, optional whitespace, the skill name, optional
 * whitespace, `}}`, on its own line or inline. The name is matched exactly
 * after trimming. This module is pure: callers supply the lookup, so the
 * choice between a diverged workspace row and the local file stays with them.
 */

export class SkillIncludeError extends Error {}

/** Includes nested deeper than this are left literal. */
export const MAX_INCLUDE_DEPTH = 3;
/** Total bytes of included skill text per expansion; further includes are left literal. */
export const MAX_INCLUDED_BYTES = 200_000;

const MARKER = /\{\{[ \t]*skill:[ \t]*([^{}\r\n]*?)[ \t]*\}\}/g;

/** Every distinct skill name `text` includes, in order of first appearance. */
export function skillMarkerNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(MARKER)) {
    const name = m[1]!.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export interface ExpandOptions {
  maxDepth?: number;
  maxBytes?: number;
}

export interface ExpandResult {
  text: string;
  /** Includes that were left literal (cycle, depth cap, size cap) — surfaced in the run summary. */
  warnings: string[];
}

/**
 * Replaces each `{{skill: Name}}` in `text` with that skill's body.
 *
 * - An unknown name throws {@link SkillIncludeError}: running without the
 *   policy the brief points at is worse than not running, the same call
 *   `planAgentRun` makes for a missing `common.md`.
 * - A skill already being expanded further up the chain (a self-include or a
 *   cycle) is left literal with a warning, so each skill is expanded once per
 *   chain. The same skill included twice side by side is not a cycle.
 * - Includes nested past `maxDepth`, or past `maxBytes` of total included
 *   text, are left literal with a warning.
 */
export function expandSkillMarkers(
  text: string,
  lookup: (name: string) => string | undefined,
  opts: ExpandOptions = {},
): ExpandResult {
  const maxDepth = opts.maxDepth ?? MAX_INCLUDE_DEPTH;
  const maxBytes = opts.maxBytes ?? MAX_INCLUDED_BYTES;
  const warnings: string[] = [];
  let included = 0;

  const expand = (source: string, chain: string[]): string =>
    source.replace(MARKER, (literal, rawName: string) => {
      const name = rawName.trim();
      if (!name) return literal;
      if (chain.includes(name)) {
        warnings.push(`skill include "${name}" left literal: it includes itself (${[...chain, name].join(' → ')})`);
        return literal;
      }
      if (chain.length >= maxDepth) {
        warnings.push(`skill include "${name}" left literal: nested deeper than ${maxDepth} levels`);
        return literal;
      }
      const body = lookup(name);
      if (body === undefined) throw new SkillIncludeError(`no skill named "${name}" for the include ${literal}`);
      const trimmed = body.replace(/^\n+/, '').replace(/\n+$/, '');
      const bytes = Buffer.byteLength(trimmed, 'utf8');
      if (included + bytes > maxBytes) {
        warnings.push(`skill include "${name}" left literal: it would exceed the ${maxBytes}-byte include budget`);
        return literal;
      }
      included += bytes;
      return expand(trimmed, [...chain, name]);
    });

  return { text: expand(text, []), warnings };
}
