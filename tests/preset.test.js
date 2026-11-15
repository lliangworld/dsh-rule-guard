import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GUARDED_PRESET, GUARDED_PRESET_SPEC, findPresetEntry, installPreset, removePreset } from '../lib/preset.js'

/**
 * Owning the guarded-full preset for the plugin's lifetime.
 *
 * A preset cannot be registered at runtime — `permissionPresets` reads its table
 * from configuration — so this plugin writes it the way the Plugins page writes
 * any other setting. The fake editor below records every `edit` call and applies
 * the change to an in-memory table, which is enough to assert the two properties
 * that matter: the write touches nothing but `presets`, and the removal never
 * deletes a preset the user has touched.
 */

/** The row the fake editor exposes. */
const ENTRY = { options: { id: 'permission', name: '@deepseek-ai/dsh-permission-presets' } }

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
 * @returns {{ ctx: object, config: Record<string, unknown>, calls: object[] }} the context and the recorded edits.
 */
function fakeEditor(presets, options = {}) {
	const calls = []
	const config = { presets: { ...presets } }
	const editor = {
		entries: () => (options.noRow ? [] : [ENTRY]),
		configuration: () => (options.noRow ? [] : [{ entry: ENTRY, inherited: {}, override: config }]),
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
	return { ctx: { configEditor: editor, logger: { warn: () => {} } }, config, calls }
}

test('installing adds the preset and keeps every other key', async () => {
	const { ctx, config, calls } = fakeEditor({
		'read-only': { sandbox: 'read-only', approval: 'ask' },
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
		'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
	})
	await installPreset(ctx)
	assert.equal(calls.length, 1, 'install should write exactly once')
	assert.deepEqual(config.presets[GUARDED_PRESET], GUARDED_PRESET_SPEC)
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

test('removing deletes only the preset this plugin wrote', async () => {
	const { ctx, config, calls } = fakeEditor({
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
		[GUARDED_PRESET]: GUARDED_PRESET_SPEC,
	})
	await removePreset(ctx)
	assert.equal(calls.length, 1)
	assert.equal(config.presets[GUARDED_PRESET], undefined)
	assert.ok(config.presets['workspace-write'] !== undefined)
})

test('removing leaves a preset the user edited alone', async () => {
	// A relabelled preset is the user's. Deleting it would take their work with
	// it, and re-adding ours on the next enable would look like it came back.
	const edited = { ...GUARDED_PRESET_SPEC, name: 'My own label' }
	const { ctx, config, calls } = fakeEditor({
		[GUARDED_PRESET]: edited,
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
	})
	await removePreset(ctx)
	assert.equal(calls.length, 0, 'a user-edited preset must not be touched')
	assert.deepEqual(config.presets[GUARDED_PRESET], edited)
})

test('removing moves the default off the preset being removed', async () => {
	// The permission service throws when its defaultPreset is not a key of the
	// table, so removing the default itself would fail the whole row.
	const { ctx, config } = fakeEditor({
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
		[GUARDED_PRESET]: GUARDED_PRESET_SPEC,
	})
	config.defaultPreset = GUARDED_PRESET
	await removePreset(ctx)
	assert.equal(config.defaultPreset, 'workspace-write', 'the default was left pointing at a removed preset')
	assert.equal(config.presets[GUARDED_PRESET], undefined)
})

test('removing without a workspace-write to fall back to drops the default', async () => {
	const { ctx, config } = fakeEditor({ [GUARDED_PRESET]: GUARDED_PRESET_SPEC })
	config.defaultPreset = GUARDED_PRESET
	await removePreset(ctx)
	assert.equal('defaultPreset' in config, false, 'the default should be dropped, not left dangling')
})

test('a missing permission row skips instead of writing', async () => {
	// Found through `configuration()`, not `entries()`: the live entry list is
	// filtered to rows whose parent fiber is the `include` root, which the
	// permission row does not satisfy in this profile — so it is absent from
	// `entries()` while `configuration()` still reports it.
	const { ctx, calls } = fakeEditor({}, { noRow: true })
	assert.equal(await installPreset(ctx), 'skipped')
	assert.equal(await removePreset(ctx), 'skipped')
	assert.equal(calls.length, 0)
})

test('a missing config editor skips instead of writing', async () => {
	// Headless and minimal profiles carry no config editor; the plugin must not
	// take that as a reason to fail loading.
	const ctx = { logger: { warn: () => {} } }
	assert.equal(await installPreset(ctx), 'skipped')
	assert.equal(await removePreset(ctx), 'skipped')
})

test('a failing write surfaces as a rejection, not a load failure', async () => {
	// The table has to hold our preset for the removal to reach the write at
	// all; otherwise it short-circuits and there is nothing to reject with.
	const install = fakeEditor({ 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }, { throws: true })
	await assert.rejects(() => installPreset(install.ctx), /edit failed/)

	const remove = fakeEditor({
		'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
		[GUARDED_PRESET]: GUARDED_PRESET_SPEC,
	}, { throws: true })
	await assert.rejects(() => removePreset(remove.ctx), /edit failed/)
})

test('a removal the loader refuses surfaces as a rejection', async () => {
	// The unload transaction never closes, so the removal usually cannot land.
	// It has to reject rather than pretend it worked, so the caller can log it
	// and the preset is left in the safe state.
	const { ctx } = fakeEditor(
		{
			'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
			[GUARDED_PRESET]: GUARDED_PRESET_SPEC,
		},
		{ throws: true },
	)
	await assert.rejects(() => removePreset(ctx), /edit failed/)
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

test('the spec is the one the guard gates on', () => {
	// `guardActive` activates on danger-full-access plus ask, which is what this
	// preset sets. If the two ever drift, the preset stops arming the guard.
	assert.equal(GUARDED_PRESET_SPEC.sandbox, 'danger-full-access')
	assert.equal(GUARDED_PRESET_SPEC.approval, 'ask')
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
