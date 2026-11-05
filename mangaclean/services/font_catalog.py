"""Read-only local font discovery. Never installs, copies or serves font files."""
from functools import lru_cache
from pathlib import Path
import os
from fontTools.ttLib import TTFont, TTCollection, TTLibError

SYSTEM = Path(os.environ.get('WINDIR', r'C:\Windows'))/'Fonts'
USER = Path(os.environ.get('LOCALAPPDATA', ''))/'Microsoft/Windows/Fonts'
APP = Path(__file__).resolve().parents[2]/'resources/fonts'
REQUESTED = {
    'Komika Text Tight': ('KOMTXTT.ttf', 'MIMPIKU MALAM ITU', 'Local file; verify usage rights; no bundled fonts'),
    'Architects Daughter': ('ArchitectsDaughter-Regular.ttf', 'Mimpiku malam itu', 'SIL OFL 1.1'),
    'Shadows Into Light': ('ShadowsIntoLight-Regular.ttf', 'A little different...', 'SIL OFL 1.1'),
    'CCMeanwhile': ('ccmeanwhile-regular.ttf', 'WHAT HAPPENED?!', 'Local file; user license required; no redistribution'),
    'Cambria Math': ('cambria.ttc', 'x² + y² = r²', 'System font; no redistribution'),
    'Cormorant Garamond': ('CormorantGaramond-VariableFont_wght.ttf', 'A Different Dream', 'SIL OFL 1.1'),
}


@lru_cache(maxsize=1)
def requested_faces():
    families = {family: {} for family in REQUESTED}
    assets = {}
    candidates = []
    for filename, _, _ in REQUESTED.values():
        candidates.extend(root/filename for root in (SYSTEM, USER))
    if APP.is_dir():
        candidates.extend(p for p in sorted(APP.iterdir())[:256] if p.suffix.lower() in ('.ttf','.otf','.ttc'))
    for path in dict.fromkeys(candidates):
        if not path.is_file(): continue
        try:
            count = 1
            if path.suffix.lower() == '.ttc':
                with TTCollection(path, lazy=True) as collection: count = len(collection.fonts)
            for index in range(count):
                with TTFont(path, fontNumber=index, lazy=True) as font:
                    family = font['name'].getDebugName(16) or font['name'].getDebugName(1)
                    if family not in families: continue
                    style = font['name'].getDebugName(17) or font['name'].getDebugName(2) or ''
                    if 'italic' in style.lower() or font['OS/2'].fsSelection & 1: continue
                    axes = [(axis.axisTag, axis.defaultValue, axis.minValue, axis.maxValue) for axis in font['fvar'].axes] if 'fvar' in font else []
                    weight_axis = next((a for a in axes if a[0]=='wght'), None)
                    weights = [w for w in (300,400,500,600,700) if weight_axis[2]<=w<=weight_axis[3]] if weight_axis else [font['OS/2'].usWeightClass]
                    for weight in weights:
                        key = f'{path}|{index}|{weight}'
                        assets[key] = dict(path=path, index=index, axes=[weight if tag=='wght' else default for tag,default,_,_ in axes])
                        families[family].setdefault(weight, key)
        except (OSError, ValueError, KeyError, TTLibError):
            continue
    return families, assets


def face(name):
    return requested_faces()[1].get(name, dict(path=SYSTEM/name, index=0, axes=[]))
