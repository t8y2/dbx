"""Use Ubuntu's primary archive when a runner image selects the Azure mirror."""

import argparse
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("apt_dir", type=Path)
args = parser.parse_args()

# Hosted runners can reference this mirror list instead of an archive URI directly.
for pattern in ("sources.list", "sources.list.d/*.list", "sources.list.d/*.sources", "apt-mirrors.txt"):
    for source in args.apt_dir.glob(pattern):
        original = source.read_bytes()
        updated = re.sub(
            rb"https?://azure\.archive\.ubuntu\.com/ubuntu(?=[/\s]|$)",
            b"https://archive.ubuntu.com/ubuntu",
            original,
        )
        if updated != original:
            source.write_bytes(updated)
            print(f"Updated Ubuntu archive in {source.name}")
