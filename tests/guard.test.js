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
			// Run the generator to obtain the disposer, as Cordis would. The
			// preset effect's first yield is a no-op and its second is the
			// cleanup, so running to the second yield also exercises that path.
			const iterator = generator.call({})
			iterator.next()
			return () => iterator.return?.(new Error('disposed'))
		},
		on(event, listener) {
			listeners.push({ event, listener })
			return () => {}
		},
		logger: { warn: () => {} },
		// No preset to manage: `findPresetEntry` returns undefined and every
		// path degrades to a logged skip.
		configEditor: { entries: () => [], configuration: () => [] },
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
		global: ref(false),
		managePreset: ref(false),
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
		disabledRules: ref([]),
		...overrides,
	}
}

/** The permission service's two effective knobs, as `guardActive` reads them. */
const KNOBS = [
	{ sandbox: 'read-only', approval: 'ask' },
	{ sandbox: 'workspace-write', approval: 'ask' },
	{ sandbox: 'workspace-write', approval: 'never' },
	{ sandbox: 'danger-full-access', approval: 'never' },
	{ sandbox: 'danger-full-access', approval: 'ask' },
	{ sandbox: 'read-only', approval: 'never' },
]

/**
 * A context whose knobs read the guarded-full preset's effective values.
 *
 * Both knobs are supplied through the path `guardActive` uses: the session's
 * own override, else the service default. Every test that exercises the engine
 * itself — rules, patterns, dialects, audit — needs the guard to be active;
 * without the knobs the listener would hand the call straight to `next`.
 */
function guardedContext() {
	const context = fakeContext()
	Object.assign(context, {
		approval: { overrideOf: () => undefined, config: { policy: 'ask' } },
		sandboxPolicy: { overrideOf: () => 'danger-full-access', defaultMode: 'workspace-write' },
	})
	return context
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

test('the guard is inert unless the effective permission asks', async () => {
	// Every preset but the guarded one must behave exactly as before, so the
	// listener must hand the call on before any analysis runs.
	for (const knobs of KNOBS) {
		const context = fakeContext()
		Object.assign(context, {
			approval: { overrideOf: () => undefined, config: { policy: knobs.approval } },
			sandboxPolicy: { overrideOf: () => knobs.sandbox, defaultMode: 'workspace-write' },
		})
		apply(context, config())
		const { spy, next } = nextSpy()
		const decision = await listenerOf(context)(
			fakeExec({ arguments: { command: 'git clean -fdx' } }),
			next,
		)
		const guarded = knobs.sandbox === 'danger-full-access' && knobs.approval === 'ask'
		if (guarded) {
			assert.equal(decision.kind, 'ask', `guarded knobs must ask: ${JSON.stringify(knobs)}`)
			assert.equal(spy.called, false)
		} else {
			assert.deepEqual(decision, { kind: 'allow' }, `knobs must pass through: ${JSON.stringify(knobs)}`)
			assert.equal(spy.called, true)
		}
	}
})

test('a missing permission service leaves the guard inert', async () => {
	// A knob that cannot be read at all fails open, the same stance
	// `onUnsupported` takes.
	const context = fakeContext()
	apply(context, config())
	const { spy, next } = nextSpy()
	const decision = await listenerOf(context)(
		fakeExec({ arguments: { command: 'git clean -fdx' } }),
		next,
	)
	assert.deepEqual(decision, { kind: 'allow' })
	assert.equal(spy.called, true)
})

test('the global switch guards every session', async () => {
	// With `global` on, the knob pair no longer gates: even the stock
	// `workspace-write` preset, which asks, and a `never` preset, which would
	// reject the ask, are guarded.
	for (const knobs of KNOBS) {
		const context = fakeContext()
		Object.assign(context, {
			approval: { overrideOf: () => undefined, config: { policy: knobs.approval } },
			sandboxPolicy: { overrideOf: () => knobs.sandbox, defaultMode: 'workspace-write' },
		})
		apply(context, config({ global: ref(true) }))
		const { spy, next } = nextSpy()
		const decision = await listenerOf(context)(
			fakeExec({ arguments: { command: 'git clean -fdx' } }),
			next,
		)
		assert.equal(decision.kind, 'ask', `global must guard every session: ${JSON.stringify(knobs)}`)
		assert.equal(spy.called, false)
	}
})

test('the guard does not evaluate allow or deny patterns while inert', async () => {
	// A deny pattern is the sharpest thing the engine has; it must stay out of
	// the path entirely when the guard does not apply.
	const context = fakeContext()
	apply(context, config({ denyPatterns: ref(['^git status$']) }))
	const { spy, next } = nextSpy()
	const decision = await listenerOf(context)(
		fakeExec({ arguments: { command: 'git status' } }),
		next,
	)
	assert.deepEqual(decision, { kind: 'allow' })
	assert.equal(spy.called, true)
})

test('an ordinary command falls through without asking', async () => {
	const context = guardedContext()
	apply(context, config())
	const listener = listenerOf(context)
	const { spy, next } = nextSpy()
	const decision = await listener(fakeExec({ arguments: { command: 'git status' } }), next)
	assert.deepEqual(decision, { kind: 'allow' })
	assert.equal(spy.called, true)
})

test('a matched rule asks, with a reason and a bilingual display', async () => {
	const context = guardedContext()
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
	const context = guardedContext()
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
	const strict = guardedContext()
	apply(strict, config({ onUnsupported: ref('ask') }))
	const ask = await listenerOf(strict)(fakeExec({ arguments: { command: '& $script' } }), nextSpy().next)
	assert.equal(ask.kind, 'ask')
	assert.match(ask.reason, /no-static-verdict/)

	// A dynamic argument with no dangerous switch is an ordinary call: the
	// switches are visible, so nothing needs to be hidden from.
	const ordinary = guardedContext()
	apply(ordinary, config())
	const release = await listenerOf(ordinary)(fakeExec({ arguments: { command: '& $script' } }), nextSpy().next)
	assert.equal(release.kind, 'allow')
})

test('a fixed dialect overrides inference', async () => {
	const context = guardedContext()
	apply(context, config({ dialect: ref('powershell') }))
	const listener = listenerOf(context)
	const decision = await listener(
		fakeExec({ name: 'bash', arguments: { command: 'Remove-Item -Recurse ./x' } }),
		nextSpy().next,
	)
	assert.equal(decision.kind, 'ask')
	assert.match(decision.reason, /pwsh-remove-recursive/)
})

test('decisions are written to the audit log when enabled', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'rule-guard-audit-'))
	const auditPath = path.join(directory, 'audit.jsonl')
	try {
		const context = guardedContext()
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

test('a disabled rule is recorded as released, not as an ask', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'rule-guard-audit-'))
	const auditPath = path.join(directory, 'audit.jsonl')
	try {
		const context = guardedContext()
		apply(
			context,
			config({ audit: ref(true), auditPath: ref(auditPath), disabledRules: ref(['git-clean-force']) }),
		)
		const { spy, next } = nextSpy()
		const decision = await listenerOf(context)(
			fakeExec({ arguments: { command: 'git clean -fdx' } }),
			next,
		)
		assert.deepEqual(decision, { kind: 'allow' })
		assert.equal(spy.called, true)
		const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
		const record = JSON.parse(lines[lines.length - 1])
		assert.equal(record.verdict, 'rule-disabled')
		assert.equal(record.ruleId, 'git-clean-force')
		assert.match(record.reason, /is disabled by configuration/)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('an unknown rule id in the disabled list disables nothing', async () => {
	// The list is user-editable, so a stale or misspelled id must not silence
	// the engine: every other rule keeps asking.
	const context = guardedContext()
	apply(context, config({ disabledRules: ref(['no-such-rule']) }))
	const { spy, next } = nextSpy()
	const decision = await listenerOf(context)(
		fakeExec({ arguments: { command: 'git clean -fdx' } }),
		next,
	)
	assert.equal(decision.kind, 'ask')
	assert.equal(spy.called, false)
})

test('an execution without an agent falls through', async () => {
	// Without an agent there is no session to gate on and no UI to route an ask
	// through; the host degrades it to a denial, so the guard steps aside.
	const context = guardedContext()
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
		const context = guardedContext()
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

test('a non-string audit path falls back instead of throwing', () => {
	// The schema says `auditPath` is a string, but a hand-edited profile layer
	// can put something else there. `apply` builds its `AuditLog` at load
	// time, so a throw here would take the whole plugin down, not one field.
	const home = (configured, env = { DSH_HOME: 'C:/dsh-home' }) => resolveDshHome(configured, env)
	for (const bad of [42, true, {}, ['C:/log.jsonl'], null, undefined]) {
		assert.doesNotThrow(() => expandPath(bad, home), `expandPath threw for ${JSON.stringify(bad)}`)
		assert.match(
			expandPath(bad, home).replace(/\\/g, '/'),
			/^C:\/dsh-home\/rule-guard-audit\.jsonl$/,
			`a non-string audit path did not fall back: ${JSON.stringify(bad)}`,
		)
	}
})
