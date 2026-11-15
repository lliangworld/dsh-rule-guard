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
 * Three constraints of the live environment, each found by driving the installed
 * plugin rather than by reading its source, shape when the write may happen:
 *
 * - **The permission row is not in `entries()`.** That list is filtered to rows
 *    whose parent fiber is the `include` root, which the permission row does not
 *    satisfy in this profile — so `entries()` omits it while `configuration()`
 *    still reports it. The lookup therefore goes through `configuration()`.
 * - **`edit` cannot run inside the transaction that is loading or unloading this
 *    plugin.** `edit` reconciles the loader, which opens its own HMR
 *    transaction, and the loader refuses to nest them: the call fails with "HMR
 *    transactions cannot be nested". That transaction outlives both a macrotask
 *    and several seconds of retrying, so a write attempted during this effect's
 *    setup does not land.
 * - **The same call succeeds from a tool execution.** The listener that guards
 *    commands runs long after the loader has settled, so the write is retried
 *    from there as well as at load. Whichever comes first wins, and the loser
 *    finds the preset already present.
 *
 * The unload is the asymmetric case. No listener runs once the fiber is gone, so
 * the removal has only its own retry window — and the transaction that unloads
 * this plugin does not close within it. Measured against the live profile: 3000
 * attempts across five and a half minutes, every one refused. The removal is
 * therefore best-effort, and a preset left behind is the documented, safe
 * outcome: the guard keeps working under it, and the next enable finds it
 * already present.
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

/** How long a write waits for the loader to become free before giving up. */
const RETRY_ATTEMPTS = 30
const RETRY_DELAY = 100

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
 * Whether one error is the loader refusing a nested transaction.
 *
 * @param {unknown} error - what a rejected write threw.
 * @returns {boolean} whether waiting could help.
 */
function isNestedTransaction(error) {
	return /cannot be nested/i.test(String(error?.message ?? error))
}

/**
 * Run one write, waiting out a transaction the loader already holds.
 *
 * Every other error is rethrown at once, so a real failure — a shadowed row, a
 * rejected validation — surfaces instead of being retried into silence.
 *
 * @template T
 * @param {() => Promise<T>} write - the write to attempt.
 * @returns {Promise<T>} the write's result.
 */
async function whenLoaderIsFree(write) {
	let last
	for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
		try {
			const result = await write()
			return result
		} catch (error) {
			if (!isNestedTransaction(error)) throw error
			last = error
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY))
		}
	}
	throw last
}

/**
 * The loader entry whose config owns the preset table, or `undefined`.
 *
 * Matching on the row's package name (or, failing that, its id) plus the
 * presence of a preset table means an upstream rename skips the row instead of
 * writing a preset into something that is not one.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {object | undefined} the entry, or `undefined` when none matches.
 */
export function findPresetEntry(ctx) {
	const editor = ctx.configEditor
	if (editor === undefined) return undefined
	let rows
	try {
		rows = editor.configuration()
	} catch {
		return undefined
	}
	if (!Array.isArray(rows)) return undefined
	const row = rows.find((candidate) => {
		const options = candidate?.entry?.options
		if (!isRecord(options)) return false
		if (options.name !== PRESET_ROW_NAME && options.id !== PRESET_ROW_ID) return false
		return isRecord(candidate.override?.presets) || isRecord(candidate.inherited?.presets)
	})
	return row?.entry
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
 * Idempotent: a table that already has the entry is left untouched, so the
 * second caller of a race — the load attempt and the listener retry — writes
 * nothing.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Promise<'written' | 'present' | 'skipped'>} what happened.
 */
export async function installPreset(ctx) {
	const entry = findPresetEntry(ctx)
	if (entry === undefined) return 'skipped'
	if (presetTableOf(ctx)?.[GUARDED_PRESET] !== undefined) return 'present'
	await whenLoaderIsFree(() =>
		ctx.configEditor.edit(entry, (current) => {
			const presets = isRecord(current.presets) ? current.presets : {}
			return { ...current, presets: { ...presets, [GUARDED_PRESET]: GUARDED_PRESET_SPEC } }
		}),
	)
	return presetTableOf(ctx)?.[GUARDED_PRESET] !== undefined ? 'written' : 'skipped'
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
	await whenLoaderIsFree(() =>
		ctx.configEditor.edit(entry, (current) => {
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
		}),
	)
	return presetTableOf(ctx)?.[GUARDED_PRESET] === undefined ? 'removed' : 'skipped'
}
