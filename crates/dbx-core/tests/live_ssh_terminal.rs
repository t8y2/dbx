use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use dbx_core::db::ssh_prompt::{self, SshPromptAnswer, SshPromptEnvelope};
use dbx_core::ssh_terminal::{
    SshAuthMethod, SshProfile, SshTerminalEvent, SshTerminalService, SshTerminalSize, BUILTIN_SSH_TERMINAL_DRIVER_ID,
};
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

#[tokio::test]
#[ignore = "requires DBX_TEST_SSH_HOST, DBX_TEST_SSH_USER, and DBX_TEST_SSH_PASSWORD"]
async fn live_ssh_terminal_supports_pty_io_resize_and_exit() {
    let host = std::env::var("DBX_TEST_SSH_HOST").expect("DBX_TEST_SSH_HOST");
    let port = std::env::var("DBX_TEST_SSH_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(22);
    let username = std::env::var("DBX_TEST_SSH_USER").expect("DBX_TEST_SSH_USER");
    let password = std::env::var("DBX_TEST_SSH_PASSWORD").expect("DBX_TEST_SSH_PASSWORD");
    let known_hosts_dir = tempfile::tempdir().unwrap();

    install_accepting_host_key_prompt();
    let service = SshTerminalService::new();
    let profile = SshProfile {
        id: "live-ssh".to_string(),
        name: "Live SSH".to_string(),
        driver_id: BUILTIN_SSH_TERMINAL_DRIVER_ID.to_string(),
        host,
        port,
        username,
        auth_method: SshAuthMethod::Password,
        password,
        key_path: String::new(),
        key_passphrase: String::new(),
        ssh_agent_sock_path: String::new(),
        connect_timeout_secs: 10,
        terminal_type: "xterm-256color".to_string(),
    };
    let command_result = service
        .execute_command(
            &profile,
            known_hosts_dir.path().join("known_hosts"),
            "printf 'DBX_SSH_EXEC_OK\\n'; uname -s; whoami",
            10,
        )
        .await
        .unwrap();
    assert_eq!(command_result.exit_code, Some(0));
    assert!(command_result.stderr.is_empty(), "command stderr was: {:?}", command_result.stderr);
    assert!(command_result.stdout.contains("DBX_SSH_EXEC_OK"));
    assert!(!command_result.truncated);

    let mut started = service
        .start(
            &profile,
            known_hosts_dir.path().join("known_hosts"),
            SshTerminalSize { columns: 80, rows: 24, pixel_width: 800, pixel_height: 480 },
        )
        .await
        .unwrap();

    let session_id = started.id.clone();
    service
        .resize(&session_id, SshTerminalSize { columns: 100, rows: 31, pixel_width: 1_000, pixel_height: 620 })
        .await
        .unwrap();
    service.input(&session_id, "printf '\\nDBX_SSH_TERMINAL_OK\\n'; stty size; exit\n".to_string()).await.unwrap();

    let mut ready = false;
    let mut output = Vec::new();
    let mut exited = false;
    timeout(Duration::from_secs(15), async {
        while let Some(event) = started.events.recv().await {
            match event {
                SshTerminalEvent::Ready => ready = true,
                SshTerminalEvent::Data { data } => output.extend(BASE64_STANDARD.decode(data).unwrap()),
                SshTerminalEvent::Exit { .. } => {
                    exited = true;
                    break;
                }
                SshTerminalEvent::Error { message } => panic!("SSH terminal error: {message}"),
            }
        }
    })
    .await
    .expect("SSH terminal did not exit within 15 seconds");

    service.forget(&session_id).await;
    ssh_prompt::clear_ssh_prompt_gateway();
    assert!(ready);
    assert!(exited);
    let output = String::from_utf8_lossy(&output);
    assert!(output.contains("DBX_SSH_TERMINAL_OK"), "terminal output was: {output:?}");
    assert!(output.contains("31 100"), "resized terminal dimensions were not reported: {output:?}");
    if std::env::var_os("DBX_TEST_SSH_EXPECT_TOFU").is_some() {
        assert!(known_hosts_dir.path().join("known_hosts").is_file());
    }
}

fn install_accepting_host_key_prompt() {
    let (tx, mut rx) = mpsc::channel::<SshPromptEnvelope>(1);
    tokio::spawn(async move {
        if let Some(envelope) = rx.recv().await {
            let _ = envelope.responder.send(SshPromptAnswer::Accept { remember: true });
        }
    });
    ssh_prompt::install_ssh_prompt_gateway(tx);
}
