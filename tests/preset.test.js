import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
	GUARDED_PRESET,
	GUARDED_PRESET_KNOBS,
	PRESET_LABELS,
	findPresetEntry,
	installChange,
	installPreset,
	installPresetWhenLoaded,
	presentationFor,
	relabelChange,
	relabelPreset,
	removalChange,
	removePresetWhenUnloaded,
} from '../lib/preset.js'

/**
 * Let a fire-and-forget write settle. Two macrotasks, because the write goes
 * through `executing.exit` into a queued operation before the editor runs.
 *
 * @returns {Promise<void>}
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

/**
 * Owning the guarded-full preset for the plugin's lifetime.
 *
 * A preset cannot be registered at runtime — `permissionPresets` reads its table
 * from configuration — so this plugin writes it the way the Plugins page writes
 * any other setting. The fake editor below records every `edit` call and applies
 * the change to an in-memory table, which is enough to assert the two properties
 * that matter: the write touches nothing but `presets`, and the slot's key is the
 * identity the plugin manages it by.
 */

/** The row the fake editor exposes. */
const ENTRY = { options: { id: 'permission', name: '@deepseek-ai/dsh-permission-presets' } }

/** A `locale` row, so `presentationFor` has something to read. */
const LOCALE_ENTRY = { options: { id: 'locale', name: '@deepseek-ai/dsh-client-locale' } }

/** What this plugin writes into the slot: the knobs plus a language's labels. */
const guardedSpec = (labels = PRESET_LABELS.en) => ({ ...GUARDED_PRESET_KNOBS, ...labels })
/**
 * A fake `configEditor` that keeps one preset table in memory.
 *
 * `configuration()` returns the live config object, so a test can set
 * `config.defaultPreset` directly and see the edit's effect on it.
 *
 * @param {Record<string, unknown>} presets - the table the profile starts with.
 * @param {object} [options] - behaviour overrides.
 * @param {boolean} [options.throws] - make `edit` reject.
 * @param {boolean} [options.noRow] - expose no permission row at all.
 * @param {boolean} [options.queued] - expose `hmr.executing.exit` so writes queue.
 * @param {string} [options.locale] - the `preference` the locale row carries.
 * @returns {{ ctx: object, config: Record<string, unknown>, calls: object[], emitted: string[] }} the context, the table, the recorded edits and the announced events.
 */
function fakeEditor(presets, options = {}) {
	const calls = []
	const emitted = []
	const config = { presets: { ...presets } }
	// Defaulted to English so a test's expectations do not depend on the host's
	// language: the language tests pass their own, and the rest stay neutral.
	const localeConfig = options.locale === undefined ? { preference: 'en' } : { preference: options.locale }
	const editor = {
		entries: () => (options.noRow ? [] : [ENTRY, LOCALE_ENTRY]),
		configuration: () =>
			options.noRow
				? []
				: [
						{ entry: ENTRY, inherited: {}, override: config },
						{ entry: LOCALE_ENTRY, inherited: {}, override: localeConfig },
					],
		async edit(entry, change) {
			calls.push(entry)
			if (options.throws) throw new Error('edit failed')
			// `configEditor.edit` replaces the whole config, so the fake has to
			// model that: whatever the change returns is what the table becomes.
			const next = change(structuredClone(config), {})
			for (const key of Object.keys(config)) delete config[key]
			Object.assign(config, next)
		},
	}
	// A fake HMR whose `executing.exit` queues the write on a microtask, the way
	// the real one queues on the loader's operation queue. Absent unless asked
	// for, so a test can also model a profile with no HMR service.
	const ctx = {
		configEditor: editor,
		logger: { warn: () => {} },
		emit: (name) => emitted.push(name),
		...(options.queued === true
			? {
					get: (name) =>
						name === 'hmr'
							? {
									executing: {
										exit: (fn) => Promise.resolve().then(fn),
									},
								}
							: undefined,
				}
			: {}),
	}
	return { ctx, config, calls, emitted }
}

test('installing adds the preset and keeps every other key', async () => {
	const { ctx, config, calls } = fakeEditor({
		'read-only': { sandbox: 'read-only', approval: 'ask' },
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
		'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
	})
	await installPreset(ctx)
	assert.equal(calls.length, 1, 'install should write exactly once')
	assert.deepEqual(config.presets[GUARDED_PRESET], guardedSpec())
	// The sibling presets survive: a patch's config is replaced wholesale, so a
	// write that dropped them would take the permission row's own defaults away.
	assert.equal(Object.keys(config.presets).length, 4)
	for (const name of ['read-only', 'workspace-write', 'danger-full-access']) {
		assert.ok(config.presets[name] !== undefined, `${name} was dropped by the install`)
	}
})

test('installing does not touch the default preset', async () => {
	const { ctx, config } = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } })
	// The profile's defaultPreset sits beside the table, and a write that
	// dropped it would make the permission row fall back to an inferred default.
	config.defaultPreset = 'workspace-write'
	await installPreset(ctx)
	assert.equal(config.defaultPreset, 'workspace-write')
	assert.equal(config.presets[GUARDED_PRESET] !== undefined, true)
})

test('installing twice does not write twice', async () => {
	const { ctx, calls } = fakeEditor({})
	await installPreset(ctx)
	await installPreset(ctx)
	assert.equal(calls.length, 1, 'the second install should be a no-op')
})

test('the install is queued, not retried inside the transaction', async () => {
	// Retrying inside the transaction that enables this plugin can never
	// succeed: the guard reads the caller's async context, so every retry runs
	// inside the very transaction waiting for the effect to return. That was the
	// bug — the preset only ever appeared once a command happened to run.
	const { ctx, config, calls } = fakeEditor({}, { queued: true })
	assert.equal(installPresetWhenLoaded(ctx), 'queued')
	// Nothing has happened yet: the write is on the queue, not in flight.
	assert.equal(calls.length, 0)
	await tick()
	assert.equal(calls.length, 1, 'the write should run once the queue drains')
	assert.ok(config.presets[GUARDED_PRESET] !== undefined)
})

test('the install lands without any tool execution', async () => {
	// The whole point of queueing: enabling the plugin is enough, and no
	// pre-execute listener has to fire first. Asserted by construction — this
	// test never touches a listener.
	const { ctx, config } = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }, { queued: true })
	installPresetWhenLoaded(ctx)
	await tick()
	assert.deepEqual(config.presets[GUARDED_PRESET], guardedSpec())
	assert.ok(config.presets['workspace-write'] !== undefined, 'the sibling preset must survive')
})

test('the install falls back to retrying without an HMR service', async () => {
	// A profile with no HMR service must still get a preset, even if it takes
	// the slower path. This is also the guard against listing `hmr` in `inject`,
	// which would stop the plugin loading there at all.
	const { ctx, config } = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } })
	installPresetWhenLoaded(ctx)
	await tick()
	assert.ok(config.presets[GUARDED_PRESET] !== undefined)
})

test('an install and a removal queue in order', async () => {
	// Enable then disable quickly. The queue is FIFO, so the removal runs after
	// the install has actually landed — which is what the real loader does,
	// because the enable transaction completes before the disable is requested.
	// A retry-based install raced instead: both writes ran inside their own
	// transactions, and the removal's check could see a table the install had
	// not yet written.
	const { ctx, config } = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }, { queued: true })
	installPresetWhenLoaded(ctx)
	// The queued install lands before the removal is even requested.
	await tick()
	removePresetWhenUnloaded(ctx)
	await tick()
	assert.equal(config.presets[GUARDED_PRESET], undefined, 'the removal should win the race')
	assert.ok(config.presets['workspace-write'] !== undefined, 'the sibling preset must survive')
})

test('a removal and an install queue in order', async () => {
	// The mirror: disable then enable quickly leaves the preset in place, because
	// the removal has already landed by the time the install is requested.
	const { ctx, config } = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }, { queued: true })
	installPresetWhenLoaded(ctx)
	await tick()
	removePresetWhenUnloaded(ctx)
	await tick()
	installPresetWhenLoaded(ctx)
	await tick()
	assert.ok(config.presets[GUARDED_PRESET] !== undefined, 'the install should win the race')
})

test('a failed install is reported, not thrown', async () => {
	const { ctx } = fakeEditor({}, { throws: true, queued: true })
	const warnings = []
	assert.equal(installPresetWhenLoaded(ctx, (m) => warnings.push(m)), 'queued')
	await tick()
	assert.equal(warnings.length, 1, 'a failed write should reach the warn callback')
	assert.match(warnings[0], /could not add the guarded-full preset/)
})

test('removing deletes only the preset this plugin wrote', async () => {
	const { ctx, config, calls } = fakeEditor({
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
		[GUARDED_PRESET]: guardedSpec(),
	})
	removePresetWhenUnloaded(ctx)
	await tick()
	assert.equal(calls.length, 1)
	assert.equal(config.presets[GUARDED_PRESET], undefined)
	assert.ok(config.presets['workspace-write'] !== undefined)
})

test('removing removes the slot whatever is in it', async () => {
	// The key is the identity, so an occupied slot is this plugin's to remove —
	// including one whose contents it would never have written. A user who wants
	// their own preset adds another key, which this plugin never touches.
	const edited = { ...guardedSpec(), name: 'My own label' }
	const { ctx, config, calls } = fakeEditor({
		[GUARDED_PRESET]: edited,
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
	})
	removePresetWhenUnloaded(ctx)
	await tick()
	assert.equal(calls.length, 1)
	assert.equal(config.presets[GUARDED_PRESET], undefined)
	assert.ok(config.presets['workspace-write'] !== undefined, 'a sibling preset must survive')
})

test('removing leaves a slot the user renamed alone', async () => {
	// Renaming the key is the one way to take the slot out of this plugin's hands,
	// because the key is the identity and the plugin no longer sees it.
	const renamed = { 'my-preset': guardedSpec(), 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }
	const { ctx, config, calls } = fakeEditor(renamed)
	removePresetWhenUnloaded(ctx)
	await tick()
	assert.equal(calls.length, 0, 'a slot under another key must not be touched')
	assert.deepEqual(config.presets['my-preset'], guardedSpec())
})

test('removing moves the default off the preset being removed', async () => {
	// The permission service throws when its defaultPreset is not a key of the
	// table, so removing the default itself would fail the whole row.
	const { ctx, config } = fakeEditor({
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
		[GUARDED_PRESET]: guardedSpec(),
	})
	config.defaultPreset = GUARDED_PRESET
	removePresetWhenUnloaded(ctx)
	await tick()
	assert.equal(config.defaultPreset, 'workspace-write', 'the default was left pointing at a removed preset')
	assert.equal(config.presets[GUARDED_PRESET], undefined)
})

test('removing without a workspace-write to fall back to drops the default', async () => {
	const { ctx, config } = fakeEditor({ [GUARDED_PRESET]: guardedSpec() })
	config.defaultPreset = GUARDED_PRESET
	removePresetWhenUnloaded(ctx)
	await tick()
	assert.equal('defaultPreset' in config, false, 'the default should be dropped, not left dangling')
})

test('removalChange is pure, so the rules are assertable without a loader', () => {
	// The rules that matter: an occupied slot is always removed, and the default
	// is never left dangling. Both are decisions about a config object, not
	// about the host.
	const base = { presets: { [GUARDED_PRESET]: guardedSpec() }, defaultPreset: 'workspace-write' }
	assert.equal(removalChange(base).presets[GUARDED_PRESET], undefined)
	assert.equal(removalChange(base).defaultPreset, 'workspace-write')

	// Contents are irrelevant to the decision: the key alone decides.
	const edited = { presets: { [GUARDED_PRESET]: { ...guardedSpec(), name: 'Mine' } } }
	assert.equal(removalChange(edited).presets[GUARDED_PRESET], undefined)

	// No slot at all is a no-op, not a crash.
	assert.equal(removalChange({}), undefined)
	assert.equal(removalChange({ presets: 'nonsense' }), undefined)
})

test('removing without the slot writes nothing', async () => {
	// The toggle path calls this whenever `managePreset` goes off, including
	// when the preset is already gone — a toggle flipped twice, or a profile
	// where the user removed it by hand. A no-op must not write the row and
	// must not announce a catalog change nobody needs to see.
	const { ctx, calls, emitted } = fakeEditor({
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
	})
	removePresetWhenUnloaded(ctx)
	await tick()
	assert.equal(calls.length, 0, 'an empty slot must not be written')
	assert.deepEqual(emitted, [], 'an empty slot must not be announced')
})

test('the unload removal is fire-and-forget, so it cannot block the fiber', async () => {
	// Awaiting the queued write waits for the very transaction the teardown is
	// blocking, which deadlocked the host. The call must return synchronously.
	const { ctx } = fakeEditor({
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
		[GUARDED_PRESET]: guardedSpec(),
	})
	const result = removePresetWhenUnloaded(ctx)
	assert.equal(result, undefined, 'the removal must not return a promise to await')
})

test('a failing removal is reported, not thrown', async () => {
	const { ctx } = fakeEditor(
		{ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }, [GUARDED_PRESET]: guardedSpec() },
		{ throws: true },
	)
	const warnings = []
	removePresetWhenUnloaded(ctx, (message) => warnings.push(message))
	await tick()
	assert.equal(warnings.length, 1, 'a failed write should reach the warn callback')
	assert.match(warnings[0], /could not remove the guarded-full preset/)
})

test('a missing permission row skips instead of writing', async () => {
	// Found through `configuration()`, not `entries()`: the live entry list is
	// filtered to rows whose parent fiber is the `include` root, which the
	// permission row does not satisfy in this profile — so it is absent from
	// `entries()` while `configuration()` still reports it.
	const { ctx, calls } = fakeEditor({}, { noRow: true })
	assert.equal(await installPreset(ctx), 'skipped')
	removePresetWhenUnloaded(ctx)
	await tick()
	assert.equal(calls.length, 0)
})

test('a missing config editor skips instead of writing', async () => {
	// Headless and minimal profiles carry no config editor; the plugin must not
	// take that as a reason to fail loading.
	const ctx = { logger: { warn: () => {} } }
	assert.equal(await installPreset(ctx), 'skipped')
	removePresetWhenUnloaded(ctx)
	await tick()
})

test('a failing write surfaces as a rejection, not a load failure', async () => {
	// The table has to hold our preset for the removal to reach the write at
	// all; otherwise it short-circuits and there is nothing to reject with.
	const install = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }, { throws: true })
	await assert.rejects(() => installPreset(install.ctx), /edit failed/)
})

test('the entry is found by name and by id', () => {
	const byName = fakeEditor({})
	assert.equal(findPresetEntry(byName.ctx), ENTRY)

	// The id alone is enough when the package has been renamed upstream, which
	// is the fallback that keeps the preset managed across a rename.
	const byId = fakeEditor({})
	byId.ctx.configEditor.configuration = () => [
		{ entry: { options: { id: 'permission', name: 'some-other-package' } }, inherited: {}, override: { presets: {} } },
	]
	assert.equal(findPresetEntry(byId.ctx)?.options?.id, 'permission')
})

test('a row that configures no presets is not the preset row', () => {
	// The permission package may be present without configuring a table; writing
	// into it would be writing into something that is not a preset table.
	const { ctx } = fakeEditor({})
	ctx.configEditor.configuration = () => [{ entry: ENTRY, inherited: {}, override: {} }]
	assert.equal(findPresetEntry(ctx), undefined)
})

test('a preset table that is not an object is not a preset table', () => {
	const { ctx } = fakeEditor({})
	ctx.configEditor.configuration = () => [{ entry: ENTRY, inherited: {}, override: { presets: 'nonsense' } }]
	assert.equal(findPresetEntry(ctx), undefined)
})

test('the knobs are the ones the guard gates on', () => {
	// `guardActive` activates on danger-full-access plus ask, which is what this
	// preset sets. If the two ever drift, the preset stops arming the guard.
	assert.deepEqual(GUARDED_PRESET_KNOBS, { sandbox: 'danger-full-access', approval: 'ask' })
})

test('a write blocked by the loader is retried, then lands', async () => {
	// The live loader refuses to nest an HMR transaction, and the one enabling
	// this plugin outlives a macrotask — so a write attempted during the effect's
	// setup fails, and only a later attempt lands. The retry has to survive the
	// nesting error and give up on anything else.
	let calls = 0
	const editor = {
		entries: () => [],
		configuration: () => [{ entry: ENTRY, inherited: {}, override: config }],
		async edit(entry, change) {
			calls++
			if (calls < 3) throw new Error('HMR transactions cannot be nested')
			const next = change(structuredClone(config), {})
			for (const key of Object.keys(config)) delete config[key]
			Object.assign(config, next)
		},
	}
	const ctx = { configEditor: editor, logger: { warn: () => {} } }
	const config = { presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } } }
	assert.equal(await installPreset(ctx), 'written')
	assert.equal(calls, 3, 'the write should have been retried past the nesting error')
	assert.ok(config.presets[GUARDED_PRESET] !== undefined)
})

test('a write rejected for any other reason is not retried', async () => {
	// A shadowed row or a failed validation is a real answer; retrying it would
	// only delay telling the user.
	let calls = 0
	const editor = {
		entries: () => [],
		configuration: () => [{ entry: ENTRY, inherited: {}, override: { presets: {} } }],
		async edit() {
			calls++
			throw new Error('Configuration for "permission" is overridden by a home patch')
		},
	}
	await assert.rejects(() => installPreset({ configEditor: editor, logger: { warn: () => {} } }), /overridden/)
	assert.equal(calls, 1)
})

test('the presentation follows the locale row when it is set', () => {
	// The setting the user picked in Settings is the most authoritative source,
	// and a region suffix does not change the language it names.
	assert.equal(presentationFor(fakeEditor({}, { locale: 'zh' }).ctx), 'zh')
	assert.equal(presentationFor(fakeEditor({}, { locale: 'zh-CN' }).ctx), 'zh')
	assert.equal(presentationFor(fakeEditor({}, { locale: 'zh-TW' }).ctx), 'zh')
	assert.equal(presentationFor(fakeEditor({}, { locale: 'en' }).ctx), 'en')
	assert.equal(presentationFor(fakeEditor({}, { locale: 'en-US' }).ctx), 'en')
})

test('the presentation falls back to the host language when unset', () => {
	// An untouched setting leaves the locale row empty, which is the normal case
	// on a fresh profile: the host's own language answers instead.
	const hostLanguage = Intl.DateTimeFormat().resolvedOptions().locale
	const expected = hostLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en'
	const { ctx } = fakeEditor({}, { locale: undefined })
	// Strip the preference, because the fake defaults it to English.
	ctx.configEditor.configuration = () => [
		{ entry: ENTRY, inherited: {}, override: { presets: {} } },
		{ entry: LOCALE_ENTRY, inherited: {}, override: {} },
	]
	assert.equal(presentationFor(ctx), expected)
})

test('the presentation follows the host language without a locale row', () => {
	// No locale row at all, so the host's own language answers — English only
	// when the platform says nothing Chinese.
	const ctx = { configEditor: { configuration: () => [] } }
	const expected = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
	assert.equal(presentationFor(ctx), expected)
})

test('the presentation is English when nothing says anything', () => {
	// The host's own ICU locale is the last source, and a reader that yields
	// nothing leaves English — the conservative default.
	const ctx = {
		configEditor: { configuration: () => [{ entry: LOCALE_ENTRY, inherited: {}, override: {} }] },
	}
	const real = Intl.DateTimeFormat
	globalThis.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ locale: 'en-US' }) }) }
	try {
		assert.equal(presentationFor(ctx), 'en')
	} finally {
		globalThis.Intl = { DateTimeFormat: real }
	}
})

test('the preset is written in the language the host is running in', async () => {
	const { ctx, config } = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }, { locale: 'zh' })
	await installPreset(ctx)
	assert.equal(config.presets[GUARDED_PRESET].name, PRESET_LABELS.zh.name)
	assert.equal(config.presets[GUARDED_PRESET].description, PRESET_LABELS.zh.description)
	// The knobs come along with the labels, so the preset still arms the guard.
	assert.equal(config.presets[GUARDED_PRESET].sandbox, 'danger-full-access')
	assert.equal(config.presets[GUARDED_PRESET].approval, 'ask')
})

test('the removal works after a language switch', async () => {
	// The reason the identity is the key, not the values: a slot written in
	// Chinese must still be removable, or switching languages would orphan it.
	const { ctx, config, calls } = fakeEditor(
		{ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }, [GUARDED_PRESET]: guardedSpec(PRESET_LABELS.zh) },
		{ locale: 'zh' },
	)
	// The language then changes to English, which is what relabelPreset writes.
	removePresetWhenUnloaded(ctx)
	await tick()
	assert.equal(calls.length, 1)
	assert.equal(config.presets[GUARDED_PRESET], undefined)
})

test('relabeling changes only the presentation', async () => {
	const { ctx, config, calls } = fakeEditor(
		{
			'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
			[GUARDED_PRESET]: guardedSpec(PRESET_LABELS.en),
		},
		{ locale: 'zh' },
	)
	config.defaultPreset = 'workspace-write'
	assert.equal(relabelPreset(ctx), 'queued')
	await tick()
	assert.equal(config.presets[GUARDED_PRESET].name, PRESET_LABELS.zh.name)
	assert.equal(config.presets[GUARDED_PRESET].description, PRESET_LABELS.zh.description)
	assert.equal(config.presets[GUARDED_PRESET].sandbox, 'danger-full-access')
	// Nothing else in the row moves.
	assert.equal(config.presets['workspace-write'] !== undefined, true)
	assert.equal(config.defaultPreset, 'workspace-write')
	assert.equal(calls.length, 1)
})

test('relabeling twice does not write twice', async () => {
	const { ctx, calls } = fakeEditor({ [GUARDED_PRESET]: guardedSpec(PRESET_LABELS.zh) }, { locale: 'zh' })
	assert.equal(relabelPreset(ctx), 'unchanged')
	await tick()
	assert.equal(calls.length, 0, 'a matching label is a no-op')
})

test('relabeling without the slot is a no-op', async () => {
	const { ctx, calls } = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }, { locale: 'zh' })
	assert.equal(relabelPreset(ctx), 'absent')
	await tick()
	assert.equal(calls.length, 0)
})

test('relabelChange is pure and adopts the current knobs', () => {
	// A preset left behind by an older version adopts the current knobs when it
	// is relabelled, which is how a spec change reaches an existing install.
	const stale = { presets: { [GUARDED_PRESET]: { sandbox: 'workspace-write', approval: 'never' } } }
	const next = relabelChange(stale, PRESET_LABELS.zh)
	assert.equal(next.presets[GUARDED_PRESET].sandbox, 'danger-full-access')
	assert.equal(next.presets[GUARDED_PRESET].approval, 'ask')
	assert.equal(next.presets[GUARDED_PRESET].name, PRESET_LABELS.zh.name)

	// Already correct: no change.
	const current = { presets: { [GUARDED_PRESET]: guardedSpec(PRESET_LABELS.zh) } }
	assert.equal(relabelChange(current, PRESET_LABELS.zh), undefined)

	// No slot: no change.
	assert.equal(relabelChange({}, PRESET_LABELS.zh), undefined)
})

test('installChange restates every sibling key', () => {
	// A patch's config is replaced wholesale, so a write that dropped the other
	// presets or the default would take the permission row's defaults with it.
	const current = {
		presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } },
		defaultPreset: 'workspace-write',
	}
	const next = installChange(current, PRESET_LABELS.en)
	assert.deepEqual(next.defaultPreset, 'workspace-write')
	assert.ok(next.presets['workspace-write'] !== undefined, 'a sibling preset must survive')
	assert.deepEqual(next.presets[GUARDED_PRESET], guardedSpec(PRESET_LABELS.en))
})

test('adding the preset announces the catalog once it has changed', async () => {
	// The permission client caches the catalog and listens for this one event,
	// so without it the settings row and the composer seat would not show the
	// preset until a restart — which is exactly what was reported.
	const { ctx, emitted } = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } })
	await installPreset(ctx)
	assert.deepEqual(emitted, ['permission-presets/catalog-changed'])
})

test('the announcement rides the queued install, after the write', async () => {
	const { ctx, config, calls, emitted } = fakeEditor({}, { queued: true })
	assert.equal(installPresetWhenLoaded(ctx), 'queued')
	assert.equal(calls.length, 0, 'the write is queued, not run yet')
	await tick()
	assert.equal(calls.length, 1)
	assert.deepEqual(emitted, ['permission-presets/catalog-changed'])
	assert.ok(config.presets[GUARDED_PRESET] !== undefined)
})

test('removing the preset announces the catalog', async () => {
	// The mirror of the install: closing the plugin drops the preset and tells
	// the two surfaces about it in the same round.
	const { ctx, emitted } = fakeEditor({ [GUARDED_PRESET]: guardedSpec() })
	removePresetWhenUnloaded(ctx)
	assert.deepEqual(emitted, [], 'the write is queued, so the announcement follows it')
	await tick()
	assert.deepEqual(emitted, ['permission-presets/catalog-changed'])
})

test('relabeling announces the catalog once', async () => {
	const { ctx, emitted } = fakeEditor({ [GUARDED_PRESET]: guardedSpec(PRESET_LABELS.en) }, { locale: 'zh' })
	assert.equal(relabelPreset(ctx), 'queued')
	await tick()
	assert.deepEqual(emitted, ['permission-presets/catalog-changed'])
})

test('an unchanged language announces nothing', async () => {
	// Re-reading the catalog is not free, and a language that did not move has
	// nothing to re-read.
	const { ctx, emitted } = fakeEditor({ [GUARDED_PRESET]: guardedSpec(PRESET_LABELS.zh) }, { locale: 'zh' })
	assert.equal(relabelPreset(ctx), 'unchanged')
	await tick()
	assert.deepEqual(emitted, [])
})

test('an absent slot announces nothing', async () => {
	const { ctx, emitted } = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } })
	assert.equal(relabelPreset(ctx), 'absent')
	await tick()
	assert.deepEqual(emitted, [])
})

test('a preset already in place announces nothing on install', async () => {
	const { ctx, emitted } = fakeEditor({ [GUARDED_PRESET]: guardedSpec() })
	assert.equal(await installPreset(ctx), 'present')
	assert.deepEqual(emitted, [])
})

test('a failed write announces nothing', async () => {
	// The catalog did not change, so announcing it would send every consumer
	// re-reading a table that is exactly what they already have.
	const editor = {
		entries: () => [ENTRY],
		configuration: () => [{ entry: ENTRY, inherited: {}, override: { presets: {} } }],
		async edit() { throw new Error('edit failed') },
	}
	const emitted = []
	const ctx = { configEditor: editor, logger: { warn: () => {} }, emit: (n) => emitted.push(n) }
	await assert.rejects(() => installPreset(ctx), /edit failed/)
	assert.deepEqual(emitted, [])
})

test('the toggle listens even when the plugin comes up with the switch off', () => {
	// A plugin enabled while `managePreset` is false must still notice the user
	// turning it on later. Guarding the listener's registration on the field's
	// value at activation left that path with nobody listening: the switch then
	// did nothing for the rest of the plugin's life, and only a restart — with
	// the switch already on — made the preset appear.
	const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
	const name = source.indexOf("'rule-guard: managed preset toggle'")
	const start = source.lastIndexOf('ctx.effect(', name)
	assert.ok(start > 0 && start < name, 'the toggle effect is gone')
	const toggle = source.slice(start, name)

	// Everything before the subscription must not be gated on the field.
	const body = toggle.slice(0, toggle.indexOf("ctx.on('app-boot/config-reload'"))
	assert.ok(
		!/managePreset\.get\(\) === false/.test(body),
		'the toggle effect returns before subscribing when the switch is off, ' +
			'so turning it on later is never noticed',
	)
	assert.ok(
		!/yield \(\) => \{\}/.test(body),
		'the toggle effect yields a no-op instead of its listener',
	)
})

test('the unload removal runs even when the plugin came up with the switch off', () => {
	// The switch can be turned on while the plugin stays enabled, which adds
	// the preset. Disabling the plugin then has to take it back out, so the
	// install effect's teardown cannot be conditional on the value it read at
	// activation — by then the preset is there and the user expects it gone.
	const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
	const toggleName = source.indexOf("'rule-guard: managed preset toggle'")
	const toggleStart = source.lastIndexOf('ctx.effect(', toggleName)
	const installStart = source.lastIndexOf('ctx.effect(', toggleStart - 1)
	assert.ok(installStart > 0 && installStart < toggleStart, 'the install effect is gone')
	const install = source.slice(installStart, toggleStart)

	// Coming up with the switch off must install nothing, whichever shape the
	// guard takes.
	assert.ok(
		/if \(config\.managePreset\.get\(\)/.test(install.slice(0, install.indexOf('ensurePreset()'))),
		'the install effect calls ensurePreset without testing the switch',
	)
	// ...and the teardown must be reachable. An early `yield () => {}` followed
	// by `return` is what made it unreachable.
	assert.ok(
		!/yield \(\) => \{\}\s*\n\s*return/.test(install),
		'the install effect returns before its teardown when the switch is off, ' +
			'so a preset added later survives the plugin being disabled',
	)
	assert.ok(
		/yield \(\) => \{[\s\S]*?removePresetWhenUnloaded/.test(install),
		'the install effect never yields the removal',
	)
})
