/**
 * Rule catalog: what each rule id means, in the user's language.
 *
 * The model-facing `reason` is English so it is stable in transcripts and
 * audit logs; the approval panel's `displayReason` carries both locales so the
 * user reads their own language. Every entry states the effect and, where a
 * safer spelling exists, how to avoid the prompt.
 *
 * `displayReason` is the panel's headline only. The panel draws the command
 * itself, so the headline must leave it out — see {@link displayReason}.
 *
 * @module dsh-rule-guard/catalog
 */

/** One rule's presentation text. */
const CATALOG = {
	'remove-critical-path': {
		zh: { title: '递归或批量删除', detail: 'rm 带 -r/-R/--recursive、-f/--force、多个目标或通配符，可一次删除大量文件。' },
		en: { title: 'Recursive or batch removal', detail: 'rm with -r/-R/--recursive, -f/--force, multiple targets or a glob can delete many files at once.' },
	},
	'find-delete': {
		zh: { title: 'find 删除动作', detail: 'find 的 -delete 会按匹配结果删除文件。' },
		en: { title: 'find delete action', detail: "find's -delete removes every file the expression matches." },
	},
	'system-storage': {
		zh: { title: '磁盘/挂载操作', detail: 'dd、mount、umount、mkfs 直接改写块设备或挂载表，可能造成数据丢失。' },
		en: { title: 'Disk or mount operation', detail: 'dd, mount, umount and mkfs write block devices or the mount table directly and can destroy data.' },
	},
	'rsync-delete': {
		zh: { title: 'rsync 删除同步', detail: 'rsync 的 --delete 系列会让目标目录与源目录完全一致，多出的文件被删除。' },
		en: { title: 'rsync delete sync', detail: "rsync's --delete family makes the destination match the source exactly, removing extra files." },
	},
	'git-reset-hard': {
		zh: { title: 'git 历史重写', detail: 'git reset --hard 丢弃工作区与暂存区的全部改动。' },
		en: { title: 'git history reset', detail: 'git reset --hard discards every working-tree and staged change.' },
	},
	'git-clean-force': {
		zh: { title: 'git 强制清理', detail: 'git clean -f 删除未跟踪文件；-x 连被忽略的文件一起删除。' },
		en: { title: 'git force clean', detail: 'git clean -f removes untracked files; -x also removes ignored ones.' },
	},
	'git-push-force': {
		zh: { title: 'git 强制推送', detail: 'git push --force / --force-with-lease / --mirror 或 +refspec 会覆盖远端历史。' },
		en: { title: 'git force push', detail: 'git push --force / --force-with-lease / --mirror or a +refspec overwrites remote history.' },
	},
	'git-discard-tree': {
		zh: { title: 'git 丢弃改动', detail: 'git checkout -f / checkout . / restore . 会用索引或提交内容覆盖工作区文件。' },
		en: { title: 'git discard changes', detail: 'git checkout -f / checkout . / restore . overwrites working-tree files from the index or a commit.' },
	},
	'git-stash-clear': {
		zh: { title: 'git 清空暂存', detail: 'git stash clear 永久删除全部 stash 记录，无法恢复。' },
		en: { title: 'git stash clear', detail: 'git stash clear permanently removes every stash entry; it cannot be undone.' },
	},
	'git-worktree-force-remove': {
		zh: { title: 'git 强制删除工作树', detail: 'git worktree remove --force 会丢弃该工作树里的未提交改动。' },
		en: { title: 'git force worktree remove', detail: 'git worktree remove --force discards uncommitted changes in that worktree.' },
	},
	'cmd-remove-tree': {
		zh: { title: 'CMD 递归删目录', detail: 'rd /s、rmdir /s 递归删除目录树。' },
		en: { title: 'CMD recursive directory removal', detail: 'rd /s and rmdir /s remove a directory tree recursively.' },
	},
	'cmd-delete-files': {
		zh: { title: 'CMD 批量删文件', detail: 'del /s、erase /s 递归删除匹配的文件。' },
		en: { title: 'CMD batch file deletion', detail: 'del /s and erase /s remove matching files recursively.' },
	},
	'robocopy-delete': {
		zh: { title: 'Robocopy 镜像删除', detail: 'robocopy /MIR 或 /PURGE 会删除目标目录中源里不存在的文件。' },
		en: { title: 'Robocopy mirror deletion', detail: 'robocopy /MIR or /PURGE deletes destination files that are absent from the source.' },
	},
	'pwsh-remove-recursive': {
		zh: { title: 'PowerShell 递归删除', detail: 'Remove-Item -Recurse（含别名 rm/del/rd）递归删除目标；管道上游是 -Recurse 枚举时 -Force 同样命中。' },
		en: { title: 'PowerShell recursive removal', detail: 'Remove-Item -Recurse (aliases rm/del/rd included) deletes recursively; -Force also matches when a -Recurse enumeration feeds the pipeline.' },
	},
	'pwsh-dotnet-delete': {
		zh: { title: '.NET 直接删除', detail: '[System.IO.Directory]::Delete / [System.IO.File]::Delete 绕过 cmdlet 的确认与回收站。' },
		en: { title: '.NET direct deletion', detail: '[System.IO.Directory]::Delete and [System.IO.File]::Delete bypass cmdlet confirmation and the recycle bin.' },
	},
	'pwsh-dynamic-exec': {
		zh: { title: '动态执行字符串', detail: 'Invoke-Expression / iex / [ScriptBlock]::Create 把字符串当代码执行，内容不可静态判定。' },
		en: { title: 'Dynamic string execution', detail: 'Invoke-Expression / iex / [ScriptBlock]::Create run a string as code, which cannot be judged statically.' },
	},
	'pwsh-download-exec': {
		zh: { title: '下载后立即执行', detail: '下载命令（iwr/irm/curl/Start-BitsTransfer）与执行命令（iex/&/Start-Process）出现在同一条管道里。' },
		en: { title: 'Download and execute', detail: 'A download command (iwr/irm/curl/Start-BitsTransfer) and an execution command (iex/&/Start-Process) appear in one pipeline.' },
	},
	'pwsh-credential-read': {
		zh: { title: '读取凭据文件', detail: '命令读取 SSH 私钥、.aws/credentials、.env 等敏感文件。' },
		en: { title: 'Credential file read', detail: 'The command reads a sensitive file such as an SSH private key, .aws/credentials or .env.' },
	},
	'pwsh-credential-write': {
		zh: { title: '写入凭据文件', detail: '命令写入或复制到 SSH 私钥、.aws/credentials、.env 等敏感文件。' },
		en: { title: 'Credential file write', detail: 'The command writes or copies into a sensitive file such as an SSH private key, .aws/credentials or .env.' },
	},
	'pwsh-system-config': {
		zh: { title: '系统或权限配置', detail: '命令修改执行策略、注册表、账户、服务、磁盘或关机设置。' },
		en: { title: 'System or permission configuration', detail: 'The command changes the execution policy, registry, accounts, services, disks or shutdown settings.' },
	},
	'pwsh-clear-recyclebin': {
		zh: { title: '清空回收站', detail: 'Clear-RecycleBin -Force 永久删除回收站内容。' },
		en: { title: 'Recycle bin cleared', detail: 'Clear-RecycleBin -Force permanently removes the recycle bin contents.' },
	},
	'command-too-long': {
		zh: { title: '命令过长', detail: '命令超过长度上限，规则引擎不对超长输入做判定。' },
		en: { title: 'Command too long', detail: 'The command exceeds the length limit, so the rule engine does not judge over-long input.' },
	},
	'user-allow-pattern': {
		zh: { title: '用户白名单', detail: '命令命中 allowPatterns，按配置放行。' },
		en: { title: 'User allow pattern', detail: 'The command matches allowPatterns and is allowed by configuration.' },
	},
	'user-ask-pattern': {
		zh: { title: '用户询问规则', detail: '命令命中 askPatterns，按配置询问。' },
		en: { title: 'User ask pattern', detail: 'The command matches askPatterns and asks by configuration.' },
	},
	'user-deny-pattern': {
		zh: { title: '用户拒绝规则', detail: '命令命中 denyPatterns，按配置拒绝。' },
		en: { title: 'User deny pattern', detail: 'The command matches denyPatterns and is denied by configuration.' },
	},
	'analysis-error': {
		zh: { title: '规则引擎内部错误', detail: '分析过程抛出异常，按 fail-closed 策略询问。' },
		en: { title: 'Rule engine internal error', detail: 'The analysis threw, so the fail-closed policy asks.' },
	},
	'no-static-verdict': {
		zh: { title: '无法静态判定', detail: '命令包含变量展开、脚本文件、复合语句或引擎不认识的语法，无法给出纯规则结论。' },
		en: { title: 'No static verdict', detail: 'The command contains expansions, script files, compound statements or syntax this engine does not model, so no pure-rule verdict is possible.' },
	},
}

/**
 * The presentation text for one rule id.
 *
 * @param {string} ruleId - the rule id that fired.
 * @returns {{ zh: { title: string, detail: string }, en: { title: string, detail: string } }} the bilingual text.
 */
export function ruleText(ruleId) {
	return (
		CATALOG[ruleId] ?? {
			zh: { title: '未知规则', detail: `规则 ${ruleId} 没有文案。` },
			en: { title: 'Unknown rule', detail: `Rule ${ruleId} has no text.` },
		}
	)
}

/**
 * The model-facing reason recorded for one decision.
 *
 * @param {string} ruleId - the rule that fired.
 * @param {string} [detail] - extra context, such as a user pattern's source.
 * @returns {string} the English reason.
 */
export function auditReason(ruleId, detail) {
	const text = ruleText(ruleId)
	const base = `rule-guard: matched "${ruleId}" (${text.en.title.toLowerCase()})`
	return detail === undefined ? base : `${base}: ${detail}`
}

/**
 * The localized approval-panel text for one decision.
 *
 * This text becomes the panel's **headline**, so it must not repeat the
 * command: the host renders the command itself, in full, in the region below
 * the headline, from the tool call correlated with the request. Quoting it
 * here as well shows it twice, which is what an earlier version of this
 * plugin did.
 *
 * The tool name is the one thing the command region does not show, so it
 * belongs here.
 *
 * @param {string} ruleId - the rule that fired.
 * @param {string} toolName - the tool being called.
 * @returns {{ en: string, zh: string }} the display text per locale.
 */
export function displayReason(ruleId, toolName) {
	const text = ruleText(ruleId)
	return {
		zh: `规则守卫命中「${text.zh.title}」：${text.zh.detail}\n工具：${toolName}`,
		en: `Rule guard matched "${text.en.title}": ${text.en.detail}\nTool: ${toolName}`,
	}
}

export default { ruleText, auditReason, displayReason, CATALOG }
