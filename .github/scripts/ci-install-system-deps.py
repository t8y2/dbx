#!/usr/bin/env python3
"""Download Ubuntu dependencies with at most two mirror switches, then install offline."""

import argparse
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

SOURCES = Path("/etc/apt/sources.list.d/ubuntu.sources")
LEGACY_SOURCES = Path("/etc/apt/sources.list")
PRIMARY = "https://archive.ubuntu.com/ubuntu/"
BACKUP = "https://mirrors.edge.kernel.org/ubuntu/"
LAST_RESORT = "http://azure.archive.ubuntu.com/ubuntu/"
MIRRORS = [("primary", PRIMARY), ("backup", BACKUP), ("last-resort", LAST_RESORT)]
PORT_MIRRORS = [("primary", "https://ports.ubuntu.com/ubuntu-ports/"),
                ("backup", "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/")]
PACKAGES = ["libwebkit2gtk-4.1-dev", "libappindicator3-dev", "librsvg2-dev",
            "patchelf", "libssl-dev", "libsecret-1-dev"]
PACKAGE_GROUPS = {"gtk": PACKAGES, "packaging": ["zstd"],
                  "duckdb": ["libdbus-1-dev", "pkg-config"],
                  "release": ["fcitx5-frontend-gtk3", "ibus-gtk3", "libwebkit2gtk-4.1-dev",
                              "libgtk-3-dev", "libappindicator3-dev", "librsvg2-dev", "patchelf",
                              "libssl-dev", "xdg-utils", "lld"],
                  "node-release": ["libfontconfig1-dev", "libsecret-1-dev"],
                  "fontconfig": ["libfontconfig1-dev"],
                  "preview": ["ffmpeg", "fonts-noto-cjk", "fonts-noto-color-emoji"]}
ACQUIRE_OPTIONS = ["-o", "Acquire::Retries=0", "-o", "Acquire::http::Timeout=30",
                   "-o", "Acquire::https::Timeout=30", "-o", "APT::Update::Error-Mode=any"]
starting_process = False
pending_cancel = None


def rewrite_ubuntu_uris(source, mirror):
    known = {"mirror+file:/etc/apt/apt-mirrors.txt", PRIMARY, PRIMARY.rstrip("/"),
             BACKUP, BACKUP.rstrip("/"), LAST_RESORT, LAST_RESORT.rstrip("/")}
    known.update({"http://archive.ubuntu.com/ubuntu", "http://archive.ubuntu.com/ubuntu/"})
    if any(mirror == uri for _label, uri in PORT_MIRRORS):
        known = {uri.rstrip("/") + suffix for _label, uri in PORT_MIRRORS for suffix in ("", "/")}
        known.update({"http://ports.ubuntu.com/ubuntu-ports", "http://ports.ubuntu.com/ubuntu-ports/"})
    found = 0
    in_uris = False
    result = []

    def replace(match):
        nonlocal found
        if match.group() in known:
            found += 1
            return mirror
        return match.group()

    for line in source.splitlines(keepends=True):
        if line.lstrip().startswith("#"):
            result.append(line)
            continue
        legacy = re.match(r"^(\s*deb(?:-src)?\s+(?:\[[^\]]*\]\s+)?)(\S+)", line)
        if legacy:
            uri = legacy.group(2)
            if uri in known:
                found += 1
                line = line[:legacy.start(2)] + mirror + line[legacy.end(2):]
            result.append(line)
            continue
        field = re.match(r"^([A-Za-z][A-Za-z0-9-]*):", line)
        if field:
            in_uris = field[1].lower() == "uris"
        elif not line.strip() or not line[0].isspace():
            in_uris = False
        if in_uris:
            prefix = field.end() if field else 0
            line = line[:prefix] + re.sub(r"\S+", replace, line[prefix:])
        result.append(line)
    if not found:
        raise ValueError("Ubuntu sources do not contain the expected runner mirror URI")
    return "".join(result)


def is_retryable_acquisition_failure(output, timed_out):
    if re.search(r"signature|NO_PUBKEY|GPG error|certificate|not signed|Release file|"
                 r"Hash Sum mismatch|unexpected size|Unable to locate package|unmet dependencies|"
                 r"held broken packages|Could not get lock|Unable to acquire|Waiting for cache lock|"
                 r"dpkg was interrupted|Permission denied|No space left|404\s", output, re.I):
        return False
    reasons = []
    for line in output.splitlines():
        fetch = re.match(r"[EW]: Failed to fetch \S+\s+(.+)", line)
        if fetch:
            reasons.append(fetch[1])
        elif line.startswith("E:") and not line.startswith((
            "E: Unable to fetch some archives,", "E: Some index files failed to download."
        )):
            return False
    network = re.compile(r"Temporary failure resolving|Could not resolve|Could not connect|"
                         r"Connection (?:failed|timed out|reset)|Network is unreachable|"
                         r"Error reading from server|Remote end closed|"
                         r"(?:^|\s)(?:429|500|502|503|504)(?:\s|$)", re.I)
    if any(not network.search(reason) for reason in reasons):
        return False
    return timed_out or bool(reasons)


class Cancelled(BaseException):
    def __init__(self, signum):
        self.signum = signum


def cancel(signum, _frame):
    global pending_cancel
    # Finish child disposal and source restoration even if cancellation repeats.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if starting_process:
        pending_cancel = signum
        return
    raise Cancelled(signum)


def dispose(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return process.communicate()[0]


def run_apt(arguments, budget):
    global starting_process, pending_cancel
    started = time.monotonic()
    process = None
    timed_out = False
    try:
        starting_process = True
        process = subprocess.Popen(
            ["apt-get", *ACQUIRE_OPTIONS, *arguments], stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, env={**os.environ, "LC_ALL": "C"},
            start_new_session=True,
        )
        starting_process = False
        if pending_cancel is not None:
            signum, pending_cancel = pending_cancel, None
            raise Cancelled(signum)
        try:
            output = process.communicate(timeout=budget)[0]
        except subprocess.TimeoutExpired:
            timed_out = True
            output = dispose(process)
    except BaseException:
        if process is not None:
            dispose(process)
        raise
    finally:
        starting_process = False
    print(output, end="", flush=True)
    print(f"APT finished elapsed={time.monotonic() - started:.1f}s "
          f"exit={process.returncode} timed_out={timed_out}", flush=True)
    return process.returncode, output, timed_out


def install(source_path=None, group="gtk"):
    if source_path is None:
        source_path = SOURCES if SOURCES.exists() else LEGACY_SOURCES
    packages = PACKAGE_GROUPS[group]
    original = source_path.read_bytes()
    source = original.decode("utf-8")
    active_source = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("#"))
    mirrors = PORT_MIRRORS if re.search(r"https?://[^\s]+/ubuntu-ports/?(?:\s|$)", active_source) else MIRRORS
    candidates = [(label, rewrite_ubuntu_uris(source, mirror)) for label, mirror in mirrors]
    try:
        for index, (label, candidate) in enumerate(candidates):
            source_path.write_bytes(candidate.encode("utf-8"))
            for phase, arguments, budget in [
                ("index", ["update"], 60),
                ("download", ["--download-only", "install", "-y", *packages], 120),
            ]:
                print(f"APT source={label} phase={phase} budget={budget}s", flush=True)
                code, output, timed_out = run_apt(arguments, budget)
                if code != 0 or timed_out:
                    if index + 1 < len(candidates) and is_retryable_acquisition_failure(output, timed_out):
                        reason = "acquisition deadline" if timed_out else "transient acquisition error"
                        print(f"APT switching to next source {mirrors[index + 1][1]}: {reason}", flush=True)
                        break
                    raise RuntimeError(f"APT {label} {phase} failed (exit={code}, timed_out={timed_out})")
            else:
                break
        print("APT phase=install budget=1200s downloads=disabled", flush=True)
        code, _output, timed_out = run_apt(["--no-download", "install", "-y", *packages], 1200)
        if code != 0 or timed_out:
            raise RuntimeError(f"APT offline install failed (exit={code}, timed_out={timed_out})")
    finally:
        source_path.write_bytes(original)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--group", choices=PACKAGE_GROUPS, default="gtk")
        install(group=parser.parse_args().group)
    except Cancelled as error:
        print("APT cancelled; no mirror retry", file=sys.stderr)
        sys.exit(128 + error.signum)
    except Exception as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
