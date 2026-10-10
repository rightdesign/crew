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
