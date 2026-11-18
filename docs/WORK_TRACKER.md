# Work tracker reference

<!-- Generated from src/tracker-interface.ts by `node --experimental-strip-types scripts/gen-tracker-reference.ts`. Do not edit by hand. -->

Interface `work-tracker`, owner `crew`, version 1.1. This crew reads versions 1.0 or a later 1.x.

An app that implements this interface declares a mapping from each role below to its own table, field or status value, and crew reads the app through that mapping. A table or column keeps working under any name as long as the mapping says so. An app that declares nothing is read from the defaults in the last column, found by table display name, and crew raises a non-blocking attention item asking the operator to update the app’s template.

## Tables

| Role | Default name | Required | What goes wrong without it |
| --- | --- | --- | --- |
| `issues` | Issues | yes | Without it crew has no tickets to work. |
| `comments` | Comments | yes | Without it crew cannot read answers or post progress. |
| `crew` | Crew | yes | Without it crew has no seats to act as and no people to hand work to. |
| `projects` | Projects | no | Without it tickets cannot be routed by project or work mode. |
| `repos` | Repos | no | Without it a ticket cannot name the repository it belongs to. |
| `ships` | Ships | no | Without it several machines cannot share one board. |
| `epics` | Epics | no | Without it tickets cannot belong to an epic. |
| `maps` | Maps | no | Without it a ticket cannot cite its epic’s planning document. |
| `periscopes` | Periscopes | no | Without it crew cannot host live previews. |
| `locks` | Locks | no | Without it ships cannot take the release lock through the board. |
| `questions` | Questions | no | Without it a seat that parks a ticket for an answer cannot also ask the question as a record with proposed answers; the comment still carries it. |
| `answers` | Answers | no | Without it a question cannot offer proposed answers. |

## Issues fields

| Role | Default column | Shape | Required | What goes wrong without it |
| --- | --- | --- | --- | --- |
| `issues.key` | `issue_id` | any column | yes | Without it tickets cannot be named in branches, comments or logs. |
| `issues.tag` | `issue_tag` | any column | no | Without it branches fall back to plain `issue-<number>` names. |
| `issues.title` | `title` | a text field | yes | Without it crew cannot show or file a ticket. |
| `issues.status` | `status` | a choice field | yes | Without it crew cannot tell which tickets to work. |
| `issues.assignee` | `assignee_id` | a link field | yes | Without it crew cannot claim a ticket or see who holds one. |
| `issues.priority` | `priority` | a choice field | yes | Without it tickets cannot be ordered by urgency. |
| `issues.severity` | `severity` | a choice field | yes | Without it tickets cannot be ordered by severity. |
| `issues.slice` | `project_id` | a link field | yes | Without it tickets cannot be partitioned by project. |
| `issues.repo` | `repo_id` | a link field | yes | Without it crew cannot tell which checkout a ticket belongs to. |
| `issues.parent` | `parent_id` | a link field | no | Without it coordinating tickets cannot roll up their children. |
| `issues.blockedBy` | `blocked_by` | a link (one or several) field | yes | Without it crew cannot park a ticket behind its dependencies. |
| `issues.updatedAt` | `updated_at` | any column | yes | Without it crew cannot tell what changed since the last poll. |
| `issues.needsDesign` | `needs_design` | a boolean field | no | Without it tickets cannot be split between the dev and design lanes. |
| `issues.attachments` | `attachments` | a link (one or several) field | no | Without it a seat cannot open a ticket’s screenshots. |
| `issues.reportType` | `report_type` | a choice field | no | Without it questions, investigations and coordinating tickets are treated as builds. |
| `issues.epic` | `epic_id` | a link field | no | Without it tickets cannot belong to an epic. |
| `issues.author` | `filed_by_id` | a link field | no | Without it a filed ticket does not name its filer. |
| `issues.ship` | `ship_id` | a link field | no | Without it a ticket does not name the machine it was filed from. |
| `issues.heldBy` | `held_by_ship_id` | a link field | no | Without it two machines can claim the same ticket. |
| `issues.resolutionNote` | `resolution_note` | a text field | no | Without it a close that needs a reason cannot give one. |
| `issues.verifiedSha` | `verified_sha` | a text field | no | Without it review cannot tell whether the verified branch changed. |
| `issues.prRef` | `pr_ref` | a text field | no | Without it the merged hook cannot be told which pull request it ends. |
| `issues.branchUrl` | `branch_url` | a text field | no | Without it the ticket does not link to its pushed branch. |
| `issues.prUrl` | `pr_url` | a text field | no | Without it the ticket does not link to its pull request. |
| `issues.externalId` | `external_id` | a text field | no | Without it imported tickets cannot be told from hand-filed ones. |
| `issues.position` | `position` | a number field | no | Without it the board’s manual order is ignored. |
| `issues.agentRuns` | `agent_runs` | a number field | no | Without it per-ticket run counts are not kept. |
| `issues.tokensIn` | `tokens_in` | a number field | no | Without it per-ticket token spend is not kept. |
| `issues.tokensOut` | `tokens_out` | a number field | no | Without it per-ticket token spend is not kept. |
| `issues.cacheReadTokens` | `cache_read_tokens` | a number field | no | Without it per-ticket token spend is not kept. |
| `issues.cacheWriteTokens` | `cache_write_tokens` | a number field | no | Without it per-ticket token spend is not kept. |
| `issues.costUsd` | `cost_usd` | a number field | no | Without it per-ticket spend is not kept. |
| `issues.crewAssisted` | `crew_assisted` | a boolean field | no | Without it tickets the crew worked are not marked. |

## Comments fields

| Role | Default column | Shape | Required | What goes wrong without it |
| --- | --- | --- | --- | --- |
| `comments.parent` | `ticket_id` | a link field | yes | Without it a comment cannot be tied to its ticket. |
| `comments.body` | `body` | a text field | yes | Without it a comment has no text. |
| `comments.author` | `team_member_id` | a link field | yes | Without it crew cannot tell its own comments from a person’s. |
| `comments.createdAt` | `created_at` | any column | yes | Without it comments cannot be ordered. |
| `comments.ship` | `ship_id` | a link field | no | Without it a comment does not name the machine that posted it. |
| `comments.publicReply` | `is_public_reply` | a boolean field | no | Without it replies from a public form are read as the team’s. |
| `comments.authorName` | `author_name` | a text field | no | Without it a public reporter’s name is lost. |

## Projects fields

| Role | Default column | Shape | Required | What goes wrong without it |
| --- | --- | --- | --- | --- |
| `projects.workMode` | `work_mode` | a choice field | no | Without it every project is worked automatically. |

## Epics fields

| Role | Default column | Shape | Required | What goes wrong without it |
| --- | --- | --- | --- | --- |
| `epics.status` | `status` | a choice field | no | Without it crew cannot keep an epic’s status from its tickets. |
| `epics.key` | `epic_id` | any column | no | Without it an epic has no name in the log. |

## Maps fields

| Role | Default column | Shape | Required | What goes wrong without it |
| --- | --- | --- | --- | --- |
| `maps.epic` | `epic_id` | a link field | no | Without it a Map cannot be matched to its epic. |
| `maps.title` | `title` | a text field | no | Without it a Map has no name in a brief. |
| `maps.content` | `content` | a text field | no | Without it a brief cannot carry the Map. |
| `maps.conversation` | `conversation` | a text field | no | Without it the interview record cannot be pointed at. |
| `maps.status` | `status` | a choice field | no | Without it the active Map cannot be told from a draft. |
| `maps.version` | `version` | any column | no | Without it a brief cannot name the Map’s version. |

## Questions fields

| Role | Default column | Shape | Required | What goes wrong without it |
| --- | --- | --- | --- | --- |
| `questions.parent` | `ticket_id` | a link field | no | Without it a question cannot be tied to the ticket it is about, so crew writes none. |
| `questions.text` | `question` | a text field | no | Without it a question has no words. |
| `questions.status` | `status` | a choice field | no | Without it crew cannot tell an open question from an answered or withdrawn one. |
| `questions.askedBy` | `asked_by_id` | a link field | no | Without it a question does not say which seat asked it, so crew cannot withdraw its own earlier question. |
| `questions.addressedTo` | `addressed_to_id` | a link field | no | Without it a question does not say who it is waiting on. |
| `questions.answeredBy` | `answered_by_id` | a link field | no | Without it an answered question does not say who answered. |
| `questions.chosenAnswer` | `chosen_answer_id` | a link field | no | Without it an answered question does not say which answer was chosen. |

## Answers fields

| Role | Default column | Shape | Required | What goes wrong without it |
| --- | --- | --- | --- | --- |
| `answers.question` | `question_id` | a link field | no | Without it an answer cannot be tied to its question, so crew offers none. |
| `answers.label` | `label` | a text field | no | Without it an answer has no short label to show on a button. |
| `answers.detail` | `detail` | a text field | no | Without it an answer has no full instruction to act on when chosen. |
| `answers.order` | `position` | a number field | no | Without it the answers show in the order they were created, not the order the seat intended. |

## The questions part (version 1.1)

Optional. When the app maps the Questions and Answers tables and the roles below, a seat that parks a ticket for a person’s answer also writes the question as a record: one open question linked to the ticket, with two to four ordered answers (recommended first) when the choices are genuinely discrete, none when the answer is free-form. The comment is posted either way and still leads with the question. An app that maps none of it, including every app at version 1.0, still conforms and gets the comment alone. The shapes are the ones the platform’s Record choices component asks of its questions and answers tables. Crew writes the part only when the mapping carries `questions.parent`, `questions.text`, `questions.status`, `questions.askedBy`, `answers.question`, `answers.label`, `answers.detail`; the other roles are written when mapped.

| Value id | Default value | Meaning |
| --- | --- | --- |
| `open` | `open` | Waiting for a person to answer. |
| `answered` | `answered` | A person chose an answer or replied in writing. |
| `withdrawn` | `withdrawn` | The asker took it back, usually because it asked again on the same ticket. |

## Status meanings

Which statuses are open and which are resolved belongs to the interface, not to the app. A blocker stops counting only at a resolved status; `Handed off` is open and not resolved, because a ticket blocked by unmerged work is still blocked.

| Value id | Default value | Open | Resolved | Required | Meaning |
| --- | --- | --- | --- | --- | --- |
| `new` | `new` | yes | no | yes | Filed, not yet approved by a person. |
| `approved` | `accepted` | yes | no | yes | A person authorized the work. Only a person sets it. |
| `parked` | `blocked` | yes | no | yes | Approved but waiting on an unresolved dependency; crew parks and restores it. |
| `building` | `in_progress` | yes | no | yes | A seat is working it. |
| `needsHuman` | `needs_info` | yes | no | yes | A person owes an answer. |
| `handoff` | `fixed` | yes | no | yes | Built, not yet checked. Open and not resolved. |
| `verifying` | `qa` | yes | no | yes | Being checked. |
| `verified` | `verified` | yes | yes | yes | Checked and awaiting release. Resolves a blocker but is not closed. |
| `reviewing` | (none) | yes | no | no | A pull request is open for human review. Only an app with a review step has it. |
| `deployed` | `closed_deployed` | no | yes | yes | Released; set by the release phase alone. |
| `wontFix` | `closed_wont_fix` | no | yes | yes | Called off without merging. |
| `duplicate` | `closed_duplicate` | no | yes | yes | Closed in favor of another ticket. |
| `completed` | `closed_completed` | no | yes | yes | Done with nothing to deploy. |
| `cantReproduce` | `closed_cant_reproduce` | no | yes | yes | Closed as written, unreproducible. |
| `draft` | `draft` | no | no | no | Held back; never polled. |
