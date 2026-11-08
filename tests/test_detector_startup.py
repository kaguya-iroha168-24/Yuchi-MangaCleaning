"""Real subprocess proof: cold detector startup must not populate bytecode caches."""
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from time import monotonic, sleep
import os
import sys
import unittest
from unittest.mock import Mock, patch

from mangaclean.services import yuchi_process as detector
from scripts.yuchi_inference import automatic_device


class DetectorStartup(unittest.TestCase):
    def test_auto_uses_cuda_only_when_free_memory_can_support_the_model(self):
        torch = Mock()
        torch.cuda.is_available.return_value = False
        self.assertEqual(automatic_device(torch), 'cpu')
        torch.cuda.mem_get_info.assert_not_called()
        torch.cuda.is_available.return_value = True
        torch.cuda.mem_get_info.return_value = (2 * 2**30, 4 * 2**30)
        self.assertEqual(automatic_device(torch), 'cpu')
        torch.cuda.mem_get_info.return_value = (3 * 2**30, 4 * 2**30)
        self.assertEqual(automatic_device(torch), 'cuda:0')
        with patch('scripts.yuchi_inference._MODEL_KEY', ('path', 'checksum', 'cuda:0')):
            torch.cuda.mem_get_info.return_value = (2 * 2**30, 4 * 2**30)
            self.assertEqual(automatic_device(torch), 'cuda:0')

    def test_startup_skips_inference_when_hardware_headroom_is_unavailable(self):
        with patch.object(detector, 'startup_gpu_available', return_value=False), patch.object(detector, 'YuchiProcess') as process:
            self.assertIsNone(detector.warm_detector(Event()))
            process.assert_not_called()

    def test_closing_during_preload_releases_the_inference_process(self):
        with TemporaryDirectory(dir=detector.ROOT/'.cache') as temporary:
            root = Path(temporary)
            scripts = root/'scripts'
            scripts.mkdir()
            worker = scripts/'yuchi_inference.py'
            worker.write_text('import sys, time\nfor line in sys.stdin: time.sleep(30)\n')
            config = dict(inference_python=sys.executable, checkpoint=str(worker), timeout_seconds=8)
            cancel = Event()
            with patch.object(detector, 'ROOT', root), patch.object(detector, 'startup_gpu_available', return_value=True), patch.object(detector, 'detection_config', return_value=config):
                thread = Thread(target=detector.warm_detector, args=(cancel,))
                detector.close_detector()
                thread.start()
                try:
                    deadline = monotonic() + 3
                    while detector._session is None and monotonic() < deadline:
                        sleep(.025)
                    self.assertIsNotNone(detector._session)
                    process = detector._session.process
                    cancel.set()
                    thread.join(4)
                    self.assertFalse(thread.is_alive())
                    self.assertIsNotNone(process.poll())
                    self.assertIsNone(detector._session)
                finally:
                    cancel.set()
                    thread.join(5)
                    detector.close_detector()

    def test_cold_worker_does_not_write_bytecode_and_closes_normally(self):
        detector.close_detector()
        with TemporaryDirectory(dir=detector.ROOT/'.cache') as temporary:
            root=Path(temporary);scripts=root/'scripts';scripts.mkdir()
            (scripts/'startup_fixture.py').write_text('VALUE = 42\n')
            worker=scripts/'yuchi_inference.py'
            worker.write_text('''import sys,json,os
from pathlib import Path
import startup_fixture
for line in sys.stdin:
    request=json.loads(Path(json.loads(line)).read_text())
    result={'ok':True,'hardware':{'value':startup_fixture.VALUE,'bytecodeDisabled':sys.dont_write_bytecode,'cacheWrites':int(Path(startup_fixture.__cached__).is_file())}}
    target=Path(request['output']);temporary=target.with_suffix('.tmp')
    temporary.write_text(json.dumps(result));os.replace(temporary,target)
''')
            config=dict(inference_python=sys.executable,checkpoint=str(worker),timeout_seconds=5)
            with patch.object(detector,'ROOT',root),patch.dict(os.environ):
                os.environ.pop('PYTHONDONTWRITEBYTECODE',None)
                try:
                    result=detector.YuchiProcess(config).probe()
                    process=detector._session.process
                    self.assertEqual(result['value'],42)
                    self.assertTrue(result['bytecodeDisabled'],'Cold inference currently writes imported modules to its per-release cache.')
                    self.assertEqual(result['cacheWrites'],0)
                finally:detector.close_detector()
                self.assertIsNotNone(process.poll())


if __name__=='__main__':unittest.main()
