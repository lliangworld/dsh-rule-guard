import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')

/**
 * The Client half cannot be executed under `node`: its module body references
 * `window` at top level, which only exists in the browser. These tests
 * therefore assert the source's shape — that every Config field the Host
 * accepts is one the card renders, that the two halves agree on the row
 * identity, and that the dictionaries agree on their keys. A field added to
 * `Config` and forgotten in `client.js` fails here rather than reaching the
 * user as a silently unconfigurable setting.
 *
 * What these tests cannot cover is the rendered card; that is verified by
 * installing the bundle and looking at the Plugins page.
 */

const client = read('client.js')
const manifest = JSON.parse(read('package.json'))

/** The card's `css` constant, so the assertions can read the shipped rules. */
const css = client.slice(client.indexOf('const css = ['), client.indexOf('const tagId'))

/**
 * The Config schema projected to its JSON form, resolved field by field.
 *
 * `Config.toJSON()` returns a ref table: the root's `dict` maps each field
 * name to a ref, and each ref carries the field's type and meta. This is the
 * same projection the Host and the settings card read, so the assertions
 * below check the contract both halves actually see.
 *
 * @returns {{ fields: Record<string, { type: string, default: unknown, min?: number, max?: number }>, order: string[] }} the projected schema.
 */
function schema() {
	const json = Config.toJSON()
	const root = json.refs[String(json.uid)]
	const fields = {}
	for (const [name, ref] of Object.entries(root.dict ?? {})) {
		const type = json.refs[String(ref)]
		fields[name] = {
			type: type.type,
			default: type.meta?.default,
			min: type.meta?.min,
			max: type.meta?.max,
		}
	}
	return { fields, order: Object.keys(fields) }
}

/** The Config schema's own field names, in declaration order. */
const schemaFields = schema().order

/** The field list `client.js` declares for the card. */
const cardFields = [...client.matchAll(/^\t\t\t'([A-Za-z]+)',?$/gm)].map((match) => match[1])

test('the Host schema declares ten fields', () => {
	assert.deepEqual(schemaFields, [
		'tools',
		'dialect',
		'onUnsupported',
		'onError',
		'allowPatterns',
		'askPatterns',
		'denyPatterns',
		'maxCommandLength',
		'audit',
		'auditPath',
	])
})

test('every schema field carries the default the card assumes', () => {
	const fields = schema().fields
	assert.deepEqual(fields.tools.default, ['pwsh', 'bash', 'terminal', 'pwsh_persistent', 'bash_persistent', 'ops_bash'])
	assert.equal(fields.dialect.default, 'auto')
	assert.equal(fields.onUnsupported.default, 'allow')
	assert.equal(fields.onError.default, 'allow')
	assert.deepEqual(fields.allowPatterns.default, [])
	assert.deepEqual(fields.askPatterns.default, [])
	assert.deepEqual(fields.denyPatterns.default, [])
	assert.equal(fields.maxCommandLength.default, 10000)
	assert.equal(fields.audit.default, true)
	assert.equal(fields.auditPath.default, '')
	// A volatile field is what lets a saved value reach the next command
	// without restarting the plugin; the card's promise depends on it.
	assert.equal(fields.dialect.type, 'union')
	assert.equal(fields.audit.type, 'boolean')
})

test('the card renders every Config field', () => {
	// The card's own field list is the source of truth for the projection
	// loop; it must cover the schema exactly, or a field is unconfigurable.
	assert.deepEqual(cardFields, schemaFields)
})

test('the card renders no field the schema lacks', () => {
	for (const field of cardFields) {
		assert.ok(schemaFields.includes(field), `client.js renders unknown field "${field}"`)
	}
})

test('the manifest declares the client half', () => {
	assert.equal(manifest.exports['./client'], './client.js')
	assert.ok(manifest.files.includes('client.js'))
	assert.equal(manifest.dsh.client.platform, 'web')
	assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
	assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'))
	assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
})

test('the two halves agree on the row identity', () => {
	// The slot key must be `<package name>#<row id>`; the namespace the card
	// watches must equal the row id the patch declares, or the configure
	// entry never appears.
	const patch = read('cordis.patch.yml')
	assert.match(patch, /^\s*- id: rule-guard$/m)
	assert.match(patch, /name: '@lliangworld\/dsh-rule-guard'/)

	const key = client.match(/const ROW_CONFIG_KEY = '([^']+)'/)?.[1]
	assert.equal(key, `${manifest.name}#rule-guard`)

	const namespace = client.match(/const NS = '([^']+)'/)?.[1]
	assert.equal(namespace, 'rule-guard')

	// The row must not restate the defaults: the schema is their only source,
	// so the config editor can clear them.
	assert.ok(!/^\s+config:/m.test(patch), 'cordis.patch.yml restates the defaults')
})

test('the card stages every field through the form model', () => {
	// Each editable field needs a spec, or `form.field(name)` throws.
	for (const field of schemaFields) {
		if (field === 'audit') continue
		assert.ok(
			client.includes(`settingsTextField('${field}')`) || client.includes(`settingsNumberField('${field}')`),
			`client.js declares no field spec for "${field}"`,
		)
	}
	// The boolean rides the form as a text field so it can be staged at all,
	// and the switch reads its position from the scope snapshot.
	assert.ok(client.includes("primitives.settingsTextField('audit')"))
	assert.ok(client.includes('scopeValue(this.scope, AUDIT_FIELD)'))
})

test('the length cap bounds match the Host schema', () => {
	const field = schema().fields.maxCommandLength
	assert.equal(client.match(/const MIN_COMMAND_LENGTH = (\d+)/)?.[1], String(field.min))
	assert.equal(client.match(/const MAX_COMMAND_LENGTH = (\d+)/)?.[1], String(field.max))
})

test('the projection key for the switch is not a Config field name', () => {
	// `projection()` fills `state[field]` for every Config field, so a
	// projection key that collides with a field name is overwritten by the
	// form's `{text, overridden, invalid}` object. The audit switch's boolean
	// would then render permanently on.
	const projection = client.slice(client.indexOf('projection() {'), client.indexOf('projection() {') + 400)
	const keys = [...projection.matchAll(/^\t{5}(\w+): /gm)].map((match) => match[1])
	assert.deepEqual(keys, ['defaults', 'auditOn'])
	for (const key of keys) {
		assert.ok(!schemaFields.includes(key), `projection key "${key}" collides with a Config field`)
	}
	// The component must read that key, not the field's object.
	assert.match(client, /checked: state\.auditOn/)
	assert.ok(!/checked: state\.audit\b/.test(client), 'the switch reads the field object, not the boolean')
})

/**
 * Theme tokens the host's own stylesheet references.
 *
 * An earlier version of the card invented three names —
 * `--dsw-alias-background-default`, `--dsw-alias-line-subtle` and
 * `--dsw-alias-border-focused` — none of which the host defines. The browser
 * silently dropped those declarations, so the textareas kept a white
 * background and dark-mode text sat on it, which is exactly what the user saw.
 *
 * The list is every `--dsw-*` name referenced by
 * `dsh-web-frontend/dist/assets/index-CSAdOBx6.css` in the installed host,
 * which is the authority: `Theme.listTokens` returns only a subset and cannot
 * be used to prove a name exists. Extend this set from that file, never by
 * guessing a plausible spelling.
 */
const HOST_TOKENS = new Set([
	'--dsw-alias-bg-base',
	'--dsw-alias-bg-layer-1',
	'--dsw-alias-bg-layer-2',
	'--dsw-alias-bg-layer-3',
	'--dsw-alias-bg-layer-4',
	'--dsw-alias-bg-mask-1',
	'--dsw-alias-bg-module-platform',
	'--dsw-alias-bg-skeleton',
	'--dsw-alias-border-l1',
	'--dsw-alias-border-l2',
	'--dsw-alias-border-l3',
	'--dsw-alias-border-l4',
	'--dsw-alias-border-l2-darkmode-thin',
	'--dsw-alias-brand-primary',
	'--dsw-alias-button-ghost-active-border',
	'--dsw-alias-button-ghost-active-fill',
	'--dsw-alias-button-primary-fill',
	'--dsw-alias-button-primary-hover',
	'--dsw-alias-button-tool-bar-fill',
	'--dsw-alias-button-tool-bar-hover',
	'--dsw-alias-code-diff-added',
	'--dsw-alias-code-diff-deleted',
	'--dsw-alias-file-diff-added-bg',
	'--dsw-alias-file-diff-added-marker',
	'--dsw-alias-file-diff-deleted-bg',
	'--dsw-alias-file-diff-deleted-marker',
	'--dsw-alias-hovercard-bg',
	'--dsw-alias-hovercard-label-primary',
	'--dsw-alias-interactive-bg-active',
	'--dsw-alias-interactive-bg-hover',
	'--dsw-alias-interactive-bg-hover-danger',
	'--dsw-alias-json-tree-icon',
	'--dsw-alias-json-tree-hover',
	'--dsw-alias-json-tree-keyword',
	'--dsw-alias-json-tree-number',
	'--dsw-alias-json-tree-property',
	'--dsw-alias-json-tree-punctuation',
	'--dsw-alias-json-tree-string',
	'--dsw-alias-label-caption',
	'--dsw-alias-label-dimmed',
	'--dsw-alias-label-error',
	'--dsw-alias-label-primary',
	'--dsw-alias-label-primary-foreground',
	'--dsw-alias-label-secondary',
	'--dsw-alias-label-shimmer',
	'--dsw-alias-label-tertiary',
	'--dsw-alias-link',
	'--dsw-alias-markdown-code-block',
	'--dsw-alias-markdown-code-block-banner',
	'--dsw-alias-markdown-inline-code',
	'--dsw-alias-markdown-tag',
	'--dsw-alias-menu-group-header-fill',
	'--dsw-alias-menu-icon',
	'--dsw-alias-scrollbar-bg-l2',
	'--dsw-alias-scrollbar-hover-l2',
	'--dsw-alias-state-business-primary',
	'--dsw-alias-state-error-primary',
	'--dsw-alias-state-idle-primary',
	'--dsw-alias-state-success-primary',
	'--dsw-alias-state-success-tertiary',
	'--dsw-alias-state-warn-label',
	'--dsw-alias-state-warn-primary',
	'--dsw-alias-state-warn-tertiary',
	'--dsw-alias-switch-thumb',
	'--dsw-alias-toast-action',
	'--dsw-alias-toast-bg',
	'--dsw-alias-toast-label',
	'--dsw-alias-tooltip-bg',
	'--dsw-alias-tooltip-key-bg',
	'--dsw-alias-tooltip-label',
	'--dsw-elevation-panel',
	'--dsw-elevation-prominent',
	'--dsw-elevation-soft',
	'--dsw-focus-ring-color',
	'--dsw-focus-ring-width',
	'--dsw-font-family',
	'--dsw-font-markdown-base',
	'--dsw-font-markdown-code',
	'--dsw-font-markdown-code-block',
	'--dsw-font-markdown-code-font-family',
	'--dsw-font-markdown-h1',
	'--dsw-font-markdown-h2',
	'--dsw-font-markdown-h3',
	'--dsw-font-markdown-h4',
	'--dsw-font-markdown-table',
	'--dsw-font-markdown-table-head',
	'--dsw-font-xs-13',
	'--dsw-mask-blur',
	'--dsw-menu-backdrop-filter',
	'--dsw-menu-surface-fill',
	'--dsw-radius-lg',
	'--dsw-radius-md',
	'--dsw-radius-panel',
	'--dsw-radius-sm',
	'--dsw-radius-xl',
	'--dsw-radius-xs',
	'--dsw-shadow-lv3',
	'--dsw-specific-bubble',
	'--dsw-specific-input-major',
	'--dsw-specific-menu',
	'--dsw-specific-sidebar-fill',
	'--dsw-static-amber-400',
	'--dsw-static-amber-500',
	'--dsw-static-deepseek-450',
	'--dsw-static-deepseek-500',
	'--dsw-static-green-500',
	'--dsw-static-neutral-bluish-300',
	'--dsw-static-red-600',
])

test('every theme token the card references exists in the host', () => {
	// A name the host never defines is dropped by the browser, so the
	// declaration it sits in has no effect — the original cause of the
	// theme-unaware textareas.
	const used = [...client.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1])
	assert.ok(used.length > 0, 'the card references no theme tokens at all')
	const unknown = [...new Set(used)].filter((token) => !HOST_TOKENS.has(token))
	assert.deepEqual(unknown, [], 'the card references tokens the host does not define')
})

test('the card mirrors the host input colors rather than inventing them', () => {
	// The theme fix's substance: the list input must take its background and
	// border from the same tokens the host's own `_input` rule uses.
	assert.match(css, /\.dshRuleGuardList\{[^}]*background:var\(--dsw-alias-bg-layer-3\)/)
	assert.match(css, /\.dshRuleGuardList\{[^}]*border:\.5px solid var\(--dsw-alias-border-l4\)/)
	assert.match(css, /\.dshRuleGuardList\{[^}]*color:var\(--dsw-alias-label-primary\)/)
	assert.match(css, /\.dshRuleGuardList:focus-visible\{[^}]*border-color:var\(--dsw-alias-state-business-primary\)/)
	assert.match(css, /\.dshRuleGuardList\[aria-invalid=true\]\{[^}]*border-color:var\(--dsw-alias-state-error-primary\)/)
})

test('adjacent fields are separated by a rule, not only by padding', () => {
	// The host's `_field + _field` hairline is what makes consecutive fields
	// readable; padding alone leaves a hint touching the next label.
	assert.match(css, /\.dshRuleGuardField\{[^}]*padding:12px 0[^}]*\}/)
	assert.match(css, /\.dshRuleGuardField\+\.dshRuleGuardField\{[^}]*border-top:\.5px solid var\(--dsw-alias-border-l2\)/)
	// And every hand-drawn field must emit that block, or the rule never fires.
	assert.match(client, /className: 'dshRuleGuardField'/)
	assert.ok(!/dshRuleGuardSegmentRow|dshRuleGuardToggleRow|dshRuleGuardGroup\b/.test(client), 'a retired field row class is still in use')
})

test('the client module parses', () => {
	// A confined environment may forbid spawning `node --check`, so the body
	// is parsed in process instead. `client.js` is a factory with no
	// top-level `import` or `export`, so a Function body is a valid parse
	// target for it; the exact command remains `node --check client.js`.
	assert.doesNotThrow(() => new Function(client), 'client.js does not parse')
	// A malformed body must be caught, so the check above is not vacuous.
	assert.throws(() => new Function('const ='))
})

/** Every dictionary literal key in one dictionary body, as a Set. */
function dictionaryKeys(name) {
	const body = client.slice(client.indexOf(`const ${name} = {`))
	const end = body.indexOf('\n\t\t}')
	const keys = [...body.slice(0, end).matchAll(/^\t\t\t([A-Za-z]+):/gm)].map((match) => match[1])
	return new Set(keys)
}

test('the two dictionaries declare the same keys', () => {
	// A key present in one language and absent in the other renders the raw
	// key name in that language's UI.
	assert.deepEqual([...dictionaryKeys('en')].sort(), [...dictionaryKeys('zh')].sort())
	assert.ok(dictionaryKeys('en').size > 20, 'the English dictionary looks truncated')
})
