"""Private JSON-lines worker. No Torch, OCR, model access or environment mutation."""
from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mangaclean.services.typesetting_render import browser_fonts, render


for line in sys.stdin:
    try:
        request = json.loads(line)
        if request.get('action') == 'close':
            break
        if request.get('action') == 'fonts':
            result = {'fonts': browser_fonts(), 'aiImported': any(name in sys.modules for name in ('torch', 'manga_ocr', 'ultralytics'))}
        else:
            result = render(request['dialogue'], request.get('clip'))
        response = {'ok': True, 'result': result}
    except Exception as error:
        response = {'ok': False, 'error': str(error)[:1000]}
    print(json.dumps(response, ensure_ascii=True, allow_nan=False), flush=True)
