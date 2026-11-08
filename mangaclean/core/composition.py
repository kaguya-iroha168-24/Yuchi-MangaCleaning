"""Validate optional page and dialogue appearance without touching source pixels."""
import re


def _number(value, minimum, maximum):
    return type(value) in (int, float) and minimum <= value <= maximum


def typography_style(style):
    numbers = {'line_height': (.5, 3, 1), 'letter_spacing': (-4, 24, 0),
               'vertical_offset': (-200, 200, 0), 'rotation': (-180, 180, 0), 'stroke_width': (0, 12, 0)}
    defaults = {'italic': False, 'auto_width': False, 'stroke_color': '#ffffff',
                **{key: default for key, (_, _, default) in numbers.items()}}
    if not isinstance(style, dict) or set(style) - defaults.keys():
        raise ValueError('Unknown typography style properties.')
    for key, value in style.items():
        if key in numbers:
            valid = _number(value, *numbers[key][:2]) and (key != 'stroke_width' or type(value) is int)
        elif key == 'stroke_color':
            valid = isinstance(value, str) and re.fullmatch(r'#[0-9a-fA-F]{6}', value)
        else:
            valid = type(value) is bool
        if not valid:
            raise ValueError(f'Invalid typography style property: {key}.')
    clean = {**style}
    if 'stroke_color' in clean: clean['stroke_color'] = clean['stroke_color'].lower()
    return {key: value for key, value in clean.items() if value != defaults[key]}


def page_composition(values):
    defaults = {'brightness': 0, 'contrast': 0, 'artwork': 'working', 'artwork_locked': False, 'text_mode': 'clean'}
    if not isinstance(values, dict) or set(values) - defaults.keys():
        raise ValueError('Unknown page composition properties.')
    for key, value in values.items():
        if key in ('brightness', 'contrast'):
            valid = type(value) is int and -100 <= value <= 100
        elif key == 'artwork':
            valid = value in ('working', 'original', 'hidden')
        elif key == 'text_mode':
            valid = value in ('clean', 'overlay')
        else:
            valid = type(value) is bool
        if not valid:
            raise ValueError(f'Invalid page composition property: {key}.')
    return {key: value for key, value in values.items() if value != defaults[key]}
