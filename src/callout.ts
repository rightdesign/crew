/**
 * The header every crew-written tracker post opens with (CREW-2142): a GitHub
 * alert callout naming the path that wrote it, in the strict form the tracker's
 * own editor serializes (`>` on every line). It replaces the HTML-comment
 * markers the tracker's renderer showed as raw text.
 */

export type CalloutKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

/** The two-line header, with no trailing newline. */
export const calloutHeader = (kind: CalloutKind, label: string): string =>
  `> [!${kind}]\n> **Crew** — ${label}`;

/** The header's label line, for a read-back that has to recognize one of our own posts. */
export const calloutLabelLine = (label: string): string => `> **Crew** — ${label}`;
