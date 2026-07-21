#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from build_driver_zips import build_driver_zips
from version_agent_artifacts import version_agent_artifacts


class DriverReleasePackagesTest(unittest.TestCase):
    def test_builds_java_and_platform_specific_native_driver_zips(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            native_source = release_dir / "dbx-agent-kingbase-windows-x64.exe"
            native_source.write_bytes(b"MZtest-agent")
            java_source = release_dir / "dbx-agent-h2.jar"
            java_source.write_bytes(b"test-jar")
            versions = {"h2": "0.2.5", "oracle": "0.1.10", "xugu": "0.1.20", "kingbase": "0.1.34"}

            renamed = version_agent_artifacts(release_dir, versions)
            versioned_java = release_dir / "dbx-agent-h2-0.2.5.jar"
            versioned_native = release_dir / "dbx-agent-kingbase-0.1.34-windows-x64.exe"
            self.assertEqual(renamed, [versioned_java, versioned_native])

            registry = {
                "jres": {"21": {"version": "21", "platforms": {}}},
                "drivers": {
                    "h2": {
                        "version": "0.2.5",
                        "label": "H2",
                        "min_app_version": "0.6.0",
                        "jre": "21",
                        "jar": {"url": f"https://example.com/{versioned_java.name}", "size": versioned_java.stat().st_size},
                    },
                    "kingbase": {
                        "version": "0.1.34",
                        "label": "人大金仓 KingbaseES",
                        "min_app_version": "0.6.0",
                        "jre": "21",
                        "jar": {"url": "https://example.com/legacy-placeholder.jar", "size": 0},
                        "native": {
                            "windows-x64": {
                                "url": f"https://example.com/{versioned_native.name}",
                                "size": versioned_native.stat().st_size,
                            }
                        },
                    },
                },
            }
            (release_dir / "agent-registry.json").write_text(json.dumps(registry), encoding="utf-8")

            outputs = build_driver_zips(release_dir)

            self.assertEqual(
                outputs,
                [
                    release_dir / "dbx-agent-h2-0.2.5.zip",
                    release_dir / "dbx-agent-kingbase-0.1.34-windows-x64.zip",
                ],
            )
            with zipfile.ZipFile(outputs[0]) as archive:
                self.assertEqual(set(archive.namelist()), {"agent-registry.json", f"drivers/{versioned_java.name}"})
                package_registry = json.loads(archive.read("agent-registry.json"))
                self.assertEqual(set(package_registry["drivers"]), {"h2"})
                self.assertNotIn("native", package_registry["drivers"]["h2"])
                self.assertEqual(package_registry["drivers"]["h2"]["jar"], {"url": versioned_java.name, "size": 8})
            with zipfile.ZipFile(outputs[1]) as archive:
                self.assertEqual(set(archive.namelist()), {"agent-registry.json", f"drivers/{versioned_native.name}"})
                package_registry = json.loads(archive.read("agent-registry.json"))
                kingbase = package_registry["drivers"]["kingbase"]
                self.assertNotIn("jar", kingbase)
                self.assertEqual(set(kingbase["native"]), {"windows-x64"})
                self.assertEqual(
                    kingbase["native"]["windows-x64"],
                    {"url": versioned_native.name, "size": versioned_native.stat().st_size},
                )

    def test_full_offline_bundle_includes_versioned_native_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            filename = "dbx-agent-kingbase-0.1.34-windows-x64.exe"
            (release_dir / filename).write_bytes(b"MZtest-agent")
            (release_dir / "dbx-jre-21-windows-x64.tar.gz").write_bytes(b"test-jre")
            (release_dir / "agent-registry.json").write_text('{"jres":{},"drivers":{}}', encoding="utf-8")

            subprocess.run(
                ["bash", str(Path(__file__).with_name("build_offline_zip.sh")), str(release_dir)],
                check=True,
                capture_output=True,
                text=True,
            )

            bundle = release_dir / "dbx-agents-offline-windows-x64.zip"
            self.assertTrue(bundle.is_file())
            with zipfile.ZipFile(bundle) as archive:
                self.assertIn(f"drivers/{filename}", archive.namelist())


if __name__ == "__main__":
    unittest.main()
