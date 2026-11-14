#!/usr/bin/env python3
"""Build a source-verified, repository-locked Phoenix compatibility runtime.

No DBX installation is modified. Every output is beneath a new --work directory.
The release catalog is an approval gate, never updated by a release build.
"""
import argparse
import concurrent.futures
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
CATALOG = REPO / "crates/dbx-core/assets/jdbc-compatibility-runtimes.json"
RUNTIME_ID = "phoenix-5.0-hbase-2.0-compat"
VERSION = "5.0.0-dbx.1"
COORDINATE = "app.dbx.compat:phoenix-hbase-2.0:" + VERSION
BUNDLE_ID = COORDINATE.replace(":", "_")
ZIP_NAME = "phoenix-5.0.0-hbase-2.0-dbx.1.zip"
RELEASE_TAG = "jdbc-compat-phoenix-" + VERSION
RELEASE_URL = "https://github.com/t8y2/dbx/releases/download/" + RELEASE_TAG + "/" + ZIP_NAME
PHOENIX_NAME = "phoenix-5.0.0-HBase-2.0-client.jar"
SOURCE_URL = "https://archive.apache.org/dist/phoenix/apache-phoenix-5.0.0-HBase-2.0/src/apache-phoenix-5.0.0-HBase-2.0-src.tar.gz"
SOURCE_SHA256 = "0cfa1bd3ddf9e80eeafc76a07027e2a69bcbbbf8d58310fc852abb65fe719533"
MAVEN_URL = "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.tar.gz"
MAVEN_SHA512 = "a555254d6b53d267965a3404ecb14e53c3827c09c3b94b5678835887ab404556bfaf78dcfe03ba76fa2508649dca8531c74bca4d5846513522404d48e8c4ac8b"
ZK_PATH = "org/apache/zookeeper/zookeeper/3.4.10/zookeeper-3.4.10.jar"
STAMP = (1980, 1, 1, 0, 0, 0)


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def digest(path, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def verify(path, expected, size=None, algorithm="sha256"):
    if (size is not None and Path(path).stat().st_size != size) or digest(path, algorithm) != expected:
        raise ValueError("Checksum/size mismatch: " + str(path))


def safe_relative(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts or "\\" in value or ":" in value:
        raise ValueError("Unsafe archive/repository path: " + value)
    return path


def acquire(url, target, expected, size=None, seed=None, algorithm="sha256"):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".download")
    if seed is not None and Path(seed).is_file():
        shutil.copyfile(seed, temporary)
    else:
        if not url.startswith("https://"):
            raise ValueError("Only HTTPS input URLs are permitted")
        with urllib.request.urlopen(url, timeout=90) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
    verify(temporary, expected, size, algorithm)
    temporary.replace(target)


def extract_source(archive_path, destination):
    with tarfile.open(archive_path) as archive:
        members = archive.getmembers()
        for item in members:
            safe_relative(item.name)
            if not (item.isdir() or item.isfile()):
                # Maven contains no required links; reject links/devices outright.
                raise ValueError("Unsupported archive member: " + item.name)
        for item in members:
            output = destination.joinpath(*PurePosixPath(item.name).parts)
            if item.isdir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(item) as src, output.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                output.chmod(item.mode & 0o777)


def patch_source(source):
    pom = source / "pom.xml"
    content = pom.read_text()
    before = "<artifactId>maven-shade-plugin</artifactId>\n          <version>2.4.3</version>"
    after = "<artifactId>maven-shade-plugin</artifactId>\n          <version>3.0.0</version>"
    if content.count(before) != 1:
        raise ValueError("Unexpected Phoenix source: Shade version patch must match exactly once")
    pom.write_text(content.replace(before, after))


def load_lock():
    lock = json.loads((ROOT / "repository-lock.json").read_text())
    if lock["format_version"] != 1 or lock["repository"] != "https://repo.maven.apache.org/maven2":
        raise ValueError("Unsupported dependency lock")
    seen = set()
    for entry in lock["artifacts"] + lock["metadata"]:
        safe_relative(entry["path"])
        if entry["path"] in seen:
            raise ValueError("Duplicate locked path")
        seen.add(entry["path"])
    # Source reactor must build Phoenix itself, never substitute a downloaded main JAR.
    if any(x["path"].startswith("org/apache/phoenix/") and x["path"].endswith(".jar") and not x["path"].endswith("-tests.jar") for x in lock["artifacts"]):
        raise ValueError("Phoenix main binary is forbidden in build repository")
    return lock


def prepare_repository(destination, seed=None):
    lock = load_lock()
    destination.mkdir(parents=True, exist_ok=False)

    def fetch(entry):
        rel = entry["path"]
        acquire(lock["repository"] + "/" + rel, destination / rel, entry["sha256"], entry["size"], Path(seed) / rel if seed else None)

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        list(executor.map(fetch, lock["artifacts"]))
    for entry in lock["metadata"]:
        target = destination / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(entry["content"])


def verify_repository(repository):
    for entry in load_lock()["artifacts"]:
        verify(repository / entry["path"], entry["sha256"], entry["size"])


def normalized_entry(name, content):
    # Only the outer unsigned Phoenix JAR is normalized. Dependencies remain embedded
    # unchanged except these non-executable build metadata entries.
    if name == "META-INF/MANIFEST.MF":
        lines = content.decode("utf-8").replace("\r\n", "\n").splitlines()
        keep, dropping = [], False
        for line in lines:
            if not line.startswith(" "):
                dropping = line.startswith(("Built-By:", "Build-Jdk:", "Created-By:"))
            if not dropping:
                keep.append(line)
        return ("\r\n".join(keep).rstrip() + "\r\n\r\n").encode()
    if name.startswith("META-INF/maven/org.apache.phoenix/") and name.endswith("/pom.properties"):
        return ("\n".join(line for line in content.decode().splitlines() if not line.startswith("#")) + "\n").encode()
    if name == "mrapp-generated-classpath":
        # Phoenix's generate-test-resources execution writes this build-machine
        # classpath into target/classes. No client class references the resource.
        # Preserve the locked dependency order, removing unusable host prefixes.
        locked = {entry["path"] for entry in load_lock()["artifacts"]}
        paths = []
        for value in content.decode().strip().split(":"):
            if value.endswith("/lib/tools.jar"):
                paths.append("jdk/lib/tools.jar")
                continue
            matches = [path for path in locked if value.endswith("/" + path)]
            if len(matches) != 1:
                raise ValueError("Unrecognized generated test classpath entry: " + value)
            paths.append("m2/" + matches[0])
        return ":".join(paths).encode()
    return content


def write_zip(path, entries, compression=zipfile.ZIP_STORED):
    # Stored outer entries avoid depending on a particular zlib implementation.
    with zipfile.ZipFile(path, "x") as archive:
        for name, data in sorted(entries.items()):
            safe_relative(name)
            info = zipfile.ZipInfo(name, STAMP)
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = compression
            archive.writestr(info, data)


def normalize_jar(source, target):
    with zipfile.ZipFile(source) as jar:
        names = jar.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate JAR entries")
        if any(re.fullmatch(r"META-INF/[^/]+\.(SF|RSA|DSA|EC)", n, re.I) for n in names):
            raise ValueError("Refusing to invalidate signed JAR")
        entries = {n: normalized_entry(n, jar.read(n)) for n in names if not n.endswith("/")}
        write_zip(target, entries)
        with zipfile.ZipFile(target) as normalized:
            if any(jar.read(n) != normalized.read(n) for n in names if n.endswith(".class")):
                raise ValueError("Class bytes changed during normalization")
    return {"sha256": digest(target), "size": target.stat().st_size, "class_bytes_preserved": True}


def artifact(path, group, artifact_id, version):
    return {"group_id": group, "artifact_id": artifact_id, "version": version, "classifier": "", "extension": "jar", "file_name": path.name, "path": "jars/" + path.name, "size": path.stat().st_size, "sha256": digest(path)}


def package(phoenix, zookeeper, output):
    output.mkdir(parents=True, exist_ok=False)
    lock = load_lock()
    zk_entry = next(x for x in lock["artifacts"] if x["path"] == ZK_PATH)
    verify(zookeeper, zk_entry["sha256"], zk_entry["size"])
    normalized = output / PHOENIX_NAME
    normalization = normalize_jar(phoenix, normalized)
    artifacts = [artifact(normalized, "app.dbx.compat", "phoenix-hbase-2.0", VERSION), artifact(zookeeper, "org.apache.zookeeper", "zookeeper", "3.4.10")]
    descriptor = {"format_version": 1, "id": RUNTIME_ID, "version": VERSION, "bundles": [{"id": BUNDLE_ID, "coordinate": COORDINATE}]}
    manifest = {"id": BUNDLE_ID, "coordinate": COORDINATE, "scope": "runtime", "repositories": [], "installed_at": "1980-01-01T00:00:00Z", "path": ".", "artifacts": artifacts}
    provenance = {"id": RUNTIME_ID, "version": VERSION, "publisher": "DBX compatibility build; not an Apache release", "source_url": SOURCE_URL, "source_sha256": SOURCE_SHA256, "patch": "maven-shade-plugin 2.4.3 -> 3.0.0", "repository_lock_sha256": digest(ROOT / "repository-lock.json"), "normalization": "Sorted stored ZIP entries at 1980-01-01; removed outer Built-By/Build-Jdk/Created-By and Phoenix pom.properties comments; canonicalized generated test-only mrapp-generated-classpath to locked relative paths; class bytes preserved", "license": "Apache-2.0; bundled dependency notices retained inside JARs", "build_jdk": "Zulu 1.8.0_512-b09", "maven": "3.9.9"}
    prefix = "jdbc/maven/" + BUNDLE_ID + "/"
    entries = {"compatibility.json": json_bytes(descriptor), prefix + "manifest.json": json_bytes(manifest), prefix + "jars/" + normalized.name: normalized.read_bytes(), prefix + "jars/" + zookeeper.name: zookeeper.read_bytes(), "provenance.json": json_bytes(provenance)}
    for component, path in [("phoenix", phoenix), ("zookeeper", zookeeper)]:
        with zipfile.ZipFile(path) as jar:
            notices = [n for n in jar.namelist() if PurePosixPath(n).name.upper() in ("LICENSE", "NOTICE", "LICENSE.TXT", "NOTICE.TXT")]
            if not notices:
                raise ValueError("Missing licensed notices: " + component)
            for name in notices:
                entries["licenses/" + component + "/" + name] = jar.read(name)
    archive = output / ZIP_NAME
    write_zip(archive, entries)
    row = {"id": RUNTIME_ID, "version": VERSION, "url": RELEASE_URL, "size": archive.stat().st_size, "sha256": digest(archive), "coordinate": COORDINATE, "artifacts": [{k: a[k] for k in ("file_name", "size", "sha256")} for a in artifacts]}
    (output / "catalog-candidate.json").write_bytes(json_bytes({"format_version": 1, "runtimes": [row]}))
    (output / "normalization.json").write_bytes(json_bytes(normalization))
    (output / "SHA256SUMS").write_text(row["sha256"] + "  " + ZIP_NAME + "\n")
    return row


def check_catalog(row):
    approved = json.loads(CATALOG.read_text())
    if approved != {"format_version": 1, "runtimes": [row]}:
        raise ValueError("Built artifact differs from approved catalog; review a NEW release version, never overwrite approved bytes")


def build(args):
    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=False)
    java_home = Path(os.environ["JAVA_HOME"])
    version = subprocess.check_output([str(java_home / "bin/java"), "-version"], stderr=subprocess.STDOUT, text=True)
    if "1.8.0_512-b09" not in version or "Zulu" not in version:
        raise ValueError("Build requires pinned Zulu JDK 1.8.0_512-b09")
    acquire(SOURCE_URL, work / "source.tar.gz", SOURCE_SHA256, seed=args.source_archive)
    acquire(MAVEN_URL, work / "maven.tar.gz", MAVEN_SHA512, seed=args.maven_archive, algorithm="sha512")
    extract_source(work / "source.tar.gz", work)
    extract_source(work / "maven.tar.gz", work)
    source = work / "apache-phoenix-5.0.0-HBase-2.0-src"
    original_pom = (source / "pom.xml").read_text()
    patch_source(source)
    patch_text = "".join(difflib.unified_diff(original_pom.splitlines(True), (source / "pom.xml").read_text().splitlines(True), fromfile="a/pom.xml", tofile="b/pom.xml"))
    repository = work / "m2"
    prepare_repository(repository, args.repository_seed)
    settings = work / "settings.xml"
    settings.write_text('<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"><mirrors><mirror><id>central-only</id><mirrorOf>*</mirrorOf><url>https://repo.maven.apache.org/maven2</url></mirror></mirrors></settings>')
    command = [str(work / "apache-maven-3.9.9/bin/mvn"), "-o", "-B", "-ntp", "-s", str(settings), "-Dmaven.repo.local=" + str(repository), "-Daether.dependencyCollector.impl=bf", "-Daether.dependencyCollector.bf.threads=5", "-pl", "phoenix-client", "-am", "-Dmaven.test.skip=true", "-Dcheckstyle.skip", "-Drat.skip=true", "-Dmaven.javadoc.skip=true", "package"]
    env = dict(os.environ, MAVEN_OPTS="-Xmx2048m -XX:MaxMetaspaceSize=512m", TZ="UTC", LANG="en_US.UTF-8")
    with (work / "build.log").open("w") as log:
        subprocess.run(command, cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    verify_repository(repository)
    raw = source / "phoenix-client/target" / PHOENIX_NAME
    row = package(raw, repository / ZK_PATH, work / "dist")
    (work / "dist/build-provenance.json").write_bytes(json_bytes({"java_version": version, "command": command, "raw_jar_sha256": digest(raw), "normalized_jar_sha256": row["artifacts"][0]["sha256"], "source_sha256": SOURCE_SHA256, "repository_lock_sha256": digest(ROOT / "repository-lock.json"), "test_scope": "Phoenix full tests skipped; requires separate runtime and DBX E2E verification"}))
    (work / "dist/shade-3.0.0.patch").write_text(patch_text)
    shutil.copyfile(work / "source.tar.gz", work / "dist/apache-phoenix-5.0.0-HBase-2.0-src.tar.gz")
    for name in ("build.py", "repository-lock.json", "README.md"):
        shutil.copyfile(ROOT / name, work / "dist" / name)
    if not args.candidate:
        check_catalog(row)
    print(json.dumps(row))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("--work", required=True)
    build_parser.add_argument("--repository-seed")
    build_parser.add_argument("--source-archive")
    build_parser.add_argument("--maven-archive")
    build_parser.add_argument("--candidate", action="store_true", help="Produce unapproved review candidate; release workflow must not use this")
    pack_parser = commands.add_parser("package", help="Package existing research input; NOT evidence of a new source build")
    pack_parser.add_argument("--phoenix", type=Path, required=True)
    pack_parser.add_argument("--zookeeper", type=Path, required=True)
    pack_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "build":
        build(args)
    else:
        print(json.dumps(package(args.phoenix, args.zookeeper, args.output)))


if __name__ == "__main__":
    main()
