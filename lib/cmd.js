/**
 * CMD's finite tokenizer: double quotes and carets; single quotes are ordinary
 * characters, and complex blocks/variable expansion are not interpreted.
 *
 * Ported from ZCode (`apps/zcode-cli/packages/core/src/tool/handlers/guarded/cmd.ts`),
 * which carries the 2026-09-17 review fix for redirection targets and REM
 * comment handling.
 *
 * @module dsh-rule-guard/cmd
 */

const CMD_DELETE_BUILTIN = /^(?:rd|rmdir|del|erase)$/i

/**
 * Split one CMD command line into invocations.
 *
 * @param {string} source - the raw command text.
 * @returns {{ commands: import('./word.js').CommandWord[][], unsupported: boolean }} each invocation's words, and whether anything was unsupported.
 */
export function analyzeCmdCommand(source) {
	const commands = []
	let words = []
	let value = ''
	let start = -1
	let quote = false
	let dynamic = false
	let hasUnquotedGlob = false
	let skipTarget = false
	let unsupported = false
	let invalidSegment = false
	let blockDepth = 0
	const flushWord = (end) => {
		if (start < 0) return
		if (!skipTarget) words.push({ value, dynamic, hasUnquotedGlob, start, end })
		skipTarget = false
		value = ''
		start = -1
		dynamic = false
		hasUnquotedGlob = false
	}
	const flushCommand = (end) => {
		flushWord(end)
		if (!invalidSegment && blockDepth === 0 && words.length && !/^(?:rem|::)$/i.test(words[0].value))
			commands.push(words)
		words = []
		invalidSegment = blockDepth > 0
	}
	const splitDeleteSwitch = (index) => {
		// CMD builtin deletes allow rd/s/q and target/s/q. The caret is removed
		// by CMD first, so a quoted path stays one whole word. Only these four
		// builtins split on a slash; other commands' paths and redirection
		// targets must not be cut into switches.
		if (!skipTarget && CMD_DELETE_BUILTIN.test(words[0]?.value ?? value)) {
			flushWord(index)
			start = index
		}
	}
	for (let i = 0; i < source.length; i++) {
		const c = source[i]
		if (!quote && c === '^') {
			if (start < 0) start = i
			if (source[i + 1] === undefined || /[\r\n]/.test(source[i + 1])) {
				unsupported = true
				invalidSegment = true
			} else {
				if (source[i + 1] === '/') splitDeleteSwitch(i)
				value += source[++i]
			}
			continue
		}
		if (c === '"') {
			if (start < 0) start = i
			quote = !quote
			continue
		}
		if (!quote && /[ \t]/.test(c)) {
			flushWord(i)
			continue
		}
		if (!quote && /[&|\r\n]/.test(c)) {
			flushCommand(i)
			if (source[i + 1] === c) i++
			continue
		}
		if (!quote && /[<>]/.test(c)) {
			// `2>&1` is an fd redirection, not a command separator or argv.
			if (start >= 0 && /^\d+$/.test(value)) {
				value = ''
				start = -1
			}
			flushWord(i)
			if (source[i + 1] === c) i++
			if (source[i + 1] === '&' && /[\d-]/.test(source[i + 2] ?? '')) {
				i += 2
			} else skipTarget = true
			continue
		}
		if (!quote && /[()]/.test(c)) {
			unsupported = true
			invalidSegment = true
			blockDepth = c === '(' ? blockDepth + 1 : Math.max(0, blockDepth - 1)
		}
		if (!quote && c === '/') splitDeleteSwitch(i)
		if (start < 0) start = i
		if (c === '%' || c === '!') dynamic = true
		if (!quote && /[*?[]/.test(c)) hasUnquotedGlob = true
		value += c
		// A REM in command position swallows the rest of the line; a REM as a
		// redirection target is an ordinary file name.
		if (!quote && !skipTarget && words.length === 0 && /^(?:rem\s|::)/i.test(source.slice(start))) {
			const newline = source.indexOf('\n', i)
			value = ''
			start = -1
			i = newline < 0 ? source.length : newline
		}
	}
	// 2026-09-17 review: `skipTarget` stays true until a target word begins,
	// which used to mark `git reset --hard 2>nul` as "missing target". Only a
	// redirection with no target word at all is missing; an accumulating
	// target is discarded by flushCommand as an ordinary redirection target.
	if (quote || (skipTarget && start < 0)) {
		unsupported = true
		invalidSegment = true
	}
	flushCommand(source.length)
	return { commands, unsupported }
}

export default { analyzeCmdCommand }
