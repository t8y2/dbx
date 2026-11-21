import http.server
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import unittest

SCRIPT = Path(__file__).with_name("ci-install-mold.sh")


@unittest.skipUnless(sys.platform == "linux", "requires the Linux CI shell and curl")
class MoldDownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.downloads = self.root / "downloads"
        self.downloads.mkdir()
        self.statuses = [200]
        self.requests = 0
        self.started = threading.Event()
        self.release = threading.Event()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                status = owner.statuses[min(owner.requests, len(owner.statuses) - 1)]
                owner.requests += 1
                self.send_response(200 if status == "partial" else status)
                self.send_header("Content-Length", "1000" if status == "partial" else "7")
                self.end_headers()
                self.wfile.write(b"archive")
                self.wfile.flush()
                owner.started.set()
                if status == "partial":
                    owner.release.wait(10)

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(self.release.set)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "REAL_CURL": shutil.which("curl"), "TEST_URL": f"http://127.0.0.1:{server.server_port}/mold",
                    "TEST_ROOT": str(self.root), "TMPDIR": str(self.downloads)}
        self.tool("curl", """import os, sys
args = sys.argv[1:]
assert '--retry-all-errors' not in args
for option, value in [('--retry', '2'), ('--connect-timeout', '15'), ('--max-time', '120'), ('--retry-max-time', '360')]:
    assert args[args.index(option) + 1] == value
assert 'https://github.com/rui314/mold/releases/download/v2.42.1/mold-2.42.1-x86_64-linux.tar.gz' in args
args = [os.environ['TEST_URL'] if arg.startswith('https://') else arg for arg in args]
os.execv(os.environ['REAL_CURL'], [os.environ['REAL_CURL'], *args])
""")
        self.tool("sudo", """import os, sys
from pathlib import Path
assert sys.argv[1:6] == ['tar', '-C', '/usr/local', '--strip-components=1', '-xzf']
assert Path(sys.argv[-1]).read_bytes() == b'archive'
with (Path(os.environ['TEST_ROOT']) / 'installed').open('a') as output: output.write('once\\n')
""")
        self.tool("mold", "print('mold 2.42.1')\n")

    def tool(self, name, body):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o755)

    def run_script(self):
        result = subprocess.run(["bash", str(SCRIPT)], env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(list(self.downloads.iterdir()), [])
        return result

    def test_transient_status_recovers_before_one_install(self):
        self.statuses = [503, 503, 200]
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.requests, 3)
        self.assertEqual((self.root / "installed").read_text(), "once\n")

    def test_not_found_and_exhausted_retries_never_install(self):
        for statuses, requests in [([404], 1), ([503], 3)]:
            with self.subTest(statuses=statuses):
                self.statuses = statuses
                self.requests = 0
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.requests, requests)
                self.assertFalse((self.root / "installed").exists())

    def test_cancellation_cleans_partial_file_without_install(self):
        self.statuses = ["partial"]
        process = subprocess.Popen(["bash", str(SCRIPT)], env=self.env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            self.assertTrue(self.started.wait(5), "curl did not start")
            os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0)
            self.assertFalse((self.root / "installed").exists())
            self.assertEqual(list(self.downloads.iterdir()), [])
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
