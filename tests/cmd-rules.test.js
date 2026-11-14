import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCommand } from '../lib/analyze.js'
import { analyzeCmdCommand } from '../lib/cmd.js'

const cmd = (command) => analyzeCommand(command, { dialect: 'cmd' })

test('CMD dangerous forms ask', () => {
	const cases = [
		['rm -rf build', 'remove-critical-path'],
		['rd /s /q build', 'cmd-remove-tree'],
		['rmdir /s build', 'cmd-remove-tree'],
		['del /s /q *.log', 'cmd-delete-files'],
		['erase /s file.txt', 'cmd-delete-files'],
		['git reset --hard', 'git-reset-hard'],
		['git clean -fd', 'git-clean-force'],
		['git push --force origin main', 'git-push-force'],
		['git stash clear', 'git-stash-clear'],
		['robocopy src dst /MIR', 'robocopy-delete'],
		['robocopy src dst /PURGE', 'robocopy-delete'],
	]
	for (const [command, ruleId] of cases) {
		const decision = cmd(command)
		assert.equal(decision.kind, 'ask', command)
		assert.equal(decision.ruleId, ruleId, command)
	}
})

test('CMD trailing redirection keeps the command matched', () => {
	for (const command of [
		'git reset --hard 2>nul',
		'git reset --hard > out.txt',
		'git reset --hard >> out.txt',
		'git push --force origin main 2>nul',
		'rm -rf build 2>nul',
		'rm -rf build 2> nul',
	]) {
		assert.equal(cmd(command).kind, 'ask', command)
	}
})

test('CMD redirection without a target stays unsupported', () => {
	for (const command of ['git reset --hard >', 'git reset --hard 2>', 'git reset --hard > ']) {
		assert.equal(cmd(command).kind, 'unsupported', command)
	}
})

test('CMD quotes and comments are not commands', () => {
	for (const command of [
		'rem rm -rf build',
		':: rm -rf build',
		'echo "rm -rf build"',
		"'rm' -rf build",
		"git reset '--hard'",
		'(echo hi & (rm -rf build))',
	]) {
		assert.notEqual(cmd(command).kind, 'ask', command)
	}
})

test('CMD preserves actual REM comments', () => {
	for (const command of ['rem git reset --hard', '>rem rem git reset --hard', '>rem rem ignored & git reset --hard']) {
		assert.deepEqual(cmd(command), { kind: 'allow', dialect: 'cmd' })
	}
})

test('CMD redirection target is not a REM comment', () => {
	for (const redirection of ['>rem', '> rem', '2>rem', '>>rem', '<rem', '>"rem"']) {
		const decision = cmd(`${redirection} git reset --hard`)
		assert.equal(decision.kind, 'ask', redirection)
		assert.equal(decision.ruleId, 'git-reset-hard', redirection)
	}
})

test('CMD separators and quoted executables', () => {
	for (const command of [
		'rm -rf build',
		'"C:\\tools\\git.exe" reset --hard',
		'echo ok & git stash clear',
		'git clean -fd && echo ok',
	]) {
		assert.equal(cmd(command).kind, 'ask', command)
	}
})

test('robocopy option ownership', () => {
	assert.equal(cmd('robocopy src dst /MIR').kind, 'ask')
	assert.equal(cmd('robocopy src dst /MIR /L').kind, 'allow')
	assert.equal(cmd('robocopy src dst /PURGE').kind, 'ask')
	assert.equal(cmd('robocopy /unknown /c/src /c/dst /MIR').kind, 'unsupported')
	assert.equal(cmd('robocopy /JOB:job /c/src /c/dst /MIR').kind, 'unsupported')
	// An unknown switch after /L is still unsupported: a deletion already
	// located precisely cannot be revoked, but nothing can be exempted either.
	assert.equal(cmd('robocopy src dst /unknown /L /MIR').kind, 'unsupported')
	// Robocopy is only interpreted on the CMD branch, as in ZCode.
	assert.equal(analyzeCommand('robocopy src dst /MIR', { dialect: 'posix' }).kind, 'allow')
})

test('CMD tokenizer splits delete switches only for the delete builtins', () => {
	// ZCode's own contract: a slash inside another command's path is not a
	// switch, and a quoted path stays one whole word even for `rd`.
	for (const source of ['echo target/s/q', 'C:/bin/tool.exe target/s/q', 'git -C /s status']) {
		assert.deepEqual(
			analyzeCmdCommand(source).commands[0]?.map((word) => word.value),
			source.split(' '),
		)
	}
	assert.deepEqual(
		analyzeCmdCommand('rd "target/s/q"').commands[0]?.map((word) => word.value),
		['rd', 'target/s/q'],
	)
})

test('CMD ordinary commands are allowed', () => {
	for (const command of ['dir', 'echo hello', 'git status', 'pnpm test', 'type file.txt', 'del file.txt']) {
		assert.equal(cmd(command).kind, 'allow', command)
	}
})

test('CMD batch, recursive and glob deletes ask', () => {
	// A single literal target is allowed (see the documented deviation in
	// lib/windows-delete.js); a batch, a recursion or a glob is not.
	for (const command of ['del file.txt other.txt', 'del *.log', 'del /s *.txt', 'erase /P a.txt b.txt']) {
		assert.equal(cmd(command).ruleId, 'cmd-delete-files', command)
	}
})
