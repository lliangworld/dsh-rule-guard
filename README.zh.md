# @lliangworld/dsh-rule-guard

[English](README.md) | 中文

DeepSeek Harness 的纯本地命令规则守卫。它监听 `tools/pre-execute`：普通命令原样交给下一个监听器，命中危险形态的命令返回 `ask`，由宿主路由到**默认审批面板**——没有倒计时，调用会一直等待你判断。不联网、不调模型、不依赖任何外部服务。

插件是一道闸门，不是沙箱。它收窄"agent 不询问就能做什么"的边界；它不替代文件沙箱，也看不到脚本文件内部。

**默认只守卫会询问你的那些会话**——有效权限为「全沙箱 + `ask`」，也就是 `guarded-full` 预设所设的值。其他预设的行为与之前完全一致。把**全局生效**开关打开，则改为守卫所有会话。详见[生效范围](#生效范围)。

## 目录

- [生效范围](#生效范围)
- [安装](#安装)
- [配置](#配置)
- [判定路径](#判定路径)
- [内置规则](#内置规则)
- [自定义规则正则](#自定义规则正则)
- [不会弹卡的情形](#不会弹卡的情形)
- [已知边界](#已知边界)
- [审计](#审计)
- [开发](#开发)
- [致谢](#致谢)
- [许可](#许可)

-----

<a id="生效范围"></a>
## 生效范围

除非会话的有效权限会询问用户，否则守卫完全 inert。审批策略为 `never` 的预设会确定性地拒绝 `ask`——模型被告知命中了哪条规则，命令不会执行——所以那种预设下守卫只可能产生一个没有提示的拒绝。沙箱更窄的预设本身已经收紧了调用边界。

因此守卫只在两个有效旋钮读作**全沙箱 + `ask`** 时激活，这正是 `guarded-full` 预设所设的值。按有效旋钮判定而不是按预设名，意味着预设表里没有这个名字时守卫依然有效——包括手工拨出来的组合，权限服务会把它报成 `custom`。

### 预设由插件托管

默认情况下，本插件启用期间会自动往预设表里加入 `guarded-full`，无需手工编辑。写入落在你自己 profile 的 `cordis.patch.yml`——也就是你本来会手工改的那个文件，走的是**插件**页写任何其他设置的同一条路径——因此始终可见、可 review。

在 composer 的权限选择器里选**守卫式全权限**，或执行 `/permission guarded-full`。

托管刻意只做三件事：

- **只增删 `guarded-full` 这一项。** 该行 config 里的其他键——自带预设、`defaultPreset`——都原样带回，因为 patch 的 `config` 是*整块替换，绝不深合并*。
- **槽位的键就是身份。** `guarded-full` 下面无论放什么，都是本插件的地盘：加、改名、删都归它管。想要自己的预设，就用**另一个键**，本插件从不碰。
- **禁用插件时会再把它移除**，而且移得很干净：整个 `permission` 行会消失，因为剩下的内容与 bundle 层已提供的一致。你的有效配置没有任何变化，重新启用时两者都会回来。

**预设名跟随语言。** 中文宿主下显示「守卫式全权限」，英文宿主下显示 *Guarded full access*，在设置里切换语言后立即更新，无需重装插件。权限客户端不会本地化配置的预设——只有三个内置键有翻译——所以这是由插件把对应语言的文案写进预设自己的 `name`。

什么线索都没有时，用宿主自己的语言判断。因此浏览器语言与操作系统不一致时不会被采纳，预设名会落到英文。

**两处选择器立即跟随。** 启用插件后，设置页的「选择新会话的默认权限模式」和输入框的权限选择器里立刻出现该预设，无需重启；禁用时两处同时消失。权限客户端会缓存目录，只监听 `permission-presets/catalog-changed`——而 `permissionPresets` 自己只在 `registerAuto` 时发这个信号，配置变更从不发——所以插件在每次写入落定后补发一次。除此之外没有任何东西需要重启。

**卸载插件不会移除它。** bundle 是先禁用再删包的，所以移除在禁用阶段就已触发，随后那次写入会在 reconcile 中丢失。预设会留着，指向一个已经不在的插件。这没有危害——守卫随插件一起卸载了，预设只是静静待在那里；重新安装插件时也会发现它已在。想手工移除，从 profile patch 的 `permission` 行里删掉 `guarded-full` 即可。

### 自己维护预设

在本插件的配置行把**托管守卫式全权限预设**关掉即可退出托管。然后在自己的 profile `cordis.patch.yml` 里加：

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
        name: "守卫式全权限"
        description: "沙箱全开；危险命令命中规则时询问用户。"
    defaultPreset: workspace-write
```

这段配置不能放在本 bundle 的 patch 里。组合说明写得很明确：patch 的 `config` 是*整块替换，绝不深合并*。你的 profile 已经用自己的预设表 patch 了 `permission` 行，而 profile 层在 bundle 层之后应用——所以加在那里的预设会被静默丢掉。本 bundle 的 patch 故意不 patch 这一行：只写 `guarded-full` 会把自己没 patch 该行的 profile 里的 `workspace-write` 和 `danger-full-access` 两个预设抹掉。

改预设只影响新会话，不影响正在运行的会话。

要无视预设、沙箱和审批策略守卫所有会话，把**全局生效**开关打开即可。这是唯一能解除上述条件的手段；预设是这件事的另一半。

<a id="安装"></a>
## 安装

在 DeepSeek Harness 的**插件**页把本仓库作为 bundle 添加。没有构建步骤：整个包就是纯 ESM 加一份 YAML patch。

```powershell
dsh plugin --profile desktop add github:lliangworld/dsh-rule-guard
```

插件在下个会话生效。先在**插件**页确认这一行，再在新会话里验证 `tools/pre-execute` 行为。

<a id="配置"></a>
## 配置

打开**插件**页 → `@lliangworld/dsh-rule-guard` → **规则守卫**。每个字段都在这一行上编辑：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `global` | `false` | 关闭只守卫上文所述会话；开启则守卫所有会话 |
| `managePreset` | `true` | 开启时本插件启用期间自动加入 `guarded-full` 预设、禁用时自动移除；拨动此开关本身也会立即移除或加回该预设，无需重启；关闭则由你自己维护预设表 |
| `tools` | `pwsh`、`bash`、`terminal`、`pwsh_persistent`、`bash_persistent`、`ops_bash` | 接管的工具名，每行一个 |
| `dialect` | `auto` | `auto` 按工具名推断方言；或强制 `posix`、`cmd`、`powershell` |
| `onUnsupported` | `allow` | 无法静态判定时 `allow` 或 `ask` |
| `onError` | `allow` | 规则引擎抛错时 `allow` 或 `ask` |
| `maxCommandLength` | `10000` | 参与判定的最长命令文本，取值 1000–100000 |
| `audit` | `true` | 记录每条非放行判定 |
| `auditPath` | `''` | 为空时用 `$DSH_HOME/rule-guard-audit.jsonl` |
| `disabledRules` | `[]` | 关闭的内置规则 id；命中即放行、不再询问 |
| `allowPatterns` | `[]` | 命中即放行的正则 |
| `askPatterns` | `[]` | 命中即询问的正则（内置规则未命中时也生效） |
| `denyPatterns` | `[]` | 命中即拒绝的正则 |

最后两组放在折叠按钮后面，因为它们通常只配一次：**内置规则**组每条规则一个开关，**自定义规则正则**组是三个正则列表。卡片文案跟随界面语言（内置英文与简体中文）。

保存写入 profile 的用户层，对下一次调用生效，无需重启 Harness；与默认值相同的值会被清除而不是保存，所以这一行只保留你真正改过的东西。默认值全部来自插件的 schema——本 bundle 的 patch 只声明这一行本身，profile 里没有任何东西遮蔽它们。

<a id="判定路径"></a>
## 判定路径

```
工具调用
  → 工具名不在 `tools` 内                    → 放行
  → 参数里没有 `command` 字符串               → 放行
  → 本会话不适用守卫                          → 放行
  → 命中 `allowPatterns`                     → 放行
  → 命中 `denyPatterns`                      → 拒绝（带结构化错误）
  → 命中被关闭的内置规则                       → 放行（审计记 rule-disabled）
  → 命中内置规则                              → 询问
  → 命中 `askPatterns`                       → 询问
  → 无法给出静态结论                           → `onUnsupported`（默认放行）
  → 规则引擎自身抛错                           → `onError`（默认放行）
```

每条非放行判定都会追加写入 JSONL 审计文件。

<a id="内置规则"></a>
## 内置规则

四方言共二十一条规则。配置卡片的**内置规则**组里每条规则各有一个开关；关掉某条规则后，命中它的命令直接放行，审计仍会记录这条规则命中过且被关闭。

POSIX（`bash`、`sh`，以及任何被推断为 POSIX 的工具）：

| 规则 | 命令形态 |
| --- | --- |
| `remove-critical-path` | `rm` 带 `-r`/`-R`/`--recursive`、`-f`/`--force`、多个目标或未引用通配符 |
| `find-delete` | `find … -delete` |
| `system-storage` | `dd`、`mount`、`umount`、`mkfs[.*]` |
| `rsync-delete` | 任一 `--delete*` 开关且非 dry-run |

git（所有方言通用）：

| 规则 | 命令形态 |
| --- | --- |
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

<a id="自定义规则正则"></a>
## 自定义规则正则

三组正则，每组每行一条，都针对整条命令文本匹配。`allowPatterns` 命中即放行，`askPatterns` 在内置规则未命中时也询问，`denyPatterns` 命中即拒绝。

命中规则一定会弹卡；要豁免某条内置规则，用它自己的开关；要豁免某个确切形态，加一条 `allowPatterns`：

```
allowPatterns:
  - '^python -c "import json'
```

<a id="不会弹卡的情形"></a>
## 不会弹卡的情形

由于 `onUnsupported` 默认为 `allow`，以下情形直接放行，不会打断：

- 目标是变量的命令（`Get-Content $path`、`rm -rf "$target"`），除非同时还能看到危险开关；
- 脚本文件或模块运行（`./deploy.sh`、`node script.js`、`python -m pytest`）；
- 复合语句（`for …; do …; done`、`if …; fi`），其函数体被整体跳过；
- 超过 `maxCommandLength` 的命令行。

把 `onUnsupported` 设为 `ask` 可以让上述每一种都改为弹卡。那是 fail-closed 姿态：它能抓住藏在变量后面的危险命令，但也会对相当一部分日常工作弹卡，因此不是默认值。

<a id="已知边界"></a>
## 已知边界

- **脚本文件是盲区。** `./deploy.sh`、`bash script.sh`、`pwsh -File x.ps1` 的内容无法从命令行读到，因此会放行——与 `pnpm test`、`make` 同理。覆盖这一层的是文件沙箱与执行期措施。
- **只管 shell 工具。** `write`、`edit`、`glob`、`grep` 与 MCP 工具不在拦截范围。只有当这些工具暴露命令字符串时，扩大 `tools` 才有意义。
- **`never` 审批策略。** 在审批策略为 `never` 的预设下（例如自带的 `danger-full-access`），ask 会被确定性地拒绝：模型被告知命中了哪条规则，命令不会执行。
- **会话 pin。** 改预设只影响新会话，不影响正在运行的会话。
- **无判定缓存。** 每次判定都重读整条命令文本，改过的危险参数一定会重新检查。代价是每次调用一次同步、零依赖的分析。
- **层叠。** 规则询问与沙箱越权是两条独立接缝，可能各弹一次。这里被批准的命令，之后仍要过 guard 层与沙箱。

<a id="审计"></a>
## 审计

每条非放行判定一行 JSONL：

```json
{"ts":"2026-11-14T10:00:00.000Z","sessionId":"session-1","tool":"pwsh","callId":"call-1","dialect":"powershell","verdict":"ask","ruleId":"pwsh-remove-recursive","command":"Remove-Item -Recurse ./build","reason":"rule-guard: matched \"pwsh-remove-recursive\" (powershell recursive removal); awaiting user approval for tool \"pwsh\""}
```

文件在 2 MiB 处轮转，保留上一代。写入失败会被吞掉并通过 logger 上报，绝不会让判定失败。

<a id="开发"></a>
## 开发

```powershell
node tests/run.js   # 进程内测试运行器
node --test         # 同一批用例，每个文件一个子进程
```

测试覆盖：移植的 ZCode 语料（matched / notMatched / unsupported 三态）、PowerShell 与 CMD 规则、拆分器的边界、决策引擎，以及用假 context 驱动插件监听器的集成用例——含会话门禁，因此可以证明守卫式全权限以外的预设确实让引擎完全不在路径上。`tests/client-card.test.js` 守住浏览器半的形状：卡片渲染了每一个 Config 字段、卡片规则表与 Host 的 catalog 一致、两个半部对 row 身份达成一致、两份字典声明同样的键。

测试导入 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-home-paths`。运行时宿主从 DSH 安装目录解析这两个包，安装后的插件不需要额外依赖；本地跑测试时需要它们能从工作目录解析到（把 profile 或安装目录里的副本链接成 `node_modules` 即可）。

浏览器半（`client.js`）无法在 `node` 下运行——它的模块体引用 `window`，那只存在于浏览器里。它的形状由 `tests/client-card.test.js` 守住；渲染结果靠安装 bundle 后在**插件**页打开这一行来验证。

<details>
<summary>实现说明</summary>

两个半部刻意分开：`index.js` 拥有规则与判定，`client.js` 负责编辑。它们只在 Config 字段名和规则 id 上相遇，而这两点都由 `tests/client-card.test.js` 断言。

浏览器半无法导入 `lib/catalog.js`——client factory 只解析基线模块——所以 `client.js` 自带一份规则表。测试比对两个集合，并逐条比对标签与 catalog 标题，这正是防止新规则变得不可开关的机制。

监听器是 append 而不是 prepend，因此像 Auto review 这样的策略型监听器，或任何以 `prepend` 注册的其他闸门，会先判定，它的 deny 或 ask 优先。卸载时会先排空在途的 ask，再撤掉监听器，因此没有提示会比提出它的插件活得更久。

</details>

<a id="致谢"></a>
## 致谢

规则引擎衍生自 ZCode 的 guarded matcher
（`apps/zcode-cli/packages/core/src/tool/handlers/guarded/` 及其测试），采用
Apache License 2.0，© 2026 Z.AI Co., Ltd。十个衍生文件列在
[NOTICE.md](NOTICE.md) 中，每个文件顶部都带上游版权头与改动说明。
Apache License 2.0 全文见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

另有两项契约只参照、未复制代码，同样记录在上述两个文件中：
`lib/posix-splitter.js` 重新实现了 `unbash`（ISC，© Lars Kappert）的可观察契约；
`lib/powershell.js` 参照 `dsh-ps-preflight` 文档化的规则族分类。

<a id="许可"></a>
## 许可

本项目自有代码为 MIT，© 2026 lliangworld。

衍生自 ZCode 的部分为 Apache-2.0，仍受该许可条款约束。
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 收录 Apache License 2.0 全文与
`unbash` 的 ISC 文本；[NOTICE.md](NOTICE.md) 列出哪些文件衍生自什么。
