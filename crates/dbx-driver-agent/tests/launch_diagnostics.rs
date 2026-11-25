use std::sync::Mutex;

use dbx_driver_agent::agent_driver::{AgentLaunchSpec, AgentRuntimeClient};
use dbx_driver_agent::agent_manager::{AgentManager, AgentState, DEFAULT_JRE_KEY};
use serde_json::json;

#[derive(Default)]
struct LaunchLog(Mutex<Vec<String>>);

impl log::Log for LaunchLog {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() == log::Level::Debug && metadata.target().ends_with("::agent_driver")
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            let line = record.args().to_string();
            if line.starts_with("[agent] launching ") {
                self.0.lock().unwrap().push(line);
            }
        }
    }

    fn flush(&self) {}
}

static LAUNCH_LOG: LaunchLog = LaunchLog(Mutex::new(Vec::new()));

#[tokio::test]
async fn launch_diagnostics_hide_configured_arguments_in_log_spawn_and_handshake_errors() {
    log::set_logger(&LAUNCH_LOG).unwrap();
    log::set_max_level(log::LevelFilter::Debug);
    let directory = tempfile::tempdir().unwrap();
    let manager = AgentManager::new_with_base_dir(directory.path().join("agent store"));
    let working_dir = manager.driver_dir("oracle");
    std::fs::create_dir_all(&working_dir).unwrap();
    std::fs::write(
        working_dir.join("agent.py"),
        r#"import json, sys
assert sys.argv[1:] == ['-pfixturepassword', '-jar', 'fixturevalue.jar', '--add-opens=java.base/fixturepackage=ALL-UNNAMED']
print(json.dumps({'ready': True}), flush=True)
request = json.loads(sys.stdin.readline())
print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32000, 'message': 'fixture handshake rejected'}}), flush=True)
"#,
    )
    .unwrap();

    let python = if cfg!(windows) { "python" } else { "python3" };
    for (program, expected_error) in
        [("./no-such-agent", "Failed to spawn agent process"), (python, "fixture handshake rejected")]
    {
        std::fs::write(
            manager.driver_launch_config_path("oracle"),
            json!({
                "command": program,
                "args": ["agent.py", "-pfixturepassword", "-jar", "fixturevalue.jar", "--add-opens=java.base/fixturepackage=ALL-UNNAMED"],
                "working_dir": "{driver_dir}"
            })
            .to_string(),
        )
        .unwrap();
        let launch = manager.resolve_agent_launch_spec(&AgentState::default(), "oracle", DEFAULT_JRE_KEY).unwrap();
        let error = AgentRuntimeClient::spawn(launch, "test").await.err().expect("startup must fail");
        assert!(error.contains(expected_error), "{error}");
        let line = LAUNCH_LOG
            .0
            .lock()
            .unwrap()
            .iter()
            .find(|line| {
                line.contains(&*working_dir.to_string_lossy()) && line.contains(program.trim_start_matches("./"))
            })
            .cloned()
            .expect("spawn must write a debug launch diagnostic");
        for diagnostic in [line, error] {
            assert!(diagnostic.contains(program.trim_start_matches("./")), "{diagnostic}");
            assert!(diagnostic.contains(&*working_dir.to_string_lossy()), "{diagnostic}");
            for secret in ["fixturepassword", "fixturevalue", "fixturepackage"] {
                assert!(!diagnostic.contains(secret), "configured argv leaked: {diagnostic}");
            }
        }
    }
}

#[tokio::test]
async fn launch_diagnostics_keep_the_dbx_jar_and_built_in_options() {
    let directory = tempfile::tempdir().unwrap();
    let jar = directory.path().join("dameng").join("managed agent.jar");
    std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
    let launch = AgentLaunchSpec::java_jar_with_extra_args(
        directory.path().join("missing-java"),
        &jar,
        &["-pfixturepassword".into(), "-jar".into(), "fixturevalue.jar".into()],
    );
    let error = AgentRuntimeClient::spawn(launch, "test").await.err().expect("startup must fail");
    assert!(error.contains("-jar ") && error.contains(&*jar.to_string_lossy()), "{error}");
    assert!(error.contains("--add-opens=java.base/java.net=ALL-UNNAMED"), "{error}");
    for secret in ["fixturepassword", "fixturevalue"] {
        assert!(!error.contains(secret), "configured JVM argument leaked: {error}");
    }
}
