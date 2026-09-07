#!/usr/bin/env node
// Stands in for a real session that was planned against one ticket (the
// poll's pre-run hint) but actually spends most of its tokens working a
// different one — the exact shape ISSUE-621-mis-attributed-to-ISSUE-430
// reported. Three assistant turns, each with its own `message.usage`.
process.stdin.resume();
process.stdin.on('end', () => {
  const usage = (input, output) => ({
    input_tokens: input, output_tokens: output,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  });
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sess-multi' },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: "I'll pick up ISSUE-621, the fixed ticket awaiting verification." }],
        usage: usage(10, 20),
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'reading the full record and comments, this needs real work' }],
        usage: usage(100, 9000),
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Verified and closed.' }],
        usage: usage(5, 5),
      },
    },
    { type: 'result', subtype: 'success', session_id: 'sess-multi', num_turns: 3, total_cost_usd: 0.01 },
  ];
  for (const l of lines) process.stdout.write(`${JSON.stringify(l)}\n`);
  process.exit(0);
});
