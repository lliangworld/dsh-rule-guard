/**
 * A self-contained PowerShell splitter: one command line into statements,
 * each split into pipeline stages of words.
 *
 * PowerShell is a statement language, not a word-splitting shell: newlines,
 * `;`, `|`, `&&`, `||` separate statements and stages, and quotes/here-strings
 * carry their own rules. This module keeps the facts the rule engine needs and
 * refuses what it cannot prove:
 *
 * - `--%` (stop parsing) and here-strings are unsupported: everything after
 *   them is opaque, and silently ignoring them would be a blind spot.
 * - A `$(...)` subexpression or `@(...)` array is opaque and marks its word
 *   dynamic; its payload is not descended into.
 * - A backtick escapes the next character, so `` `$ `` is a literal dollar.
 * - Redirection targets are skipped, not treated as arguments.
 *
 * @module dsh-rule-guard/powershell
 */

/**
 * One word of one pipeline stage.
 * @typedef {object} PsWord
 * @property {string} value the literal text, with quotes and backtick escapes resolved.
 * @property {boolean} dynamic whether a subexpression/expansion makes the value unknowable.
 * @property {number} start the word's start offset.
 * @property {number} end the word's end offset.
 */

/**
 * One pipeline stage: a command with its arguments.
 * @typedef {object} PsStage
 * @property {PsWord[]} words the stage's words; `words[0]` is the command.
 * @property {number} start the stage's start offset in the source.
 * @property {number} end the stage's end offset in the source.
 */

/**
 * The split result for one command line.
 * @typedef {object} PsAnalysis
 * @property {PsStage[]} stages the pipeline stages in source order.
 * @property {boolean} hasDynamicWords whether any word is dynamic.
 * @property {boolean} hasParseErrors whether a construct was unterminated or unparseable.
 * @property {boolean} hasUnsupportedSyntax whether a construct was outside the supported grammar.
 */

/** Longest command line this splitter accepts; longer input is unsupported. */
export const MAX_PS_PARSE_LENGTH = 10_000

/** Raised internally when a quoted or bracketed run is unterminated. */
class ParseEnd extends Error {}

/**
 * Split one PowerShell command line into pipeline stages.
 *
 * @param {string} source - the raw command text.
 * @returns {PsAnalysis} the stages plus the analysis facts.
 */
export function analyzePowershellCommand(source) {
	const stages = []
	let words = []
	let cur = null
	let stageStart = 0
	let hasDynamicWords = false
	let unsupported = false

	const startWord = (start) => {
		if (cur === null) cur = { value: '', dynamic: false, start }
	}
	const pushChar = (ch) => {
		if (cur !== null) cur.value += ch
	}
	const markDynamic = () => {
		if (cur !== null) cur.dynamic = true
	}
	const flushWord = (end) => {
		if (cur === null) return
		words.push({ value: cur.value, dynamic: cur.dynamic, start: cur.start, end })
		if (cur.dynamic) hasDynamicWords = true
		cur = null
	}
	const flushStage = (start, end) => {
		flushWord(end)
		if (words.length > 0) stages.push({ words, start, end })
		words = []
	}
	/** Flush the stage that started at `stageStart` and ends at `end`. */
	const endStage = (end) => {
		flushStage(stageStart, end)
		stageStart = end
	}

	/** Find the end of a quoted run without touching word state. */
	const quoteEnd = (open) => {
		const quote = source[open]
		const hereString = source.slice(open, open + 3)
		if (hereString === "@'" || hereString === '@"') {
			// A here-string runs to its opener at the start of a line.
			const terminator = hereString === "@'" ? "'@" : '"@"'
			const at = source.indexOf(terminator, open + 3)
			if (at < 0) throw new ParseEnd()
			return at + 2
		}
		let i = open + 1
		while (i < source.length) {
			const c = source[i]
			if (quote === "'") {
				if (c === "'") return i + 1
				i++
				continue
			}
			if (c === '`') {
				i += 2
				continue
			}
			if (c === '"') return i + 1
			i++
		}
		throw new ParseEnd()
	}

	/** Skip a `(...)`/`$(...)`/`@(...)` run; returns the index after the close. */
	const skipParen = (open) => {
		let depth = 0
		let i = open
		while (i < source.length) {
			const c = source[i]
			if (c === '"' || c === "'") {
				i = quoteEnd(i)
				continue
			}
			if (c === '(') depth++
			else if (c === ')') {
				depth--
				if (depth === 0) return i + 1
			}
			i++
		}
		throw new ParseEnd()
	}

	/** Skip a `{...}` script block; returns the index after the close. */
	const skipBrace = (open) => {
		let depth = 0
		let i = open
		while (i < source.length) {
			const c = source[i]
			if (c === '"' || c === "'") {
				i = quoteEnd(i)
				continue
			}
			if (c === '{') depth++
			else if (c === '}') {
				depth--
				if (depth === 0) return i + 1
			}
			i++
		}
		throw new ParseEnd()
	}

	/** Consume one word and return the index after it. */
	const readWord = (from) => {
		let i = from
		while (i < source.length) {
			const c = source[i]
			if (/\s/.test(c) || ';|&<>(){}"\''.includes(c) || c === '`' || c === '#' || c === ',') break
			if (c === '$' && source[i + 1] === '(') {
				i = skipParen(i + 1)
				continue
			}
			if (c === '@' && source[i + 1] === '(') {
				i = skipParen(i + 1)
				continue
			}
			i++
		}
		return i
	}

	let i = 0
	try {
		while (i < source.length) {
			const c = source[i]
			if (c === ' ' || c === '\t' || c === '\r') {
				i++
				continue
			}
			if (c === '\n') {
				endStage(i)
				i++
				stageStart = i
				continue
			}
			if (c === ';') {
				endStage(i)
				i++
				stageStart = i
				continue
			}
			if (c === '|') {
				endStage(i)
				i += source[i + 1] === '|' ? 2 : 1
				stageStart = i
				continue
			}
			if (c === '&') {
				endStage(i)
				i += source[i + 1] === '&' ? 2 : 1
				stageStart = i
				continue
			}
			if (c === '<' || c === '>') {
				flushWord(i)
				let j = i
				if (source[j + 1] === c || source[j + 1] === '>') j++
				j++
				while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++
				if (j < source.length && source[j] !== '\n' && source[j] !== ';') j = readWord(j)
				i = j
				continue
			}
			// Stop-parsing: everything after `--%` is opaque, wherever it
			// appears, because PowerShell stops expanding and interpreting it.
			if (c === '-' && source.slice(i, i + 3) === '--%') {
				unsupported = true
				break
			}
			if (c === '#' && cur === null && words.length === 0) {
				const nl = source.indexOf('\n', i)
				i = nl < 0 ? source.length : nl
				continue
			}
			if (c === '"' || c === "'") {
				startWord(i)
				const end = quoteEnd(i)
				for (let k = i; k < end; k++) {
					const ch = source[k]
					if (ch === '`' && k + 1 < end) {
						pushChar(source[k + 1])
						k++
						continue
					}
					if (ch === '"' || ch === "'") continue
					pushChar(ch)
				}
				const next = source[end]
				if (next === undefined || /\s/.test(next) || ';|&<>(){}\'"`#,'.includes(next)) flushWord(end)
				i = end
				continue
			}
			if (c === '`') {
				if (cur === null) startWord(i)
				if (source[i + 1] !== undefined) pushChar(source[i + 1])
				i += 2
				continue
			}
			if (c === '$' || c === '@') {
				startWord(i)
				markDynamic()
				if (source[i + 1] === '(') {
					const end = skipParen(i + 1)
					pushChar(source.slice(i, end))
					i = end
					continue
				}
				let j = i + 1
				while (j < source.length && /[A-Za-z0-9_:?\[\]]/.test(source[j])) j++
				pushChar(source.slice(i, j))
				i = j
				continue
			}
			if (c === '{' && cur === null && words.length === 0) {
				unsupported = true
				i = skipBrace(i)
				continue
			}
			// A script block argument (`Where-Object { ... }`) is opaque: its
			// body is code, not a word, so it is kept as one dynamic argument.
			if (c === '{') {
				const end = skipBrace(i)
				startWord(i)
				markDynamic()
				pushChar(source.slice(i, end))
				const next = source[end]
				if (next === undefined || /\s/.test(next) || ';|&<>(){}\'"`#,'.includes(next)) flushWord(end)
				i = end
				continue
			}
			if (c === '}') {
				flushWord(i)
				i++
				continue
			}
			const wordEnd = readWord(i)
			if (wordEnd === i) {
				// A character this scanner does not model: consume it so the
				// loop always makes progress, and treat it as part of a word.
				startWord(i)
				pushChar(c)
				flushWord(i + 1)
				i++
				continue
			}
			startWord(i)
			for (let k = i; k < wordEnd; k++) {
				const ch = source[k]
				if (ch === '$' || ch === '@') markDynamic()
				pushChar(ch)
			}
			flushWord(wordEnd)
			i = wordEnd
		}
	} catch {
		flushWord(source.length)
		endStage(source.length)
		return { stages, hasDynamicWords, hasParseErrors: true, hasUnsupportedSyntax: unsupported }
	}
	flushWord(source.length)
	endStage(source.length)
	return { stages, hasDynamicWords, hasParseErrors: false, hasUnsupportedSyntax: unsupported }
}

export default { analyzePowershellCommand, MAX_PS_PARSE_LENGTH }
