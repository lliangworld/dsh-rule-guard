# @lliangworld/dsh-rule-guard

English | [中文](README.zh.md)

A pure-local command rule guard for DeepSeek Harness. It intercepts the agent's
shell commands and judges them with local rules only: an ordinary call passes
through untouched, and a command that matches a rule is put to the user through
the host's default approval panel — with no countdown, so the call waits for as
long as the user needs.

Commands the engine cannot judge statically (dynamic targets, script files,
compound statements, over-long input) are released by default, so only a
confident rule match interrupts the agent. Set `onUnsupported: ask` for the
fail-closed stance instead.

Full behavior, rule tables, configuration and limitations:
[DETAIL.md](docs/DETAIL.md) / [DETAIL.zh.md](docs/DETAIL.zh.md)

## Configure

Open **Plugins** → `@lliangworld/dsh-rule-guard` → **Rule guard**. The row
carries a configuration card with every field:

- **Guarded tools** — the tool names this guard takes over, one per line.
- **Command dialect** — `Auto`, `POSIX`, `CMD` or `PowerShell`.
- **When a command cannot be judged** — `Allow` (default) or `Ask`.
- **When the rule engine fails** — `Allow` (default) or `Ask`.
- **Command length cap**, **Audit log path**, **Record decisions**.
- **Rule patterns** — allow, ask and deny, one regular expression per line.

A save reaches the next command without restarting the harness: every field is
volatile, and a value identical to the default is cleared rather than stored.
The card's copy follows the interface language (English and Simplified Chinese
are shipped).

## Install

From the DeepSeek Harness **Plugins** page, add this local directory as a
bundle. No build step runs: the package is plain ESM plus one YAML patch.

```powershell
dsh plugin --profile desktop add E:\programData\dsh\default-workspace\dsh-rule-guard
```

The plugin takes effect on the next session. Verify the row in **Plugins**, then
check `tools/pre-execute` behavior in a new session.

## Permission presets

An ask needs an approval policy of `ask`. The stock `workspace-write` preset
already is one, so nothing extra is required. If you want full sandbox access
*and* the guard's prompts, add a preset to your profile's own
`cordis.patch.yml` (a profile layer is applied after bundle layers, so a
bundle-level patch would be overridden):

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

Under `never` (the stock `danger-full-access`), an ask is rejected
deterministically and the model is told which rule matched.

## Development

```powershell
node tests/run.js   # in-process test runner
node --test         # same suites, one child process per file
```

The suites cover the ported ZCode corpus (matched / not-matched / unsupported
three-state), the PowerShell and CMD rules, the splitters' boundaries, the
decision engine, and the plugin listener against a fake context.
`tests/client-card.test.js` asserts the browser half's shape: that the card
renders every Config field, that the two halves agree on the row identity, and
that the two dictionaries declare the same keys.

The tests import `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-home-paths`.
At runtime the host resolves both from the DSH installation, so the installed
plugin needs nothing else; for a local test run they must be resolvable from
the working directory (a `node_modules` link to the profile's or the
installation's copy is enough).

The browser half (`client.js`) cannot run under `node` — its module body
references `window`, which only exists in the browser. Its shape is guarded by
`tests/client-card.test.js`; the rendered card is verified by installing the
bundle and opening the row in **Plugins**.

## Attribution

The POSIX, CMD and git rule bodies are ported from ZCode's guarded matcher
(`apps/zcode-cli/packages/core/src/tool/handlers/guarded/`), whose comments and
adversarial test corpus this plugin keeps. The PowerShell families follow the
classification documented for `dsh-ps-preflight`.

## License

MIT
