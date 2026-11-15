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
 * - **Which slot is this plugin's.** The key `guarded-full` is the identity, not
 *    the values under it. What sits there is presentation this plugin owns — the
 *    label changes with the language — so matching on values would make a
 *    language switch look like a user edit and stop the plugin managing its own
 *    preset, and would stop it recognising its own preset after a version adds a
 *    field to the spec. A user who wants their own preset adds another key,
 *    which this plugin never touches.
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
 * The unload is the asymmetric case, and its resolution was found by measurement
 * rather than by reading. `runExclusive`'s nesting guard reads an AsyncLocalStorage
 * on the *caller's* context; escaping that context — `hmr.executing.exit()`, the
 * same escape the HMR service itself uses in `watchConfig` — makes it queue the
 * write on the loader's operation queue instead of refusing it. Queued is what we
 * want, but awaiting that queue waits for the very transaction the caller's
 * teardown is blocking, which deadlocks the host. So the write is fired and
 * abandoned: the teardown returns, the unload finishes, the queue drains, and the
 * preset is removed a moment later.
 *
 * Disabling the plugin removes the preset that way, and it does so cleanly —
 * `configEditor.edit` drops the whole `permission` row when the next config
 * deep-equals its inherited one, so the effective configuration does not change
 * at all and no residue is left. Uninstalling does not: `removeBundle` disables
 * the bundle first, and the write that follows is lost in the reconcile. That
 * leaves a preset naming a plugin that is gone, which is harmless.
 *
 * @module dsh-rule-guard/preset
 */


/** The preset this plugin owns. The key is its identity, never its contents. */
export const GUARDED_PRESET = 'guarded-full'

/** What the preset does, and the only part that must never change. */
export const GUARDED_PRESET_KNOBS = {
	sandbox: 'danger-full-access',
	approval: 'ask',
}

/** Presentation, which follows the language the host is running in. */
export const PRESET_LABELS = {
	zh: {
		name: '守卫式全权限',
		description: '沙箱全开；危险命令命中规则时询问用户。',
	},
	en: {
		name: 'Guarded full access',
		description: 'Full sandbox access; dangerous commands ask the user.',
	},
}

/** The row whose config holds the preset table. */
const PRESET_ROW_NAME = '@deepseek-ai/dsh-permission-presets'
const PRESET_ROW_ID = 'permission'

/** The row whose config carries the language the host runs in. */
const LOCALE_ROW_ID = 'locale'

/** The process catalog's "something changed, re-read it" signal. */
const CATALOG_CHANGED = 'permission-presets/catalog-changed'

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
 * Tell every consumer the selectable preset set moved.
 *
 * The permission client caches the whole catalog and listens for this one event,
 * so a preset this plugin adds or removes would not reach the settings row or
 * the composer seat until a restart: `permissionPresets` emits the signal only
 * from `registerAuto`, never for a configuration change. The event is
 * payload-free by design and the catalog is process-level, so a contributor
 * announcing its own change is the documented use.
 *
 * Emitted after the write settles, never before: `configEditor.edit` resolves
 * once the permission fiber has been restarted with the new table, so a
 * consumer that re-reads the catalog then sees the new one. Emitting first
 * would hand the client the old table, and nothing would ever re-read it.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {void}
 */
function announceCatalogChange(ctx) {
	try {
		ctx.emit(CATALOG_CHANGED)
	} catch {
		// A context on its way out cannot emit; the preset stands and the
		// consumer's next generation reads it anyway.
	}
}

/**
 * Whether the table's `guarded-full` slot is occupied.
 *
 * The key is the identity. What sits under it is presentation this plugin owns:
 * `name` and `description` change with the language, so matching on values would
 * make a language switch look like a user edit and stop the plugin managing its
 * own preset — and it would stop the plugin recognising its own preset after a
 * version adds a field to the spec. A user who wants their own preset adds
 * another key, which this plugin never touches.
 *
 * @param {unknown} presets - the table, or anything a hostile config may hold.
 * @returns {boolean} whether the slot is occupied.
 */
function slotOccupied(presets) {
	return isRecord(presets) && presets[GUARDED_PRESET] !== undefined
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
 * The HMR service, reached the way the config editor reaches it.
 *
 * Not injected: `ctx.hmr` is only present when the host was started with
 * `--expose-internals`, and `static inject` lists are resolved at mount time —
 * listing it would make this plugin fail to load in a profile that has no HMR
 * service at all. `dsh-config-editor` uses exactly this form for the same
 * reason.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {{ executing?: { exit<T>(fn: () => Promise<T>): Promise<T> } } | undefined} the service, if mounted.
 */
function hmrOf(ctx) {
	try {
		return ctx.get?.('hmr')
	} catch {
		return undefined
	}
}

/**
 * Run one write outside whatever HMR transaction the caller is standing in.
 *
 * `configEditor.edit` ends in `hmr.runExclusive`, whose nesting guard reads an
 * AsyncLocalStorage on the *caller's* context. Inside the transaction that
 * loads or unloads this plugin the guard rejects outright; escaping the context
 * instead makes `runExclusive` queue the write on the loader's own operation
 * queue, where it runs once that transaction finishes.
 *
 * The HMR service itself uses exactly this escape in `watchConfig`, so the shape
 * is not novel — but the consequence is: **the caller must not await the result
 * while it is still inside that transaction.** Awaiting it waits for a queue that
 * the caller's own transaction is blocking, which deadlocks the unload. See
 * `removePresetWhenUnloaded` and `installPresetWhenLoaded`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {() => Promise<T>} write - the write to attempt.
 * @returns {Promise<T>} the write's result, or a rejection if it cannot queue.
 * @template T
 */
function outsideLoader(ctx, write) {
	const executing = hmrOf(ctx)?.executing
	if (executing?.exit === undefined) return write()
	return executing.exit(write)
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
 * The permission row's config as the profile's own patch currently holds it.
 *
 * Read from the override layer, which is what `configEditor.edit` both reads and
 * writes. `undefined` when the row configures no preset table.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Record<string, unknown> | undefined} the row's config, if any.
 */
function rowConfigOf(ctx) {
	const editor = ctx.configEditor
	if (editor === undefined) return undefined
	try {
		const rows = editor.configuration()
		if (!Array.isArray(rows)) return undefined
		for (const row of rows) {
			const options = row?.entry?.options
			if (options?.name !== PRESET_ROW_NAME && options?.id !== PRESET_ROW_ID) continue
			return isRecord(row.override?.presets) ? row.override : undefined
		}
	} catch {
		return undefined
	}
	return undefined
}

/**
 * The language the host is running in.
 *
 * Three sources, most authoritative first:
 *
 * 1. the `locale` row's `preference` — what the user picked in Settings, which
 *    the client writes through the same `configEditor.edit` path this plugin
 *    uses, and which is absent until they choose something;
 * 2. the host's own ICU locale — the operating system's language, and the right
 *    answer on a desktop install where the setting was never touched;
 * 3. English, when neither says anything.
 *
 * The client's own language choice is not readable from here, so a browser in
 * one language over an OS in another lands on the second source. That is a
 * display label, not a behaviour, and the fallback is the conservative one.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {'zh' | 'en'} the language to present the preset in.
 */
export function presentationFor(ctx) {
	return labelsFor(ctx).language
}

/**
 * The presentation to write, in the language the host is running in.
 *
 * The resolver, as opposed to {@link presentationFor}: the writes need the
 * labels, and only the language for the callers that only branch on it.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {{ language: 'zh' | 'en', labels: { name: string, description: string } }} the language and its labels.
 */
export function labelsFor(ctx) {
	const language = languageOf(ctx)
	return { language, labels: PRESET_LABELS[language] }
}

/**
 * The language the host is running in, from the three sources.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {'zh' | 'en'} the language to present the preset in.
 */
function languageOf(ctx) {
	const preference = localePreferenceOf(ctx)
	if (typeof preference === 'string' && preference.length > 0) {
		return preference.toLowerCase().startsWith('zh') ? 'zh' : 'en'
	}
	return hostLanguage().startsWith('zh') ? 'zh' : 'en'
}

/**
 * The host's own language, as the platform reports it.
 *
 * Read through ICU rather than an environment variable: `LANG` and `LC_ALL` are
 * unset on Windows, where the language comes from the user's regional settings.
 *
 * @returns {string} a language tag such as `zh-CN`, or `en` when unknown.
 */
function hostLanguage() {
	try {
		const locale = Intl.DateTimeFormat().resolvedOptions().locale
		return typeof locale === 'string' ? locale : 'en'
	} catch {
		return 'en'
	}
}

/**
 * The `locale` row's `preference`, if the profile carries one.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {string | undefined} the chosen language, or `undefined`.
 */
function localePreferenceOf(ctx) {
	const editor = ctx.configEditor
	if (editor === undefined) return undefined
	try {
		const rows = editor.configuration()
		if (!Array.isArray(rows)) return undefined
		for (const row of rows) {
			const options = row?.entry?.options
			if (options?.id !== LOCALE_ROW_ID) continue
			const config = isRecord(row.override) ? row.override : {}
			const preference = config.preference
			if (typeof preference === 'string' && preference.length > 0) return preference
			const inherited = isRecord(row.inherited) ? row.inherited : {}
			return typeof inherited.preference === 'string' ? inherited.preference : undefined
		}
	} catch {
		return undefined
	}
	return undefined
}

/**
 * Add this plugin's preset, waiting out a transaction the loader already holds.
 *
 * The awaited variant, kept for tests and for a profile with no HMR service.
 * `index.js` uses {@link installPresetWhenLoaded}, which queues instead of
 * waiting — waiting is what could never land the write.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Promise<'written' | 'present' | 'skipped'>} what happened.
 */
export async function installPreset(ctx) {
	const entry = findPresetEntry(ctx)
	if (entry === undefined) return 'skipped'
	const current = rowConfigOf(ctx)
	if (slotOccupied(current?.presets)) return 'present'
	const labels = labelsFor(ctx).labels
	await whenLoaderIsFree(() => ctx.configEditor.edit(entry, (live) => installChange(live, labels)))
	const written = slotOccupied(rowConfigOf(ctx)?.presets)
	if (written) announceCatalogChange(ctx)
	return written ? 'written' : 'skipped'
}

/**
 * Add the preset from a fiber that is being activated, without blocking it.
 *
 * The mirror of {@link removePresetWhenUnloaded}, and the reason the enable path
 * works at all. Retrying inside the transaction that enables this plugin cannot
 * succeed: `runExclusive`'s guard reads the caller's async context, so every
 * retry runs inside the very transaction that is waiting for the effect to
 * return. Queuing past it is the only way, and awaiting that queue would deadlock
 * the activation exactly as it deadlocks the unload.
 *
 * So the write is fired and abandoned. Enabling the plugin therefore takes effect
 * on its own, without needing a command to run first — which is what the previous
 * retry-based install could never do, and why the preset only ever appeared after
 * the listener happened to fire.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {(message: string) => void} [warn] - where to report a failure.
 * @returns {'queued' | 'present' | 'skipped' | 'failed'} what happened, synchronously.
 */
export function installPresetWhenLoaded(ctx, warn) {
	const editor = ctx.configEditor
	const entry = findPresetEntry(ctx)
	if (editor === undefined || entry === undefined) return 'skipped'
	const current = rowConfigOf(ctx)
	if (slotOccupied(current?.presets)) return 'present'
	const labels = labelsFor(ctx).labels
	const write = () => editor.edit(entry, (live) => installChange(live, labels))
	try {
		Promise.resolve(outsideLoader(ctx, write))
			.then(() => announceCatalogChange(ctx))
			.catch((error) => {
				warn?.(`rule-guard: could not add the guarded-full preset: ${String(error)}`)
			})
		return 'queued'
	} catch (error) {
		warn?.(`rule-guard: could not add the guarded-full preset: ${String(error)}`)
		return 'failed'
	}
}

/**
 * The next config with this plugin's preset added, or unchanged.
 *
 * Every other key in the row is restated verbatim, because a patch's config is
 * replaced wholesale when a layer is applied — dropping `defaultPreset` or the
 * other presets would take the permission row's own defaults with them.
 *
 * @param {Record<string, unknown>} current - the row's config as it stands.
 * @param {{ name: string, description: string }} labels - the presentation to write.
 * @returns {Record<string, unknown>} the next config.
 */
export function installChange(current, labels) {
	const presets = isRecord(current.presets) ? current.presets : {}
	return {
		...current,
		presets: { ...presets, [GUARDED_PRESET]: { ...GUARDED_PRESET_KNOBS, ...labels } },
	}
}

/**
 * The next config with this plugin's preset removed, or `undefined` for no change.
 *
 * The slot's key is the identity, so an occupied slot is always this plugin's to
 * remove. The default preset is moved off this one first, because the permission
 * service throws when its `defaultPreset` is not a key of the table.
 *
 * Pure, so the two rules that matter — an occupied slot is always removed, and the
 * default is never left dangling — are assertable without a loader.
 *
 * @param {Record<string, unknown>} current - the row's config as it stands.
 * @returns {Record<string, unknown> | undefined} the next config, or `undefined`.
 */
export function removalChange(current) {
	const presets = isRecord(current.presets) ? current.presets : {}
	if (!slotOccupied(presets)) return undefined
	const next = { ...presets }
	delete next[GUARDED_PRESET]
	const config = { ...current, presets: next }
	if (current.defaultPreset === GUARDED_PRESET) {
		// Leaving this in place fails the permission row's own validation.
		if ('workspace-write' in next) config.defaultPreset = 'workspace-write'
		else delete config.defaultPreset
	}
	return config
}

/**
 * The next config with this plugin's preset relabelled, or `undefined` for no change.
 *
 * Called when the language changes: only `name` and `description` move, so the
 * rest of the row — the other presets, `defaultPreset` — is untouched. The knobs
 * are rewritten too, which is what makes a preset left behind by an older
 * version adopt the current ones.
 *
 * @param {Record<string, unknown>} current - the row's config as it stands.
 * @param {{ name: string, description: string }} labels - the presentation to write.
 * @returns {Record<string, unknown> | undefined} the next config, or `undefined`.
 */
export function relabelChange(current, labels) {
	const presets = isRecord(current.presets) ? current.presets : {}
	const existing = presets[GUARDED_PRESET]
	if (!isRecord(existing)) return undefined
	if (existing.name === labels.name && existing.description === labels.description) return undefined
	return {
		...current,
		presets: {
			...presets,
			[GUARDED_PRESET]: { ...existing, ...GUARDED_PRESET_KNOBS, ...labels },
		},
	}
}

/**
 * Remove the preset from a fiber that is being disposed, without blocking it.
 *
 * The caller is standing inside the transaction that unloads this plugin, so the
 * write can only be queued — and awaiting a queue the caller's own transaction
 * is blocking deadlocks the unload. This therefore fires the write and returns
 * immediately: the transaction completes, the queue drains, and the preset is
 * removed a moment later.
 *
 * Everything the write needs is captured before the fiber goes away, because
 * `ctx` is not readable afterwards — the announcement included, which is fired
 * from the write's own continuation for the same reason. A host that shuts down
 * in the window simply leaves the preset behind, which is the same safe outcome
 * as not trying.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {(message: string) => void} [warn] - where to report a failure.
 * @returns {void}
 */
export function removePresetWhenUnloaded(ctx, warn) {
	const editor = ctx.configEditor
	const entry = findPresetEntry(ctx)
	if (editor === undefined || entry === undefined) return
	// The write is keyed off the row's own config, so it stays correct even if
	// the table changed between the check and the queued write.
	if (removalChange(rowConfigOf(ctx) ?? {}) === undefined) return
	// Captured while the fiber still owns the context: the queued write runs
	// after this teardown returns, when `ctx.emit` would no longer be readable.
	const announce = () => announceCatalogChange(ctx)
	const write = () => editor.edit(entry, (current) => removalChange(current) ?? current)
	Promise.resolve(outsideLoader(ctx, write))
		.then(announce)
		.catch((error) => {
			warn?.(`rule-guard: could not remove the guarded-full preset: ${String(error)}`)
		})
}

/**
 * Relabel the preset for the language the host is now running in.
 *
 * Fired when the `locale` row changes, so switching the language in Settings
 * updates the preset without a reinstall. Queued rather than awaited, because
 * this runs inside whatever transaction the settings write is in.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {(message: string) => void} [warn] - where to report a failure.
 * @returns {'queued' | 'unchanged' | 'absent' | 'failed'} what happened.
 */
export function relabelPreset(ctx, warn) {
	const editor = ctx.configEditor
	const entry = findPresetEntry(ctx)
	if (editor === undefined || entry === undefined) return 'absent'
	const current = rowConfigOf(ctx)
	if (!slotOccupied(current?.presets)) return 'absent'
	const labels = labelsFor(ctx).labels
	if (relabelChange(current ?? {}, labels) === undefined) return 'unchanged'
	const write = () => editor.edit(entry, (live) => relabelChange(live, labels) ?? live)
	try {
		Promise.resolve(outsideLoader(ctx, write))
			.then(() => announceCatalogChange(ctx))
			.catch((error) => {
				warn?.(`rule-guard: could not relabel the guarded-full preset: ${String(error)}`)
			})
		return 'queued'
	} catch (error) {
		warn?.(`rule-guard: could not relabel the guarded-full preset: ${String(error)}`)
		return 'failed'
	}
}
