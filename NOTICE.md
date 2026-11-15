# Notice for @lliangworld/dsh-rule-guard

This project is © 2026 lliangworld and is licensed under the MIT License; see
`LICENSE`.

## Derived code

The following files are derived from ZCode's guarded command matcher, which is
licensed under the Apache License, Version 2.0 and is © 2026 Z.AI Co., Ltd. Each
of these files carries ZCode's own copyright and license header at its top,
together with a notice of the changes made here.

| File | Derived from |
| --- | --- |
| `lib/word.js` | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/word.ts` |
| `lib/options.js` | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/options.ts` |
| `lib/cmd.js` | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/cmd.ts` |
| `lib/git.js` | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/git.ts` |
| `lib/find.js` | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/find.ts` |
| `lib/wrappers.js` | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/wrappers.ts` |
| `lib/windows-delete.js` | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/windows-delete.ts` |
| `lib/posix.js` | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.ts` |
| `tests/analyze.test.js` | `apps/zcode-cli/packages/core/tests/guarded-command.test.ts` |
| `tests/cmd-rules.test.js` | `apps/zcode-cli/packages/core/tests/guarded-deletion.test.ts` |

The changes made here are recorded per file in the `Modified by` line of each
header: a conversion from TypeScript to JavaScript, localization of rule ids and
user-facing text, adaptation to this bundle's `tools/pre-execute` seam, and a
rewrite of the test corpus to `node:test`. The Apache License 2.0 text is
reproduced in full in `THIRD-PARTY-NOTICES.md`.

## Retained upstream notice

Apache-2.0 §4(d) requires a derivative work to carry a readable copy of the
attribution notices in the upstream's `NOTICE` file that pertain to the derived
parts. ZCode's `NOTICE.md` states, for its first-party code:

> 本仓库第一方代码依照根 LICENSE 采用 Apache-2.0；该许可不替其他权利人新增授权，
> 也不覆盖第三方软件、复制代码、原生二进制、字体、图标、网页素材及其他资源的独立条款。

That is the notice that pertains to the guarded matcher, and it is the one
retained here. The remaining sections of ZCode's `NOTICE.md` describe product
behavior — AI output risk, telemetry, credential storage, upload endpoints — that
does not pertain to the derived command matcher, and are excluded under the
§4(d) allowance for notices that do not pertain to any part of the derivative
work.

## Reimplemented contracts

- `lib/posix-splitter.js` reimplements the observable contract of the `unbash`
  package (ISC, © Lars Kappert), which ZCode uses for POSIX splitting. No
  `unbash` code is redistributed here; the ISC text is reproduced in
  `THIRD-PARTY-NOTICES.md` because the contract is followed.

- `lib/powershell.js` follows the rule families documented for
  `dsh-ps-preflight`. No code from that project is copied.

- `client.js` follows conventions from the `dsh-web-search-keenable` settings
  card. No code from that project is copied.
