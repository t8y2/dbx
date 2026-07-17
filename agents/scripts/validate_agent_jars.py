#!/usr/bin/env python3
import sys
import zipfile
from email.parser import Parser
from pathlib import Path


def agent_modules(root: Path) -> list[str]:
    return sorted(
        path.parents[2].name
        for path in list(root.glob("*/build/libs/dbx-agent-*.jar"))
        + list(root.glob("drivers/*/build/libs/dbx-agent-*.jar"))
        if path.is_file()
    )


def module_dir(root: Path, module: str) -> Path:
    nested = root / "drivers" / module
    if nested.exists():
        return nested
    return root / module


def validate_agent_jars(root: Path) -> list[str]:
    problems: list[str] = []
    for module in agent_modules(root):
        jar = module_dir(root, module) / "build/libs" / f"dbx-agent-{module}.jar"
        relative = jar.relative_to(root)
        try:
            with zipfile.ZipFile(jar) as archive:
                manifest = read_manifest(archive)
                main_class = manifest.get("Main-Class")
                if not main_class:
                    problems.append(f"{relative}: missing Main-Class manifest attribute")
                    continue
                class_entry = main_class.replace(".", "/") + ".class"
                if class_entry not in archive.namelist():
                    problems.append(f"{relative}: Main-Class class not found: {class_entry}")
                if not manifest.get("Agent-Label"):
                    problems.append(f"{relative}: missing Agent-Label manifest attribute")
        except zipfile.BadZipFile:
            problems.append(f"{relative}: invalid jar")
    return problems


def read_manifest(archive: zipfile.ZipFile) -> dict[str, str]:
    try:
        raw = archive.read("META-INF/MANIFEST.MF").decode("utf-8")
    except KeyError:
        return {}
    return dict(Parser().parsestr(raw))


def main() -> int:
    root = Path.cwd()
    problems = validate_agent_jars(root)
    if problems:
        print("Agent jar validation failed:")
        for problem in problems:
            print(f"- {problem}")
        return 1

    print("Agent jar validation passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
