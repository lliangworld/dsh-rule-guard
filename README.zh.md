# @lliangworld/dsh-rule-guard

[English](README.md) | 中文

DeepSeek Harness 的纯本地命令规则守卫。它拦截 agent 的执行命令，只用本地规则判定：普通调用原样放行，命中规则的命令交给宿主默认审批面板——没有倒计时，调用一直等待用户判断。

规则引擎无法静态判定的命令（动态目标、脚本文件、复合语句、超长输入）默认直接放行，因此只有确切的规则命中才会打断 agent。把 `onUnsupported` 设为 `ask` 可改为 fail-closed 姿态。

完整行为、规则表、配置与已知边界：[DETAIL.md](docs/DETAIL.md) / [DETAIL.zh.md](docs/DETAIL.zh.md)

## 配置

打开**插件**页 → `@lliangworld/dsh-rule-guard` → **规则守卫**。这一行带一张配置卡片，列出全部字段：

- **受管工具**——本守卫接管的工具名，每行一个。
- **命令方言**——`Auto`、`POSIX`、`CMD` 或 `PowerShell`。
- **无法静态判定时**——`放行`（默认）或`询问`。
- **规则引擎失败时**——`放行`（默认）或`询问`。
- **命令长度上限**、**审计日志路径**、**记录判定**。
- **规则正则**——放行、询问、拒绝三组，每行一条正则表达式。

保存后对下一次调用生效，无需重启 Harness：所有字段都是 volatile，且与默认值相同的值会被清除而不是保存。卡片文案跟随界面语言（内置英文与简体中文）。

## 安装

在 DeepSeek Harness 的**插件**页把本目录作为 bundle 添加。没有构建步骤：整个包就是纯 ESM 加一份 YAML patch。

```powershell
dsh plugin --profile desktop add E:\programData\dsh\default-workspace\dsh-rule-guard
```

插件在下个会话生效。先在**插件**页确认这一行，再在新会话里验证 `tools/pre-execute` 行为。

## 权限预设

ask 需要审批策略为 `ask`。自带的 `workspace-write` 预设正是如此，无需额外配置。若想要"沙箱全开 + 命中询问"，在自己的 profile `cordis.patch.yml` 里加一个预设（profile 层在 bundle 层之后应用，bundle 里的预设补丁会被覆盖）：

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

在 `never`（自带的 `danger-full-access`）下，ask 会被确定性地拒绝，模型会被告知命中了哪条规则。

## 开发

```powershell
node tests/run.js   # 进程内测试运行器
node --test         # 同一批用例，每个文件一个子进程
```

测试覆盖：移植的 ZCode 语料（matched / notMatched / unsupported 三态）、PowerShell 与 CMD 规则、拆分器的边界、决策引擎，以及用假 context 驱动插件监听器的集成用例。`tests/client-card.test.js` 守住浏览器半的形状：卡片渲染了每一个 Config 字段、两个半部对 row 身份达成一致、两份字典声明同样的键。

测试导入 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-home-paths`。运行时宿主从 DSH 安装目录解析这两个包，安装后的插件不需要额外依赖；本地跑测试时需要它们能从工作目录解析到（把 profile 或安装目录里的副本链接成 `node_modules` 即可）。

浏览器半（`client.js`）无法在 `node` 下运行——它的模块体引用 `window`，那只存在于浏览器里。它的形状由 `tests/client-card.test.js` 守住；渲染结果靠安装 bundle 后在**插件**页打开这一行来验证。

## 致谢

POSIX、CMD 与 git 规则体移植自 ZCode 的 guarded matcher
（`apps/zcode-cli/packages/core/src/tool/handlers/guarded/`），本插件保留了它的注释与对抗测试语料。PowerShell 规则族参照 `dsh-ps-preflight` 文档化的分类方式。

## 许可

MIT
