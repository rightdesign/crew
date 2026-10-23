// A dev session that commits, pushes, then gets a 502 on its hand-off writes and gives up.
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
out({ type: 'assistant', message: { role: 'assistant', content: [
  { type: 'tool_use', id: 'u1', name: 'mcp__tablation__records_controller_create', input: { dataModelId: 'c', body: { ticket_id: 'row-9', body: 'Hand-off: built and pushed.' } } },
  { type: 'tool_use', id: 'u2', name: 'mcp__tablation__records_controller_update', input: { dataModelId: 'i', recordId: 'row-9', body: { status: 'fixed', assignee_id: null } } },
] } });
out({ type: 'user', message: { role: 'user', content: [
  { type: 'tool_result', tool_use_id: 'u1', is_error: true, content: '<html><title>502 Bad Gateway</title></html>' },
  { type: 'tool_result', tool_use_id: 'u2', is_error: true, content: 'HTTP 502 Bad Gateway' },
] } });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Built and pushed, but the board returned 502.' }] } });
out({ type: 'result', session_id: 's', num_turns: 2, usage: { input_tokens: 1, output_tokens: 1 } });
