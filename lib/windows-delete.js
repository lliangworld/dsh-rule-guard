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
 *                                                          with the documented deviation from the
 *                                                          upstream `del file` behavior.
 * The upstream attribution and the Apache License 2.0 text are in
 * THIRD-PARTY-NOTICES.md.
 */
/**
 * Windows delete forms: CMD builtins (`rd`, `rmdir`, `del`, `erase`) and
 * Robocopy's mirror/purge deletion.
 *
 * Ported from ZCode (`apps/zcode-cli/packages/core/src/tool/handlers/guarded/windows-delete.ts`).
 *
 * @module dsh-rule-guard/windows-delete
 */

/**
 * Match one CMD builtin delete.
 *
 * Slash switches are interpreted only on the CMD branch. An isolated `/?"`
 * help spelling is not a delete call. An unrecognized switch marks the
 * invocation unsupported, but a confirmed target and tree/recursive switch
 * still wins by hit-first settlement.
 *
 * Deviation from ZCode, deliberate: ZCode matches `del file` outright, which
 * would prompt on every single-file delete. A batch, a recursion or an
 * unquoted glob is what makes a `del` dangerous, so those are matched and a
 * single literal target is not.
 *
 * @param {string} name - the builtin's basename (already lowercased).
 * @param {import('./word.js').CommandWord[]} args - the words after the builtin.
 * @returns {import('./git.js').RuleMatch} the rule id, `false`, or `undefined` when unsupported.
 */
export function matchCmdDelete(name, args) {
	if (args.length === 1 && args[0].value === '/?' && !args[0].dynamic) return false
	const tree = name === 'rd' || name === 'rmdir'
	let recursive = false
	let targets = 0
	let glob = false
	let unsupported = false
	for (const word of args) {
		const value = word.value.toUpperCase()
		if (!value.startsWith('/') || word.dynamic) {
			targets++
			if (word.hasUnquotedGlob) glob = true
			continue
		}
		for (const option of value.slice(1).split('/')) {
			if (option === 'S') recursive = true
			else if (
				!['Q', '?', ...(!tree ? ['P', 'F'] : [])].includes(option) &&
				!(!tree && /^A(?::?[-RASHIO]*)$/.test(option))
			)
				unsupported = true
		}
	}
	if (tree) return targets > 0 && recursive ? 'cmd-remove-tree' : unsupported ? undefined : false
	if (targets > 0 && (recursive || glob || targets >= 2)) return 'cmd-delete-files'
	return unsupported ? undefined : false
}

const ROBOCOPY_FLAGS = new Set(
	'/MIR /PURGE /L /S /E /Z /B /ZB /J /EFSRAW /SEC /COPYALL /NOCOPY /SECFIX /TIMFIX /CREATE /FAT /256 /PF /SJ /SL /NODCOPY /NOOFFLOAD /COMPRESS /A /M /XC /XN /XO /XX /XL /IM /IS /IT /XJ /FFT /DST /XJD /XJF /TBD /LFSM /X /V /TS /FP /BYTES /NS /NC /NFL /NDL /NP /ETA /TEE /NJH /NJS /UNICODE /?'.split(
		' ',
	),
)
const ROBOCOPY_VALUES = new Set(
	'/LEV /COPY /DCOPY /A+ /A- /MON /MOT /RH /IPG /MT /IOMAXSIZE /IORATE /THRESHOLD /IA /XA /MAX /MIN /MAXAGE /MINAGE /MAXLAD /MINLAD /R /W /LFSM /LOG /LOG+ /UNILOG /UNILOG+'.split(
		' ',
	),
)

/**
 * Match a Robocopy invocation for mirror/purge deletion.
 *
 * A value option binds with a colon; an XF/XD exclusion list ends at the next
 * slash switch. Git Bash rewrites `/c/...` into a Windows drive path, which is
 * argv syntax rather than an unknown slash switch, so it requires a slash after
 * the drive letter before counting as a path.
 *
 * @param {import('./word.js').CommandWord[]} args - the words after `robocopy`.
 * @param {'cmd' | 'git-bash'} dialect - the shell the invocation was written for.
 * @returns {import('./git.js').RuleMatch} the rule id, `false`, or `undefined` when unsupported.
 */
export function matchRobocopyDelete(args, dialect) {
	if (args.length < 2) return false
	let deletion = false
	let listOnly = false
	let paths = 0
	let exclusions = false
	for (const word of args) {
		const value = word.value.toUpperCase()
		if (word.dynamic) return deletion ? 'robocopy-delete' : undefined
		const drivePath = dialect === 'git-bash' && /^\/[a-z]\//i.test(word.value)
		if (!value.startsWith('/') || drivePath) {
			if (!exclusions) paths++
			continue
		}
		exclusions = value === '/XF' || value === '/XD'
		if (value === '/MIR' || value === '/PURGE') deletion = true
		else if (value === '/L') listOnly = true
		else if (value === '/XF' || value === '/XD' || ROBOCOPY_FLAGS.has(value)) continue
		else if (value.includes(':') && ROBOCOPY_VALUES.has(value.split(':', 1)[0])) continue
		// A JOB file and unknown-arity switches can neither create an exemption
		// nor revoke a deletion already located precisely.
		else return deletion ? 'robocopy-delete' : undefined
	}
	return paths >= 2 && deletion && !listOnly && 'robocopy-delete'
}

export default { matchCmdDelete, matchRobocopyDelete }
