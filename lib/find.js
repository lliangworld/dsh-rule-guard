/**
 * Copyright 2026 Z.AI Co., Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Modified by lliangworld for @lliangworld/dsh-rule-guard: converted from TypeScript to JavaScript.
 * The upstream attribution and the Apache License 2.0 text are in
 * THIRD-PARTY-NOTICES.md.
 */
/**
 * `find`'s delete actions, including `-exec` payload boundaries.
 *
 * Ported from ZCode (`apps/zcode-cli/packages/core/src/tool/handlers/guarded/find.ts`).
 *
 * @module dsh-rule-guard/find
 */

const FLAGS = new Set(
	'-H -L -P -O0 -O1 -O2 -O3 -depth -d -x -xdev -mount -ignore_readdir_race -noignore_readdir_race -daystart -follow -noleaf -true -false -empty -readable -writable -executable -print -print0 -ls -prune -quit -a -and -o -or -not ! ( ) ,'.split(
		' ',
	),
)
const VALUES = new Set(
	'-D -f -name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -size -user -group -uid -gid -perm -links -inum -samefile -newer -anewer -cnewer -atime -ctime -mtime -amin -cmin -mmin -used -maxdepth -mindepth -printf -fprint -fprint0 -fls -files0-from'.split(
		' ',
	),
)
const EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/**
 * Match a finite `find` expression for a delete action.
 *
 * An `-exec` payload must be closed before its end can be judged; the payload
 * itself is not analyzed. An option with unknown arity must not turn the
 * following value into an action, so the whole expression becomes unsupported.
 *
 * @param {import('./word.js').CommandWord[]} args - the words after `find`.
 * @returns {import('./git.js').RuleMatch} the rule id, `false`, or `undefined` when unsupported.
 */
export function matchFindDelete(args) {
	let expression = false
	for (let i = 0; i < args.length; i++) {
		const word = args[i]
		const value = word.value
		if (!expression && !value.startsWith('-') && !['!', '('].includes(value)) continue
		if (word.dynamic) return undefined
		// BSD's -d/-x may precede the start paths; treating them as expression
		// start would mistake a later path for an unknown predicate.
		if (['-H', '-L', '-P', '-O0', '-O1', '-O2', '-O3', '-d', '-x'].includes(value) && !expression) continue
		if (['-D', '-f'].includes(value) && !expression) {
			if (!args[++i]) return undefined
			continue
		}
		expression = true
		if (value === '-delete') return 'find-delete'
		if (EXEC.has(value)) {
			let closed = false
			while (++i < args.length) {
				const token = args[i]
				if (
					!token.dynamic &&
					(token.value === ';' ||
						(token.value === '+' && args[i - 1]?.value === '{}' && ['-exec', '-execdir'].includes(value)))
				) {
					closed = true
					break
				}
			}
			if (!closed) return undefined
		} else if (value === '-fprintf' || VALUES.has(value) || /^-newer[acmBt][acmBt]$/.test(value)) {
			i += value === '-fprintf' ? 2 : 1
			if (!args[i]) return undefined
		} else if (!FLAGS.has(value)) return undefined
	}
	return false
}

export default { matchFindDelete }
