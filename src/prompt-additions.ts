/**
 * The fixed divider between a managed prompt and a workspace row's
 * "Additional instructions" (`prompt_additions`). Copied verbatim from the
 * Tablation backend's `PROMPT_ADDITIONS_SEPARATOR` so a lane's assembled
 * prompt matches the Effective prompt Tablation shows; keep generic (no
 * names, dates or ticket ids).
 */
export const PROMPT_ADDITIONS_SEPARATOR =
  '---\n\nAdditional instructions from this workspace. Where they conflict with anything above, these take precedence.';

/**
 * `text` followed, when `additions` is a non-blank string, by the separator
 * and the additions. Blank, absent or non-string additions (a server that
 * predates the column) return `text` byte for byte.
 */
export function appendAdditions(text: string, additions: unknown): string {
  if (typeof additions !== 'string' || additions.trim() === '') return text;
  return `${text}\n\n${PROMPT_ADDITIONS_SEPARATOR}\n\n${additions}`;
}
