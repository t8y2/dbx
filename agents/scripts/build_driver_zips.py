#!/usr/bin/env python3
import argparse
import copy
import json
import zipfile
from pathlib import Path
from urllib.parse import urlparse


def artifact_filename(url: str) -> str:
    return Path(urlparse(url).path).name


def write_driver_zip(output: Path, registry: dict, source: Path) -> None:
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("agent-registry.json", json.dumps(registry, ensure_ascii=False, indent=2) + "\n")
        archive.write(source, f"drivers/{source.name}")


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
            package_driver["jar"] = {"url": source.name, "size": source.stat().st_size}
            package_registry = {"jres": {}, "drivers": {driver_name: package_driver}}
            output = release_dir / f"dbx-agent-{driver_name}-{version}.zip"
            write_driver_zip(output, package_registry, source)
            outputs.append(output)

        for platform, artifact in driver.get("native", {}).items():
            filename = artifact_filename(artifact["url"])
            source = release_dir / filename
            if not source.is_file():
                raise FileNotFoundError(f"Native agent artifact missing for {driver_name}/{platform}: {source}")

            package_driver = copy.deepcopy(driver)
            package_driver.pop("jar", None)
            package_driver["native"] = {platform: {"url": source.name, "size": source.stat().st_size}}
            package_registry = {"jres": {}, "drivers": {driver_name: package_driver}}
            output = release_dir / f"dbx-agent-{driver_name}-{version}-{platform}.zip"
            write_driver_zip(output, package_registry, source)
            outputs.append(output)

    return outputs


def main() -> None:
    parser = argparse.ArgumentParser(description="Build offline ZIPs for individual DBX agents")
    parser.add_argument("release_dir", type=Path)
    args = parser.parse_args()

    for path in build_driver_zips(args.release_dir):
        print(f"Created {path.name} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
