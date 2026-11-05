"""Bounded runtime reuse without OCR models; exercise real owned subprocesses."""
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event,Timer
from unittest import TestCase,main
from unittest.mock import patch
import sys,time
import numpy as np
from mangaclean.services import ocr


class OCRRuntimeTests(TestCase):
    def setUp(self):
        self.folder=TemporaryDirectory(dir=ocr.ROOT/'.cache');self.script=Path(self.folder.name)/'fake_runtime.py'
        self.script.write_text('''import sys,json,os,time
from pathlib import Path
for line in sys.stdin:
 request=json.loads(Path(line.strip()).read_text())
 print('OCR stage: recognition',flush=True)
 time.sleep(request.get('delay',0))
 Path(request['output']).write_text(json.dumps({'ok':True,'result':{'text':request['marker'],'pid':os.getpid()}}))
''')
        self.command=patch.object(ocr.MangaOCRProvider,'command',return_value=[sys.executable,'-B',str(self.script)]);self.command.start()
        self.crop=np.zeros((20,50,3),np.uint8);self.crop[0]=255
        self.config=dict(provider='manga_ocr',device='cpu',timeout_seconds=3,marker='first')
    def tearDown(self):
        if callable(getattr(ocr,'close_ocr',None)):ocr.close_ocr()
        self.command.stop();self.folder.cleanup()
    def test_sequential_requests_reuse_process_without_stale_result(self):
        first=ocr.recognize(self.crop,self.config,Event())
        second=ocr.recognize(self.crop,dict(self.config,marker='second'),Event())
        self.assertEqual((first['text'],second['text']),('first','second'))
        self.assertEqual(first['pid'],second['pid'])
    def test_idle_worker_exits_and_next_request_starts_fresh(self):
        self.assertTrue(hasattr(ocr,'RUNTIME_IDLE_SECONDS'),'Runtime must have a bounded idle lifetime')
        with patch.object(ocr,'RUNTIME_IDLE_SECONDS',.1):
            first=ocr.recognize(self.crop,self.config,Event());process=ocr._runtime.process
            deadline=time.monotonic()+3
            while process.poll() is None and time.monotonic()<deadline:time.sleep(.02)
            self.assertIsNotNone(process.poll(),'Idle OCR worker was retained')
            second=ocr.recognize(self.crop,dict(self.config,marker='after idle'),Event())
            self.assertEqual(second['text'],'after idle');self.assertNotEqual(first['pid'],second['pid'])
    def test_previous_idle_callback_cannot_evict_recent_request(self):
        ocr.recognize(self.crop,self.config,Event());old_timer=ocr._runtime.timer;process=ocr._runtime.process
        ocr.recognize(self.crop,dict(self.config,marker='recent'),Event())
        old_timer.function()
        self.assertIsNone(process.poll(),'A stale idle callback stopped a recently used worker')
    def test_cancellation_discards_worker_and_does_not_leak_response(self):
        cancel=Event();timer=Timer(.1,cancel.set);timer.start()
        try:self.assertRaises(ocr.OCRCancelled,ocr.recognize,self.crop,dict(self.config,delay=.5),cancel)
        finally:timer.cancel()
        result=ocr.recognize(self.crop,dict(self.config,marker='after cancel'),Event())
        self.assertEqual(result['text'],'after cancel')
    def test_timeout_and_shutdown_release_owned_worker(self):
        self.assertTrue(callable(getattr(ocr,'close_ocr',None)),'Explicit worker shutdown is required')
        self.assertRaises(ocr.OCRUnavailable,ocr.recognize,self.crop,dict(self.config,delay=.5,timeout_seconds=.1),Event())
        result=ocr.recognize(self.crop,self.config,Event());process=ocr._runtime.process
        ocr.close_ocr();self.assertIsNotNone(process.poll());self.assertEqual(result['text'],'first')


if __name__=='__main__':main()
