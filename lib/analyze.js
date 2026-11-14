/**
 * The top-level rule decision for one command line.
 *
 * Pipeline: tool filter (caller) → allow patterns → deny patterns → dialect
 * dispatch and rule match → ask patterns → unsupported/error policy. There is
 * no cache: a rule decision depends on the whole command text, so caching
 * would open a window where a changed dangerous argument is not re-examined.
 *
 * @module dsh-rule-guard/analyze
 */

import { analyzeCmdCommand } from './cmd.js'
import { analyzePosixCommand } from './posix-splitter.js'
import { analyzePowershellCommand } from './powershell-splitter.js'
import { matchPowershellPipeline } from './powershell.js'
import { matchPosixInvocation } from './posix.js'
import { unwrapCommand } from './wrappers.js'
import { commandBasename } from './word.js'
import { MAX_INTERPRETER_DEPTH, resolveInterpreter } from './interpreter.js'

/** The dialect a command line is written for. */
export const DIALECTS = ['posix', 'cmd', 'powershell']

/**
 * One decision.
 * @typedef {object} Decision
 * @property {'allow' | 'deny' | 'ask' | 'unsupported'} kind
 * @property {string} [ruleId] the rule that fired, when any.
 * @property {string} [reason] the model-facing reason for a deny.
 * @property {'posix' | 'cmd' | 'powershell' | 'unknown'} dialect the dialect the analysis used.
 */

/**
 * Infer the dialect of a tool call from its tool name.
 *
 * @param {string} toolName - the tool being called.
 * @returns {'posix' | 'cmd' | 'powershell' | 'unknown'} the dialect, or `'unknown'` when it cannot be inferred.
 */
export function dialectForTool(toolName) {
	const name = toolName.toLowerCase()
	if (name.includes('pwsh') || name.includes('powershell')) return 'powershell'
	if (name === 'cmd' || name.endsWith('_cmd')) return 'cmd'
	if (name.includes('bash') || name.includes('terminal') || name.includes('shell') || name.includes('sh')) {
		return 'posix'
	}
	return 'unknown'
}

/**
 * Compile one user pattern list, ignoring entries that are not valid regular
 * expressions. An invalid pattern is a configuration mistake, not a reason to
 * fail every command.
 *
 * @param {readonly string[]} patterns - the configured pattern sources.
 * @returns {{ regexps: RegExp[], invalid: string[] }} the compiled patterns and the rejected sources.
 */
export function compilePatterns(patterns) {
	const regexps = []
	const invalid = []
	for (const source of patterns) {
		if (typeof source !== 'string' || source.length === 0) continue
		try {
			regexps.push(new RegExp(source, 'u'))
		} catch {
			invalid.push(source)
		}
	}
	return { regexps, invalid }
}

/** The first pattern that matches, or `undefined`. */
function firstMatch(regexps, command) {
	for (const regexp of regexps) {
		if (regexp.test(command)) return regexp
	}
	return undefined
}

/**
 * Analyze one command line against the rule set.
 *
 * @param {string} command - the raw command text.
 * @param {object} options - the analysis options.
 * @param {'posix' | 'cmd' | 'powershell'} options.dialect - the dialect to analyze under.
 * @param {readonly string[]} [options.allowPatterns] - user allow patterns.
 * @param {readonly string[]} [options.askPatterns] - user ask patterns.
 * @param {readonly string[]} [options.denyPatterns] - user deny patterns.
 * @param {number} [options.maxCommandLength] - the longest command analyzed.
 * @returns {Decision} the decision.
 */
export function analyzeCommand(command, options) {
	const dialect = options.dialect
	if (typeof command !== 'string' || command.trim().length === 0) return { kind: 'allow', dialect }
	const maxLength = options.maxCommandLength ?? 10_000
	if (command.length > maxLength) {
		return { kind: 'unsupported', dialect, ruleId: 'command-too-long' }
	}

	const allow = compilePatterns(options.allowPatterns ?? [])
	const ask = compilePatterns(options.askPatterns ?? [])
	const deny = compilePatterns(options.denyPatterns ?? [])

	if (firstMatch(allow.regexps, command) !== undefined) {
		return { kind: 'allow', dialect, ruleId: 'user-allow-pattern' }
	}
	const denied = firstMatch(deny.regexps, command)
	if (denied !== undefined) {
		return { kind: 'deny', dialect, ruleId: 'user-deny-pattern' }
	}

	const match = matchDialect(command, dialect)
	if (typeof match === 'string') {
		return { kind: 'ask', dialect, ruleId: match }
	}
	if (match === undefined) {
		return { kind: 'unsupported', dialect }
	}
	const asked = firstMatch(ask.regexps, command)
	if (asked !== undefined) {
		return { kind: 'ask', dialect, ruleId: 'user-ask-pattern' }
	}
	return { kind: 'allow', dialect }
}

/**
 * Match one command line under one dialect.
 *
 * @param {string} command - the raw command text.
 * @param {'posix' | 'cmd' | 'powershell'} dialect - the dialect to analyze under.
 * @param {number} [depth] - the current interpreter nesting depth.
 * @returns {import('./git.js').RuleMatch} the rule id, `false`, or `undefined` when unsupported.
 */
function matchDialect(command, dialect, depth = 0) {
	if (dialect === 'posix') return matchPosix(command, false, depth)
	if (dialect === 'cmd') return matchCmd(command, depth)
	return matchPowershell(command, depth)
}

/** Analyze a POSIX command line. */
function matchPosix(command, windows, depth) {
	const analysis = analyzePosixCommand(command)
	if (analysis.hasParseErrors) return undefined
	let unsupported = analysis.hasUnsupportedSyntax
	for (const invocation of analysis.commands) {
		const words = unwrapCommand(invocation.words, windows)
		if (words === undefined || words.length === 0) {
			unsupported = true
			continue
		}
		const name = commandBasename(words[0], windows)
		if (name === undefined) {
			// A dynamic command name hides what will run.
			unsupported = true
			continue
		}		// An interpreter that runs another command line is analyzed as that
		// command line; arbitrary code has no shell grammar to analyze, and a
		// script file's contents are the documented blind spot.
		if (SHELL_WRAPPER_NAMES.has(name) && depth < MAX_INTERPRETER_DEPTH) {
			const inner = resolveInterpreter(name, words.slice(1), windows)
			if (inner === 'opaque-code') return undefined
			if (inner === 'opaque-file') continue
			if (inner === undefined) {
				unsupported = true
				continue
			}
			const innerMatch = matchDialect(inner.command, inner.dialect, depth + 1)
			if (typeof innerMatch === 'string') return innerMatch
			if (innerMatch === undefined) unsupported = true
			continue
		}
		const result = matchPosixInvocation(name, words.slice(1), 'posix')
		if (typeof result === 'string') return result
		// A dynamic argument does not hide flag evidence: the dangerous switches are visible, and matchGit/matchFindDelete already report a dynamic command or subcommand as unsupported.
		if (result === undefined) unsupported = true
	}
	return unsupported ? undefined : false
}

/** Analyze a CMD command line. */
function matchCmd(command, depth) {
	const analysis = analyzeCmdCommand(command)
	let unsupported = analysis.unsupported
	for (const invocation of analysis.commands) {
		const words = unwrapCommand(invocation, true)
		if (words === undefined || words.length === 0) {
			unsupported = true
			continue
		}
		const name = commandBasename(words[0], true)
		if (name === undefined) {
			unsupported = true
			continue
		}
		if (SHELL_WRAPPER_NAMES.has(name) && depth < MAX_INTERPRETER_DEPTH) {
			const inner = resolveInterpreter(name, words.slice(1), true)
			if (inner === 'opaque-code') return undefined
			if (inner === 'opaque-file') continue
			if (inner === undefined) {
				unsupported = true
				continue
			}
			const innerMatch = matchDialect(inner.command, inner.dialect, depth + 1)
			if (typeof innerMatch === 'string') return innerMatch
			if (innerMatch === undefined) unsupported = true
			continue
		}
		const result = matchPosixInvocation(name, words.slice(1), 'cmd')
		if (typeof result === 'string') return result
		// A dynamic argument does not hide flag evidence: the dangerous switches are visible, and matchGit/matchFindDelete already report a dynamic command or subcommand as unsupported.
		if (result === undefined) unsupported = true
	}
	return unsupported ? undefined : false
}

/** Analyze a PowerShell command line. */
function matchPowershell(command, depth) {
	const analysis = analyzePowershellCommand(command)
	// A parse error or a construct this splitter refuses (stop-parsing, a
	// leading script block) means the command line cannot be read as written.
	if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax) return undefined
	return matchPowershellPipeline(
		analysis.stages,
		(text, dialect, innerDepth) => matchDialect(text, dialect, innerDepth),
		command,
		depth,
	)
}

/** The interpreter names that run another command line in-band. */
const SHELL_WRAPPER_NAMES = new Set([
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

export default { analyzeCommand, dialectForTool, compilePatterns, DIALECTS }
