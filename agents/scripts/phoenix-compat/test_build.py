import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("compat_build", Path(__file__).with_name("build.py"))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class CompatibilityBuildTests(unittest.TestCase):
    def test_source_patch_rejects_changed_or_already_patched_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pom = root / "pom.xml"
            original = "<artifactId>maven-shade-plugin</artifactId>\n          <version>2.4.3</version>"
            pom.write_text(original)
            build.patch_source(root)
            self.assertIn("3.0.0", pom.read_text())
            with self.assertRaises(ValueError):
                build.patch_source(root)
            pom.write_text(original + original)
            with self.assertRaises(ValueError):
                build.patch_source(root)

    def test_normalization_preserves_classes_and_removes_only_approved_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = []
            for index, user in enumerate(["alice", "bob"]):
                source, output = root / f"input{index}.jar", root / f"out{index}.jar"
                entries = {"A.class": b"not-real-bytecode-but-must-not-change", "META-INF/MANIFEST.MF": f"Manifest-Version: 1.0\nBuilt-By: {user}\nImplementation-Version: 5.0\n\n".encode(), "META-INF/maven/org.apache.phoenix/core/pom.properties": f"#time {index}\nversion=5.0\n".encode(), "META-INF/NOTICE": b"notice", "resource": b"exact"}
                with zipfile.ZipFile(source, "w") as archive:
                    for name in list(entries)[::1 if index else -1]:
                        archive.writestr(name, entries[name])
                result = build.normalize_jar(source, output)
                outputs.append(output.read_bytes())
                self.assertTrue(result["class_bytes_preserved"])
                with zipfile.ZipFile(output) as normalized:
                    self.assertEqual(normalized.read("resource"), b"exact")
                    self.assertEqual(normalized.read("META-INF/NOTICE"), b"notice")
                    self.assertIn(b"Implementation-Version: 5.0", normalized.read("META-INF/MANIFEST.MF"))
            self.assertEqual(*outputs)

    def test_normalization_refuses_signed_jars(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "signed.jar"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("META-INF/VENDOR.SF", "signature")
            with self.assertRaisesRegex(ValueError, "signed"):
                build.normalize_jar(source, Path(directory) / "out.jar")

    def test_archive_extraction_rejects_links_and_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, (name, member_type) in enumerate([("../outside", tarfile.REGTYPE), ("root/link", tarfile.SYMTYPE)]):
                archive = root / f"source{index}.tar.gz"
                with tarfile.open(archive, "w:gz") as output:
                    member = tarfile.TarInfo(name)
                    member.type = member_type
                    member.linkname = "/etc/passwd"
                    output.addfile(member, io.BytesIO())
                with self.assertRaises(ValueError):
                    build.extract_source(archive, root / "target")
            self.assertFalse((root / "target").exists())

    def test_corrupt_seed_does_not_become_verified_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, destination = root / "bad.jar", root / "repo/file.jar"
            source.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "Checksum"):
                build.acquire("https://repo.maven.apache.org/maven2/example.jar", destination, "0" * 64, seed=source)
            self.assertFalse(destination.exists())

    def test_repository_lock_excludes_phoenix_main_binary_and_pins_metadata(self):
        lock = build.load_lock()
        self.assertGreater(len(lock["artifacts"]), 0)
        for entry in lock["artifacts"]:
            self.assertEqual(len(entry["sha256"]), 64)
            self.assertGreater(entry["size"], 0)
        self.assertEqual(len(lock["metadata"]), 2)
        self.assertTrue(any("3.0.1-b12" in x["content"] for x in lock["metadata"]))

    def test_release_gate_rejects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog = Path(directory) / "catalog.json"
            row = {"id": build.RUNTIME_ID, "sha256": "approved"}
            catalog.write_text(json.dumps({"format_version": 1, "runtimes": [row]}))
            with patch.object(build, "CATALOG", catalog):
                build.check_catalog(row)
                with self.assertRaisesRegex(ValueError, "differs"):
                    build.check_catalog(dict(row, sha256="different"))

    def test_generated_test_classpath_has_no_machine_paths_and_rejects_unknown_input(self):
        dependency = build.load_lock()["artifacts"][0]["path"]
        for prefix in ("/home/builder/work/", "/Volumes/Dev/test/"):
            raw = (prefix + "m2/" + dependency + ":/jdk/jre/../lib/tools.jar").encode()
            self.assertEqual(build.normalized_entry("mrapp-generated-classpath", raw), ("m2/" + dependency + ":jdk/lib/tools.jar").encode())
        with self.assertRaisesRegex(ValueError, "Unrecognized"):
            build.normalized_entry("mrapp-generated-classpath", b"/unlocked.jar")


if __name__ == "__main__":
    unittest.main()
