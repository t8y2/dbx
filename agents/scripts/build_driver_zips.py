#!/usr/bin/env python3
import argparse
import copy
import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlparse


def artifact_filename(url: str) -> str:
    return Path(urlparse(url).path).name


def write_driver_tar_zstd(output: Path, registry: dict, source: Path, *, executable: bool) -> None:
    registry_bytes = (json.dumps(registry, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with tempfile.TemporaryDirectory() as temp_dir:
        tar_path = Path(temp_dir) / "driver.tar"
        with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as archive:
            registry_info = tarfile.TarInfo("agent-registry.json")
            registry_info.size = len(registry_bytes)
            registry_info.mode = 0o644
            registry_info.mtime = 0
            archive.addfile(registry_info, io.BytesIO(registry_bytes))

            driver_info = archive.gettarinfo(str(source), arcname=f"drivers/{source.name}")
            driver_info.mode = 0o755 if executable else 0o644
            driver_info.mtime = 0
            driver_info.uid = 0
            driver_info.gid = 0
            driver_info.uname = ""
            driver_info.gname = ""
            with source.open("rb") as driver_file:
                archive.addfile(driver_info, driver_file)

        subprocess.run(
            ["zstd", "-q", "-19", "--force", str(tar_path), "-o", str(output)],
            check=True,
        )


def release_url_with_filename(url: str, filename: str) -> str:
    prefix, separator, _ = url.rpartition("/")
    return f"{prefix}{separator}{filename}" if separator else filename


def packaged_artifact(artifact: dict, source: Path) -> dict:
    packaged = copy.deepcopy(artifact)
    packaged["url"] = source.name
    packaged["size"] = source.stat().st_size
    packaged.pop("format", None)
    return packaged


def update_release_artifact(artifact: dict, output: Path) -> None:
    artifact["url"] = release_url_with_filename(artifact["url"], output.name)
    artifact["size"] = output.stat().st_size
    artifact["sha256"] = hashlib.sha256(output.read_bytes()).hexdigest()
    artifact["format"] = "tar_zstd"


def build_driver_zips(release_dir: Path) -> list[Path]:
    registry_path = release_dir / "agent-registry.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    outputs: list[Path] = []

    for driver_name, driver in registry.get("drivers", {}).items():
        version = driver["version"]
        jar_artifact = driver.get("jar")
        if jar_artifact and jar_artifact.get("size", 0) > 0:
            filename = artifact_filename(jar_artifact["url"])
            source = release_dir / filename
            if not source.is_file():
                raise FileNotFoundError(f"Java agent artifact missing for {driver_name}: {source}")

            package_driver = copy.deepcopy(driver)
            package_driver.pop("native", None)
            package_driver["jar"] = packaged_artifact(jar_artifact, source)
            package_registry = {"jres": {}, "drivers": {driver_name: package_driver}}
            output = release_dir / f"dbx-agent-{driver_name}-{version}.tar.zst"
            if not output.exists():
                write_driver_tar_zstd(output, package_registry, source, executable=False)
            elif not output.is_file():
                raise FileExistsError(f"Reusable Java agent package is not a file: {output}")
            update_release_artifact(jar_artifact, output)
            outputs.append(output)

        for platform, artifact in driver.get("native", {}).items():
            filename = artifact_filename(artifact["url"])
            source = release_dir / filename
            if not source.is_file():
                raise FileNotFoundError(f"Native agent artifact missing for {driver_name}/{platform}: {source}")

            package_driver = copy.deepcopy(driver)
            package_driver.pop("jar", None)
            package_driver["native"] = {platform: packaged_artifact(artifact, source)}
            package_registry = {"jres": {}, "drivers": {driver_name: package_driver}}
            output = release_dir / f"dbx-agent-{driver_name}-{version}-{platform}.tar.zst"
            if not output.exists():
                write_driver_tar_zstd(output, package_registry, source, executable=True)
            elif not output.is_file():
                raise FileExistsError(f"Reusable native agent package is not a file: {output}")
            update_release_artifact(artifact, output)
            outputs.append(output)

    registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return outputs


def remove_raw_driver_artifacts(release_dir: Path) -> list[Path]:
    removed: list[Path] = []
    for path in sorted(release_dir.glob("dbx-agent-*")):
        if path.name.endswith(".tar.zst") or not path.is_file():
            continue
        path.unlink()
        removed.append(path)
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description="Build tar.zst packages for individual DBX agents")
    parser.add_argument("release_dir", type=Path)
    parser.add_argument("--cleanup-sources", action="store_true")
    args = parser.parse_args()

    for path in build_driver_zips(args.release_dir):
        print(f"Prepared {path.name} ({path.stat().st_size} bytes)")
    if args.cleanup_sources:
        for path in remove_raw_driver_artifacts(args.release_dir):
            print(f"Removed intermediate {path.name}")


if __name__ == "__main__":
    main()
