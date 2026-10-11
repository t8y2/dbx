#!/usr/bin/env python3
"""Add Google's public Docker Hub cache without replacing daemon settings."""

import argparse
import json
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

MIRROR = "https://mirror.gcr.io"


def configure(path, validate=None):
    path = Path(path)
    config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if not isinstance(config, dict):
        raise ValueError("Docker daemon config must be a JSON object")
    mirrors = config.get("registry-mirrors", [])
    if not isinstance(mirrors, list) or any(not isinstance(item, str) for item in mirrors):
        raise ValueError("registry-mirrors must be an array of strings")
    if any(item.rstrip("/") == MIRROR for item in mirrors):
        return
    config["registry-mirrors"] = [*mirrors, MIRROR]
    original_stat = path.stat() if path.exists() else None
    candidate = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix="daemon-mirror-", suffix=".json", delete=False) as output:
            candidate = Path(output.name)
            output.write(json.dumps(config, indent=2) + "\n")
        candidate.chmod(stat.S_IMODE(original_stat.st_mode) if original_stat else 0o644)
        if original_stat and hasattr(os, "chown"):
            os.chown(candidate, original_stat.st_uid, original_stat.st_gid)
        if validate:
            validate(candidate)
        if original_stat:
            backup = path.with_name(path.name + ".before-dbx-mirror")
            if not backup.exists():
                descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                     stat.S_IMODE(original_stat.st_mode))
                with os.fdopen(descriptor, "wb") as output:
                    output.write(path.read_bytes())
                shutil.copystat(path, backup)
                if hasattr(os, "chown"):
                    os.chown(backup, original_stat.st_uid, original_stat.st_gid)
        os.replace(candidate, path)
    finally:
        if candidate and candidate.exists():
            candidate.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--validate", action="store_true", help="Validate with dockerd before replacing config")
    args = parser.parse_args()

    def validate(candidate):
        subprocess.run(["dockerd", "--validate", "--config-file", str(candidate)], check=True, timeout=15)

    configure(args.config, validate if args.validate else None)
