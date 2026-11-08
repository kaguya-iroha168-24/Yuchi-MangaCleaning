"""Authoritative horizontal typography; imported only in the isolated Pillow worker."""
from functools import lru_cache
from io import BytesIO
from pathlib import Path
import base64
import math
import os
import re
import unicodedata
from time import perf_counter

from PIL import Image, ImageDraw, ImageFont, features
from fontTools.ttLib import TTFont
from mangaclean.core.composition import typography_style
from mangaclean.services.font_catalog import REQUESTED, requested_faces, face

FONT_ROOT = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Fonts'
FACES = {'Segoe UI': {400: 'segoeui.ttf', 700: 'segoeuib.ttf'},
         'Arial': {400: 'arial.ttf', 700: 'arialbd.ttf'},
         'Times New Roman': {400: 'times.ttf', 700: 'timesbd.ttf'},
         'Yu Gothic': {400: 'YuGothR.ttc', 700: 'YuGothB.ttc'},
         'MS Gothic': {400: 'msgothic.ttc'}}
ITALIC_FACES = {'Segoe UI': {400: 'segoeuii.ttf', 700: 'segoeuiz.ttf'},
                'Arial': {400: 'ariali.ttf', 700: 'arialbi.ttf'},
                'Times New Roman': {400: 'timesi.ttf', 700: 'timesbi.ttf'}}


def italic_font_faces():
    faces = {family: {weight: name for weight, name in weights.items() if (FONT_ROOT/name).is_file()}
             for family, weights in ITALIC_FACES.items()}
    return {**faces, **{family: weights for family, weights in requested_faces()[2].items() if weights}}


def fonts():
    result = [{'family': family, 'weights': [weight for weight, name in faces.items() if (FONT_ROOT/name).is_file()]}
              for family, faces in FACES.items() if any((FONT_ROOT/name).is_file() for name in faces.values())]
    for family, weights in requested_faces()[0].items():
        if weights: result.append({'family': family, 'weights': sorted(weights)})
    return result


@lru_cache(maxsize=1)
def browser_fonts():
    entries = {entry['family']: dict(entry) for entry in fonts()}
    for family in REQUESTED: entries.setdefault(family, dict(family=family, weights=[]))
    result = []
    for family, entry in entries.items():
        sample = REQUESTED[family][1] if family in REQUESTED else 'MangaClean Aa 123'
        entry['italicWeights'] = sorted(italic_font_faces().get(family, {}))
        entry.update(sample=sample, status='Missing', preview=None, license=REQUESTED[family][2] if family in REQUESTED else 'System font; no redistribution')
        if entry['weights']:
            try:
                weight = min(entry['weights'], key=lambda w:abs(w-400))
                name = font_faces()[family][weight]
                if not {ord(c) for c in sample if not c.isspace()}.issubset(coverage(name)):
                    entry.update(status='Fallback', warning='Sample glyphs unavailable; no substituted preview.')
                else:
                    font = font_at(name, 28)
                    box = font.getbbox(sample, anchor='lt')
                    image = Image.new('RGBA', (min(1200, box[2]-box[0]+12), max(40, box[3]-box[1]+12)))
                    ImageDraw.Draw(image).text((6-box[0],6), sample, font=font, fill='#eeeeee', anchor='lt')
                    output=BytesIO();image.save(output,'PNG')
                    entry.update(status='Available', preview=base64.b64encode(output.getvalue()).decode('ascii'))
            except (OSError, ValueError, KeyError) as error:
                entry.update(status='Missing', warning=str(error)[:200])
        result.append(entry)
    return result


def font_faces():
    return {**FACES, **{family:weights for family,weights in requested_faces()[0].items() if weights}}


@lru_cache(maxsize=16)
def coverage(name):
    item = face(name)
    with TTFont(item['path'], fontNumber=item['index'], lazy=True) as font:
        return frozenset((font.getBestCmap() or {}).keys())


@lru_cache(maxsize=24)
def font_at(name, size):
    item = face(name)
    font = ImageFont.truetype(str(item['path']), size, index=item['index'])
    if item['axes']: font.set_variation_by_axes(item['axes'])
    return font


def resolve_font(family, weight, text, italic=False):
    available = {entry['family']: entry['weights'] for entry in fonts()}
    if not available:
        raise ValueError('No supported system font is available. Install/select a licensed font outside this application.')
    warnings = []
    resolved = family if family in available else next(iter(available))
    if resolved != family:
        warnings.append(f'Missing font "{family}"; using {resolved}. The requested family remains saved.')
    actual_weight = min(available[resolved], key=lambda value: abs(value-weight))
    faces = font_faces()
    name = faces[resolved][actual_weight]
    required = {ord(c) for c in text if not c.isspace() and unicodedata.category(c) not in ('Cf', 'Mn', 'Me')}
    if italic:
        italic_faces = italic_font_faces().get(resolved, {})
        candidates = sorted(italic_faces, key=lambda value: abs(value-weight))
        italic_weight = next((candidate for candidate in candidates if required.issubset(coverage(italic_faces[candidate]))), None)
        if italic_weight is None:
            warnings.append(f'Italic face for this text is unavailable in {resolved}; using an upright face.')
        else:
            actual_weight, name = italic_weight, italic_faces[italic_weight]
    if not required.issubset(coverage(name)):
        fallback = next(((candidate, min(weights, key=lambda value: abs(value-weight))) for candidate, weights in available.items()
                         if required.issubset(coverage(faces[candidate][min(weights, key=lambda value: abs(value-weight))]))), None)
        if fallback:
            resolved, actual_weight = fallback
            name = faces[resolved][actual_weight]
            warnings.append(f'Glyph fallback: using {resolved} for this dialogue.')
        else:
            warnings.append('Some glyphs are missing from the available system fonts; inspect the result before exporting.')
    if actual_weight != weight:
        warnings.append(f'Requested weight {weight}; actual system face uses {actual_weight}.')
    if not features.check('raqm') and any(unicodedata.bidirectional(c) in ('R', 'AL') for c in text):
        warnings.append('Complex-script/RTL shaping is unavailable in this runtime; this renderer supports horizontal Latin/CJK.')
    return name, resolved, actual_weight, warnings


def largest_rectangle(mask):
    """Largest axis-aligned rectangle contained in the unchanged safe interior."""
    width, height = mask.size
    pixels = mask.tobytes()
    histogram = [0] * (width + 1)
    best = (0, 0, 0, 0)
    area = 0
    for row in range(height):
        for column in range(width):
            histogram[column] = histogram[column] + 1 if pixels[row*width+column] else 0
        stack = []
        for column in range(width + 1):
            start = column
            while stack and stack[-1][1] > histogram[column]:
                start, value = stack.pop()
                candidate = value * (column-start)
                if candidate > area:
                    best, area = (start, row-value+1, column-start, value), candidate
            if not stack or stack[-1][1] < histogram[column]:
                stack.append((start, histogram[column]))
    return best


def clusters(text):
    result = []
    for char in text:
        if result and (unicodedata.combining(char) or char in ('\ufe0f', '\ufe0e', '\u200d') or result[-1].endswith('\u200d')):
            result[-1] += char
        else:
            result.append(char)
    return result


def lines_for(text, font, width, spacing=0):
    """Bounded, word-preserving layout; explicit newlines remain paragraph breaks."""
    lines = []
    def length(value):
        return font.getlength(value) + (max(0, len(clusters(value))-1) * spacing if spacing else 0)
    for paragraph in text.replace('\t', '    ').split('\n'):
        # Latin words (including existing hyphens) are atomic. CJK permits
        # character boundaries, with basic closing punctuation kept together.
        units = []
        for token in re.findall(r'\s+|\S+', paragraph):
            if token.isspace():
                if units: units[-1] += token
                continue
            word = ''
            for char in clusters(token):
                if unicodedata.east_asian_width(char[0]) in ('W', 'F'):
                    if word: units.append(word); word = ''
                    if char in '、。！？）」』】' and units:
                        units[-1] += char
                    else: units.append(char)
                else:
                    word += char
            if word: units.append(word)
        if not units:
            lines.append(''); continue
        # Search balanced breaks for normal dialogue, greedy fallback for very
        # long input. Neither path splits an overlong Latin word to hide overflow.
        if len(units) > 128:
            line = ''
            for unit in units:
                if line and length((line+unit).rstrip()) > width:
                    lines.append(line.rstrip()); line = ''
                line += unit
            lines.append(line.rstrip()); continue
        costs = [(math.inf, math.inf)] * (len(units)+1)
        breaks = [0] * len(units)
        costs[-1] = (0, 0)
        for first in range(len(units)-1, -1, -1):
            candidate = ''
            for last in range(first, min(len(units), first+32)):
                candidate += units[last]
                measured = length(candidate.rstrip())
                if measured > width and last > first: break
                cost = (1+costs[last+1][0], (width-measured)**2+costs[last+1][1])
                if cost < costs[first]: costs[first], breaks[first] = cost, last+1
                if measured > width: break
        first = 0
        while first < len(units):
            last = breaks[first]
            lines.append(''.join(units[first:last]).rstrip()); first = last
    return lines


def measure(text, name, size, width, style=None):
    style = style or {}
    font = font_at(name, size)
    spacing, stroke = style.get('letter_spacing', 0), style.get('stroke_width', 0)
    lines = lines_for(text, font, max(1, width-2*stroke), spacing)
    runs, boxes = [], []
    for line in lines:
        if not spacing or not line:
            runs.append([])
            boxes.append(font.getbbox(line, anchor='lt', stroke_width=stroke))
            continue
        glyphs = clusters(line)
        cursor, run, bounds = 0, [], []
        for index, glyph in enumerate(glyphs):
            position = round(cursor)
            run.append((position, glyph))
            left, top, right, bottom = font.getbbox(glyph, anchor='ls', stroke_width=stroke)
            bounds.append((left+position, top, right+position, bottom))
            if index+1 < len(glyphs):
                following = glyphs[index+1]
                cursor += font.getlength(glyph+following)-font.getlength(following)+spacing
        runs.append(run)
        boxes.append((min(box[0] for box in bounds), min(box[1] for box in bounds),
                      max(box[2] for box in bounds), max(box[3] for box in bounds)))
    line_height = math.ceil(sum(font.getmetrics()) * 1.08 * style.get('line_height', 1))
    height = max((index*line_height + box[3]-box[1] for index, box in enumerate(boxes)), default=0)
    widest = max((box[2]-box[0] for box in boxes), default=0)
    words = re.findall(r"[A-Za-z0-9À-ÖØ-öø-ÿ]+(?:['’\-][A-Za-z0-9À-ÖØ-öø-ÿ]+)*", text)
    longest_word = max((font.getlength(word) + (len(clusters(word))-1)*spacing + 2*stroke for word in words), default=0)
    return font, lines, boxes, line_height, widest, height, longest_word, runs


def fits(measured, width, height, rotation, offset):
    widest, total_height, longest = measured[4:7]
    if max(widest, longest) > width:
        return False
    radians = math.radians(rotation)
    c, s = abs(math.cos(radians)), abs(math.sin(radians))
    rotated_width = math.ceil(widest*c + total_height*s - 1e-9)
    rotated_height = math.ceil(widest*s + total_height*c - 1e-9)
    top = (height-rotated_height)//2 + offset
    return rotated_width <= width and 0 <= top and top+rotated_height <= height


def render(dialogue, clip=None):
    start = perf_counter()
    width, height = math.ceil(dialogue['width']), math.ceil(dialogue['height'])
    if width*height > 24_000_000:
        raise ValueError('Typography layer exceeds the native image pixel budget.')
    canvas = Image.new('RGBA', (width, height))
    style = typography_style(dialogue.get('style', {}))
    name, family, weight, warnings = resolve_font(dialogue['family'], dialogue['weight'], dialogue['text'], style.get('italic', False))
    if style.get('letter_spacing') and any(unicodedata.bidirectional(char) in ('R', 'AL') for char in dialogue['text']):
        style.pop('letter_spacing')
        warnings.append('Custom letter spacing is unavailable for RTL text; default shaping is retained.')
    italic = name == italic_font_faces().get(family, {}).get(weight)
    safe = largest_rectangle(Image.open(BytesIO(base64.b64decode(clip))).convert('L')) if clip else (0, 0, width, height)
    padding = dialogue.get('padding', 8)
    x, y, w, h = safe
    x += padding; y += padding; w -= 2*padding; h -= 2*padding
    size = dialogue['size']
    rotation, offset = style.get('rotation', 0), round(style.get('vertical_offset', 0))
    layout_width = max(0, w)
    overflow = False
    if min(w, h) < 1:
        overflow = bool(dialogue['text'])
        warnings.append('No safe text area remains after padding; enlarge the box or reduce padding.')
    elif dialogue['visible'] and dialogue['text']:
        if dialogue['auto_fit']:
            low, high = min(dialogue['minimum_size'], size), size
            selected = low
            while low <= high:
                middle = (low+high)//2
                measured = measure(dialogue['text'], name, middle, w, style)
                if fits(measured, w, h, rotation, offset):
                    selected = middle; low = middle+1
                else:
                    high = middle-1
            size = selected
        measured = measure(dialogue['text'], name, size, w, style)
        font, lines, boxes, line_height, widest, total_height, longest_word, runs = measured
        overflow = not fits(measured, w, h, rotation, offset)
        if longest_word > w:
            overflow = True
            warnings.append('An unbroken word exceeds the safe width. Words are not split; enlarge the box, reduce padding/font size, or add an intentional line break.')
        if not overflow:
            layout_width = max(1, widest) if style.get('auto_width') else w
            # Rotation operates on the tight text block, inside the existing safe area.
            block_width = max(1, widest) if rotation else layout_width
            ink = Image.new('RGBA', (block_width, max(1, total_height)))
            draw = ImageDraw.Draw(ink)
            stroke = {'stroke_width': style.get('stroke_width', 0), 'stroke_fill': style.get('stroke_color', '#ffffff')}
            align = dialogue['alignment']
            for index, (line, box, run) in enumerate(zip(lines, boxes, runs)):
                row_width = box[2]-box[0]
                left = {'left': 0, 'center': (block_width-row_width)//2, 'right': block_width-row_width}[align]-box[0]
                if run:
                    for position, glyph in run:
                        draw.text((left+position, index*line_height-box[1]), glyph, font=font, fill=dialogue['color'], anchor='ls', **stroke)
                else:
                    draw.text((left, index*line_height-box[1]), line, font=font, fill=dialogue['color'], anchor='lt', **stroke)
            if rotation:
                ink = ink.rotate(-rotation, resample=Image.Resampling.BICUBIC, expand=True)
                bounds = ink.getchannel('A').getbbox()
                if bounds: ink = ink.crop(bounds)
            top = (h-ink.height)//2 + offset
            overflow = ink.width > w or top < 0 or top+ink.height > h
            if not overflow:
                left = {'left': 0, 'center': (w-ink.width)//2, 'right': w-ink.width}[align]
                canvas.alpha_composite(ink, (x+left, y+top))
    if overflow:
        warnings.append('Text overflow: no safe layout fits at the current size/minimum. This layer is not rendered in preview/export; enlarge the box or reduce the size/padding. Full text remains editable.')
    output = BytesIO(); canvas.save(output, format='PNG')
    return {'png': base64.b64encode(output.getvalue()).decode('ascii'), 'width': width, 'height': height,
            'effectiveSize': size, 'resolvedFamily': family, 'resolvedWeight': weight, 'resolvedItalic': italic, 'layoutWidth': layout_width,
            'overflow': overflow, 'warnings': warnings, 'contentRect': [x, y, max(0, w), max(0, h)],
            'durationMs': (perf_counter()-start)*1000}
