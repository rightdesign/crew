#!/usr/bin/env node
// A RECORDED `codex exec --json` session (Codex CLI 0.162.1, gpt-5.5, 2026-10-10,
// workspace-write sandbox, approval_policy="never", the tracker MCP registered
// per run with default_tools_approval_mode="approve"), replayed line for line.
// Scrubbed: the command output and the MCP result body are trimmed to a stub;
// ids, event shapes, field names and the usage block are as Codex emitted them.
// Re-record with the same flags if Codex's `exec --json` schema moves.
process.stdin.resume();
process.stdin.on('end', () => {
  const lines = [
    {"type": "thread.started", "thread_id": "01a128c0-1b5e-7fd3-9c5f-2a0b4b4e9d11"},
    {"type": "turn.started"},
    {"type": "item.started", "item": {"id": "item_0", "type": "command_execution", "command": "/bin/zsh -lc 'git status --short'", "aggregated_output": "", "exit_code": null, "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "item_0", "type": "command_execution", "command": "/bin/zsh -lc 'git status --short'", "aggregated_output": "", "exit_code": 0, "status": "completed"}},
    {"type": "item.started", "item": {"id": "item_1", "type": "mcp_tool_call", "server": "tablation", "tool": "records_controller_list", "arguments": {"dataModelId": "5be396b9-1dce-44ae-ba2d-cd67434cd19e", "limit": "1"}, "result": null, "error": null, "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "item_1", "type": "mcp_tool_call", "server": "tablation", "tool": "records_controller_list", "arguments": {"dataModelId": "5be396b9-1dce-44ae-ba2d-cd67434cd19e", "limit": "1"}, "result": {"content": [{"type": "text", "text": "[{\"issue_tag\":\"CREW-1529\",\"title\":\"Per-repo toolchain override on a route's `repos:` entry\"}]"}], "structured_content": {"count": 1}}, "error": null, "status": "completed"}},
    {"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": "The record is CREW-1529, \"Per-repo toolchain override on a route's `repos:` entry\"."}},
    {"type": "turn.completed", "usage": {"input_tokens": 52152, "cached_input_tokens": 35968, "cache_write_input_tokens": 0, "output_tokens": 241, "reasoning_output_tokens": 60}},
  ];
  for (const l of lines) process.stdout.write(`${JSON.stringify(l)}\n`);
});
