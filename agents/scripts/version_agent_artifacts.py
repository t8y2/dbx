#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


NATIVE_DRIVERS = ("oracle", "xugu", "kingbase")
PLATFORMS = (
    "macos-aarch64",
    "macos-x64",
    "linux-aarch64",
    "linux-x64",
    "windows-aarch64",
    "windows-x64",
)


def rename_artifact(source: Path, target: Path) -> Path | None:
    if not source.exists():
        return None
    if target.exists():
        raise FileExistsError(f"Versioned agent artifact already exists: {target}")
    source.rename(target)
    return target


def version_agent_artifacts(release_dir: Path, versions: dict[str, str]) -> list[Path]:
    renamed: list[Path] = []
    for driver, version in sorted(versions.items()):
        jar = rename_artifact(
            release_dir / f"dbx-agent-{driver}.jar",
            release_dir / f"dbx-agent-{driver}-{version}.jar",
        )
        if jar:
            renamed.append(jar)

    for driver in NATIVE_DRIVERS:
        version = versions.get(driver)
        if not version:
            raise ValueError(f"Missing version for native driver: {driver}")
        for platform in PLATFORMS:
            extension = ".exe" if platform.startswith("windows-") else ""
            artifact = rename_artifact(
                release_dir / f"dbx-agent-{driver}-{platform}{extension}",
                release_dir / f"dbx-agent-{driver}-{version}-{platform}{extension}",
            )
            if artifact:
                renamed.append(artifact)
    return renamed


def main() -> None:
    parser = argparse.ArgumentParser(description="Add module versions to DBX agent release filenames")
    parser.add_argument("release_dir", type=Path)
    parser.add_argument("versions_json")
    args = parser.parse_args()

    versions = json.loads(args.versions_json)
    for path in version_agent_artifacts(args.release_dir, versions):
        print(f"Versioned {path.name}")


if __name__ == "__main__":
    main()
