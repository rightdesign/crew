/**
 * A tracker, in-process, over real HTTP.
 *
 * The unit tests all stop at a function boundary — they proved `planSweep`
 * computed the right answer, and never noticed that nothing applied it. Four
 * ported units were complete, tested and unwired for exactly that reason.
 *
 * So this speaks the same protocol the real tracker does, and the crew reaches
 * it through @tablation/client over a socket. What it records is what the crew
 * actually SENT — not what a mock was asked to pretend.
 */

import { createServer, type Server } from 'node:http';

export interface Row { id: string; [k: string]: unknown }

export interface Write { method: 'POST' | 'PATCH'; model: string; id?: string; body: Record<string, unknown> }

export class FakeTracker {
  private server?: Server;
  readonly tables = new Map<string, Row[]>();
  /** Every write the crew made, in order. */
  readonly writes: Write[] = [];
  port = 0;
  /**
   * Fired once, right after the NEXT `GET .../records` for `model` is
   * answered — for simulating a race (ISSUE-395): another ship's write
   * lands on a row between this ship's read of it and its own write.
   */
  private raceHooks = new Map<string, () => void>();
  raceOnNextList(model: string, fn: () => void): void {
    this.raceHooks.set(model, fn);
  }

  table(id: string, rows: Row[]): this {
    this.tables.set(id, rows.map((r) => ({ ...r })));
    return this;
  }

  row(model: string, id: string): Row | undefined {
    return this.tables.get(model)?.find((r) => r.id === id);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const parts = url.pathname.split('/').filter(Boolean); // api data-models <id> records [rid]
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (parts[1] !== 'data-models') return send(404, { message: 'not found' });
      const model = parts[2] ?? '';
      const rows = this.tables.get(model);
      if (!rows) return send(404, { message: `no such model ${model}` });

      if (req.method === 'GET' && parts[3] === 'records') {
        // Only the operators the crew actually uses.
        const raw = url.searchParams.get('filters');
        let out = rows;
        if (raw) {
          for (const f of JSON.parse(raw) as Array<{ columnName: string; operator: string; value: unknown }>) {
            out = out.filter((r) => {
              const v = r[f.columnName];
              if (f.operator === 'IN') return (f.value as unknown[]).includes(v);
              if (f.operator === 'EQ') return v === f.value;
              return true;
            });
          }
        }
        send(200, out);
        const hook = this.raceHooks.get(model);
        if (hook) { this.raceHooks.delete(model); hook(); }
        return;
      }

      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        if (req.method === 'PATCH' && parts[4]) {
          const row = rows.find((r) => r.id === parts[4]);
          if (!row) return send(404, { message: 'no such record' });
          // Conditional write (ISSUE-395, ISSUE-394's same primitive):
          // `RecordsResource.update`'s expectedUpdatedAt arrives as this
          // header, and a mismatch is a 409 — which @tablation/client
          // itself turns into `StaleWriteError` for the caller.
          const expected = req.headers['x-expected-updated-at'];
          if (expected !== undefined && expected !== row.updated_at) {
            return send(409, { message: 'stale write', conflict: true });
          }
          this.writes.push({ method: 'PATCH', model, id: parts[4], body: parsed });
          Object.assign(row, parsed, { updated_at: new Date(Date.parse(String(row.updated_at ?? 0)) + 1000).toISOString() });
          return send(200, row);
        }
        if (req.method === 'POST' && parts[3] === 'records') {
          const created = { id: `created-${rows.length + 1}`, created_at: '2026-08-24T00:00:00.000Z', ...parsed };
          this.writes.push({ method: 'POST', model, body: parsed });
          rows.push(created as Row);
          return send(201, created);
        }
        send(405, { message: 'not allowed' });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as { port: number }).port;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

export const MODELS = { issues: 'm-issues', comments: 'm-comments', crew: 'm-crew' };
export const SEATS = { dev: 'seat-dev', design: 'seat-design', qa: 'seat-qa', triage: 'seat-triage' };
export const OPERATOR = 'row-operator';

export const crewRows = (): Row[] => [
  { id: SEATS.dev, name: 'Developer agent' },
  { id: SEATS.design, name: 'Design agent' },
  { id: SEATS.qa, name: 'QA agent' },
  { id: SEATS.triage, name: 'Triage agent' },
  { id: OPERATOR, name: 'The Operator', email: 'op@example.test' },
];

export const ticket = (o: Partial<Row> & { id: string; issue_id: string; status: string }): Row => ({
  updated_at: '2026-08-01T00:00:00.000Z', needs_design: false, ...o,
});
