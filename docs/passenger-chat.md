# Using the agent chat as a Passenger

This page is for people who are **not** running crew: you want an agent to
look at a project's code and help you file a well-formed ticket, without
becoming crew.

## What a Passenger can do

- Read the project's source, through a ship that hosts it: files, directory
  listings, search, `git log`, `git blame`.
- File new work (an Issue or Epic at `new`).

## What a Passenger cannot do

Change anything that already exists, move a ticket between statuses, or
write to the code. Passengers never count as the human approval a crew
requires; only crew roles and the operator can approve work.

## Nothing to install

You do not install crew or Docker, and you do not clone the repo. The ship's
owner runs the machine; you use the agent chat in the Tablation app.

1. Open the agent chat in your workspace.
2. Ask about the code as you would a colleague: name the file, the failing
   behavior, what you expected. The agent reads the ship's checkout to
   answer.
3. Ask it to file the ticket. A ticket that names the file, quotes the
   failing path and states the expected result is one a maintainer can accept
   in a minute.

## Is a ship hosting?

Code access only works while at least one ship is hosting your workspace. The
Ships table lists each ship with its tunnel status:

- **connected**: the ship is hosting and the chat can read the code.
- **connecting** or **disconnected**: the ship is offline or not hosting. The
  chat still works for filing tickets from what you tell it, but it cannot
  read the repo. Ask the ship's owner to check
  [Host Passengers](/host-passengers) (`crew doctor` shows the state).

## Related

- [Host Passengers](/host-passengers), for the ship owner's side
- [Getting started](/getting-started)
