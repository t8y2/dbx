//! Live coverage for issue #12855: the CREATE statement a MySQL routine source tab shows cannot be
//! re-run (`ERROR 1304 ... already exists`) because MySQL has no `CREATE OR REPLACE` for stored routines.
//!
//! Saving replaces the routine with the `object_source_sql` sequence (validate under a temporary name,
//! then `DROP ... IF EXISTS`, then `CREATE`). The desktop "Run" path executes every statement of that
//! sequence except the trailing `CREATE` first, then runs the tab's own `CREATE` through the normal
//! query pipeline so results and error positions stay untouched. These tests drive both flows through
//! the backend executor against a real server.

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::object_source_sql::{
    build_editable_object_source, build_executable_object_source_statements, EditableObjectSourceSqlInput,
};
use dbx_core::query::execute_sql_statement;
use dbx_core::types::ObjectSourceKind;
use serde_json::json;

fn live_mysql_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_MYSQL_ROUTINE_HOST").expect("DBX_LIVE_MYSQL_ROUTINE_HOST");
    let port =
        std::env::var("DBX_LIVE_MYSQL_ROUTINE_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3306);
    let username = std::env::var("DBX_LIVE_MYSQL_ROUTINE_USER").unwrap_or_else(|_| "root".to_string());
    let password = std::env::var("DBX_LIVE_MYSQL_ROUTINE_PASSWORD").expect("DBX_LIVE_MYSQL_ROUTINE_PASSWORD");

    serde_json::from_value(json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MySQL routine config should deserialize")
}

struct LiveRoutineEnv {
    state: AppState,
    connection_id: String,
    database: String,
    definer: String,
    db_path: std::path::PathBuf,
}

impl LiveRoutineEnv {
    async fn create() -> Self {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let config = live_mysql_config(&format!("live-mysql-routine-source-{suffix}"));
        let db_path = std::env::temp_dir().join(format!("dbx-live-routine-source-{suffix}.db"));
        let storage = dbx_core::persistence::test_storage::open(&db_path).await.expect("open temp storage");
        let state = AppState::new(storage);
        let connection_id = config.id.clone();
        state.configs.write().await.insert(connection_id.clone(), config);

        let env = Self {
            state,
            connection_id,
            database: format!("dbx_routine_source_{suffix}"),
            definer: format!("dbx_definer_{}", &suffix[..8]),
            db_path,
        };
        env.exec_on("", &format!("CREATE DATABASE `{}`", env.database)).await.expect("create isolated database");
        env.exec_on("", &format!("CREATE USER '{}'@'%'", env.definer)).await.expect("create definer account");
        // Routines run with the definer's privileges (SQL SECURITY DEFINER), so the account needs access to call them.
        env.exec_on("", &format!("GRANT ALL PRIVILEGES ON `{}`.* TO '{}'@'%'", env.database, env.definer))
            .await
            .expect("grant definer account access");
        env
    }

    async fn exec_on(&self, database: &str, sql: &str) -> Result<dbx_core::db::QueryResult, String> {
        execute_sql_statement(&self.state, &self.connection_id, database, sql, None, None).await
    }

    async fn exec(&self, sql: &str) -> Result<dbx_core::db::QueryResult, String> {
        self.exec_on(&self.database, sql).await
    }

    /// The text DBX loads into the source tab: `SHOW CREATE ...` run through the editable-source builder.
    async fn source_tab_text(&self, kind: ObjectSourceKind, name: &str) -> String {
        let keyword = if kind == ObjectSourceKind::Function { "FUNCTION" } else { "PROCEDURE" };
        let result = self.exec(&format!("SHOW CREATE {keyword} `{name}`")).await.expect("SHOW CREATE routine");
        let ddl = result.rows[0][2].as_str().expect("routine DDL column").to_string();
        build_editable_object_source(self.input(kind, name, &ddl))
    }

    fn input(&self, kind: ObjectSourceKind, name: &str, source: &str) -> EditableObjectSourceSqlInput {
        EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: kind,
            schema: Some(self.database.clone()),
            name: name.to_string(),
            source: source.to_string(),
        }
    }

    /// Everything the desktop Run path executes before the tab's own CREATE.
    fn run_preparation(&self, kind: ObjectSourceKind, name: &str, source: &str) -> Vec<String> {
        let mut statements =
            build_executable_object_source_statements(self.input(kind, name, source)).expect("executable statements");
        let create = statements.pop().expect("replace sequence ends with the routine CREATE");
        assert!(create.trim_start().to_ascii_uppercase().starts_with("CREATE"), "unexpected tail: {create}");
        statements
    }

    async fn run_all(&self, statements: &[String]) -> Result<(), String> {
        for statement in statements {
            self.exec(statement).await?;
        }
        Ok(())
    }

    async fn cleanup(self) {
        let database = self.exec_on("", &format!("DROP DATABASE IF EXISTS `{}`", self.database)).await;
        let user = self.exec_on("", &format!("DROP USER IF EXISTS '{}'@'%'", self.definer)).await;
        let _ = std::fs::remove_file(&self.db_path);
        database.expect("drop isolated database");
        user.expect("drop definer account");
    }
}

#[tokio::test]
#[ignore = "requires a writable MySQL 8 endpoint (DBX_LIVE_MYSQL_ROUTINE_HOST/PORT/USER/PASSWORD)"]
async fn live_mysql_procedure_source_run_replaces_existing_routine_and_keeps_definer() {
    let env = LiveRoutineEnv::create().await;
    let name = "p_issue_12855";
    let outcome = async {
        let definer = &env.definer;
        env.exec(&format!(
            "CREATE DEFINER=`{definer}`@`%` PROCEDURE `{name}`(IN a INT)\nBEGIN\n  SELECT a + 1 AS v;\nEND"
        ))
        .await?;

        let tab_text = env.source_tab_text(ObjectSourceKind::Procedure, name).await;
        assert!(tab_text.contains(&format!("DEFINER=`{definer}`@`%`")), "{tab_text}");
        let edited = tab_text.replace("SELECT a + 1 AS v", "SELECT a + 100 AS v");

        // The bug: running the edited CREATE as-is hits the existing routine.
        let direct = env.exec(&edited).await.expect_err("re-running CREATE on an existing routine must fail");
        assert!(direct.contains("already exists"), "{direct}");

        // Preparation + the tab's own CREATE replaces the routine and keeps its DEFINER.
        let preparation = env.run_preparation(ObjectSourceKind::Procedure, name, &edited);
        env.run_all(&preparation).await?;
        env.exec(&edited).await?;
        let called = env.exec(&format!("CALL `{name}`(1)")).await?;
        assert_eq!(called.rows, vec![vec![json!("101")]]);
        let replaced = env.source_tab_text(ObjectSourceKind::Procedure, name).await;
        assert!(replaced.contains(&format!("DEFINER=`{definer}`@`%`")), "{replaced}");

        // A second edit goes through the very same sequence (idempotent), and no validation routine lingers.
        let edited_again = replaced.replace("a + 100", "a + 200");
        env.run_all(&env.run_preparation(ObjectSourceKind::Procedure, name, &edited_again)).await?;
        env.exec(&edited_again).await?;
        assert_eq!(env.exec(&format!("CALL `{name}`(1)")).await?.rows, vec![vec![json!("201")]]);

        // Save runs the complete sequence, ending with the CREATE, and lands on the same routine.
        let saved = edited_again.replace("a + 200", "a + 300");
        let save_statements =
            build_executable_object_source_statements(env.input(ObjectSourceKind::Procedure, name, &saved))
                .map_err(|error| error.to_string())?;
        env.run_all(&save_statements).await?;
        assert_eq!(env.exec(&format!("CALL `{name}`(1)")).await?.rows, vec![vec![json!("301")]]);
        let leftovers = env
            .exec(&format!(
                "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '{}'",
                env.database
            ))
            .await?;
        assert_eq!(leftovers.rows, vec![vec![json!(name)]]);
        Ok::<_, String>(())
    }
    .await;
    env.cleanup().await;
    outcome.expect("procedure Run replacement should succeed on a live MySQL server");
}

#[tokio::test]
#[ignore = "requires a writable MySQL 8 endpoint (DBX_LIVE_MYSQL_ROUTINE_HOST/PORT/USER/PASSWORD)"]
async fn live_mysql_function_source_run_replaces_existing_routine_and_keeps_definer() {
    let env = LiveRoutineEnv::create().await;
    let name = "f_issue_12855";
    let outcome = async {
        let definer = &env.definer;
        env.exec(&format!(
            "CREATE DEFINER=`{definer}`@`%` FUNCTION `{name}`(a INT) RETURNS int\n    DETERMINISTIC\nBEGIN\n  RETURN a + 1;\nEND"
        ))
        .await?;

        let tab_text = env.source_tab_text(ObjectSourceKind::Function, name).await;
        let edited = tab_text.replace("a + 1", "a + 100");
        let direct = env.exec(&edited).await.expect_err("re-running CREATE on an existing function must fail");
        assert!(direct.contains("already exists"), "{direct}");

        env.run_all(&env.run_preparation(ObjectSourceKind::Function, name, &edited)).await?;
        env.exec(&edited).await?;
        assert_eq!(env.exec(&format!("SELECT `{name}`(1)")).await?.rows, vec![vec![json!("101")]]);
        let replaced = env.source_tab_text(ObjectSourceKind::Function, name).await;
        assert!(replaced.contains(&format!("DEFINER=`{definer}`@`%`")), "{replaced}");
        Ok::<_, String>(())
    }
    .await;
    env.cleanup().await;
    outcome.expect("function Run replacement should succeed on a live MySQL server");
}

#[tokio::test]
#[ignore = "requires a writable MySQL 8 endpoint (DBX_LIVE_MYSQL_ROUTINE_HOST/PORT/USER/PASSWORD)"]
async fn live_mysql_routine_source_run_keeps_original_when_the_edited_body_is_invalid() {
    let env = LiveRoutineEnv::create().await;
    let name = "p_issue_12855_invalid";
    let outcome = async {
        env.exec(&format!("CREATE PROCEDURE `{name}`()\nBEGIN\n  SELECT 1 AS v;\nEND")).await?;
        let tab_text = env.source_tab_text(ObjectSourceKind::Procedure, name).await;
        let broken = tab_text.replace("SELECT 1 AS v", "SELEC 1 AS v");

        // Validation under the temporary name fails first, so the preparation never reaches the DROP.
        let preparation = env.run_preparation(ObjectSourceKind::Procedure, name, &broken);
        let validation = env.run_all(&preparation).await.expect_err("invalid body must fail validation");
        assert!(validation.contains("syntax"), "{validation}");

        // The tab's own CREATE then reports the real syntax error rather than "already exists".
        let direct = env.exec(&broken).await.expect_err("invalid CREATE must fail");
        assert!(direct.contains("syntax") && !direct.contains("already exists"), "{direct}");

        // The original routine is untouched and still callable.
        assert_eq!(env.exec(&format!("CALL `{name}`()")).await?.rows, vec![vec![json!("1")]]);
        Ok::<_, String>(())
    }
    .await;
    env.cleanup().await;
    outcome.expect("an invalid edit must leave the original routine in place");
}

#[tokio::test]
#[ignore = "requires a writable MySQL 8 endpoint (DBX_LIVE_MYSQL_ROUTINE_HOST/PORT/USER/PASSWORD)"]
async fn live_mysql_routine_source_run_creates_a_missing_routine_without_error() {
    let env = LiveRoutineEnv::create().await;
    let name = "p_issue_12855_missing";
    let outcome = async {
        // First creation: nothing to drop, so every preparation step (DROP ... IF EXISTS) must be a no-op.
        let source = format!("CREATE PROCEDURE `{name}`()\nBEGIN\n  SELECT 7 AS v;\nEND");
        env.run_all(&env.run_preparation(ObjectSourceKind::Procedure, name, &source)).await?;
        env.exec(&source).await?;
        assert_eq!(env.exec(&format!("CALL `{name}`()")).await?.rows, vec![vec![json!("7")]]);
        Ok::<_, String>(())
    }
    .await;
    env.cleanup().await;
    outcome.expect("creating a routine that does not exist yet must not fail");
}
