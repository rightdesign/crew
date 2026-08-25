#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json --verbose` in
// spawnAgent tests: reads and discards stdin (the prompt), then prints a
// small, realistic NDJSON transcript — one thinking block, one tool call,
// one final text block, and the closing result line.
process.stdin.resume();
process.stdin.on('end', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'let me look' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } },
    'not valid json — must not kill the run',
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] } },
    { type: 'result', subtype: 'success', session_id: 'sess-1', num_turns: 2, total_cost_usd: 0.0042 },
  ];
  for (const l of lines) process.stdout.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
  process.exit(0);
});
