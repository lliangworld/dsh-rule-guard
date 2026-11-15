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
 *                                                          and the rule ids and reasons localized
 *                                                          for this bundle.
 * The upstream attribution and the Apache License 2.0 text are in
 * THIRD-PARTY-NOTICES.md.
 */
/**
 * POSIX-dialect command rules: `rm`, `find -delete`, storage tools, `rsync`
 * deletion, and the `git` family.
 *
 * The rule bodies are ported from ZCode
 * (`apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.ts`), whose
 * comments explain each boundary: BSD `rm` stops parsing options after the
 * first operand, an unknown option never revokes recognized evidence, and an
 * isolated `--help`/`--version` is a query exit rather than a delete.
 *
 * @module dsh-rule-guard/posix
 */

import { matchFindDelete } from './find.js'
import { matchGit } from './git.js'
import { matchCmdDelete, matchRobocopyDelete } from './windows-delete.js'
import { COMMAND_SCAN, enabled, optionTable, parseOptions, settleRule } from './options.js'
import { commandBasename } from './word.js'

const RM = optionTable(
	'-r -R --recursive -f --force -i -I --one-file-system --preserve-root --no-preserve-root -v --verbose -d --dir --help --version',
	'',
	'--interactive',
)
const RSYNC_DELETE = [
	'--delete',
	'--del',
	'--delete-before',
	'--delete-during',
	'--delete-delay',
	'--delete-after',
	'--delete-excluded',
]
const RSYNC = optionTable(
	`-a -r -v -q -z -h -P -p -t -g -o -D -l -H -A -X -u -c -n --dry-run --archive --recursive --verbose --quiet --compress --progress --partial --checksum --update --numeric-ids --ignore-errors --force --help --version ${RSYNC_DELETE.join(' ')}`,
	'-e --rsh -f --filter --include --exclude --include-from --exclude-from --files-from --rsync-path --log-file --out-format --backup-dir --suffix --chmod --chown --max-delete --timeout --bwlimit --compare-dest --copy-dest --link-dest',
)

/**
 * Command names whose payload is arbitrary code rather than a shell command
 * line. The rule engine cannot analyze such a payload, so these are reported
 * unsupported (which the caller turns into an ask under the fail-closed
 * policy) instead of being mistaken for a safe command.
 */
export const OPAQUE_INTERPRETERS = new Set(['python', 'python3', 'node', 'perl', 'ruby', 'php', 'lua', 'rscript', 'deno', 'bun'])

/**
 * Whether one interpreter invocation carries inline code on its command line.
 *
 * `python -c "..."`, `node -e "..."`, `perl -e "..."` and `ruby -e "..."`
 * place another language's source text directly in the command line. The rule
 * engine has no grammar for those languages, so an inline payload is reported
 * unsupported (which asks under the fail-closed policy) rather than waved
 * through.
 *
 * @param {import('./word.js').CommandWord[]} args - the words after the interpreter.
 * @returns {boolean} whether the invocation carries inline code.
 */
export function hasInlineCode(args) {
	return args.some((word) => {
		const value = word.value
		if (word.dynamic) return false
		if (value === '-c' || value === '-e' || value === '--eval' || value === '-E' || value === '-p' || value === '--print') {
			return true
		}
		// An attached spelling such as `-cprint(1)` or `-e'code'`.
		return /^-[cpe]/.test(value) && value.length > 2
	})
}

/**
 * Match one unwrapped invocation's arguments against the POSIX rules.
 *
 * @param {string} name - the command's basename.
 * @param {import('./word.js').CommandWord[]} args - the words after the name.
 * @param {'posix' | 'cmd' | 'git-bash'} dialect - the dialect the command was written for.
 * @returns {import('./git.js').RuleMatch} the rule id, `false`, or `undefined` when unsupported.
 */
export function matchPosixInvocation(name, args, dialect) {
	if (name === 'git') return matchGit(args)
	if (OPAQUE_INTERPRETERS.has(name)) {
		// Inline code is visible and unjudgeable; a script file's contents are
		// invisible and belong to the documented blind spot.
		return hasInlineCode(args) ? undefined : false
	}
	if (dialect === 'cmd' && ['rd', 'rmdir', 'del', 'erase'].includes(name)) return matchCmdDelete(name, args)
	if (dialect !== 'cmd' && name === 'find') return matchFindDelete(args)
	if ((dialect === 'cmd' || dialect === 'git-bash') && name === 'robocopy') return matchRobocopyDelete(args, dialect)
	if (name === 'rm') {
		const parsed = parseOptions(args, RM, COMMAND_SCAN)
		// BSD rm stops parsing options after the first operand; an existence
		// scan would swallow later real file names such as --help. The target
		// count is scanned under that semantics, while dangerous options keep
		// GNU's interspersed scan, without probing the running platform.
		const targets = parseOptions(args, RM, { ordering: 'stop-at-operand', unknown: 'continue' })
		// Recursion or a syntactic batch is enough; targets are never expanded,
		// and a help/interactive option cannot cancel known dangerous evidence.
		return settleRule(
			(enabled(parsed.flags, ['-r', '-R', '--recursive']) ||
				targets.operands.length >= 2 ||
				targets.operands.some((word) => word.hasUnquotedGlob)) &&
				'remove-critical-path',
			parsed,
		)
	}
	if (['dd', 'mount', 'umount', 'mkfs'].includes(name) || /^mkfs\.[a-zA-Z0-9_-]+$/.test(name)) {
		// Only an isolated, unambiguous query form is exempt; a --help inside
		// another option's value is not an exit option.
		if (args.length === 1 && !args[0].dynamic && ['--help', '--version'].includes(args[0].value)) return false
		return !(name === 'mount' && args.length === 0) && 'system-storage'
	}
	if (name === 'rsync') {
		const parsed = parseOptions(args, RSYNC, COMMAND_SCAN)
		return settleRule(
			!parsed.flags.some((f) => ['-n', '--dry-run', '--help', '--version'].includes(f)) &&
				parsed.flags.some((f) => RSYNC_DELETE.includes(f)) &&
				'rsync-delete',
			parsed,
		)
	}
	return false
}

/**
 * The basename of one invocation's command word, or `undefined` when it is
 * dynamic. Re-exported so callers need not reach into the word module.
 *
 * @param {import('./word.js').CommandWord} word - the invocation's first word.
 * @param {boolean} windows - whether the dialect compares Windows names.
 * @returns {string | undefined} the basename.
 */
export { commandBasename }

export default { matchPosixInvocation, OPAQUE_INTERPRETERS, hasInlineCode }
