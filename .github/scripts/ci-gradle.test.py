import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("ci_gradle", Path(__file__).with_name("ci-gradle.py"))
gradle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gradle)
OK = (0, "", False)


def failure(status=403, url="https://repo.maven.apache.org/maven2/example/a.pom"):
    return (1, f"""FAILURE: Build failed with an exception.
* What went wrong:
A problem occurred configuring root project 'fixture'.
> Could not resolve all artifacts for configuration 'classpath'.
   > Could not resolve example:a:1.
      > Could not get resource '{url}'.
         > Could not GET '{url}'.
            > Received status code {status} from server: Forbidden
* Try:
> Run with --stacktrace option to get the stack trace.
""", False)


class AcquisitionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.project = self.root / "project"
        self.project.mkdir()
        self.home = self.root / "gradle-home"
        self.calls = []
        self.sleeps = []

    def execute(self, responses):
        responses = iter(responses)

        def run(command, cwd, env, budget, capture=True):
            self.assertEqual(cwd, self.project)
            self.assertEqual(len(list((self.home / "init.d").glob("dbx-ci-acquire-*.gradle"))), 1)
            self.calls.append((command, dict(env), budget, capture))
            result = next(responses)
            if isinstance(result, BaseException):
                raise result
            return result

        with patch.dict(os.environ, {"GRADLE_USER_HOME": str(self.home)}):
            try:
                return gradle.acquire_and_run(self.project, "agents", ["original", "test", "shadowJar", "--continue"],
                                              runner=run, sleep=self.sleeps.append)
            finally:
                self.assertFalse(list((self.home / "init.d").glob("dbx-ci-acquire-*.gradle")))

    def test_success_acquires_before_one_offline_original_command(self):
        self.assertEqual(self.execute([OK, OK, OK]), 0)
        self.assertEqual([call[2] for call in self.calls], [180, 600, None])
        self.assertEqual(self.calls[1][0][-1], "dbxCiAcquireDependencies")
        self.assertEqual(self.calls[2][0], ["original", "test", "shadowJar", "--continue"])
        self.assertEqual(self.calls[2][1]["DBX_CI_GRADLE_PHASE"], "execute")
        self.assertEqual(self.calls[2][1]["DBX_CI_GRADLE_SOURCE"], "primary")
        self.assertFalse(self.calls[2][3])
        self.assertEqual(self.sleeps, [])

    def test_public_forbidden_switches_once_without_repeating_original(self):
        self.assertEqual(self.execute([OK, failure(), OK, OK]), 0)
        self.assertEqual([call[1]["DBX_CI_GRADLE_SOURCE"] for call in self.calls],
                         ["primary", "primary", "backup", "backup"])
        self.assertEqual(self.sleeps, [])

    def test_transient_retries_once_before_backup(self):
        self.assertEqual(self.execute([OK, failure(503), failure(503), OK, OK]), 0)
        self.assertEqual(self.sleeps, [2])
        self.assertEqual([call[1]["DBX_CI_GRADLE_SOURCE"] for call in self.calls[1:]],
                         ["primary", "primary", "backup", "backup"])

    def test_backup_failure_and_execution_failure_are_terminal(self):
        for responses, count in [([OK, failure(), failure(), failure()], 4),
                                 ([OK, OK, failure()], 3)]:
            with self.subTest(responses=responses):
                self.calls.clear()
                self.assertEqual(self.execute(responses), 1)
                self.assertEqual(len(self.calls), count)

    def test_forbidden_preserves_remaining_attempt_for_backup(self):
        backup_error = failure(503, "https://maven-central.storage-download.googleapis.com/maven2/example/a.pom")
        self.assertEqual(self.execute([OK, failure(), backup_error, OK, OK]), 0)
        self.assertEqual([call[1]["DBX_CI_GRADLE_SOURCE"] for call in self.calls[1:]],
                         ["primary", "backup", "backup", "backup"])
        self.assertEqual(self.sleeps, [2])

    def test_timeout_recovers_only_acquisition(self):
        timeout = (-9, "Downloading dependencies\n", True)
        self.assertEqual(self.execute([OK, timeout, timeout, OK, OK]), 0)
        self.assertEqual(self.sleeps, [2])

    def test_wrapper_has_separate_bounded_retry_and_no_project_task(self):
        self.assertEqual(self.execute([(1, "java.net.SocketTimeoutException: Read timed out", False), OK, OK, OK]), 0)
        self.assertEqual(self.sleeps, [2])
        self.assertTrue(all(call[0][-1] == "--version" for call in self.calls[:2]))

    def test_deterministic_private_and_mixed_failures_do_not_switch(self):
        errors = [failure(404), failure(401), failure(url="https://private.test/maven2/a.pom"),
                  failure(url="https://user:password@repo.maven.apache.org/maven2/a.pom"),
                  failure(url="https://repo.maven.apache.org/maven2/a.pom?token=secret"),
                  (1, failure()[1] + "\n> No space left on device", False),
                  (1, failure()[1].replace("* Try:", "> PKIX certificate failure\n* Try:"), False),
                  (1, failure()[1].replace("* Try:", "> An unknown failure\n* Try:"), False)]
        for error in errors:
            with self.subTest(error=error):
                self.calls.clear()
                self.assertEqual(self.execute([OK, error]), 1)
                self.assertEqual(len(self.calls), 2)

    def test_unknown_wrapper_failure_does_not_enter_acquisition(self):
        self.assertEqual(self.execute([(1, "checksum verification failed", False)]), 1)
        self.assertEqual(len(self.calls), 1)

    def test_cancellation_never_switches_and_preserves_other_init_scripts(self):
        directory = self.home / "init.d"
        directory.mkdir(parents=True)
        other = directory / "existing.gradle"
        other.write_text("// existing")
        with self.assertRaises(gradle.Cancelled):
            self.execute([OK, gradle.Cancelled(signal.SIGTERM)])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(other.read_text(), "// existing")

    def test_original_exception_still_cleans_up(self):
        with self.assertRaises(OSError):
            self.execute([OK, OK, OSError("cannot start original")])
        self.assertEqual(len(self.calls), 3)

    @unittest.skipUnless(sys.platform == "linux", "requires Linux process groups")
    def test_spawn_cancellation_reaps_child_before_init_cleanup(self):
        events = []
        with patch.object(gradle.signal, "signal"), patch.object(gradle.os, "killpg", side_effect=lambda *_: events.append("kill")), \
                patch.object(gradle.subprocess, "Popen") as popen:
            child = popen.return_value
            child.communicate.side_effect = lambda: (events.append("reap") or "", None)

            def spawn(*_args, **_kwargs):
                gradle.cancel(signal.SIGTERM, None)
                return child

            popen.side_effect = spawn
            with self.assertRaises(gradle.Cancelled):
                gradle.run_process(["gradle"], self.project, {}, 1)
        self.assertEqual(events, ["kill", "reap"])

    @unittest.skipUnless(sys.platform == "linux", "requires Linux process groups and /proc")
    def test_timeout_and_cancellation_dispose_owned_descendants(self):
        for signum in [0, signal.SIGTERM, signal.SIGINT]:
            with self.subTest(signum=signum):
                case = self.root / str(signum)
                case.mkdir()
                pids = case / "pids"
                harness = textwrap.dedent("""
                    import importlib.util, os, signal, sys
                    from pathlib import Path
                    spec = importlib.util.spec_from_file_location('acquire', sys.argv[1])
                    acquire = importlib.util.module_from_spec(spec); spec.loader.exec_module(acquire)
                    signal.signal(signal.SIGINT, acquire.cancel)
                    signal.signal(signal.SIGTERM, acquire.cancel)
                    os.environ['GRADLE_USER_HOME'] = sys.argv[2]
                    payload = '''import os, subprocess, sys, time
                    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
                    with open(sys.argv[1], 'a') as output: print(os.getpid(), child.pid, file=output)
                    time.sleep(60)
                    '''
                    def run(command, cwd, env, budget, capture=True):
                        if command[-1] == '--version': return 0, '', False
                        if not capture: raise RuntimeError('execution reached without acquisition')
                        return acquire.run_process([sys.executable, '-c', payload, sys.argv[3]], cwd, env, 1)
                    try:
                        code = acquire.acquire_and_run(Path(sys.argv[2]), 'agents', ['original'], runner=run, sleep=lambda _: None)
                        sys.exit(code)
                    except acquire.Cancelled as error:
                        sys.exit(128 + error.signum)
                """)
                process = subprocess.Popen([sys.executable, "-c", harness, gradle.__file__,
                                            str(case), str(pids)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                try:
                    deadline = time.monotonic() + 10
                    while (not pids.exists() or not pids.read_text().strip()) and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(pids.exists() and pids.read_text().strip(), "fake acquisition did not start")
                    if signum:
                        process.send_signal(signum)
                    output = process.communicate(timeout=10)[0]
                    self.assertNotEqual(process.returncode, 0, output)
                    self.assertNotIn("phase=execute", output)
                    self.assertEqual(len(pids.read_text().splitlines()), 1 if signum else 3)
                    self.assertFalse(list((case / "init.d").glob("dbx-ci-acquire-*.gradle")))
                    for pid in pids.read_text().split():
                        status = Path(f"/proc/{pid}/stat")
                        deadline = time.monotonic() + 5
                        while status.exists() and status.read_text().split()[2] != "Z" and time.monotonic() < deadline:
                            time.sleep(0.02)
                        self.assertTrue(not status.exists() or status.read_text().split()[2] == "Z", f"owned child {pid} survived")
                finally:
                    if pids.exists():
                        for line in pids.read_text().splitlines():
                            try:
                                os.killpg(int(line.split()[0]), signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
