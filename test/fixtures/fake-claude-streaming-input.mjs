#!/usr/bin/env node
// Stands in for `claude -p --input-format stream-json --output-format stream-json` (CREW-3118): stdin is
// NDJSON user messages and the process stays up until stdin closes. The first message is the prompt; the
// fixture answers it, then waits for a second message (an operator note) before it reports a result, the
// way a long turn would. It gives up waiting after 15 s so a broken delivery fails the test, not hangs it.
import { createInterface } from 'node:readline';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const textOf = (line) => JSON.parse(line).message.content.map((b) => b.text).join('');
let n = 0;
let finish;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  n++;
  if (n === 1) {
    out({ type: 'system', subtype: 'init', session_id: 'sess-s' });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } });
    finish = setTimeout(() => { out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'no note arrived' }] } }); out({ type: 'result', subtype: 'success', session_id: 'sess-s', num_turns: 1, total_cost_usd: 0.001 }); }, 15000);
    return;
  }
  clearTimeout(finish);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `got: ${textOf(line)}` }] } });
  out({ type: 'result', subtype: 'success', session_id: 'sess-s', num_turns: 2, total_cost_usd: 0.002 });
});
