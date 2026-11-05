"""Real installed-font metadata/PNG proofs, using approved existing Pillow worker."""
from io import BytesIO
from pathlib import Path
import base64
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from PIL import Image
from mangaclean.services import typesetting_render as renderer
from mangaclean.services.font_catalog import REQUESTED, face


class FontBrowserTests(unittest.TestCase):
    def values(self, family, **fields):
        d=dict(text='MangaClean Dream',width=600,height=130,size=32,minimum_size=12,family=family,weight=400,color='#202020',alignment='center',padding=8,visible=True,auto_fit=False)
        d.update(fields);return d

    def test_catalog_samples_use_actual_faces_not_fallback(self):
        entries={entry['family']:entry for entry in renderer.browser_fonts()}
        self.assertTrue({'Arial','Segoe UI','Times New Roman'}.issubset(entries))
        for family in REQUESTED:
            with self.subTest(family=family):
                entry=entries[family]
                if not entry['weights']:
                    self.assertEqual(entry['status'],'Missing');self.assertIsNone(entry['preview']);continue
                self.assertEqual(entry['status'],'Available')
                image=Image.open(BytesIO(base64.b64decode(entry['preview'])))
                self.assertIsNotNone(image.getchannel('A').getbbox())
                name,resolved,weight,warnings=renderer.resolve_font(family,400,entry['sample'])
                self.assertEqual(resolved,family)
                self.assertNotIn('fallback',' '.join(warnings).lower())
                self.assertTrue(face(name)['path'].is_file())

    def test_cambria_math_uses_collection_face_one(self):
        name,family,_,_=renderer.resolve_font('Cambria Math',400,'x² + y² = r²')
        if family!='Cambria Math':self.skipTest('System face not installed')
        self.assertEqual(face(name)['index'],1)
        self.assertEqual(renderer.font_at(name,32).getname()[0],'Cambria Math')

    def test_variable_font_applies_requested_weight(self):
        regular=renderer.render(self.values('Cormorant Garamond'))
        if regular['resolvedFamily']!='Cormorant Garamond':self.skipTest('Local variable font not installed')
        bold=renderer.render(self.values('Cormorant Garamond',weight=700))
        self.assertEqual((regular['resolvedWeight'],bold['resolvedWeight']),(400,700))
        self.assertNotEqual(regular['png'],bold['png'])

    def test_wrapping_and_missing_glyph_fallback_remain_explicit(self):
        pngs=set()
        for family in REQUESTED:
            d=self.values(family)
            result=renderer.render(d);pngs.add(result['png'])
            name,_,_,_=renderer.resolve_font(family,400,'Kaktus')
            self.assertEqual(renderer.lines_for('Kaktus',renderer.font_at(name,32),20),['Kaktus'])
            result=renderer.render(self.values(family,text='Mimpiku malam itu sedikit berbeda dari semalam',width=220,height=300,auto_fit=True))
            self.assertFalse(result['overflow'])
        self.assertGreater(len(pngs),1)
        japanese=renderer.render(self.values('Komika Text Tight',text='何そのカッコ'))
        self.assertTrue(any('fallback' in warning.lower() for warning in japanese['warnings']))
        missing=renderer.render(self.values('Unknown Missing Family'))
        self.assertTrue(any('Missing font' in warning for warning in missing['warnings']))


if __name__=='__main__':unittest.main()
