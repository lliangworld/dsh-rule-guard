/**
 * Owning the `guarded-full` permission preset for this plugin's lifetime.
 *
 * A preset cannot be registered at runtime: `permissionPresets` reads its table
 * straight from `config.presets`, and the only registration hook it offers,
 * `registerAuto`, is hard-wired to the single reserved name `auto` — which the
 * client renders with auto-review's own copy and description, and which this
 * profile already occupies. So the preset is written the same way the Plugins
 * page writes any other setting: through `configEditor.edit`, which persists the
 * profile's own patch and reloads that one row.
 *
 * The write is deliberately narrow. A patch's `config` is replaced wholesale
 * when a layer is applied, so the edit re-states every sibling key it read and
 * changes only `presets`. Dropping `defaultPreset` or the other presets would
 * take the permission row down with them.
 *
 * Two failure shapes drove the design:
 *
 * - **Removing the preset a session or the default points at.** `resolve`
 *    throws for an unknown name, and the service's constructor throws when
 *    `defaultPreset` is not a key of the table. A removal therefore has to move
 *    `defaultPreset` off this preset, or the permission row fails to load.
 *    Session-level state is more forgiving — `derive` falls back to matching the
 *    knobs, and a hand-tuned combination is reported as `custom` — so only the
 *    default is fatal.
 * - **Removing a preset the user edited.** A preset is the user's once they
 *    touch it. The removal only deletes an entry whose spec still equals what
 *    this plugin wrote, so a relabelled or retuned preset survives.
 *
 * @module dsh-rule-guard/preset
 */

/** The preset this plugin owns. */
export const GUARDED_PRESET = 'guarded-full'

/** What this plugin writes into the preset table. */
export const GUARDED_PRESET_SPEC = {
	sandbox: 'danger-full-access',
	approval: 'ask',
	name: 'Guarded full access',
	description: 'Full sandbox access; dangerous commands ask the user.',
}

/** The row whose config holds the preset table. */
const PRESET_ROW_NAME = '@deepseek-ai/dsh-permission-presets'
const PRESET_ROW_ID = 'permission'

/**
 * Whether one value is a plain object.
 *
 * @param {unknown} value - the value to test.
 * @returns {boolean} whether it is a non-null, non-array object.
 */
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one preset entry is exactly what this plugin wrote.
 *
 * Compared key by key rather than by identity, because the value has been
 * through YAML: a round trip may hand back a fresh object each read.
 *
 * @param {unknown} existing - the entry found in the table.
 * @returns {boolean} whether it is this plugin's, untouched.
 */
function isOurs(existing) {
	if (!isRecord(existing)) return false
	for (const [key, value] of Object.entries(GUARDED_PRESET_SPEC)) {
		if (existing[key] !== value) return false
	}
	return true
}

/**
 * The loader entry whose config owns the preset table, or `undefined`.
 *
 * Two independent signals must agree: the row's package name (or, failing that,
 * its id) and the presence of a preset table in its config. Requiring both means
 * an upstream rename skips the row instead of writing a preset into something
 * that is not one.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {object | undefined} the entry, or `undefined` when none matches.
 */
export function findPresetEntry(ctx) {
	const editor = ctx.configEditor
	if (editor === undefined) return undefined
	let entries
	try {
		entries = editor.entries()
	} catch {
		return undefined
	}
	if (!Array.isArray(entries)) return undefined
	const match = entries.find((entry) => {
		const options = entry?.options
		if (!isRecord(options)) return false
		return options.name === PRESET_ROW_NAME || options.id === PRESET_ROW_ID
	})
	if (match === undefined) return undefined
	// The row may exist without configuring presets; only then is it ours to edit.
	return presetTableOf(ctx) !== undefined ? match : undefined
}

/**
 * The preset table as the profile currently has it, or `undefined`.
 *
 * Read from the override layer, which is what the profile's own patch holds.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Record<string, unknown> | undefined} the table, if any.
 */
function presetTableOf(ctx) {
	const editor = ctx.configEditor
	if (editor === undefined) return undefined
	try {
		const rows = editor.configuration()
		if (!Array.isArray(rows)) return undefined
		for (const row of rows) {
			const options = row?.entry?.options
			if (options?.name !== PRESET_ROW_NAME && options?.id !== PRESET_ROW_ID) continue
			return isRecord(row.override?.presets) ? row.override.presets : undefined
		}
	} catch {
		return undefined
	}
	return undefined
}

/**
 * Add this plugin's preset to the table, leaving every other key alone.
 *
 * Idempotent: a table that already has the entry is left untouched, so
 * re-enabling the plugin does not rewrite the profile.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Promise<'written' | 'present' | 'skipped'>} what happened.
 */
export async function installPreset(ctx) {
	const entry = findPresetEntry(ctx)
	if (entry === undefined) return 'skipped'
	const before = presetTableOf(ctx)
	if (before?.[GUARDED_PRESET] !== undefined) return 'present'
	await ctx.configEditor.edit(entry, (current) => {
		const presets = isRecord(current.presets) ? current.presets : {}
		return { ...current, presets: { ...presets, [GUARDED_PRESET]: GUARDED_PRESET_SPEC } }
	})
	const after = presetTableOf(ctx)
	return after?.[GUARDED_PRESET] !== undefined ? 'written' : 'skipped'
}

/**
 * Remove this plugin's preset, if it is still the one this plugin wrote.
 *
 * A preset the user relabelled or retuned is theirs and survives. The default
 * preset is moved off this one first, because the permission service throws
 * when its `defaultPreset` is not a key of the table.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Promise<'removed' | 'not-ours' | 'skipped'>} what happened.
 */
export async function removePreset(ctx) {
	const entry = findPresetEntry(ctx)
	if (entry === undefined) return 'skipped'
	const existing = presetTableOf(ctx)?.[GUARDED_PRESET]
	if (existing === undefined) return 'skipped'
	if (!isOurs(existing)) return 'not-ours'
	await ctx.configEditor.edit(entry, (current) => {
		const presets = isRecord(current.presets) ? current.presets : {}
		const next = { ...presets }
		delete next[GUARDED_PRESET]
		const config = { ...current, presets: next }
		if (current.defaultPreset === GUARDED_PRESET) {
			// Leaving this in place fails the permission row's own validation.
			if ('workspace-write' in next) config.defaultPreset = 'workspace-write'
			else delete config.defaultPreset
		}
		return config
	})
	return presetTableOf(ctx)?.[GUARDED_PRESET] === undefined ? 'removed' : 'skipped'
}
