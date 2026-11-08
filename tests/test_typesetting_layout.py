"""Renderer contracts; run read-only with the approved existing Pillow interpreter."""
from pathlib import Path
from io import BytesIO
import base64
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mangaclean.services import typesetting_render as renderer
from mangaclean.core.dialogue import manga_lettering
from PIL import Image, ImageDraw


class LayoutTests(unittest.TestCase):
    def dialogue(self, **fields):
        values = dict(text='Kaktus', width=55, height=180, size=47, minimum_size=12,
                      family='Arial', weight=400, visible=True, auto_fit=True,
                      padding=8, color='#202020', alignment='center')
        values.update(fields)
        return values

    def test_latin_word_is_atomic_even_when_impossible(self):
        font = renderer.font_at('arial.ttf', 47)
        self.assertEqual(renderer.lines_for('Kaktus', font, 39), ['Kaktus'])
        self.assertEqual(renderer.lines_for('CAC-TUS', font, 39), ['CAC-TUS'])
        result = renderer.render(self.dialogue(width=25, minimum_size=16))
        self.assertTrue(result['overflow'])
        self.assertTrue(any('not split' in warning for warning in result['warnings']))
        image = Image.open(BytesIO(base64.b64decode(result['png'])))
        self.assertIsNone(image.getchannel('A').getbbox())

    def test_auto_fit_reduces_size_before_breaking_word(self):
        values = self.dialogue()
        result = renderer.render(values)
        self.assertFalse(result['overflow'])
        self.assertLess(result['effectiveSize'], 47)
        self.assertGreaterEqual(result['effectiveSize'], 12)
        self.assertEqual(values['text'], 'Kaktus')

    def test_manga_lettering_fits_narrow_caption_with_installed_bold_italic_face(self):
        if 700 not in renderer.italic_font_faces().get('Komika Text Kaps', {}):
            self.skipTest('Komika Text Kaps Bold Italic is not installed.')
        values = self.dialogue(text='SEPULUH MENIT KEMUDIAN', width=52, height=88, family='Segoe UI',
                               size=32, minimum_size=8, padding=4)
        mask = Image.new('L', (52, 88))
        ImageDraw.Draw(mask).rectangle((1, 1, 50, 86), fill=255)
        clip = BytesIO()
        mask.save(clip, 'PNG')
        encoded = base64.b64encode(clip.getvalue())
        old = renderer.render(values, encoded)
        new = renderer.render({**values, **manga_lettering(52, 88, (1600, 1114))}, encoded)
        self.assertEqual((new['resolvedFamily'], new['resolvedWeight'], new['resolvedItalic']), ('Komika Text Kaps', 700, True))
        self.assertFalse(new['overflow'])
        self.assertGreater(new['effectiveSize'], old['effectiveSize'])
        alpha = Image.open(BytesIO(base64.b64decode(new['png']))).getchannel('A')
        left, top, right, bottom = alpha.getbbox()
        self.assertTrue(1 <= left < right <= 51 and 1 <= top < bottom <= 87)

    def test_word_boundaries_punctuation_and_manual_empty_lines(self):
        text = 'Mimpiku malam itu sedikit berbeda dari semalam'
        lines = renderer.lines_for(text, renderer.font_at('arial.ttf', 32), 204)
        self.assertEqual(' '.join(lines), text)
        self.assertTrue(all(word in text.split() for line in lines for word in line.split()))
        self.assertEqual(renderer.lines_for('Hello!\n\nWorld?', renderer.font_at('arial.ttf', 20), 200), ['Hello!', '', 'World?'])

    def test_font_and_weight_change_pixels_at_identical_size(self):
        values = self.dialogue(text='MangaClean Wiii', width=600, height=120, auto_fit=False, size=47)
        a = renderer.render(values)
        b = renderer.render(dict(values, family='Times New Roman'))
        bold = renderer.render(dict(values, weight=700))
        self.assertEqual((a['resolvedFamily'], b['resolvedFamily']), ('Arial', 'Times New Roman'))
        self.assertEqual(bold['resolvedWeight'], 700)
        self.assertEqual({a['effectiveSize'], b['effectiveSize'], bold['effectiveSize']}, {47})
        self.assertNotEqual(a['png'], b['png'])
        self.assertNotEqual(a['png'], bold['png'])

    def test_v4_style_changes_visible_pixels_and_auto_width_reports_content_width(self):
        values = self.dialogue(text='Ink!\nManga', width=400, height=240, size=32, auto_fit=False)
        plain = renderer.render(values)
        styled = renderer.render(dict(values, style=dict(italic=True, rotation=12, vertical_offset=4,
            line_height=1.25, letter_spacing=2, stroke_width=2, stroke_color='#ff0000', auto_width=True)))
        self.assertFalse(styled['overflow'])
        self.assertTrue(styled['resolvedItalic'])
        self.assertLess(styled['layoutWidth'], plain['layoutWidth'])
        self.assertNotEqual(styled['png'], plain['png'])
        pixels = Image.open(BytesIO(base64.b64decode(styled['png'])))
        self.assertTrue(any(red > green and alpha for red, green, _, alpha in pixels.getdata()))

    def test_vertical_offset_cannot_silently_clip_text(self):
        result = renderer.render(self.dialogue(width=180, height=70, size=26, auto_fit=False,
                                               style={'vertical_offset': 100}))
        self.assertTrue(result['overflow'])

    def test_cjk_fallback_explicit_and_unicode_unchanged(self):
        values = self.dialogue(text='何そのカッコ', width=200, height=200)
        result = renderer.render(values)
        self.assertTrue(any('fallback' in warning.lower() for warning in result['warnings']))
        font, _, _, _ = renderer.resolve_font(values['family'], values['weight'], values['text'])
        lines = renderer.lines_for(values['text'], renderer.font_at(font, result['effectiveSize']), 100)
        self.assertEqual(''.join(lines), values['text'])
        self.assertEqual(renderer.clusters('a\u0301'), ['a\u0301'])

    def test_oval_safe_interior_unchanged_and_no_ink_outside(self):
        mask = Image.new('L', (120, 220))
        ImageDraw.Draw(mask).ellipse((2, 2, 117, 217), fill=255)
        before = mask.tobytes()
        encoded = BytesIO(); mask.save(encoded, 'PNG')
        result = renderer.render(self.dialogue(width=120, height=220), base64.b64encode(encoded.getvalue()).decode())
        image = Image.open(BytesIO(base64.b64decode(result['png'])))
        ink = image.getchannel('A').tobytes()
        self.assertTrue(any(ink))
        self.assertFalse(any(a and not b for a, b in zip(ink, before)))
        self.assertEqual(before, mask.tobytes())

    def test_long_dialogue_bounded_fallback_preserves_words(self):
        text = ' '.join(['dialogue']*150)
        lines = renderer.lines_for(text, renderer.font_at('arial.ttf', 20), 180)
        self.assertEqual(' '.join(lines), text)


if __name__ == '__main__':
    unittest.main()
