/**
 * Copyright 2026 Z.AI Co., Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Modified by lliangworld for @lliangworld/dsh-rule-guard: converted from TypeScript to JavaScript,
 *                                                          and the word facts extended with the
 *                                                          offsets the rule engine needs.
 * The upstream attribution and the Apache License 2.0 text are in
 * THIRD-PARTY-NOTICES.md.
 */
/**
 * AST-located word facts. Expansions are never executed, and an unknown word is
 * never treated as a known option.
 *
 * Ported from ZCode (`apps/zcode-cli/packages/core/src/tool/handlers/guarded/word.ts`),
 * which carries its own boundary-case fixes (2026-09-17 review, 2026-09-24 batch-delete review).
 *
 * @module dsh-rule-guard/word
 */

/**
 * One word's literal value plus the facts that make a rule reliable.
 * @typedef {object} CommandWord
 * @property {string} value the literal text, with quotes and escapes resolved.
 * @property {boolean} dynamic whether an expansion or unterminated quote makes the value unknowable.
 * @property {boolean} hasUnquotedGlob whether an unquoted glob metacharacter appears.
 * @property {number} start the word's start offset in the whole command.
 * @property {number} end the word's end offset in the whole command.
 */

/**
 * Compute one POSIX word's literal value and dynamic facts.
 *
 * A backslash escape, a quote, a `$`/backtick expansion, or an unquoted glob
 * metacharacter each mark the word `dynamic`: the rule engine cannot prove
 * what such a word will expand to, so its callers report `unsupported` rather
 * than guess. An unterminated quote also marks the word dynamic.
 *
 * @param {string} text - the raw source slice for this word.
 * @param {number} start - the word's start offset in the whole command.
 * @param {number} end - the word's end offset in the whole command.
 * @returns {CommandWord} the word's facts.
 */
export function literalPosixWord(text, start, end) {
	let value = ''
	let quote = ''
	let dynamic = false
	let hasUnquotedGlob = false
	for (let i = 0; i < text.length; i++) {
		const c = text[i]
		if (c === quote) {
			quote = ''
			continue
		}
		if (quote !== "'" && c === '\\') {
			const next = text[i + 1]
			if (next === undefined) {
				dynamic = true
				break
			}
			if (!quote || ['$', '`', '"', '\\', '\n'].includes(next)) {
				if (next !== '\n') value += next
				i++
				continue
			}
		}
		if (!quote && (c === "'" || c === '"')) {
			quote = c
			continue
		}
		if (quote !== "'" && (c === '$' || c === '`')) dynamic = true
		if (!quote && /[*?[{}~]/.test(c)) dynamic = true
		if (!quote && /[*?[]/.test(c)) hasUnquotedGlob = true
		value += c
	}
	return { value, dynamic: dynamic || Boolean(quote), hasUnquotedGlob, start, end }
}

/**
 * The executable basename of one word, or `undefined` when it is dynamic.
 *
 * A path prefix is stripped (`/usr/bin/sudo` → `sudo`) and, on Windows
 * dialects, case and a `.exe` suffix are normalized, so a spelled-out binary
 * path cannot smuggle a command past a basename rule.
 *
 * @param {CommandWord} word - the leading word of one invocation.
 * @param {boolean} windows - whether the dialect compares Windows names.
 * @returns {string | undefined} the basename, or `undefined` for a dynamic word.
 */
export function commandBasename(word, windows) {
	if (word.dynamic) return undefined
	const name = word.value.split(windows ? /[\\/]/ : /\//).at(-1)
	return windows ? name.toLowerCase().replace(/\.exe$/, '') : name
}

export default { literalPosixWord, commandBasename }
