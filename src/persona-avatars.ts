/**
 * CREW-3117: a persona's default image ships beside its brief
 * (`personas/lane-<role>.png` or `.svg`) and `crew agents sync` uploads it
 * through the platform's sync route. The server owns the decisions (it sets
 * the image only when the row has none or the stored source hash differs, and
 * never over an image the workspace set by hand), so crew just offers the file
 * every sync and reports what came back. A failed upload is a warning, never a
 * failed sync: the persona works without a face.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_NAMES, resolveApiKey, resolvedPathFor, type RoleName, type Route } from './config.ts';

const IMAGE_TYPES = { png: 'image/png', svg: 'image/svg+xml' } as const;

export type AvatarSyncStatus = 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface AvatarSyncOutcome {
  role: RoleName;
  status: AvatarSyncStatus;
  /** Why it failed or was skipped. */
  detail?: string;
}

/** The bundled image for a role, or undefined when the preset ships none. */
export function personaAvatarFile(promptsDir: string, role: RoleName): { path: string; mimeType: string; name: string } | undefined {
  for (const ext of ['png', 'svg'] as const) {
    const name = `lane-${role}.${ext}`;
    const path = join(promptsDir, 'personas', name);
    if (existsSync(path)) return { path, mimeType: IMAGE_TYPES[ext], name };
  }
  return undefined;
}

export async function syncPersonaAvatars(
  route: Route,
  agentPersonas: Partial<Record<RoleName, { agentId: string }>>,
  opts: { userAgent?: string },
): Promise<AvatarSyncOutcome[]> {
  if (!route.resolved) return [];
  const base = `${route.baseUrl.replace(/\/+$/, '')}/api/workspaces/${route.resolved.workspaceId}/agents/personas`;
  const outcomes: AvatarSyncOutcome[] = [];
  for (const role of ROLE_NAMES) {
    const file = personaAvatarFile(route.promptsDir, role);
    const agentId = agentPersonas[role]?.agentId;
    if (!file || !agentId) continue;
    try {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(file.path)], { type: file.mimeType }), file.name);
      const res = await fetch(`${base}/${agentId}/avatar`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${resolveApiKey(route)}`, 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0' },
        body: form,
      });
      if (!res.ok) {
        outcomes.push({ role, status: 'failed', detail: `${res.status} ${(await res.text()).slice(0, 200)}`.trim() });
        continue;
      }
      const body = (await res.json()) as { status?: string; reason?: string };
      if (body.status === 'updated' || body.status === 'unchanged' || body.status === 'skipped') {
        outcomes.push({ role, status: body.status, ...(body.reason ? { detail: body.reason } : {}) });
      } else {
        outcomes.push({ role, status: 'failed', detail: 'unrecognised response' });
      }
    } catch (e) {
      outcomes.push({ role, status: 'failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}

export function describeAvatarOutcome(o: AvatarSyncOutcome, label: string): string {
  switch (o.status) {
    case 'updated': return `${label}: avatar uploaded`;
    case 'unchanged': return `${label}: avatar already current`;
    case 'skipped': return `${label}: avatar left alone${o.detail ? ` (${o.detail})` : ''}`;
    case 'failed': return `${label}: avatar upload failed — ${o.detail ?? 'unknown error'}`;
  }
}

/** Roles whose last avatar upload failed, as `crew doctor` reads them from the route's state file. */
function avatarFailures(raw: unknown): Array<{ role: string; detail: string }> {
  const map = (raw as { avatarSyncFailures?: Record<string, unknown> } | undefined)?.avatarSyncFailures;
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).map(([role, detail]) => ({ role, detail: String(detail) }));
}

export function routeAvatarFailures(stateDir: string, route: string): Array<{ role: string; detail: string }> {
  try {
    return avatarFailures(JSON.parse(readFileSync(resolvedPathFor(stateDir, route), 'utf8')));
  } catch { return []; }
}
