/**
 * `-EncodedCommand` decoding for PowerShell.
 *
 * PowerShell accepts a base64 UTF-16LE command line; the rule engine decodes
 * it so an encoded payload is analyzed rather than waved through. A payload
 * that does not decode cleanly is reported unsupported.
 *
 * @module dsh-rule-guard/encoding
 */

/**
 * Decode a base64 UTF-16LE command line.
 *
 * @param {string} text - the encoded payload.
 * @returns {string | undefined} the decoded command line, or `undefined` when it does not decode.
 */
export function decodeEncodedCommand(text) {
	const trimmed = text.trim()
	if (trimmed.length === 0) return undefined
	let bytes
	try {
		bytes = Buffer.from(trimmed, 'base64')
	} catch {
		return undefined
	}
	if (bytes.length === 0 || bytes.length % 2 !== 0) return undefined
	// Round-trip check: a payload that is not valid base64 must not be treated
	// as a decoded command line.
	const reencoded = Buffer.from(bytes).toString('base64').replace(/=+$/, '')
	const canonical = trimmed.replace(/=+$/, '')
	if (reencoded !== canonical && reencoded.replace(/\+/g, '-').replace(/\//g, '_') !== canonical) return undefined
	const decoded = bytes.toString('utf16le')
	if (decoded.length === 0) return undefined
	return decoded
}

export default { decodeEncodedCommand }
