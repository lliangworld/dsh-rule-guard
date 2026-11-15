"""Render the plugin's detail image from its HTML source.

The source of truth is ``docs/preview-source.html``: the artwork is drawn live
there from a JSON scene embedded in the page, so it can be opened in a browser
and edited. This script parses that same scene and rasterises it with Pillow at
four times the canvas size, then downsamples with LANCZOS, which gives clean
small text and smooth rounded corners — the difference against drawing directly
at 640x300 is large enough to be worth the extra pass.

Run with the Python that ships with the DSH runtime, which carries Pillow:

    C:\\Users\\liang\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe \\
        docs/render-preview.py

It writes ``preview.png`` (English) and ``preview.zh.png`` (Chinese) beside
itself and is idempotent: the same scene always produces the same bytes.

The canvas is 640x300, the size the plugin detail page reserves for its feature
image. Coordinates come from the scene, so changing the layout there changes it
here too; the panel is an opaque dark surface so both themes render it
identically.

@module dsh-rule-guard/render-preview
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

#: Rendered at this multiple of the canvas, then downsampled.
SUPERSAMPLE = 4

#: Where the fonts live. Segoe UI covers Latin, Microsoft YaHei covers Chinese,
#: and Consolas covers the command line.
FONTS = {
    'latin': Path(r'C:\Windows\Fonts\segoeui.ttf'),
    'latin_bold': Path(r'C:\Windows\Fonts\segoeuib.ttf'),
    'cjk': Path(r'C:\Windows\Fonts\msyh.ttc'),
    'cjk_bold': Path(r'C:\Windows\Fonts\msyhbd.ttc'),
    'mono': Path(r'C:\Windows\Fonts\consola.ttf'),
}

#: One palette, resolved once per size so the hot loop stays allocation-free.
_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(kind: str, px: float) -> ImageFont.FreeTypeFont:
    """One font instance per (kind, size), since Pillow re-parses otherwise."""
    key = (kind, round(px))
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = ImageFont.truetype(str(FONTS[kind]), round(px))
    return _FONT_CACHE[key]


def scene_of(html: str) -> dict:
    """The scene embedded in the page, parsed as JSON.

    @param html - the whole HTML document.
    @returns the scene object.
    @throws ValueError when the page carries no usable scene.
    """
    match = re.search(
        r'<script[^>]*type="application/json"[^>]*id="scene"[^>]*>(.*?)</script>',
        html,
        re.DOTALL,
    )
    if match is None:
        raise ValueError('preview-source.html carries no scene script')
    return json.loads(match.group(1))


class Canvas:
    """A drawing surface at the supersampled size, in canvas units."""

    def __init__(self, width: int, height: int, background: str) -> None:
        self.width = width
        self.height = height
        self.image = Image.new('RGB', (width * SUPERSAMPLE, height * SUPERSAMPLE), background)
        self.draw = ImageDraw.Draw(self.image)

    def _box(self, x: float, y: float, w: float, h: float) -> tuple[int, int, int, int]:
        return (round(x * SUPERSAMPLE), round(y * SUPERSAMPLE),
                round((x + w) * SUPERSAMPLE), round((y + h) * SUPERSAMPLE))

    def rect(self, x, y, w, h, fill=None, radius=0, outline=None, width=1):
        """A rounded rectangle; `radius` is in canvas units."""
        box = self._box(x, y, w, h)
        if radius > 0:
            self.draw.rounded_rectangle(box, radius=round(radius * SUPERSAMPLE),
                                        fill=fill, outline=outline,
                                        width=round(width * SUPERSAMPLE) if outline else 0)
        else:
            self.draw.rectangle(box, fill=fill, outline=outline,
                                width=round(width * SUPERSAMPLE) if outline else 0)

    def circle(self, cx, cy, r, fill=None, outline=None, width=1):
        self.draw.ellipse((round((cx - r) * SUPERSAMPLE), round((cy - r) * SUPERSAMPLE),
                           round((cx + r) * SUPERSAMPLE), round((cy + r) * SUPERSAMPLE)),
                          fill=fill, outline=outline,
                          width=round(width * SUPERSAMPLE) if outline else 0)

    def line(self, points, fill, width):
        self.draw.line([(round(x * SUPERSAMPLE), round(y * SUPERSAMPLE)) for x, y in points],
                       fill=fill, width=round(width * SUPERSAMPLE), joint='curve')

    def polyline(self, points, fill, width):
        """An open polyline with round caps, for arrows and glyph strokes."""
        self.line(points, fill, width)
        for x, y in (points[0], points[-1]):
            self.circle(x, y, width / 2, fill=fill)

    def text(self, x, y, body, kind, px, fill, anchor='la', bold=False):
        """Draw text with its anchor point at (x, y) in canvas units.

        Pillow's anchors are `l`, `m` and `a` for left, middle and ascender, so
        `la` is the default and `mm` centres a button label.
        """
        self.draw.text((round(x * SUPERSAMPLE), round(y * SUPERSAMPLE)), body,
                       font=font(kind, px * SUPERSAMPLE), fill=fill, anchor=anchor)

    def measure(self, body, kind, px, bold=False) -> float:
        """The rendered width in canvas units, for centring against a box."""
        return self.draw.textlength(body, font=font(kind, px * SUPERSAMPLE)) / SUPERSAMPLE

    def fit(self, body, kind, px, limit, bold=False) -> float:
        """The largest size up to `px` whose rendering stays within `limit`.

        @param body - the text to measure.
        @param kind - which font family to use.
        @param px - the preferred size in canvas units.
        @param limit - the widest allowed rendering, in canvas units.
        @param bold - whether the bold face is meant, for cache identity.
        @returns the size to draw at, never larger than `px`.
        """
        if self.measure(body, kind, px, bold) <= limit:
            return px
        size = px
        while size > 7 and self.measure(body, kind, size, bold) > limit:
            size -= 0.5
        return size

    def accent(self, x, y, w, h, fill, radius):
        """A top accent bar clipped to the card's rounded corners.

        A square-cornered bar laid over a rounded card overhangs at both top
        corners, which reads as a misalignment rather than a design choice. The
        clip is the card's own shape, so the bar follows it exactly.

        @param x, y - the card's top-left, in canvas units.
        @param w, h - the card's width and the bar's height, in canvas units.
        @param fill - the bar's colour.
        @param radius - the card's corner radius, in canvas units.
        """
        # The clip is the card's top section: rounded at the top, square where
        # the bar ends, so nothing below the bar is tinted.
        mask = Image.new('L', self.image.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (round(x * SUPERSAMPLE), round(y * SUPERSAMPLE),
             round((x + w) * SUPERSAMPLE), round((y + h + radius) * SUPERSAMPLE)),
            radius=round(radius * SUPERSAMPLE), fill=255)
        self.image.paste(Image.new('RGB', self.image.size, fill), (0, 0), mask)

    def downsample(self) -> Image.Image:
        """The final image at canvas size."""
        return self.image.resize((self.width, self.height), Image.LANCZOS)


def draw_scene(scene: dict, lang: str) -> Image.Image:
    """One language variant of the artwork.

    @param scene - the parsed scene.
    @param lang - `en` or `zh`, choosing the text set.
    @returns the rendered image at canvas size.
    """
    text = scene['text'][lang]
    colors = scene['colors']
    panel = scene['panel']

    canvas = Canvas(scene['width'], scene['height'], panel['fill'])

    # ---- left: the permission seat, with the plugin's preset selected -------
    seat = scene['seat']
    seat_w = seat['width'][lang]
    canvas.rect(seat['x'], seat['y'], seat_w, seat['h'], fill=colors['card'],
                radius=seat['h'] / 2, outline=colors['cardEdge'])

    # The shield, matching the plugin's own icon.svg.
    cx, cy = 48, seat['y'] + seat['h'] / 2
    canvas.polyline([(cx - 8, cy - 6), (cx, cy - 9), (cx + 8, cy - 6),
                     (cx + 8, cy + 1), (cx, cy + 8), (cx - 8, cy + 1)],
                    colors['shield'], 1.4)
    canvas.polyline([(cx - 3, cy), (cx - 1, cy + 2), (cx + 3, cy - 2)], colors['shield'], 1.6)

    # The seat's label, shrunk to fit whichever the language needs: six Chinese
    # characters are wider than the English phrase, and a clipped label in the
    # one place the user looks for the preset is the wrong thing to ship.
    label_x = 64
    label_kind = 'cjk_bold' if lang == 'zh' else 'latin_bold'
    label_px = canvas.fit(text['seat'], label_kind, 12,
                          seat_w - (label_x - seat['x']) - 40, bold=True)
    canvas.text(label_x, cy, text['seat'], label_kind, label_px, colors['text'],
                anchor='lm', bold=True)

    # The chevron that says the menu opens, inset from the seat's right edge.
    ax = seat['x'] + seat_w - seat['arrowOffset']
    canvas.polyline([(ax, cy - 4), (ax + 4, cy), (ax, cy + 4)], colors['textDim'], 1.6)

    # The open menu, one row per preset, the plugin's own highlighted. The three
    # stock presets come first because the bundle layer supplies them and the
    # plugin appends its own — which is the order the profile patch ends up in.
    menu = seat['menu']
    canvas.rect(menu['x'], menu['y'], menu['w'], menu['h'], fill=colors['card'],
                radius=menu['r'], outline=colors['cardEdge'])
    for index, label in enumerate(text['presets']):
        y = menu['y'] + seat['rowInset'] + index * (seat['rowH'] + seat['rowGap'])
        selected = index == seat['selected']
        canvas.rect(menu['x'] + seat['rowInset'], y, menu['w'] - seat['rowInset'] * 2,
                    seat['rowH'], fill=colors['select'] if selected else None, radius=6)
        if selected:
            check_y = y + seat['rowH'] / 2
            canvas.polyline([(menu['x'] + 18, check_y), (menu['x'] + 20, check_y + 2),
                             (menu['x'] + 25, check_y - 3)], '#ffffff', 1.8)
        kind = ('cjk_bold' if lang == 'zh' else 'latin_bold') if selected \
            else ('cjk' if lang == 'zh' else 'latin')
        canvas.text(menu['x'] + (34 if selected else seat['rowInset'] + 8), y + seat['rowH'] / 2,
                    label, kind, 11.5, '#ffffff' if selected else colors['textDim'], anchor='lm')

    # ---- the arrow into the panel -----------------------------------------
    flow = seat['flow']
    canvas.line([(flow['x1'], flow['y']), (flow['x2'] - 8, flow['y'])], colors['line'], 2)
    canvas.polyline([(flow['x2'] - 8, flow['y'] - 5), (flow['x2'] - 3, flow['y']),
                     (flow['x2'] - 8, flow['y'] + 5)], colors['line'], 2)

    # ---- right: the approval panel ----------------------------------------
    approval = scene['approval']
    canvas.rect(approval['x'], approval['y'], approval['w'], approval['h'], fill=colors['card'],
                radius=approval['r'], outline=colors['cardEdge'])
    # The accent bar across the top, following the card's corners rather than
    # overhanging them.
    bar = approval['bar']
    canvas.accent(approval['x'], approval['y'], approval['w'], bar['h'], bar['fill'],
                  approval['r'])

    canvas.text(approval['x'] + 20, approval['titleY'], text['panelTitle'],
                'cjk_bold' if lang == 'zh' else 'latin_bold', 13, colors['text'])

    command = approval['command']
    canvas.rect(command['x'], command['y'], command['w'], command['h'], fill=colors['cardSoft'],
                radius=command['r'])
    canvas.text(command['x'] + 12, command['y'] + command['h'] / 2, text['panelCommand'],
                'mono', 12, colors['text'], anchor='lm')

    # The hold sign: a ringed bar. A clock face would say "counts down", which is
    # the one thing this panel does not do.
    note_y = approval['noteY']
    canvas.circle(approval['x'] + 26, note_y, 8, outline=colors['ok'], width=1.6)
    canvas.line([(approval['x'] + 22, note_y), (approval['x'] + 30, note_y)], colors['ok'], 1.8)
    canvas.text(approval['x'] + 42, note_y, text['panelNote'],
                'cjk' if lang == 'zh' else 'latin', 11, colors['textDim'], anchor='lm')

    for index, button in enumerate(approval['buttons']):
        canvas.rect(button['x'], button['y'], button['w'], button['h'],
                    fill=colors['select'] if button['primary'] else None, radius=7,
                    outline=None if button['primary'] else colors['cardEdge'], width=1.2)
        canvas.text(button['x'] + button['w'] / 2, button['y'] + button['h'] / 2,
                    text['allow'] if index == 0 else text['deny'],
                    'cjk_bold' if lang == 'zh' else 'latin_bold', 11.5,
                    '#ffffff' if button['primary'] else colors['textDim'], anchor='mm')

    # ---- bottom: the rule set and its three verdicts ----------------------
    rules = scene['rules']
    canvas.rect(rules['x'], rules['y'], rules['w'], rules['h'], fill=colors['cardSoft'],
                radius=rules['r'], outline=colors['cardEdge'])

    shield = rules['shield']
    sx, sy, sr = shield['cx'], shield['cy'], shield['r']
    canvas.polyline([(sx - sr, sy - sr * 0.65), (sx, sy - sr), (sx + sr, sy - sr * 0.65),
                     (sx + sr, sy + sr * 0.1), (sx, sy + sr * 0.35), (sx - sr, sy + sr * 0.1)],
                    colors['shield'], 1.8)
    canvas.polyline([(sx - sr * 0.42, sy - sr * 0.1), (sx - sr * 0.14, sy + sr * 0.18),
                     (sx + sr * 0.42, sy - sr * 0.46)], colors['shield'], 2.4)

    cjk = lang == 'zh'
    canvas.text(rules['textX'], rules['titleY'], text['rules'],
                'cjk_bold' if cjk else 'latin_bold', 12, colors['text'], bold=True)
    canvas.text(rules['textX'], rules['noteY'], text['rulesNote'],
                'cjk' if cjk else 'latin', 10, colors['textDim'])

    for verdict in rules['verdicts']:
        vx, vy = verdict['x'], verdict['cy']
        canvas.circle(vx, vy, 13, outline=colors['cardEdge'], width=1.2)
        if verdict['mark'] == 'check':
            canvas.polyline([(vx - 5, vy), (vx - 1, vy + 4), (vx + 7, vy - 8)], colors['ok'], 2)
        elif verdict['mark'] == 'ask':
            # A question mark, drawn: the arc, then the dot below it.
            canvas.polyline([(vx - 4, vy - 3), (vx, vy - 7), (vx + 4, vy - 3),
                             (vx + 4, vy), (vx, vy + 3), (vx, vy + 6)], '#e8a33d', 1.8)
            canvas.circle(vx, vy + 9, 1.2, fill='#e8a33d')
        else:
            canvas.polyline([(vx - 4, vy - 4), (vx + 4, vy + 4)], '#e5534b', 2)
            canvas.polyline([(vx + 4, vy - 4), (vx - 4, vy + 4)], '#e5534b', 2)
        label = text['release'] if verdict['mark'] == 'check' \
            else text['ask'] if verdict['mark'] == 'ask' else text['denyVerdict']
        canvas.text(vx, rules['verdictLabelY'], label, 'cjk' if cjk else 'latin', 10,
                    colors['textDim'], anchor='ma')

    return canvas.downsample()


def main() -> int:
    """Render every language variant beside this script.

    @returns the process exit code.
    """
    here = Path(__file__).resolve().parent
    html_path = here / 'preview-source.html'
    scene = scene_of(html_path.read_text(encoding='utf-8'))

    missing = [str(path) for path in FONTS.values() if not path.exists()]
    if missing:
        print('missing font(s): ' + ', '.join(missing), file=sys.stderr)
        return 1

    written = []
    for lang, suffix in (('en', ''), ('zh', '.zh')):
        image = draw_scene(scene, lang)
        target = here / f'preview{suffix}.png'
        image.save(target, 'PNG', optimize=True)
        written.append(f'{target.name}  {target.stat().st_size} bytes')

    for line in written:
        print(line)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
