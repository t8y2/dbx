from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[2]
INIT = Path(__file__).with_name("ci-gradle.init.gradle")
REJECTION = "CI mirror switching does not support authenticated Central repositories"


class RepositoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        properties = (ROOT / "agents/gradle/wrapper/gradle-wrapper.properties").read_text(encoding="utf-8")
        distribution = next(line for line in properties.splitlines() if line.startswith("distributionUrl="))
        distribution = distribution.rsplit("/", 1)[1].removesuffix(".zip")
        home = Path(os.environ.get("GRADLE_USER_HOME", str(Path.home() / ".gradle"))).expanduser()
        executable = "gradle.bat" if os.name == "nt" else "gradle"
        cls.gradle = next(home.glob(f"wrapper/dists/{distribution}/*/{distribution.rsplit('-', 1)[0]}/bin/{executable}"), None)
        if cls.gradle is None:
            raise RuntimeError("Run agents/gradlew --version first to prepare the pinned Gradle distribution")

    def test_repository_authentication(self):
        cases = [
            ("public-primary", "primary", "mavenCentral()", False, False),
            ("public-backup", "backup", "mavenCentral()", False, False),
            ("password-primary", "primary", "mavenCentral { credentials { username = 'fixture'; password = 'fixture' } }", True, False),
            ("password-backup", "backup", "mavenCentral { credentials { username = 'fixture'; password = 'fixture' } }", True, True),
            ("empty-backup", "backup", "mavenCentral { credentials {} }", True, True),
            ("lazy-missing-backup", "backup", "mavenCentral { credentials(PasswordCredentials) }", True, True),
            ("lazy-present-backup", "backup", "mavenCentral { credentials(PasswordCredentials) }", True, True),
            ("scheme-backup", "backup", "mavenCentral { authentication { basic(BasicAuthentication) } }", False, True),
            ("header-backup", "backup", "mavenCentral { credentials(HttpHeaderCredentials) }", True, True),
            ("private-backup", "backup", "maven { name = 'privateFixture'; url = uri('https://private.invalid/maven/'); credentials(PasswordCredentials) }", True, False),
        ]
        with tempfile.TemporaryDirectory(prefix="dbx-gradle-repositories-") as directory:
            root = Path(directory)
            for name, source, repositories, credentials, rejected in cases:
                with self.subTest(name=name):
                    project = root / name
                    project.mkdir()
                    (project / "settings.gradle").write_text("rootProject.name = 'fixture'\n", encoding="utf-8")
                    if name == "lazy-present-backup":
                        (project / "gradle.properties").write_text(
                            "MavenRepoUsername=fixture\nMavenRepoPassword=fixture\n", encoding="utf-8")
                    private = name.startswith("private")
                    expected_url = ("https://private.invalid/maven/" if private else
                                    "https://maven-central.storage-download.googleapis.com/maven2/" if source == "backup" else
                                    "https://repo.maven.apache.org/maven2/")
                    (project / "build.gradle").write_text(f"""
import org.gradle.api.credentials.PasswordCredentials
import org.gradle.api.credentials.HttpHeaderCredentials
import org.gradle.authentication.http.BasicAuthentication
repositories {{ {repositories} }}
tasks.register('inspectRepository') {{
    doLast {{
        def repository = repositories.first()
        assert repository.url.toString() == '{expected_url}'
        assert repository.usesCredentials() == {str(credentials).lower()}
        assert repository.authentication.empty
        println 'REPOSITORY_STATE_OK'
    }}
}}
""", encoding="utf-8")
                    env = {**os.environ, "DBX_CI_GRADLE_ROOT": str(project.resolve()),
                           "DBX_CI_GRADLE_SOURCE": source, "DBX_CI_GRADLE_PHASE": "acquire"}
                    result = subprocess.run(
                        [str(self.gradle), "--no-daemon", "--console=plain", "--offline",
                         "--gradle-user-home", str(root / "home"), "--project-dir", str(project),
                         "--init-script", str(INIT), "inspectRepository"],
                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
                    output = result.stdout + result.stderr
                    if rejected:
                        self.assertNotEqual(result.returncode, 0, output)
                        self.assertIn(REJECTION, output)
                        self.assertNotIn("REPOSITORY_STATE_OK", output)
                    else:
                        self.assertEqual(result.returncode, 0, output)
                        self.assertIn("REPOSITORY_STATE_OK", output)

    def test_backup_resolves_anonymously(self):
        authorization = []

        class Handler(SimpleHTTPRequestHandler):
            def do_GET(self):
                authorization.append(self.headers.get("Authorization"))
                super().do_GET()

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory(prefix="dbx-gradle-anonymous-") as directory:
            root = Path(directory)
            artifact = root / "maven" / "fixture" / "example" / "1"
            artifact.mkdir(parents=True)
            (artifact / "example-1.pom").write_text(
                "<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId>"
                "<artifactId>example</artifactId><version>1</version></project>", encoding="utf-8")
            (artifact / "example-1.jar").write_bytes(b"fixture")
            server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(root / "maven")))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                (root / "settings.gradle").write_text("rootProject.name = 'fixture'\n", encoding="utf-8")
                (root / "build.gradle").write_text("""
repositories { mavenCentral() }
configurations { fixture }
dependencies { fixture 'fixture:example:1' }
""", encoding="utf-8")
                boundary = root / "transport.gradle"
                boundary.write_text(f"""
afterProject {{ project ->
    def repository = project.repositories.first()
    assert repository.url.toString() == 'https://maven-central.storage-download.googleapis.com/maven2/'
    repository.url = uri('http://127.0.0.1:{server.server_port}/')
    repository.allowInsecureProtocol = true
}}
""", encoding="utf-8")
                env = {**os.environ, "DBX_CI_GRADLE_ROOT": str(root.resolve()),
                       "DBX_CI_GRADLE_SOURCE": "backup", "DBX_CI_GRADLE_PHASE": "acquire"}
                result = subprocess.run(
                    [str(self.gradle), "--no-daemon", "--console=plain", "--gradle-user-home", str(root / "home"),
                     "--project-dir", str(root), "--init-script", str(INIT), "--init-script", str(boundary),
                     "dbxCiAcquireDependencies"],
                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("1 external artifacts", result.stdout)
                self.assertTrue(authorization)
                self.assertTrue(all(value is None for value in authorization))
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
