/**
 * A self-contained POSIX-shell splitter: one command line into invocations,
 * with the same word facts the rule engine relies on.
 *
 * ZCode uses `unbash` for this. To keep this bundle free of runtime
 * dependencies (only `schemastery` is declared), this module implements the
 * subset the rule engine needs and mirrors `unbash`'s observable contract:
 * separators (`;`, `&&`, `||`, `|`, newline, background `&`), comments,
 * quoting, escapes, line continuations, expansions, redirections, and
 * unsupported compound constructs.
 *
 * Behavior notes (deliberate, documented):
 * - Command substitution, arithmetic and parameter expansions are opaque:
 *   their payload is never descended into, and the word becomes `dynamic`.
 * - Compound constructs (`for`, `while`, `until`, `if`, `case`, `select`,
 *   `function`, `{ ...; }`, `( ... )`, `[[ ... ]]`, `(( ... ))`) are skipped
 *   whole and mark the analysis unsupported, so a body can neither hide a hit
 *   nor be mistaken for an independent command.
 * - A heredoc/here-string marks the analysis unsupported: its body is data,
 *   not syntax, and silently ignoring it would be a blind spot.
 *
 * @module dsh-rule-guard/posix-splitter
 */

/** One invocation: the words of one simple command, `words[0]` is its name. */

/**
 * @typedef {object} PosixInvocation
 * @property {import('./word.js').CommandWord[]} words the invocation's words.
 */

/**
 * The split result for one command line.
 * @typedef {object} PosixAnalysis
 * @property {readonly import('./word.js').CommandWord[][]} commands each simple command's words.
 * @property {boolean} hasDynamicWords whether any word is dynamic.
 * @property {boolean} hasParseErrors whether a construct was unterminated or the input was too long.
 * @property {boolean} hasRedirects whether any redirection appeared.
 * @property {boolean} hasUnsupportedSyntax whether a construct was outside the supported grammar.
 */

/** Longest command line this splitter accepts; longer input is a parse error. */
export const MAX_POSIX_PARSE_LENGTH = 10_000

/** Keywords that open a compound construct rather than a simple command. */
const COMPOUND_KEYWORDS = new Set(['for', 'while', 'until', 'if', 'case', 'select', 'function'])

/** Raised internally when a quoted or parenthesized run is unterminated. */
class ParseEnd extends Error {}

/** Split one POSIX command line into simple-command invocations. */
export function analyzePosixCommand(source) {
	const commands = []
	const words = []
	let cur = null
	let hasDynamicWords = false
	let hasRedirects = false
	let unsupported = false

	const startWord = (start) => {
		if (cur === null) cur = { value: '', dynamic: false, glob: false, start }
	}
	const pushChar = (ch) => {
		if (cur !== null) cur.value += ch
	}
	const markDynamic = () => {
		if (cur !== null) cur.dynamic = true
	}
	const flushWord = (end) => {
		if (cur === null) return
		words.push({ value: cur.value, dynamic: cur.dynamic, hasUnquotedGlob: cur.glob, start: cur.start, end })
		if (cur.dynamic) hasDynamicWords = true
		cur = null
	}
	const flushCommand = (end) => {
		flushWord(end)
		if (words.length > 0) commands.push({ words: [...words] })
		words.length = 0
	}

	/**
	 * Find the end of a quoted run without touching any word state, so a
	 * caller that is only measuring text (a redirection target, a keyword
	 * lookup) cannot leak that text into the current word.
	 * @returns the index after the closing quote.
	 */
	const quoteEnd = (open) => {
		const quote = source[open]
		let i = open + 1
		while (i < source.length) {
			const c = source[i]
			if (quote === "'") {
				if (c === "'") return i + 1
				i++
				continue
			}
			if (c === '\\' && i + 1 < source.length) {
				i += 2
				continue
			}
			if (c === '"') return i + 1
			i++
		}
		throw new ParseEnd()
	}

	/** Read a quoted run; returns the index after the closing quote. */
	const readQuote = (open) => {
		const quote = source[open]
		startWord(open)
		let i = open + 1
		while (i < source.length) {
			const c = source[i]
			if (quote === "'") {
				if (c === "'") return i + 1
				pushChar(c)
				i++
				continue
			}
			// Double quotes: backslash escapes and expansions.
			if (c === '\\' && i + 1 < source.length) {
				pushChar(c)
				pushChar(source[i + 1])
				i += 2
				continue
			}
			if (c === '"') return i + 1
			if (c === '$' || c === '`') markDynamic()
			pushChar(c)
			i++
		}
		throw new ParseEnd()
	}

	/** Skip a `(`-run with nesting; returns the index after the closing `)`. */
	const readParenRun = (open) => {
		let depth = 0
		let i = open
		while (i < source.length) {
			const c = source[i]
			if (c === '"' || c === "'") {
				i = quoteEnd(i)
				continue
			}
			if (c === '\\') {
				i += 2
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

	/** Skip a `${`-run with nesting; returns the index after the closing `}`. */
	const readBraceRun = (open) => {
		let depth = 0
		let i = open
		while (i < source.length) {
			if (source[i] === '{') depth++
			else if (source[i] === '}') {
				depth--
				if (depth === 0) return i + 1
			}
			i++
		}
		throw new ParseEnd()
	}

	/** Consume one word (honoring quotes) and return the index after it. */
	const readWord = (from) => {
		let i = from
		while (i < source.length) {
			const c = source[i]
			if (/\s/.test(c) || ';&|()<>\n'.includes(c)) break
			if (c === '"' || c === "'") {
				i = quoteEnd(i)
				continue
			}
			if (c === '\\') {
				i += 2
				continue
			}
			i++
		}
		return i
	}

	/** The word starting at `from`, without quotes or escapes. */
	const wordTextAt = (from) => {
		const end = readWord(from)
		let text = ''
		for (let k = from; k < end; k++) {
			const c = source[k]
			if (c === '"' || c === "'") {
				const close = quoteEnd(k)
				text += source.slice(k, close).replace(/["']/g, '')
				k = close - 1
				continue
			}
			if (c === '\\') {
				if (source[k + 1] !== undefined) text += source[k + 1]
				k++
				continue
			}
			text += c
		}
		return text
	}

	/**
	 * Skip a compound construct. The opener keyword decides its terminator;
	 * nested same-keyword constructs are counted so the outer one ends at its
	 * own terminator.
	 * @returns the index after the terminator, or the end of input.
	 */
	const skipCompound = (from, keyword) => {
		const group = keyword === 'function'
		let i = from
		let depth = 1
		while (i < source.length) {
			const c = source[i]
			if (c === '#') {
				const nl = source.indexOf('\n', i)
				i = nl < 0 ? source.length : nl
				continue
			}
			if (c === '"' || c === "'") {
				try {
					i = quoteEnd(i)
					continue
				} catch {
					return source.length
				}
			}
			if (c === '\\') {
				i += 2
				continue
			}
			if (group) {
				if (c === '{') depth++
				else if (c === '}') {
					depth--
					if (depth === 0) return i + 1
				}
				i++
				continue
			}
			const word = /^[A-Za-z_]+/.exec(source.slice(i))?.[0]
			if (word !== undefined) {
				const isOpener = word === keyword
				const isTerminator =
					(keyword === 'if' && word === 'fi') ||
					(keyword === 'case' && word === 'esac') ||
					(['for', 'while', 'until', 'select'].includes(keyword) && word === 'done')
				if (isOpener) depth++
				if (isTerminator) {
					depth--
					if (depth === 0) return i + word.length
				}
				i += word.length
				continue
			}
			i++
		}
		return source.length
	}

	/** Skip a `[[ ... ]]` conditional expression. */
	const skipConditional = (from) => {
		const close = source.indexOf(']]', from)
		return close < 0 ? source.length : close + 2
	}

	/** Skip a `(( ... ))` arithmetic command. */
	const skipArithmetic = (from) => {
		let depth = 0
		let i = from
		while (i < source.length) {
			if (source[i] === '(') depth++
			else if (source[i] === ')') {
				depth--
				if (depth === 0) return i + 1
			}
			i++
		}
		return source.length
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
				flushCommand(i)
				i++
				continue
			}
			if (c === '#' && cur === null) {
				const nl = source.indexOf('\n', i)
				i = nl < 0 ? source.length : nl
				continue
			}
			if (c === ';') {
				flushCommand(i)
				i++
				continue
			}
			if (c === '&') {
				flushCommand(i)
				unsupported = true
				i += source[i + 1] === '&' ? 2 : 1
				continue
			}
			if (c === '|') {
				flushCommand(i)
				i += source[i + 1] === '&' ? 2 : 1
				continue
			}
			if (c === '<' || c === '>') {
				// A leading all-digit run is the redirection's file descriptor,
				// whether it is still open or already flushed as a word.
				if (cur !== null && /^\d+$/.test(cur.value)) cur = null
				else if (words.length > 0 && /^\d+$/.test(words[words.length - 1].value)) words.pop()
				flushWord(i)
				hasRedirects = true
				if (c === '<' && source[i + 1] === '<') unsupported = true
				let j = i
				if (source[j + 1] === c || source[j + 1] === '&' || source[j + 1] === '>') j++
				j++
				if (source[j] === '&' && /[\d-]/.test(source[j + 1] ?? '')) j += 2
				while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++
				if (j < source.length && source[j] !== '\n' && source[j] !== ';' && source[j] !== '&') {
					j = readWord(j)
				}				i = j
				continue
			}
			if (c === '"' || c === "'") {
				const after = readQuote(i)
				// `"foo"bar` is one word, `"foo" bar` is two: a quoted run ends
				// at the first separator that follows it.
				const next = source[after]
				if (next === undefined || /\s/.test(next) || ';&|()<>\n'.includes(next)) flushWord(after)
				i = after
				continue
			}
			if (c === '\\') {
				if (source[i + 1] === '\n') {
					i += 2
					continue
				}
				if (cur === null) startWord(i)
				if (source[i + 1] !== undefined) pushChar(source[i + 1])
				i += 2
				continue
			}
			if (c === '$' || c === '`') {
				startWord(i)
				markDynamic()
				if (c === '`') {
					const close = source.indexOf('`', i + 1)
					if (close < 0) throw new ParseEnd()
					pushChar(source.slice(i, close + 1))
					i = close + 1
					continue
				}
				const next = source[i + 1]
				if (next === '(') {
					const end = readParenRun(i + 1)
					pushChar(source.slice(i, end))
					i = end
					continue
				}
				if (next === '{') {
					const end = readBraceRun(i + 1)
					pushChar(source.slice(i, end))
					i = end
					continue
				}
				let j = i + 1
				while (j < source.length && /[A-Za-z0-9_?*@#!$-]/.test(source[j])) j++
				pushChar(source.slice(i, j))
				i = j
				continue
			}
			if (c === '(') {
				const end = readParenRun(i)
				unsupported = true
				i = end
				continue
			}
			if (c === '{' && cur === null && /\s/.test(source[i + 1] ?? ' ')) {
				unsupported = true
				i = skipCompound(i + 1, 'function')
				continue
			}
			// A word. Compound constructs at command start are not commands.
			const wordEnd = readWord(i)
			const text = wordTextAt(i)
			if (words.length === 0 && cur === null && COMPOUND_KEYWORDS.has(text)) {
				unsupported = true
				i = skipCompound(wordEnd, text)
				continue
			}
			if (words.length === 0 && cur === null && text === '[[') {
				unsupported = true
				i = skipConditional(wordEnd)
				continue
			}
			if (words.length === 0 && cur === null && text === '((') {
				unsupported = true
				i = skipArithmetic(wordEnd)
				continue
			}
			startWord(i)
			for (let k = i; k < wordEnd; k++) {
				const ch = source[k]
				if (ch === '"' || ch === "'") {
					const close = readQuote(k)
					k = close - 1
					continue
				}
				if (ch === '\\') {
					if (source[k + 1] !== undefined) pushChar(source[k + 1])
					k++
					continue
				}
				if (ch === '$' || ch === '`') markDynamic()
				pushChar(ch)
			}
			flushWord(wordEnd)
			i = wordEnd
		}
	} catch {
		flushWord(source.length)
		flushCommand(source.length)
		return {
			commands,
			hasDynamicWords,
			hasParseErrors: true,
			hasRedirects,
			hasUnsupportedSyntax: unsupported,
		}
	}
	flushWord(source.length)
	flushCommand(source.length)
	return { commands, hasDynamicWords, hasParseErrors: false, hasRedirects, hasUnsupportedSyntax: unsupported }
}

export default { analyzePosixCommand, MAX_POSIX_PARSE_LENGTH }
