---
name: Periscope
trigger: periscope
persona: Pair
description: Open a live preview of a named issue from the chat, outside an interview. Use when someone asks to "periscope" an issue or to see a change running on a machine.
---
# Periscope from the chat

Run this when someone starts a conversation with the word "periscope", for
example "periscope for <issue> on my machine". Your job is to open a live
preview of the issue they name, post its URL, and apply their change requests
inside that preview. You do not file a ticket, merge anything or touch the
project's real checkouts. If you're running as Pair, this is a distinct mode
within the same session, not a different identity — drop back to normal Pair
behavior once the preview is kept or discarded.

Assume nothing about your environment beyond this session. You may be a bare
MCP client with no filesystem access. Use only the tools this chat actually
offers (`use_host`, `periscope_up`, the preview's own file tools, and the
Tablation MCP tools for looking up an Issue). If a tool named below is not
offered, skip that step; if there is no `periscope_up`, go to §5.

The person who started the conversation is the **starter**.

## 1. Find the issue

1. The message names an issue by its `issue_tag` (its tag, with the project prefix) or
   `issue_id` (the numbered form). Look it up through the Tablation MCP
   tools. If the message names none, or the name matches nothing, ask the
   starter which issue they mean and stop until they answer; never guess.
2. Confirm a preview may be opened on it: no `assignee_id` that is a person
   or another agent holding it, and no run in flight (`held_by_ship_id`
   empty, status not `in_progress`, `fixed` or `qa`). If it is held or being
   worked, say which and why, and stop. Do not open a preview on top of
   someone's work.
3. Never open a preview without an issue, and never for an Epic.

## 2. Choose the host

If the message names a host or machine ("on my machine", "on the Studio"),
pin it with `use_host` before opening the preview. Without a `use_host` tool,
or when no host is named, follow the chat's default host.

## 3. Open the preview

Call `periscope_up` with `issue` set to the issue you found. Post the URL it
returns, with one note: the URL is reachable only on that host's network (the
same LAN or private network), not from outside it.

## 4. Work in the preview

- Take change requests from anyone in the thread. Apply them in the
  preview's worktree only, using the preview's own file tools, and say what
  you changed so the preview can be refreshed.
- Keep or discard is the starter's call. If anyone else asks, acknowledge it
  and put the question to the starter. Only the starter's answer counts.
- When the starter decides, carry it out with the preview's tools if the chat
  offers them; otherwise tell them the `crew periscope down --keep` or
  `--discard` command that does it.

## 5. When no preview is available

When no ship offers previews, or `periscope_up` refuses (no `preview` hook,
the ship is at its limit, the host is unreachable), say so in one or two
plain sentences, give the reason it returned, and stop. Still answer the
person's actual question in prose if you can (describe the change, or point at
the code). Never mint a ticket as a substitute for a preview.

## What this mode is never responsible for

- Filing, accepting or closing tickets.
- Opening a preview for an Epic, or without a named issue.
- Pushing, merging or releasing the preview's branch.
