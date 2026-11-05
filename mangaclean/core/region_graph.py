"""Native-coordinate source text, independent from raster masks and typesetting."""
from copy import deepcopy
from dataclasses import dataclass, field, asdict, replace
from hashlib import sha256
import json
from uuid import uuid4, uuid5, NAMESPACE_URL


KINDS = ('dialogue', 'narration', 'sfx', 'sign', 'other')
DIRECTIONS = ('unspecified', 'ltr', 'rtl', 'vertical')
MAX_REGIONS = 1000


def image_digest(image):
    return sha256(image.tobytes()).hexdigest()


def valid_id(value):
    return isinstance(value, str) and 1 <= len(value) <= 100 and not any(ord(c) < 32 for c in value)


@dataclass(frozen=True)
class BubbleContainer:
    """Geometry view of an existing Bubble; masks remain owned by that Bubble."""
    id: str
    rect: tuple[int, int, int, int]


@dataclass
class TextRegion:
    rect: tuple[int, int, int, int]
    id: str = field(default_factory=lambda: uuid4().hex)
    bubble_id: str | None = None
    source_text: str = ''
    kind: str = 'dialogue'
    language: str = 'und'
    direction: str = 'unspecified'
    provenance: dict = field(default_factory=lambda: {'origin': 'manual'})


@dataclass
class RegionGraph:
    page_id: str = field(default_factory=lambda: uuid4().hex)
    text_regions: list[TextRegion] = field(default_factory=list)
    reading_order: list[str] = field(default_factory=list)
    source_sha256: str | None = None

    @staticmethod
    def containers(bubbles):
        return [BubbleContainer(b.id, tuple(b.rect)) for b in bubbles]

    def region(self, identifier):
        return next((r for r in self.text_regions if r.id == identifier), None)

    def validate(self, shape, bubbles):
        if not valid_id(self.page_id):
            raise ValueError('Invalid graph page ID.')
        if self.source_sha256 is not None and (not isinstance(self.source_sha256, str)
                or len(self.source_sha256) != 64 or any(c not in '0123456789abcdef' for c in self.source_sha256)):
            raise ValueError('Invalid graph source fingerprint.')
        if not isinstance(self.text_regions, list) or len(self.text_regions) > MAX_REGIONS:
            raise ValueError(f'Project supports at most {MAX_REGIONS} source text regions.')
        ids = [r.id for r in self.text_regions]
        containers = [b.id for b in bubbles]
        if any(not valid_id(v) for v in ids+containers) or len(set(ids)) != len(ids) or len(set(containers)) != len(containers):
            raise ValueError('Invalid or duplicate region/container IDs.')
        if (not isinstance(self.reading_order, list) or any(not valid_id(v) for v in self.reading_order)
                or len(self.reading_order) != len(ids) or set(self.reading_order) != set(ids)):
            raise ValueError('Reading order must include every source region exactly once.')
        height, width = shape[:2]
        for r in self.text_regions:
            if (not isinstance(r.rect, (tuple, list)) or len(r.rect) != 4
                    or any(type(v) is not int for v in r.rect)):
                raise ValueError('Text region coordinates must be native integer x/y/width/height.')
            x, y, w, h = r.rect
            if min(x, y) < 0 or min(w, h) < 1 or x+w > width or y+h > height:
                raise ValueError('Text region is outside the native image.')
            if r.bubble_id is not None and r.bubble_id not in containers:
                raise ValueError('Text region references a missing bubble container.')
            if not isinstance(r.source_text, str) or len(r.source_text) > 20000:
                raise ValueError('Source transcription exceeds 20,000 characters.')
            if r.kind not in KINDS or r.direction not in DIRECTIONS:
                raise ValueError('Invalid source region kind or reading direction.')
            if not isinstance(r.language, str) or not 1 <= len(r.language) <= 40:
                raise ValueError('Invalid source language tag.')
            if not isinstance(r.provenance, dict) or len(json.dumps(r.provenance, allow_nan=False)) > 20000:
                raise ValueError('Invalid source transcription provenance.')
            if 'ocr' in r.provenance:
                from .ocr_result import validate_ocr
                validate_ocr(r.provenance['ocr'])
        if len(json.dumps(self.to_dict(), ensure_ascii=False, allow_nan=False).encode('utf-8')) > 1_500_000:
            raise ValueError('Source region graph exceeds the project metadata budget.')
        return self

    def to_dict(self):
        return {'schema_version': 1, 'page_id': self.page_id, 'source_sha256': self.source_sha256,
                'text_regions': [asdict(r) for r in self.text_regions], 'reading_order': list(self.reading_order)}

    @classmethod
    def from_dict(cls, data, shape, bubbles):
        if not isinstance(data, dict) or type(data.get('schema_version')) is not int or data['schema_version'] != 1:
            raise ValueError('Unsupported source region graph schema.')
        expected = {'schema_version', 'page_id', 'source_sha256', 'text_regions', 'reading_order'}
        if set(data) != expected or not isinstance(data['text_regions'], list):
            raise ValueError('Invalid source graph fields; refusing a potentially lossy migration.')
        try:
            graph = cls(page_id=data['page_id'], source_sha256=data['source_sha256'],
                        text_regions=[TextRegion(**entry) for entry in data['text_regions']],
                        reading_order=data['reading_order'])
            for r in graph.text_regions:
                r.rect = tuple(r.rect)
            return graph.validate(shape, bubbles)
        except (TypeError, KeyError) as error:
            raise ValueError(f'Invalid source region graph: {error}') from error

    @classmethod
    def for_legacy(cls, source, name):
        digest = image_digest(source)
        # Reopening the same v1 page yields the same identity, without inventing
        # semantic text regions from connected-component/glyph rectangles.
        return cls(page_id=uuid5(NAMESPACE_URL, 'mangaclean:'+digest+':'+name).hex, source_sha256=digest)

    def detached(self, bubble_ids):
        """Preserve transcription and order when an explicitly deleted container goes away."""
        graph = deepcopy(self)
        for r in graph.text_regions:
            if r.bubble_id is not None and r.bubble_id not in bubble_ids:
                r.provenance = dict(r.provenance, detached_from_bubble=r.bubble_id)
                r.bubble_id = None
        return graph

    def add(self, region):
        if self.region(region.id) is not None:
            raise ValueError('Duplicate source text ID.')
        self.text_regions.append(deepcopy(region))
        self.reading_order.append(region.id)

    def update(self, identifier, **values):
        old = self.region(identifier)
        if old is None:
            raise ValueError('Source text region no longer exists.')
        if 'id' in values:
            raise ValueError('Source text IDs are immutable.')
        self.text_regions[self.text_regions.index(old)] = replace(old, **values)

    def remove(self, identifier):
        if self.region(identifier) is None:
            raise ValueError('Source text region no longer exists.')
        self.text_regions = [r for r in self.text_regions if r.id != identifier]
        self.reading_order.remove(identifier)

    def move(self, identifier, position):
        if identifier not in self.reading_order or type(position) is not int or not 0 <= position < len(self.reading_order):
            raise ValueError('Invalid manual reading-order position.')
        self.reading_order.remove(identifier)
        self.reading_order.insert(position, identifier)
