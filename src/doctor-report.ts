/**
 * The text report of `crew doctor` (CREW-3272): collected first, rendered after.
 *
 * Every check used to print its own line as it ran, so findings were scattered
 * through ~110 lines in check order, repeated once per repository, and the
 * report ended with whatever the `--fix` phase had to say. The checks still
 * produce the same lines (their wording lives in many helpers); `DoctorReport.line`
 * takes each one, splits it into label and value, classifies its severity from
 * the words the check already uses, and keeps it. `renderDoctor` then prints
 * either the findings that need attention (default) or every check under
 * section headings (`--verbose`), and always ends with a verdict.
 *
 * Severity never feeds the exit code: the call sites keep setting
 * `process.exitCode` exactly where they did. `--json` has its own structure
 * (`doctor-problems.ts`) and does not pass through here.
 *
 * Pure: no disk, no tracker, so the renderer is tested directly.
 */

export type DoctorSeverity = 'ok' | 'info' | 'note' | 'warning' | 'blocker';

export type DoctorSection = 'ship' | 'tracker' | 'repositories' | 'seats' | 'tools' | 'passengers';

export const DOCTOR_SECTIONS: Array<{ id: DoctorSection; title: string }> = [
  { id: 'ship', title: 'Ship' },
  { id: 'tracker', title: 'Tracker' },
  { id: 'repositories', title: 'Repositories' },
  { id: 'seats', title: 'Seats' },
  { id: 'tools', title: 'Tools' },
  { id: 'passengers', title: 'Periscopes, passengers and sandbox' },
];

export interface DoctorFinding {
  severity: DoctorSeverity;
  section: DoctorSection;
  label: string;
  /** The check's own wording, remedy included where the check states one. Continuation lines are joined with `\n`. */
  text: string;
  repo?: string;
  /** A repository the message names (`for <repo>:`, `…/<repo>:`) outside a repository block; used only to group repeats. */
  mentions?: string;
}

const RANK: Record<DoctorSeverity, number> = { ok: 0, info: 1, note: 2, warning: 3, blocker: 4 };

const worse = (a: DoctorSeverity, b: DoctorSeverity): DoctorSeverity => (RANK[b] > RANK[a] ? b : a);

/** Severity from the words a check already prints. Uppercase words are the checks' own markers. */
export function classifySeverity(label: string, text: string): DoctorSeverity {
  const s = `${label} ${text}`;
  if (/\b(BLOCKER|ERROR)\b/.test(s)) return 'blocker';
  // The ship-attention items print as a lowercase `attention:` label; each one needs a person.
  if (/^attention$/i.test(label)) return 'warning';
  if (/\b(WARN|WARNING|ATTENTION|DEAD|NOT FOUND|NOT READY|NOT AVAILABLE|NOT installed|NO row|MISMATCH|STALE|FAILED)\b|\(missing\)|\bMISSING\b|\bnot registered\b|\b\d{3} —/.test(s)) return 'warning';
  if (/\bNOTE\b|cannot enforce|\bnot run\b|release readiness|\babsent\b|\bmissing\b|^none\b|\bnot minted\b|could not (be )?check|\bunknown\b|no operator|\bwithout\b|discovery unavailable/.test(s)) return 'note';
  return 'ok';
}

const SECTION_BY_LABEL: Array<[DoctorSection, RegExp]> = [
  ['seats', /^(seat |operator identity|api key role|can mint|capability)/],
  ['passengers', /^(periscopes?\b|periscope mcp|host passengers|docker|ssh-keygen|image|relay (host|control|tunnel)|sandbox|attention|foreign launchd)/],
  ['tracker', /^(contract|authorship|runtime columns|link columns|public replies|crew assisted|release seat|ship (record|row|holds)|crew manifest|branch\/pull|pull request|branch links)/],
  ['tools', /^(agent binary|toolchain|git\b|mcp|pair\b|auth\b|credential helper|hook |repo toolchain|push auth|gh\b|node\b|docker\b)/],
  ['ship', /^(ship|routes?|bundle|role concurrency|persona avatar|key store|events log|scheduler unit|passengers unit|daemon|reload request|crew version)/],
];

function sectionOf(label: string): DoctorSection | undefined {
  for (const [id, re] of SECTION_BY_LABEL) if (re.test(label)) return id;
  return undefined;
}

const LABEL_RE = /^([A-Za-z][\w.\-/ ]{0,38}?):\s+(\S.*)$/;
const MARKER_RE = /^(WARNING|WARN|ERROR|BLOCKER|ATTENTION|NOTE|MISSING|NOT)\b/;

/** Collects the lines the checks print; `repo` scopes lines to the repository whose block is being written. */
export class DoctorReport {
  readonly findings: DoctorFinding[] = [];
  /** Set while a repository's block is being written; lines are filed under it and grouped across repositories. */
  repo: string | undefined;
  /** Repository names of the route; a line outside a repo block that names exactly one is grouped with the same line for the others. */
  repoNames: string[] = [];
  private last: DoctorFinding | undefined;

  private mentionedRepo(text: string): string | undefined {
    const hits = this.repoNames.filter((n) => text.split('\n').some((l) => l.includes(`${n}:`) && new RegExp(`(?:^|[\\s/])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(l)));
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** Take one check's output (one or more lines, as it would have been printed). */
  line(raw: string, ctx: { repo?: string } = {}): void {
    const repo = ctx.repo ?? this.repo;
    for (const physical of raw.split('\n')) {
      if (physical.trim() === '') continue;
      const continuation = /^\s{2,}/.test(physical);
      const body = physical.trim().replace(/^-\s+/, '');
      // `repo <name>:<dir>` can outgrow its padded column and run into the path with no space.
      const m = MARKER_RE.test(body) ? null : (/^(repo \S+?):(\/\S.*)$/.exec(body) ?? LABEL_RE.exec(body));
      // A line that opens with a severity word is its own finding, not the tail of the line above.
      if (continuation && this.last && !m && !MARKER_RE.test(body)) {
        this.last.text += `\n${body}`;
        this.last.severity = worse(this.last.severity, classifySeverity('', body));
        continue;
      }
      const label = m ? m[1]!.trim() : '';
      const text = m ? m[2]!.trim() : body;
      const parent = continuation ? this.last : undefined;
      const section: DoctorSection = repo ? 'repositories' : (sectionOf(label) ?? parent?.section ?? this.last?.section ?? 'ship');
      const f: DoctorFinding = { severity: classifySeverity(label, text), section, label, text, ...(repo ? { repo } : {}) };
      if (!repo) {
        const mentions = this.mentionedRepo(text);
        if (mentions) f.mentions = mentions;
      }
      this.findings.push(f);
      this.last = f;
    }
  }

  counts(): { blocker: number; warning: number; note: number; passed: number } {
    const merged = groupFindings(this.findings.filter((f) => RANK[f.severity] >= RANK.note));
    const c = { blocker: 0, warning: 0, note: 0, passed: 0 };
    for (const g of merged) c[g.severity as 'blocker' | 'warning' | 'note']++;
    c.passed = this.findings.filter((f) => RANK[f.severity] < RANK.note).length;
    return c;
  }
}

export interface GroupedFinding extends DoctorFinding {
  repos: string[];
}

/** A finding with the same severity, label and message on several repositories prints once. */
export function groupFindings(findings: DoctorFinding[]): GroupedFinding[] {
  const out: GroupedFinding[] = [];
  const byKey = new Map<string, GroupedFinding>();
  for (const f of findings) {
    const repo = f.repo ?? f.mentions;
    if (!repo) { out.push({ ...f, repos: [] }); continue; }
    const norm = (s: string) => s.split(repo).join('<repo>');
    const key = [f.severity, f.section, norm(f.label), norm(f.text)].join('\0');
    const hit = byKey.get(key);
    if (hit) { if (!hit.repos.includes(repo)) hit.repos.push(repo); continue; }
    const g: GroupedFinding = { ...f, repos: [repo] };
    byKey.set(key, g);
    out.push(g);
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `repo a, b, c`, or a count when there are many. */
function reposPhrase(repos: string[]): string {
  return repos.length <= 5 ? `repositories ${repos.join(', ')}` : `${repos.length} repositories (${repos.slice(0, 3).join(', ')}, …)`;
}

const SEVERITY_WORD: Record<'blocker' | 'warning' | 'note', string> = { blocker: 'BLOCKER', warning: 'WARNING', note: 'NOTE   ' };

/** The last line of the report. */
export function verdictLine(c: { blocker: number; warning: number; note: number; passed: number }): string {
  const parts: string[] = [];
  if (c.blocker) parts.push(plural(c.blocker, 'blocker'));
  if (c.warning) parts.push(plural(c.warning, 'warning'));
  if (c.note) parts.push(plural(c.note, 'note'));
  if (parts.length === 0) return `verdict: all clear — ${plural(c.passed, 'check')} passed`;
  const lead = c.blocker ? 'needs action' : c.warning ? 'usable, with warnings' : 'ok, with notes';
  return `verdict: ${lead} — ${parts.join(', ')}; ${plural(c.passed, 'check')} passed`;
}

function indentContinuation(text: string, pad: number): string {
  return text.split('\n').map((l, i) => (i === 0 ? l : `${' '.repeat(pad)}${l}`)).join('\n');
}

/**
 * The report. Default: header, the findings that are not `ok`/`info` (blocker
 * first), a count of what passed, the verdict. `verbose`: header, then every
 * check under section headings with one label column, then the verdict.
 */
export function renderDoctor(report: DoctorReport, header: string[], verbose: boolean): string {
  const c = report.counts();
  const out: string[] = [...header];
  if (!verbose) {
    const shown = groupFindings(report.findings.filter((f) => RANK[f.severity] >= RANK.note))
      .sort((a, b) => RANK[b.severity] - RANK[a.severity]);
    for (const g of shown) {
      const sev = SEVERITY_WORD[g.severity as 'blocker' | 'warning' | 'note'];
      const where = g.repos.length ? ` [${reposPhrase(g.repos)}]` : '';
      const head = `${sev}  ${g.label ? `${g.label}: ` : ''}`;
      // The severity word replaces the check's own marker; a grouped line names the repository once, in brackets.
      let text = g.text.replace(/^(WARNING|WARN|NOTE|BLOCKER|ERROR|ATTENTION)\s+/, '');
      if (g.repos.length > 1) for (const r of g.repos) text = text.split(r).join('<repo>');
      out.push(`${head}${indentContinuation(text, 4)}${where}`);
    }
    if (shown.length) out.push('');
    if (c.passed) out.push(`${plural(c.passed, 'check')} passed (\`crew doctor --verbose\` lists them)`);
    out.push(verdictLine(c));
    return `${out.join('\n')}\n`;
  }
  for (const s of DOCTOR_SECTIONS) {
    const inSection = report.findings.filter((f) => f.section === s.id);
    if (inSection.length === 0) continue;
    out.push('', s.title, '-'.repeat(s.title.length));
    const block = (items: DoctorFinding[], indent: number, strip?: string) => {
      const labelOf = (f: DoctorFinding) => (strip && f.label === `repo ${strip}` ? 'path' : f.label);
      const width = Math.min(26, Math.max(...items.map((f) => (labelOf(f) ? labelOf(f).length + 1 : 0)))) + 1;
      for (const f of items) {
        const l = labelOf(f);
        const lab = l ? `${l}:` : '';
        // Always at least one space between label and value, even when the label outgrows the column.
        const col = lab.length >= width ? `${lab} ` : lab.padEnd(width);
        out.push(`${' '.repeat(indent)}${col}${indentContinuation(f.text, indent + col.length)}`);
      }
    };
    if (s.id === 'repositories') {
      const names = [...new Set(inSection.map((f) => f.repo ?? ''))];
      for (const n of names) {
        out.push(n ? `  ${n}` : '');
        block(inSection.filter((f) => (f.repo ?? '') === n), 4, n);
      }
    } else block(inSection, 0);
  }
  out.push('', verdictLine(c));
  return `${out.join('\n')}\n`;
}

/**
 * What the `--fix` phase prints (CREW-3272). It used to print `fix: nothing to
 * change` at the end of every interactive run, which reads as a clean bill of
 * health straight after a blocker. Now a plain run with nothing to offer is
 * silent; `--fix` says that no automatic fix applies and, when the report has
 * warnings or blockers, that they need the remedies listed above.
 */
export function fixPhaseNothingToOffer(o: { notes: string[]; fixFlag: boolean; blockers: number; warnings: number }): string[] {
  const lines = o.notes.map((n) => `fix: ${n}`);
  if (!o.fixFlag) return lines;
  const outstanding = o.blockers + o.warnings;
  lines.push(outstanding
    ? `fix: no automatic fix applies; the ${plural(outstanding, 'finding')} above ${outstanding === 1 ? 'needs' : 'need'} action`
    : 'fix: no automatic fix applies, and nothing needs one');
  return lines;
}
