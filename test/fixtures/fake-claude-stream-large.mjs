#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json --verbose` in
// spawnAgent's flush-race test (CREW-985): prints enough NDJSON that the
// sink's writes cannot possibly all have landed synchronously by the time
// `end()` returns, so a caller that doesn't wait for `finish` before
// reading the file back would see it short.
process.stdin.resume();
process.stdin.on('end', () => {
  const bigText = 'x'.repeat(200_000);
  const lineCount = 50;
  for (let i = 0; i < lineCount; i++) {
    const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${bigText}-${i}` }] } };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-big', num_turns: lineCount, total_cost_usd: 0.01 })}\n`);
  // Same reasoning as fake-claude-stream.mjs: no process.exit() here, let
  // the event loop drain naturally so the writes are not lost.
});
