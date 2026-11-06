"""Real subprocess proof: cold detector startup must not populate bytecode caches."""
from pathlib import Path
from tempfile import TemporaryDirectory
import os
import sys
import unittest
from unittest.mock import patch

from mangaclean.services import yuchi_process as detector


class DetectorStartup(unittest.TestCase):
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
