#!/usr/bin/env python3
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

from build_driver_zips import build_driver_zips, remove_raw_driver_artifacts
from version_agent_artifacts import NATIVE_DRIVERS, version_agent_artifacts


class DriverReleasePackagesTest(unittest.TestCase):
    def test_builds_java_and_platform_specific_native_driver_tar_zstd_packages(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            native_source = release_dir / "dbx-agent-kingbase-windows-x64.exe"
            native_source.write_bytes(b"MZtest-agent")
            vastbase_source = release_dir / "dbx-agent-vastbase-linux-x64"
            vastbase_source.write_bytes(b"\x7fELFtest-vastbase-agent")
            duckdb_source = release_dir / "dbx-agent-duckdb-macos-aarch64"
            duckdb_source.write_bytes(b"\xcf\xfa\xed\xfetest-duckdb-agent")
            rabbitmq_source = release_dir / "dbx-agent-rabbitmq-linux-x64"
            rabbitmq_source.write_bytes(b"\x7fELFtest-rabbitmq-agent")
            cassandra_source = release_dir / "dbx-agent-cassandra-linux-x64"
            cassandra_source.write_bytes(b"\x7fELFtest-cassandra-agent")
            tdengine_source = release_dir / "dbx-agent-tdengine-windows-aarch64.exe"
            tdengine_source.write_bytes(b"MZtest-tdengine-agent")
            java_source = release_dir / "dbx-agent-h2.jar"
            java_source.write_bytes(b"test-jar")
            versions = {
                "h2": "0.2.5",
                "oracle": "0.1.10",
                "xugu": "0.1.20",
                "kingbase": "0.1.34",
                "neo4j": "0.1.40",
                "vastbase": "0.1.37",
                "duckdb": "0.1.0",
                "rabbitmq": "0.1.0",
                "cassandra": "0.1.37",
                "tdengine": "0.1.0",
            }

            renamed = version_agent_artifacts(release_dir, versions)
            versioned_java = release_dir / "dbx-agent-h2-0.2.5.jar"
            versioned_native = release_dir / "dbx-agent-kingbase-0.1.34-windows-x64.exe"
            versioned_vastbase = release_dir / "dbx-agent-vastbase-0.1.37-linux-x64"
            versioned_duckdb = release_dir / "dbx-agent-duckdb-0.1.0-macos-aarch64"
            versioned_rabbitmq = release_dir / "dbx-agent-rabbitmq-0.1.0-linux-x64"
            versioned_cassandra = release_dir / "dbx-agent-cassandra-0.1.37-linux-x64"
            versioned_tdengine = release_dir / "dbx-agent-tdengine-0.1.0-windows-aarch64.exe"
            self.assertEqual(
                renamed,
                [
                    versioned_java,
                    versioned_cassandra,
                    versioned_native,
                    versioned_vastbase,
                    versioned_duckdb,
                    versioned_rabbitmq,
                    versioned_tdengine,
                ],
            )

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
                    "cassandra": {
                        "version": "0.1.37",
                        "label": "Apache Cassandra",
                        "min_app_version": "0.6.0",
                        "jre": "21",
                        "jar": {"url": "https://example.com/legacy-placeholder.jar", "size": 0},
                        "native": {
                            "linux-x64": {
                                "url": f"https://example.com/{versioned_cassandra.name}",
                                "size": versioned_cassandra.stat().st_size,
                            }
                        },
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
                    "vastbase": {
                        "version": "0.1.37",
                        "label": "Vastbase",
                        "min_app_version": "0.6.0",
                        "jre": "21",
                        "jar": {"url": "https://example.com/legacy-placeholder.jar", "size": 0},
                        "native": {
                            "linux-x64": {
                                "url": f"https://example.com/{versioned_vastbase.name}",
                                "size": versioned_vastbase.stat().st_size,
                            }
                        },
                    },
                    "duckdb": {
                        "version": "0.1.0",
                        "label": "DuckDB",
                        "min_app_version": "0.6.0",
                        "jre": "21",
                        "jar": {"url": "https://example.com/legacy-placeholder.jar", "size": 0},
                        "native": {
                            "macos-aarch64": {
                                "url": f"https://example.com/{versioned_duckdb.name}",
                                "size": versioned_duckdb.stat().st_size,
                            }
                        },
                    },
                    "rabbitmq": {
                        "version": "0.1.0",
                        "label": "RabbitMQ",
                        "min_app_version": "0.6.0",
                        "jre": "21",
                        "jar": {"url": "https://example.com/legacy-placeholder.jar", "size": 0},
                        "native": {
                            "linux-x64": {
                                "url": f"https://example.com/{versioned_rabbitmq.name}",
                                "size": versioned_rabbitmq.stat().st_size,
                            }
                        },
                    },
                    "tdengine": {
                        "version": "0.1.0",
                        "label": "TDengine",
                        "min_app_version": "0.6.0",
                        "jre": "21",
                        "jar": {"url": "https://example.com/legacy-placeholder.jar", "size": 0},
                        "native": {
                            "windows-aarch64": {
                                "url": f"https://example.com/{versioned_tdengine.name}",
                                "size": versioned_tdengine.stat().st_size,
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
                    release_dir / "dbx-agent-h2-0.2.5.tar.zst",
                    release_dir / "dbx-agent-cassandra-0.1.37-linux-x64.tar.zst",
                    release_dir / "dbx-agent-kingbase-0.1.34-windows-x64.tar.zst",
                    release_dir / "dbx-agent-vastbase-0.1.37-linux-x64.tar.zst",
                    release_dir / "dbx-agent-duckdb-0.1.0-macos-aarch64.tar.zst",
                    release_dir / "dbx-agent-rabbitmq-0.1.0-linux-x64.tar.zst",
                    release_dir / "dbx-agent-tdengine-0.1.0-windows-aarch64.tar.zst",
                ],
            )
            package_cases = [
                (outputs[0], "h2", versioned_java, "jar", None),
                (outputs[1], "cassandra", versioned_cassandra, "native", "linux-x64"),
                (outputs[2], "kingbase", versioned_native, "native", "windows-x64"),
                (outputs[3], "vastbase", versioned_vastbase, "native", "linux-x64"),
                (outputs[4], "duckdb", versioned_duckdb, "native", "macos-aarch64"),
                (outputs[5], "rabbitmq", versioned_rabbitmq, "native", "linux-x64"),
                (outputs[6], "tdengine", versioned_tdengine, "native", "windows-aarch64"),
            ]
            for output, driver_name, source, artifact_type, platform in package_cases:
                tar_bytes = subprocess.run(
                    ["zstd", "-q", "-dc", str(output)],
                    check=True,
                    capture_output=True,
                ).stdout
                with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as archive:
                    self.assertEqual(set(archive.getnames()), {"agent-registry.json", f"drivers/{source.name}"})
                    package_registry = json.load(archive.extractfile("agent-registry.json"))
                    driver = package_registry["drivers"][driver_name]
                    if artifact_type == "jar":
                        self.assertNotIn("native", driver)
                        self.assertEqual(driver["jar"], {"url": source.name, "size": source.stat().st_size})
                    else:
                        self.assertNotIn("jar", driver)
                        self.assertEqual(
                            driver["native"][platform],
                            {"url": source.name, "size": source.stat().st_size},
                        )

            final_registry = json.loads((release_dir / "agent-registry.json").read_text(encoding="utf-8"))
            release_artifacts = [
                (final_registry["drivers"]["h2"]["jar"], outputs[0]),
                (final_registry["drivers"]["cassandra"]["native"]["linux-x64"], outputs[1]),
                (final_registry["drivers"]["kingbase"]["native"]["windows-x64"], outputs[2]),
                (final_registry["drivers"]["vastbase"]["native"]["linux-x64"], outputs[3]),
                (final_registry["drivers"]["duckdb"]["native"]["macos-aarch64"], outputs[4]),
                (final_registry["drivers"]["rabbitmq"]["native"]["linux-x64"], outputs[5]),
                (final_registry["drivers"]["tdengine"]["native"]["windows-aarch64"], outputs[6]),
            ]
            for artifact, output in release_artifacts:
                self.assertEqual(artifact["url"], f"https://example.com/{output.name}")
                self.assertEqual(artifact["size"], output.stat().st_size)
                self.assertEqual(artifact["format"], "tar_zstd")
                self.assertEqual(len(artifact["sha256"]), 64)

            removed = remove_raw_driver_artifacts(release_dir)
            self.assertEqual(
                removed,
                [
                    versioned_cassandra,
                    versioned_duckdb,
                    versioned_java,
                    versioned_native,
                    versioned_rabbitmq,
                    versioned_tdengine,
                    versioned_vastbase,
                ],
            )
            self.assertTrue(all(output.is_file() for output in outputs))

    def test_versions_neo4j_native_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            source = release_dir / "dbx-agent-neo4j-macos-aarch64"
            source.write_bytes(b"\xcf\xfa\xed\xfetest-neo4j-agent")
            versions = {driver: "0.1.0" for driver in NATIVE_DRIVERS}
            versions["neo4j"] = "0.1.40"

            renamed = version_agent_artifacts(release_dir, versions)
            versioned = release_dir / "dbx-agent-neo4j-0.1.40-macos-aarch64"

            self.assertEqual(renamed, [versioned])
            self.assertFalse(source.exists())
            self.assertEqual(versioned.read_bytes(), b"\xcf\xfa\xed\xfetest-neo4j-agent")

    def test_full_offline_bundle_includes_supported_windows_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            filename = "dbx-agent-kingbase-0.1.34-windows-x64.exe"
            kafka_filename = "dbx-agent-kafka-0.1.0.jar"
            (release_dir / filename).write_bytes(b"MZtest-agent")
            (release_dir / kafka_filename).write_bytes(b"test-kafka-agent")
            (release_dir / "dbx-jre-21-windows-x64.tar.zst").write_bytes(b"test-jre")
            (release_dir / "dbx-jre-21-windows-aarch64.tar.zst").write_bytes(b"test-jre")
            (release_dir / "agent-registry.json").write_text('{"jres":{},"drivers":{}}', encoding="utf-8")

            result = subprocess.run(
                ["bash", str(Path(__file__).with_name("build_offline_zip.sh")), str(release_dir)],
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertNotIn("SKIP windows-aarch64", result.stdout)
            x64_bundle = release_dir / "dbx-agents-offline-windows-x64.zip"
            arm64_bundle = release_dir / "dbx-agents-offline-windows-aarch64.zip"
            self.assertTrue(x64_bundle.is_file())
            self.assertTrue(arm64_bundle.is_file())
            with zipfile.ZipFile(x64_bundle) as archive:
                self.assertIn(f"drivers/{filename}", archive.namelist())
                self.assertIn(f"drivers/{kafka_filename}", archive.namelist())
            with zipfile.ZipFile(arm64_bundle) as archive:
                self.assertIn("jre/dbx-jre-21-windows-aarch64.tar.zst", archive.namelist())
                self.assertIn(f"drivers/{kafka_filename}", archive.namelist())


if __name__ == "__main__":
    unittest.main()
