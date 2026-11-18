import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/connect.ts';
import { DEFAULT_CONTRACT, type Contract } from '../src/contract.ts';
import { askQuestion, validateAsk, type AskRequest, type QuestionStore, type QuestionsPart } from '../src/questions.ts';
import { FIELD_ENTRIES, QUESTIONS_PART_ROLES, contractFromMapping, questionsPartMapped, trackerInterfaceDefinition, type InterfaceMapping } from '../src/tracker-interface.ts';

const BASE = { baseUrl: 'https://example.test', apiKey: 'k', userAgent: 'crew-test' };
const PART: QuestionsPart = { questionsModelId: 'm-q', answersModelId: 'm-a' };

/** A mapping with the whole questions part, every column renamed. */
function mappingWithQuestions(omit: string[] = []): InterfaceMapping {
  const fields: Record<string, string> = {};
  for (const e of FIELD_ENTRIES) if (!e.optional || e.table === 'questions' || e.table === 'answers') fields[e.role] = `x_${e.defaultColumn}`;
  for (const r of omit) delete fields[r];
  return { tables: { issues: 'Tickets', comments: 'Notes', crew: 'People', questions: 'Asks', answers: 'Options' }, fields, values: { questionStatus: { open: 'waiting' } } };
}

interface Row { model: string; id: string; fields: Record<string, unknown> }
/** An in-memory store: the same writes the tracker would make, recorded. */
function memoryStore(contract: Contract): QuestionStore & { rows: Row[] } {
  const rows: Row[] = [];
  let n = 0;
  return {
    rows,
    async listOpenQuestions(part, ticketId, askedBy) {
      const q = contract.questions;
      return rows.filter((r) => r.model === part.questionsModelId && r.fields[q.parent] === ticketId
        && r.fields[q.status] === contract.questionStatuses.open && r.fields[q.askedBy] === askedBy);
    },
    async updateRecord(model, id, fields) { Object.assign(rows.find((r) => r.model === model && r.id === id)!.fields, fields); },
    async createRecord(model, fields) { const row = { model, id: `r${++n}`, fields }; rows.push(row); return row; },
  };
}

const request = (over: Partial<AskRequest> = {}): AskRequest => ({
  ticketId: 't1', question: 'Ship it as one change or two?', askedBy: 'seat-dev', addressedTo: 'brad',
  answers: [
    { label: 'One change', detail: 'Do it all in this branch.' },
    { label: 'Two changes', detail: 'Split the migration into its own ticket.' },
  ],
  ...over,
});

test('an app mapping the part: one open question with ordered answers, addressed to the person', async () => {
  const contract = contractFromMapping(DEFAULT_CONTRACT, mappingWithQuestions());
  const store = memoryStore(contract);
  const done = await askQuestion(store, PART, contract, request());
  const [question, ...answers] = store.rows;
  assert.equal(done.questionId, question!.id);
  assert.deepEqual(question!.fields, {
    x_ticket_id: 't1', x_question: 'Ship it as one change or two?', x_status: 'waiting',
    x_asked_by_id: 'seat-dev', x_addressed_to_id: 'brad',
  });
  assert.deepEqual(answers.map((a) => [a.fields['x_label'], a.fields['x_position'], a.fields['x_question_id']]), [
    ['One change', 1, question!.id], ['Two changes', 2, question!.id],
  ]);
});

test('parking again withdraws the seat\'s earlier open question, and only the seat\'s own', async () => {
  const contract = contractFromMapping(DEFAULT_CONTRACT, mappingWithQuestions());
  const store = memoryStore(contract);
  const first = await askQuestion(store, PART, contract, request());
  // a person's own open question on the same ticket is left alone
  const theirs = await store.createRecord(PART.questionsModelId, { x_ticket_id: 't1', x_status: 'waiting', x_asked_by_id: 'brad' });
  const second = await askQuestion(store, PART, contract, request({ question: 'Which branch?' }));
  assert.deepEqual(second.withdrawn, [first.questionId]);
  const status = (id: string) => store.rows.find((r) => r.id === id)!.fields['x_status'];
  assert.equal(status(first.questionId), 'withdrawn');
  assert.equal(status(theirs.id), 'waiting');
  assert.equal(status(second.questionId), 'waiting');
});

test('a free-form question is created with no answers', async () => {
  const contract = contractFromMapping(DEFAULT_CONTRACT, mappingWithQuestions());
  const store = memoryStore(contract);
  const done = await askQuestion(store, PART, contract, request({ answers: [] }));
  assert.deepEqual(done.answerIds, []);
  assert.equal(store.rows.length, 1);
  assert.deepEqual(validateAsk(request({ answers: [] })), []);
});

test('columns the app leaves unmapped are never written', async () => {
  const contract = contractFromMapping(DEFAULT_CONTRACT, mappingWithQuestions(['questions.addressedTo', 'answers.order']));
  const store = memoryStore(contract);
  await askQuestion(store, PART, contract, request());
  assert.equal(Object.keys(store.rows[0]!.fields).includes('addressed_to_id'), false);
  assert.equal(Object.keys(store.rows[0]!.fields).length, 4);
  assert.deepEqual(Object.keys(store.rows[1]!.fields).sort(), ['x_detail', 'x_label', 'x_question_id']);
});

test('an answer that cannot be written withdraws the new question again', async () => {
  const contract = contractFromMapping(DEFAULT_CONTRACT, mappingWithQuestions());
  const store = memoryStore(contract);
  const create = store.createRecord.bind(store);
  store.createRecord = async (model, fields) => {
    if (model === PART.answersModelId) throw new Error('boom');
    return create(model, fields);
  };
  await assert.rejects(askQuestion(store, PART, contract, request()), /boom/);
  assert.equal(store.rows[0]!.fields['x_status'], 'withdrawn');
});

test('a request is checked before anything is written', () => {
  assert.match(validateAsk(request({ question: ' ' })).join(), /question is empty/);
  assert.match(validateAsk(request({ answers: [{ label: 'A', detail: 'a' }] })).join(), /one proposed answer is not a choice/);
  const five = Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, detail: `d${i}` }));
  assert.match(validateAsk(request({ answers: five })).join(), /too many/);
  assert.match(validateAsk(request({ answers: [{ label: 'A', detail: '' }, { label: 'B', detail: 'b' }] })).join(), /answer 1 has no detail/);
});

test('the part counts as mapped only with every role crew needs to write it', () => {
  assert.equal(questionsPartMapped(mappingWithQuestions()), true);
  for (const role of QUESTIONS_PART_ROLES) assert.equal(questionsPartMapped(mappingWithQuestions([role])), false, role);
  assert.equal(questionsPartMapped({ tables: {}, fields: {}, values: {} }), false);
});

test('the published definition carries the part as optional roles, with the platform link and choice shapes', () => {
  const def = trackerInterfaceDefinition();
  const role = (id: string) => def.roles.find((r) => r.id === id)!;
  assert.equal(role('questions').type, 'table');
  assert.equal(role('questions').optional, true);
  assert.deepEqual((role('answers.question') as { linkTarget?: unknown }).linkTarget, { tableRole: 'questions' });
  assert.deepEqual((role('questions.parent') as { linkTarget?: unknown }).linkTarget, { tableRole: 'issues' });
  assert.ok(FIELD_ENTRIES.filter((e) => e.table === 'questions' || e.table === 'answers').every((e) => e.optional));
  assert.deepEqual(def.valueSets?.find((v) => v.id === 'questionStatus')?.values.map((v) => v.id), ['open', 'answered', 'withdrawn']);
});

// ---- connect ---------------------------------------------------------------

const IMPL = '/api/app-interfaces/implementers?workspaceId=ws-1&name=work-tracker';
function routes(version: { major: number; minor: number }, mapping: InterfaceMapping, models: { id: string; name: string }[]) {
  return {
    '/api/workspaces/app': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/tracker?workspaceId=ws-1': { id: 'proj-1', name: 'Tracker' },
    '/api/data-models?projectId=proj-1': models,
    '/api/data-models/m-people/records?limit=200': [],
    [IMPL]: [{ project: { id: 'proj-1' }, interfaceName: 'work-tracker', version, mapping }],
    '/api/projects/proj-1/interfaces': [{ name: 'work-tracker', conforms: true, unmet: [] }],
  } as Record<string, unknown>;
}
function mockFetch(table: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${url.pathname}${url.search}`;
    return key in table ? new Response(JSON.stringify(table[key]), { status: 200 }) : new Response('{"message":"not found"}', { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
const CORE = [{ id: 'm-tickets', name: 'Tickets' }, { id: 'm-notes', name: 'Notes' }, { id: 'm-people', name: 'People' }];

test('connect resolves the questions tables from the mapping, by role', async (t) => {
  t.after(mockFetch(routes({ major: 1, minor: 1 }, mappingWithQuestions(), [...CORE, { id: 'm-q', name: 'Asks' }, { id: 'm-a', name: 'Options' }])));
  const found = await discover({ ...BASE, workspace: 'app', project: 'tracker' });
  assert.equal(found.questionsModelId, 'm-q');
  assert.equal(found.answersModelId, 'm-a');
  assert.equal(found.declaredContract?.questionStatuses.open, 'waiting');
});

test('an app at 1.0 maps no part: nothing resolved, nothing written, and it still conforms', async (t) => {
  const mapping = mappingWithQuestions();
  const v10: InterfaceMapping = { tables: { issues: 'Tickets', comments: 'Notes', crew: 'People' }, fields: Object.fromEntries(Object.entries(mapping.fields).filter(([k]) => !k.startsWith('questions.') && !k.startsWith('answers.'))), values: {} };
  t.after(mockFetch(routes({ major: 1, minor: 0 }, v10, CORE)));
  const found = await discover({ ...BASE, workspace: 'app', project: 'tracker' });
  assert.equal(found.questionsModelId, undefined);
  assert.equal(found.answersModelId, undefined);
  assert.equal(found.problems.some((p) => /conform/.test(p)), false);
  assert.equal(found.interface?.kind === 'declared' && found.interface.conforms, true);
});

test('an undeclared app never resolves a table that is merely named Questions', async (t) => {
  t.after(mockFetch({
    '/api/workspaces/app': { id: 'ws-1' },
    '/api/auth/me?workspaceId=ws-1': { role: 'WORKSPACE_ADMIN' },
    '/api/projects/tracker?workspaceId=ws-1': { id: 'proj-1', name: 'Tracker' },
    '/api/data-models?projectId=proj-1': [{ id: 'i', name: 'Issues' }, { id: 'c', name: 'Comments' }, { id: 'p', name: 'Crew' }, { id: 'q', name: 'Questions' }, { id: 'a', name: 'Answers' }],
    '/api/data-models/p/records?limit=200': [],
  }));
  const found = await discover({ ...BASE, workspace: 'app', project: 'tracker' });
  assert.equal(found.questionsModelId, undefined);
  assert.equal(found.answersModelId, undefined);
});
