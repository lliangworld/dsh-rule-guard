/**
 * Append-only JSONL audit with size-based rotation.
 *
 * Every non-allow decision is recorded so a mistaken prompt or a missed
 * dangerous command can be diagnosed after the fact. Writing must never
 * affect a decision: a full disk, a locked file or a bad path is swallowed
 * and reported through the logger instead.
 *
 * @module dsh-rule-guard/audit
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, sep } from 'node:path'

/** Default audit file size before rotation, in bytes (2 MiB). */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** Longest command text retained in one audit record. */
export const MAX_AUDIT_COMMAND = 4000

/** Normalize one path to the platform's separators without touching the rest. */
function normalize(path) {
	return path.replace(/\//g, sep)
}

/**
 * One audit record.
 * @typedef {object} AuditRecord
 * @property {string} ts ISO timestamp.
 * @property {string} [sessionId] the session the call belongs to.
 * @property {string} tool the tool being called.
 * @property {string} [callId] the tool call id.
 * @property {'posix' | 'cmd' | 'powershell'} dialect the dialect analyzed.
 * @property {'ask' | 'deny' | 'unsupported' | 'error' | 'allow-pattern' | 'invalid-pattern'} verdict the decision.
 * @property {string} [ruleId] the rule that fired.
 * @property {string} command the command text, truncated.
 * @property {string} [reason] the model-facing reason.
 */

/**
 * Expand `$DSH_HOME` and `${DSH_HOME}` in one configured path.
 *
 * `DSH_HOME` is injected into tool subprocesses but is not necessarily present
 * in the host process's own environment, so the canonical resolver is used:
 * an explicit path wins, then `$DSH_HOME`, then `~/.dsh`.
 *
 * @param {string | undefined} configured - the configured path, if any.
 * @param {(configured?: string, env?: Record<string, string | undefined>) => string} resolveHome - the harness home resolver.
 * @returns {string | undefined} the audit file path, or `undefined` when auditing is off.
 */
export function expandPath(configured, resolveHome) {
	const home = resolveHome()
	if (configured === undefined || configured === null || configured === '') {
		return normalize(`${home}/rule-guard-audit.jsonl`)
	}
	return normalize(
		configured
			.replace(/\$\{DSH_HOME\}/g, home)
			.replace(/\$DSH_HOME/g, home)
			.replace(/\\/g, '/'),
	)
}

/**
 * One audit sink: append a record, rotating once the file grows too large.
 */
export class AuditLog {
	/**
	 * @param {object} options
	 * @param {string | undefined} options.path the audit file path; `undefined` disables auditing.
	 * @param {number} [options.maxBytes] the size at which the file rotates.
	 * @param {(message: string) => void} [options.onError] reporter for swallowed write failures.
	 */
	constructor({ path, maxBytes = DEFAULT_MAX_BYTES, onError }) {
		this.path = path
		this.maxBytes = maxBytes
		this.onError = onError ?? (() => {})
	}

	/**
	 * Append one record.
	 *
	 * @param {AuditRecord} record - the record to append.
	 * @returns {void}
	 */
	write(record) {
		if (this.path === undefined) return
		const line = `${JSON.stringify({ ...record, command: record.command.slice(0, MAX_AUDIT_COMMAND) })}\n`
		try {
			this.rotateIfNeeded(Buffer.byteLength(line))
			appendFileSync(this.path, line, 'utf8')
		} catch (error) {
			// A failed audit must never turn into a failed decision.
			this.onError(`rule-guard: audit write failed: ${String(error)}`)
		}
	}

	/** Rotate the file when it has reached the size limit. */
	rotateIfNeeded(incoming) {
		let size = 0
		try {
			size = statSync(this.path).size
		} catch {
			return
		}
		if (size + incoming < this.maxBytes) return
		try {
			renameSync(this.path, `${this.path}.1`)
		} catch (error) {
			this.onError(`rule-guard: audit rotation failed: ${String(error)}`)
		}
	}

	/** Create the audit file's directory, best effort. */
	ensureDirectory() {
		if (this.path === undefined) return
		try {
			mkdirSync(dirname(this.path), { recursive: true })
		} catch {
			// The first append will report the failure if the path is unusable.
		}
	}
}

export default { AuditLog, expandPath, DEFAULT_MAX_BYTES, MAX_AUDIT_COMMAND }
