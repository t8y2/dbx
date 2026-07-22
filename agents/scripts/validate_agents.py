#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path
from typing import Optional


INFRA_MODULES = {"common", "test-support"}
SOURCE_GLOBS = ("*/src/main/**/*.java", "drivers/*/src/main/**/*.java")
KOTLIN_FILE_SUFFIXES = (".kt", ".kts")
KOTLIN_SCAN_EXCLUDED_PARTS = {".git", ".gradle", "build"}
DEFAULT_AGENT_JRE_KEY = "21"
NON_JDBC_AGENT_MODULES = {"mongodb", "etcd", "zookeeper", "kafka", "rocketmq", "rabbitmq"}
NATIVE_ONLY_AGENT_MODULES = {
    "oracle": "drivers/oracle-go",
    "xugu": "drivers/xugu",
}
JDBC_ARCHITECTURE_ALLOWLIST = {
    "h2-legacy": "reuses the H2 agent implementation with an isolated legacy driver version",
    "access": "custom Access metadata and URL behavior pending migration",
    "dameng": "custom Dameng metadata and DDL pending migration",
    "db2": "custom DB2 metadata pending migration",
    "gbase8s": "custom GBase 8s metadata pending migration",
    "goldendb": "custom GoldenDB metadata pending migration",
    "informix": "custom Informix metadata pending migration",
    "neo4j": "custom Neo4j transaction/query behavior pending migration",
    "sundb": "custom SunDB metadata pending migration",
    "tdengine": "custom TDengine WebSocket JDBC behavior pending migration",
}
APPROVED_JDBC_BASES = {
    "AbstractJdbcAgent",
    "ConfiguredJdbcAgent",
    "PostgresLikeAgent",
}

FORBIDDEN_PATTERNS = [
    (re.compile(r"private\s+val\s+QUERY_PREFIXES"), "forbidden local SQL prefix classifier"),
    (re.compile(r"private\s+const\s+val\s+MAX_ROWS"), "forbidden local result row cap"),
    (re.compile(r"executeUpdate\s*\(\s*trimmedSql\s*\)"), "forbidden executeUpdate(trimmedSql) in query execution"),
    (re.compile(r"truncated\s*=\s*rows\.size\s*>=\s*MAX_ROWS"), "forbidden inclusive truncation check"),
    (re.compile(r"val\s+truncated\s*=\s*rs\.next\s*\(\s*\)"), "forbidden extra ResultSet next() truncation probe"),
]

COPIED_JDBC_INFRASTRUCTURE_PATTERNS = [
    (re.compile(r"\bClass\.forName\s*\("), "copied driver loading"),
    (re.compile(r"\bDriverManager\.getConnection\s*\("), "copied JDBC connection creation"),
    (re.compile(r"public\s+void\s+disconnect\s*\("), "copied JDBC disconnect lifecycle"),
    (re.compile(r"JdbcExecutor\.INSTANCE\.execute\s*\("), "copied JDBC query execution"),
    (re.compile(r"private\s+Object\s+(?:getResultValue|resultValue|stringResultValue)\s*\("), "copied result value reader"),
]


def included_agent_modules(root: Path) -> set[str]:
    settings = (root / "settings.gradle").read_text(encoding="utf-8")
    include_args = "\n".join(
        parenthesized or bare
        for parenthesized, bare in re.findall(
            r"\binclude\b\s*(?:\((.*?)\)|([^\n]+))", settings, flags=re.S
        )
    )
    included = set(re.findall(r"""['"]([^'"]+)['"]""", include_args))
    for variable in ("infrastructureModules", "driverModules"):
        match = re.search(rf"\bdef\s+{variable}\s*=\s*\[(.*?)\]", settings, flags=re.S)
        if match:
            included.update(re.findall(r"""['"]([^'"]+)['"]""", match.group(1)))
    return included - INFRA_MODULES


def agent_modules(root: Path) -> set[str]:
    native = {name for name, path in NATIVE_ONLY_AGENT_MODULES.items() if (root / path).exists()}
    return included_agent_modules(root) | native


def module_dir(root: Path, module: str) -> Path:
    if module in NATIVE_ONLY_AGENT_MODULES:
        return root / NATIVE_ONLY_AGENT_MODULES[module]
    nested = root / "drivers" / module
    if nested.exists():
        return nested
    return root / module


def module_relative_path(root: Path, module: str, *parts: str) -> Path:
    return module_dir(root, module).joinpath(*parts)


def validate_versions(root: Path) -> list[str]:
    included = agent_modules(root)
    versions = set(json.loads((root / "versions.json").read_text(encoding="utf-8")))
    return (
        [f"included module missing version: {name}" for name in sorted(included - versions)]
        + [f"versions key not included: {name}" for name in sorted(versions - included)]
    )


def validate_source_patterns(root: Path) -> list[str]:
    problems: list[str] = []
    sources = sorted(source for glob in SOURCE_GLOBS for source in root.glob(glob))
    for source in sources:
        relative = source.relative_to(root)
        text = source.read_text(encoding="utf-8")
        for line_number, line in enumerate(text.splitlines(), start=1):
            for pattern, message in FORBIDDEN_PATTERNS:
                if pattern.search(line):
                    problems.append(f"{relative}:{line_number}: {message}")
    return problems


def validate_no_kotlin_residue(root: Path) -> list[str]:
    problems: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in KOTLIN_SCAN_EXCLUDED_PARTS for part in relative.parts):
            continue
        if path.suffix in KOTLIN_FILE_SUFFIXES:
            problems.append(f"{relative}: forbidden Kotlin file")
    return problems


def validate_manifest_fields(root: Path, modules: set[str]) -> list[str]:
    problems: list[str] = []
    root_build_text = (root / "build.gradle").read_text(encoding="utf-8") if (root / "build.gradle").exists() else ""
    archive_convention = re.search(
        r"archiveBaseName\s*=\s*['\"]dbx-agent-\$\{project\.name\}['\"]",
        root_build_text,
    )
    for module in sorted(modules):
        if module in NATIVE_ONLY_AGENT_MODULES:
            continue
        build_file = module_relative_path(root, module, "build.gradle")
        relative = build_file.relative_to(root)
        if not build_file.exists():
            problems.append(f"{module}: missing build.gradle")
            continue

        text = build_file.read_text(encoding="utf-8")
        expected_archive = f"archiveBaseName = 'dbx-agent-{module}'"
        archive_pattern = re.compile(
            rf"archiveBaseName\s*=\s*['\"]dbx-agent-{re.escape(module)}['\"]"
        )
        if not archive_convention and not archive_pattern.search(text):
            problems.append(f"{relative}: missing {expected_archive}")
        attrs = manifest_attributes(text)
        if "Agent-Label" not in attrs:
            problems.append(f"{relative}: missing Agent-Label manifest attribute")
        main_class = attrs.get("Main-Class")
        if main_class is None:
            problems.append(f"{relative}: missing Main-Class manifest attribute")
        else:
            main_source = module_relative_path(
                root,
                module,
                "src/main/java",
                str(Path(*main_class.split(".")).with_suffix(".java")),
            )
            if not main_source.exists():
                problems.append(f"{relative}: Main-Class source not found: {main_source.relative_to(root)}")
    return problems


def validate_jdbc_architecture(root: Path, modules: set[str]) -> list[str]:
    problems: list[str] = []
    for module in sorted(modules - NON_JDBC_AGENT_MODULES - set(NATIVE_ONLY_AGENT_MODULES)):
        source = main_class_source(root, module)
        if source is None or not source.exists():
            continue
        text = source.read_text(encoding="utf-8")
        base_match = re.search(r"\bextends\s+([A-Za-z0-9_]+)", text)
        base = base_match.group(1) if base_match else ""
        if module not in JDBC_ARCHITECTURE_ALLOWLIST and base not in APPROVED_JDBC_BASES:
            problems.append(
                f"{source.relative_to(root)}: JDBC agents must extend AbstractJdbcAgent, ConfiguredJdbcAgent, or PostgresLikeAgent"
            )
        if module in JDBC_ARCHITECTURE_ALLOWLIST:
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            for pattern, message in COPIED_JDBC_INFRASTRUCTURE_PATTERNS:
                if pattern.search(line):
                    problems.append(f"{source.relative_to(root)}:{line_number}: {message}; use shared JDBC foundation")
    return problems


def validate_authoring_template(root: Path) -> list[str]:
    template = root / "docs/examples/jdbc-agent-template/src/main/java/com/dbx/agent/template/TemplateAgent.java"
    if not template.exists():
        return []
    text = template.read_text(encoding="utf-8")
    problems: list[str] = []
    if "extends BaseDatabaseAgent" in text:
        problems.append(f"{template.relative_to(root)}: template must use shared JDBC foundation")
    for pattern, message in COPIED_JDBC_INFRASTRUCTURE_PATTERNS:
        if pattern.search(text):
            problems.append(f"{template.relative_to(root)}: template contains {message}")
    return problems


def main_class_source(root: Path, module: str) -> Optional[Path]:
    build_file = module_relative_path(root, module, "build.gradle")
    if not build_file.exists():
        return None
    attrs = manifest_attributes(build_file.read_text(encoding="utf-8"))
    main_class = attrs.get("Main-Class")
    if main_class is None:
        return None
    return module_relative_path(root, module, "src/main/java", str(Path(*main_class.split(".")).with_suffix(".java")))


def validate_release_runtime_keys(root: Path) -> list[str]:
    workflow_candidates = [
        root.parent / ".github/workflows/agents-release.yml",
        root / ".github/workflows/agents-release.yml",
        root / ".github/workflows/release.yml",
    ]
    workflow = next((candidate for candidate in workflow_candidates if candidate.exists()), workflow_candidates[-1])
    if not workflow.exists():
        return []
    text = workflow.read_text(encoding="utf-8")
    problems: list[str] = []
    required_patterns = [
        (
            rf'jre-key:\s*"{DEFAULT_AGENT_JRE_KEY}"',
            f"release workflow must build the default JRE with key {DEFAULT_AGENT_JRE_KEY}",
        ),
        (
            rf'java-version:\s*"{DEFAULT_AGENT_JRE_KEY}"',
            f"release workflow must build the default JRE from Java {DEFAULT_AGENT_JRE_KEY}",
        ),
        (
            rf'\*\)\s*echo\s*"{DEFAULT_AGENT_JRE_KEY}"',
            f"agents must use JRE key {DEFAULT_AGENT_JRE_KEY}",
        ),
        (
            rf'"{DEFAULT_AGENT_JRE_KEY}":\s*\{{\s*"version":\s*"{DEFAULT_AGENT_JRE_KEY}\.',
            f"registry must publish Java {DEFAULT_AGENT_JRE_KEY} under JRE key {DEFAULT_AGENT_JRE_KEY}",
        ),
        (
            r"jdk\.security\.auth",
            "release workflow JRE must include jdk.security.auth for Kafka Kerberos LoginModule support",
        ),
        (
            r"jdk\.security\.jgss",
            "release workflow JRE must include jdk.security.jgss for Kafka GSSAPI SASL support",
        ),
        (
            r"legacy-placeholder\.jar",
            "native-only registry entries must publish a legacy jar placeholder for older DBX clients",
        ),
    ]
    for pattern, message in required_patterns:
        if not re.search(pattern, text, flags=re.S):
            problems.append(message)
    forbidden_patterns = [
        (r'jre-key:\s*"17"', "release workflow must not build Java 21 under JRE key 17"),
        (r'\*\)\s*echo\s*"17"', "agents must not use JRE key 17"),
        (r'"17":\s*\{\s*"version":\s*"21\.', "registry must not publish Java 21 under JRE key 17"),
    ]
    for pattern, message in forbidden_patterns:
        if re.search(pattern, text, flags=re.S):
            problems.append(message)
    return problems


def manifest_attributes(build_text: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for key, value in re.findall(
        r"['\"]([^'\"]+)['\"]\s*:\s*['\"]([^'\"]+)['\"]",
        build_text,
    ):
        attrs[key] = value
    return attrs


def validate(root: Path) -> list[str]:
    modules = agent_modules(root)
    return (
        validate_versions(root)
        + validate_source_patterns(root)
        + validate_manifest_fields(root, modules)
        + validate_jdbc_architecture(root, modules)
        + validate_authoring_template(root)
        + validate_release_runtime_keys(root)
        + validate_no_kotlin_residue(root)
    )


def main() -> int:
    root = Path.cwd()
    problems = validate(root)
    if problems:
        print("Agent validation failed:")
        for problem in problems:
            print(f"- {problem}")
        return 1

    print("Agent validation passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
