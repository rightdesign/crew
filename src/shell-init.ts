/**
 * `crew shell-init` (CREW-2866): the shell function a person installs once
 * with `eval "$(crew shell-init)"`.
 *
 * A process cannot change the directory of the shell that ran it, so "land in
 * the periscope's worktree" has to be the shell's own doing. The function
 * wraps `crew periscope`: `up` runs the command with `--json`, relays the
 * progress lines, and on success changes into the printed worktree and opens
 * the URL; `down` run from a worktree runs the command there (which survives
 * its own working directory being removed) and on success changes to the
 * repository's checkout; anything else passes straight through. The bare
 * `crew periscope` command never changes the caller's directory.
 *
 * The scripts read the JSON `done` object with sed, which is enough for the
 * flat object `crew` prints and keeps the function free of a jq dependency.
 */

export const SHELLS = ['zsh', 'bash', 'fish'] as const;
export type ShellName = (typeof SHELLS)[number];

/** The shell to emit for: `--shell`, else the login shell named by `$SHELL`, else zsh. */
export function shellFor(requested: string | undefined, envShell: string | undefined): ShellName {
  const pick = (requested ?? envShell ?? '').split('/').pop() ?? '';
  return (SHELLS as readonly string[]).includes(pick) ? (pick as ShellName) : 'zsh';
}

const POSIX = String.raw`# crew shell-init: "periscope up" lands in the worktree, "periscope down" returns to the checkout.
periscope() {
  case "${'$'}{1-}" in
    up|start)
      shift
      local _out _wt _url _noopen=
      _out=$(mktemp) || return 1
      case " $* " in *" --no-open "*) _noopen=1 ;; esac
      command crew periscope up --json "$@" 2>&1 >"$_out" \
        | command sed -e 's/^{.*"message":"\([^"]*\)".*}$/  \1/' >&2
      if command grep -q '"event":"done"' "$_out"; then
        _wt=$(command sed -n 's/.*"worktree":"\([^"]*\)".*/\1/p' "$_out" | command tail -n 1)
        _url=$(command sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$_out" | command tail -n 1)
      fi
      command rm -f "$_out"
      [ -n "$_wt" ] && [ -d "$_wt" ] || return 1
      builtin cd "$_wt" || return 1
      printf '%s\n%s\n' "$_url" "$_wt"
      if [ -z "$_noopen" ] && [ -n "$_url" ]; then
        if command -v open >/dev/null 2>&1; then command open "$_url"
        elif command -v xdg-open >/dev/null 2>&1; then command xdg-open "$_url" >/dev/null 2>&1; fi
      fi
      ;;
    down|end)
      local _common _checkout=
      _common=$(command git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && _checkout=${'$'}{_common%/.git}
      command crew periscope "$@" || return $?
      if [ -n "$_checkout" ] && [ -d "$_checkout" ]; then builtin cd "$_checkout" || return 1; fi
      ;;
    *)
      command crew periscope "$@"
      ;;
  esac
}
`;

const FISH = String.raw`# crew shell-init: "periscope up" lands in the worktree, "periscope down" returns to the checkout.
function periscope
    switch "$argv[1]"
        case up start
            set -e argv[1]
            set -l out (mktemp); or return 1
            command crew periscope up --json $argv 2>&1 >$out \
                | command sed -e 's/^{.*"message":"\([^"]*\)".*}$/  \1/' >&2
            set -l wt
            set -l url
            if command grep -q '"event":"done"' $out
                set wt (command sed -n 's/.*"worktree":"\([^"]*\)".*/\1/p' $out | command tail -n 1)
                set url (command sed -n 's/.*"url":"\([^"]*\)".*/\1/p' $out | command tail -n 1)
            end
            command rm -f $out
            test -n "$wt" -a -d "$wt"; or return 1
            builtin cd $wt; or return 1
            printf '%s\n%s\n' $url $wt
            if not contains -- --no-open $argv; and test -n "$url"
                if command -sq open
                    command open $url
                else if command -sq xdg-open
                    command xdg-open $url >/dev/null 2>&1
                end
            end
        case down end
            set -l checkout
            set -l common (command git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
            and set checkout (string replace -r '/\.git$' '' -- $common)
            command crew periscope $argv; or return $status
            if test -n "$checkout" -a -d "$checkout"
                builtin cd $checkout
            end
        case '*'
            command crew periscope $argv
    end
end
`;

export function shellInitScript(shell: ShellName): string {
  return shell === 'fish' ? FISH : POSIX;
}
