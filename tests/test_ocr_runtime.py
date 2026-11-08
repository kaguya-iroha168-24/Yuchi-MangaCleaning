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
 output=Path(request['output']);temp=output.with_suffix('.tmp')
 temp.write_text(json.dumps({'ok':True,'result':{'text':request['marker'],'pid':os.getpid()}}));temp.replace(output)
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
    def test_windows_worker_reuse_is_independent_of_manga_and_releases_on_shutdown(self):
        with patch.object(ocr.WindowsOCRProvider,'command',return_value=[sys.executable,'-B',str(self.script)]):
            config=dict(self.config,provider='windows_ocr')
            first=ocr.recognize(self.crop,config,Event())
            manga=ocr.recognize(self.crop,self.config,Event())
            second=ocr.recognize(self.crop,dict(config,marker='second'),Event())
        self.assertEqual(first['pid'],second['pid'])
        self.assertNotEqual(manga['pid'],second['pid'])
        self.assertEqual(second['text'],'second')
        processes=[worker.process for worker in ocr._runtimes.values()]
        ocr.close_ocr()
        self.assertEqual(len(processes),2)
        self.assertTrue(all(process.poll() is not None for process in processes))
    def test_result_temporarily_locked_after_publication_is_read_without_restarting(self):
        read_text=Path.read_text
        denied=[]
        def temporarily_locked(path,*args,**kwargs):
            if path.name=='result.json' and not denied:
                denied.append(path)
                raise PermissionError('Result is temporarily locked')
            return read_text(path,*args,**kwargs)
        with patch.object(Path,'read_text',temporarily_locked):
            first=ocr.recognize(self.crop,self.config,Event())
        second=ocr.recognize(self.crop,dict(self.config,marker='second'),Event())
        self.assertEqual(len(denied),1)
        self.assertEqual(first['pid'],second['pid'])
        self.assertEqual(second['text'],'second')
    def test_idle_worker_exits_and_next_request_starts_fresh(self):
        self.assertTrue(hasattr(ocr,'RUNTIME_IDLE_SECONDS'),'Runtime must have a bounded idle lifetime')
        create=ocr._Runtime
        started=[]
        def capture(*args):
            runtime=create(*args);started.append(runtime.process);return runtime
        with patch.object(ocr,'RUNTIME_IDLE_SECONDS',.1),patch.object(ocr,'_Runtime',side_effect=capture):
            first=ocr.recognize(self.crop,self.config,Event());process=started[0]
            deadline=time.monotonic()+3
            while process.poll() is None and time.monotonic()<deadline:time.sleep(.02)
            self.assertIsNotNone(process.poll(),'Idle OCR worker was retained')
            second=ocr.recognize(self.crop,dict(self.config,marker='after idle'),Event())
            self.assertEqual(second['text'],'after idle');self.assertNotEqual(first['pid'],second['pid'])
    def test_previous_idle_callback_cannot_evict_recent_request(self):
        ocr.recognize(self.crop,self.config,Event());old_timer=ocr._runtimes['--serve'].timer;process=ocr._runtimes['--serve'].process
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
        result=ocr.recognize(self.crop,self.config,Event());process=ocr._runtimes['--serve'].process
        ocr.close_ocr();self.assertIsNotNone(process.poll());self.assertEqual(result['text'],'first')


if __name__=='__main__':main()
