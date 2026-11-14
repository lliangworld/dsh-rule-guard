/**
 * PowerShell command rules.
 *
 * The rule set follows the families documented for dsh-ps-preflight (delete /
 * overwrite / download+execute / credentials / dynamic execution / system /
 * permission) and the boundary handling that made that analyzer reliable:
 * reversal semantics (`-WhatIf`, `-Confirm`) downgrade instead of matching,
 * unambiguous parameter prefixes count, and a combination (download +
 * execute, recursive enumeration + force delete) escalates what either stage
 * alone is.
 *
 * Native commands inside a PowerShell line (`git`, `node`, `dd`, `python`) are
 * routed back to the POSIX matcher so the shared rules apply in both dialects.
 *
 * @module dsh-rule-guard/powershell
 */

import { matchPosixInvocation } from './posix.js'
import { MAX_INTERPRETER_DEPTH, resolveInterpreter } from './interpreter.js'

/** Interpreter names that run another command line in-band. */
const INTERPRETER_NAMES = new Set([
	'bash',
	'sh',
	'zsh',
	'dash',
	'ksh',
	'cmd',
	'pwsh',
	'powershell',
	'powershell_ise',
	'eval',
	'source',
	'.',
])

/** Lowercased alias → canonical cmdlet name. Only documented aliases appear. */
const ALIASES = new Map(
	Object.entries({
		rm: 'Remove-Item',
		rmdir: 'Remove-Item',
		ri: 'Remove-Item',
		del: 'Remove-Item',
		erase: 'Remove-Item',
		rd: 'Remove-Item',
		mi: 'Move-Item',
		move: 'Move-Item',
		cp: 'Copy-Item',
		copy: 'Copy-Item',
		cpi: 'Copy-Item',
		gc: 'Get-Content',
		cat: 'Get-Content',
		type: 'Get-Content',
		gi: 'Get-Item',
		gp: 'Get-ItemProperty',
		gci: 'Get-ChildItem',
		dir: 'Get-ChildItem',
		ls: 'Get-ChildItem',
		iex: 'Invoke-Expression',
		icm: 'Invoke-Command',
		irm: 'Invoke-RestMethod',
		iwr: 'Invoke-WebRequest',
		wget: 'Invoke-WebRequest',
		curl: 'Invoke-WebRequest',
		sbs: 'Start-BitsTransfer',
		sc: 'Set-Content',
		ac: 'Add-Content',
		clc: 'Clear-Content',
		cli: 'Clear-Item',
		clp: 'Clear-ItemProperty',
		sp: 'Set-ItemProperty',
		ni: 'New-Item',
		sls: 'Select-String',
		select: 'Select-Object',
		compare: 'Compare-Object',
		diff: 'Compare-Object',
		foreach: 'ForEach-Object',
		where: 'Where-Object',
		gps: 'Get-Process',
		gsv: 'Get-Service',
		sasv: 'Set-Service',
		saps: 'Start-Process',
		start: 'Start-Process',
		kill: 'Stop-Process',
		spp: 'Stop-Process',
		set: 'Set-Variable',
		sv: 'Set-Variable',
		r: 'Invoke-History',
		ihy: 'Invoke-History',
	}),
)

/** Commands that fetch content over the network. */
const DOWNLOADERS = new Set(['invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer', 'downloadfile', 'downloadstring', 'downloaddata'])

/** Commands that start another program or evaluate a string as code. */
const EXECUTORS = new Set(['invoke-expression', 'start-process', 'invoke-command', 'start-job'])

/** Commands that read or copy file content. */
const READERS = new Set(['get-content', 'get-item', 'get-childitem', 'copy-item', 'compress-archive'])

/** Commands that write file content. */
const WRITERS = new Set(['set-content', 'add-content', 'out-file', 'new-item', 'move-item', 'copy-item'])

/** Sensitive path fragments: reading or copying them exposes credentials. */
const CREDENTIAL_PATTERNS = [
	/(^|[\\/])\.ssh[\\/](id_rsa|id_ed25519|id_ecdsa|id_dsa|identity|authorized_keys|known_hosts)(\.pub)?$/i,
	/(^|[\\/])\.ssh[\\/]config$/i,
	/(^|[\\/])\.aws[\\/](credentials|config)$/i,
	/(^|[\\/])\.env(\.local|\.production|\.development|\.test)?$/i,
	/(^|[\\/])\.git-credentials$/i,
	/(^|[\\/])\.kube[\\/]config$/i,
	/(^|[\\/])\.docker[\\/]config\.json$/i,
	/(^|[\\/])\.npmrc$/i,
	/(^|[\\/])\.pypirc$/i,
	/(^|[\\/])\.netrc$/i,
	/(^|[\\/])\.azure[\\/](accessTokens|azureProfile)\.json$/i,
	/(^|[\\/])\.config[\\/]gh[\\/]hosts\.yml$/i,
]

/** Commands that change machine, service, registry or execution policy. */
const SYSTEM_COMMANDS = new Set([
	'set-executionpolicy',
	'reg',
	'regedit',
	'vssadmin',
	'wevtutil',
	'icacls',
	'takeown',
	'shutdown',
	'restart-computer',
	'stop-computer',
	'format-volume',
	'clear-disk',
	'initialize-disk',
	'remove-partition',
	'diskpart',
	'bcdedit',
	'cipher',
	'wbadmin',
	'wmic',
	'disable-computerrestore',
	'checkpoint-computer',
	'restore-computer',
])

/** `net.exe` and `sc.exe` subcommands that change accounts or services. */
const NET_SUBCOMMANDS = new Set(['user', 'localgroup', 'accounts', 'share', 'stop', 'start', 'time'])
const SC_SUBCOMMANDS = new Set(['config', 'create', 'delete', 'failure', 'description', 'qc', 'start', 'stop', 'pause'])

/**
 * Parameter-name prefixes PowerShell accepts, per canonical switch.
 * Ambiguous prefixes are intentionally absent: `-f` could be `-Filter` or
 * `-Force`, and a rule that guessed would be unsound.
 */
const PREFIXES = {
	recurse: ['-r', '-re', '-rec', '-recu', '-recur', '-recurse'],
	force: ['-fo', '-for', '-forc', '-force'],
	whatif: ['-w', '-wh', '-wha', '-what', '-whati', '-whatif'],
	confirm: ['-c', '-co', '-con', '-conf', '-confi', '-confir', '-confirm'],
	dryrun: ['-d', '-dr', '-dry', '-dryr', '-dryru', '-dryrun'],
}

/**
 * Normalize one PowerShell parameter to its canonical long name, or `null`.
 *
 * PowerShell accepts an unambiguous parameter prefix, so `-Recurse`,
 * `-Recur` and `-r` are the same switch.
 *
 * @param {string} token - one argument token.
 * @returns {string | null} the canonical parameter, or `null`.
 */
export function canonicalParameter(token) {
	if (!token.startsWith('-') || token.length < 2) return null
	const name = token.split('=', 1)[0].toLowerCase()
	for (const [canonical, prefixes] of Object.entries(PREFIXES)) {
		if (prefixes.includes(name)) return `-${canonical}`
	}
	return null
}

/** The canonical parameters of one stage. */
function stageParameters(words) {
	const params = []
	for (const word of words.slice(1)) {
		if (word.value.startsWith('-') && word.value.length > 1) params.push(word.value)
	}
	return params
}

/** The non-parameter words of one stage. */
function stageOperands(words) {
	return words.slice(1).filter((word) => !(word.value.startsWith('-') && word.value.length > 1))
}

/** Whether a parameter list contains one canonical switch. */
function hasSwitch(params, canonical) {
	return params.some((p) => p === canonical || canonicalParameter(p) === canonical)
}

/** The canonical cmdlet name of one word, or `null` when it is not a cmdlet. */
function cmdletName(raw) {
	if (/^[.\/\\]/.test(raw) || /\.(exe|cmd|bat|com|ps1|sh|bash)$/i.test(raw)) return null
	if (/^\[/.test(raw)) return null
	const lowered = raw.toLowerCase()
	return ALIASES.get(lowered) ?? raw
}

/** Whether a word is a static .NET call such as `[System.IO.Directory]::Delete(...)`. */
function staticCall(raw) {
	return /^\[[^\]]+\]\s*::/i.test(raw)
}

/** The method name of a static .NET call, lowercased. */
function staticMethod(raw) {
	const match = /::\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(raw)
	return match === null ? '' : match[1].toLowerCase()
}

/** The type name of a static .NET call, lowercased and without brackets. */
function staticType(raw) {
	const match = /^\[?\s*([A-Za-z_][A-Za-z0-9_.]*?)\s*\]?\s*::/i.exec(raw)
	return match === null ? '' : match[1].toLowerCase().replace(/^system\./, '')
}

/**
 * Whether a path operand names a sensitive credential file.
 *
 * @param {string} value - one operand's literal text.
 * @returns {boolean} whether the path is a credential file.
 */
export function isCredentialPath(value) {
	const normalized = value.replace(/^["']+|["']+$/g, '')
	return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * Match one PowerShell pipeline stage against the cmdlet rules.
 *
 * @param {import('./powershell-splitter.js').PsStage} stage - the stage to match.
 * @param {(command: string, dialect: 'posix' | 'cmd' | 'powershell', depth: number) => import('./git.js').RuleMatch} matchNative - matcher for other dialects.
 * @param {string} [sourceText] - the whole command, used to recover this stage's exact text.
 * @param {number} [depth] - the current interpreter nesting depth.
 * @returns {import('./git.js').RuleMatch} the rule id, `false`, or `undefined` when unsupported.
 */
export function matchPowershellStage(stage, matchNative, sourceText, depth = 0) {
	const head = stage.words[0]
	if (head === undefined) return false
	if (head.dynamic) return undefined
	const raw = head.value

	// Static .NET calls: deleting a file or directory, or creating a
	// scriptblock to run.
	if (staticCall(raw)) {
		const method = staticMethod(raw)
		const type = staticType(raw)
		if (method === 'delete' && ['io.directory', 'io.file', 'io.fileinfo', 'io.directoryinfo'].includes(type)) {
			return 'pwsh-dotnet-delete'
		}
		if (method === 'create' && ['scriptblock', 'management.automation.scriptblock'].includes(type)) {
			return 'pwsh-dynamic-exec'
		}
		return false
	}

	const name = (cmdletName(raw) ?? raw).toLowerCase()
	const params = stageParameters(stage.words)
	const operands = stageOperands(stage.words)
	const whatIf = hasSwitch(params, '-whatif')
	const confirm = hasSwitch(params, '-confirm')

	// An interpreter invoked from a PowerShell line: analyze the command line
	// it runs, exactly as the POSIX path does.
	if (INTERPRETER_NAMES.has(name) && depth < MAX_INTERPRETER_DEPTH) {
		const inner = resolveInterpreter(name, stage.words.slice(1), false)
		if (inner === 'opaque-code') return undefined
		if (inner === 'opaque-file') return false
		if (inner === undefined) return undefined
		return matchNative(inner.command, inner.dialect, depth + 1)
	}

	// A native command reached through PowerShell's own grammar (git, node,
	// python, dd, mkfs, find, rsync, robocopy, xargs, bash). The original
	// source slice is preferred so quoting survives.
	if (name === raw.toLowerCase() && NATIVE_COMMANDS.has(raw.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, ''))) {
		const text = sourceText === undefined
			? stage.words.map((word) => word.value).join(' ')
			: sourceText.slice(stage.start, stage.end).trim()
		return matchNative(text, 'posix', depth + 1)
	}

	if (name === 'remove-item') {
		// -WhatIf only prints; -Confirm prompts per item. Both mean the user
		// is already in the loop, so neither is a silent delete.
		if (whatIf || confirm) return false
		if (hasSwitch(params, '-recurse')) return 'pwsh-remove-recursive'
		// A force delete without recursion is escalated by the caller when a
		// recursive producer feeds it through the pipeline.
		return false
	}

	if (name === 'clear-recyclebin') {
		if (whatIf || confirm) return false
		return hasSwitch(params, '-force') && 'pwsh-clear-recyclebin'
	}

	if (name === 'invoke-expression') return 'pwsh-dynamic-exec'

	if (DOWNLOADERS.has(name)) return false

	if (WRITERS.has(name)) {
		if (operands.some((word) => isCredentialPath(word.value))) return 'pwsh-credential-write'
		return false
	}

	if (READERS.has(name)) {
		// The path text is visible even when the word is dynamic
		// (`$env:USERPROFILE\.aws\credentials`), so a credential fragment is
		// matched on the literal text rather than on the proven value.
		if (operands.some((word) => isCredentialPath(word.value))) return 'pwsh-credential-read'
		return false
	}

	if (SYSTEM_COMMANDS.has(name)) return 'pwsh-system-config'
	if (name === 'net' && operands.length > 0 && NET_SUBCOMMANDS.has(operands[0].value.toLowerCase())) {
		return 'pwsh-system-config'
	}
	if (name === 'sc' && operands.length > 0 && SC_SUBCOMMANDS.has(operands[0].value.toLowerCase())) {
		return 'pwsh-system-config'
	}

	return false
}

/** Commands whose arguments follow the POSIX grammar even inside PowerShell. */
const NATIVE_COMMANDS = new Set([
	'git',
	'dd',
	'mkfs',
	'mount',
	'umount',
	'rsync',
	'find',
	'robocopy',
	'rm',
	'xargs',
	'node',
	'python',
	'python3',
	'perl',
	'ruby',
	'bash',
	'sh',
	'zsh',
	'cmd',
	'del',
	'rd',
	'rmdir',
	'erase',
])

/**
 * Match a whole PowerShell pipeline, including cross-stage escalation.
 *
 * A download stage feeding an execution stage, or a recursive enumeration
 * stage feeding a force delete, is more than either stage alone: the
 * escalation is checked before either stage's own rule so the more specific
 * combination wins.
 *
 * @param {readonly import('./powershell-splitter.js').PsStage[]} stages - the pipeline stages in order.
 * @param {(command: string, dialect: 'posix' | 'cmd' | 'powershell', depth: number) => import('./git.js').RuleMatch} matchNative - matcher for other dialects.
 * @param {string} [sourceText] - the whole command, used to recover each stage's exact text.
 * @param {number} [depth] - the current interpreter nesting depth.
 * @returns {import('./git.js').RuleMatch} the first rule id, `false`, or `undefined` when unsupported.
 */
export function matchPowershellPipeline(stages, matchNative, sourceText, depth = 0) {
	let unsupported = false
	for (let index = 0; index < stages.length; index++) {
		const stage = stages[index]
		const name = (cmdletName(stage.words[0].value) ?? stage.words[0].value).toLowerCase()
		const params = stageParameters(stage.words)
		const previous = stages[index - 1]
		const previousName =
			previous === undefined ? '' : (cmdletName(previous.words[0].value) ?? previous.words[0].value).toLowerCase()
		const previousParams = previous === undefined ? [] : stageParameters(previous.words)
		// Download + execute in one pipeline.
		if (
			(DOWNLOADERS.has(previousName) && EXECUTORS.has(name)) ||
			(DOWNLOADERS.has(name) && EXECUTORS.has(previousName))
		) {
			return 'pwsh-download-exec'
		}
		// A recursive enumeration feeding a force delete.
		if (
			previousName === 'get-childitem' &&
			hasSwitch(previousParams, '-recurse') &&
			name === 'remove-item' &&
			hasSwitch(params, '-force')
		) {
			return 'pwsh-remove-recursive'
		}
		const result = matchPowershellStage(stage, matchNative, sourceText, depth)
		if (typeof result === 'string') return result
		if (result === undefined) unsupported = true
	}
	return unsupported ? undefined : false
}

export default { matchPowershellStage, matchPowershellPipeline, canonicalParameter, isCredentialPath }
