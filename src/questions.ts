/**
 * A seat's question as a record with proposed answers (EPIC-093 Map v1 §13,
 * CREW-3588).
 *
 * When a seat parks a ticket for a person's answer and the connected app maps
 * the work tracker interface's questions part (1.1), the seat calls
 * `crew ask`, which runs `askQuestion` here before the seat posts its usual
 * comment: it withdraws the seat's own earlier open question on the ticket,
 * creates one question addressed to the same person as the park, and creates
 * the proposed answers, the recommended one first.
 *
 * The seat never reads the question back. A chosen answer arrives as a
 * comment from the person, which the seat already treats as direction; this
 * module only writes. Nothing here is reached for an app that does not map the
 * part (every app at interface 1.0 included): `questionsPart` is null there
 * and the helper reports "nothing to do" without writing.
 *
 * Free-form questions: a question whose answer is not one of a few discrete
 * choices is created with NO answers. The Record choices component draws a
 * question with no answers as an open question with no buttons, so the person
 * still sees what is being asked and who it waits on, and replies in writing.
 */

import type { Contract } from './contract.ts';

export const MIN_ANSWERS = 2;
export const MAX_ANSWERS = 4;

export interface ProposedAnswer { label: string; detail: string }

export interface AskRequest {
  ticketId: string;
  /** Plain language, one or two sentences. */
  question: string;
  /** Recommended first. Empty for a question that needs a free-form answer. */
  answers: ProposedAnswer[];
  /** The asking seat's Crew row. */
  askedBy: string;
  /** The Crew row the park is addressed to; absent when the park names nobody. */
  addressedTo?: string;
}

/** The tables of the part, as the route resolved them. */
export interface QuestionsPart { questionsModelId: string; answersModelId: string }

/** The store half of the write, so it is tested without a tracker. */
export interface QuestionStore {
  listOpenQuestions(part: QuestionsPart, ticketId: string, askedBy: string): Promise<{ id: string }[]>;
  updateRecord(modelId: string, id: string, fields: Record<string, unknown>): Promise<void>;
  createRecord(modelId: string, fields: Record<string, unknown>): Promise<{ id: string }>;
}

/** Problems with a request that no tracker could fix; empty when it can be written. */
export function validateAsk(req: AskRequest): string[] {
  const problems: string[] = [];
  if (!req.question.trim()) problems.push('the question is empty');
  const n = req.answers.length;
  if (n === 1) problems.push(`one proposed answer is not a choice — give ${MIN_ANSWERS} to ${MAX_ANSWERS}, or none for a question that needs a free-form answer`);
  if (n > MAX_ANSWERS) problems.push(`${n} proposed answers is too many — give ${MIN_ANSWERS} to ${MAX_ANSWERS}`);
  req.answers.forEach((a, i) => {
    if (!a.label.trim()) problems.push(`answer ${i + 1} has no label`);
    if (!a.detail.trim()) problems.push(`answer ${i + 1} has no detail`);
  });
  return problems;
}

export interface AskResult {
  withdrawn: string[];
  questionId: string;
  answerIds: string[];
}

/** Only the columns the app maps: a blank column name (an unmapped optional role) and an absent value are left out. */
function columns(pairs: [string, unknown][]): Record<string, unknown> {
  return Object.fromEntries(pairs.filter(([name, value]) => name && value !== undefined));
}

/**
 * Withdraw the seat's own open questions on the ticket, create the question,
 * then its answers. If an answer cannot be written the new question is
 * withdrawn again, so a half-written question never sits open with buttons
 * missing; the caller still posts its comment, which carries the question.
 */
export async function askQuestion(store: QuestionStore, part: QuestionsPart, contract: Contract, req: AskRequest): Promise<AskResult> {
  const q = contract.questions;
  const a = contract.answers;
  const st = contract.questionStatuses;

  const earlier = await store.listOpenQuestions(part, req.ticketId, req.askedBy);
  for (const old of earlier) await store.updateRecord(part.questionsModelId, old.id, { [q.status]: st.withdrawn });

  const made = await store.createRecord(part.questionsModelId, columns([
    [q.parent, req.ticketId],
    [q.text, req.question.trim()],
    [q.status, st.open],
    [q.askedBy, req.askedBy],
    [q.addressedTo, req.addressedTo],
  ]));

  const answerIds: string[] = [];
  try {
    for (const [i, ans] of req.answers.entries()) {
      const row = await store.createRecord(part.answersModelId, columns([
        [a.question, made.id], [a.label, ans.label.trim()], [a.detail, ans.detail.trim()], [a.order, i + 1],
      ]));
      answerIds.push(row.id);
    }
  } catch (e) {
    try { await store.updateRecord(part.questionsModelId, made.id, { [q.status]: st.withdrawn }); } catch { /* the original failure is the one to report */ }
    throw e;
  }
  return { withdrawn: earlier.map((e) => e.id), questionId: made.id, answerIds };
}
