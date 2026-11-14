/**
 * A finite option grammar for one command.
 *
 * Ported from ZCode (`apps/zcode-cli/packages/core/src/tool/handlers/guarded/options.ts`).
 * The 2026-09-17 review comment inside `parseOptions` records why an unknown
 * option must never discard already-recognized dangerous evidence: an earlier
 * `return` turned `rm -rfx` into a silent YOLO execution.
 *
 * @module dsh-rule-guard/options
 */

/**
 * One declared option's arity.
 * @typedef {'flag' | 'value' | 'optional'} OptionArity
 */

/**
 * A command's declared options: name → arity.
 * @typedef {Readonly<Record<string, OptionArity>>} OptionTable
 */

/**
 * The result of scanning one command's arguments.
 * @typedef {object} ParsedOptions
 * @property {string[]} flags the recognized option names in order.
 * @property {import('./word.js').CommandWord[]} operands the non-option words.
 * @property {boolean} unsupported whether anything was outside the grammar.
 */

/**
 * The caller must declare its scan policy explicitly; there is no default.
 * - `ordering`: wrapper/front arguments stop at the first operand; the target
 *   command itself allows options and operands to interleave.
 * - `unknown`: a wrapper cannot tell where the real command starts after an
 *   unknown option, so it aborts. A target command's existence rule (`rm -rf`,
 *   `--delete`, `--force`) is not invalidated by one extra unknown word:
 *   `continue` only marks `unsupported`, consumes nothing, and enters no flag.
 * @typedef {object} OptionScanPolicy
 * @property {'stop-at-operand' | 'interspersed'} ordering
 * @property {'abort' | 'continue'} unknown
 */

/** Wrapper and front-argument scan: abort on the first unknown option. */
export const WRAPPER_SCAN = {
	ordering: 'stop-at-operand',
	unknown: 'abort',
}

/** Target-command scan: unknown options never revoke a recognized hit. */
export const COMMAND_SCAN = {
	ordering: 'interspersed',
	unknown: 'continue',
}

/**
 * Scan one argument list against a finite option table.
 *
 * Declared arities consume their value first; an unknown option's arity is
 * never guessed. `--` ends option parsing. A short cluster expands per
 * character (`-rf` → `-r`, `-f`), with an attached value recognized when the
 * character is not last.
 *
 * @param {import('./word.js').CommandWord[]} words - the arguments after the command name.
 * @param {OptionTable} table - the declared option arities.
 * @param {OptionScanPolicy} policy - the caller's ordering and unknown-option policy.
 * @returns {ParsedOptions} the recognized flags, the operands, and whether anything was unsupported.
 */
export function parseOptions(words, table, policy) {
	const result = { flags: [], operands: [], unsupported: false }
	let ended = false
	for (let i = 0; i < words.length; i++) {
		const word = words[i]
		if (!ended && !word.dynamic && word.value === '--') {
			ended = true
			continue
		}
		if (ended || word.dynamic || !word.value.startsWith('-') || word.value === '-') {
			result.operands.push(word)
			if (policy.ordering === 'stop-at-operand') {
				result.operands.push(...words.slice(i + 1))
				break
			}
			continue
		}
		const long = word.value.startsWith('--')
		const equals = word.value.indexOf('=')
		const names = long
			? [equals < 0 ? word.value : word.value.slice(0, equals)]
			: Array.from(word.value.slice(1), (c) => `-${c}`)
		for (let n = 0; n < names.length; n++) {
			const name = names[n]
			const arity = table[name]
			const attached = long ? equals >= 0 : n < names.length - 1
			if (!arity || (arity === 'flag' && long && attached)) {
				result.unsupported = true
				if (policy.unknown === 'abort') return result
				continue
			}
			result.flags.push(name)
			if (arity === 'value' && !attached) {
				if (!words[++i]) result.unsupported = true
			}
			if (arity !== 'flag') break
		}
	}
	return result
}

/**
 * Build an option table from space-separated name lists.
 *
 * @param {string} flags - zero-arity option names.
 * @param {string} [values] - options that consume the next word.
 * @param {string} [optional] - options that may consume a value.
 * @returns {OptionTable} the option table.
 */
export function optionTable(flags, values = '', optional = '') {
	return Object.fromEntries([
		...flags.split(/\s+/).filter(Boolean).map((name) => [name, 'flag']),
		...values.split(/\s+/).filter(Boolean).map((name) => [name, 'value']),
		...optional.split(/\s+/).filter(Boolean).map((name) => [name, 'optional']),
	])
}

/**
 * Whether a flag set enables an option, honoring later cancellation.
 *
 * `git push -f --no-force` is not a force push, and
 * `git clean -fd --dry-run` is not a clean: the last spelling wins, which is
 * how the real commands behave.
 *
 * @param {string[]} flags - the recognized flag names in order.
 * @param {string[]} yes - names that enable the option.
 * @param {string[]} [no] - names that disable it.
 * @returns {boolean} whether the option is enabled.
 */
export function enabled(flags, yes, no = []) {
	let result = false
	for (const flag of flags) {
		if (yes.includes(flag)) result = true
		if (no.includes(flag)) result = false
	}
	return result
}

/**
 * Hit-first settlement: a reliable hit is returned; otherwise an unknown
 * option means `unsupported`, and only a fully supported miss means `false`.
 *
 * @param {string | false} rule - the rule id when the evidence is reliable, else `false`.
 * @param {{ unsupported: boolean }} parsed - the scan whose `unsupported` flag is consulted.
 * @returns {string | false | undefined} the rule id, `false`, or `undefined` for unsupported.
 */
export function settleRule(rule, parsed) {
	return rule || (parsed.unsupported ? undefined : false)
}

export default { parseOptions, optionTable, enabled, settleRule, WRAPPER_SCAN, COMMAND_SCAN }
