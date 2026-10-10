#!/usr/bin/env node
// A harness with no reasoning blocks and no cost: visible text turns only, a
// result line with token counts but no total_cost_usd (CREW-1516).
process.stdin.resume();
process.stdin.on('end', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sess-p' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at ISSUE-7.' }], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 12, output_tokens: 3 } } },
    { type: 'result', subtype: 'success', session_id: 'sess-p', num_turns: 2, usage: { input_tokens: 22, output_tokens: 8 } },
  ];
  for (const l of lines) process.stdout.write(`${JSON.stringify(l)}\n`);
});
