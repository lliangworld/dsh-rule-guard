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
 *                                                          and the destructive-subcommand table
 *                                                          kept as data.
 * The upstream attribution and the Apache License 2.0 text are in
 * THIRD-PARTY-NOTICES.md.
 */
/**
 * Git's destructive subcommands: reset --hard, clean -f, push --force,
 * checkout/restore discards, stash clear, worktree remove -f.
 *
 * Ported from ZCode (`apps/zcode-cli/packages/core/src/tool/handlers/guarded/git.ts`),
 * whose comments record the boundary fixes each rule carries: front arguments
 * abort on unknown options, unambiguous flag abbreviations count, and a
 * `-h/--help` spelling is a reliable query exit.
 *
 * @module dsh-rule-guard/git
 */

import { COMMAND_SCAN, enabled, optionTable, parseOptions, settleRule, WRAPPER_SCAN } from './options.js'

// Front arguments use the abort policy: an unknown option makes the whole
// command unsupported, so -c/-p/-P/--exec-path must be recognized here to
// skip them by arity without interpreting configuration content.
const FRONT = optionTable(
	'--no-pager -P --paginate -p --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --bare --no-replace-objects --no-optional-locks',
	'-C --git-dir --work-tree --namespace -c --config-env --super-prefix',
	'--exec-path',
)
const HELP = '-h --help'
const COMMON = `${HELP} -q --quiet -v --verbose`
const RESET = optionTable(
	`${COMMON} --hard --soft --mixed --merge --keep -p --patch -N --intent-to-add --no-refresh --refresh --recurse-submodules --no-recurse-submodules`,
)
const CLEAN = optionTable(
	`${COMMON} -f --force -d -x -X -n --dry-run --no-dry-run -i --interactive`,
	'-e --exclude',
)
const PUSH = optionTable(
	`${COMMON} -f --force --no-force --mirror --no-mirror -n --dry-run --no-dry-run --no-force-with-lease --force-if-includes --no-force-if-includes --all --branches --tags --delete -d --prune --atomic --no-atomic --porcelain --follow-tags --no-follow-tags --set-upstream -u --thin --no-thin --progress --no-progress --ipv4 -4 --ipv6 -6`,
	'--repo --receive-pack --exec -o --push-option',
	'--force-with-lease --signed --recurse-submodules',
)
const CHECKOUT = optionTable(
	`${COMMON} -f --force --no-force --detach --ours --theirs -m --merge --conflict -p --patch --ignore-other-worktrees --recurse-submodules --no-recurse-submodules --no-overlay --overlay`,
	'-b -B --orphan --conflict',
)
const RESTORE = optionTable(
	`${COMMON} -W --worktree --no-worktree -S --staged --no-staged --ours --theirs -m --merge -p --patch --ignore-unmerged --overlay --no-overlay --recurse-submodules --no-recurse-submodules`,
	'-s --source --conflict',
)
const FORCE = ['-f', '--force']
const TREE = new Set(['.', './', ':/'])

/**
 * Git subcommands whose command line cannot hide a destructive effect.
 *
 * ZCode answers `undefined` for every subcommand outside its destructive
 * grammar, which is right for a capability grantor: "I cannot prove this is
 * safe, so I grant nothing". This plugin is a gate, so the same answer would
 * prompt on `git status` and `git log`. The subcommands below are the
 * ordinary read and local-workflow set; anything outside them — `git rm`,
 * `git update-ref`, `git filter-branch`, `git tag -d`, `git branch -D` —
 * stays `undefined` and therefore asks.
 */
const SAFE_GIT_SUBCOMMANDS = new Set([
	'status',
	'log',
	'diff',
	'show',
	'branch',
	'fetch',
	'pull',
	'merge',
	'add',
	'commit',
	'mv',
	'switch',
	'tag',
	'remote',
	'config',
	'reflog',
	'shortlog',
	'describe',
	'blame',
	'annotate',
	'rev-parse',
	'ls-files',
	'ls-remote',
	'ls-tree',
	'grep',
	'show-ref',
	'show-branch',
	'symbolic-ref',
	'rev-list',
	'whatchanged',
	'cherry',
	'cherry-pick',
	'rebase',
	'revert',
	'apply',
	'format-patch',
	'am',
	'request-pull',
	'bundle',
	'clone',
	'init',
	'submodule',
	'sparse-checkout',
	'notes',
	'bisect',
	'mergetool',
	'difftool',
	'help',
	'version',
	'var',
	'count-objects',
	'fsck',
	'gc',
	'prune',
	'repack',
	'pack-refs',
	'unpack-objects',
	'verify-commit',
	'verify-tag',
	'check-ignore',
	'check-attr',
	'for-each-ref',
	'merge-base',
	'merge-tree',
	'name-rev',
	'patch-id',
	'stripspace',
	'interpret-trailers',
	'write-tree',
	'read-tree',
	'mktree',
	'hash-object',
	'cat-file',
	'index-pack',
	'pack-objects',
	'upload-pack',
	'receive-pack',
	'gui',
	'citool',
	'range-diff',
	'stash',
	'worktree',
])

/**
 * `false` = supported and unmatched; `undefined` = beyond this grammar.
 * @typedef {string | false | undefined} RuleMatch
 */

/**
 * Match one `git` invocation.
 *
 * @param {import('./word.js').CommandWord[]} words - the words after `git`.
 * @returns {RuleMatch} the rule id, `false`, or `undefined` when unsupported.
 */
export function matchGit(words) {
	const front = parseOptions(words, FRONT, WRAPPER_SCAN)
	if (front.unsupported || front.operands[0]?.dynamic) return undefined
	const [head, ...args] = front.operands
	if (!head) return false
	let table
	switch (head.value) {
		case 'reset':
			table = RESET
			break
		case 'clean':
			table = CLEAN
			break
		case 'push':
			table = PUSH
			break
		case 'checkout':
			table = CHECKOUT
			break
		case 'restore':
			table = RESTORE
			break
		case 'stash': {
			if (args[0]?.dynamic) return undefined
			if (args[0]?.value !== 'clear') return false
			const parsed = parseOptions(args.slice(1), optionTable(HELP), COMMAND_SCAN)
			return settleRule(!hasHelp(parsed.flags) && 'git-stash-clear', parsed)
		}
		case 'worktree': {
			if (args[0]?.dynamic) return undefined
			if (args[0]?.value !== 'remove') return false
			const parsed = parseOptions(
				args.slice(1),
				optionTable(`${HELP} -f --force --no-force`),
				COMMAND_SCAN,
			)
			return settleRule(
				!hasHelp(parsed.flags) && enabled(parsed.flags, FORCE, ['--no-force']) && 'git-worktree-force-remove',
				parsed,
			)
		}
		default:
			// An ordinary read or local-workflow subcommand is a supported
			// miss; anything else is beyond this grammar and asks.
			return SAFE_GIT_SUBCOMMANDS.has(head.value) ? false : undefined
	}
	const parsed = parseOptions(args, table, COMMAND_SCAN)
	const { flags, operands } = parsed
	// Git's -h/--help is a reliable query exit; an unknown option does not
	// change that, and it does not erase an already recognized force/hard.
	if (hasHelp(flags)) return false
	const dryRun = enabled(flags, ['-n', '--dry-run'], ['--no-dry-run'])
	const force = enabled(flags, FORCE, ['--no-force'])
	switch (head.value) {
		case 'reset':
			return settleRule(
				enabled(flags, ['--hard'], ['--soft', '--mixed', '--merge', '--keep', '-p', '--patch']) &&
					'git-reset-hard',
				parsed,
			)
		case 'clean':
			return settleRule(!dryRun && force && 'git-clean-force', parsed)
		case 'push': {
			const refspecs = flags.includes('--repo') ? operands : operands.slice(1)
			// A glob marks the whole word dynamic, but a known `+` prefix is
			// still strong evidence of a force refspec.
			return settleRule(
				!dryRun &&
					(force ||
						enabled(flags, ['--force-with-lease'], ['--no-force-with-lease']) ||
						enabled(flags, ['--mirror'], ['--no-mirror']) ||
						refspecs.some((w) => w.value.startsWith('+'))) &&
					'git-push-force',
				parsed,
			)
		}
		case 'checkout':
			return settleRule(
				(force || operands.some((w) => !w.dynamic && TREE.has(w.value))) && 'git-discard-tree',
				parsed,
			)
		case 'restore': {
			const stagedOnly =
				enabled(flags, ['-S', '--staged'], ['--no-staged']) &&
				!enabled(flags, ['-W', '--worktree'], ['--no-worktree'])
			return settleRule(
				!stagedOnly && operands.some((w) => !w.dynamic && TREE.has(w.value)) && 'git-discard-tree',
				parsed,
			)
		}
		default:
			return false
	}
}

function hasHelp(flags) {
	return flags.includes('--help') || flags.includes('-h')
}

export default { matchGit }
