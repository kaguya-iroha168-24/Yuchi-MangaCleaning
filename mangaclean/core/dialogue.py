"""Serializable dialogue data; no raster mutation or OCR inference."""
from dataclasses import dataclass, field
from uuid import uuid4
import math


@dataclass
class Dialogue:
    text: str = ''
    id: str = field(default_factory=lambda: uuid4().hex)
    bubble_id: str | None = None
    x: float = 0.
    y: float = 0.
    width: float = 160.
    height: float = 60.
    family: str = 'Segoe UI'
    size: int = 32  # native image pixels, independent of screen DPI/zoom
    weight: int = 400
    minimum_size: int = 12
    color: str = '#000000'
    alignment: str = 'center'
    visible: bool = True
    auto_fit: bool = True
    source_region_id: str | None = None
    padding: int = 8  # native image pixels; typography only

    def validate(self):
        if self.source_region_id is not None and (not isinstance(self.source_region_id, str) or not 1 <= len(self.source_region_id) <= 100):
            raise ValueError('Invalid source TextRegion reference.')
        if type(self.padding) is not int or not 0 <= self.padding <= 512:
            raise ValueError('Typography padding must be 0–512 native pixels.')
        if not isinstance(self.text, str) or len(self.text) > 4000:
            raise ValueError('Dialogue must contain at most 4,000 characters.')
        if self.alignment not in ('left', 'center', 'right'):
            raise ValueError('Unsupported dialogue alignment.')
        if type(self.size) is not int or not 8 <= self.size <= 144 or not isinstance(self.family,str) or not self.family or len(self.family) > 200:
            raise ValueError('Invalid font family or size (8–144 source pixels).')
        if type(self.weight) is not int or not 100 <= self.weight <= 900 or type(self.minimum_size) is not int or not 8 <= self.minimum_size <= 48:
            raise ValueError('Invalid font weight or minimum readable size (8–48 px).')
        if not all(type(v) in (int, float) and math.isfinite(v) for v in (self.x, self.y, self.width, self.height)) or not 1 <= self.width <= 20000 or not 1 <= self.height <= 2_000_000:
            raise ValueError('Invalid native text geometry.')
        if not isinstance(self.color,str) or len(self.color) != 7 or self.color[0] != '#' or any(c not in '0123456789abcdefABCDEF' for c in self.color[1:]):
            raise ValueError('Text color must be #RRGGBB.')
        if type(self.visible) is not bool or type(self.auto_fit) is not bool:
            raise ValueError('Text visibility and auto-fit must be boolean.')
