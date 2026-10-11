---
name: Ticket Attachments
description: How to resolve and open the attachments on a ticket or comment — Media Library record ids, not URLs — before building or verifying a fix. Fetch when the ticket you picked up, or any of its comments, carries an attachments value.
---
# Opening a ticket's attachments

A ticket (and any of its comments) may carry an `attachments` value: a list
of Media Library record ids, not URLs. A bare id array is not "nothing to
see" — it is usually the repro screenshot, and a fix built from the prose
alone has shipped the wrong behaviour before. Resolve every id on the ticket
you picked up, and on any comment that has them, before you start.

1. **Read the Media Library record for that id.** The `attachments` column is
   a reference into the workspace's Media Library table; its `storage_key`
   and `mime_type` are what you need:
   `GET /api/workspaces/<workspaceId>/data-models/<Media Library id>/records/<id>`
   (MCP: `records_controller_find_one`). The Environment section's "Opening
   a ticket's attachments" names the table id; if it is absent, find the
   table by name in a workspace-level model listing — never by reading the
   whole Issues model definition, which is over a megabyte. The id is a
   record id, not a file id: `files/<id>`, `files/<id>/download` and
   `media-library/<id>/...` all 404 by design.
2. **Fetch the bytes:** the `storage_key` has the form `<uuid>/<filename>`;
   `GET /api/workspaces/<workspaceId>/files/<uuid>/<filename>` with the usual
   headers streams it (the MCP form is `files_controller_download` with
   `workspaceId`, `uuid` and `filename`, which hands an image back as a
   viewable block). Save the file in a scratch directory outside the
   repository, then open it.
3. **Compare what the picture shows with what the description says.** Where
   they disagree, the picture is the reproduction.

**If you cannot open an attachment, that is a blocker, not a detail to
skip:** post a comment naming the attachment and what failed, set
`needs_info` and `needs_planning` to true, and stop — do not proceed on the
description alone. QA applies the same rule: a pass on the description alone
is not a pass.

To attach your own screenshot to a comment, follow the Environment section's
"Attaching a file to a comment" recipe and put the returned id in the
comment's `attachments` array.
