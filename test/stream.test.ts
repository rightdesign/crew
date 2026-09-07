import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStreamLine, extractResult, toolTarget, extractTurnTokens } from '../src/stream.ts';

test('a thinking block maps to a thought event, carrying the thinking text verbatim', () => {
  const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } };
  assert.deepEqual(mapStreamLine(line), [{ kind: 'thought', text: 'hmm' }]);
});

test('a text block maps to a text event, carrying the text verbatim', () => {
  const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } };
  assert.deepEqual(mapStreamLine(line), [{ kind: 'text', text: 'Hello' }]);
});

test('a tool_use block carries the tool name and a short target', () => {
  const line = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] },
  };
  assert.deepEqual(mapStreamLine(line), [{ kind: 'tool', tool: 'Bash', target: 'ls' }]);
});

test('an Edit tool_use targets the file path, not the command', () => {
  const line = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'x' } }] },
  };
  assert.deepEqual(mapStreamLine(line), [{ kind: 'tool', tool: 'Edit', target: '/a/b.ts' }]);
});

test('a message with several blocks yields several events, in order', () => {
  const line = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'ok' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/x.ts' } },
        { type: 'text', text: 'done' },
      ],
    },
  };
  assert.deepEqual(mapStreamLine(line), [
    { kind: 'thought', text: 'ok' },
    { kind: 'tool', tool: 'Read', target: '/x.ts' },
    { kind: 'text', text: 'done' },
  ]);
});

test('a user (tool_result) line and any system line map to nothing', () => {
  assert.deepEqual(mapStreamLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } }), []);
  assert.deepEqual(mapStreamLine({ type: 'system', subtype: 'init' }), []);
  assert.deepEqual(mapStreamLine({ type: 'result', subtype: 'success' }), []);
});

test('a line with no recognizable shape yields no events, not a throw', () => {
  assert.deepEqual(mapStreamLine(null), []);
  assert.deepEqual(mapStreamLine(undefined), []);
  assert.deepEqual(mapStreamLine('not an object'), []);
  assert.deepEqual(mapStreamLine({ type: 'assistant' }), []);
  assert.deepEqual(mapStreamLine({ type: 'assistant', message: { content: 'not an array' } }), []);
});

test('the final result line surfaces cost, turns and session id', () => {
  const line = { type: 'result', subtype: 'success', total_cost_usd: 0.0123, num_turns: 4, session_id: 'abc-123' };
  assert.deepEqual(extractResult(line), {
    sessionId: 'abc-123', numTurns: 4, totalCostUsd: 0.0123,
    inputTokens: undefined, outputTokens: undefined,
    cacheReadTokens: undefined, cacheCreationTokens: undefined,
  });
});

test('the final result line surfaces the token usage breakdown when present (ISSUE-376)', () => {
  const line = {
    type: 'result', subtype: 'success', total_cost_usd: 0.0123, num_turns: 4, session_id: 'abc-123',
    usage: {
      input_tokens: 1000, output_tokens: 200,
      cache_read_input_tokens: 50, cache_creation_input_tokens: 10,
    },
  };
  assert.deepEqual(extractResult(line), {
    sessionId: 'abc-123', numTurns: 4, totalCostUsd: 0.0123,
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheCreationTokens: 10,
  });
});

test('a non-result line has no result to extract', () => {
  assert.equal(extractResult({ type: 'assistant' }), undefined);
  assert.equal(extractResult(null), undefined);
});

test('extractTurnTokens sums an assistant line\'s own usage block', () => {
  const line = {
    type: 'assistant',
    message: {
      role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }],
      usage: { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 20240, cache_creation_input_tokens: 49836 },
    },
  };
  assert.equal(extractTurnTokens(line), 2 + 2 + 20240 + 49836);
});

test('extractTurnTokens is undefined for a non-assistant line, or an assistant line with no usage block', () => {
  assert.equal(extractTurnTokens({ type: 'result', usage: { input_tokens: 5 } }), undefined);
  assert.equal(extractTurnTokens({ type: 'assistant', message: { role: 'assistant', content: [] } }), undefined);
});

test('toolTarget falls back to nothing when no recognizable input field is present', () => {
  assert.equal(toolTarget('Glob', { pattern: undefined }), undefined);
  assert.equal(toolTarget('Task', { description: 'go do things' }), undefined);
  assert.equal(toolTarget('Grep', { pattern: 'foo.*bar' }), 'foo.*bar');
});
