import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "docker_mirror", Path(__file__).with_name("configure-docker-mirror.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DockerMirrorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "daemon.json"

    def test_missing_config(self):
        module.configure(self.path)
        self.assertEqual(json.loads(self.path.read_text()), {"registry-mirrors": [module.MIRROR]})
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_preserves_settings_and_existing_mirror_order(self):
        original = {"log-driver": "json-file", "features": {"containerd-snapshotter": True},
                    "registry-mirrors": ["https://existing.example", "https://second.example/"]}
        self.path.write_text(json.dumps(original))
        module.configure(self.path)
        expected = {**original, "registry-mirrors": [*original["registry-mirrors"], module.MIRROR]}
        self.assertEqual(json.loads(self.path.read_text()), expected)

    def test_second_run_does_not_write(self):
        module.configure(self.path)
        before = self.path.read_bytes()
        modified = self.path.stat().st_mtime_ns
        module.configure(self.path)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.path.stat().st_mtime_ns, modified)

    def test_existing_mirror_with_trailing_slash_does_not_write(self):
        before = '{"registry-mirrors": ["https://mirror.gcr.io/"], "debug": false}\n'
        self.path.write_text(before)
        module.configure(self.path)
        self.assertEqual(self.path.read_text(), before)

    def test_invalid_json_fails_without_writing(self):
        before = b'{"debug":'
        self.path.write_bytes(before)
        with self.assertRaises(json.JSONDecodeError):
            module.configure(self.path)
        self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_structure_fails_without_writing(self):
        for value in [[], {"registry-mirrors": "https://existing.example"},
                      {"registry-mirrors": [None]}]:
            with self.subTest(value=value):
                before = json.dumps(value).encode()
                self.path.write_bytes(before)
                with self.assertRaises(ValueError):
                    module.configure(self.path)
                self.assertEqual(self.path.read_bytes(), before)

    def test_existing_file_permissions_preserved(self):
        self.path.write_text('{"debug": false}')
        self.path.chmod(0o600)
        mode = self.path.stat().st_mode
        module.configure(self.path)
        self.assertEqual(self.path.stat().st_mode, mode)

    def test_backup_preserves_original_bytes_and_mode(self):
        before = b'{ "debug": false, "log-driver": "json-file" }\n'
        self.path.write_bytes(before)
        self.path.chmod(0o600)
        mode = self.path.stat().st_mode
        module.configure(self.path)
        backup = self.path.with_name(self.path.name + ".before-dbx-mirror")
        self.assertEqual(backup.read_bytes(), before)
        self.assertEqual(backup.stat().st_mode, mode)
        module.configure(self.path)
        self.assertEqual(backup.read_bytes(), before)

    def test_validator_failure_preserves_original_and_removes_candidate(self):
        before = b'{"debug": false}\n'
        self.path.write_bytes(before)

        def reject(candidate):
            self.assertEqual(json.loads(candidate.read_text())["registry-mirrors"], [module.MIRROR])
            self.assertEqual(self.path.read_bytes(), before)
            raise ValueError("daemon validation failed")

        with self.assertRaisesRegex(ValueError, "daemon validation failed"):
            module.configure(self.path, reject)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_validation_precedes_atomic_replace(self):
        before = b'{"debug": true}\n'
        self.path.write_bytes(before)
        candidates = []

        def validate(candidate):
            self.assertEqual(candidate.parent, self.path.parent)
            self.assertEqual(self.path.read_bytes(), before)
            self.assertTrue(json.loads(candidate.read_text())["debug"])
            candidates.append(candidate)

        module.configure(self.path, validate)
        self.assertEqual(len(candidates), 1)
        self.assertFalse(candidates[0].exists())
        self.assertIn(module.MIRROR, json.loads(self.path.read_text())["registry-mirrors"])


if __name__ == "__main__":
    unittest.main()
