#!/usr/bin/env node
// Stands in for `gemini -p --output-format stream-json`: discards stdin (the
// prompt), prints an NDJSON transcript in Gemini CLI's documented event shape.
// Hand-built from the schema, NOT recorded from a real session (CREW-1521).
process.stdin.resume();
process.stdin.on('end', () => {
  const lines = [
    { type: 'init', session_id: 'gem-sess-1', model: 'gemini-2.5-pro' },
    { type: 'message', role: 'user', content: 'prompt' },
    { type: 'message', role: 'assistant', content: 'Looking at ', delta: true },
    { type: 'message', role: 'assistant', content: 'the repo. ', delta: true },
    { type: 'tool_use', tool_name: 'run_shell_command', tool_id: 't1', parameters: { command: 'ls -la' } },
    { type: 'tool_result', tool_id: 't1', status: 'success', output: 'x' },
    'not valid json — must not kill the run',
    { type: 'tool_use', tool_name: 'read_file', tool_id: 't2', parameters: { file_path: 'src/a.ts' } },
    { type: 'message', role: 'assistant', content: 'All ', delta: true },
    { type: 'message', role: 'assistant', content: 'done.', delta: true },
    { type: 'result', status: 'success', stats: { total_tokens: 150, input_tokens: 100, output_tokens: 50, cached: 20, duration_ms: 900, tool_calls: 2 } },
  ];
  for (const l of lines) process.stdout.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
});
