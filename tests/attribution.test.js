import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Attribution and license obligations for the code derived from ZCode.
 *
 * ZCode's guarded command matcher is Apache-2.0, so redistributing a derivative
 * carries four duties: ship the license text (§4(a)), mark modified files
 * (§4(b)), keep the upstream's copyright notice (§4(c)), and keep the upstream
 * NOTICE entries that pertain to the derived parts (§4(d)). Each of the four is
 * asserted here, so a later edit cannot quietly drop one.
 *
 * The ZCode checkout is only needed for the verbatim-text comparison; the other
 * assertions read this repository alone.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const packageJson = () => JSON.parse(read('package.json'))
const zcodeRoot = () => process.env.ZCODE_ROOT

/** Every file derived from ZCode, with the upstream path it came from. */
const DERIVED = {
	'lib/word.js': 'guarded/word.ts',
	'lib/options.js': 'guarded/options.ts',
	'lib/cmd.js': 'guarded/cmd.ts',
	'lib/git.js': 'guarded/git.ts',
	'lib/find.js': 'guarded/find.ts',
	'lib/wrappers.js': 'guarded/wrappers.ts',
	'lib/windows-delete.js': 'guarded/windows-delete.ts',
	'lib/posix.js': 'guarded/command.ts',
	'tests/analyze.test.js': 'tests/guarded-command.test.ts',
	'tests/cmd-rules.test.js': 'tests/guarded-deletion.test.ts',
}

test('the three license files exist', () => {
	assert.ok(existsSync(path.join(root, 'LICENSE')), 'LICENSE is missing')
	assert.ok(existsSync(path.join(root, 'NOTICE.md')), 'NOTICE.md is missing')
	assert.ok(existsSync(path.join(root, 'THIRD-PARTY-NOTICES.md')), 'THIRD-PARTY-NOTICES.md is missing')
})

test('every derived file carries the upstream copyright and license', () => {
	// Apache-2.0 §4(c): retain the upstream's copyright notice. The upstream's
	// own LICENSE appendix supplies the boilerplate to attach.
	for (const file of Object.keys(DERIVED)) {
		const text = read(file)
		assert.match(text, /Copyright 2026 Z\.AI Co\., Ltd/, `${file} is missing the upstream copyright`)
		assert.match(
			text,
			/Licensed under the Apache License, Version 2\.0 \(the "License"\)/,
			`${file} is missing the upstream license statement`,
		)
		assert.match(text, /http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0/, `${file} is missing the license URL`)
	}
})

test('every derived file states that it was changed', () => {
	// Apache-2.0 §4(b): a modified file carries a prominent notice that it was
	// changed. The `Ported from ZCode (...)` note says where it came from but
	// not that this copy differs, so the `Modified by` line is what discharges
	// this duty.
	for (const file of Object.keys(DERIVED)) {
		assert.match(read(file), /Modified by lliangworld/, `${file} does not state that it was changed`)
	}
})

test('the derived set matches the files that declare themselves derived', () => {
	// A file that names ZCode as its source but is not in the list above has no
	// upstream header; a listed file that no longer names ZCode has lost its
	// provenance. Both directions are failures. Either phrasing counts, because
	// `lib/posix.js` says "The rule bodies are ported from ZCode" where the
	// others say "Ported from ZCode".
	const declaresZCode = (text) => /Ported from ZCode|ported from ZCode/.test(text)
	for (const file of Object.keys(DERIVED)) {
		assert.ok(declaresZCode(read(file)), `${file} is listed as derived but no longer says so`)
	}
	const lib = readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.js'))
	const selfDeclared = lib.filter((name) => declaresZCode(read(`lib/${name}`)))
	const expected = Object.keys(DERIVED)
		.filter((file) => file.startsWith('lib/'))
		.map((file) => path.basename(file))
	assert.deepEqual(
		selfDeclared.sort(),
		expected.sort(),
		'a lib/ module names ZCode but is not in the derived set, or vice versa',
	)
})

test('NOTICE.md names every derived file and its upstream', () => {
	const notice = read('NOTICE.md')
	for (const [file, upstream] of Object.entries(DERIVED)) {
		assert.ok(notice.includes(file), `NOTICE.md does not list ${file}`)
		assert.ok(notice.includes(upstream), `NOTICE.md does not name the upstream ${upstream}`)
	}
	// Apache-2.0 §4(d): the upstream NOTICE entry that pertains to the derived
	// part is retained.
	assert.ok(notice.includes('Apache-2.0'), 'NOTICE.md does not retain the upstream first-party license notice')
	// And it records why the rest of that NOTICE is absent.
	assert.match(notice, /do not pertain|不 pertain|excluded/, 'NOTICE.md does not explain the excluded sections')
})

test('THIRD-PARTY-NOTICES.md reproduces the license texts verbatim', async () => {
	// Apache-2.0 §4(a): recipients get a copy of the license. ISC asks the same
	// for unbash, whose contract this bundle reimplements.
	const notices = read('THIRD-PARTY-NOTICES.md')
	for (const line of [
		'Apache License',
		'Version 2.0, January 2004',
		'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
		'END OF TERMS AND CONDITIONS',
	]) {
		assert.ok(notices.includes(line), `THIRD-PARTY-NOTICES.md is missing "${line}"`)
	}
	assert.match(notices, /ISC License/)
	assert.match(notices, /Lars Kappert/)
	assert.match(notices, /Z\.AI Co\., Ltd/)

	// The Apache text must be the upstream's, not a paraphrase. Compared against
	// the ZCode checkout when one is available.
	const zcode = zcodeRoot()
	if (zcode === undefined || !existsSync(path.join(zcode, 'LICENSE'))) {
		console.log('        (ZCODE_ROOT not set: skipping the verbatim comparison)')
		return
	}
	const upstream = readFileSync(path.join(zcode, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trimEnd()
	assert.ok(notices.includes(upstream), 'the Apache License text differs from the upstream LICENSE')
})

test('the license files ship with the bundle', () => {
	// `files` is what npm packs. NOTICE.md and THIRD-PARTY-NOTICES.md are not in
	// npm's automatic set, so a missing entry means they never reach an
	// installed copy - which no local test would otherwise catch.
	const files = packageJson().files
	for (const name of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md']) {
		assert.ok(files.includes(name), `package.json "files" omits ${name}`)
	}
})

test('LICENSE states what it covers', () => {
	// A lone MIT file reads as if the whole work were MIT, which is not true of
	// the derived parts. The clarification at the top is what prevents that.
	const license = read('LICENSE')
	assert.match(license, /MIT License/)
	assert.match(license, /Apache License, Version 2\.0/, 'LICENSE does not point at the Apache-2.0 portion')
	assert.match(license, /THIRD-PARTY-NOTICES\.md/, 'LICENSE does not point at the license texts')
})
