import type { WorkMode } from './work-mode.ts';

/** One `Projects` row as `crew projects` reports it. */
export interface ProjectEntry {
  id: string;
  name: string;
  issuePrefix: string | null;
  workMode: WorkMode;
  /** True for the row this route's `area` points at. */
  current: boolean;
}

export type RouteProjects =
  | { route: string; areaId: string | null; projects: ProjectEntry[] }
  | { route: string; areaId: string | null; error: string };

/** What a route's tracker connection can tell us; `Tracker` satisfies it. */
export interface ProjectSource {
  projectRowsWithModes(): Promise<Array<{ id: string; name?: string; issue_prefix?: string | null; mode: WorkMode }>>;
}

/**
 * The `crew projects --json` payload (CREW-1502): the Projects rows each
 * route's connection can read, for a reader (crew-macos's Settings ▸ Routes
 * popup) that must offer the route's `area` as a choice rather than a typed
 * id. A route whose connection fails (bad key, offline) reports an `error`
 * for that route alone, so one dead key never hides the others.
 */
export async function buildProjectsReport(
  routes: Array<{ route: string; areaId?: string }>,
  open: (route: string) => ProjectSource,
): Promise<RouteProjects[]> {
  return Promise.all(routes.map(async (r): Promise<RouteProjects> => {
    const areaId = r.areaId ?? null;
    try {
      const rows = await open(r.route).projectRowsWithModes();
      return {
        route: r.route,
        areaId,
        projects: rows.map((p) => ({
          id: p.id,
          name: p.name ?? p.id,
          issuePrefix: p.issue_prefix ?? null,
          workMode: p.mode,
          current: p.id === areaId,
        })),
      };
    } catch (e) {
      return { route: r.route, areaId, error: (e as Error).message };
    }
  }));
}

/** The small table `crew projects` prints without `--json`. */
export function formatProjectsReport(report: RouteProjects[]): string {
  const lines: string[] = [];
  for (const r of report) {
    lines.push(`route ${r.route}`);
    if ('error' in r) { lines.push(`  error: ${r.error}`); continue; }
    if (r.projects.length === 0) lines.push('  (no projects readable)');
    for (const p of r.projects) {
      lines.push(`  ${p.current ? '*' : ' '} ${p.name}\t${p.issuePrefix ?? '-'}\t${p.workMode}\t${p.id}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** An error `crew projects add` reports as one plain line (no stack trace). `code` is the stable reason for a `--json` reader. */
export class ProjectsError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid') { super(message); this.code = code; }
}

export const WORK_MODES: readonly WorkMode[] = ['automatic', 'hybrid', 'manual'];

/** What the refusal to write a Projects row says; a raw API error never reaches the person. */
export const PROJECT_FORBIDDEN_MESSAGE =
  "this route's key is not allowed to create a Projects row — a workspace admin has to add the project (the Projects table, or `crew projects add` with an admin's key)";

export interface ProjectAddInput {
  name?: string;
  prefix?: string;
  /** `--work-mode`; undefined means automatic and is not an explicit request. */
  workMode?: string;
}

/** What `planProjectAdd` needs from the contract and the Projects table. */
export interface ProjectAddContext {
  workModeColumn: string;
  manualWorkMode: string;
  hybridWorkMode: string;
  /** Rows already in the Projects table. */
  existing: Array<{ id: string; name?: string; issue_prefix?: string | null }>;
  /** False when the Projects table has no work mode column. */
  hasWorkModeColumn: boolean;
}

export interface ProjectAddPlan {
  /** The fields to write. */
  fields: Record<string, unknown>;
  name: string;
  prefix: string;
  workMode: WorkMode;
}

/** The checks that need no request: required fields, prefix shape, work mode value. */
export function validateProjectInput(i: ProjectAddInput): { name: string; prefix: string; workMode: WorkMode; explicitMode: boolean } {
  const name = (i.name ?? '').trim();
  if (!name) throw new ProjectsError('a project needs a name: crew projects add [route] NAME --prefix PREFIX');
  const prefix = (i.prefix ?? '').trim();
  if (!prefix) throw new ProjectsError('a project needs an issue prefix: pass --prefix PREFIX (letters and digits, e.g. CREW)');
  if (!/^[A-Za-z0-9]+$/.test(prefix)) {
    throw new ProjectsError(`the issue prefix "${prefix}" may only contain letters and digits`);
  }
  const mode = i.workMode?.trim().toLowerCase();
  if (mode !== undefined && !(WORK_MODES as readonly string[]).includes(mode)) {
    throw new ProjectsError(`unknown work mode "${i.workMode}" (use ${WORK_MODES.join(', ')})`);
  }
  return { name, prefix: prefix.toUpperCase(), workMode: (mode as WorkMode | undefined) ?? 'automatic', explicitMode: mode !== undefined };
}

/**
 * The Projects row to create (CREW-3359). Validation first, then the
 * duplicate check against the rows that exist (name or prefix, compared
 * case-insensitively, naming the row that already holds it). The work mode
 * goes through the contract's column and values; a table without that column
 * refuses an explicit `--work-mode` and takes the row without one.
 */
export function planProjectAdd(i: ProjectAddInput, ctx: ProjectAddContext): ProjectAddPlan {
  const v = validateProjectInput(i);
  for (const row of ctx.existing) {
    if (row.name?.toLowerCase() === v.name.toLowerCase()) {
      throw new ProjectsError(`a project named "${row.name}" already exists (${row.id}); nothing was created`, 'duplicate');
    }
    if (row.issue_prefix && row.issue_prefix.toLowerCase() === v.prefix.toLowerCase()) {
      throw new ProjectsError(`the prefix ${row.issue_prefix} is already used by project "${row.name ?? row.id}" (${row.id}); nothing was created`, 'duplicate');
    }
  }
  const fields: Record<string, unknown> = { name: v.name, issue_prefix: v.prefix };
  if (ctx.hasWorkModeColumn) {
    fields[ctx.workModeColumn] = v.workMode === 'manual' ? ctx.manualWorkMode : v.workMode === 'hybrid' ? ctx.hybridWorkMode : 'automatic';
  } else if (v.explicitMode) {
    throw new ProjectsError(`this workspace's Projects table has no ${ctx.workModeColumn} column, so --work-mode cannot be set; omit it to create the project without one`, 'no_work_mode_column');
  }
  return { fields, name: v.name, prefix: v.prefix, workMode: ctx.hasWorkModeColumn ? v.workMode : 'automatic' };
}

/** What a tracker connection must offer for `crew projects add`; `Tracker` satisfies it. */
export interface ProjectWriter {
  projectRows(): Promise<Array<{ id: string; name?: string; issue_prefix?: string | null }>>;
  projectHasWorkMode(): Promise<boolean>;
  createProjectRow(fields: Record<string, unknown>): Promise<{ id: string }>;
  contract: { columns: { workMode: string }; manualWorkMode: string; hybridWorkMode: string };
}

function isForbidden(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 403 || /\b403\b/.test(e instanceof Error ? e.message : String(e));
}

/**
 * Create a Projects row, or with `dryRun` only plan it. A refused write
 * (403) becomes `PROJECT_FORBIDDEN_MESSAGE`; the shared code path for
 * `crew projects add` and `crew repos add` on an empty Projects table.
 */
export async function createProject(
  tracker: ProjectWriter,
  input: ProjectAddInput,
  opts: { dryRun?: boolean } = {},
): Promise<{ entry: ProjectEntry; created: boolean }> {
  // Shape errors are raised before any request is made.
  validateProjectInput(input);
  let plan: ProjectAddPlan;
  try {
    plan = planProjectAdd(input, {
      workModeColumn: tracker.contract.columns.workMode,
      manualWorkMode: tracker.contract.manualWorkMode,
      hybridWorkMode: tracker.contract.hybridWorkMode,
      existing: await tracker.projectRows(),
      hasWorkModeColumn: await tracker.projectHasWorkMode(),
    });
  } catch (e) {
    if (e instanceof ProjectsError) throw e;
    throw new ProjectsError(isForbidden(e) ? PROJECT_FORBIDDEN_MESSAGE : `could not read the Projects table: ${firstLine(e)}`, isForbidden(e) ? 'forbidden' : 'tracker');
  }
  const entry = (id: string): ProjectEntry => ({ id, name: plan.name, issuePrefix: plan.prefix, workMode: plan.workMode, current: false });
  if (opts.dryRun) return { entry: entry(''), created: false };
  try {
    const row = await tracker.createProjectRow(plan.fields);
    return { entry: entry(row.id), created: true };
  } catch (e) {
    throw new ProjectsError(isForbidden(e) ? PROJECT_FORBIDDEN_MESSAGE : `could not create the project: ${firstLine(e)}`, isForbidden(e) ? 'forbidden' : 'tracker');
  }
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200);
}

/** The questions `crew repos add` asks on a terminal; `terminalPrompter()` in cli.ts satisfies it. */
export interface ProjectPrompter {
  say(line: string): void;
  ask(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
}

/**
 * CREW-3359: `crew repos add` on a tracker with no Projects row. Asks whether to create
 * one, then its name and prefix, and creates it with `createProject`'s own checks. Null
 * when the person declines, so the caller leaves everything untouched.
 */
export async function offerFirstProject(
  prompter: ProjectPrompter,
  create: (input: ProjectAddInput) => Promise<{ entry: ProjectEntry }>,
): Promise<ProjectEntry | null> {
  prompter.say('The tracker has no Projects row, and the new Repos row has to belong to one.');
  if (!(await prompter.confirm('Create a project now?', true))) return null;
  const name = await prompter.ask('Project name');
  const prefix = await prompter.ask('Issue prefix (letters and digits, e.g. CREW)');
  return (await create({ name, prefix })).entry;
}
