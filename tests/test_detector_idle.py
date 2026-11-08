"""Bound detector cache lifetime; exercise owned subprocesses without AI models."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main
from unittest.mock import patch
from threading import Event, Thread
import subprocess
import sys
import time

from mangaclean.services import yuchi_process as detector


class DetectorIdleTests(TestCase):
    def setUp(self):
        detector.close_detector()
        self.folder = TemporaryDirectory(dir=detector.ROOT/'.cache')
        self.script = Path(self.folder.name)/'fake_detector.py'
        self.script.write_text('''import sys,json,os,time
from pathlib import Path
for line in sys.stdin:
 request=json.loads(Path(json.loads(line)).read_text())
 time.sleep(request.get('delay',0))
 output=Path(request['output'])
 pending=output.with_suffix('.tmp')
 pending.write_text(json.dumps({'ok':True,'hardware':{'pid':os.getpid(),'marker':request.get('marker','first')}}))
 os.replace(pending,output)
''')
        original = subprocess.Popen
        def launch(command, **kwargs):
            return original([command[0], '-B', str(self.script)], **kwargs)
        self.process_patch = patch.object(detector.subprocess, 'Popen', side_effect=launch)
        self.process_patch.start()
        self.config = dict(inference_python=sys.executable, checkpoint=str(self.script), timeout_seconds=2)

    def tearDown(self):
        detector.close_detector()
        self.process_patch.stop()
        self.folder.cleanup()

    def probe(self, **changes):
        return detector.YuchiProcess(dict(self.config, **changes)).probe()

    def require_idle_policy(self):
        self.assertTrue(hasattr(detector, 'DETECTOR_IDLE_SECONDS'), 'Detector worker must have a bounded idle lifetime')

    def test_idle_exit_and_fresh_request_preserve_results(self):
        self.require_idle_policy()
        with patch.object(detector, 'DETECTOR_IDLE_SECONDS', .1):
            first = self.probe(); process = detector._session.process
            deadline = time.monotonic()+3
            while process.poll() is None and time.monotonic()<deadline: time.sleep(.02)
            self.assertIsNotNone(process.poll(), 'Idle detector retained its model process')
            second = self.probe()
            self.assertNotEqual(first['pid'], second['pid'])
            self.assertEqual((first['marker'], second['marker']), ('first', 'first'))

    def test_burst_reuses_process_and_stale_callback_cannot_evict_it(self):
        self.require_idle_policy()
        first = self.probe(); session = detector._session; old_timer = session.idle_timer
        second = self.probe()
        old_timer.function()
        self.assertEqual(first['pid'], second['pid'])
        self.assertIs(detector._session, session)
        self.assertIsNone(session.process.poll())

    def test_changed_configuration_and_old_timer_cannot_evict_replacement(self):
        self.require_idle_policy()
        self.probe(); old = detector._session; old_timer = old.idle_timer
        result = self.probe(marker='replacement'); current = detector._session
        old_timer.function()
        self.assertIsNotNone(old.process.poll())
        self.assertIs(detector._session, current)
        self.assertEqual(result['marker'], 'replacement')
        self.assertIsNone(current.process.poll())

    def test_shutdown_and_timeout_leave_no_owned_worker(self):
        self.require_idle_policy()
        self.probe(); session = detector._session; timer = session.idle_timer
        detector.close_detector(); timer.function()
        self.assertIsNotNone(session.process.poll())
        self.assertIsNone(detector._session)
        self.assertRaises(detector.DetectorUnavailable, self.probe, delay=.2, timeout_seconds=.01)
        self.assertIsNone(detector._session)
        self.assertEqual(self.probe()['marker'], 'first')

    def test_idle_timer_start_failure_preserves_completed_result(self):
        self.require_idle_policy()
        with patch.object(detector.threading.Timer, 'start', side_effect=RuntimeError('controlled timer failure')):
            result = self.probe()
        self.assertEqual(result['marker'], 'first')
        self.assertIsNone(detector._session)

    def test_response_io_error_releases_worker_after_idle_timer_was_cancelled(self):
        self.require_idle_policy()
        for failure, expected in ((OSError('controlled read failure'), detector.DetectorUnavailable),
                                  (ValueError('controlled malformed response'), ValueError)):
            with self.subTest(error=type(failure).__name__):
                self.probe(); session = detector._session
                with patch.object(detector, 'read_response', side_effect=failure):
                    self.assertRaises(expected, self.probe)
                self.assertIsNone(detector._session)
                self.assertIsNotNone(session.process.poll())

    def test_old_callback_waiting_for_active_request_cannot_close_recent_result(self):
        self.require_idle_policy()
        self.probe(); session = detector._session; timer = session.idle_timer
        entered = Event(); release = Event(); outcome = []
        original = detector.read_response
        def blocked_read(path, deadline):
            entered.set()
            if not release.wait(3): raise RuntimeError('Test gate timed out')
            return original(path, deadline)
        def request():
            try: outcome.append(self.probe())
            except Exception as error: outcome.append(error)
        with patch.object(detector, 'read_response', side_effect=blocked_read):
            thread = Thread(target=request); thread.start()
            self.assertTrue(entered.wait(3))
            callback = Thread(target=timer.function); callback.start()
            self.assertIsNone(session.process.poll())
            release.set(); thread.join(3); callback.join(3)
        self.assertFalse(thread.is_alive()); self.assertFalse(callback.is_alive())
        self.assertEqual(len(outcome), 1); self.assertIsInstance(outcome[0], dict)
        self.assertIs(detector._session, session); self.assertIsNone(session.process.poll())


if __name__ == '__main__': main()
