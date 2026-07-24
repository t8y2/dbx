#!/usr/bin/env python3
"""Verify that the TAURI_SIGNING_PRIVATE_KEY_BASE64 secret on sorchk/dbx
matches the updater.pubkey in src-tauri/tauri.conf.json.

Tauri's `cargo tauri signer generate -w file.key` produces a paired
.key (private, rsign format) and .key.pub (public, also rsign format).
Both files are base64-of-the-actual-key-text.

The GitHub secret `TAURI_SIGNING_PRIVATE_KEY_BASE64` is the content of
the .key file. The `updater.pubkey` field in tauri.conf.json is the
content of the .key.pub file.

Both rsign and standard minisign use the same Ed25519 signature scheme,
so a sig produced by `cargo tauri signer sign` can be verified by
`minisign -V` after converting the .key.pub from rsign format (which is
base64 of minisign text) to plain minisign text (single base64 decode).

Usage:
  python3 .github/scripts/verify-tauri-key.py "<TAURI_SIGNING_PRIVATE_KEY_BASE64>"
  python3 .github/scripts/verify-tauri-key.py < secret.txt
  python3 .github/scripts/verify-tauri-key.py /path/to/private.key
"""
import base64
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
TAURI_CONF = REPO / "src-tauri" / "tauri.conf.json"


def find_minisign() -> str | None:
    for name in ("minisign", "minisign.exe"):
        found = shutil.which(name)
        if found:
            return found
    return None


def main() -> int:
    if not TAURI_CONF.exists():
        print(f"ERROR: {TAURI_CONF} not found", file=sys.stderr)
        return 2

    with TAURI_CONF.open() as f:
        conf = json.load(f)
    pubkey_b64 = conf.get("plugins", {}).get("updater", {}).get("pubkey")
    if not pubkey_b64:
        print("ERROR: updater.pubkey not set in tauri.conf.json", file=sys.stderr)
        return 2

    print("pubkey in tauri.conf.json:")
    print(f"  length: {len(pubkey_b64)} chars")
    print(f"  preview: {pubkey_b64[:60]}...{pubkey_b64[-20:]}")
    print()

    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if Path(arg).is_file():
            b64_secret = Path(arg).read_text().strip()
        else:
            b64_secret = arg.strip()
    elif not sys.stdin.isatty():
        b64_secret = sys.stdin.read().strip()
    else:
        print("ERROR: provide the secret as argv[1] (file path or string) or via stdin", file=sys.stderr)
        return 1

    try:
        key_text = base64.b64decode(b64_secret, validate=True).decode("utf-8")
    except Exception as e:
        print(f"ERROR: secret is not valid base64-of-utf8: {e}", file=sys.stderr)
        return 1

    if "rsign" not in key_text and "minisign" not in key_text:
        print("ERROR: decoded secret doesn't look like a minisign/rsign key file", file=sys.stderr)
        print(f"  first line: {key_text.splitlines()[0]!r}", file=sys.stderr)
        return 1

    print(f"secret decoded OK; first line: {key_text.splitlines()[0]!r}")
    print(f"  line 1 length: {len(key_text.splitlines()[1])} chars of base64")
    print()

    minisign = find_minisign()
    if not minisign:
        print("ERROR: minisign CLI not found on PATH", file=sys.stderr)
        return 1
    print(f"using minisign: {minisign}")
    print()

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        pub_file_minisign = td_path / "public.key.minisign.pub"
        test_file = td_path / "payload.bin"
        sig_file = td_path / "payload.bin.sig"
        sig_file_minisign = td_path / "payload.bin.minisig.sig"

        try:
            pub_file_minisign.write_text(base64.b64decode(pubkey_b64, validate=True).decode("utf-8"))
        except Exception as e:
            print(f"ERROR: cannot decode pubkey to minisign format: {e}", file=sys.stderr)
            return 1

        test_file.write_bytes(b"dbx-tauri-key-verification-payload-v1")

        r = subprocess.run(
            ["cargo", "tauri", "signer", "sign", "-k", b64_secret, "--password", "", str(test_file)],
            capture_output=True, text=True, cwd=str(td_path),
        )
        if r.returncode != 0 or not sig_file.exists():
            print("ERROR: cargo tauri signer sign failed", file=sys.stderr)
            print(f"  stdout: {r.stdout[:500]}", file=sys.stderr)
            print(f"  stderr: {r.stderr[:500]}", file=sys.stderr)
            return 1

        try:
            sig_file_minisign.write_text(base64.b64decode(sig_file.read_text().strip()).decode("utf-8"))
        except Exception as e:
            print(f"ERROR: cannot decode tauri .sig to minisign format: {e}", file=sys.stderr)
            return 1

        v = subprocess.run(
            [minisign, "-V", "-x", str(sig_file_minisign), "-p", str(pub_file_minisign), "-m", str(test_file), "-q"],
            capture_output=True, text=True,
        )
        print("=== minisign verify ===")
        if v.returncode == 0:
            print(f"stdout: {v.stdout.strip() or '(empty)'}")
            print()
            print("MATCH -- private key in secret correctly signs files that the")
            print("  pubkey in tauri.conf.json can verify. Tauri updater will work.")
            return 0
        else:
            print(f"stdout: {v.stdout.strip()}")
            print(f"stderr: {v.stderr.strip()}")
            print()
            print("MISMATCH -- sig made with the secret does NOT verify against the")
            print("  pubkey in tauri.conf.json. Updater verification will fail at runtime.")
            return 1


if __name__ == "__main__":
    sys.exit(main())
