/**
 * `dsh-rule-guard`: a pure-local command rule guard for DeepSeek Harness.
 *
 * The plugin listens on the `tools/pre-execute` waterfall. A call whose
 * command matches a local rule is answered with `ask`, which the host routes
 * to the default approval panel — no countdown, so the call waits for as long
 * as the user needs. Everything else falls through to the next listener, so
 * an ordinary command costs nothing.
 *
 * Design decisions this file implements:
 * - **No cache.** A decision depends on the whole command text; caching would
 *   open a window in which a changed dangerous argument is not re-examined.
 * - **Allow unless a rule matches.** An unjudgeable command (expansions,
 *   script files, compound statements, over-long input) and an internal
 *   analysis error are both released, because a guard that prompts on
 *   ordinary variable-bearing commands is switched off in practice. A
 *   confident rule match always asks. `onUnsupported`/`onError` can restore
 *   the fail-closed stance, and the README states what each choice costs.
 * - **ask, never allow.** The host owns the answer: `never` policy, a missing
 *   answerer, an unloading plugin and an agent-less call each degrade to a
 *   denial with a distinct reason. This plugin never converts an ask into an
 *   allow.
 * - **No terminal denials from this plugin.** A hard rejection is expressed
 *   through `denyPatterns`; the monotonic `tools.guard` seam is left free for
 *   a future bottom layer.
 *
 * Exported symbols only: a bundle whose `index.js` also carries a default
 * export is read as the service-class form, and its `apply` is never called.
 *
 * @module dsh-rule-guard
 */

import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { analyzeCommand, dialectForTool } from './lib/analyze.js'
import { AuditLog, expandPath } from './lib/audit.js'
import { auditReason, displayReason } from './lib/catalog.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rule-guard'

/** The seams this plugin needs: the approval service, the sandbox policy, and the tools service. */
export const inject = ['approval', 'sandboxPolicy', 'tools']

/** Structured error identity for a `denyPatterns` denial. */
const DENIED_ERROR_NAME = 'RuleGuardDeniedError'
const DENIED_ERROR_CODE = 'RULE_GUARD_DENIED'

/** The tool names this plugin takes over by default. */
const DEFAULT_TOOLS = ['pwsh', 'bash', 'terminal', 'pwsh_persistent', 'bash_persistent', 'ops_bash']

/**
 * Plugin config. Every field is volatile so a settings change reaches the next
 * call without restarting the plugin, and every field carries a description
 * because the Plugins page and `--dump-config` show it verbatim.
 */
export const Config = z.object({
	global: z
		.boolean()
		.default(false)
		.volatile()
		.description('Whether the guard applies everywhere. Off (the default) limits it to sessions whose effective permission is full sandbox plus ask — the guarded-full preset — so an existing preset behaves exactly as before. On guards every session regardless of preset, sandbox or approval policy.'),
	tools: z
		.array(z.string())
		.default(DEFAULT_TOOLS)
		.volatile()
		.description('Tool names this guard takes over. A call to any other tool is never intercepted.'),
	dialect: z
		.union(['auto', 'posix', 'cmd', 'powershell'])
		.default('auto')
		.volatile()
		.description('How a command is parsed: auto infers the dialect from the tool name (pwsh/powershell → powershell, cmd → cmd, bash/terminal/sh → posix), or a fixed dialect is forced.'),
	onUnsupported: z
		.union(['ask', 'allow'])
		.default('allow')
		.volatile()
		.description('What to do when the command cannot be judged statically (expansions, script files, compound statements, over-long input): allow (the default, so ordinary variable-bearing commands are never interrupted) or ask.'),
	onError: z
		.union(['ask', 'allow'])
		.default('allow')
		.volatile()
		.description('What to do when the rule engine itself throws: allow (the default) or ask.'),
	allowPatterns: z
		.array(z.string())
		.default([])
		.volatile()
		.description('Regular expressions matched against the whole command text. A match releases the call without asking; use it to exempt a recurring false positive.'),
	askPatterns: z
		.array(z.string())
		.default([])
		.volatile()
		.description('Regular expressions matched against the whole command text. A match asks the user, even when no built-in rule fired.'),
	denyPatterns: z
		.array(z.string())
		.default([])
		.volatile()
		.description('Regular expressions matched against the whole command text. A match denies the call outright, without asking.'),
	maxCommandLength: z
		.number()
		.step(1)
		.min(1000)
		.max(100000)
		.default(10000)
		.volatile()
		.description('Longest command text analyzed. A longer command is treated as unjudgeable and follows onUnsupported.'),
	audit: z
		.boolean()
		.default(true)
		.volatile()
		.description('Record every non-allow decision (ask, deny, unjudgeable, internal error) as one JSONL line.'),
	auditPath: z
		.string()
		.default('')
		.volatile()
		.description('Audit file. Empty uses $DSH_HOME/rule-guard-audit.jsonl; $DSH_HOME and ${DSH_HOME} are expanded.'),
	disabledRules: z
		.array(z.string())
		.default([])
		.volatile()
		.description('Built-in rule ids to switch off: a command matching one of them is released without asking, and the audit records that the rule was disabled. Empty enables every rule. Adding a rule to the engine enables it here automatically.'),
})

/**
 * The live config, read fresh on every call so volatile updates apply.
 *
 * Cordis hands each config field to `apply` as a reference whose `.get()`
 * returns the current value, so nothing is snapshotted here.
 *
 * @param {ReturnType<typeof Config['simplify']>} config - the live config.
 * @returns {object} the resolved settings for one decision.
 */
function settingsOf(config) {
	const tools = config.tools.get() ?? DEFAULT_TOOLS
	const dialect = config.dialect.get() ?? 'auto'
	return {
		global: config.global.get() ?? false,
		tools: new Set(Array.isArray(tools) ? tools.map(String) : DEFAULT_TOOLS),
		dialect,
		onUnsupported: config.onUnsupported.get() ?? 'allow',
		onError: config.onError.get() ?? 'allow',
		allowPatterns: config.allowPatterns.get() ?? [],
		askPatterns: config.askPatterns.get() ?? [],
		denyPatterns: config.denyPatterns.get() ?? [],
		maxCommandLength: config.maxCommandLength.get() ?? 10000,
		audit: config.audit.get() ?? true,
		auditPath: config.auditPath.get() ?? '',
		disabledRules: new Set(config.disabledRules.get() ?? []),
	}
}

/**
 * Whether the guard applies to one session.
 *
 * The guard is inert unless the effective permission asks the user. A preset
 * whose approval policy is `never` rejects an ask deterministically, so a
 * guard there could only ever produce a denial with no prompt; a preset with a
 * narrower sandbox already confines the call. By default the guard therefore
 * activates only where the two effective knobs read full sandbox plus ask,
 * which is exactly what the guarded-full preset sets.
 *
 * Both knobs are read the way `dsh-permission-presets` derives them: the
 * session's own override, else the service default. Matching the effective
 * knobs rather than the preset's name keeps the guard working when the preset
 * table does not name it — including a hand-tuned combination, which the
 * permission service reports as `custom`.
 *
 * A knob that cannot be read at all leaves the guard inert, which is the same
 * fail-open stance `onUnsupported` takes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {ReturnType<typeof settingsOf>} settings - the resolved settings.
 * @param {import('@deepseek-ai/dsh-session').Session} session - the session the call belongs to.
 * @returns {boolean} whether the guard evaluates this session.
 */
function guardActive(ctx, settings, session) {
	if (settings.global) return true
	const sandbox = ctx.sandboxPolicy?.overrideOf(session) ?? ctx.sandboxPolicy?.defaultMode
	const approval = ctx.approval?.overrideOf(session) ?? ctx.approval?.config?.policy ?? 'ask'
	return sandbox === 'danger-full-access' && approval === 'ask'
}

/** One string argument, or `undefined` when the shape is not a command. */
function commandArgument(args) {
	if (typeof args === 'string') return args
	if (args === null || typeof args !== 'object') return undefined
	const command = Reflect.get(args, 'command')
	return typeof command === 'string' ? command : undefined
}

/**
 * Register the guard.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {ReturnType<typeof Config['simplify']>} config - the live config.
 * @returns {void}
 */
export function apply(ctx, config) {
	// Aborting this controller settles every later call as cancelled rather
	// than asking: a prompt raised by a plugin that no longer exists could
	// never be answered.
	const lifecycle = new AbortController()
	// Asks this plugin has raised and not yet settled. Unload drains them so no
	// prompt outlives the listener that would answer it.
	const active = new Set()
	let accepting = true

	const audit = new AuditLog({
		path: config.audit.get() === false ? undefined : expandPath(config.auditPath.get() ?? '', resolveDshHome),
		onError: (message) => ctx.logger?.warn?.(message),
	})
	audit.ensureDirectory()

	/** Record one decision, honoring the live audit switch. */
	const record = (entry) => {
		if (config.audit.get() === false) return
		audit.write({ ts: new Date().toISOString(), ...entry })
	}

	ctx.effect(function* () {
		const stopListener = ctx.on(
			'tools/pre-execute',
			async (exec, next) => {
				const settings = settingsOf(config)
				if (!settings.tools.has(exec.name)) return next()
				const command = commandArgument(exec.arguments)
				if (command === undefined || command.trim().length === 0) return next()
				if (exec.agent === undefined) {
					// Without an agent there is no session to audit to and no UI
					// to route an ask through; the host degrades it to a denial.
					return next()
				}
				if (!accepting || lifecycle.signal.aborted) return { kind: 'cancel' }
				if (!guardActive(ctx, settings, exec.agent.session)) return next()

				// Registered before the first await, so a call that is unloading
				// right now is still drained rather than left floating.
				const settled = Promise.withResolvers()
				active.add(settled.promise)
				try {
					return await decide(ctx, exec, next, command, settings, record, lifecycle)
				} finally {
					active.delete(settled.promise)
					settled.resolve()
				}
			},
			// Appended, not prepended: this guard is the last gate, so a
			// policy-driven listener such as the Auto review layer, or any other
			// gate registered with `prepend`, decides first and its deny or ask
			// wins.
			{ prepend: false },
		)
		yield stopListener
		yield async () => {
			accepting = false
			lifecycle.abort(new Error('rule-guard listener disposed'))
			await Promise.allSettled([...active])
		}
	}, 'rule-guard lifecycle')
}

/**
 * One call's decision, with the audit record written for every non-allow path.
 *
 * Split out of the listener so the listener stays readable: it resolves the
 * settings and the session gate, then hands the command here.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the pending execution.
 * @param {() => Promise<import('@deepseek-ai/dsh-tools').PreToolDecision>} next - the next listener.
 * @param {string} command - the command under decision.
 * @param {ReturnType<typeof settingsOf>} settings - the resolved settings.
 * @param {(entry: object) => void} record - the audit writer.
 * @param {AbortController} lifecycle - the plugin's lifecycle, aborted on unload.
 * @returns {Promise<import('@deepseek-ai/dsh-tools').PreToolDecision>} the decision.
 */
async function decide(ctx, exec, next, command, settings, record, lifecycle) {
	const dialect = settings.dialect === 'auto' ? dialectForTool(exec.name) : settings.dialect
	const base = {
		sessionId: exec.agent.session.id,
		tool: exec.name,
		callId: exec.callId,
		dialect,
	}

	let decision
	try {
		decision = analyzeCommand(command, {
			dialect: dialect === 'unknown' ? 'posix' : dialect,
			allowPatterns: settings.allowPatterns,
			askPatterns: settings.askPatterns,
			denyPatterns: settings.denyPatterns,
			maxCommandLength: settings.maxCommandLength,
		})
	} catch (error) {
		if (settings.onError === 'allow') {
			record({
				...base,
				verdict: 'allow-pattern',
				ruleId: 'analysis-error',
				command,
				reason: `rule-guard: analysis threw ${String(error)}; released by onError=allow`,
			})
			return next()
		}
		record({
			...base,
			verdict: 'error',
			ruleId: 'analysis-error',
			command,
			reason: `rule-guard: analysis threw ${String(error)}`,
					})
					return askDecision(exec, 'analysis-error')
				}

				if (decision.kind === 'allow') {
					if (decision.ruleId !== undefined && decision.ruleId !== 'user-allow-pattern') {
						// Only a user exemption is interesting; a plain allow is
						// the overwhelming majority and is not recorded.
						record({ ...base, verdict: 'allow-pattern', ruleId: decision.ruleId, command })
					}
					return next()
				}

				if (decision.kind === 'deny') {
					const reason = auditReason(decision.ruleId ?? 'user-deny-pattern')
					record({ ...base, verdict: 'deny', ruleId: decision.ruleId, command, reason })
					return {
						kind: 'deny',
						reason: `${reason}; the command was not executed`,
						info: { name: DENIED_ERROR_NAME, code: DENIED_ERROR_CODE },
					}
				}

				if (decision.kind === 'unsupported') {
					if (settings.onUnsupported === 'allow') {
						record({
							...base,
							verdict: 'unsupported',
							ruleId: decision.ruleId,
							command,
							reason: 'released by onUnsupported=allow',
						})
						return next()
					}
					const ruleId = decision.ruleId ?? 'no-static-verdict'
					record({ ...base, verdict: 'unsupported', ruleId, command, reason: auditReason(ruleId) })
					return askDecision(exec, ruleId)
				}

			// A rule matched: ask the user, with no timeout.
			const ruleId = decision.ruleId ?? 'unknown-rule'
			if (settings.disabledRules.has(ruleId)) {
				// The guard saw the dangerous shape and the configuration switched
				// this rule off, so nothing happens. Recording it keeps the audit
				// able to answer why a dangerous command produced no prompt.
				record({
					...base,
					verdict: 'rule-disabled',
					ruleId,
					command,
					reason: `rule "${ruleId}" is disabled by configuration; the call was released`,
				})
				return next()
			}
			const reason = auditReason(ruleId)
			record({ ...base, verdict: 'ask', ruleId, command, reason })
			return askDecision(exec, ruleId)
}

/**
 * Build one `ask` decision.
 *
 * The `reason` is the audited English text; the `displayReason` is the
 * localized headline. Neither quotes the command: the host's approval panel
 * renders the command itself, in full, from the tool call correlated with this
 * request, so repeating it here would show it twice. The host turns the ask
 * into an approval request with no timeout, so the call waits for as long as
 * the user needs.
 *
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the pending execution.
 * @param {string} ruleId - the rule that fired.
 * @returns {import('@deepseek-ai/dsh-tools').PreToolDecision} the ask decision.
 */
function askDecision(exec, ruleId) {
	return {
		kind: 'ask',
		reason: `${auditReason(ruleId)}; awaiting user approval for tool "${exec.name}"`,
		displayReason: displayReason(ruleId, exec.name),
	}
}
