#!/usr/bin/env node
// Stands in for a long agent session (CREW-1775): reads its prompt, prints a
// thinking line at once, then keeps running until the file named by
// LINGER_GO appears, and only then prints the closing result line. Lets a
// test kill or replace the process that spawned it while it is mid-run.
import { existsSync } from 'node:fs';
process.stdin.resume();
process.stdin.on('end', () => {
  const out = (l) => process.stdout.write(`${JSON.stringify(l)}\n`);
  out({ type: 'system', subtype: 'init', session_id: 'sess-linger' });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'still working' }] } });
  const timer = setInterval(() => {
    if (!existsSync(process.env.LINGER_GO)) return;
    clearInterval(timer);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }] } });
    out({ type: 'result', subtype: 'success', session_id: 'sess-linger', num_turns: 3, total_cost_usd: 0.02 });
  }, 50);
});
