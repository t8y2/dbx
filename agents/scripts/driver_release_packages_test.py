#!/usr/bin/env python3
import hashlib
import io
import json
import secrets
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

from build_driver_zips import build_driver_zips, remove_raw_driver_artifacts
from validate_agents import CRATE_NATIVE_AGENT_MODULES, NATIVE_ONLY_AGENT_MODULES
from version_agent_artifacts import NATIVE_DRIVERS, version_agent_artifacts


AGENTS_ROOT = Path(__file__).resolve().parent.parent


def native_only_modules() -> set[str]:
    declared = {
        name
        for name, relative in {**NATIVE_ONLY_AGENT_MODULES, **CRATE_NATIVE_AGENT_MODULES}.items()
        if (AGENTS_ROOT / relative).exists()
    }
    return declared


class NativeReleaseCoverageTest(unittest.TestCase):
    """Guards the hand-maintained native module list in the release packaging.

    `version_agent_artifacts` renames `dbx-agent-<module>-<platform>` into the
    versioned name the registry generator looks for. A native module missing from
    its list is not a loud failure: the raw artifact is dropped, the module never
    reaches `agent-registry.json`, and the driver simply disappears from the app.
    `oracle-oci` was lost exactly that way, so cross-check the list against the
    modules `validate_agents` treats as native-only rather than trusting it to be
    maintained by hand.
    """

    def test_lists_every_native_only_module(self) -> None:
        declared = native_only_modules()
        listed = set(NATIVE_DRIVERS)

        self.assertEqual(
            sorted(listed - declared),
            [],
            "NATIVE_DRIVERS lists entries validate_agents no longer declares native-only",
        )
        self.assertEqual(
            sorted(declared - listed),
            [],
            "native-only modules missing from version_agent_artifacts.NATIVE_DRIVERS",
        )

    def test_every_listed_module_has_a_version(self) -> None:
        versions = json.loads((AGENTS_ROOT / "versions.json").read_text(encoding="utf-8"))

        missing = sorted(name for name in NATIVE_DRIVERS if not versions.get(name))

        self.assertEqual(missing, [], "native modules without a versions.json entry")

    def test_versions_platform_limited_native_artifacts(self) -> None:
        # A module published for one platform only (Oracle OCI is Windows x64)
        # must still be versioned; platforms it does not publish are skipped.
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            source = release_dir / "dbx-agent-oracle-oci-windows-x64.exe"
            source.write_bytes(b"MZtest-oracle-oci-agent")
            versions = {driver: "0.1.0" for driver in NATIVE_DRIVERS}
            versions["oracle-oci"] = "0.1.7"

            renamed = version_agent_artifacts(release_dir, versions)
            versioned = release_dir / "dbx-agent-oracle-oci-0.1.7-windows-x64.exe"

            self.assertEqual(renamed, [versioned])
            self.assertFalse(source.exists())
            self.assertEqual(versioned.read_bytes(), b"MZtest-oracle-oci-agent")


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
            rocketmq_source = release_dir / "dbx-agent-rocketmq-windows-x64.exe"
            rocketmq_source.write_bytes(b"MZtest-rocketmq-agent")
            cassandra_source = release_dir / "dbx-agent-cassandra-linux-x64"
            cassandra_source.write_bytes(b"\x7fELFtest-cassandra-agent")
            nebula_source = release_dir / "dbx-agent-nebula-linux-aarch64"
            nebula_source.write_bytes(b"\x7fELFtest-nebula-agent")
            tdengine_source = release_dir / "dbx-agent-tdengine-windows-aarch64.exe"
            tdengine_source.write_bytes(b"MZtest-tdengine-agent")
            etcd_source = release_dir / "dbx-agent-etcd-linux-x64"
            etcd_source.write_bytes(b"\x7fELFtest-etcd-agent")
            etcd2_source = release_dir / "dbx-agent-etcd2-macos-aarch64"
            etcd2_source.write_bytes(b"test-etcd2-agent")
            java_source = release_dir / "dbx-agent-h2.jar"
            java_source.write_bytes(b"test-jar")
            versions = {
                "h2": "0.2.5",
                "oracle": "0.1.10",
                "oracle-oci": "0.1.0",
                "xugu": "0.1.20",
                "kingbase": "0.1.34",
                "iotdb": "0.1.30",
                "neo4j": "0.1.40",
                "nebula": "0.1.0",
                "vastbase": "0.1.37",
                "duckdb": "0.1.0",
                "rabbitmq": "0.1.0",
                "rocketmq": "0.1.0",
                "zookeeper": "0.1.0",
                "cassandra": "0.1.37",
                "hive": "0.1.43",
                "argo": "0.1.0",
                "tdengine": "0.1.0",
                "etcd": "0.1.40",
                "etcd2": "0.1.0",
                "argo": "0.1.0",
                "sqlite-worker": "0.1.0",
            }

            renamed = version_agent_artifacts(release_dir, versions)
            versioned_java = release_dir / "dbx-agent-h2-0.2.5.jar"
            versioned_native = release_dir / "dbx-agent-kingbase-0.1.34-windows-x64.exe"
            versioned_vastbase = release_dir / "dbx-agent-vastbase-0.1.37-linux-x64"
            versioned_duckdb = release_dir / "dbx-agent-duckdb-0.1.0-macos-aarch64"
            versioned_rabbitmq = release_dir / "dbx-agent-rabbitmq-0.1.0-linux-x64"
            versioned_rocketmq = release_dir / "dbx-agent-rocketmq-0.1.0-windows-x64.exe"
            versioned_cassandra = release_dir / "dbx-agent-cassandra-0.1.37-linux-x64"
            versioned_nebula = release_dir / "dbx-agent-nebula-0.1.0-linux-aarch64"
            versioned_tdengine = release_dir / "dbx-agent-tdengine-0.1.0-windows-aarch64.exe"
            versioned_etcd = release_dir / "dbx-agent-etcd-0.1.40-linux-x64"
            versioned_etcd2 = release_dir / "dbx-agent-etcd2-0.1.0-macos-aarch64"
            self.assertEqual(
                renamed,
                [
                    versioned_java,
                    versioned_cassandra,
                    versioned_native,
                    versioned_nebula,
                    versioned_vastbase,
                    versioned_duckdb,
                    versioned_rabbitmq,
                    versioned_rocketmq,
                    versioned_tdengine,
                    versioned_etcd,
                    versioned_etcd2,
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
                        "label": "金仓KingbaseES",
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
                    "rocketmq": {
                        "version": "0.1.0",
                        "label": "Apache RocketMQ",
                        "min_app_version": "0.6.0",
                        "jre": "21",
                        "jar": {"url": "https://example.com/legacy-placeholder.jar", "size": 0},
                        "native": {
                            "windows-x64": {
                                "url": f"https://example.com/{versioned_rocketmq.name}",
                                "size": versioned_rocketmq.stat().st_size,
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
                    release_dir / "dbx-agent-rocketmq-0.1.0-windows-x64.tar.zst",
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
                (outputs[6], "rocketmq", versioned_rocketmq, "native", "windows-x64"),
                (outputs[7], "tdengine", versioned_tdengine, "native", "windows-aarch64"),
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
                (final_registry["drivers"]["rocketmq"]["native"]["windows-x64"], outputs[6]),
                (final_registry["drivers"]["tdengine"]["native"]["windows-aarch64"], outputs[7]),
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
                    versioned_etcd,
                    versioned_etcd2,
                    versioned_java,
                    versioned_native,
                    versioned_nebula,
                    versioned_rabbitmq,
                    versioned_rocketmq,
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

    def test_versions_nebula_native_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            source = release_dir / "dbx-agent-nebula-linux-aarch64"
            source.write_bytes(b"\x7fELFtest-nebula-agent")
            versions = {driver: "0.1.0" for driver in NATIVE_DRIVERS}

            renamed = version_agent_artifacts(release_dir, versions)
            versioned = release_dir / "dbx-agent-nebula-0.1.0-linux-aarch64"

            self.assertEqual(renamed, [versioned])
            self.assertFalse(source.exists())
            self.assertEqual(versioned.read_bytes(), b"\x7fELFtest-nebula-agent")

    def test_versions_iotdb_native_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            source = release_dir / "dbx-agent-iotdb-linux-x64"
            source.write_bytes(b"\x7fELFtest-iotdb-agent")
            versions = {driver: "0.1.0" for driver in NATIVE_DRIVERS}
            versions["iotdb"] = "0.1.30"

            renamed = version_agent_artifacts(release_dir, versions)
            versioned = release_dir / "dbx-agent-iotdb-0.1.30-linux-x64"

            self.assertEqual(renamed, [versioned])
            self.assertFalse(source.exists())
            self.assertEqual(versioned.read_bytes(), b"\x7fELFtest-iotdb-agent")

    def test_versions_hive_native_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            source = release_dir / "dbx-agent-hive-windows-x64.exe"
            source.write_bytes(b"MZtest-hive-agent")
            versions = {driver: "0.1.0" for driver in NATIVE_DRIVERS}
            versions["hive"] = "0.1.44"

            renamed = version_agent_artifacts(release_dir, versions)
            versioned = release_dir / "dbx-agent-hive-0.1.44-windows-x64.exe"

            self.assertEqual(renamed, [versioned])
            self.assertFalse(source.exists())
            self.assertEqual(versioned.read_bytes(), b"MZtest-hive-agent")

    def test_versions_zookeeper_native_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            source = release_dir / "dbx-agent-zookeeper-linux-aarch64"
            source.write_bytes(b"\x7fELFtest-zookeeper-agent")
            versions = {driver: "0.1.0" for driver in NATIVE_DRIVERS}
            versions["zookeeper"] = "0.1.8"

            renamed = version_agent_artifacts(release_dir, versions)
            versioned = release_dir / "dbx-agent-zookeeper-0.1.8-linux-aarch64"

            self.assertEqual(renamed, [versioned])
            self.assertFalse(source.exists())
            self.assertEqual(versioned.read_bytes(), b"\x7fELFtest-zookeeper-agent")

    def test_versions_sqlite_worker_native_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            x64 = release_dir / "dbx-agent-sqlite-worker-linux-x64"
            arm = release_dir / "dbx-agent-sqlite-worker-linux-aarch64"
            x64.write_bytes(b"\x7fELFtest-sqlite-worker-x64")
            arm.write_bytes(b"\x7fELFtest-sqlite-worker-arm")
            versions = {driver: "0.1.0" for driver in NATIVE_DRIVERS}

            renamed = version_agent_artifacts(release_dir, versions)
            versioned_x64 = release_dir / "dbx-agent-sqlite-worker-0.1.0-linux-x64"
            versioned_arm = release_dir / "dbx-agent-sqlite-worker-0.1.0-linux-aarch64"

            self.assertEqual(renamed, [versioned_arm, versioned_x64])
            self.assertFalse(x64.exists())
            self.assertFalse(arm.exists())
            self.assertEqual(versioned_x64.read_bytes(), b"\x7fELFtest-sqlite-worker-x64")
            self.assertEqual(versioned_arm.read_bytes(), b"\x7fELFtest-sqlite-worker-arm")

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


class DriverDeltaPatchTest(unittest.TestCase):
    """Incremental `zstd --patch-from` deltas emitted by build_driver_zips."""

    @staticmethod
    def _incompressible_filler(size: int) -> bytes:
        # Deterministic, incompressible shared payload: two packages built from
        # it stay ~`size` bytes large while their version differences stay a
        # few bytes, so the delta ratio reflects the small real change.
        chunks = []
        counter = 0
        while sum(len(chunk) for chunk in chunks) < size:
            chunks.append(hashlib.sha256(f"demo-filler-{counter}".encode()).digest())
            counter += 1
        return b"".join(chunks)[:size]

    @staticmethod
    def _write_release(release_dir: Path, version: str, jar_payload: bytes) -> None:
        jar = release_dir / f"dbx-agent-demo-{version}.jar"
        jar.write_bytes(jar_payload)
        registry = {
            "jres": {"21": {"version": "21", "platforms": {}}},
            "drivers": {
                "demo": {
                    "version": version,
                    "label": "Demo",
                    "min_app_version": "0.6.0",
                    "jre": "21",
                    "jar": {"url": f"https://example.com/{jar.name}", "size": jar.stat().st_size},
                }
            },
        }
        (release_dir / "agent-registry.json").write_text(json.dumps(registry), encoding="utf-8")

    @staticmethod
    def _zstd_available() -> bool:
        try:
            subprocess.run(["zstd", "--version"], capture_output=True, check=True)
            return True
        except (OSError, subprocess.CalledProcessError):
            return False

    def _build_previous_release(self, release_dir: Path) -> None:
        filler = self._incompressible_filler(96 * 1024)
        jar_v1 = b"PK-demo-jar-v1\x00" + filler + b"\x00trailer-v1"
        self._write_release(release_dir, "0.1.0", jar_v1)
        build_driver_zips(release_dir)
        registry = json.loads((release_dir / "agent-registry.json").read_text(encoding="utf-8"))
        package = release_dir / "dbx-agent-demo-0.1.0.tar.zst"
        # Point the previous registry at the local package so the generator
        # fetches its base the same way production fetches the previous release.
        registry["drivers"]["demo"]["jar"]["url"] = package.resolve().as_uri()
        (release_dir / "previous-agent-registry.json").write_text(json.dumps(registry), encoding="utf-8")

    def test_delta_patch_generated_and_registry_annotated(self) -> None:
        if not self._zstd_available():
            self.skipTest("zstd CLI is unavailable")
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            self._build_previous_release(release_dir)

            filler = self._incompressible_filler(96 * 1024)
            jar_v2 = b"PK-demo-jar-v2\x00" + filler + b"\x00trailer-v2"
            self._write_release(release_dir, "0.2.0", jar_v2)
            previous = json.loads((release_dir / "previous-agent-registry.json").read_text(encoding="utf-8"))
            build_driver_zips(release_dir, previous, delta_min_full_size=0)

            package_v2 = release_dir / "dbx-agent-demo-0.2.0.tar.zst"
            delta_path = release_dir / "dbx-agent-demo-0.1.0-to-0.2.0.tar.zst.delta"
            self.assertTrue(delta_path.is_file(), "delta file must be written into the release dir")
            self.assertLess(delta_path.stat().st_size, package_v2.stat().st_size)

            registry = json.loads((release_dir / "agent-registry.json").read_text(encoding="utf-8"))
            delta = registry["drivers"]["demo"]["jar"].get("delta")
            self.assertIsNotNone(delta, "registry must carry the delta block")
            self.assertEqual(delta["base_version"], "0.1.0")
            self.assertEqual(delta["size"], delta_path.stat().st_size)
            self.assertEqual(delta["sha256"], hashlib.sha256(delta_path.read_bytes()).hexdigest())
            self.assertTrue(delta["url"].endswith(delta_path.name))
            self.assertEqual(delta["url"].rpartition("/")[0], "https://example.com")

            # The delta must reconstruct the exact full package from the base.
            reconstructed = release_dir / "reconstructed.tar.zst"
            subprocess.run(
                [
                    "zstd", "-q", "-d", "--patch-from",
                    str(release_dir / "dbx-agent-demo-0.1.0.tar.zst"),
                    str(delta_path), "-o", str(reconstructed), "--force",
                ],
                check=True,
            )
            self.assertEqual(reconstructed.read_bytes(), package_v2.read_bytes())

    def test_delta_skipped_when_ratio_exceeds_threshold(self) -> None:
        if not self._zstd_available():
            self.skipTest("zstd CLI is unavailable")
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            self._build_previous_release(release_dir)
            # A completely unrelated payload produces a delta as large as the
            # full package; the generator must drop it and leave no block.
            self._write_release(release_dir, "0.2.0", secrets.token_bytes(96 * 1024))
            previous = json.loads((release_dir / "previous-agent-registry.json").read_text(encoding="utf-8"))
            build_driver_zips(release_dir, previous, delta_min_full_size=0, delta_max_ratio=0.5)

            self.assertEqual(list(release_dir.glob("*.delta")), [])
            registry = json.loads((release_dir / "agent-registry.json").read_text(encoding="utf-8"))
            self.assertIsNone(registry["drivers"]["demo"]["jar"].get("delta"))

    def test_delta_skipped_for_unchanged_version(self) -> None:
        if not self._zstd_available():
            self.skipTest("zstd CLI is unavailable")
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            self._build_previous_release(release_dir)
            # Same version in the previous registry: no delta, and the previous
            # artifact must not even be fetched (its URL is intentionally dead).
            previous = json.loads((release_dir / "previous-agent-registry.json").read_text(encoding="utf-8"))
            previous["drivers"]["demo"]["jar"]["url"] = "https://example.invalid/no-such-package.tar.zst"
            build_driver_zips(release_dir, previous, delta_min_full_size=0)
            self.assertEqual(list(release_dir.glob("*.delta")), [])

    def test_cleanup_keeps_delta_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            release_dir = Path(temp_dir)
            delta = release_dir / "dbx-agent-demo-0.1.0-to-0.2.0.tar.zst.delta"
            delta.write_bytes(b"delta-frame")
            raw = release_dir / "dbx-agent-demo-0.2.0.jar"
            raw.write_bytes(b"raw")
            removed = remove_raw_driver_artifacts(release_dir)
            self.assertEqual(removed, [raw])
            self.assertTrue(delta.is_file())

    def test_release_uploads_delta_files_to_r2(self) -> None:
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/agents-release.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn('--include "dbx-agent-*.tar.zst.delta"', workflow)


if __name__ == "__main__":
    unittest.main()
