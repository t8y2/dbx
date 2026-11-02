import importlib.util
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("ci-install-system-deps.py")
spec = importlib.util.spec_from_file_location("deps", SCRIPT)
deps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deps)

SOURCE = """Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs:
 mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main

Types: deb
URIs: https://example.test/apt
Suites: stable
Components: main
"""
OK = (0, "", False)
TIMEOUT = (-9, "", True)
NETWORK = (100, "E: Failed to fetch http://azure.archive.ubuntu.com/a.deb Connection timed out\n"
           "E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?\n", False)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / "ubuntu.sources"
        self.source.write_bytes(SOURCE.encode())
        self.calls = []

    def execute(self, results, group="gtk"):
        responses = iter(results)

        def run(arguments, budget):
            self.calls.append((arguments, budget, self.source.read_text()))
            return next(responses)

        with patch.object(deps, "run_apt", side_effect=run):
            try:
                deps.install(self.source, group)
            finally:
                self.assertEqual(self.source.read_bytes(), SOURCE.encode())

    def test_success_downloads_before_one_offline_install(self):
        self.execute([OK, OK, OK])
        self.assertEqual([call[1] for call in self.calls], [60, 120, 1200])
        self.assertEqual(self.calls[1][0], ["--download-only", "install", "-y", *deps.PACKAGES])
        self.assertEqual(self.calls[2][0], ["--no-download", "install", "-y", *deps.PACKAGES])
        self.assertTrue(all(deps.BACKUP not in call[2] for call in self.calls))

    def test_fixed_package_groups_preserve_each_caller_list(self):
        for group, packages in {"packaging": ["zstd"],
                                "duckdb": ["libdbus-1-dev", "pkg-config"]}.items():
            with self.subTest(group=group):
                self.calls.clear()
                self.execute([OK, OK, OK], group)
                self.assertEqual(self.calls[1][0], ["--download-only", "install", "-y", *packages])
                self.assertEqual(self.calls[2][0], ["--no-download", "install", "-y", *packages])

    def test_official_primary_and_known_runner_sources(self):
        self.assertEqual(deps.PRIMARY, "https://archive.ubuntu.com/ubuntu/")
        for uri in [deps.PRIMARY, deps.BACKUP, deps.LAST_RESORT, "mirror+file:/etc/apt/apt-mirrors.txt"]:
            with self.subTest(uri=uri):
                source = SOURCE.replace("mirror+file:/etc/apt/apt-mirrors.txt", uri)
                rewritten = deps.rewrite_ubuntu_uris(source, deps.PRIMARY)
                self.assertIn("URIs: https://archive.ubuntu.com/ubuntu/", rewritten)
                self.assertIn("URIs: https://security.ubuntu.com/ubuntu/", rewritten)
                self.assertIn("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg", rewritten)

    def test_jammy_list_preserves_options_suites_comments_and_security(self):
        source = (
            "# runner sources\n"
            "deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] "
            "http://azure.archive.ubuntu.com/ubuntu/ jammy main universe\n"
            "deb-src http://archive.ubuntu.com/ubuntu jammy-updates main\n"
            "deb http://security.ubuntu.com/ubuntu jammy-security main\n"
            "# deb http://archive.ubuntu.com/ubuntu jammy-backports main\n"
            "deb https://example.test/apt stable main\n"
        )
        expected = source.replace("http://azure.archive.ubuntu.com/ubuntu/", deps.BACKUP)
        expected = expected.replace("deb-src http://archive.ubuntu.com/ubuntu ", "deb-src " + deps.BACKUP + " ")
        self.assertEqual(deps.rewrite_ubuntu_uris(source, deps.BACKUP), expected)

    def test_release_package_groups_preserve_existing_dependencies(self):
        expected = {
            "release": ["fcitx5-frontend-gtk3", "ibus-gtk3", "libwebkit2gtk-4.1-dev",
                        "libgtk-3-dev", "libappindicator3-dev", "librsvg2-dev", "patchelf",
                        "libssl-dev", "xdg-utils", "lld"],
            "node-release": ["libfontconfig1-dev", "libsecret-1-dev"],
            "fontconfig": ["libfontconfig1-dev"],
            "preview": ["ffmpeg", "fonts-noto-cjk", "fonts-noto-color-emoji"],
        }
        for group, packages in expected.items():
            with self.subTest(group=group):
                self.calls.clear()
                self.execute([OK, OK, OK], group)
                self.assertEqual(self.calls[1][0], ["--download-only", "install", "-y", *packages])
                self.assertEqual(self.calls[2][0], ["--no-download", "install", "-y", *packages])

    def test_arm_sources_never_switch_to_amd64_archive(self):
        for source in [
            "deb http://ports.ubuntu.com/ubuntu-ports jammy main universe\n",
            "Types: deb\nURIs: http://ports.ubuntu.com/ubuntu-ports/\nSuites: noble noble-security\nComponents: main\nSigned-By: /keyring\n",
        ]:
            with self.subTest(source=source):
                self.source.write_text(source)
                calls = []
                responses = iter([TIMEOUT, OK, OK, OK])
                def run(arguments, budget):
                    calls.append((arguments, self.source.read_text()))
                    return next(responses)
                with patch.object(deps, "run_apt", side_effect=run):
                    deps.install(self.source, "release")
                self.assertEqual(self.source.read_text(), source)
                self.assertIn(deps.PORT_MIRRORS[0][1], calls[0][1])
                self.assertIn(deps.PORT_MIRRORS[1][1], calls[1][1])
                self.assertTrue(all("archive.ubuntu.com" not in text for _args, text in calls))

    def test_default_source_selects_existing_runner_format(self):
        legacy = Path(self.directory.name) / "sources.list"
        legacy.write_text("deb http://archive.ubuntu.com/ubuntu jammy main\n")
        with patch.object(deps, "SOURCES", Path(self.directory.name) / "missing.sources"), \
             patch.object(deps, "LEGACY_SOURCES", legacy), \
             patch.object(deps, "run_apt", return_value=OK):
            deps.install(group="packaging")
        self.assertEqual(legacy.read_text(), "deb http://archive.ubuntu.com/ubuntu jammy main\n")

    def test_release_workflows_use_bounded_installer_from_their_checkout(self):
        workflows = SCRIPT.parent.parent / "workflows"
        expected = {
            "release.yml": {"release": 1},
            "agents-release.yml": {"packaging": 3},
            "mcp-release.yml": {"node-release": 1, "fontconfig": 2},
            "ui-preview.yml": {"preview": 1},
        }
        for filename, groups in expected.items():
            content = (workflows / filename).read_text(encoding="utf-8")
            with self.subTest(workflow=filename):
                self.assertNotIn("sudo apt-get", content)
                for group, count in groups.items():
                    self.assertEqual(content.count("ci-install-system-deps.py --group " + group + "\n"), count)
        agents = (workflows / "agents-release.yml").read_text(encoding="utf-8")
        jre = agents.split("\n  build-jre:", 1)[1].split("\n  reuse-previous-assets:", 1)[0]
        self.assertLess(jre.index("uses: actions/checkout@"), jre.index("ci-install-system-deps.py"))
        preview = (workflows / "ui-preview.yml").read_text(encoding="utf-8")
        trusted_checkout = preview.split("path: ci", 1)[1].split("persist-credentials:", 1)[0]
        self.assertIn(".github/scripts", trusted_checkout)
        self.assertIn("ref: ${{ github.event.repository.default_branch }}", preview)
        self.assertIn("working-directory: ci/.github/ui-preview", preview)
        self.assertIn("sudo python3 ../scripts/ci-install-system-deps.py --group preview", preview)

    def test_timeout_or_network_failure_switches_once_and_reuses_cache(self):
        for failure in [TIMEOUT, NETWORK]:
            with self.subTest(failure=failure):
                self.calls.clear()
                self.execute([OK, failure, OK, OK, OK])
                self.assertEqual([call[1] for call in self.calls], [60, 120, 60, 120, 1200])
                self.assertIn(deps.PRIMARY, self.calls[1][2])
                self.assertNotIn(deps.PRIMARY, self.calls[2][2])
                self.assertIn(deps.BACKUP, self.calls[2][2])
                self.assertFalse(any("clean" in call[0] or "--fix-missing" in call[0] for call in self.calls))
                self.assertTrue(all(not any("Dir::Cache" in arg for arg in call[0]) for call in self.calls))

    def test_network_index_failure_refreshes_backup_before_downloading(self):
        self.execute([NETWORK, OK, OK, OK])
        self.assertEqual([call[0][0] for call in self.calls], ["update", "update", "--download-only", "--no-download"])

    def test_all_three_sources_fail_without_installing_partial_downloads(self):
        with self.assertRaises(RuntimeError):
            self.execute([OK, TIMEOUT, OK, NETWORK, OK, NETWORK])
        self.assertEqual(len(self.calls), 6)
        self.assertFalse(any("--no-download" in call[0] for call in self.calls))

    def test_second_switch_is_last_resort_and_never_loops(self):
        self.execute([OK, TIMEOUT, OK, NETWORK, OK, OK, OK])
        self.assertEqual(len(self.calls), 7)
        self.assertIn(deps.PRIMARY, self.calls[1][2])
        self.assertIn(deps.BACKUP, self.calls[3][2])
        self.assertIn(deps.LAST_RESORT, self.calls[5][2])
        self.assertEqual(self.calls[6][0][0], "--no-download")

    def test_deterministic_and_unknown_errors_never_switch(self):
        for output in ["E: Unable to locate package missing", "W: GPG error: invalid signatures",
                       "E: Failed to fetch https://archive.ubuntu.com/a.deb Certificate verification failed",
                       "E: Failed to fetch http://azure.archive.ubuntu.com/a.deb 404 Not Found",
                       "E: Failed to fetch http://azure.archive.ubuntu.com/a.deb Hash Sum mismatch",
                       "E: Could not get lock /var/lib/dpkg/lock", "E: No space left on device",
                       "E: Unknown error", NETWORK[1] + "E: unmet dependencies"]:
            for timed_out in [False, True]:
                with self.subTest(output=output, timed_out=timed_out):
                    self.calls.clear()
                    with self.assertRaises(RuntimeError):
                        self.execute([OK, (100, output, timed_out)])
                    self.assertEqual(len(self.calls), 2)
        self.assertFalse(deps.is_retryable_acquisition_failure("", False))
        self.assertFalse(deps.is_retryable_acquisition_failure(
            NETWORK[1] + "E: Failed to fetch https://example.test/a.deb Unknown error", False))

    def test_http_transient_errors_are_allowed_but_not_unknown_fetch_errors(self):
        for status in [429, 500, 502, 503, 504]:
            self.assertTrue(deps.is_retryable_acquisition_failure(
                f"E: Failed to fetch https://archive.ubuntu.com/a.deb {status} Server error", False))
        self.assertFalse(deps.is_retryable_acquisition_failure(
            "E: Failed to fetch https://archive.ubuntu.com/a.deb Something went wrong", False))

    def test_install_failure_is_terminal_without_retry(self):
        for failure in [TIMEOUT, NETWORK, (100, "E: dpkg failed", False)]:
            self.calls.clear()
            with self.assertRaises(RuntimeError):
                self.execute([OK, OK, failure])
            self.assertEqual(len(self.calls), 3)

    def test_source_rewrite_preserves_all_non_uri_fields_and_security(self):
        rewritten = deps.rewrite_ubuntu_uris(SOURCE, deps.BACKUP)
        self.assertEqual(rewritten, SOURCE.replace("mirror+file:/etc/apt/apt-mirrors.txt", deps.BACKUP))
        self.assertEqual(deps.rewrite_ubuntu_uris(SOURCE.replace("mirror+file:/etc/apt/apt-mirrors.txt", deps.PRIMARY), deps.BACKUP), rewritten)
        self.source.write_text("Types: deb\nURIs: https://unknown.test/ubuntu\nSuites: noble\n")
        original = self.source.read_bytes()
        with self.assertRaises(ValueError), patch.object(deps, "run_apt") as run:
            deps.install(self.source)
        run.assert_not_called()
        self.assertEqual(self.source.read_bytes(), original)

    def test_run_apt_uses_an_owned_process_group_and_c_locale(self):
        with patch.object(deps.subprocess, "Popen") as popen:
            popen.return_value.communicate.return_value = ("downloaded\n", None)
            popen.return_value.returncode = 0
            self.assertEqual(deps.run_apt(["--download-only", "install", "-y", *deps.PACKAGES], 120), (0, "downloaded\n", False))
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertEqual(popen.call_args.kwargs["env"]["LC_ALL"], "C")
        self.assertIn("Acquire::Retries=0", popen.call_args.args[0])

    @unittest.skipUnless(sys.platform == "linux", "requires Linux process groups")
    def test_cancellation_during_spawn_reaps_before_restoring_sources(self):
        events = []
        write = Path.write_bytes

        def record_write(path, content):
            if content == SOURCE.encode():
                events.append("restore")
            return write(path, content)

        with patch.object(deps.subprocess, "Popen") as popen, \
                patch.object(deps.signal, "signal"), \
                patch.object(deps.os, "killpg", side_effect=lambda *_: events.append("kill")), \
                patch.object(Path, "write_bytes", autospec=True, side_effect=record_write):
            process = popen.return_value
            process.communicate.side_effect = lambda: (events.append("reap") or "", None)

            def spawn(*_args, **_kwargs):
                events.append("spawn")
                deps.cancel(signal.SIGTERM, None)
                return process

            popen.side_effect = spawn
            with self.assertRaises(deps.Cancelled):
                deps.install(self.source)
            popen.assert_called_once()
        self.assertEqual(events, ["spawn", "kill", "reap", "restore"])
        self.assertEqual(self.source.read_bytes(), SOURCE.encode())

    def run_child_case(self, signum=0):
        pid_file = Path(self.directory.name) / f"child-{signum}.pid"
        payload = textwrap.dedent("""
            import os, subprocess, sys, time
            child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
            open(sys.argv[1], 'w').write(f'{os.getpid()} {child.pid}')
            time.sleep(60)
        """)
        harness = textwrap.dedent("""
            import importlib.util, signal, subprocess, sys
            from pathlib import Path
            spec = importlib.util.spec_from_file_location('deps', sys.argv[1])
            deps = importlib.util.module_from_spec(spec); spec.loader.exec_module(deps)
            deps.signal.signal(signal.SIGINT, deps.cancel)
            deps.signal.signal(signal.SIGTERM, deps.cancel)
            original_popen = subprocess.Popen
            deps.subprocess.Popen = lambda *a, **kw: original_popen([sys.executable, '-c', sys.argv[3], sys.argv[4]], **kw)
            original_run = deps.run_apt
            deps.run_apt = lambda args, budget: original_run(args, 3)
            try:
                deps.install(Path(sys.argv[2]))
            except deps.Cancelled as error:
                sys.exit(128 + error.signum)
            except RuntimeError:
                sys.exit(1)
        """)
        process = subprocess.Popen([sys.executable, "-c", harness, str(SCRIPT), str(self.source), payload, str(pid_file)],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        def cleanup():
            if pid_file.exists() and pid_file.read_text():
                try:
                    os.killpg(int(pid_file.read_text().split()[0]), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)

        self.addCleanup(cleanup)
        deadline = time.monotonic() + 10
        while not pid_file.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(pid_file.exists(), "fake apt did not start")
        if signum:
            process.send_signal(signum)
        output = process.communicate(timeout=15)[0]
        self.assertEqual(process.returncode, 128 + signum if signum else 1, output)
        self.assertEqual(self.source.read_bytes(), SOURCE.encode())
        self.assertNotIn("phase=install", output)
        child = Path(f"/proc/{pid_file.read_text().split()[1]}/stat")

        def child_running():
            try:
                return child.read_text().split()[2] != "Z"
            except FileNotFoundError:
                return False

        deadline = time.monotonic() + 5
        while child_running() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertFalse(child_running(), "descendant still running")
        return output

    @unittest.skipUnless(sys.platform == "linux", "requires Linux process groups and /proc")
    def test_timeout_disposes_descendants_before_backup(self):
        output = self.run_child_case()
        self.assertIn("timed_out=True", output)
        self.assertEqual(output.count("switching to next source"), 2)

    @unittest.skipUnless(sys.platform == "linux", "requires Linux process groups and /proc")
    def test_cancellation_disposes_descendants_without_backup_and_restores_sources(self):
        for signum in [signal.SIGINT, signal.SIGTERM]:
            with self.subTest(signum=signum):
                output = self.run_child_case(signum)
                self.assertNotIn("switching to next source", output)


if __name__ == "__main__":
    unittest.main()
