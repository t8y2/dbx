#!/usr/bin/env python3
"""Acquire Gradle dependencies with bounded recovery, then execute the original command once offline."""

import argparse
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
INIT = Path(__file__).with_name("ci-gradle.init.gradle")
starting_process = False
pending_cancel = None


class Cancelled(BaseException):
    def __init__(self, signum):
        self.signum = signum


def cancel(signum, _frame):
    global pending_cancel
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if starting_process:
        pending_cancel = signum
    else:
        raise Cancelled(signum)


def dispose(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return process.communicate()[0] or ""


def run_process(command, cwd, env, budget, capture=True):
    global starting_process, pending_cancel
    process = None
    timed_out = False
    try:
        starting_process = True
        process = subprocess.Popen(command, cwd=cwd, env=env,
                                   stdout=subprocess.PIPE if capture else None,
                                   stderr=subprocess.STDOUT if capture else None,
                                   text=True, start_new_session=True)
        starting_process = False
        if pending_cancel is not None:
            signum, pending_cancel = pending_cancel, None
            raise Cancelled(signum)
        try:
            output = process.communicate(timeout=budget)[0] or ""
        except subprocess.TimeoutExpired:
            timed_out = True
            output = dispose(process)
    except BaseException:
        if process is not None:
            dispose(process)
        raise
    finally:
        starting_process = False
    if capture:
        def redact(match):
            url = urlsplit(match[0])
            return f"{url.scheme}://{url.hostname}{url.path}"
        print(re.sub(r"https?://[^\s'\"<>]+", redact, output), end="", flush=True)
    return process.returncode, output, timed_out


def public_maven_url(value):
    url = urlsplit(value)
    return (url.scheme == "https" and not url.username and not url.password and
            not url.query and not url.fragment and url.port in (None, 443) and
            ((url.hostname == "repo.maven.apache.org" and url.path.startswith("/maven2/")) or
             (url.hostname == "plugins.gradle.org" and url.path.startswith("/m2/")) or
             (url.hostname == "maven-central.storage-download.googleapis.com" and url.path.startswith("/maven2/"))))


def acquisition_failure(output, timed_out=False):
    if re.search(r"certificate|PKIX|SSLHandshake|checksum|signature|verification failed|"
                 r"No space left|Permission denied|Could not compile|Compilation failed|"
                 r"Could not find |Could not resolve.*conflict|401\b|404\b", output, re.I):
        return None
    section = output.split("* What went wrong:", 1)[-1].split("* Try:", 1)[0]
    requests = re.findall(r"Could not (?:GET|HEAD) '([^']+)'", section)
    if timed_out and "* What went wrong:" not in output and not requests:
        return "transient"
    if not requests or not all(public_maven_url(url) for url in requests):
        return None
    network = re.compile(r"timed out|Connection (?:reset|refused)|UnknownHostException|"
                         r"Temporary failure|Name or service not known|Remote host terminated|"
                         r"Received status code (?:403|429|500|502|503|504)\b", re.I)
    context = re.compile(r"^(?:A problem occurred configuring |Could not resolve |"
                         r"Could not get resource |Could not (?:GET|HEAD) '|"
                         r"There (?:is|are) \d+ more failure)")
    details = re.findall(r"^\s*>\s*(.+)$", section, re.M)
    if not details or any(not context.search(line) and not network.search(line) for line in details):
        return None
    if any(re.search(r"Received status code (?!403\b|429\b|500\b|502\b|503\b|504\b)\d+", line)
           for line in details):
        return None
    if re.search(r"Received status code 403\b", section):
        return "forbidden"
    return "transient" if timed_out or network.search(section) else None


def wrapper_failure(output, timed_out):
    if re.search(r"certificate|PKIX|checksum|signature|Permission denied|No space left|"
                 r"HTTP response code: (?:401|403|404)", output, re.I):
        return False
    return timed_out or bool(re.search(r"timed out|UnknownHostException|Connection (?:reset|refused)|"
                                      r"HTTP response code: (?:429|500|502|503|504)", output, re.I))


def acquire_and_run(project, scope, command, runner=run_process, sleep=time.sleep):
    env = {**os.environ, "LC_ALL": "C", "DBX_CI_GRADLE_ROOT": str(project.resolve()),
           "DBX_CI_GRADLE_SCOPE": scope, "DBX_CI_GRADLE_SOURCE": "primary",
           "DBX_CI_GRADLE_PHASE": "acquire"}
    env["GRADLE_OPTS"] = env.get("GRADLE_OPTS", "") + " -Dorg.gradle.daemon=false -Duser.language=en -Duser.country=US"
    home = Path(env.get("GRADLE_USER_HOME", str(Path.home() / ".gradle"))).expanduser().resolve()
    env["GRADLE_USER_HOME"] = str(home)
    init_directory = home / "init.d"
    init_directory.mkdir(parents=True, exist_ok=True)
    wrapper = [str(project / "gradlew"), "--no-daemon", "--console=plain"]
    init_path = None
    try:
        with tempfile.NamedTemporaryFile(prefix="dbx-ci-acquire-", suffix=".gradle", dir=init_directory,
                                         delete=False) as temporary:
            init_path = Path(temporary.name)
            temporary.write(INIT.read_bytes())
        for attempt in range(3):
            print(f"Gradle phase=wrapper attempt={attempt + 1} budget=180s", flush=True)
            code, output, timed_out = runner([*wrapper, "--version"], project, env, 180)
            if code == 0 and not timed_out:
                break
            if attempt == 2 or not wrapper_failure(output, timed_out):
                return code or 1
            sleep(2 ** (attempt + 1))
        acquisition_count = 0
        for source in ["primary", "backup"]:
            env["DBX_CI_GRADLE_SOURCE"] = source
            attempts = 2 if source == "primary" else 3 - acquisition_count
            for attempt in range(attempts):
                acquisition_count += 1
                print(f"Gradle phase=acquire source={source} attempt={attempt + 1} budget=600s", flush=True)
                code, output, timed_out = runner([*wrapper, "dbxCiAcquireDependencies"], project, env, 600)
                if code == 0 and not timed_out:
                    env["DBX_CI_GRADLE_PHASE"] = "execute"
                    print(f"Gradle phase=execute source={source} offline=true attempts=1", flush=True)
                    code, _output, _timed_out = runner(command, project, env, None, capture=False)
                    return code
                reason = acquisition_failure(output, timed_out)
                if reason is None:
                    return code or 1
                if source == "primary" and (reason == "forbidden" or attempt + 1 == attempts):
                    break
                if attempt + 1 == attempts:
                    return code or 1
                sleep(2)
            if source == "primary":
                print("Gradle switching once to Google-hosted Maven Central mirror", flush=True)
        return 1
    finally:
        if init_path is not None:
            init_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", choices=["agents", "jdbc"])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("an original command is required after --")
    project = ROOT / ("agents" if args.project == "agents" else "plugins/jdbc")
    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    try:
        return acquire_and_run(project, args.project, command)
    except Cancelled as error:
        print("Gradle cancelled; no acquisition retry", file=sys.stderr)
        return 128 + error.signum


if __name__ == "__main__":
    sys.exit(main())
