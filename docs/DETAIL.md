# Rule guard

English | [中文](DETAIL.zh.md)

## What it does

Rule guard listens on the `tools/pre-execute` seam of DeepSeek Harness. Before a
shell tool runs, the command text is judged by local rules only — no network,
no model call, no dependency on any external service. An ordinary command falls
through to the next listener untouched; a command that matches a rule is answered
with `ask`, which the host routes to the **default approval panel**. That panel
has no countdown, so the call waits for as long as the user needs.

The plugin is a gate, not a sandbox. It narrows what the agent can do without
asking; it does not replace the file sandbox, and it cannot see inside a script
file.

## Decision path

```
tool call
  → tool name not in `tools`                     → fall through (allow)
  → no `command` string argument                 → fall through (allow)
  → matches `allowPatterns`                      → fall through (allow)
  → matches `denyPatterns`                       → deny, with a structured error
  → matches a built-in rule                      → ask
  → matches `askPatterns`                        → ask
  → no static verdict possible                   → `onUnsupported` (allow by default)
  → the rule engine itself threw                 → `onError` (allow by default)
```

Every non-allow decision is appended to a JSONL audit file.

## Rule families

POSIX (`bash`, `sh`, and any tool inferred as POSIX):

| Rule | Command forms |
| --- | --- |
| `remove-critical-path` | `rm` with `-r`/`-R`/`--recursive`, `-f`/`--force`, several targets or an unquoted glob |
| `find-delete` | `find … -delete` |
| `system-storage` | `dd`, `mount`, `umount`, `mkfs[.*]` |
| `rsync-delete` | any `--delete*` switch without a dry run |
| `git-reset-hard` | `git reset --hard` |
| `git-clean-force` | `git clean -f` without a dry run |
| `git-push-force` | `--force`, `--force-with-lease`, `--mirror`, or a `+refspec` |
| `git-discard-tree` | `git checkout -f`, `checkout .`, `restore .` |
| `git-stash-clear` | `git stash clear` |
| `git-worktree-force-remove` | `git worktree remove --force` |

CMD (`cmd`, and any tool inferred as CMD):

| Rule | Command forms |
| --- | --- |
| `cmd-remove-tree` | `rd /s`, `rmdir /s` |
| `cmd-delete-files` | `del`/`erase` with recursion, a glob or several targets |
| `robocopy-delete` | `robocopy /MIR` or `/PURGE` without `/L` |
| plus every POSIX and git rule | the same tokenizer rules apply |

PowerShell (`pwsh`, `powershell`, and any tool inferred as PowerShell):

| Rule | Command forms |
| --- | --- |
| `pwsh-remove-recursive` | `Remove-Item -Recurse` (aliases included), or a `-Recurse` enumeration feeding `-Force` |
| `pwsh-dotnet-delete` | `[System.IO.Directory]::Delete`, `[System.IO.File]::Delete` |
| `pwsh-dynamic-exec` | `Invoke-Expression` / `iex`, `[ScriptBlock]::Create` |
| `pwsh-download-exec` | a download command and an execution command in one pipeline |
| `pwsh-credential-read` | reading `.ssh/id_*`, `.aws/credentials`, `.env`, and similar |
| `pwsh-credential-write` | writing or copying into the same files |
| `pwsh-system-config` | execution policy, registry, accounts, services, disks, shutdown |
| `pwsh-clear-recyclebin` | `Clear-RecycleBin -Force` |
| plus every POSIX and git rule | native commands inside a PowerShell line are routed to the shared matcher |

The POSIX, CMD and git rules are ported from ZCode's guarded matcher, which
carries its own boundary-case fixes: an unknown option never revokes a
recognized hit, a wrapper's unknown option makes the whole invocation
unsupported, a `--help` spelling is a query exit, and reversal words
(`--dry-run`, `-WhatIf`, `-Confirm`) downgrade instead of matching.

## Configuration

Every field is edited on the plugin's own row in **Plugins** →
`@lliangworld/dsh-rule-guard` → **Rule guard**. A save writes the profile's
user layer and reaches the next command without restarting the harness; a
value identical to the default is cleared rather than stored, so the row only
ever holds what you actually changed.

| Field | Default | Meaning |
| --- | --- | --- |
| `tools` | `pwsh`, `bash`, `terminal`, `pwsh_persistent`, `bash_persistent`, `ops_bash` | Tool names this guard takes over, one per line |
| `dialect` | `auto` | `auto` infers the dialect from the tool name; or force `posix`, `cmd`, `powershell` |
| `onUnsupported` | `allow` | `allow` or `ask` when no static verdict is possible |
| `onError` | `allow` | `allow` or `ask` when the rule engine throws |
| `allowPatterns` | `[]` | Regular expressions that release a call without asking |
| `askPatterns` | `[]` | Regular expressions that ask, even without a built-in hit |
| `denyPatterns` | `[]` | Regular expressions that deny outright |
| `maxCommandLength` | `10000` | Longest command text analyzed, from 1000 to 100000 |
| `audit` | `true` | Record every non-allow decision |
| `auditPath` | `''` | Empty uses `$DSH_HOME/rule-guard-audit.jsonl` |

Every field is volatile, so a change reaches the next call without restarting
the harness. The defaults live in the plugin's schema — this bundle's patch
declares only the row, so nothing in the profile shadows them.

### Reducing prompts

A rule match always asks; there is no way to suppress a built-in rule other
than an `allowPatterns` entry for the exact shape you trust:

```
allowPatterns:
  - '^python -c "import json'
```

### What is allowed without a prompt

Because `onUnsupported` defaults to `allow`, these are released rather than
interrupted:

- a command whose target is dynamic (`Get-Content $path`, `rm -rf "$target"`),
  unless a dangerous switch is also visible;
- a script file or module run (`./deploy.sh`, `node script.js`, `python -m pytest`);
- a compound statement (`for …; do …; done`, `if …; fi`), whose body is skipped;
- a command line longer than `maxCommandLength`.

Set `onUnsupported: ask` to make each of those a prompt instead. That is the
fail-closed stance: it catches a dangerous command hidden behind a variable,
and it also prompts on a large share of ordinary work, which is why it is not
the default.

## Limitations

- **Script files are a blind spot.** The contents of `./deploy.sh`,
  `bash script.sh` or `pwsh -File x.ps1` cannot be read from a command line, so
  they are allowed — exactly as `pnpm test` or `make` are. The file sandbox and
  execution-time measures are the layers that cover this.
- **Only shell tools.** `write`, `edit`, `glob`, `grep` and MCP tools are not
  intercepted. Widen `tools` only if those tools expose a command string.
- **`never` approval policy.** Under a preset whose approval policy is `never`
  (for example the stock `danger-full-access`), an ask is deterministically
  rejected: the model is told which rule matched, and nothing executes.
- **Session pinning.** A preset change applies to new sessions, not to a
  running one.
- **No verdict cache.** A decision always re-reads the whole command text, so
  changing a dangerous argument is always re-examined. The cost is one
  synchronous, dependency-free analysis per call.
- **Layering.** A rule ask and a sandbox escalation are two independent seams
  and may each prompt once. A call approved here still passes the guard layer
  and the sandbox afterwards.

## Audit

One JSONL line per non-allow decision:

```json
{"ts":"2026-11-14T10:00:00.000Z","sessionId":"session-1","tool":"pwsh","callId":"call-1","dialect":"powershell","verdict":"ask","ruleId":"pwsh-remove-recursive","command":"Remove-Item -Recurse ./build","reason":"rule-guard: matched \"pwsh-remove-recursive\" (powershell recursive removal); awaiting user approval for tool \"pwsh\""}
```

The file rotates at 2 MiB, keeping one previous generation. A failed write is
swallowed and reported through the logger; it never turns into a failed
decision.
