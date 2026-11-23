use dbx_driver_sqlserver::{completion_assistant_search, connect, execute_batch, execute_query, get_columns};
use dbx_types::types::{CompletionAssistantCandidateKind, CompletionAssistantObjectKind, CompletionAssistantRequest};
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_completion_preserves_column_comments_and_order() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client = connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
        .await
        .expect("connect SQL Server");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let table = format!("dbx_completion_comments_{suffix}");
    let view = format!("dbx_completion_view_{suffix}");
    let cleanup = format!(
        "IF OBJECT_ID(N'dbo.{view}', N'V') IS NOT NULL DROP VIEW [dbo].[{view}]; \
         IF OBJECT_ID(N'dbo.{table}', N'U') IS NOT NULL DROP TABLE [dbo].[{table}];"
    );
    let comment = "\u{5de5}\u{5355}\u{7c7b}\u{522b}";
    let view_comment = "\u{89c6}\u{56fe}\u{5b57}\u{6bb5}";
    let setup = format!(
        "CREATE TABLE [dbo].[{table}] (z_column CHAR(4) NOT NULL, a_column NVARCHAR(40) NULL, no_comment INT NULL); \
         CREATE CLUSTERED INDEX [commented_index] ON [dbo].[{table}] (z_column); \
         EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'table description', \
           @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'{table}'; \
         EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'{comment}', \
           @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'{table}', \
           @level2type=N'COLUMN', @level2name=N'z_column'; \
         EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Customer''s display name', \
           @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'{table}', \
           @level2type=N'COLUMN', @level2name=N'a_column'; \
         EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'index description', \
           @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'{table}', \
           @level2type=N'INDEX', @level2name=N'commented_index';"
    );
    let result = async {
        execute_batch(&mut client, &setup).await?;
        execute_batch(
            &mut client,
            &format!("CREATE VIEW [dbo].[{view}] AS SELECT z_column, a_column, no_comment FROM [dbo].[{table}];"),
        )
        .await?;
        execute_batch(
            &mut client,
            &format!(
                "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'{view_comment}', \
                 @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'VIEW', @level1name=N'{view}', \
                 @level2type=N'COLUMN', @level2name=N'z_column';"
            ),
        )
        .await?;
        let request = CompletionAssistantRequest {
            connection_id: "live-completion-comments".to_string(),
            database,
            schema: Some("dbo".to_string()),
            object_kinds: vec![CompletionAssistantObjectKind::Column],
            mask: String::new(),
            case_sensitive: false,
            global_search: false,
            max_results: Some(50),
            search_in_comments: false,
            search_in_definitions: false,
            parent_schema: Some("dbo".to_string()),
            parent_name: Some(table.clone()),
            match_mode: None,
        };
        let columns = get_columns(&mut client, "dbo", &table).await?;
        let response = completion_assistant_search(&mut client, &request).await?;
        let filtered = completion_assistant_search(
            &mut client,
            &CompletionAssistantRequest { mask: "a_".to_string(), ..request.clone() },
        )
        .await?;
        let view_response = completion_assistant_search(
            &mut client,
            &CompletionAssistantRequest { parent_name: Some(view.clone()), ..request },
        )
        .await?;
        let version =
            execute_query(&mut client, "SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)) AS version")
                .await?;
        Ok::<_, String>((columns, response, filtered, view_response, version))
    }
    .await;
    execute_batch(&mut client, &cleanup).await.expect("clean up live completion fixtures");
    let (columns, response, filtered, view_response, version) = result.expect("query live completion metadata");
    println!("SQL Server version: {:?}", version.rows);
    assert!(!response.incomplete);
    assert!(!response.fallback_used);
    assert_eq!(response.candidates.len(), 3);
    for (candidate, column) in response.candidates.iter().zip(&columns) {
        assert_eq!(candidate.name, column.name);
        assert_eq!(candidate.comment, column.comment);
        assert_eq!(candidate.kind, CompletionAssistantCandidateKind::Column);
        assert_eq!(candidate.parent_name.as_deref(), Some(table.as_str()));
        assert_eq!(candidate.schema.as_deref(), Some("dbo"));
    }
    assert_eq!(response.candidates[0].name, "z_column");
    assert_eq!(response.candidates[0].comment.as_deref(), Some(comment));
    assert_eq!(response.candidates[0].data_type.as_deref(), Some("char"));
    assert_eq!(response.candidates[1].name, "a_column");
    assert_eq!(response.candidates[1].comment.as_deref(), Some("Customer's display name"));
    assert_eq!(response.candidates[2].comment, None);
    assert_eq!(filtered.candidates.len(), 1);
    assert_eq!(filtered.candidates[0].comment, response.candidates[1].comment);
    assert_eq!(view_response.candidates.len(), 3);
    assert_eq!(view_response.candidates[0].comment.as_deref(), Some(view_comment));
    assert_eq!(view_response.candidates[1].comment, None);
    assert_eq!(view_response.candidates[2].comment, None);
    println!("Verified table/view comments, Unicode, NULL comments, filtering, column order and index isolation.");
}
