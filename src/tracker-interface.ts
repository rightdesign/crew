/**
 * The work tracker interface (EPIC-093 Map v1 §9.1, CREW-3579).
 *
 * What crew expects of the tracker app, published as data in the form the
 * platform's app interface feature accepts (name, owner, a two-number version,
 * roles for tables and fields, named value sets). An app that implements it
 * declares a mapping from each role to its own table, field or choice value;
 * crew then reads the app through that mapping instead of finding tables by
 * display name.
 *
 * This is the single source for the defaults in code: `DEFAULT_CONTRACT`
 * (contract.ts) is built from the `default` of each entry below, and the
 * reference page (docs/WORK_TRACKER.md) is generated from the same data
 * (`renderReferencePage`, checked by test/tracker-interface.test.ts).
 *
 * Nothing here imports contract.ts at runtime: contract.ts imports this file.
 */

export interface InterfaceVersion { major: number; minor: number }

interface RoleBase {
  id: string;
  label: string;
  whatBreaks: string;
  optional?: boolean;
}
export interface TableRole extends RoleBase { type: 'table' }
export interface FieldRole extends RoleBase {
  type: 'field';
  tableRole: string;
  fieldKind: 'text' | 'number' | 'date' | 'boolean' | 'choice' | 'multichoice' | 'file' | 'link' | 'any';
  multiple?: boolean | 'either';
  computed?: boolean | 'either';
  builtinColumns?: string[];
  /** `link` only: the table role the link must point at (the platform's own `linkTarget` form). */
  linkTarget?: { tableRole: string };
}
export type InterfaceRole = TableRole | FieldRole;

export interface InterfaceValueSet {
  id: string;
  label: string;
  fieldRole: string;
  values: { id: string; label: string; optional?: boolean }[];
}

/** The document the platform stores on an app that declares it. */
export interface InterfaceDefinition {
  name: string;
  owner: string;
  version: InterfaceVersion;
  roles: InterfaceRole[];
  valueSets?: InterfaceValueSet[];
}

/** The platform's mapping half of a declaration: names only. */
export interface InterfaceMapping {
  tables: Record<string, string>;
  fields: Record<string, string>;
  values: Record<string, Record<string, string>>;
}

// ---- the definition ------------------------------------------------------

export const TRACKER_INTERFACE_NAME = 'work-tracker';

/** The versions of the interface this crew reads: the same major, a minor of at least `minMinor`. */
export const ACCEPTED_INTERFACE_VERSIONS = { major: 1, minMinor: 0 } as const;

/**
 * The transition switch (CREW-3579 item 5). While true, an app that declares
 * nothing keeps working from the built-in defaults, found by display name, and
 * only raises a non-blocking attention item. A later release sets it to false
 * to make the declaration required; no date is set for that.
 */
export const ALLOW_UNDECLARED_TRACKER_APPS = true;

export interface TableEntry {
  role: string;
  defaultName: string;
  label: string;
  optional?: boolean;
  whatBreaks: string;
}

export const TABLE_ENTRIES: readonly TableEntry[] = [
  { role: 'issues', defaultName: 'Issues', label: 'Tickets table', whatBreaks: 'Without it crew has no tickets to work.' },
  { role: 'comments', defaultName: 'Comments', label: 'Comments table', whatBreaks: 'Without it crew cannot read answers or post progress.' },
  { role: 'crew', defaultName: 'Crew', label: 'Crew table', whatBreaks: 'Without it crew has no seats to act as and no people to hand work to.' },
  { role: 'projects', defaultName: 'Projects', label: 'Projects table', optional: true, whatBreaks: 'Without it tickets cannot be routed by project or work mode.' },
  { role: 'repos', defaultName: 'Repos', label: 'Repos table', optional: true, whatBreaks: 'Without it a ticket cannot name the repository it belongs to.' },
  { role: 'ships', defaultName: 'Ships', label: 'Ships table', optional: true, whatBreaks: 'Without it several machines cannot share one board.' },
  { role: 'epics', defaultName: 'Epics', label: 'Epics table', optional: true, whatBreaks: 'Without it tickets cannot belong to an epic.' },
  { role: 'maps', defaultName: 'Maps', label: 'Maps table', optional: true, whatBreaks: 'Without it a ticket cannot cite its epic’s planning document.' },
  { role: 'periscopes', defaultName: 'Periscopes', label: 'Periscopes table', optional: true, whatBreaks: 'Without it crew cannot host live previews.' },
  { role: 'locks', defaultName: 'Locks', label: 'Locks table', optional: true, whatBreaks: 'Without it ships cannot take the release lock through the board.' },
  { role: 'questions', defaultName: 'Questions', label: 'Questions table', optional: true, whatBreaks: 'Without it a seat that parks a ticket for an answer cannot also ask the question as a record with proposed answers; the comment still carries it.' },
  { role: 'answers', defaultName: 'Answers', label: 'Answers table', optional: true, whatBreaks: 'Without it a question cannot offer proposed answers.' },
];

export interface FieldEntry {
  /** Role id, unique across the interface, `<table role>.<name>`. */
  role: string;
  table: string;
  /** Where the column lands in `Contract`, e.g. `columns.status`. */
  contractPath: string;
  defaultColumn: string;
  kind: FieldRole['fieldKind'];
  label: string;
  optional?: boolean;
  multiple?: boolean | 'either';
  /** Absent means the platform's default: the field must not be computed. */
  computed?: boolean | 'either';
  builtin?: string[];
  /** `link` only: the table role the link must point at. */
  linkTo?: string;
  whatBreaks: string;
}

function f(
  table: string, name: string, contractPath: string, defaultColumn: string, kind: FieldRole['fieldKind'],
  label: string, whatBreaks: string, extra: Partial<Pick<FieldEntry, 'optional' | 'multiple' | 'computed' | 'builtin' | 'linkTo'>> = {},
): FieldEntry {
  return { role: `${table}.${name}`, table, contractPath, defaultColumn, kind, label, whatBreaks, ...extra };
}
const opt = { optional: true } as const;
/**
 * A role crew only reads (the key roles: the tracker generates them and crew
 * never writes them) accepts a computed or a plain field. A role with no
 * `computed` setting means "must not be computed", which is what a role crew
 * writes needs (CREW-3638).
 */
const readOnly = { computed: 'either' } as const;

export const FIELD_ENTRIES: readonly FieldEntry[] = [
  f('issues', 'key', 'columns.key', 'issue_id', 'any', 'Ticket key', 'Without it tickets cannot be named in branches, comments or logs.', readOnly),
  f('issues', 'tag', 'columns.tag', 'issue_tag', 'any', 'Per-project ticket tag', 'Without it branches fall back to plain `issue-<number>` names.', { ...opt, ...readOnly }),
  f('issues', 'title', 'columns.title', 'title', 'text', 'Title', 'Without it crew cannot show or file a ticket.'),
  f('issues', 'status', 'columns.status', 'status', 'choice', 'Status', 'Without it crew cannot tell which tickets to work.'),
  f('issues', 'assignee', 'columns.assignee', 'assignee_id', 'link', 'Assignee', 'Without it crew cannot claim a ticket or see who holds one.'),
  f('issues', 'priority', 'columns.priority', 'priority', 'choice', 'Priority', 'Without it tickets cannot be ordered by urgency.'),
  f('issues', 'severity', 'columns.severity', 'severity', 'choice', 'Severity', 'Without it tickets cannot be ordered by severity.'),
  f('issues', 'slice', 'columns.slice', 'project_id', 'link', 'Project', 'Without it tickets cannot be partitioned by project.'),
  f('issues', 'repo', 'columns.repo', 'repo_id', 'link', 'Repository', 'Without it crew cannot tell which checkout a ticket belongs to.'),
  f('issues', 'parent', 'columns.parent', 'parent_id', 'link', 'Parent ticket', 'Without it coordinating tickets cannot roll up their children.', opt),
  f('issues', 'blockedBy', 'columns.blockedBy', 'blocked_by', 'link', 'Blocked by', 'Without it crew cannot park a ticket behind its dependencies.', { multiple: 'either' }),
  f('issues', 'updatedAt', 'columns.updatedAt', 'updated_at', 'any', 'Updated at', 'Without it crew cannot tell what changed since the last poll.', { builtin: ['updated_at'] }),
  f('issues', 'needsDesign', 'columns.needsDesign', 'needs_design', 'boolean', 'Needs design', 'Without it tickets cannot be split between the dev and design lanes.', opt),
  f('issues', 'attachments', 'columns.attachments', 'attachments', 'file', 'Attachments', 'Without it a seat cannot open a ticket’s screenshots.', { ...opt, multiple: 'either' }),
  f('issues', 'reportType', 'columns.reportType', 'report_type', 'choice', 'Report type', 'Without it questions, investigations and coordinating tickets are treated as builds.', opt),
  f('issues', 'epic', 'columns.epic', 'epic_id', 'link', 'Epic', 'Without it tickets cannot belong to an epic.', opt),
  f('issues', 'author', 'columns.author', 'filed_by_id', 'link', 'Filed by', 'Without it a filed ticket does not name its filer.', opt),
  f('issues', 'ship', 'columns.ship', 'ship_id', 'link', 'Filed from ship', 'Without it a ticket does not name the machine it was filed from.', opt),
  f('issues', 'heldBy', 'columns.heldBy', 'held_by_ship_id', 'link', 'Held by ship', 'Without it two machines can claim the same ticket.', opt),
  f('issues', 'resolutionNote', 'columns.resolutionNote', 'resolution_note', 'text', 'Resolution note', 'Without it a close that needs a reason cannot give one.', opt),
  f('issues', 'verifiedSha', 'columns.verifiedSha', 'verified_sha', 'text', 'Verified commit', 'Without it review cannot tell whether the verified branch changed.', opt),
  f('issues', 'prRef', 'columns.prRef', 'pr_ref', 'text', 'Pull request reference', 'Without it the merged hook cannot be told which pull request it ends.', opt),
  f('issues', 'branchUrl', 'columns.branchUrl', 'branch_url', 'text', 'Branch URL', 'Without it the ticket does not link to its pushed branch.', opt),
  f('issues', 'prUrl', 'columns.prUrl', 'pr_url', 'text', 'Pull request URL', 'Without it the ticket does not link to its pull request.', opt),
  f('issues', 'externalId', 'columns.externalId', 'external_id', 'text', 'External id', 'Without it imported tickets cannot be told from hand-filed ones.', opt),
  f('issues', 'position', 'columns.position', 'position', 'number', 'Manual position', 'Without it the board’s manual order is ignored.', opt),
  f('issues', 'agentRuns', 'columns.agentRuns', 'agent_runs', 'number', 'Agent runs', 'Without it per-ticket run counts are not kept.', opt),
  f('issues', 'tokensIn', 'columns.tokensIn', 'tokens_in', 'number', 'Input tokens', 'Without it per-ticket token spend is not kept.', opt),
  f('issues', 'tokensOut', 'columns.tokensOut', 'tokens_out', 'number', 'Output tokens', 'Without it per-ticket token spend is not kept.', opt),
  f('issues', 'cacheReadTokens', 'columns.cacheReadTokens', 'cache_read_tokens', 'number', 'Cache read tokens', 'Without it per-ticket token spend is not kept.', opt),
  f('issues', 'cacheWriteTokens', 'columns.cacheWriteTokens', 'cache_write_tokens', 'number', 'Cache write tokens', 'Without it per-ticket token spend is not kept.', opt),
  f('issues', 'costUsd', 'columns.costUsd', 'cost_usd', 'number', 'Cost (USD)', 'Without it per-ticket spend is not kept.', opt),
  f('issues', 'crewAssisted', 'columns.crewAssisted', 'crew_assisted', 'boolean', 'Crew assisted', 'Without it tickets the crew worked are not marked.', opt),
  f('issues', 'description', 'columns.description', 'description', 'text', 'Description', 'Without it the platform cannot tell its own setup tickets from a first ticket, and cannot write one.', opt),
  f('issues', 'needsPlanning', 'columns.needsPlanning', 'needs_planning', 'boolean', 'Needs planning', 'Without it the platform counts every ticket in a demand status as plannable, including ones a person still owes scoping.', opt),
  f('projects', 'workMode', 'columns.workMode', 'work_mode', 'choice', 'Work mode', 'Without it every project is worked automatically.', opt),
  f('comments', 'parent', 'comments.parent', 'ticket_id', 'link', 'Comment ticket', 'Without it a comment cannot be tied to its ticket.'),
  f('comments', 'body', 'comments.body', 'body', 'text', 'Comment body', 'Without it a comment has no text.'),
  f('comments', 'author', 'comments.author', 'team_member_id', 'link', 'Comment author', 'Without it crew cannot tell its own comments from a person’s.'),
  f('comments', 'createdAt', 'comments.createdAt', 'created_at', 'any', 'Comment time', 'Without it comments cannot be ordered.', { builtin: ['created_at'] }),
  f('comments', 'ship', 'comments.ship', 'ship_id', 'link', 'Posted from ship', 'Without it a comment does not name the machine that posted it.', opt),
  f('comments', 'publicReply', 'comments.publicReply', 'is_public_reply', 'boolean', 'Public reply', 'Without it replies from a public form are read as the team’s.', opt),
  f('comments', 'authorName', 'comments.authorName', 'author_name', 'text', 'Public author name', 'Without it a public reporter’s name is lost.', opt),
  // Read by the platform's scheduler, project setup checklist and repository
  // pages (interface 1.2, CREW-3633). All optional: the platform reports a role
  // it needs but the app did not map as 'not ready' with that reason.
  f('repos', 'name', 'repos.name', 'name', 'text', 'Repository name', 'Without it a repository has no short name to show or route by.', opt),
  f('repos', 'remote', 'repos.remote', 'remote', 'text', 'Repository remote', 'Without it the platform cannot tell which `owner/name` a repository is.', opt),
  f('repos', 'enabled', 'repos.enabled', 'enabled', 'boolean', 'Repository enabled', 'Without it the platform cannot tell a repository crew works from one it has switched off.', opt),
  f('repos', 'ciProvider', 'repos.ciProvider', 'ci_provider', 'any', 'CI provider', 'Without it the platform cannot tell which CI system a repository uses (a text or choice field).', opt),
  f('repos', 'appUrl', 'repos.appUrl', 'app_url', 'text', 'App URL', 'Without it the setup checklist has no link to where the app is served.', opt),
  f('repos', 'project', 'repos.project', 'project_id', 'link', 'Repository project', 'Without it setup tickets cannot tell which project a repository belongs to.', { ...opt, linkTo: 'projects' }),
  f('crew', 'userId', 'crew.userId', 'user_id', 'any', 'Workspace membership', 'Without it the platform cannot find the adding member’s seat (the field holds the workspace membership id of the person the seat is).', opt),
  // The optional questions part (interface 1.1, CREW-3588). The shapes are the
  // ones the platform's Record choices requirement asks of its questions and
  // answers tables; `questionsPartMapped` says when a mapping carries enough of
  // them for crew to write a question. Each role is optional here because the
  // whole part is: an app that maps none of it still conforms.
  f('questions', 'parent', 'questions.parent', 'ticket_id', 'link', 'Question ticket', 'Without it a question cannot be tied to the ticket it is about, so crew writes none.', { ...opt, linkTo: 'issues' }),
  f('questions', 'text', 'questions.text', 'question', 'text', 'Question text', 'Without it a question has no words.', opt),
  f('questions', 'status', 'questions.status', 'status', 'choice', 'Question status', 'Without it crew cannot tell an open question from an answered or withdrawn one.', opt),
  f('questions', 'askedBy', 'questions.askedBy', 'asked_by_id', 'link', 'Asked by', 'Without it a question does not say which seat asked it, so crew cannot withdraw its own earlier question.', opt),
  f('questions', 'addressedTo', 'questions.addressedTo', 'addressed_to_id', 'link', 'Addressed to', 'Without it a question does not say who it is waiting on.', opt),
  f('questions', 'answeredBy', 'questions.answeredBy', 'answered_by_id', 'link', 'Answered by', 'Without it an answered question does not say who answered.', opt),
  f('questions', 'chosenAnswer', 'questions.chosenAnswer', 'chosen_answer_id', 'link', 'Chosen answer', 'Without it an answered question does not say which answer was chosen.', { ...opt, linkTo: 'answers' }),
  f('answers', 'question', 'answers.question', 'question_id', 'link', 'Answer question', 'Without it an answer cannot be tied to its question, so crew offers none.', { ...opt, linkTo: 'questions' }),
  f('answers', 'label', 'answers.label', 'label', 'text', 'Answer label', 'Without it an answer has no short label to show on a button.', opt),
  f('answers', 'detail', 'answers.detail', 'detail', 'text', 'Answer detail', 'Without it an answer has no full instruction to act on when chosen.', opt),
  f('answers', 'order', 'answers.order', 'position', 'number', 'Answer order', 'Without it the answers show in the order they were created, not the order the seat intended.', opt),
  f('epics', 'status', 'epics.statusColumn', 'status', 'choice', 'Epic status', 'Without it crew cannot keep an epic’s status from its tickets.', opt),
  f('epics', 'key', 'epics.keyColumn', 'epic_id', 'any', 'Epic key', 'Without it an epic has no name in the log.', { ...opt, ...readOnly }),
  f('maps', 'epic', 'maps.epicColumn', 'epic_id', 'link', 'Map epic', 'Without it a Map cannot be matched to its epic.', opt),
  f('maps', 'title', 'maps.titleColumn', 'title', 'text', 'Map title', 'Without it a Map has no name in a brief.', opt),
  f('maps', 'content', 'maps.contentColumn', 'content', 'text', 'Map content', 'Without it a brief cannot carry the Map.', opt),
  f('maps', 'conversation', 'maps.conversationColumn', 'conversation', 'text', 'Map conversation', 'Without it the interview record cannot be pointed at.', opt),
  f('maps', 'status', 'maps.statusColumn', 'status', 'choice', 'Map status', 'Without it the active Map cannot be told from a draft.', opt),
  f('maps', 'version', 'maps.versionColumn', 'version', 'any', 'Map version', 'Without it a brief cannot name the Map’s version.', { ...opt, ...readOnly }),
];

export interface StatusMeaning {
  /** Value id in the mapping and the matching `statuses.<id>` contract key (where there is one). */
  id: string;
  label: string;
  defaultValue: string;
  /** `statuses.<contractKey>`; absent for a value that only counts toward `open`/`resolved`. */
  contractKey?: string;
  open: boolean;
  resolved: boolean;
  optional?: boolean;
  /**
   * Counts only where the app maps it: `defaultValue` is the value to map, not
   * a value assumed for an undeclared or earlier-version app, so such an app
   * behaves exactly as it did before the meaning existed.
   */
  mappedOnly?: boolean;
  meaning: string;
}

/**
 * What each status MEANS. Which values are open and which are resolved is part
 * of the interface, not of the app: `fixed` being open but not resolved is
 * load-bearing, since a ticket blocked by unmerged work is still blocked.
 */
export const STATUS_MEANINGS: readonly StatusMeaning[] = [
  { id: 'new', label: 'New', defaultValue: 'new', open: true, resolved: false, meaning: 'Filed, not yet approved by a person.' },
  { id: 'approved', label: 'Approved', defaultValue: 'accepted', contractKey: 'approved', open: true, resolved: false, meaning: 'A person authorized the work. Only a person sets it.' },
  { id: 'parked', label: 'Parked', defaultValue: 'blocked', contractKey: 'parked', open: true, resolved: false, meaning: 'Approved but waiting on an unresolved dependency; crew parks and restores it.' },
  { id: 'building', label: 'Building', defaultValue: 'in_progress', contractKey: 'building', open: true, resolved: false, meaning: 'A seat is working it.' },
  { id: 'needsHuman', label: 'Needs a person', defaultValue: 'needs_info', contractKey: 'needsHuman', open: true, resolved: false, meaning: 'A person owes an answer.' },
  { id: 'handoff', label: 'Handed off', defaultValue: 'fixed', contractKey: 'handoff', open: true, resolved: false, meaning: 'Built, not yet checked. Open and not resolved.' },
  { id: 'verifying', label: 'Verifying', defaultValue: 'qa', contractKey: 'verifying', open: true, resolved: false, meaning: 'Being checked.' },
  { id: 'verified', label: 'Verified', defaultValue: 'verified', contractKey: 'verified', open: true, resolved: true, meaning: 'Checked and awaiting release. Resolves a blocker but is not closed.' },
  { id: 'reviewing', label: 'Under review', defaultValue: '', contractKey: 'reviewing', open: true, resolved: false, optional: true, meaning: 'A pull request is open for human review. Only an app with a review step has it.' },
  { id: 'deployed', label: 'Deployed', defaultValue: 'closed_deployed', contractKey: 'deployed', open: false, resolved: true, meaning: 'Released; set by the release phase alone.' },
  { id: 'wontFix', label: 'Won’t fix', defaultValue: 'closed_wont_fix', contractKey: 'wontFix', open: false, resolved: true, meaning: 'Called off without merging.' },
  { id: 'duplicate', label: 'Duplicate', defaultValue: 'closed_duplicate', open: false, resolved: true, meaning: 'Closed in favor of another ticket.' },
  { id: 'completed', label: 'Completed', defaultValue: 'closed_completed', open: false, resolved: true, meaning: 'Done with nothing to deploy.' },
  { id: 'obsolete', label: 'Obsolete', defaultValue: 'closed_obsolete', open: false, resolved: true, optional: true, mappedOnly: true, meaning: 'Overtaken or no longer wanted, closed without being built. Releases a dependent exactly as Won’t fix does (interface 1.4).' },
  { id: 'cantReproduce', label: 'Can’t reproduce', defaultValue: 'closed_cant_reproduce', open: false, resolved: true, meaning: 'Closed as written, unreproducible.' },
  { id: 'draft', label: 'Draft', defaultValue: 'draft', contractKey: 'draft', open: false, resolved: false, optional: true, meaning: 'Held back; never polled.' },
];

/** What each question status MEANS (interface 1.1). Only `open` is waiting on anyone. */
export const QUESTION_STATUS_MEANINGS: readonly { id: string; label: string; defaultValue: string; meaning: string }[] = [
  { id: 'open', label: 'Open', defaultValue: 'open', meaning: 'Waiting for a person to answer.' },
  { id: 'answered', label: 'Answered', defaultValue: 'answered', meaning: 'A person chose an answer or replied in writing.' },
  { id: 'withdrawn', label: 'Withdrawn', defaultValue: 'withdrawn', meaning: 'The asker took it back, usually because it asked again on the same ticket.' },
];

/** The version this crew publishes; `ACCEPTED_INTERFACE_VERSIONS` is what it reads. */
export const PUBLISHED_INTERFACE_VERSION: InterfaceVersion = { major: 1, minor: 4 };

/** The definition as the platform stores it. */
export function trackerInterfaceDefinition(): InterfaceDefinition {
  const roles: InterfaceRole[] = [
    ...TABLE_ENTRIES.map((t): TableRole => ({
      id: t.role, type: 'table', label: t.label, whatBreaks: t.whatBreaks, ...(t.optional ? { optional: true } : {}),
    })),
    ...FIELD_ENTRIES.map((e): FieldRole => ({
      id: e.role, type: 'field', tableRole: e.table, fieldKind: e.kind, label: e.label, whatBreaks: e.whatBreaks,
      ...(e.optional ? { optional: true } : {}),
      ...(e.multiple !== undefined ? { multiple: e.multiple } : {}),
      ...(e.computed !== undefined ? { computed: e.computed } : {}),
      ...(e.builtin ? { builtinColumns: e.builtin } : {}),
      ...(e.linkTo ? { linkTarget: { tableRole: e.linkTo } } : {}),
    })),
  ];
  return {
    name: TRACKER_INTERFACE_NAME,
    owner: 'crew',
    version: PUBLISHED_INTERFACE_VERSION,
    roles,
    valueSets: [
      {
        id: 'status', label: 'Ticket statuses', fieldRole: 'issues.status',
        values: STATUS_MEANINGS.map((s) => ({ id: s.id, label: s.label, ...(s.optional ? { optional: true } : {}) })),
      },
      {
        id: 'questionStatus', label: 'Question statuses', fieldRole: 'questions.status',
        values: QUESTION_STATUS_MEANINGS.map((s) => ({ id: s.id, label: s.label })),
      },
    ],
  };
}

/** The default column of every field role, keyed by contract path (`columns.status`). */
export function defaultsByContractPath(): Record<string, string> {
  return Object.fromEntries(FIELD_ENTRIES.map((e) => [e.contractPath, e.defaultColumn]));
}

/** The default column group (`columns`, `comments`, `epics`, `maps`) as a plain object. */
export function defaultGroup<T extends object = Record<string, string>>(group: string): T {
  const out: Record<string, string> = {};
  for (const e of FIELD_ENTRIES) {
    const [g, key] = e.contractPath.split('.') as [string, string];
    if (g === group) out[key] = e.defaultColumn;
  }
  // Safe: every key of the caller's column group has a field entry, which test/tracker-interface.test.ts pins.
  return out as T;
}

export function defaultQuestionStatuses(): { open: string; answered: string; withdrawn: string } {
  const v = (id: string): string => QUESTION_STATUS_MEANINGS.find((q) => q.id === id)!.defaultValue;
  return { open: v('open'), answered: v('answered'), withdrawn: v('withdrawn') };
}

export function defaultStatusValues(): { open: string[]; resolved: string[]; single: Record<string, string | null> } {
  const open = STATUS_MEANINGS.filter((s) => s.open && s.defaultValue && !s.mappedOnly).map((s) => s.defaultValue);
  const resolved = STATUS_MEANINGS.filter((s) => s.resolved && s.defaultValue && !s.mappedOnly).map((s) => s.defaultValue);
  const single: Record<string, string | null> = {};
  for (const s of STATUS_MEANINGS) if (s.contractKey && !s.mappedOnly) single[s.contractKey] = s.defaultValue || null;
  return { open, resolved, single };
}

// ---- version handling ----------------------------------------------------

export function versionLabel(v: InterfaceVersion): string { return `${v.major}.${v.minor}`; }

export function acceptedLabel(): string {
  return `${ACCEPTED_INTERFACE_VERSIONS.major}.${ACCEPTED_INTERFACE_VERSIONS.minMinor} or a later ${ACCEPTED_INTERFACE_VERSIONS.major}.x`;
}

export function versionAccepted(v: InterfaceVersion): boolean {
  return v.major === ACCEPTED_INTERFACE_VERSIONS.major && v.minor >= ACCEPTED_INTERFACE_VERSIONS.minMinor;
}

/** Which side has to change when the app's declared version is not accepted. */
export function sideToUpdate(v: InterfaceVersion): 'crew' | 'app' {
  return v.major > ACCEPTED_INTERFACE_VERSIONS.major ? 'crew' : 'app';
}

// ---- the contract an app's mapping implies ------------------------------

import type { Contract } from './contract.ts';

/**
 * The contract a declared app implies: `base` (the built-in defaults) with the
 * mapped column of each field role and the mapped choice value of each status
 * meaning laid over it. A role the mapping leaves out keeps its default.
 */
export function contractFromMapping(base: Contract, mapping: InterfaceMapping): Contract {
  const next = structuredClone(base);
  const groups: Record<string, object> = {
    columns: next.columns, comments: next.comments, epics: next.epics, maps: next.maps,
    questions: next.questions, answers: next.answers, repos: next.repos, crew: next.crew,
  };
  for (const e of FIELD_ENTRIES) {
    const col = mapping.fields[e.role];
    const [group, key] = e.contractPath.split('.') as [string, string];
    // A questions-part column the mapping leaves out is blank, not the default
    // name: the default would be written to a column the app does not have.
    if (!col) {
      if (group === 'questions' || group === 'answers') Object.assign(groups[group]!, { [key]: '' });
      continue;
    }
    Object.assign(groups[group]!, { [key]: col });
  }
  const mapped = mapping.values?.['status'] ?? {};
  const open: string[] = [];
  const resolved: string[] = [];
  for (const s of STATUS_MEANINGS) {
    // An optional meaning the app did not map is absent (review) or stays default (draft).
    const v = mapped[s.id] ?? (s.mappedOnly ? null : s.defaultValue || null);
    if (s.contractKey) Object.assign(next.statuses, { [s.contractKey]: v });
    if (!v) continue;
    if (s.open && !open.includes(v)) open.push(v);
    if (s.resolved && !resolved.includes(v)) resolved.push(v);
  }
  next.statuses.open = open;
  next.statuses.resolved = resolved;
  const questionValues = mapping.values?.['questionStatus'] ?? {};
  for (const q of QUESTION_STATUS_MEANINGS) {
    Object.assign(next.questionStatuses, { [q.id]: questionValues[q.id] ?? q.defaultValue });
  }
  return next;
}

/** The table name the mapping gives each table role (declared apps are never searched by default name). */
export function mappedTableName(mapping: InterfaceMapping, role: string): string | undefined {
  return mapping.tables?.[role];
}

/**
 * Whether a mapping carries what crew needs to write a question: both tables
 * and the fields that tie a question to its ticket and its asker (so a seat can
 * withdraw only its own) and an answer to its question. The rest (addressed to, order, ...) are written when
 * mapped and left out when not. An undeclared app never maps any of it.
 */
export const QUESTIONS_PART_ROLES = [
  'questions.parent', 'questions.text', 'questions.status', 'questions.askedBy', 'answers.question', 'answers.label', 'answers.detail',
] as const;

export function questionsPartMapped(mapping: InterfaceMapping): boolean {
  return !!mapping.tables?.['questions'] && !!mapping.tables?.['answers'] && QUESTIONS_PART_ROLES.every((r) => !!mapping.fields?.[r]);
}

// ---- reading conformance -------------------------------------------------

export interface UnmetRoleLike { roleId: string; label?: string; reason?: string; message: string; whatBreaks?: string }

/** The shape a role asks for, in plain words. */
export function describeShape(roleId: string): string {
  const t = TABLE_ENTRIES.find((x) => x.role === roleId);
  if (t) return 'a table';
  const e = FIELD_ENTRIES.find((x) => x.role === roleId);
  if (!e) return 'unknown role';
  const several = e.multiple === 'either' ? ' (one or several)' : '';
  const base = e.kind === 'any' ? 'any column' : e.kind === 'link' || e.kind === 'file' ? `a ${e.kind}${several} field` : `a ${e.kind} field`;
  const kind = e.computed === 'either' ? `${base}, plain or computed` : base;
  return `${kind} on the ${e.table} table${e.optional ? ' (optional)' : ''}`;
}

/** One line per difference: role, expected shape, what was found. */
export function describeDifferences(unmet: readonly UnmetRoleLike[]): string[] {
  return unmet.map((u) => `role ${u.roleId} — expected ${describeShape(u.roleId)}; found: ${u.message}`);
}

// ---- the reference page --------------------------------------------------

/** The page `docs/WORK_TRACKER.md` carries, generated from the definition; a test fails when the file differs. */
export function renderReferencePage(): string {
  const def = trackerInterfaceDefinition();
  const lines: string[] = [];
  lines.push('# Work tracker reference');
  lines.push('');
  lines.push('<!-- Generated from src/tracker-interface.ts by `node --experimental-strip-types scripts/gen-tracker-reference.ts`. Do not edit by hand. -->');
  lines.push('');
  lines.push(`Interface \`${def.name}\`, owner \`${def.owner}\`, version ${versionLabel(def.version)}. This crew reads versions ${acceptedLabel()}.`);
  lines.push('');
  lines.push('An app that implements this interface declares a mapping from each role below to its own table, field or status value, and crew reads the app through that mapping. A table or column keeps working under any name as long as the mapping says so. An app that declares nothing is read from the defaults in the last column, found by table display name, and crew raises a non-blocking attention item asking the operator to update the app’s template.');
  lines.push('');
  lines.push('## Tables');
  lines.push('');
  lines.push('| Role | Default name | Required | What goes wrong without it |');
  lines.push('| --- | --- | --- | --- |');
  for (const t of TABLE_ENTRIES) lines.push(`| \`${t.role}\` | ${t.defaultName} | ${t.optional ? 'no' : 'yes'} | ${t.whatBreaks} |`);
  lines.push('');
  for (const table of TABLE_ENTRIES) {
    const rows = FIELD_ENTRIES.filter((e) => e.table === table.role);
    if (rows.length === 0) continue;
    lines.push(`## ${table.defaultName} fields`);
    lines.push('');
    lines.push('| Role | Default column | Shape | Required | What goes wrong without it |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const e of rows) {
      lines.push(`| \`${e.role}\` | \`${e.defaultColumn}\` | ${describeShape(e.role).replace(/ on the \w+ table.*/, '')} | ${e.optional ? 'no' : 'yes'} | ${e.whatBreaks} |`);
    }
    lines.push('');
  }
  lines.push('## Changes in version 1.4');
  lines.push('');
  lines.push('Adds the optional status meaning `obsolete` (default value `closed_obsolete`): closed, resolved, for a ticket overtaken or no longer wanted. It releases a dependent exactly as `wontFix` does. It counts only in an app that maps it; an app declared at an earlier 1.x, or one that leaves it unmapped, behaves as before.');
  lines.push('');
  lines.push('## Changes in version 1.3');
  lines.push('');
  lines.push('The roles crew only reads accept a computed field as well as a plain one: `issues.key`, `issues.tag`, `epics.key` and `maps.version`, which an app generates. `issues.attachments` asks for a file field (one or several) rather than a link field, because crew reads file references from it. Every role not named here is unchanged, and a role crew writes still asks for a plain field. An app declared at an earlier 1.x still conforms to that version and is read by this crew.');
  lines.push('');
  lines.push('## Roles the platform reads (version 1.2)');
  lines.push('');
  lines.push('Optional. The platform\u2019s scheduler, project setup checklist and repository pages read `issues.description`, `issues.needsPlanning`, the `repos.*` roles and `crew.userId`. An app that maps none of them, including every app at version 1.0 or 1.1, still conforms; the platform then reports the function that needs a missing role as not ready, naming the role.');
  lines.push('');
  lines.push('## The questions part (version 1.1)');
  lines.push('');
  lines.push('Optional. When the app maps the Questions and Answers tables and the roles below, a seat that parks a ticket for a person\u2019s answer also writes the question as a record: one open question linked to the ticket, with two to four ordered answers (recommended first) when the choices are genuinely discrete, none when the answer is free-form. The comment is posted either way and still leads with the question. An app that maps none of it, including every app at version 1.0, still conforms and gets the comment alone. The shapes are the ones the platform\u2019s Record choices component asks of its questions and answers tables. Crew writes the part only when the mapping carries ' + QUESTIONS_PART_ROLES.map((r) => `\`${r}\``).join(', ') + '; the other roles are written when mapped.');
  lines.push('');
  lines.push('| Value id | Default value | Meaning |');
  lines.push('| --- | --- | --- |');
  for (const q of QUESTION_STATUS_MEANINGS) lines.push(`| \`${q.id}\` | \`${q.defaultValue}\` | ${q.meaning} |`);
  lines.push('');
  lines.push('## Status meanings');
  lines.push('');
  lines.push('Which statuses are open and which are resolved belongs to the interface, not to the app. A blocker stops counting only at a resolved status; `Handed off` is open and not resolved, because a ticket blocked by unmerged work is still blocked.');
  lines.push('');
  lines.push('| Value id | Default value | Open | Resolved | Required | Meaning |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const s of STATUS_MEANINGS) {
    lines.push(`| \`${s.id}\` | ${s.defaultValue ? `\`${s.defaultValue}\`` : '(none)'} | ${s.open ? 'yes' : 'no'} | ${s.resolved ? 'yes' : 'no'} | ${s.optional ? 'no' : 'yes'} | ${s.meaning} |`);
  }
  lines.push('');
  return lines.join('\n');
}
