import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzePosixCommand } from '../lib/posix-splitter.js'

const names = (source) => analyzePosixCommand(source).commands.map((c) => c.words.map((w) => w.value))

test('separators split invocations', () => {
	assert.deepEqual(names('echo hello; rm -rf build'), [['echo', 'hello'], ['rm', '-rf', 'build']])
	assert.deepEqual(names('false || rm -rf build'), [['false'], ['rm', '-rf', 'build']])
	assert.deepEqual(names('true && rm -rf build'), [['true'], ['rm', '-rf', 'build']])
	assert.deepEqual(names('echo hi | rm -rf build'), [['echo', 'hi'], ['rm', '-rf', 'build']])
	assert.deepEqual(names('echo a\necho b'), [['echo', 'a'], ['echo', 'b']])
})

test('quotes keep a word whole and mark dynamic facts', () => {
	assert.deepEqual(names('"/bin/rm" -rf build'), [['/bin/rm', '-rf', 'build']])
	assert.deepEqual(names('git commit "--no-verify"'), [['git', 'commit', '--no-verify']])
	const dynamic = analyzePosixCommand('rm -rf "$target"')
	assert.equal(dynamic.commands[0].words[2].dynamic, true)
	const escaped = analyzePosixCommand('r\\m -rf build')
	assert.deepEqual(escaped.commands[0].words.map((w) => w.value), ['rm', '-rf', 'build'])
	assert.equal(escaped.commands[0].words[0].dynamic, false)
})

test('line continuation folds', () => {
	assert.deepEqual(names('rm -rf \\\nbuild'), [['rm', '-rf', 'build']])
})

test('comments are not commands', () => {
	assert.deepEqual(names('echo hi # rm -rf build'), [['echo', 'hi']])
	assert.deepEqual(names('echo a#b'), [['echo', 'a#b']])
})

test('redirection targets are not operands', () => {
	assert.deepEqual(names('rm -rf build > out.txt'), [['rm', '-rf', 'build']])
	assert.deepEqual(names('git reset --hard 2>nul'), [['git', 'reset', '--hard']])
	assert.deepEqual(names('echo hi > \'rm -rf build\''), [['echo', 'hi']])
	assert.deepEqual(names('time -o file rm -rf build'), [['time', '-o', 'file', 'rm', '-rf', 'build']])
})

test('command substitution is opaque and dynamic', () => {
	const analysis = analyzePosixCommand('echo $(rm -rf build)')
	assert.deepEqual(analysis.commands.map((c) => c.words.map((w) => w.value)), [['echo', '$(rm -rf build)']])
	assert.equal(analysis.hasDynamicWords, true)
})

test('unterminated quote is a parse error', () => {
	assert.equal(analyzePosixCommand("rm 'unterminated").hasParseErrors, true)
})

test('over-long input is reported by the caller, not here', () => {
	assert.equal(analyzePosixCommand('x'.repeat(10_001)).commands.length, 1)
})

test('compound constructs are skipped whole', () => {
	const before = analyzePosixCommand('for x in a; do echo hi; done; rm -rf build')
	assert.equal(before.commands.length, 1)
	assert.deepEqual(before.commands[0].words.map((w) => w.value), ['rm', '-rf', 'build'])
	assert.equal(before.hasUnsupportedSyntax, true)

	const inside = analyzePosixCommand('for x in a; do rm -rf build; done')
	assert.equal(inside.commands.length, 0)
	assert.equal(inside.hasUnsupportedSyntax, true)

	const grouped = analyzePosixCommand('if [ -f x ]; then rm -rf build; fi')
	assert.equal(grouped.commands.length, 0)
	assert.equal(grouped.hasUnsupportedSyntax, true)

	const conditional = analyzePosixCommand('[[ -f x ]] && echo ok')
	assert.equal(conditional.hasUnsupportedSyntax, true)

	const subshell = analyzePosixCommand('(echo hi && rm -rf build)')
	assert.equal(subshell.hasUnsupportedSyntax, true)
})

test('heredoc marks unsupported', () => {
	assert.equal(analyzePosixCommand('cat <<EOF\nrm -rf build\nEOF').hasUnsupportedSyntax, true)
})

test('background execution marks unsupported but keeps the command', () => {
	const analysis = analyzePosixCommand('rm -rf build &')
	assert.equal(analysis.commands.length, 1)
	assert.equal(analysis.hasUnsupportedSyntax, true)
})
