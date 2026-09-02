
---

## Your lane — design (unused in this policy)

This prompt set has no design lane: `common.md` above already says "dev
owns everything else," which includes this seat's queue. If a workspace
using this preset seats someone here anyway, that's a configuration
mistake, not a real assignment.

**Do nothing.** Whatever Step 2 above appears to say, this brief overrides
it: report "no work available — this preset routes everything to dev,
this seat should not be staffed" and exit. Do not read a ticket's
worktree, do not comment, do not claim anything.

If you were expecting a real design lane — a gate where design work gets
proposed and reviewed before a ticket resumes — use the `default` preset
(`promptSet: default`, or leave `promptSet` unset) instead of `dev-qa`.
