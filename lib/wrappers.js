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
 * Wrapper peeling: strip `env`/`time`/`sudo` and leading `VAR=value`
 * assignments to reach the command that actually runs.
 *
 * Ported from ZCode (`apps/zcode-cli/packages/core/src/tool/handlers/guarded/wrappers.ts`).
 *
 * @module dsh-rule-guard/wrappers
 */

import { optionTable, parseOptions, WRAPPER_SCAN } from './options.js'
import { commandBasename } from './word.js'

const WRAPPERS = {
	env: optionTable('-i --ignore-environment -0 --null -v --debug', '-u --unset -C --chdir'),
	time: optionTable('-a --append -p --portability -v --verbose -q --quiet', '-o --output -f --format'),
	sudo: optionTable(
		'-A --askpass -b --background -E --preserve-env -H --set-home -K --remove-timestamp -k --reset-timestamp -n --non-interactive -S --stdin',
		'-u --user -g --group -h --host -p --prompt -C --close-from -T --command-timeout -D --chdir -R --chroot',
	),
}

/**
 * Peel wrapper commands until the real command's first word is reached.
 *
 * A wrapper's unknown option decides where the real command begins, so
 * guessing would be unsound: an unknown wrapper option makes the whole
 * invocation unsupported. `env`/`sudo` may also carry `VAR=value` prefixes,
 * which are skipped; they are environment decoration, not a new command.
 *
 * @param {import('./word.js').CommandWord[]} input - one invocation's words.
 * @param {boolean} windows - whether the dialect compares Windows names.
 * @returns {import('./word.js').CommandWord[] | undefined} the unwrapped words, or `undefined` when unsupported.
 */
export function unwrapCommand(input, windows) {
	let words = input
	while (words.length) {
		const name = commandBasename(words[0], windows)
		if (!name) return undefined
		if (!(name in WRAPPERS)) return words
		const parsed = parseOptions(words.slice(1), WRAPPERS[name], WRAPPER_SCAN)
		if (parsed.unsupported) return undefined
		words = parsed.operands
		if (name === 'env' || name === 'sudo') {
			while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) words = words.slice(1)
		}
	}
	return undefined
}

export default { unwrapCommand }
