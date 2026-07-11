import json
import tempfile
import textwrap
import unittest
import zipfile
from pathlib import Path

import validate_agents
import validate_agent_jars


class ValidateAgentsTest(unittest.TestCase):
    def test_versions_must_match_included_agent_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "settings.gradle").write_text(
                "include 'common', 'test-support', 'h2', 'oracle'\n",
                encoding="utf-8",
            )
            (root / "versions.json").write_text(
                json.dumps({"h2": "0.1.0", "mongodb": "0.1.0"}),
                encoding="utf-8",
            )

            problems = validate_agents.validate_versions(root)

            self.assertEqual(
                [
                    "included module missing version: oracle",
                    "versions key not included: mongodb",
                ],
                problems,
            )

    def test_versions_support_driver_modules_variable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "settings.gradle").write_text(
                "def infrastructureModules = ['common', 'test-support']\n"
                "def driverModules = ['h2', 'oracle']\n"
                "include(*(infrastructureModules + driverModules))\n",
                encoding="utf-8",
            )
            (root / "versions.json").write_text(
                json.dumps({"h2": "0.1.0", "oracle": "0.1.0"}),
                encoding="utf-8",
            )

            self.assertEqual([], validate_agents.validate_versions(root))

    def test_source_scan_rejects_old_execute_query_patterns(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "h2/src/main/java/com/dbx/agent/h2/H2Agent.java"
            source.parent.mkdir(parents=True)
            source.write_text(
                textwrap.dedent(
                    """
                    private val QUERY_PREFIXES = listOf("SELECT")
                    fun executeQuery(sql: String) {
                        val trimmedSql = sql.trim()
                        stmt.executeUpdate(trimmedSql)
                    }
                    """
                ),
                encoding="utf-8",
            )

            problems = validate_agents.validate_source_patterns(root)

            self.assertEqual(
                [
                    "h2/src/main/java/com/dbx/agent/h2/H2Agent.java:2: forbidden local SQL prefix classifier",
                    "h2/src/main/java/com/dbx/agent/h2/H2Agent.java:5: forbidden executeUpdate(trimmedSql) in query execution",
                ],
                problems,
            )

    def test_jdbc_architecture_requires_shared_base_for_new_agents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = root / "example"
            source = module / "src/main/java/com/dbx/agent/example/ExampleAgent.java"
            source.parent.mkdir(parents=True)
            (module / "build.gradle").write_text(
                textwrap.dedent(
                    """
                    tasks.named('shadowJar') {
                        manifest {
                            attributes(
                                'Agent-Label': 'Example',
                                'Main-Class': 'com.dbx.agent.example.ExampleAgent'
                            )
                        }
                    }
                    """
                ),
                encoding="utf-8",
            )
            source.write_text(
                textwrap.dedent(
                    """
                    package com.dbx.agent.example;

                    import com.dbx.agent.BaseDatabaseAgent;
                    import java.sql.DriverManager;

                    public final class ExampleAgent extends BaseDatabaseAgent {
                        public void connect() throws Exception {
                            Class.forName("example.Driver");
                            DriverManager.getConnection("jdbc:example");
                        }
                    }
                    """
                ),
                encoding="utf-8",
            )

            problems = validate_agents.validate_jdbc_architecture(root, {"example"})

            self.assertEqual(
                [
                    "example/src/main/java/com/dbx/agent/example/ExampleAgent.java: JDBC agents must extend AbstractJdbcAgent, ConfiguredJdbcAgent, or PostgresLikeAgent",
                    "example/src/main/java/com/dbx/agent/example/ExampleAgent.java:9: copied driver loading; use shared JDBC foundation",
                    "example/src/main/java/com/dbx/agent/example/ExampleAgent.java:10: copied JDBC connection creation; use shared JDBC foundation",
                ],
                problems,
            )

    def test_versions_include_native_only_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "settings.gradle").write_text(
                "def infrastructureModules = ['common', 'test-support']\n"
                "def driverModules = ['h2']\n"
                "include(*(infrastructureModules + driverModules))\n",
                encoding="utf-8",
            )
            (root / "drivers/oracle-go").mkdir(parents=True)
            (root / "versions.json").write_text(
                json.dumps({"h2": "0.1.0", "oracle": "0.1.0"}),
                encoding="utf-8",
            )

            self.assertEqual([], validate_agents.validate_versions(root))

    def test_authoring_template_must_use_shared_foundation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            template = root / "docs/examples/jdbc-agent-template/src/main/java/com/dbx/agent/template/TemplateAgent.java"
            template.parent.mkdir(parents=True)
            template.write_text(
                textwrap.dedent(
                    """
                    package com.dbx.agent.template;
                    import com.dbx.agent.BaseDatabaseAgent;
                    import java.sql.DriverManager;
                    public final class TemplateAgent extends BaseDatabaseAgent {
                        void connect() throws Exception {
                            DriverManager.getConnection("jdbc:template");
                        }
                    }
                    """
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                [
                    "docs/examples/jdbc-agent-template/src/main/java/com/dbx/agent/template/TemplateAgent.java: template must use shared JDBC foundation",
                    "docs/examples/jdbc-agent-template/src/main/java/com/dbx/agent/template/TemplateAgent.java: template contains copied JDBC connection creation",
                ],
                validate_agents.validate_authoring_template(root),
            )

    def test_manifest_validation_requires_registry_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = root / "h2"
            module.mkdir()
            (root / "build.gradle").write_text(
                textwrap.dedent(
                    """
                    configure(agentProjects) {
                        tasks.named('shadowJar') {
                            archiveBaseName = "dbx-agent-${project.name}"
                        }
                    }
                    """
                ),
                encoding="utf-8",
            )
            (module / "build.gradle").write_text(
                textwrap.dedent(
                    """
                    tasks.named('shadowJar') {
                        manifest {
                            attributes(
                                'Agent-Label': 'H2'
                            )
                        }
                    }
                    """
                ),
                encoding="utf-8",
            )

            problems = validate_agents.validate_manifest_fields(root, {"h2"})

            self.assertEqual(
                ["h2/build.gradle: missing Main-Class manifest attribute"],
                problems,
            )

    def test_manifest_validation_requires_main_class_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = root / "h2"
            module.mkdir()
            (root / "build.gradle").write_text(
                'archiveBaseName = "dbx-agent-${project.name}"\n',
                encoding="utf-8",
            )
            (module / "build.gradle").write_text(
                textwrap.dedent(
                    """
                    tasks.named('shadowJar') {
                        manifest {
                            attributes(
                                'Agent-Label': 'H2',
                                'Main-Class': 'com.dbx.agent.h2.H2Agent'
                            )
                        }
                    }
                    """
                ),
                encoding="utf-8",
            )

            problems = validate_agents.validate_manifest_fields(root, {"h2"})

            self.assertEqual(
                ["h2/build.gradle: Main-Class source not found: h2/src/main/java/com/dbx/agent/h2/H2Agent.java"],
                problems,
            )

            source = module / "src/main/java/com/dbx/agent/h2/H2Agent.java"
            source.parent.mkdir(parents=True)
            source.write_text("package com.dbx.agent.h2; public final class H2Agent {}", encoding="utf-8")

            self.assertEqual([], validate_agents.validate_manifest_fields(root, {"h2"}))

    def test_manifest_validation_supports_drivers_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = root / "drivers/h2"
            source = module / "src/main/java/com/dbx/agent/h2/H2Agent.java"
            source.parent.mkdir(parents=True)
            source.write_text("package com.dbx.agent.h2; public final class H2Agent {}", encoding="utf-8")
            (root / "build.gradle").write_text(
                'archiveBaseName = "dbx-agent-${project.name}"\n',
                encoding="utf-8",
            )
            (module / "build.gradle").write_text(
                textwrap.dedent(
                    """
                    tasks.named('shadowJar') {
                        manifest {
                            attributes(
                                'Agent-Label': 'H2',
                                'Main-Class': 'com.dbx.agent.h2.H2Agent'
                            )
                        }
                    }
                    """
                ),
                encoding="utf-8",
            )

            self.assertEqual([], validate_agents.validate_manifest_fields(root, {"h2"}))

    def test_kotlin_residue_scan_rejects_kt_and_kts_files_outside_build_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            forbidden_source = root / "h2/src/main/kotlin/com/dbx/agent/h2/H2Agent.kt"
            forbidden_build = root / "settings.gradle.kts"
            ignored_build_output = root / "h2/build/tmp/Generated.kt"
            ignored_gradle_cache = root / ".gradle/caches/init.gradle.kts"
            for path in (
                forbidden_source,
                forbidden_build,
                ignored_build_output,
                ignored_gradle_cache,
            ):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("", encoding="utf-8")

            problems = validate_agents.validate_no_kotlin_residue(root)

            self.assertEqual(
                [
                    "h2/src/main/kotlin/com/dbx/agent/h2/H2Agent.kt: forbidden Kotlin file",
                    "settings.gradle.kts: forbidden Kotlin file",
                ],
                problems,
            )

    def test_release_runtime_keys_match_java_21_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = root / ".github/workflows/release.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text(
                textwrap.dedent(
                    '''
                    strategy:
                      matrix:
                        include:
                          - jre-key: "21"
                            java-version: "21"
                            modules: "java.base,jdk.security.auth,jdk.security.jgss"
                    detect_jre_key() {
                      case "$name" in
                        *) echo "21" ;;
                      esac
                    }
                    cat > release/agent-registry.json <<EOF
                    {
                      "jres": {
                        "21": {
                          "version": "21.0.11"
                        }
                      }
                    }
                    EOF
                    legacy_jar_url="https://github.com/${REPO}/releases/download/${TAG}/dbx-agent-${name}-legacy-placeholder.jar"
                    '''
                ),
                encoding="utf-8",
            )

            self.assertEqual([], validate_agents.validate_release_runtime_keys(root))

            workflow.write_text(
                textwrap.dedent(
                    '''
                    strategy:
                      matrix:
                        include:
                          - jre-key: "17"
                            java-version: "21"
                    detect_jre_key() {
                      case "$name" in
                        *) echo "17" ;;
                      esac
                    }
                    cat > release/agent-registry.json <<EOF
                    {
                      "jres": {
                        "17": {
                          "version": "21.0.11"
                        }
                      }
                    }
                    EOF
                    '''
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                [
                    "release workflow must build the default JRE with key 21",
                    "agents must use JRE key 21",
                    "registry must publish Java 21 under JRE key 21",
                    "release workflow JRE must include jdk.security.auth for Kafka Kerberos LoginModule support",
                    "release workflow JRE must include jdk.security.jgss for Kafka GSSAPI SASL support",
                    "native-only registry entries must publish a legacy jar placeholder for older DBX clients",
                    "release workflow must not build Java 21 under JRE key 17",
                    "agents must not use JRE key 17",
                    "registry must not publish Java 21 under JRE key 17",
                ],
                validate_agents.validate_release_runtime_keys(root),
            )

    def test_agent_jar_validation_requires_main_class_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            jar = root / "h2/build/libs/dbx-agent-h2.jar"
            jar.parent.mkdir(parents=True)
            with zipfile.ZipFile(jar, "w") as archive:
                archive.writestr(
                    "META-INF/MANIFEST.MF",
                    "Manifest-Version: 1.0\n"
                    "Agent-Label: H2\n"
                    "Main-Class: com.dbx.agent.h2.H2Agent\n\n",
                )

            self.assertEqual(
                ["h2/build/libs/dbx-agent-h2.jar: Main-Class class not found: com/dbx/agent/h2/H2Agent.class"],
                validate_agent_jars.validate_agent_jars(root),
            )

            with zipfile.ZipFile(jar, "a") as archive:
                archive.writestr("com/dbx/agent/h2/H2Agent.class", b"class-bytes")

            self.assertEqual([], validate_agent_jars.validate_agent_jars(root))

    def test_agent_jar_validation_supports_drivers_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            jar = root / "drivers/h2/build/libs/dbx-agent-h2.jar"
            jar.parent.mkdir(parents=True)
            with zipfile.ZipFile(jar, "w") as archive:
                archive.writestr(
                    "META-INF/MANIFEST.MF",
                    "Manifest-Version: 1.0\n"
                    "Agent-Label: H2\n"
                    "Main-Class: com.dbx.agent.h2.H2Agent\n\n",
                )
                archive.writestr("com/dbx/agent/h2/H2Agent.class", b"class-bytes")

            self.assertEqual([], validate_agent_jars.validate_agent_jars(root))


if __name__ == "__main__":
    unittest.main()
