# @lliangworld/dsh-rule-guard

English | [中文](README.zh.md)

A pure-local rule guard for agent shell commands in DeepSeek Harness. It listens on
`tools/pre-execute`: an ordinary command falls through untouched, and a command that
matches a dangerous pattern is answered with `ask`, which the host routes to the
**default approval panel** — no countdown, so the call waits as long as you need.
No network, no model call, no external dependency.

The plugin is a gate, not a sandbox. It narrows what the agent can do without asking;
it does not replace the file sandbox, and it cannot see inside a script file.

**By default it guards only the sessions that ask you** — the effective permission
full sandbox plus `ask`, which is what the `guarded-full` preset sets. Every other
preset behaves exactly as it did before. Switch **Guard every session** on to guard
everything instead. See [Where it applies](#where-it-applies).

## Table of contents

- [Where it applies](#where-it-applies)
- [Install](#install)
- [Configure](#configure)
- [Decision path](#decision-path)
- [Built-in rules](#built-in-rules)
- [Custom patterns](#custom-patterns)
- [What is allowed without a prompt](#what-is-allowed-without-a-prompt)
- [Known limitations](#known-limitations)
- [Audit](#audit)
- [Development](#development)
- [Attribution](#attribution)
- [License](#license)

-----

<a id="where-it-applies"></a>
## Where it applies

The guard is inert unless the session's effective permission asks the user. A preset
whose approval policy is `never` rejects an `ask` deterministically — the model is
told which rule matched and nothing executes — so a guard there could only ever
produce a denial with no prompt. A preset with a narrower sandbox already confines
the call.

So the guard activates where the two effective knobs read **full sandbox plus `ask`**,
which is exactly what the `guarded-full` preset sets. Matching the effective knobs
rather than a preset's name means the guard still works when the preset table does
not name it — including a hand-tuned combination, which the permission service
reports as `custom`.

### The preset is managed for you

By default this plugin adds `guarded-full` to your preset table while it is enabled, so there is nothing to edit by hand. The write goes to your profile's own `cordis.patch.yml` — the same file you would edit yourself, through the same path the **Plugins** page uses for any other setting — so it stays visible and reviewable.

Pick **Guarded full access** in the composer's permission picker, or run `/permission guarded-full`.

Three things the management does deliberately:

- **It only ever adds `guarded-full`.** Every other key in that row's
  config — the stock presets, `defaultPreset` — is restated unchanged, because a
  patch's `config` is *replaced wholesale, never deep-merged*.
- **The slot's key is the identity.** Whatever sits under `guarded-full` is this
  plugin's to add, relabel and remove. A preset you want for yourself gets
  another key, which this plugin never touches.
- **Disabling the plugin removes it again**, and removes it cleanly: the whole
  `permission` row goes away, because what is left equals what the bundle layer
  already provides. Nothing about your effective configuration changes. Re-enabling
  puts both back.

**The label follows the language.** The preset appears as 「守卫式全权限」 under a
Chinese host and as *Guarded full access* under an English one, and switching the
language in Settings updates it without a reinstall. The permission client does
not localize configured presets — only the three shipped keys are translated — so
this is the plugin writing the language's label into the preset's own `name`.

When nothing says which language to use, the host's own locale answers. A browser
language that differs from the OS is therefore not picked up, and the label lands
on English.

**The two pickers follow immediately.** Enabling the plugin adds the preset to
Settings' *default permission mode for new sessions* and to the composer's
permission seat without a restart, and disabling it removes it from both. The
permission client caches its catalog and listens for
`permission-presets/catalog-changed` — which `permissionPresets` itself emits only
from `registerAuto`, never for a configuration change — so the plugin announces
that signal after each write it lands. Nothing else needs a restart.

**Uninstalling the plugin does not remove it.** A bundle is disabled before its
package is deleted, so the removal fires during the disable and the write that
would follow is lost in the reconcile. The preset stays, naming a plugin that is
gone. That is harmless — the guard is unloaded with the plugin, so the preset just
sits there inert — and installing the plugin again finds it already in place. To
remove it by hand, delete the `guarded-full` entry from the `permission` row of
your profile patch.

### Managing the preset yourself

Set **Manage the guarded-full preset** to off on the plugin's row to opt out. Then
add the preset to your profile's own `cordis.patch.yml` yourself:

```yaml
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      guarded-full:
        sandbox: danger-full-access
        approval: ask
        name: "Guarded full access"
        description: "Full sandbox access; dangerous commands ask the user."
    defaultPreset: workspace-write
```

This cannot live in the bundle's own patch. The composition reference is explicit:
a patch's `config` is *replaced wholesale, never deep-merged*. Your profile already
patches the `permission` row with its own preset table, and a profile layer is
applied after bundle layers — so a preset added there would be silently dropped.
Leaving the row out of this bundle's patch is deliberate: writing only
`guarded-full` there would erase the stock `workspace-write` and `danger-full-access`
presets in a profile that does not patch the row itself.

A preset change applies to new sessions, not to a running one.

To guard every session regardless of preset, sandbox or approval policy, set
**Guard every session** to on. That is the only setting that lifts the condition;
the preset is the other half of it.

<a id="install"></a>
## Install

From the DeepSeek Harness **Plugins** page, add this repository as a bundle. No
build step runs: the package is plain ESM plus one YAML patch.

```powershell
dsh plugin --profile desktop add github:lliangworld/dsh-rule-guard
```

The plugin takes effect on the next session. Verify the row in **Plugins**, then
check `tools/pre-execute` behavior in a new session.

<a id="configure"></a>
## Configure

Open **Plugins** → `@lliangworld/dsh-rule-guard` → **Rule guard**. Every field is
edited on that row:

| Field | Default | Meaning |
| --- | --- | --- |
| `global` | `false` | Off guards only the sessions described above; on guards every session |
| `managePreset` | `true` | On adds the guarded-full preset while this plugin is enabled and removes it again when the plugin is disabled; turning the switch itself off removes the preset and turning it back on adds it again, both without a restart; off leaves the preset table to you |
| `tools` | `pwsh`, `bash`, `terminal`, `pwsh_persistent`, `bash_persistent`, `ops_bash` | Tool names this guard takes over, one per line |
| `dialect` | `auto` | `auto` infers the dialect from the tool name; or force `posix`, `cmd`, `powershell` |
| `onUnsupported` | `allow` | `allow` or `ask` when no static verdict is possible |
| `onError` | `allow` | `allow` or `ask` when the rule engine throws |
| `maxCommandLength` | `10000` | Longest command text analyzed, from 1000 to 100000 |
| `audit` | `true` | Record every non-allow decision |
| `auditPath` | `''` | Empty uses `$DSH_HOME/rule-guard/rule-guard-audit.jsonl` |
| `disabledRules` | `[]` | Built-in rule ids switched off: a match is released without asking |
| `allowPatterns` | `[]` | Regular expressions that release a call without asking |
| `askPatterns` | `[]` | Regular expressions that ask, even without a built-in hit |
| `denyPatterns` | `[]` | Regular expressions that deny outright |

The two last groups sit behind fold buttons, because a deployment sets them once:
**Built-in rules** carries one switch per rule, and **Custom patterns** the three
regular-expression lists. The card's copy follows the interface language (English
and Simplified Chinese are shipped).

A save writes the profile's user layer and reaches the next command without
restarting the harness; a value identical to the default is cleared rather than
stored, so the row only ever holds what you actually changed. The defaults live in
the plugin's schema — this bundle's patch declares only the row, so nothing in the
profile shadows them.

<a id="decision-path"></a>
## Decision path

```
tool call
  → tool name not in `tools`                     → fall through (allow)
  → no `command` string argument                 → fall through (allow)
  → the guard does not apply to this session     → fall through (allow)
  → matches `allowPatterns`                      → fall through (allow)
  → matches `denyPatterns`                       → deny, with a structured error
  → matches a built-in rule that is switched off → fall through (allow), audited as rule-disabled
  → matches a built-in rule                      → ask
  → matches `askPatterns`                        → ask
  → no static verdict possible                   → `onUnsupported` (allow by default)
  → the rule engine itself threw                 → `onError` (allow by default)
```

Every non-allow decision is appended to a JSONL audit file.

<a id="built-in-rules"></a>
## Built-in rules

Twenty-one rules across four dialects. Each has its own switch in the **Built-in
rules** group of the configuration card; switching one off releases a command that
matches it, and the audit records that the rule matched and was disabled.

POSIX (`bash`, `sh`, and any tool inferred as POSIX):

| Rule | Command forms |
| --- | --- |
| `remove-critical-path` | `rm` with `-r`/`-R`/`--recursive`, `-f`/`--force`, several targets or an unquoted glob |
| `find-delete` | `find … -delete` |
| `system-storage` | `dd`, `mount`, `umount`, `mkfs[.*]` |
| `rsync-delete` | any `--delete*` switch without a dry run |

git (in every dialect):

| Rule | Command forms |
| --- | --- |
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

The POSIX, CMD and git rules are ported from ZCode's guarded matcher, which carries
its own boundary-case fixes: an unknown option never revokes a recognized hit, a
wrapper's unknown option makes the whole invocation unsupported, a `--help` spelling
is a query exit, and reversal words (`--dry-run`, `-WhatIf`, `-Confirm`) downgrade
instead of matching.

<a id="custom-patterns"></a>
## Custom patterns

Three regular-expression lists, one entry per line, each matched against the whole
command text. `allowPatterns` releases a call without asking, `askPatterns` asks even
when no built-in rule fired, and `denyPatterns` denies outright.

A rule match always asks; the way to suppress one built-in rule is its own switch, and
the way to suppress one shape is an `allowPatterns` entry for it:

```
allowPatterns:
  - '^python -c "import json'
```

<a id="what-is-allowed-without-a-prompt"></a>
## What is allowed without a prompt

Because `onUnsupported` defaults to `allow`, these are released rather than
interrupted:

- a command whose target is dynamic (`Get-Content $path`, `rm -rf "$target"`),
  unless a dangerous switch is also visible;
- a script file or module run (`./deploy.sh`, `node script.js`, `python -m pytest`);
- a compound statement (`for …; do …; done`, `if …; fi`), whose body is skipped;
- a command line longer than `maxCommandLength`.

Set `onUnsupported: ask` to make each of those a prompt instead. That is the
fail-closed stance: it catches a dangerous command hidden behind a variable, and it
also prompts on a large share of ordinary work, which is why it is not the default.

<a id="known-limitations"></a>
## Known limitations

- **Script files are a blind spot.** The contents of `./deploy.sh`, `bash script.sh`
  or `pwsh -File x.ps1` cannot be read from a command line, so they are allowed —
  exactly as `pnpm test` or `make` are. The file sandbox and execution-time measures
  are the layers that cover this.
- **Only shell tools.** `write`, `edit`, `glob`, `grep` and MCP tools are not
  intercepted. Widen `tools` only if those tools expose a command string.
- **`never` approval policy.** Under a preset whose approval policy is `never` (for
  example the stock `danger-full-access`), an ask is deterministically rejected: the
  model is told which rule matched, and nothing executes.
- **Session pinning.** A preset change applies to new sessions, not to a running one.
- **No verdict cache.** A decision always re-reads the whole command text, so
  changing a dangerous argument is always re-examined. The cost is one synchronous,
  dependency-free analysis per call.
- **Layering.** A rule ask and a sandbox escalation are two independent seams and may
  each prompt once. A call approved here still passes the guard layer and the sandbox
  afterwards.

<a id="audit"></a>
## Audit

One JSONL line per non-allow decision:

```json
{"ts":"2026-11-14T10:00:00.000Z","sessionId":"session-1","tool":"pwsh","callId":"call-1","dialect":"powershell","verdict":"ask","ruleId":"pwsh-remove-recursive","command":"Remove-Item -Recurse ./build","reason":"rule-guard: matched \"pwsh-remove-recursive\" (powershell recursive removal); awaiting user approval for tool \"pwsh\""}
```

The file rotates at 2 MiB, keeping one previous generation. A failed write is
swallowed and reported through the logger; it never turns into a failed decision.

<a id="development"></a>
## Development

```powershell
node tests/run.js   # in-process test runner
node --test         # same suites, one child process per file
```

The suites cover the ported ZCode corpus (matched / not-matched / unsupported
three-state), the PowerShell and CMD rules, the splitters' boundaries, the decision
engine, and the plugin listener against a fake context — including the session gate,
so a preset other than the guarded one provably leaves the engine out of the path.
`tests/client-card.test.js` asserts the browser half's shape: that the card renders
every Config field, that its rule table agrees with the Host's catalog, that the two
halves agree on the row identity, and that the two dictionaries declare the same keys.

The tests import `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-home-paths`. At
runtime the host resolves both from the DSH installation, so the installed plugin
needs nothing else; for a local test run they must be resolvable from the working
directory (a `node_modules` link to the profile's or the installation's copy is
enough).

The browser half (`client.js`) cannot run under `node` — its module body references
`window`, which only exists in the browser. Its shape is guarded by
`tests/client-card.test.js`; the rendered card is verified by installing the bundle
and opening the row in **Plugins**.

<details>
<summary>Implementation notes</summary>

The two halves are deliberately separate: `index.js` owns the rules and the decision,
`client.js` owns the editing. They meet only on the Config field names and on the rule
ids, and `tests/client-card.test.js` asserts both.

The browser half cannot import `lib/catalog.js` — a client factory resolves only the
baseline modules — so `client.js` carries its own copy of the rule table. The test
compares the two sets and each label against the catalog title, which is what keeps a
new rule from becoming unswitchable.

The listener is appended rather than prepended, so a policy-driven listener such as the
Auto review layer, or any other gate registered with `prepend`, decides first and its
deny or ask wins. Unload drains any in-flight ask before the listener goes away, so no
prompt outlives the plugin that raised it.

</details>

<a id="attribution"></a>
## Attribution

The rule engine is derived from ZCode's guarded command matcher
(`apps/zcode-cli/packages/core/src/tool/handlers/guarded/` and its tests), which
is licensed under the Apache License, Version 2.0 and is © 2026 Z.AI Co., Ltd.
The ten derived files are listed in [NOTICE.md](NOTICE.md), and each carries the
upstream's copyright header plus a note of what changed. The Apache License 2.0
text is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Two further contracts are followed without copying code, and are recorded in the
same files: `lib/posix-splitter.js` reimplements the observable contract of
`unbash` (ISC, © Lars Kappert), and `lib/powershell.js` follows the rule families
documented for `dsh-ps-preflight`.

<a id="license"></a>
## License

This project's own code is MIT, © 2026 lliangworld.

The portions derived from ZCode are Apache-2.0 and remain subject to that
license's terms. [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) carries the
Apache License 2.0 text and the ISC text for `unbash`;
[NOTICE.md](NOTICE.md) lists which files are derived from what.
