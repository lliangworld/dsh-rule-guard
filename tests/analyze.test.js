/**
 * Copyright 2026 Z.AI Co., Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Modified by lliangworld for @lliangworld/dsh-rule-guard: rewritten to `node:test`, with the rule
 *                                                          ids and copy localized for this bundle.
 * The upstream attribution and the Apache License 2.0 text are in
 * THIRD-PARTY-NOTICES.md.
 */
/**
 * The command corpus, ported from ZCode's guarded-command tests
 * (`apps/zcode-cli/packages/core/tests/guarded-command.test.ts`), which this
 * bundle keeps as the matcher's regression surface. The upstream file pairs
 * each rule with the command forms that must and must not match; the pairing is
 * preserved here, with the rule ids and reasons localized.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCommand, dialectForTool, compilePatterns } from '../lib/analyze.js'

const posix = (command, options = {}) => analyzeCommand(command, { dialect: 'posix', ...options })

test('ordinary commands are allowed', () => {
	for (const command of [
		'git status',
		'git log --oneline -5',
		'pnpm test',
		'npm run build',
		'ls -la',
		'cat package.json',
		'Get-Content ./README.md',
		'node script.js',
		'echo hello',
		'grep -rn "foo" src',
		'git commit -m "message"',
		'git push origin main',
		'git pull --rebase',
		'git checkout -b feature',
		'git stash',
		'python -m pytest tests/',
		'rm file.txt',
		'rm -f file.txt',
		'del file.txt',
	]) {
		assert.equal(posix(command).kind, 'allow', command)
		assert.equal(posix(command, { dialect: 'powershell' }).kind, 'allow', command)
	}
})

test('built-in dangerous commands ask', () => {
	const cases = [
		['rm -rf build', 'remove-critical-path'],
		['rm -f -R build', 'remove-critical-path'],
		['rm --recursive --force build', 'remove-critical-path'],
		['rm -rf -- -i', 'remove-critical-path'],
		['rm -rfi build', 'remove-critical-path'],
		['rm -rf build other', 'remove-critical-path'],
		['rm -rf *.log', 'remove-critical-path'],
		['dd if=in of=out', 'system-storage'],
		['mount /dev/disk /mnt', 'system-storage'],
		['mkfs.ext4 /dev/disk', 'system-storage'],
		['git reset --hard', 'git-reset-hard'],
		['git -C repo reset --hard HEAD', 'git-reset-hard'],
		['git --git-dir=repo reset --hard', 'git-reset-hard'],
		['git clean -fd', 'git-clean-force'],
		['git clean -dfx', 'git-clean-force'],
		['git clean -f file', 'git-clean-force'],
		['git push -f origin main', 'git-push-force'],
		['git push --force-with-lease', 'git-push-force'],
		['git push --mirror', 'git-push-force'],
		['git push origin +HEAD:main', 'git-push-force'],
		['git checkout -f main', 'git-discard-tree'],
		['git checkout HEAD -- .', 'git-discard-tree'],
		['git restore .', 'git-discard-tree'],
		['git restore --source=HEAD :/', 'git-discard-tree'],
		['git stash clear', 'git-stash-clear'],
		['git worktree remove -ff path', 'git-worktree-force-remove'],
		['rsync -a --delete src/ dest/', 'rsync-delete'],
		['rsync --del src/ dest/', 'rsync-delete'],
		['find . -name "*.log" -delete', 'find-delete'],
	]
	for (const [command, ruleId] of cases) {
		const decision = posix(command)
		assert.equal(decision.kind, 'ask', command)
		assert.equal(decision.ruleId, ruleId, command)
	}
})

test('benign git and shell forms are not matched', () => {
	for (const command of [
		'git reset --soft HEAD',
		'git reset -- --hard',
		'git clean -nfd',
		'git clean -fd --dry-run',
		'git push -nf',
		'git push --force --no-force',
		'git push --force-with-lease --no-force-with-lease',
		'git push --mirror --no-mirror',
		'git push --repo +not-a-refspec',
		'git push --push-option=--force',
		'git restore --staged .',
		'git restore file',
		'git checkout -b branch',
		'git checkout -b .',
		'git stash drop',
		'git worktree remove path',
		'rsync --delete -n src/ dest/',
		'rsync --exclude --delete src/ dest/',
		'rsync --filter=--delete src/ dest/',
		"echo 'rm -rf build'",
		'echo hi # rm -rf build',
		"echo hi > 'rm -rf build'",
		'time -o file echo ok',
		'sudo -u rm echo -rf build',
		"env A='rm -rf build' echo ok",
		'rm -f file',
		'rm -- -rf',
		'rm --help',
		'rm --version',
		'mount',
		'dd --help',
		'git status --short',
		'git log -p --stat',
	]) {
		assert.equal(posix(command).kind, 'allow', command)
	}
})

test('reliable command nodes are matched through wrappers and separators', () => {
	for (const command of [
		'env A=b rm -rf build',
		'env -u A rm -rf build',
		'time -o file rm -rf build',
		'/usr/bin/time --output=file rm -rf build',
		'sudo -u root rm -rf build',
		"env -C repo time -f '%e' sudo --user=root rm -rf build",
		'echo hello; rm -rf build',
		'false || rm -rf build',
		'true && rm -rf build',
		'echo hi | rm -rf build',
		'"/bin/rm" -rf build',
		'r\\m -rf build',
	]) {
		const decision = posix(command)
		assert.equal(decision.kind, 'ask', command)
		assert.equal(decision.ruleId, 'remove-critical-path', command)
	}
})

test('unjudgeable forms are unsupported, not allowed', () => {
	for (const command of [
		'eval \'rm -rf build\'',
		'$exe -rf build',
		"git -c alias.wipe='reset --hard' wipe",
		"env -S 'rm -rf build'",
		'time --unknown rm -rf build',
		'for x in a; do rm -rf build; done',
		"rm 'unterminated",
		'x'.repeat(10_001),
		'python -c "import shutil; shutil.rmtree(\'build\')"',
		'node -e "require(\'fs\').rmSync(\'build\', {recursive:true})"',
		'git $subcommand --hard',
		'rm --totally-unknown build',
	]) {
		assert.equal(posix(command).kind, 'unsupported', command)
	}
})

test('visible dangerous evidence fires even when a target is dynamic', () => {
	// The switches are literal, so the rule fires; only a dynamic command or
	// subcommand hides what will run.
	for (const [command, ruleId] of [
		['rm -rf $($evil)', 'remove-critical-path'],
		['rm -rf "$target"', 'remove-critical-path'],
		['git clean -f $paths', 'git-clean-force'],
	]) {
		const decision = posix(command)
		assert.equal(decision.kind, 'ask', command)
		assert.equal(decision.ruleId, ruleId, command)
	}
})

test('a script file is the documented blind spot, not a prompt', () => {
	// The contents of a script file are invisible to a command-line rule
	// engine, exactly as they are to `pnpm test` or `make`. Prompting on
	// every build command would make the guard unusable, so this is stated as
	// a limitation instead; the host sandbox and execution-time measures are
	// the layers that cover it.
	for (const command of ['./deploy.sh', 'bash ./deploy.sh', 'pwsh -File ./deploy.ps1']) {
		assert.equal(posix(command).kind, 'allow', command)
	}
})

test('a script file or module run is an ordinary invocation, not inline code', () => {
	for (const command of [
		'python -m pytest tests/',
		'python script.py',
		'node script.js',
		'node --version',
		'perl script.pl',
	]) {
		assert.equal(posix(command).kind, 'allow', command)
	}
})

test('interpreter payloads are analyzed as the command they run', () => {
	const dangerous = posix('bash -c \'rm -rf build\'')
	assert.equal(dangerous.kind, 'ask')
	assert.equal(dangerous.ruleId, 'remove-critical-path')
	const gitDangerous = posix('bash -c \'git clean -fdx\'')
	assert.equal(gitDangerous.kind, 'ask')
	assert.equal(gitDangerous.ruleId, 'git-clean-force')
	const safe = posix('bash -c \'git status\'')
	assert.equal(safe.kind, 'allow')
	const nested = posix('bash -c \'bash -c "git reset --hard"\'')
	assert.equal(nested.kind, 'ask')
})

test('unknown options never revoke a recognized hit', () => {
	for (const [command, ruleId] of [
		['rm -rfx build', 'remove-critical-path'],
		['rm -rfP build', 'remove-critical-path'],
		['rm -rf -W build', 'remove-critical-path'],
		['rm -rf --preserve-root=all build', 'remove-critical-path'],
		['rm -rf --totally-unknown build', 'remove-critical-path'],
		['rsync -a --delete --info=progress2 src/ dest/', 'rsync-delete'],
		['rsync -ai --delete src/ dest/', 'rsync-delete'],
		['rsync --unknown-flag --delete src/ dest/', 'rsync-delete'],
		['git push --force --no-verify origin main', 'git-push-force'],
		['git push --force --no-recurse-submodules origin main', 'git-push-force'],
		['git -c core.pager=cat reset --hard HEAD~1', 'git-reset-hard'],
		['git -p reset --hard', 'git-reset-hard'],
		['git --exec-path=/opt/git reset --hard', 'git-reset-hard'],
		['git reset --hard --totally-unknown', 'git-reset-hard'],
		['git checkout -f -t origin/main', 'git-discard-tree'],
		['git stash clear --totally-unknown', 'git-stash-clear'],
		['git worktree remove --force --totally-unknown path', 'git-worktree-force-remove'],
	]) {
		const decision = posix(command)
		assert.equal(decision.kind, 'ask', command)
		assert.equal(decision.ruleId, ruleId, command)
	}
})

test('unsupported is reported when unknown options leave no reliable hit', () => {
	for (const command of [
		'rm --totally-unknown build',
		'rsync --unknown-flag src/ dest/',
		'git push --totally-unknown origin main',
		'git reset --totally-unknown',
	]) {
		assert.equal(posix(command).kind, 'unsupported', command)
	}
})

test('cancellation words are distinct from values', () => {
	const dangerous = [
		['git clean -fd -e --dry-run', 'git-clean-force'],
		['git clean -nfd --no-dry-run', 'git-clean-force'],
		['git push -f --push-option --dry-run', 'git-push-force'],
		['git push -nf --no-dry-run', 'git-push-force'],
		['git push --mirror --no-force', 'git-push-force'],
		['rsync --delete --exclude --help src/ dest/', 'rsync-delete'],
		['rsync --delete --filter --dry-run src/ dest/', 'rsync-delete'],
	]
	const exempt = [
		'git clean -fd --dry-run',
		'git push -f --dry-run',
		'git push -f --no-dry-run -n',
		'git push --mirror --no-mirror',
		'rsync --delete --help',
		'rsync --delete -n src/ dest/',
	]
	for (const [command, ruleId] of dangerous) {
		const decision = posix(command)
		assert.equal(decision.kind, 'ask', command)
		assert.equal(decision.ruleId, ruleId, command)
	}
	for (const command of exempt) {
		assert.equal(posix(command).kind, 'allow', command)
	}
})

test('force refspec boundaries are preserved', () => {
	for (const command of [
		'git push origin +refs/heads/*:refs/heads/*',
		'git push origin "+refs/heads/*:refs/heads/*"',
		'git push origin "+main"',
		'git push --force origin "refs/heads/*:refs/heads/*"',
		'git push --repo origin +refs/heads/*:refs/heads/*',
	]) {
		assert.equal(posix(command).ruleId, 'git-push-force', command)
	}
	for (const command of [
		'git push --dry-run origin +refs/heads/*:refs/heads/*',
		'git push -n origin +refs/heads/*:refs/heads/*',
		'git push origin refs/heads/*:refs/heads/*',
		'git push --push-option "+refs/heads/*:refs/heads/*" origin main',
		'git push --repo "+refs/heads/*:refs/heads/*" main',
		'git push "+refs/heads/*:refs/heads/*" main',
	]) {
		assert.notEqual(posix(command).ruleId, 'git-push-force', command)
	}
})

test('user patterns take precedence over the built-in rules', () => {
	const allow = posix('git clean -fdx', { allowPatterns: ['^git clean -fdx$'] })
	assert.equal(allow.kind, 'allow')
	assert.equal(allow.ruleId, 'user-allow-pattern')

	const deny = posix('git status', { denyPatterns: ['^git status$'] })
	assert.equal(deny.kind, 'deny')
	assert.equal(deny.ruleId, 'user-deny-pattern')

	const ask = posix('pnpm test', { askPatterns: ['^pnpm test$'] })
	assert.equal(ask.kind, 'ask')
	assert.equal(ask.ruleId, 'user-ask-pattern')
})

test('an allow pattern releases a command the built-ins would flag', () => {
	const decision = posix('Remove-Item -Recurse -Force .\\tmp-e2e', {
		dialect: 'powershell',
		allowPatterns: ['tmp-e2e'],
	})
	assert.equal(decision.kind, 'allow')
})

test('an empty or non-string command is allowed', () => {
	assert.equal(posix('').kind, 'allow')
	assert.equal(posix('   \n  ').kind, 'allow')
})

test('dialect inference maps tool names', () => {
	assert.equal(dialectForTool('pwsh'), 'powershell')
	assert.equal(dialectForTool('powershell'), 'powershell')
	assert.equal(dialectForTool('pwsh_persistent'), 'powershell')
	assert.equal(dialectForTool('bash'), 'posix')
	assert.equal(dialectForTool('terminal'), 'posix')
	assert.equal(dialectForTool('ops_bash'), 'posix')
	assert.equal(dialectForTool('cmd'), 'cmd')
	assert.equal(dialectForTool('unknown-tool'), 'unknown')
})

test('invalid user patterns are ignored rather than fatal', () => {
	const compiled = compilePatterns(['(', '^ok$'])
	assert.deepEqual(compiled.invalid, ['('])
	assert.equal(compiled.regexps.length, 1)
	assert.equal(posix('git status', { askPatterns: ['('] }).kind, 'allow')
})
