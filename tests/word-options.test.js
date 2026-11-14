import { test } from 'node:test'
import assert from 'node:assert/strict'
import { literalPosixWord, commandBasename } from '../lib/word.js'
import { parseOptions, optionTable, enabled, settleRule } from '../lib/options.js'
import { unwrapCommand } from '../lib/wrappers.js'
import { analyzeCmdCommand } from '../lib/cmd.js'
import { analyzePosixCommand } from '../lib/posix-splitter.js'

test('word facts: quotes, escapes, expansions and globs', () => {
	const plain = literalPosixWord('build', 0, 5)
	assert.deepEqual(plain, { value: 'build', dynamic: false, hasUnquotedGlob: false, start: 0, end: 5 })

	const single = literalPosixWord("'rm -rf build'", 0, 14)
	assert.equal(single.value, 'rm -rf build')
	assert.equal(single.dynamic, false)

	const double = literalPosixWord('"$target"', 0, 9)
	assert.equal(double.dynamic, true)

	const glob = literalPosixWord('*.log', 0, 5)
	assert.equal(glob.hasUnquotedGlob, true)
	assert.equal(glob.dynamic, true)

	const escaped = literalPosixWord('r\\m', 0, 3)
	assert.equal(escaped.value, 'rm')
	assert.equal(escaped.dynamic, false)

	const unterminated = literalPosixWord("'oops", 0, 5)
	assert.equal(unterminated.dynamic, true)
})

test('command basename strips a path prefix and normalizes Windows names', () => {
	const posix = literalPosixWord('/usr/bin/sudo', 0, 13)
	assert.equal(commandBasename(posix, false), 'sudo')
	// Windows paths come from the CMD tokenizer, where a backslash is a path
	// separator rather than a POSIX escape.
	const windows = analyzeCmdCommand('"C:\\Tools\\git.exe" reset --hard').commands[0][0]
	assert.equal(windows.value, 'C:\\Tools\\git.exe')
	assert.equal(commandBasename(windows, true), 'git')
	const dynamic = literalPosixWord('$exe', 0, 4)
	assert.equal(commandBasename(dynamic, false), undefined)
})

test('enabled honors later cancellation', () => {
	assert.equal(enabled(['-f', '--no-force'], ['-f', '--force'], ['--no-force']), false)
	assert.equal(enabled(['--no-force', '-f'], ['-f', '--force'], ['--no-force']), true)
	// `-n --no-dry-run` ends with the cancellation, so it is not a dry run.
	assert.equal(enabled(['-n', '--no-dry-run'], ['-n', '--dry-run'], ['--no-dry-run']), false)
	assert.equal(enabled(['--no-dry-run', '-n'], ['-n', '--dry-run'], ['--no-dry-run']), true)
})

test('option scanning honors declared arity and unknown-option policy', () => {
	const table = optionTable('-r -f --help', '-o')
	const words = analyzePosixCommand('rm --unknown -rf target').commands[0].words.slice(1)
	const parsed = parseOptions(words, table, { ordering: 'interspersed', unknown: 'continue' })
	assert.equal(parsed.unsupported, true)
	assert.deepEqual(parsed.flags, ['-r', '-f'])
	assert.deepEqual(parsed.operands.map((word) => word.value), ['target'])
})

test('stop-at-operand scanning keeps later words as operands', () => {
	const words = analyzePosixCommand('rm -rf target --help').commands[0].words.slice(1)
	const stopped = parseOptions(words, optionTable('-r -f --help'), { ordering: 'stop-at-operand', unknown: 'abort' })
	assert.deepEqual(stopped.flags, ['-r', '-f'])
	assert.deepEqual(stopped.operands.map((word) => word.value), ['target', '--help'])
	const interspersed = parseOptions(words, optionTable('-r -f --help'), {
		ordering: 'interspersed',
		unknown: 'continue',
	})
	assert.deepEqual(interspersed.flags, ['-r', '-f', '--help'])
	assert.deepEqual(interspersed.operands.map((word) => word.value), ['target'])
})

test('wrapper abort policy stops at the first unknown option', () => {
	const words = analyzePosixCommand('time --unknown rm -rf target').commands[0].words.slice(1)
	const parsed = parseOptions(words, optionTable('-p'), { ordering: 'stop-at-operand', unknown: 'abort' })
	assert.equal(parsed.unsupported, true)
	assert.deepEqual(parsed.flags, [])
})

test('enabled honors later cancellation', () => {
	assert.equal(enabled(['-f', '--no-force'], ['-f', '--force'], ['--no-force']), false)
	assert.equal(enabled(['--no-force', '-f'], ['-f', '--force'], ['--no-force']), true)
	// `-n --no-dry-run` ends with the cancellation, so it is not a dry run.
	assert.equal(enabled(['-n', '--no-dry-run'], ['-n', '--dry-run'], ['--no-dry-run']), false)
	assert.equal(enabled(['--no-dry-run', '-n'], ['-n', '--dry-run'], ['--no-dry-run']), true)
})

test('settleRule prefers a hit, then unsupported, then a clean miss', () => {
	assert.equal(settleRule('remove-critical-path', { unsupported: true }), 'remove-critical-path')
	assert.equal(settleRule(false, { unsupported: true }), undefined)
	assert.equal(settleRule(false, { unsupported: false }), false)
})

test('wrapper peeling reaches the real command', () => {
	const words = analyzePosixCommand("env -C repo time -f '%e' sudo --user=root rm -rf build").commands[0].words
	assert.deepEqual(unwrapCommand(words, false)?.map((word) => word.value), ['rm', '-rf', 'build'])
	const envAssignment = analyzePosixCommand("env A='rm -rf build' echo ok").commands[0].words
	assert.deepEqual(unwrapCommand(envAssignment, false)?.map((word) => word.value), ['echo', 'ok'])
	const unknown = analyzePosixCommand("env -S 'rm -rf build'").commands[0].words
	assert.equal(unwrapCommand(unknown, false), undefined)
})
