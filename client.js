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
				// `audit` is a boolean: it rides the form as a text field only
				// because `SettingsFormModel` needs a spec to stage it, and the
				// switch reads its position from the scope snapshot instead.
				{ ...primitives.settingsTextField('audit') },
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
		].join('')
		const tagId = '@lliangworld/dsh-rule-guard/RuleGuardCard.css'
		//#endregion

		//#region controller
		/** Settings namespace this card edits: the plugin's own row. */
		const NS = 'rule-guard'
		/** Row-configuration key: the bundle package name and the row its patch declares. */
		const ROW_CONFIG_KEY = '@lliangworld/dsh-rule-guard#rule-guard'
		/** Field the switch stages its boolean position under. */
		const AUDIT_FIELD = 'audit'
		/**
		 * Every Config field the card renders, in the order the Host schema
		 * declares them. The card's field list must match the schema: a field
		 * added to `Config` and forgotten here is silently unconfigurable, so
		 * `tests/client-card.test.js` asserts the two agree.
		 */
		const FIELDS = [
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
		]

		/**
		 * The Rule guard settings card's staged form over the plugin's
		 * settings namespace.
		 *
		 * Ten fields, all rendered plainly rather than folded into an advanced
		 * group: this card exists so the guard's policy is visible at a glance,
		 * and the fields are the policy. The one structural split is the
		 * pattern group at the end, which shares one explanatory lead-in.
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
			}

			/** The staged form state the card renders. */
			projection() {
				const state = {
					...this.form.shell(),
					defaults: scopeBase(this.scope),
					// `auditOn` rather than `audit`: the field loop below fills
					// `state[field]` for every Config field, and a boolean
					// cannot share a key with the form's `{text, overridden,
					// invalid}` object for the same field.
					auditOn: this.auditPosition(),
				}
				for (const field of FIELDS) state[field] = this.form.field(field)
				return state
			}

			/**
			 * The audit switch position: the staged draft while it differs from
			 * the config, otherwise the value the section serves. It is read
			 * from the scope rather than the form's text field, because a
			 * boolean cannot be echoed back through one.
			 *
			 * @returns {boolean} the switch position.
			 */
			auditPosition() {
				const effective = scopeValue(this.scope, AUDIT_FIELD) ?? true
				return this.auditDraft === undefined || this.auditDraft === effective
					? effective
					: this.auditDraft
			}

			/**
			 * Stage one switch position. A position equal to the inherited value
			 * clears the override so the schema default keeps applying;
			 * anything else stages the edit the form saves with the rest.
			 *
			 * @param {boolean} checked - the switch's new position.
			 */
			setAudit(checked) {
				const base = scopeBase(this.scope)?.[AUDIT_FIELD]
				if ((base ?? true) === checked) this.form.actions().resetField(AUDIT_FIELD)
				else this.form.actions().edit(AUDIT_FIELD, checked ? 'true' : 'false')
				this.auditDraft = checked
				this.store.set(this.projection())
			}

			/** Build the face the slot registration injects. */
			inject() {
				return {
					hooks: { ruleGuardCard: this.store },
					...this.form.actions(),
					setAudit: (checked) => this.setAudit(checked),
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
		 * Render the audit switch as a `.dshRuleGuardField` block: the label and
		 * the switch in the head row, and the hint under them.
		 *
		 * @param {object} props - the card's props, whose actions write the field.
		 * @param {(key: string, vars?: Record<string, unknown>) => string} t - the card's locale reader.
		 * @param {object} state - the card's current snapshot.
		 * @param {boolean} disabled - whether the form refuses edits right now.
		 * @returns the field block.
		 */
		function auditField(props, t, state, disabled) {
			return jsx.jsxs('div', {
				className: 'dshRuleGuardField',
				children: [
					jsx.jsxs('div', {
						className: 'dshRuleGuardHead',
						children: [
							jsx.jsx('span', { className: 'dshRuleGuardLabel', children: t('audit') }),
							jsx.jsx(primitives.Switch, {
								checked: state.auditOn,
								label: t('audit'),
								disabled,
								onChange: (checked) => props.setAudit(checked),
							}),
						],
					}),
					jsx.jsx('p', { className: 'dshRuleGuardHint', children: t('auditHint') }),
				],
			})
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
					auditField(props, t, state, disabled),
					jsx.jsxs('div', {
						className: 'dshRuleGuardField',
						children: [
							jsx.jsx('p', { className: 'dshRuleGuardLead', children: t('patterns') }),
							jsx.jsx('p', { className: 'dshRuleGuardLead', children: t('patternsHint') }),
							listField(props, t, state, { name: 'allowPatterns', invalid: 'invalidList', rows: 3 }, disabled),
							listField(props, t, state, { name: 'askPatterns', invalid: 'invalidList', rows: 3 }, disabled),
							listField(props, t, state, { name: 'denyPatterns', invalid: 'invalidList', rows: 3 }, disabled),
						],
					}),
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
