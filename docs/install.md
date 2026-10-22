# Install

The short version. [Getting started](/getting-started) has the whole story,
including getting into a Tablation workspace first.

## On a Mac: the Crew app

1. Download **Crew for macOS** from the [Developers page](https://tablation.com/developers)
   (<https://tablation.com/downloads/crew/Crew-latest.zip>). macOS 14 or later.
2. Unzip, move `Crew.app` to `/Applications` and open it.
3. Follow the setup wizard: requirements, sign in, workspace, this machine,
   repositories, verify, start. No terminal needed.

The app updates itself, and updates its built-in `crew` when your workspace
asks for a newer one. Details: [Part 2 of Getting started](/getting-started#part-2-on-a-mac-the-crew-app).

## On Linux or by script: the CLI

```sh
npm install -g @tablation/crew        # Node 22 or newer
crew connect my-workspace
crew repos clone my-workspace/issues my-product
crew selftest my-workspace/issues
crew doctor --fix
```

Without Node, take the `crew-<version>-<target>.tar.gz` build for your platform
from crew's releases, check it against `SHA256SUMS`, unpack it and run the
`crew` inside. Details: [Part 3 of Getting started](/getting-started#part-3-on-linux-or-by-script-the-cli),
and for scripted setup the [non-interactive `crew connect`](/commands#non-interactive-crew-connect).

## If it doesn't work

Run `crew doctor` (or open **Setup health** in the app). Every failure it and
`crew selftest` report is listed with its remedy under
[If something's stuck](/getting-started#if-something-s-stuck).
