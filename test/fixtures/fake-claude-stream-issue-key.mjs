#!/usr/bin/env node
// A session whose transcript names only the ISSUE- form of its ticket (CREW-4021).
// it announces ISSUE-4009, then claims it.
process.stdin.resume();
process.stdin.on('end', () => {
  const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sess-issue-key' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], usage } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Claiming ISSUE-4009.' },
      { type: 'tool_use', name: 'mcp__tablation__records_controller_update', input: { dataModelId: 'd', recordId: 'r', body: { status: 'in_progress' } } },
    ], usage } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }], usage } },
    { type: 'result', subtype: 'success', session_id: 'sess-issue-key', num_turns: 3, total_cost_usd: 0.01 },
  ];
  for (const l of lines) process.stdout.write(`${JSON.stringify(l)}\n`);
});
