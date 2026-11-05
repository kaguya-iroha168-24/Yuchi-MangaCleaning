"""Renderer contracts; run read-only with the approved existing Pillow interpreter."""
from pathlib import Path
from io import BytesIO
import base64
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mangaclean.services import typesetting_render as renderer
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
