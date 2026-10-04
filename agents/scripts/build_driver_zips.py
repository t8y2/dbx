#!/usr/bin/env python3
import argparse
import copy
import hashlib
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
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


# Incremental updates only pay off for packages big enough to matter on slow
# links; small packages ship a full download either way.
MIN_DELTA_FULL_SIZE = 8 * 1024 * 1024
# A delta larger than this fraction of the full package is not worth hosting:
# clients would rather re-download the full artifact.
MAX_DELTA_RATIO = 0.5


class DeltaGenerator:
    """Generates `zstd --patch-from` deltas between two releases of one artifact.

    The previous registry (from the `agents-latest` release) provides each
    driver's previously published version and artifact URL. For every artifact
    whose version changed, the previous package is downloaded once, the new
    package is compressed against it, and — when the delta is small enough to
    be worth it — both the `.delta` file and the registry `delta` block are
    emitted. Any failure to produce a delta is logged and skipped: the release
    must never break because an incremental update could not be built.
    """

    def __init__(
        self,
        release_dir: Path,
        previous_registry: dict | None,
        *,
        min_full_size: int = MIN_DELTA_FULL_SIZE,
        max_ratio: float = MAX_DELTA_RATIO,
        verbose: bool = True,
    ) -> None:
        self.release_dir = release_dir
        self.previous_registry = previous_registry or {"drivers": {}}
        self.min_full_size = min_full_size
        self.max_ratio = max_ratio
        self.verbose = verbose
        self._downloads: dict[str, Path] = {}
        self._download_dir: Path | None = None

    def _previous_driver(self, driver_name: str) -> dict | None:
        return self.previous_registry.get("drivers", {}).get(driver_name)

    def _download_previous(self, url: str) -> Path | None:
        if url in self._downloads:
            return self._downloads[url]
        if self._download_dir is None:
            self._download_dir = Path(tempfile.mkdtemp(prefix="dbx-delta-prev-"))
        target = self._download_dir / artifact_filename(url)
        try:
            with urllib.request.urlopen(url) as response, target.open("wb") as out:
                out.write(response.read())
        except Exception as error:  # noqa: BLE001 - any fetch failure just skips the delta
            print(f"  delta skipped (previous artifact unavailable: {error})", file=sys.stderr)
            return None
        self._downloads[url] = target
        return target

    def maybe_generate(
        self,
        driver_name: str,
        new_version: str,
        new_artifact: dict,
        previous_artifact: dict | None,
        new_package: Path,
        suffix: str,
    ) -> None:
        """Attaches a `delta` block to the freshly packaged `new_artifact`.

        `previous_artifact` is the same artifact slot (jar, or one native
        platform) in the previous registry and only supplies the base package
        URL; `suffix` distinguishes native platforms in the delta file name.
        """
        if not previous_artifact:
            return
        if new_package.stat().st_size < self.min_full_size:
            return
        previous_driver = self._previous_driver(driver_name) or {}
        previous_version = str(previous_driver.get("version", ""))
        if not previous_version or previous_version == new_version:
            return
        base_url = previous_artifact.get("url", "")
        if not base_url:
            return
        previous_package = self._download_previous(base_url)
        if previous_package is None:
            return

        stem = f"dbx-agent-{driver_name}-{previous_version}-to-{new_version}{suffix}"
        delta_path = self.release_dir / f"{stem}.tar.zst.delta"
        try:
            subprocess.run(
                [
                    "zstd", "-q", "--patch-from", str(previous_package),
                    str(new_package), "-o", str(delta_path), "--force",
                ],
                check=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            print(f"  delta skipped (zstd failed: {error})", file=sys.stderr)
            delta_path.unlink(missing_ok=True)
            return

        delta_size = delta_path.stat().st_size
        if delta_size > self.max_ratio * new_package.stat().st_size:
            delta_path.unlink()
            if self.verbose:
                ratio = delta_size / new_package.stat().st_size
                print(f"  delta skipped ({ratio:.0%} of full package, above {self.max_ratio:.0%})")
            return

        # `new_artifact["url"]` already points at the packaged tar.zst on this
        # release; the delta file rides the same release, so only the file name
        # needs swapping.
        new_artifact["delta"] = {
            "base_version": previous_version,
            "url": release_url_with_filename(new_artifact["url"], delta_path.name),
            "sha256": hashlib.sha256(delta_path.read_bytes()).hexdigest(),
            "size": delta_size,
        }
        if self.verbose:
            ratio = delta_size / new_package.stat().st_size
            print(f"  delta {delta_path.name} ({delta_size} bytes, {ratio:.0%} of full)")


def build_driver_zips(
    release_dir: Path,
    previous_registry: dict | None = None,
    *,
    delta_min_full_size: int = MIN_DELTA_FULL_SIZE,
    delta_max_ratio: float = MAX_DELTA_RATIO,
) -> list[Path]:
    registry_path = release_dir / "agent-registry.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    delta_generator = DeltaGenerator(
        release_dir,
        previous_registry,
        min_full_size=delta_min_full_size,
        max_ratio=delta_max_ratio,
    )
    outputs: list[Path] = []

    for driver_name, driver in registry.get("drivers", {}).items():
        version = driver["version"]
        previous_driver = delta_generator._previous_driver(driver_name)
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
            delta_generator.maybe_generate(
                driver_name, version, jar_artifact,
                (previous_driver or {}).get("jar"), output, "",
            )
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
            delta_generator.maybe_generate(
                driver_name, version, artifact,
                (previous_driver or {}).get("native", {}).get(platform), output, f"-{platform}",
            )
            outputs.append(output)

    registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return outputs


def remove_raw_driver_artifacts(release_dir: Path) -> list[Path]:
    removed: list[Path] = []
    for path in sorted(release_dir.glob("dbx-agent-*")):
        if path.name.endswith(".tar.zst") or path.name.endswith(".delta") or not path.is_file():
            continue
        path.unlink()
        removed.append(path)
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description="Build tar.zst packages for individual DBX agents")
    parser.add_argument("release_dir", type=Path)
    parser.add_argument("--cleanup-sources", action="store_true")
    parser.add_argument(
        "--previous-registry",
        type=Path,
        default=None,
        help=(
            "agent-registry.json of the previous agents release; enables "
            "incremental delta patches between consecutive driver versions"
        ),
    )
    args = parser.parse_args()

    previous_registry = None
    if args.previous_registry and args.previous_registry.is_file():
        previous_registry = json.loads(args.previous_registry.read_text(encoding="utf-8"))

    for path in build_driver_zips(args.release_dir, previous_registry):
        print(f"Prepared {path.name} ({path.stat().st_size} bytes)")
    if args.cleanup_sources:
        for path in remove_raw_driver_artifacts(args.release_dir):
            print(f"Removed intermediate {path.name}")


if __name__ == "__main__":
    main()
