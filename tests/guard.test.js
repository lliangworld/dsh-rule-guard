import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { apply } from '../index.js'
import { displayReason, auditReason, ruleText } from '../lib/catalog.js'
import { expandPath } from '../lib/audit.js'

/** A minimal stand-in for one config field reference. */
function ref(value) {
	return { get: () => value }
}

/** Build a fake plugin context whose `on` records the registered listener. */
function fakeContext() {
	const listeners = []
	return {
		listeners,
		effect(generator) {
			// Run the generator to obtain the disposer, as Cordis would.
			const iterator = generator.call({})
			const first = iterator.next()
			void first
			return () => iterator.return?.(new Error('disposed'))
		},
		on(event, listener) {
			listeners.push({ event, listener })
			return () => {}
		},
		logger: { warn: () => {} },
	}
}

/** One pending execution. */
function fakeExec(overrides = {}) {
	return {
		name: 'pwsh',
		arguments: { command: 'git status' },
		callId: 'call-1',
		agent: { session: { id: 'session-1' } },
		signal: new AbortController().signal,
		...overrides,
	}
}

/** The listener registered by `apply`. */
function listenerOf(context) {
	const found = context.listeners.find((entry) => entry.event === 'tools/pre-execute')
	assert.ok(found, 'the plugin must register a tools/pre-execute listener')
	return found.listener
}

/** A `next` that records whether it was reached. */
function nextSpy() {
	const spy = { called: false }
	const next = async () => {
		spy.called = true
		return { kind: 'allow' }
	}
	return { spy, next }
}

function config(overrides = {}) {
	return {
		tools: ref(['pwsh', 'bash']),
		dialect: ref('auto'),
		onUnsupported: ref('allow'),
		onError: ref('allow'),
		allowPatterns: ref([]),
		askPatterns: ref([]),
		denyPatterns: ref([]),
		maxCommandLength: ref(10000),
		audit: ref(false),
		auditPath: ref(''),
		...overrides,
	}
}

test('a tool outside the configured list falls through', async () => {
	const context = fakeContext()
	apply(context, config())
	const listener = listenerOf(context)
	const { spy, next } = nextSpy()
	const decision = await listener(fakeExec({ name: 'glob' }), next)
	assert.deepEqual(decision, { kind: 'allow' })
	assert.equal(spy.called, true)
})

test('an ordinary command falls through without asking', async () => {
	const context = fakeContext()
	apply(context, config())
	const listener = listenerOf(context)
	const { spy, next } = nextSpy()
	const decision = await listener(fakeExec({ arguments: { command: 'git status' } }), next)
	assert.deepEqual(decision, { kind: 'allow' })
	assert.equal(spy.called, true)
})

test('a matched rule asks, with a reason and a bilingual display', async () => {
	const context = fakeContext()
	apply(context, config())
	const listener = listenerOf(context)
	const { spy, next } = nextSpy()
	const decision = await listener(fakeExec({ arguments: { command: 'git clean -fdx' } }), next)
	assert.equal(decision.kind, 'ask')
	assert.match(decision.reason, /rule-guard: matched "git-clean-force"/)
	assert.equal(typeof decision.displayReason.zh, 'string')
	assert.equal(typeof decision.displayReason.en, 'string')
	assert.match(decision.displayReason.en, /git force clean/)
	assert.equal(spy.called, false)
})

test('a deny pattern denies outright with a structured error', async () => {
	const context = fakeContext()
	apply(context, config({ denyPatterns: ref(['^git status$']) }))
	const listener = listenerOf(context)
	const { spy, next } = nextSpy()
	const decision = await listener(fakeExec(), next)
	assert.equal(decision.kind, 'deny')
	assert.equal(decision.info.name, 'RuleGuardDeniedError')
	assert.equal(spy.called, false)
})

test('an unjudgeable command follows the configured policy', async () => {
	// A dynamic command name hides what will run, so the fail-closed stance
	// asks; the default stance releases it.
	const strict = fakeContext()
	apply(strict, config({ onUnsupported: ref('ask') }))
	const ask = await listenerOf(strict)(fakeExec({ arguments: { command: '& $script' } }), nextSpy().next)
	assert.equal(ask.kind, 'ask')
	assert.match(ask.reason, /no-static-verdict/)

	// A dynamic argument with no dangerous switch is an ordinary call: the
	// switches are visible, so nothing needs to be hidden from.
	const ordinary = fakeContext()
	apply(ordinary, config())
	const release = await listenerOf(ordinary)(fakeExec({ arguments: { command: '& $script' } }), nextSpy().next)
	assert.equal(release.kind, 'allow')
})

test('a fixed dialect overrides inference', async () => {
	const context = fakeContext()
	apply(context, config({ dialect: ref('powershell') }))
	const listener = listenerOf(context)
	const decision = await listener(
		fakeExec({ name: 'bash', arguments: { command: 'Remove-Item -Recurse ./x' } }),
		nextSpy().next,
	)
	assert.equal(decision.kind, 'ask')
	assert.match(decision.reason, /pwsh-remove-recursive/)
})

test('an execution without an agent falls through', async () => {
	const context = fakeContext()
	apply(context, config())
	const listener = listenerOf(context)
	const { spy, next } = nextSpy()
	const decision = await listener(fakeExec({ agent: undefined, arguments: { command: 'git clean -fdx' } }), next)
	assert.deepEqual(decision, { kind: 'allow' })
	assert.equal(spy.called, true)
})

test('decisions are written to the audit log when enabled', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'rule-guard-audit-'))
	const auditPath = path.join(directory, 'audit.jsonl')
	try {
		const context = fakeContext()
		apply(context, config({ audit: ref(true), auditPath: ref(auditPath) }))
		const listener = listenerOf(context)
		await listener(fakeExec({ arguments: { command: 'git clean -fdx' } }), nextSpy().next)
		await listener(fakeExec({ arguments: { command: 'git status' } }), nextSpy().next)
		assert.equal(existsSync(auditPath), true)
		const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
		assert.equal(lines.length, 1)
		const record = JSON.parse(lines[0])
		assert.equal(record.verdict, 'ask')
		assert.equal(record.ruleId, 'git-clean-force')
		assert.equal(record.tool, 'pwsh')
		assert.equal(record.sessionId, 'session-1')
		assert.equal(record.command, 'git clean -fdx')
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('catalog text and reasons are stable and bilingual', () => {
	const text = ruleText('git-clean-force')
	assert.equal(text.en.title, 'git force clean')
	assert.match(text.zh.title, /git/)
	const reason = auditReason('git-clean-force')
	assert.match(reason, /rule-guard: matched "git-clean-force"/)
	const display = displayReason('git-clean-force', 'pwsh')
	assert.match(display.en, /Rule guard matched "git force clean"/)
	assert.match(display.zh, /规则守卫/)
})

test('the approval headline leaves the command to the panel', () => {
	// The host's approval card renders the command itself, in full, in the
	// region below the headline, from the tool call correlated with the
	// request. Quoting it in `displayReason` as well showed it twice — once
	// truncated and once complete.
	//
	// The command is passed in as the third argument on purpose: a caller
	// that resumes quoting it would produce a headline containing it, and a
	// test that omits the argument would see only "undefined" and pass
	// anyway. Passing it makes the regression visible.
	const command = "junk | Set-Content x.txt; git -C .tmp-e2e clean -fdx"
	const display = displayReason('git-clean-force', 'pwsh', command)
	assert.ok(!display.en.includes(command), 'the English headline repeats the command')
	assert.ok(!display.zh.includes(command), 'the Chinese headline repeats the command')
	// The tool name is the one thing the command region does not show, so it
	// stays in the headline.
	assert.match(display.en, /Tool: pwsh/)
	assert.match(display.zh, /工具：pwsh/)
	// Fragments specific to *this command* must not survive either: a partial
	// quote is the same duplication with fewer characters. A word the rule's
	// own text uses ("git", "clean") is not evidence of duplication, so the
	// fragments are chosen from the command's distinctive parts only.
	for (const fragment of ['Set-Content', 'tmp-e2e', 'junk', 'x.txt', 'clean -fdx']) {
		assert.ok(!display.en.includes(fragment), `the English headline leaks "${fragment}"`)
		assert.ok(!display.zh.includes(fragment), `the Chinese headline leaks "${fragment}"`)
	}
})

test('audit path expansion honors DSH_HOME', () => {
	const home = (configured, env = { DSH_HOME: 'C:/dsh-home' }) => resolveDshHome(configured, env)
	const expected = `${sep}dsh-home${sep}rule-guard-audit.jsonl`
	assert.match(expandPath('', home), new RegExp(`^C:${expected.replace(/\\/g, '\\\\')}$`))
	assert.equal(expandPath('$DSH_HOME/log.jsonl', home).replace(/\\/g, '/'), 'C:/dsh-home/log.jsonl')
	assert.equal(expandPath('${DSH_HOME}/log.jsonl', home).replace(/\\/g, '/'), 'C:/dsh-home/log.jsonl')
	assert.equal(expandPath('C:/tmp/log.jsonl', home).replace(/\\/g, '/'), 'C:/tmp/log.jsonl')
	// A blank override never resolves the home to the working directory.
	const blank = (configured, env = { DSH_HOME: '  ' }) => resolveDshHome(configured, env)
	assert.match(expandPath('', blank), /[\\/]\.dsh[\\/]rule-guard-audit\.jsonl$/)
})
