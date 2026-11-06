"""Resume must reuse valid files and repair incomplete/corrupt copies."""
from pathlib import Path
import importlib.util
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('staging',ROOT/'scripts/stage_release.py')
staging=importlib.util.module_from_spec(spec);spec.loader.exec_module(staging)

class ResumeStaging(unittest.TestCase):
    def test_valid_copy_is_reused_and_corrupt_equal_size_is_repaired(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/sumi-hikari') as temporary:
            source=Path(temporary)/'source';target=Path(temporary)/'target'
            source.write_bytes(b'correct');staging.copy_verified(source,target)
            stamp=target.stat().st_mtime_ns
            staging.copy_verified(source,target)
            self.assertEqual(target.stat().st_mtime_ns,stamp)
            target.write_bytes(b'corrupt');staging.copy_verified(source,target)
            self.assertEqual(target.read_bytes(),b'correct')
            target.write_bytes(b'partial-copy');staging.copy_verified(source,target)
            self.assertEqual(target.read_bytes(),b'correct')

    def test_resume_cannot_target_source_or_protected_folders(self):
        for path in [ROOT,ROOT.parent/'Yuchi Labs',ROOT/'releases']:
            with self.assertRaises(SystemExit):staging.stage(path)

if __name__=='__main__':unittest.main()
