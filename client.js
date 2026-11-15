/**
 * `dsh-rule-guard` client half: the configuration card on the Plugins page.
 *
 * The Host half owns the rules and the decision; this file owns the editing.
 * It registers into the `plugins.row.config` keyed slot while the Host serves
 * the `rule-guard` namespace, so a disabled row shows no configure entry, and
 * a saved field reaches the next command without a restart — every Config
 * field is `.volatile()`, so the loader commits the change into the live
 * reference instead of rebuilding the plugin fiber.
 *
 * The Host never reads this file and the browser never reads `index.js`: a
 * bundle's two halves meet only at the settings namespace and the slot key,
 * both of which equal the row id this bundle's patch declares.
 *
 * Conventions taken from the sibling `dsh-web-search-keenable` card and the
 * shipped `@deepseek-ai/dsh-client-ui-settings-shell` card:
 * - `window.__ModuleLoader__.load` factory form, no build step, plain ESM.
 * - Baseline modules `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`
 *   and `@deepseek-ai/dsh-client-store` are required directly; no declaration.
 * - Visible text comes from the Client locale service, never a literal.
 * - Collapsible state and drafts live in the controller's store, not React
 *   hooks, because a factory only guarantees `react/jsx-runtime`.
 *
 * Two shapes need care, both learned from the shipped cards:
 * - **A boolean cannot ride a text field.** `settingsTextField.format` maps a
 *   boolean to `''`, so the field's text goes stale the moment a save lands
 *   and the switch appears in the wrong position. The audit switch is
 *   therefore driven from the scope snapshot plus a draft, and only a position
 *   differing from the inherited one is staged.
 * - **The primitives have no list or boolean field.** `tools` and the three
 *   pattern arrays are edited as one-per-line textareas with a custom
 *   `format`/`parse`, and the two enum fields use `SegmentedControl` writing
 *   the same `edit(field, value)` call a text field would.
 *
 * @module dsh-rule-guard/client
 */

window.__ModuleLoader__.load({
	id: '@lliangworld/dsh-rule-guard',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		let jsx = require('react/jsx-runtime')
		let primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		let store = require('@deepseek-ai/dsh-client-store')

		//#region dictionaries
		/** English copy. */
		const en = {
			description:
				'Local shell-command rules: an ordinary call passes, a rule match asks the user with no timeout.',
			global: 'Guard every session',
			globalHint:
				'Off (the default) guards only sessions whose effective permission is full sandbox plus ask — the guarded-full preset — so an existing preset behaves exactly as before. On guards every session regardless of preset, sandbox or approval policy.',
			managePreset: 'Manage the guarded-full preset',
			managePresetHint:
				'On (the default) adds the guarded-full preset while this plugin is enabled, and removes it again when the plugin is disabled. Turning this switch off removes the preset too, and turning it back on adds it again — both take effect without restarting the harness. Uninstalling the plugin does not remove it — the guard is unloaded either way, so a leftover preset is inert. Off leaves your preset table alone: maintain the preset yourself, as README.md describes.',
			rules: 'Built-in rules',
			rulesHint:
				'A switched-off rule no longer asks: a command that matches it is released. The audit still records that the rule matched.',
			patterns: 'Custom patterns',
			tools: 'Guarded tools',
			toolsHint:
				'One tool name per line. A call to any tool not listed here is never intercepted. Leave blank to restore the default.',
			dialect: 'Command dialect',
			dialectHint:
				'How a command is parsed. Auto infers it from the tool name (pwsh → powershell, cmd → cmd, bash/terminal/sh → posix).',
			dialectAuto: 'Auto',
			dialectPosix: 'POSIX',
			dialectCmd: 'CMD',
			dialectPowershell: 'PowerShell',
			onUnsupported: 'When a command cannot be judged',
			onUnsupportedHint:
				'A command whose target is dynamic, a script file, a compound statement, or a line longer than the length cap has no static verdict. Allow releases it; ask prompts.',
			onError: 'When the rule engine fails',
			onErrorHint:
				'What to do if analyzing a command throws. Allow releases it; ask prompts. Both are safe against crashes: an error never lets a command through silently.',
			optionAllow: 'Allow',
			optionAsk: 'Ask',
			audit: 'Record decisions',
			auditHint:
				'Append every ask, deny, and unjudgeable verdict to a JSONL log. A plain allow is the common case and is not recorded.',
			auditPath: 'Audit log path',
			auditPathHint:
				'Where the log is written. Leave blank for $DSH_HOME/rule-guard-audit.jsonl; $DSH_HOME and ${DSH_HOME} are expanded.',
			maxCommandLength: 'Command length cap',
			maxCommandLengthHint:
				'Longest command text analyzed, in characters. A longer command has no static verdict and follows the policy above.',
			patterns: 'Rule patterns',
			patternsHint:
				'One regular expression per line, matched against the whole command text.',
			allowPatterns: 'Allow patterns',
			allowPatternsHint:
				'A match releases the call without asking. Use it to exempt a recurring false positive.',
			askPatterns: 'Ask patterns',
			askPatternsHint: 'A match asks the user, even when no built-in rule fired.',
			denyPatterns: 'Deny patterns',
			denyPatternsHint: 'A match denies the call outright, without asking.',
			unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
			readOnly: 'This deployment stores settings read-only.',
			saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
			save: 'Save',
			saving: 'Saving…',
			overridden: 'Overridden',
			reset: 'Reset to default',
			invalidText: 'Enter text, or leave blank to use the default.',
			invalidLength: 'Enter a whole number from 1000 to 100000, or leave blank to use the default.',
			invalidList: 'Enter one entry per line, or leave blank to use the default.',
			defaultValue: 'Default: {value}.',
			noDefault: 'No default.',
			listDefault: 'Default: {count} entries.',
		}
		/** Simplified Chinese copy. */
		const zh = {
			description: '本地命令规则：普通调用直接放行，命中规则的命令询问用户，无倒计时。',
			global: '全局生效',
			globalHint:
				'关闭（默认）时，只有有效权限为「全沙箱 + 询问」的会话——即守卫式全权限预设——才启用守卫，现有预设行为完全不变；开启后在任何预设、任何权限下都生效。',
			managePreset: '托管守卫式全权限预设',
			managePresetHint:
				'开启（默认）时，本插件启用期间会自动加入「守卫式全权限」预设，禁用插件时再自动移除。关闭此开关同样会移除该预设，重新打开则会加回——两者都立即生效，无需重启 harness。卸载插件不会移除它——守卫两种情况下都会卸载，残留的预设只是空置。关闭则不动你的预设表：由你自己维护该预设，见 README.md。',
			rules: '内置规则',
			rulesHint: '关掉某条规则后，命中它不再询问、直接放行；审计仍会记录这条规则命中过。',
			patterns: '自定义规则正则',
			tools: '受管工具',
			toolsHint: '每行一个工具名。不在列表内的工具调用不会被拦截。留空恢复默认。',
			dialect: '命令方言',
			dialectHint:
				'命令的解析方式。Auto 按工具名推断（pwsh → powershell、cmd → cmd、bash/terminal/sh → posix）。',
			dialectAuto: 'Auto',
			dialectPosix: 'POSIX',
			dialectCmd: 'CMD',
			dialectPowershell: 'PowerShell',
			onUnsupported: '无法静态判定时',
			onUnsupportedHint:
				'目标是变量、脚本文件、复合语句，或超过长度上限的命令行，都没有静态结论。Allow 放行；Ask 询问。',
			onError: '规则引擎失败时',
			onErrorHint: '分析命令时抛错如何处理。Allow 放行；Ask 询问。两者都不会让崩溃悄悄放行命令。',
			optionAllow: '放行',
			optionAsk: '询问',
			audit: '记录判定',
			auditHint: '把每次询问、拒绝和无法判定的结果追加写入 JSONL 日志。普通放行是绝大多数，不记录。',
			auditPath: '审计日志路径',
			auditPathHint: '日志写入位置。留空使用 $DSH_HOME/rule-guard-audit.jsonl；会展开 $DSH_HOME 与 ${DSH_HOME}。',
			maxCommandLength: '命令长度上限',
			maxCommandLengthHint: '参与分析的命令文本最大字符数。超过该长度即无静态结论，按上述策略处理。',
			patterns: '规则正则',
			patternsHint: '每行一条正则表达式，针对整条命令文本匹配。',
			allowPatterns: '放行规则',
			allowPatternsHint: '命中则不经询问直接放行。用于豁免反复出现的误报。',
			askPatterns: '询问规则',
			askPatternsHint: '命中则询问用户，即使没有内置规则命中。',
			denyPatterns: '拒绝规则',
			denyPatternsHint: '命中则直接拒绝，不询问。',
			unavailable: '该插件当前未加载，暂时无法配置。',
			readOnly: '本部署的设置为只读。',
			saveFailed: '本部署未接受这些值；请修正后重试。',
			save: '保存',
			saving: '保存中…',
			overridden: '已覆盖',
			reset: '恢复默认',
			invalidText: '请填写文本；留空使用默认值。',
			invalidLength: '请填 1000–100000 的整数；留空使用默认值。',
			invalidList: '每行一条；留空使用默认值。',
			defaultValue: '默认值：{value}。',
			noDefault: '无默认值。',
			listDefault: '默认值：{count} 条。',
		}
		//#endregion

		//#region field specs
		/** Bounds of the command length cap, matching the Host schema. */
		const MIN_COMMAND_LENGTH = 1000
		const MAX_COMMAND_LENGTH = 100000

		/**
		 * Parse a bounded whole number: blank clears the override, a
		 * non-integer or out-of-range value is invalid so the form blocks
		 * the save instead of letting the Host reject it.
		 *
		 * @param {number} min - the inclusive lower bound.
		 * @param {number} max - the inclusive upper bound.
		 * @returns {(text: string) => { kind: 'clear' } | { kind: 'set', value: number } | undefined} the field's parse function.
		 */
		function boundedInt(min, max) {
			return (text) => {
				if (text.trim() === '') return { kind: 'clear' }
				const value = Number(text)
				return Number.isInteger(value) && value >= min && value <= max
					? { kind: 'set', value }
					: undefined
			}
		}

		/**
		 * Parse a boolean written as text: blank clears the override, anything
		 * but `true`/`false` is invalid.
		 *
		 * A text field's default parse returns its input verbatim, so without
		 * this a switch would stage the *string* 'false'. The Host rejects
		 * that at validation, because the schema declares a boolean.
		 *
		 * @param {string} text - the field's raw text.
		 * @returns {{ kind: 'clear' } | { kind: 'set', value: boolean } | undefined} the parsed edit.
		 */
		function booleanText(text) {
			const value = text.trim()
			if (value === '') return { kind: 'clear' }
			if (value === 'true') return { kind: 'set', value: true }
			if (value === 'false') return { kind: 'set', value: false }
			return undefined
		}

		/**
		 * Parse a one-per-line list: blank clears the override, every line is
		 * trimmed and an empty line is dropped, so a trailing newline is not
		 * an entry.
		 *
		 * @param {string} text - the staged text.
		 * @returns {{ kind: 'clear' } | { kind: 'set', value: string[] } | undefined} the parsed edit.
		 */
		function lineList(text) {
			if (text.trim() === '') return { kind: 'clear' }
			const items = text
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
			return { kind: 'set', value: items }
		}

		/**
		 * The form's field specs, in the order the card renders them.
		 *
		 * A spec is `{ field, format, parse }`; a custom `format`/`parse`
		 * replaces the primitive's, which is what the list and enum fields
		 * need because neither has a shipped factory.
		 *
		 * @returns {object[]} the specs for `SettingsFormModel`.
		 */
		function fieldSpecs() {
			return [
				{
					...primitives.settingsTextField('tools'),
					format: (value) => (Array.isArray(value) ? value.join('\n') : ''),
					parse: lineList,
				},
				{ ...primitives.settingsTextField('dialect') },
				{ ...primitives.settingsTextField('onUnsupported') },
				{ ...primitives.settingsTextField('onError') },
				{
					...primitives.settingsTextField('auditPath'),
				},
				{
					...primitives.settingsNumberField('maxCommandLength'),
					parse: boundedInt(MIN_COMMAND_LENGTH, MAX_COMMAND_LENGTH),
				},
				{
					...primitives.settingsTextField('allowPatterns'),
					format: (value) => (Array.isArray(value) ? value.join('\n') : ''),
					parse: lineList,
				},
				{
					...primitives.settingsTextField('askPatterns'),
					format: (value) => (Array.isArray(value) ? value.join('\n') : ''),
					parse: lineList,
				},
				{
					...primitives.settingsTextField('denyPatterns'),
					format: (value) => (Array.isArray(value) ? value.join('\n') : ''),
					parse: lineList,
				},
				{
					...primitives.settingsTextField('disabledRules'),
					format: (value) => (Array.isArray(value) ? value.join('\n') : ''),
					parse: lineList,
				},
				// `global`, `managePreset` and `audit` are booleans: they ride the
				// form as text fields only because `SettingsFormModel` needs a spec
				// to stage them, and each switch reads its position from the scope
				// snapshot instead.
				// The parse is what makes the save land. A text field's default
				// parse hands the staged text through as a string, so
				// `edit('managePreset', 'false')` would stage the *string* 'false'.
				// The Host then refuses it twice over: `z.boolean()` rejects a
				// string, and the config editor's own equality check compares the
				// composed row against what was staged and finds 'false' !== false.
				// `booleanText` turns the text back into a real boolean, which is
				// the only shape the schema accepts.
				{ ...primitives.settingsTextField('global'), parse: booleanText },
				{ ...primitives.settingsTextField('managePreset'), parse: booleanText },
				{ ...primitives.settingsTextField('audit'), parse: booleanText },
			]
		}
		//#endregion

		//#region styles
		/**
		 * Card-local styles.
		 *
		 * Every `--dsw-*` name below is one the host's own stylesheet already
		 * references, verified against
		 * `dsh-web-frontend/dist/assets/index-CSAdOBx6.css`; a name invented
		 * here is silently dropped by the browser, which is how an earlier
		 * version of this card ended up with a white textarea in dark mode.
		 * `tests/client-card.test.js` keeps that list honest.
		 *
		 * The values mirror the host's own settings field (CSS module
		 * `_181ew_`): one field is a block with `gap:6px` inside and
		 * `padding:12px 0` outside, adjacent fields separated by a `.5px`
		 * line, and the input on `--dsw-alias-bg-layer-3` with a
		 * `--dsw-alias-border-l4` border. Mirroring rather than inventing is
		 * what makes the card follow the theme.
		 *
		 * The host's hashed class names are deliberately not referenced: they
		 * change with every host build.
		 */
		const css = [
			// One field: the block the host's `_field` rule describes.
			'.dshRuleGuardField{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
			'.dshRuleGuardField+.dshRuleGuardField{border-top:.5px solid var(--dsw-alias-border-l2)}',
			// The label row: label left, "overridden / reset" badges right.
			'.dshRuleGuardHead{display:flex;align-items:center;gap:8px}',
			'.dshRuleGuardLabel{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
			'.dshRuleGuardBadges{display:inline-flex;align-items:center;gap:8px}',
			'.dshRuleGuardReset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}',
			'@media(hover:hover){.dshRuleGuardReset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}}',
			'.dshRuleGuardReset:disabled{cursor:default}',
			// The list input: the host's `_input` rule, with a textarea's
			// vertical resize and a single-line height floor.
			'.dshRuleGuardList{width:100%;min-height:34px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);resize:vertical}',
			'.dshRuleGuardList:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.dshRuleGuardList[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}',
			'.dshRuleGuardList:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
			// The message under a field: hint while valid, invalid while not.
			'.dshRuleGuardHint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.dshRuleGuardInvalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}',
			// The pattern group's title and lead-in, as a lead not a heading.
			'.dshRuleGuardLead{margin:0;padding:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
			// A fold button: the host's outline button at its default size, with
			// this card's own text metrics. Scoped as a descendant of the field
			// block so it beats the host's single-class button rules whatever
			// order the two stylesheets land in — a bare `.dshRuleGuardFold`
			// would be at the same specificity as the host's and depend on
			// document order. The host's `sm` (12px on a 28px row) is what made
			// the folds read as smaller, different controls; the default row is
			// 36px, so only the text and the horizontal padding need restating.
			// `padding:0 12px` matches the host's own `_input`, so the label
			// lines up with the text below it. No `margin-top`: the field
			// wrapper's `padding:12px 0` already separates it, and the
			// `.5px` rule above marks the seam.
			'.dshRuleGuardField .dshRuleGuardFold{justify-content:space-between;align-items:center;width:100%;padding:0 12px;font-size:13px;line-height:1.5;display:flex}',
			'.dshRuleGuardChevron{transition:transform .15s}',
			'.dshRuleGuardChevronOpen{transform:rotate(180deg)}',
			// One rule row inside the rules group: label left, switch right, no
			// separator — the rules read as one list under one group title.
			'.dshRuleGuardRuleRow{justify-content:space-between;align-items:center;gap:16px;padding:6px 0;display:flex}',
			'.dshRuleGuardRuleLabel{color:var(--dsw-alias-label-primary);flex:1;min-width:0;font-size:13px;line-height:1.5}',
			'.dshRuleGuardGroupTitle{color:var(--dsw-alias-label-secondary);margin:12px 0 0;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}',
		].join('')
		const tagId = '@lliangworld/dsh-rule-guard/RuleGuardCard.css'
		//#endregion

		//#region controller
		/** Settings namespace this card edits: the plugin's own row. */
		const NS = 'rule-guard'
		/** Row-configuration key: the bundle package name and the row its patch declares. */
		const ROW_CONFIG_KEY = '@lliangworld/dsh-rule-guard#rule-guard'
		/**
		 * Every Config field the card renders, in the order the Host schema
		 * declares them. The card's field list must match the schema: a field
		 * added to `Config` and forgotten here is silently unconfigurable, so
		 * `tests/client-card.test.js` asserts the two agree.
		 */
		const FIELDS = [
			'global',
			'managePreset',
			'tools',
			'dialect',
			'onUnsupported',
			'onError',
			'maxCommandLength',
			'audit',
			'auditPath',
			'disabledRules',
			'allowPatterns',
			'askPatterns',
			'denyPatterns',
		]

		/**
		 * The built-in rules, grouped the way the dialects group them.
		 *
		 * This table is the browser half's own copy: a client factory resolves
		 * only the baseline modules, so it cannot import `lib/catalog.js` for
		 * the Host's titles. The ids must therefore stay in step with
		 * `CATALOG`, and `tests/client-card.test.js` asserts that they do —
		 * including that every id here is a real rule, not one of the six
		 * derived verdicts (`no-static-verdict`, `command-too-long`,
		 * `user-*-pattern`, `analysis-error`) that are results rather than
		 * rules and so have no switch.
		 *
		 * @returns {{ name: string, rules: { id: string, label: string }[] }[]} the groups.
		 */
		function ruleGroups() {
			return [
				{
					name: 'POSIX',
					rules: [
						{ id: 'remove-critical-path', label: 'Recursive or batch removal' },
						{ id: 'find-delete', label: 'find delete action' },
						{ id: 'system-storage', label: 'Disk or mount operation' },
						{ id: 'rsync-delete', label: 'rsync delete sync' },
					],
				},
				{
					name: 'git',
					rules: [
						{ id: 'git-reset-hard', label: 'git history reset' },
						{ id: 'git-clean-force', label: 'git force clean' },
						{ id: 'git-push-force', label: 'git force push' },
						{ id: 'git-discard-tree', label: 'git discard changes' },
						{ id: 'git-stash-clear', label: 'git stash clear' },
						{ id: 'git-worktree-force-remove', label: 'git force worktree remove' },
					],
				},
				{
					name: 'CMD',
					rules: [
						{ id: 'cmd-remove-tree', label: 'CMD recursive directory removal' },
						{ id: 'cmd-delete-files', label: 'CMD batch file deletion' },
						{ id: 'robocopy-delete', label: 'Robocopy mirror deletion' },
					],
				},
				{
					name: 'PowerShell',
					rules: [
						{ id: 'pwsh-remove-recursive', label: 'PowerShell recursive removal' },
						{ id: 'pwsh-dotnet-delete', label: '.NET direct deletion' },
						{ id: 'pwsh-dynamic-exec', label: 'Dynamic string execution' },
						{ id: 'pwsh-download-exec', label: 'Download and execute' },
						{ id: 'pwsh-credential-read', label: 'Credential file read' },
						{ id: 'pwsh-credential-write', label: 'Credential file write' },
						{ id: 'pwsh-system-config', label: 'System or permission configuration' },
						{ id: 'pwsh-clear-recyclebin', label: 'Recycle bin cleared' },
					],
				},
			]
		}

		/**
		 * The Rule guard settings card's staged form over the plugin's
		 * settings namespace.
		 *
		 * The policy is spread over twelve fields, so the card keeps the
		 * always-relevant ones open and folds the two groups a deployment sets
		 * once — the built-in rules and the custom patterns — behind buttons.
		 * The fold state lives here rather than in a React hook because a
		 * factory only guarantees `react/jsx-runtime`.
		 */
		class RuleGuardCardController {
			/** @param {object} scope - the bound settings scope for the plugin's namespace. */
			constructor(scope) {
				this.scope = scope
				this.form = new primitives.SettingsFormModel(scope, fieldSpecs())
				this.store = store.createSnapshotStore(this.projection())
				const publish = () => this.store.set(this.projection())
				this.unsubscribe = [
					this.form.bind(() => this.projection()).subscribe(publish),
					scope.subscribe(publish),
				]
				this.rulesOpen = false
				this.patternsOpen = false
			}

			/** The staged form state the card renders. */
			projection() {
				const state = {
					...this.form.shell(),
					defaults: scopeBase(this.scope),
					// `globalOn`, `manageOn` and `auditOn` rather than the field
					// names: the loop below fills `state[field]` for every Config
					// field, and a boolean cannot share a key with the form's
					// `{text, overridden, invalid}` object for the same field.
					globalOn: this.switchPosition('global', false),
					manageOn: this.switchPosition('managePreset', true),
					auditOn: this.switchPosition('audit', true),
					rulesOpen: this.rulesOpen,
					patternsOpen: this.patternsOpen,
				}
				for (const field of FIELDS) state[field] = this.form.field(field)
				return state
			}

			/**
			 * One boolean field's switch position: the staged draft while it
			 * differs from the config, otherwise the value the section serves.
			 * It is read from the scope rather than the form's text field,
			 * because a boolean cannot be echoed back through one.
			 *
			 * @param {string} field - the config field the switch drives.
			 * @param {boolean} fallback - the value the field defaults to when the section has none.
			 * @returns {boolean} the switch position.
			 */
			switchPosition(field, fallback) {
				const effective = scopeValue(this.scope, field) ?? fallback
				const draft = this.drafts?.[field]
				return draft === undefined || draft === effective ? effective : draft
			}

			/**
			 * Stage one switch position. A position equal to the inherited value
			 * clears the override so the schema default keeps applying; anything
			 * else stages the edit the form saves with the rest.
			 *
			 * @param {string} field - the config field the switch drives.
			 * @param {boolean} checked - the switch's new position.
			 * @param {boolean} fallback - the value the field defaults to.
			 */
			setSwitch(field, checked, fallback) {
				const base = scopeBase(this.scope)?.[field]
				if ((base ?? fallback) === checked) this.form.actions().resetField(field)
				else this.form.actions().edit(field, checked ? 'true' : 'false')
				this.drafts = { ...this.drafts, [field]: checked }
				this.store.set(this.projection())
			}

			/** Open or close the built-in rules group. */
			toggleRules() {
				this.rulesOpen = !this.rulesOpen
				this.store.set(this.projection())
			}

			/** Open or close the custom patterns group. */
			togglePatterns() {
				this.patternsOpen = !this.patternsOpen
				this.store.set(this.projection())
			}

			/**
			 * Stage a change to the disabled-rule list.
			 *
			 * A switch that turns a rule off adds its id; one that turns it back
			 * on removes it. The staged text is the whole list, so switching
			 * several rules in one visit saves together.
			 *
			 * @param {string} ruleId - the rule the switch belongs to.
			 * @param {boolean} wasEnabled - the switch position before this change.
			 */
			toggleRule(ruleId, wasEnabled) {
				const current = disabledRulesOf(this.projection())
				const next = wasEnabled
					? [...current, ruleId]
					: current.filter((id) => id !== ruleId)
				this.form.actions().edit('disabledRules', next.join('\n'))
			}

			/** Build the face the slot registration injects. */
			inject() {
				return {
					hooks: { ruleGuardCard: this.store },
					...this.form.actions(),
					setGlobal: (checked) => this.setSwitch('global', checked, false),
					setManagePreset: (checked) => this.setSwitch('managePreset', checked, true),
					setAudit: (checked) => this.setSwitch('audit', checked, true),
					toggleRule: (ruleId, wasEnabled) => this.toggleRule(ruleId, wasEnabled),
					toggleRules: () => this.toggleRules(),
					togglePatterns: () => this.togglePatterns(),
				}
			}

			/** Save the staged form; a refused write stops and keeps the draft. */
			async save() {
				const state = this.projection()
				if (!state.available || state.invalid || state.saving) return
				await this.form.save()
			}

			/** Release configuration subscriptions. */
			dispose() {
				for (const off of this.unsubscribe) off()
				this.form.dispose()
			}
		}

		/**
		 * One snapshot's effective config values, or an empty object.
		 *
		 * @param {object} scope - a settings scope.
		 * @returns {Record<string, unknown>} the effective values.
		 */
		function scopeValue(scope, field) {
			return scope.getSnapshot().value?.[field]
		}

		/**
		 * One snapshot's inherited config values, or an empty object.
		 *
		 * @param {object} scope - a settings scope.
		 * @returns {Record<string, unknown>} the inherited values.
		 */
		function scopeBase(scope) {
			return scope.getSnapshot().base ?? {}
		}

		/** The form frame's copy, read from this card's dictionary. */
		function formLabels(t) {
			return {
				unavailable: t('unavailable'),
				readOnly: t('readOnly'),
				saveFailed: t('saveFailed'),
				save: t('save'),
				saving: t('saving'),
			}
		}
		//#endregion

		//#region component
		/**
		 * Render one list field as a `.dshRuleGuardField` block: the label row,
		 * the textarea, and one message that is the hint while the text is
		 * valid and the invalid text while it is not.
		 *
		 * The primitives ship no list field, so the textarea is hand-drawn
		 * here. `state[field].text` already carries the right string — the
		 * spec's custom `format` produced it — so the control is controlled
		 * exactly like `SettingsValueField`.
		 *
		 * @param {object} props - the card's props, whose actions write the field.
		 * @param {(key: string, vars?: Record<string, unknown>) => string} t - the card's locale reader.
		 * @param {object} state - the card's current snapshot.
		 * @param {{ name: string, invalid: string, rows: number }} field - the field descriptor.
		 * @param {boolean} disabled - whether the form refuses edits right now.
		 * @returns the field block.
		 */
		function listField(props, t, state, field, disabled) {
			const entry = state[field.name]
			const defaultCount = entry.overridden ? undefined : countOf(state.defaults?.[field.name])
			const hint =
				defaultCount === undefined
					? t(`${field.name}Hint`)
					: `${t(`${field.name}Hint`)} ${t('listDefault', { count: defaultCount })}`
			return jsx.jsxs('div', {
				className: 'dshRuleGuardField',
				children: [
					jsx.jsxs('div', {
						className: 'dshRuleGuardHead',
						children: [
							jsx.jsx('label', {
								className: 'dshRuleGuardLabel',
								htmlFor: `plugin-config-rule-guard-${field.name}`,
								children: t(field.name),
							}),
							entry.overridden === true
								? jsx.jsxs('span', {
										className: 'dshRuleGuardBadges',
										children: [
											jsx.jsx('span', { children: t('overridden') }),
											jsx.jsx('button', {
												type: 'button',
												className: 'dshRuleGuardReset',
												disabled,
												onClick: () => props.resetField(field.name),
												children: t('reset'),
											}),
										],
									})
								: null,
						],
					}),
					jsx.jsx('textarea', {
						id: `plugin-config-rule-guard-${field.name}`,
						className: 'dshRuleGuardList',
						rows: field.rows,
						value: entry.text,
						disabled,
						spellCheck: false,
						'aria-invalid': entry.invalid === true ? true : undefined,
						'aria-describedby': `plugin-config-rule-guard-${field.name}-hint`,
						onChange: (event) => props.edit(field.name, event.target.value),
					}),
					entry.invalid === true
						? jsx.jsx('p', {
								id: `plugin-config-rule-guard-${field.name}-hint`,
								className: 'dshRuleGuardInvalid',
								role: 'alert',
								children: t(field.invalid),
							})
						: jsx.jsx('p', {
								id: `plugin-config-rule-guard-${field.name}-hint`,
								className: 'dshRuleGuardHint',
								children: hint,
							}),
				],
			})
		}

		/**
		 * How many entries a default list holds, for its hint.
		 *
		 * @param {unknown} value - the inherited value.
		 * @returns {number | undefined} the entry count, or undefined without a default.
		 */
		function countOf(value) {
			return Array.isArray(value) ? value.length : undefined
		}

		/**
		 * Render one enum field as a `.dshRuleGuardField` block: the label row
		 * with the segmented control beside the label, and the hint under both.
		 *
		 * @param {object} props - the card's props, whose actions write the field.
		 * @param {(key: string, vars?: Record<string, unknown>) => string} t - the card's locale reader.
		 * @param {object} state - the card's current snapshot.
		 * @param {{ name: string, options: { value: string, label: string }[] }} field - the field descriptor.
		 * @param {boolean} disabled - whether the form refuses edits right now.
		 * @returns the field block.
		 */
		function enumField(props, t, state, field, disabled) {
			const entry = state[field.name]
			return jsx.jsxs('div', {
				className: 'dshRuleGuardField',
				children: [
					jsx.jsxs('div', {
						className: 'dshRuleGuardHead',
						children: [
							jsx.jsx('span', { className: 'dshRuleGuardLabel', children: t(field.name) }),
							jsx.jsx(primitives.SegmentedControl, {
								id: `plugin-config-rule-guard-${field.name}`,
								label: t(field.name),
								value: entry.text,
								options: field.options,
								disabled,
								onChange: (value) => props.edit(field.name, value),
							}),
						],
					}),
					jsx.jsx('p', {
						id: `plugin-config-rule-guard-${field.name}-hint`,
						className: 'dshRuleGuardHint',
						children: t(`${field.name}Hint`),
					}),
				],
			})
		}

		/**
		 * Render one boolean field as a `.dshRuleGuardField` block: the label and
		 * the switch in the head row, and the hint under them.
		 *
		 * @param {object} props - the card's props, whose actions write the field.
		 * @param {(key: string, vars?: Record<string, unknown>) => string} t - the card's locale reader.
		 * @param {object} state - the card's current snapshot.
		 * @param {{ name: string, position: string, hint: string }} field - the field descriptor.
		 * @param {boolean} disabled - whether the form refuses edits right now.
		 * @returns the field block.
		 */
		function switchField(props, t, state, field, disabled) {
			return jsx.jsxs('div', {
				className: 'dshRuleGuardField',
				children: [
					jsx.jsxs('div', {
						className: 'dshRuleGuardHead',
						children: [
							jsx.jsx('span', { className: 'dshRuleGuardLabel', children: t(field.name) }),
							jsx.jsx(primitives.Switch, {
								checked: state[field.position],
								label: t(field.name),
								disabled,
								onChange: (checked) => props[field.set](checked),
							}),
						],
					}),
					jsx.jsx('p', { className: 'dshRuleGuardHint', children: t(field.hint) }),
				],
			})
		}

		/**
		 * Render one fold button: the group's name on the left, a chevron that
		 * points down while the group is closed.
		 *
		 * The host's default size, not `sm`: the small button is 12px text on a
		 * 28px row, which reads as a different and smaller control than the
		 * 13px labels and 34px inputs beside it — and a fold is a primary
		 * click target. `dshRuleGuardFold` then restores this card's own text
		 * metrics, so the button matches its neighbours without asking the
		 * host for a size that does not exist. The shipped keenable card folds
		 * with `sm`; its fields are denser, so the smaller row suits it there.
		 *
		 * @param {object} props - the card's props, whose action toggles the group.
		 * @param {(key: string) => string} t - the card's locale reader.
		 * @param {{ label: string, action: string, open: boolean, id: string }} group - the group descriptor.
		 * @param {boolean} disabled - whether the form refuses edits right now.
		 * @returns the button.
		 */
		function foldButton(props, t, group, disabled) {
			return jsx.jsx('div', {
				className: 'dshRuleGuardField',
				children: jsx.jsxs(primitives.Button, {
					variant: 'outline',
					className: 'dshRuleGuardFold',
					disabled,
					'aria-expanded': group.open,
					'aria-controls': group.id,
					onClick: () => props[group.action](),
					children: [
						jsx.jsx('span', { children: t(group.label) }),
						jsx.jsx(primitives.IconChevronDownOutlineRegular, {
							size: 20,
							'aria-hidden': 'true',
							className: `dshRuleGuardChevron${group.open ? ' dshRuleGuardChevronOpen' : ''}`,
						}),
					],
				}),
			})
		}

		/**
		 * Render one built-in rule row: its name and the switch that decides
		 * whether a match asks.
		 *
		 * The switch reads the staged `disabledRules` list rather than a field
		 * of its own: twenty-one switches would mean twenty-one config fields,
		 * and the list is what the Host reads.
		 *
		 * @param {object} props - the card's props, whose action stages the list.
		 * @param {(key: string) => string} t - the card's locale reader.
		 * @param {object} state - the card's current snapshot.
		 * @param {{ id: string, label: string }} rule - the rule descriptor.
		 * @param {boolean} disabled - whether the form refuses edits right now.
		 * @returns the rule row.
		 */
		function ruleRow(props, t, state, rule, disabled) {
			const enabled = !disabledRulesOf(state).includes(rule.id)
			return jsx.jsxs('div', {
				className: 'dshRuleGuardRuleRow',
				children: [
					jsx.jsx('span', { className: 'dshRuleGuardRuleLabel', children: rule.label }),
					jsx.jsx(primitives.Switch, {
						checked: enabled,
						label: rule.label,
						disabled,
						onChange: () => props.toggleRule(rule.id, enabled),
					}),
				],
			})
		}

		/**
		 * The staged or effective list of disabled rule ids.
		 *
		 * While nothing is staged the field's text already carries the effective
		 * list, because the spec's custom `format` produced it; once a switch
		 * moves it carries the staged one.
		 *
		 * @param {object} state - the card's current snapshot.
		 * @returns {string[]} the rule ids switched off.
		 */
		function disabledRulesOf(state) {
			const entry = state.disabledRules
			if (entry === undefined) return []
			return entry.text
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
		}

		/**
		 * Render the card's one-liner or its settings form, as the Plugins
		 * page asks.
		 *
		 * @param {object} props - the view asked for, locale copy, the form snapshot, and its actions.
		 * @returns the one-liner, or the form.
		 */
		function RuleGuardCard(props) {
			const { t } = props
			const state = props.useRuleGuardCard((snapshot) => snapshot)
			if (props.view === 'summary') return t('description')
			const disabled = !state.writable || state.saving
			return jsx.jsxs(primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					switchField(props, t, state, {
						name: 'global',
						position: 'globalOn',
						hint: 'globalHint',
						set: 'setGlobal',
					}, disabled),
					switchField(props, t, state, {
						name: 'managePreset',
						position: 'manageOn',
						hint: 'managePresetHint',
						set: 'setManagePreset',
					}, disabled),
					listField(props, t, state, { name: 'tools', invalid: 'invalidList', rows: 4 }, disabled),
					enumField(props, t, state, {
						name: 'dialect',
						options: [
							{ value: 'auto', label: t('dialectAuto') },
							{ value: 'posix', label: t('dialectPosix') },
							{ value: 'cmd', label: t('dialectCmd') },
							{ value: 'powershell', label: t('dialectPowershell') },
						],
					}, disabled),
					enumField(props, t, state, {
						name: 'onUnsupported',
						options: [
							{ value: 'allow', label: t('optionAllow') },
							{ value: 'ask', label: t('optionAsk') },
						],
					}, disabled),
					enumField(props, t, state, {
						name: 'onError',
						options: [
							{ value: 'allow', label: t('optionAllow') },
							{ value: 'ask', label: t('optionAsk') },
						],
					}, disabled),
					jsx.jsx(primitives.SettingsValueField, {
						id: 'plugin-config-rule-guard-maxCommandLength',
						label: t('maxCommandLength'),
						hint: `${t('maxCommandLengthHint')} ${
							state.defaults?.maxCommandLength === undefined
								? t('noDefault')
								: t('defaultValue', { value: String(state.defaults.maxCommandLength) })
						}`,
						overriddenLabel: t('overridden'),
						resetLabel: t('reset'),
						invalidLabel: t('invalidLength'),
						numeric: true,
						disabled,
						...state.maxCommandLength,
						text: state.maxCommandLength.overridden
							? state.maxCommandLength.text
							: state.defaults?.maxCommandLength === undefined
								? ''
								: String(state.defaults.maxCommandLength),
						onEdit: (text) => props.edit('maxCommandLength', text),
						onReset: () => props.resetField('maxCommandLength'),
					}),
					jsx.jsx(primitives.SettingsValueField, {
						id: 'plugin-config-rule-guard-auditPath',
						label: t('auditPath'),
						hint: t('auditPathHint'),
						overriddenLabel: t('overridden'),
						resetLabel: t('reset'),
						invalidLabel: t('invalidText'),
						disabled,
						...state.auditPath,
						onEdit: (text) => props.edit('auditPath', text),
						onReset: () => props.resetField('auditPath'),
					}),
					switchField(props, t, state, {
						name: 'audit',
						position: 'auditOn',
						hint: 'auditHint',
						set: 'setAudit',
					}, disabled),
					foldButton(props, t, {
						label: 'rules',
						action: 'toggleRules',
						open: state.rulesOpen,
						id: 'plugin-config-rule-guard-rules',
					}, disabled),
					state.rulesOpen
						? jsx.jsxs('div', {
								id: 'plugin-config-rule-guard-rules',
								children: [
									jsx.jsx('p', { className: 'dshRuleGuardLead', children: t('rulesHint') }),
									...ruleGroups().map((group) =>
										jsx.jsxs('div', {
											children: [
												jsx.jsx('p', { className: 'dshRuleGuardGroupTitle', children: group.name }),
												...group.rules.map((rule) => ruleRow(props, t, state, rule, disabled)),
											],
										}, group.name),
									),
								],
							})
						: null,
					foldButton(props, t, {
						label: 'patterns',
						action: 'togglePatterns',
						open: state.patternsOpen,
						id: 'plugin-config-rule-guard-patterns',
					}, disabled),
					state.patternsOpen
						? jsx.jsxs('div', {
								id: 'plugin-config-rule-guard-patterns',
								children: [
									jsx.jsx('p', { className: 'dshRuleGuardLead', children: t('patternsHint') }),
									listField(props, t, state, { name: 'allowPatterns', invalid: 'invalidList', rows: 3 }, disabled),
									listField(props, t, state, { name: 'askPatterns', invalid: 'invalidList', rows: 3 }, disabled),
									listField(props, t, state, { name: 'denyPatterns', invalid: 'invalidList', rows: 3 }, disabled),
								],
							})
						: null,
				],
			})
		}
		//#endregion

		//#region apply
		/** Required services (cordis fiber inject). */
		const inject = ['slots', 'locale', 'configForms']

		/**
		 * Mount the Rule guard settings card while the Host serves its namespace.
		 *
		 * @param {object} ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(
				() => ctx.locale.register(NS, { zh, en }),
				'rule-guard: dictionaries',
			)
			ctx.effect(() => {
				if (
					typeof document === 'undefined' ||
					document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null
				) {
					return () => {}
				}
				const tag = document.createElement('style')
				tag.dataset.plugin = '@lliangworld/dsh-rule-guard'
				tag.dataset.pluginCss = tagId
				tag.textContent = css
				document.head.appendChild(tag)
				return () => {
					tag.remove()
				}
			}, 'rule-guard: card styles')
			const card = new RuleGuardCardController(ctx.configForms.get(NS))
			ctx.effect(() => () => {
				card.dispose()
			}, 'rule-guard: form subscription')
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () =>
						ctx.slots.inject('plugins.row.config', () =>
							ctx.slots.register(
								{
									name: 'plugins.row.config',
									key: ROW_CONFIG_KEY,
									locale: NS,
									order: 50,
									inject: () => card.inject(),
								},
								RuleGuardCard,
							),
						),
					),
				'rule-guard: page',
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
