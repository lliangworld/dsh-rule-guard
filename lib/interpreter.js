/**
 * Interpreter recursion: a command that runs another command line is analyzed
 * as the command line it runs.
 *
 * `bash -c 'rm -rf build'` and `pwsh -Command "git clean -fdx"` are the same
 * actions as their inner command lines, so the rules apply to the payload.
 * A payload whose quoting cannot be proven literal is unsupported rather than
 * silently allowed, and a payload that is arbitrary code (`python -c`,
 * `node -e`) has no shell grammar to analyze at all.
 *
 * Depth is bounded so a self-referential command cannot recurse forever.
 *
 * @module dsh-rule-guard/interpreter
 */

import { decodeEncodedCommand } from './encoding.js'

/** Commands that run another shell's command line, and the dialect they use. */
const SHELL_WRAPPERS = new Map([
	['bash', 'posix'],
	['sh', 'posix'],
	['zsh', 'posix'],
	['dash', 'posix'],
	['ksh', 'posix'],
	['cmd', 'cmd'],
	['pwsh', 'powershell'],
	['powershell', 'powershell'],
	['powershell_ise', 'powershell'],
])

/** Maximum interpreter nesting depth. */
export const MAX_INTERPRETER_DEPTH = 3

/**
 * Resolve one interpreter invocation to the command line it runs.
 *
 * @param {string} name - the interpreter's basename.
 * @param {import('./word.js').CommandWord[]} args - the words after the interpreter.
 * @param {boolean} windows - whether the dialect compares Windows names.
 * @returns {{ dialect: 'posix' | 'cmd' | 'powershell', command: string } | 'opaque-code' | 'opaque-file' | undefined} the inner command line, `'opaque-code'` for arbitrary code, `'opaque-file'` for a script file, or `undefined` when unsupported.
 */
export function resolveInterpreter(name, args, windows) {
	void windows
	const dialect = SHELL_WRAPPERS.get(name)
	if (dialect === undefined) {
		// Arbitrary code: `python -c`, `node -e`, `perl -e`, `ruby -e`.
		return 'opaque-code'
	}
	const words = args.filter((word) => !word.dynamic)
	if (words.some((word) => word.value.startsWith('-'))) {
		// An unknown switch may carry the command line in a form this module
		// does not model, so the invocation is unsupported.
		const known = KNOWN_SWITCHES[name]
		const unknown = words.filter((word) => word.value.startsWith('-') && !known.has(word.value.split('=', 1)[0]))
		if (unknown.length > 0) return undefined
	}
	const payload = interpreterPayload(name, args)
	if (payload === undefined) return undefined
	return { dialect, command: payload }
}

/** Switches each interpreter accepts before its command line. */
const KNOWN_SWITCHES = {
	bash: new Set(['-c', '-l', '-i', '-s', '-e', '-x', '-v', '-u', '-o', '--norc', '--noprofile', '--login', '--rcfile', '--posix', '-']),
	sh: new Set(['-c', '-e', '-x', '-s', '-l', '-i']),
	zsh: new Set(['-c', '-l', '-i', '-s', '-e', '-x', '-o']),
	dash: new Set(['-c', '-e', '-x', '-s', '-l', '-i']),
	ksh: new Set(['-c', '-s', '-e', '-x', '-l', '-i']),
	cmd: new Set(['/c', '/k', '/s', '/q', '/d', '/a', '/u', '/t', '/e:on', '/e:off', '/f:on', '/f:off', '/v:on', '/v:off']),
	pwsh: new Set(['-Command', '-c', '-EncodedCommand', '-ec', '-File', '-f', '-NoProfile', '-nop', '-NoLogo', '-nol', '-NonInteractive', '-ni', '-ExecutionPolicy', '-ep', '-WindowStyle', '-OutputFormat', '-InputFormat', '-Version', '-Help', '-?']),
	powershell: new Set(['-Command', '-c', '-EncodedCommand', '-ec', '-File', '-f', '-NoProfile', '-nop', '-NoLogo', '-nol', '-NonInteractive', '-ni', '-ExecutionPolicy', '-ep', '-WindowStyle', '-OutputFormat', '-InputFormat', '-Version', '-Help', '-?']),
	powershell_ise: new Set(['-File', '-f', '-NoProfile', '-nop', '-ExecutionPolicy', '-ep']),
}

/** `eval`, `source` and `.` run the file or string they are given in-band. */
const IN_BAND = new Set(['eval', 'source', '.'])

/**
 * The command line one interpreter invocation runs.
 *
 * A `-File` spelling names a script file whose contents are invisible to the
 * rule engine, so it is reported `'opaque-file'` rather than analyzed. A
 * `-EncodedCommand` payload is decoded (UTF-16LE base64) before analysis.
 *
 * @param {string} name - the interpreter's basename.
 * @param {import('./word.js').CommandWord[]} args - the words after the interpreter.
 * @returns {string | 'opaque-file' | undefined} the inner command line, `'opaque-file'`, or `undefined` when unsupported.
 */
function interpreterPayload(name, args) {
	if (IN_BAND.has(name)) {
		const [target] = args
		if (target === undefined || target.dynamic) return undefined
		// `eval "$(cat script.sh)"` is dynamic and unsupported; `./script.sh`
		// is a file whose contents cannot be read.
		return target.value
	}
	let index = 0
	let encoded = false
	let file = false
	const collected = []
	while (index < args.length) {
		const word = args[index]
		const value = word.value
		if (word.dynamic) return undefined
		const lower = value.toLowerCase()
		if (lower === '-encodedcommand' || lower === '-ec') {
			encoded = true
			index++
			continue
		}
		if (lower === '-file' || lower === '-f') {
			file = true
			index++
			continue
		}
		if (lower === '-command' || lower === '-c') {
			index++
			continue
		}
		if (value.startsWith('-')) {
			// A switch with an attached or following value is skipped; its
			// value is not the command line.
			index++
			continue
		}
		// The first non-switch word after the switches is the command line.
		collected.push(...args.slice(index).filter((word) => !word.dynamic).map((word) => word.value))
		if (file) return 'opaque-file'
		const joined = collected.join(' ')
		return encoded ? decodeEncodedCommand(joined) : joined
	}
	return undefined
}

export { IN_BAND, KNOWN_SWITCHES }

export default { resolveInterpreter, IN_BAND, MAX_INTERPRETER_DEPTH }
