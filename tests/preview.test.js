import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The plugin's detail image.
 *
 * The image is rendered from `docs/preview-source.html` by
 * `docs/render-preview.py`, which cannot run in this suite — it needs Pillow.
 * What is asserted here is what the plugin ships: that the images exist at the
 * size the detail page reserves, that they are far inside the Host's per-image
 * budget, and that both localized detail documents name a file that is really
 * there. A detail document naming a missing image is the one failure mode the
 * user sees as an empty slot under the description.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(HERE, '..', 'docs')

/** The Host's own per-image ceiling; see `pluginManager.detailImageMaxBytes`. */
const HOST_IMAGE_LIMIT = 5 * 1024 * 1024

/** What this plugin holds itself to, an order of magnitude inside that. */
const OWN_IMAGE_BUDGET = 200 * 1024

/** The detail canvas size the plugin detail page reserves. */
const CANVAS = { width: 640, height: 300 }

/**
 * The PNG's IHDR, read straight from the file.
 *
 * @param {string} file - the image to read.
 * @returns {{ width: number, height: number }} the pixel size.
 */
function pngSize(file) {
	const bytes = readFileSync(file)
	// The signature is 8 bytes, then a 4-byte length, then the `IHDR` tag.
	assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${file} is not a PNG`)
	assert.equal(bytes.subarray(12, 16).toString('latin1'), 'IHDR', `${file} has no IHDR`)
	return {
		width: bytes.readUInt32BE(16),
		height: bytes.readUInt32BE(20),
	}
}

/**
 * Every image the two detail documents reference.
 *
 * @param {string} document - the detail document's text.
 * @returns {string[]} the destinations its images name, relative to the document.
 */
function imageRefs(document) {
	const refs = []
	const pattern = /!\[[^\]]*\]\(([^)]+)\)/g
	let match
	while ((match = pattern.exec(document)) !== null) refs.push(match[1].trim())
	return refs
}

test('the English detail image is a 640x300 PNG inside the budget', () => {
	const file = path.join(DOCS, 'preview.png')
	assert.ok(existsSync(file), 'preview.png is missing from the bundle')
	assert.deepEqual(pngSize(file), CANVAS)
	assert.ok(statSync(file).size < OWN_IMAGE_BUDGET, 'preview.png exceeds the plugin budget')
	assert.ok(statSync(file).size < HOST_IMAGE_LIMIT, 'preview.png exceeds the Host limit')
})

test('the Chinese detail image is a 640x300 PNG inside the budget', () => {
	const file = path.join(DOCS, 'preview.zh.png')
	assert.ok(existsSync(file), 'preview.zh.png is missing from the bundle')
	assert.deepEqual(pngSize(file), CANVAS)
	assert.ok(statSync(file).size < OWN_IMAGE_BUDGET, 'preview.zh.png exceeds the plugin budget')
	assert.ok(statSync(file).size < HOST_IMAGE_LIMIT, 'preview.zh.png exceeds the Host limit')
})

test('each detail document names exactly one image, and it ships', () => {
	// A missing image is the failure the user sees: an empty slot where the
	// feature picture should be. Both documents are checked separately, because
	// the localized one names its own variant.
	for (const [document, expected] of [
		['DETAIL.md', 'preview.png'],
		['DETAIL.zh.md', 'preview.zh.png'],
	]) {
		const file = path.join(DOCS, document)
		assert.ok(existsSync(file), `${document} is missing`)
		const refs = imageRefs(readFileSync(file, 'utf8'))
		assert.equal(refs.length, 1, `${document} should name exactly one image`)
		assert.equal(refs[0], expected, `${document} names the wrong image`)
		assert.ok(existsSync(path.join(DOCS, refs[0])), `${document} names ${refs[0]}, which is not shipped`)
	}
})

test('the detail document has alt text, not an empty description', () => {
	// The alt text is the only thing a screen reader or a failed load can show,
	// so it has to say what the image is rather than being empty.
	for (const document of ['DETAIL.md', 'DETAIL.zh.md']) {
		const text = readFileSync(path.join(DOCS, document), 'utf8')
		const match = /!\[([^\]]*)\]/.exec(text)
		assert.ok(match !== null, `${document} has no image`)
		assert.ok(match[1].length > 10, `${document} has no usable alt text`)
	}
})

test('the render source carries a scene with both languages', () => {
	// The scene is the contract between the page that previews the artwork and
	// the script that renders it: a language missing from it would render an
	// image with an empty label, and nothing here could catch that.
	const html = readFileSync(path.join(DOCS, 'preview-source.html'), 'utf8')
	const match = /<script[^>]*id="scene"[^>]*>([\s\S]*?)<\/script>/.exec(html)
	assert.ok(match !== null, 'preview-source.html carries no scene')
	const scene = JSON.parse(match[1])
	assert.equal(scene.width, CANVAS.width)
	assert.equal(scene.height, CANVAS.height)
	for (const lang of ['en', 'zh']) {
		assert.ok(scene.text[lang] !== undefined, `the scene has no ${lang} text`)
		assert.equal(scene.text[lang].presets.length, 4, `${lang} should list four presets`)
		// The seat's width is per language, because the Chinese label is wider.
		assert.equal(typeof scene.seat.width[lang], 'number', `${lang} has no seat width`)
	}
	// The scene must still describe the three parts of the product.
	assert.ok(scene.approval !== undefined, 'the scene has no approval panel')
	assert.ok(scene.rules !== undefined, 'the scene has no rule set')
})

test('nothing references the retired SVG placeholders', () => {
	// The SVG versions were replaced by PNGs; a leftover reference would leave a
	// localized document pointing at a file that is no longer shipped.
	for (const name of ['DETAIL.md', 'DETAIL.zh.md', 'preview-source.html']) {
		const text = readFileSync(path.join(DOCS, name), 'utf8')
		assert.ok(!text.includes('preview.svg'), `${name} still references preview.svg`)
		assert.ok(!text.includes('preview.zh.svg'), `${name} still references preview.zh.svg`)
	}
})

test('the render source uses no remote resource or script beyond the scene', () => {
	// The detail page serves the document beside the bundle, but the source page
	// itself should stay self-contained so it can be opened from a checkout.
	const html = readFileSync(path.join(DOCS, 'preview-source.html'), 'utf8')
	assert.ok(!/<script[^>]+src=/i.test(html), 'the source loads a remote script')
	assert.ok(!/<link[^>]+href=/i.test(html), 'the source loads a remote stylesheet')
	assert.ok(!/https?:\/\//i.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')),
		'the source names a remote resource')
})
