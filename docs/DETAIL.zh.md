# 规则守卫

[English](DETAIL.md) | 中文

## 它做什么

规则守卫监听 DeepSeek Harness 的 `tools/pre-execute` 接缝。shell 工具执行前，命令文本只由本地规则判定——不联网、不调模型、不依赖任何外部服务。普通命令原样交给下一个监听器；命中规则的命令返回 `ask`，由宿主路由到**默认审批面板**。该面板没有倒计时，调用会一直等待用户判断。

插件是一道闸门，不是沙箱。它收窄"agent 不询问就能做什么"的边界；它不替代文件沙箱，也看不到脚本文件内部。

## 判定路径

```
工具调用
  → 工具名不在 `tools` 内                    → 放行
  → 参数里没有 `command` 字符串               → 放行
  → 命中 `allowPatterns`                     → 放行
  → 命中 `denyPatterns`                      → 拒绝（带结构化错误）
  → 命中内置规则                              → 询问
  → 命中 `askPatterns`                       → 询问
  → 无法给出静态结论                           → `onUnsupported`（默认放行）
  → 规则引擎自身抛错                           → `onError`（默认放行）
```

每条非放行判定都会追加写入 JSONL 审计文件。

## 规则族

POSIX（`bash`、`sh`，以及任何被推断为 POSIX 的工具）：

| 规则 | 命令形态 |
| --- | --- |
| `remove-critical-path` | `rm` 带 `-r`/`-R`/`--recursive`、`-f`/`--force`、多个目标或未引用通配符 |
| `find-delete` | `find … -delete` |
| `system-storage` | `dd`、`mount`、`umount`、`mkfs[.*]` |
| `rsync-delete` | 任一 `--delete*` 开关且非 dry-run |
| `git-reset-hard` | `git reset --hard` |
| `git-clean-force` | `git clean -f` 且非 dry-run |
| `git-push-force` | `--force`、`--force-with-lease`、`--mirror` 或 `+refspec` |
| `git-discard-tree` | `git checkout -f`、`checkout .`、`restore .` |
| `git-stash-clear` | `git stash clear` |
| `git-worktree-force-remove` | `git worktree remove --force` |

CMD（`cmd`，以及任何被推断为 CMD 的工具）：

| 规则 | 命令形态 |
| --- | --- |
| `cmd-remove-tree` | `rd /s`、`rmdir /s` |
| `cmd-delete-files` | `del`/`erase` 带递归、通配符或多个目标 |
| `robocopy-delete` | `robocopy /MIR` 或 `/PURGE` 且无 `/L` |
| 以及全部 POSIX 与 git 规则 | 同一套词法规则同样适用 |

PowerShell（`pwsh`、`powershell`，以及任何被推断为 PowerShell 的工具）：

| 规则 | 命令形态 |
| --- | --- |
| `pwsh-remove-recursive` | `Remove-Item -Recurse`（含别名），或 `-Recurse` 枚举喂给 `-Force` |
| `pwsh-dotnet-delete` | `[System.IO.Directory]::Delete`、`[System.IO.File]::Delete` |
| `pwsh-dynamic-exec` | `Invoke-Expression` / `iex`、`[ScriptBlock]::Create` |
| `pwsh-download-exec` | 下载命令与执行命令出现在同一条管道 |
| `pwsh-credential-read` | 读取 `.ssh/id_*`、`.aws/credentials`、`.env` 等 |
| `pwsh-credential-write` | 写入或复制到上述文件 |
| `pwsh-system-config` | 执行策略、注册表、账户、服务、磁盘、关机 |
| `pwsh-clear-recyclebin` | `Clear-RecycleBin -Force` |
| 以及全部 POSIX 与 git 规则 | PowerShell 行内的原生命令路由到共享匹配器 |

POSIX、CMD 与 git 规则移植自 ZCode 的 guarded matcher，它自带边界修复：未知选项不会撤销已识别的危险证据、wrapper 的未知选项使整条调用 unsupported、`--help` 拼写是查询退出、反转词（`--dry-run`、`-WhatIf`、`-Confirm`）降级而不命中。

## 配置

每个字段都在**插件**页 → `@lliangworld/dsh-rule-guard` → **规则守卫**这一行上编辑。
保存写入 profile 的用户层，对下一次调用生效，无需重启 Harness；与默认值相同的值会被清除
而不是保存，所以这一行只保留你真正改过的东西。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `tools` | `pwsh`、`bash`、`terminal`、`pwsh_persistent`、`bash_persistent`、`ops_bash` | 接管的工具名，每行一个 |
| `dialect` | `auto` | `auto` 按工具名推断方言；或强制 `posix`、`cmd`、`powershell` |
| `onUnsupported` | `allow` | 无法静态判定时 `allow` 或 `ask` |
| `onError` | `allow` | 规则引擎抛错时 `allow` 或 `ask` |
| `allowPatterns` | `[]` | 命中即放行的正则 |
| `askPatterns` | `[]` | 命中即询问的正则（内置规则未命中时也生效） |
| `denyPatterns` | `[]` | 命中即拒绝的正则 |
| `maxCommandLength` | `10000` | 参与判定的最长命令文本，取值 1000–100000 |
| `audit` | `true` | 记录每条非放行判定 |
| `auditPath` | `''` | 为空时用 `$DSH_HOME/rule-guard-audit.jsonl` |

所有字段都是 volatile，改配置对下一次调用生效，无需重启 Harness。默认值全部来自插件的
schema——本 bundle 的 patch 只声明这一行本身，profile 里没有任何东西遮蔽它们。

### 减少弹卡

命中规则一定会弹卡；要豁免某条内置规则，只能为你信任的确切形态加一条
`allowPatterns`：

```
allowPatterns:
  - '^python -c "import json'
```

### 哪些情况不会弹卡

由于 `onUnsupported` 默认为 `allow`，以下情形直接放行，不会打断：

- 目标是变量的命令（`Get-Content $path`、`rm -rf "$target"`），除非同时还能看到危险开关；
- 脚本文件或模块运行（`./deploy.sh`、`node script.js`、`python -m pytest`）；
- 复合语句（`for …; do …; done`、`if …; fi`），其函数体被整体跳过；
- 超过 `maxCommandLength` 的命令行。

把 `onUnsupported` 设为 `ask` 可以让上述每一种都改为弹卡。那是 fail-closed
姿态：它能抓住藏在变量后面的危险命令，但也会对相当一部分日常工作弹卡，因此
不是默认值。

## 已知边界

- **脚本文件是盲区。** `./deploy.sh`、`bash script.sh`、`pwsh -File x.ps1` 的内容无法从命令行读到，因此会放行——与 `pnpm test`、`make` 同理。覆盖这一层的是文件沙箱与执行期措施。
- **只管 shell 工具。** `write`、`edit`、`glob`、`grep` 与 MCP 工具不在拦截范围。只有当这些工具暴露命令字符串时，扩大 `tools` 才有意义。
- **`never` 审批策略。** 在审批策略为 `never` 的预设下（例如自带的 `danger-full-access`），ask 会被确定性地拒绝：模型被告知命中了哪条规则，命令不会执行。
- **会话 pin。** 改预设只影响新会话，不影响正在运行的会话。
- **无判定缓存。** 每次判定都重读整条命令文本，改过的危险参数一定会重新检查。代价是每次调用一次同步、零依赖的分析。
- **层叠。** 规则询问与沙箱越权是两条独立接缝，可能各弹一次。这里被批准的命令，之后仍要过 guard 层与沙箱。

## 审计

每条非放行判定一行 JSONL：

```json
{"ts":"2026-11-14T10:00:00.000Z","sessionId":"session-1","tool":"pwsh","callId":"call-1","dialect":"powershell","verdict":"ask","ruleId":"pwsh-remove-recursive","command":"Remove-Item -Recurse ./build","reason":"rule-guard: matched \"pwsh-remove-recursive\" (powershell recursive removal); awaiting user approval for tool \"pwsh\""}
```

文件达到 2 MiB 轮转，保留上一个世代。写入失败会被吞掉并经 logger 报告，绝不会把一次判定变成失败。
