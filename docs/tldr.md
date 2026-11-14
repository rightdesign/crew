# Crew in brief

The one-page version: what Crew is and how it works. Each section links to the
page with the detail.

## What it is

Crew is a small Tablation client that runs on a computer you control. It
watches a board for work, hands each task to a coding agent installed on that
computer, and reports back on the ticket.

## Where the work comes from

Crew checks a Tablation **Issues** app for tasks. Issues is a minimal bug
tracker with a simple data model: tickets, statuses, projects, repositories and
the people and agents who work them. Crew runs on a timer; each check is a
cheap poll, and an agent starts only when there is a ticket ready for it.

Tablation can also sync tickets in from other systems (Jira and GitHub today),
so Crew can work a backlog that lives somewhere else.

## Who does the work

A local agent does: Claude, Codex, Gemini or another supported harness, using
your own installation and sign-in. The prompts and the hand-off rules (which
status a ticket moves to, and who picks it up next) come from the Issues app,
so you can edit them to match how your team works.

The Issues app ships prompts for four roles:

| Role | What it does |
| --- | --- |
| Triage | Sorts new cases and routes each one to the right place. |
| Development | Makes the change. |
| Design | Works out the interface for tickets flagged as needing design. |
| QA | Tests the change and verifies or returns it. |

Releasing is not an agent's job. Crew does it itself, as an automation driven
by your configuration.

## How a ticket moves

1. **Development.** Crew cuts a Git worktree for the ticket, so the change is
   made in isolation from your checkout and from other tickets. The agent
   commits to a new branch and pushes it to the origin when it finishes.
2. **QA.** The QA agent reads the development branch and tests it in the
   worktree. It marks the ticket verified, or sends it back with what it found.
3. **Release.** If you configure it to, Crew merges verified changes back to
   your main branch, then runs your release and deploy steps. No agent or
   prompt is involved: Crew acts as the release manager, following the
   repository's configuration.

Every step leaves comments on the ticket, and a ticket that needs a person is
parked with a question for you to answer.

## How Crew knows your repository

A configuration file in the repository, `.crew.yaml`, tells Crew how to operate
there: how to set up a worktree, how to run the tests and the build, how
branches are named, and how to release and deploy. See
[the repo spec](/repo-spec), or have a coding agent write the file for you with
the [repository setup prompt](/repo-setup-prompt).

## Watching it work

- **Crew for macOS** sits in the menu bar and shows which agent is working, on
  which ticket and in which worktree, with a window to follow or message each agent and switches
  to pause the crew.
- **The command line** does the same job anywhere: `crew watch` is a live view
  of the event log, `crew log` tails it and `crew status` says what is running
  and what is waiting on you. See the [command reference](/commands).

## Gallery

<div class="gallery">
  <figure>
    <a href="/screenshots/issues-board-view.png"><img src="/screenshots/issues-board-view.png" alt="The Issues board, with tickets in New, Plan, Dev, QA and Closed columns"></a>
    <figcaption>The Issues board: tickets move from New to Closed as agents hand them off.</figcaption>
  </figure>
  <figure>
    <a href="/screenshots/issues-calendar-view.png"><img src="/screenshots/issues-calendar-view.png" alt="The Issues calendar in week view, with one entry per release and a ticket open beside it"></a>
    <figcaption>The Calendar: every release, with the tickets that shipped in it.</figcaption>
  </figure>
  <figure>
    <a href="/screenshots/issues-dashboard-view.png"><img src="/screenshots/issues-dashboard-view.png" alt="The Issues dashboard, with charts of open tickets by area and severity and resolution times"></a>
    <figcaption>The Dashboard: open work, releases and how long tickets take.</figcaption>
  </figure>
  <figure>
    <a href="/screenshots/macos-menubar-panel.png"><img src="/screenshots/macos-menubar-panel.png" alt="The Crew menu bar panel, listing each agent, the ticket it is working and switches for the crew, runs and releases"></a>
    <figcaption>Crew for macOS: each agent and its ticket, from the menu bar.</figcaption>
  </figure>
  <figure>
    <a href="/screenshots/macos-agent-chat.png"><img src="/screenshots/macos-agent-chat.png" alt="The Agent window in Crew for macOS, showing a developer agent's steps and messages as it works a ticket"></a>
    <figcaption>The Agent window: follow a run as it happens, or message the agent.</figcaption>
  </figure>
  <figure>
    <a href="/screenshots/macos-agent-history.png"><img src="/screenshots/macos-agent-history.png" alt="The Recent runs tab of the Agent window, showing a finished design run and its hand-off summary"></a>
    <figcaption>Recent runs: what each run did, how long it took and what it cost.</figcaption>
  </figure>
</div>

## Next

[Install](/install) is the short route to a running crew;
[Getting started](/getting-started) is the whole story.
