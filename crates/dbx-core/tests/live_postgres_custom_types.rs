//! Live PostgreSQL coverage for user-defined type management.
//!
//! Runs the real Core path — capability probe, snapshot read, planner, apply —
//! against a writable PostgreSQL server, because that is the only way to know
//! the generated `ALTER TYPE` / `ALTER DOMAIN` forms are accepted by a kernel
//! rather than merely well-formed.
//!
//! ```text
//! DBX_LIVE_POSTGRES_HOST=127.0.0.1 DBX_LIVE_POSTGRES_PORT=5432 \
//! DBX_LIVE_POSTGRES_USER=postgres DBX_LIVE_POSTGRES_PASSWORD=secret \
//! DBX_LIVE_POSTGRES_DATABASE=postgres \
//!   cargo test -j 2 -p dbx-core --test live_postgres_custom_types -- --ignored --nocapture
//! ```
//!
//! Everything runs in a randomly named scratch schema that is dropped with
//! CASCADE at the end, so a run never leaves objects behind and never touches
//! an existing schema.

use dbx_core::connection::AppState;
use dbx_core::db::postgres as pg;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::schema::custom_types::{
    apply_custom_type_change_core, apply_custom_type_drop_core, get_custom_type_management_capabilities_core,
    list_custom_type_dependencies_core, preview_custom_type_change_core, preview_custom_type_drop_core,
};
use dbx_core::schema::get_custom_type_details_core;
use dbx_core::storage::Storage;
use dbx_core::types::{
    ApplyCustomTypeChangeRequest, ApplyCustomTypeDropRequest, CustomTypeAttributeDraft, CustomTypeChangeRequest,
    CustomTypeDomainConstraintDraft, CustomTypeDraft, CustomTypeDraftDefinition, CustomTypeDropRequest,
    CustomTypeEnumValueDraft, CustomTypeIdentity, CustomTypeKind, CustomTypeOperation,
};

const CONNECTION_ID: &str = "live-custom-types";

/// Connection parameters for the live server, read once so the URL and the
/// `ConnectionConfig` cannot disagree.
struct LiveTarget {
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
}

impl LiveTarget {
    fn from_env() -> Self {
        Self {
            host: std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
            port: std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432),
            user: std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string()),
            password: std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default(),
            database: std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string()),
        }
    }

    /// Percent-encoded, because a password containing `@` or `/` would otherwise
    /// be parsed as part of the host.
    fn url(&self) -> String {
        format!(
            "postgresql://{}:{}@{}:{}/{}",
            percent_encode(&self.user),
            percent_encode(&self.password),
            self.host,
            self.port,
            percent_encode(&self.database)
        )
    }
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => encoded.push(byte as char),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn connection_config(target: &LiveTarget) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": CONNECTION_ID,
        "name": "Live custom types",
        "db_type": "postgres",
        "host": target.host,
        "port": target.port,
        "username": target.user,
        "password": target.password,
        "database": target.database,
    }))
    .expect("build ConnectionConfig")
}

async fn live_state(target: &LiveTarget) -> AppState {
    let data_dir = std::env::temp_dir().join(format!("dbx-live-custom-types-{}", std::process::id()));
    std::fs::create_dir_all(&data_dir).expect("create data dir");
    let storage = Storage::open(&data_dir.join("dbx.db")).await.expect("open storage");
    let state = AppState::new(storage);
    state.configs.write().await.insert(CONNECTION_ID.to_string(), connection_config(target));
    state
}

fn enum_draft(schema: &str, name: &str, values: &[&str]) -> CustomTypeChangeRequest {
    CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: CustomTypeDraft {
            schema: schema.to_string(),
            name: name.to_string(),
            owner: None,
            comment: None,
            definition: CustomTypeDraftDefinition::Enum {
                values: values
                    .iter()
                    .map(|value| CustomTypeEnumValueDraft { value: (*value).to_string(), original_value: None })
                    .collect(),
            },
        },
    }
}

/// Turn an existing enum into a draft whose values carry their catalog identity.
fn enum_edit(schema: &str, name: &str, values: &[(Option<&str>, &str)]) -> CustomTypeChangeRequest {
    CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: Some(CustomTypeIdentity {
            schema: schema.to_string(),
            name: name.to_string(),
            kind: CustomTypeKind::Enum,
        }),
        draft: CustomTypeDraft {
            schema: schema.to_string(),
            name: name.to_string(),
            owner: None,
            comment: None,
            definition: CustomTypeDraftDefinition::Enum {
                values: values
                    .iter()
                    .map(|(original, value)| CustomTypeEnumValueDraft {
                        value: (*value).to_string(),
                        original_value: original.map(str::to_string),
                    })
                    .collect(),
            },
        },
    }
}

fn draft_identity(schema: &str, name: &str, kind: CustomTypeKind) -> CustomTypeIdentity {
    CustomTypeIdentity { schema: schema.to_string(), name: name.to_string(), kind }
}

/// One scratch schema per test.
///
/// Each test is kept small on purpose: a single giant async body overflows the
/// test thread's stack in debug builds, and a per-area test reports which part
/// of the feature broke.
/// The native PostgreSQL pool handle returned by the driver's `connect`.
type LivePool = deadpool_postgres::Pool;

struct LiveCase {
    state: AppState,
    pool: LivePool,
    schema: String,
    database: String,
}

impl LiveCase {
    async fn open() -> Self {
        let target = LiveTarget::from_env();
        let database = target.database.clone();
        let state = live_state(&target).await;
        let pool = pg::connect(&target.url(), std::time::Duration::from_secs(10)).await.expect("connect PostgreSQL");
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let schema = format!("dbx_types_{}", &suffix[..8]);
        pg::execute_batch(&pool, &[format!("CREATE SCHEMA \"{schema}\"")]).await.expect("create scratch schema");
        Self { state, pool, schema, database }
    }

    async fn bind(&self, mut request: CustomTypeChangeRequest) -> Result<CustomTypeChangeRequest, String> {
        if request.expected_snapshot_revision.is_none() {
            if let Some(target) = &request.target {
                request.expected_snapshot_revision = get_custom_type_details_core(
                    &self.state,
                    CONNECTION_ID,
                    &self.database,
                    &target.schema,
                    &target.name,
                )
                .await?
                .snapshot_revision;
            }
        }
        Ok(request)
    }

    async fn apply(&self, request: &CustomTypeChangeRequest) -> Result<CustomTypeIdentity, String> {
        let request = self.bind(request.clone()).await?;
        let preview =
            preview_custom_type_change_core(&self.state, CONNECTION_ID, &self.database, request.clone()).await?;
        assert!(
            preview.blocked_changes.is_empty(),
            "unexpected blocking issues for {request:?}: {:?}",
            preview.blocked_changes
        );
        // Kept so a statement the server rejects is visible in the failure
        // message instead of only "statement N failed".
        let statements = preview.statements.clone();
        let applied = apply_custom_type_change_core(
            &self.state,
            CONNECTION_ID,
            &self.database,
            ApplyCustomTypeChangeRequest { change: request.clone(), expected_plan_revision: preview.plan_revision },
        )
        .await
        .map_err(|error| format!("{error}\n--- planned statements ---\n{}", statements.join("\n")))?;
        Ok(applied.identity)
    }

    async fn details(&self, name: &str) -> Result<dbx_core::types::CustomTypeDetails, String> {
        get_custom_type_details_core(&self.state, CONNECTION_ID, &self.database, &self.schema, name).await
    }

    async fn exec(&self, statements: &[String]) -> Result<(), String> {
        pg::execute_batch(&self.pool, statements).await
    }

    async fn finish(&self) {
        if let Err(error) = self.exec(&[format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", self.schema)]).await {
            eprintln!("[live] cleanup failed: {error}");
        }
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_capabilities_are_resolved_for_postgres() {
    let case = LiveCase::open().await;
    let result = get_custom_type_management_capabilities_core(&case.state, CONNECTION_ID, Some(&case.database)).await;
    case.finish().await;
    let capabilities = result.expect("capability probe");
    assert_eq!(capabilities.database_type, "postgres");
    for operation in [
        CustomTypeOperation::CreateEnum,
        CustomTypeOperation::CreateComposite,
        CustomTypeOperation::CreateDomain,
        CustomTypeOperation::CreateRange,
        CustomTypeOperation::AlterEnumAddValue,
        CustomTypeOperation::AlterEnumRenameValue,
        CustomTypeOperation::AlterCompositeAddAttribute,
        CustomTypeOperation::AlterCompositeRenameAttribute,
        CustomTypeOperation::AlterCompositeAlterAttributeType,
        CustomTypeOperation::AlterCompositeDropAttribute,
        CustomTypeOperation::AlterDomainAddConstraint,
        CustomTypeOperation::AlterDomainValidateConstraint,
        CustomTypeOperation::DropRestrict,
        CustomTypeOperation::DropCascade,
        CustomTypeOperation::TransactionalDdl,
    ] {
        assert!(
            capabilities.supports(operation),
            "{operation:?} should be supported: {:?}",
            capabilities.operations.get(&operation)
        );
    }
    assert!(
        capabilities.supports(CustomTypeOperation::AlterEnumAddValueInTransaction),
        "PostgreSQL 12+ allows ADD VALUE inside a transaction"
    );
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_enum_create_add_rename_and_comment() {
    let case = LiveCase::open().await;
    let result = async {
        case.apply(&enum_draft(&case.schema, "status", &["draft", "published"])).await?;

        // Insert at the head and append in one plan: both anchors must be accepted.
        let add = enum_edit(
            &case.schema,
            "status",
            &[(None, "review"), (Some("draft"), "draft"), (Some("published"), "published"), (None, "archived")],
        );
        let add = case.bind(add).await?;
        let preview = preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, add.clone()).await?;
        assert!(preview.blocked_changes.is_empty(), "{:?}", preview.blocked_changes);
        assert_eq!(preview.statements.len(), 2, "{:?}", preview.statements);
        apply_custom_type_change_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeChangeRequest { change: add, expected_plan_revision: preview.plan_revision },
        )
        .await?;
        let values = case
            .details("status")
            .await?
            .members
            .into_iter()
            .filter_map(|member| member.enum_value)
            .collect::<Vec<_>>();
        assert_eq!(values, vec!["review", "draft", "published", "archived"], "{values:?}");

        // Rename one value and change the comment in the same plan.
        let mut rename = enum_edit(
            &case.schema,
            "status",
            &[
                (Some("review"), "review"),
                (Some("draft"), "pending"),
                (Some("published"), "published"),
                (Some("archived"), "archived"),
            ],
        );
        rename.draft.comment = Some("order status".to_string());
        case.apply(&rename).await?;
        let details = case.details("status").await?;
        assert_eq!(details.comment.as_deref(), Some("order status"));
        assert_eq!(
            details.members.iter().filter_map(|member| member.enum_value.clone()).collect::<Vec<_>>(),
            vec!["review", "pending", "published", "archived"]
        );

        // Renaming the type itself moves the object and reports the new identity.
        // The draft carries the *current* catalog identity: originals name the
        // values as they exist now, after the value rename above.
        let mut renamed = enum_edit(
            &case.schema,
            "status",
            &[
                (Some("review"), "review"),
                (Some("pending"), "pending"),
                (Some("published"), "published"),
                (Some("archived"), "archived"),
            ],
        );
        renamed.draft.name = "order_status".to_string();
        renamed.draft.comment = Some("order status".to_string());
        let renamed = case.bind(renamed).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, renamed.clone()).await?;
        assert_eq!(
            preview.statements,
            vec![format!("ALTER TYPE \"{}\".\"status\" RENAME TO \"order_status\";", case.schema)]
        );
        let identity = case.apply(&renamed).await?;
        assert_eq!(identity.name, "order_status");
        assert!(case.details("status").await.is_err());
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("enum round trip");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_enum_removal_and_reordering_are_refused() {
    let case = LiveCase::open().await;
    let result = async {
        case.apply(&enum_draft(&case.schema, "status", &["draft", "published"])).await?;

        let removal = enum_edit(&case.schema, "status", &[(Some("published"), "published")]);
        let removal = case.bind(removal).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, removal.clone()).await?;
        assert!(
            preview.blocked_changes.iter().any(|issue| issue.code == "enum.remove_value_unsupported"),
            "{:?}",
            preview.blocked_changes
        );
        assert!(
            apply_custom_type_change_core(
                &case.state,
                CONNECTION_ID,
                &case.database,
                ApplyCustomTypeChangeRequest { change: removal, expected_plan_revision: preview.plan_revision }
            )
            .await
            .is_err(),
            "a blocked plan must not be applied"
        );

        let reorder = enum_edit(&case.schema, "status", &[(Some("published"), "published"), (Some("draft"), "draft")]);
        let reorder = case.bind(reorder).await?;
        let preview = preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, reorder).await?;
        assert!(
            preview.blocked_changes.iter().any(|issue| issue.code == "enum.reorder_existing_unsupported"),
            "{:?}",
            preview.blocked_changes
        );

        // The type is untouched by either refusal.
        let values = case
            .details("status")
            .await?
            .members
            .into_iter()
            .filter_map(|member| member.enum_value)
            .collect::<Vec<_>>();
        assert_eq!(values, vec!["draft", "published"]);
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("enum guards");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_composite_add_rename_alter_drop_and_comments() {
    let case = LiveCase::open().await;
    let result = async {
        let create = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "address".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Composite {
                    attributes: vec![
                        CustomTypeAttributeDraft {
                            name: "city".to_string(),
                            original_name: None,
                            data_type: "text".to_string(),
                            comment: Some("city name".to_string()),
                        },
                        CustomTypeAttributeDraft {
                            name: "zip".to_string(),
                            original_name: None,
                            data_type: "numeric(6)".to_string(),
                            comment: None,
                        },
                    ],
                },
            },
        };
        case.apply(&create).await?;

        let edit = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: Some(draft_identity(&case.schema, "address", CustomTypeKind::Composite)),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "address".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Composite {
                    attributes: vec![
                        CustomTypeAttributeDraft {
                            name: "town".to_string(),
                            original_name: Some("city".to_string()),
                            data_type: "text".to_string(),
                            comment: Some("town name".to_string()),
                        },
                        CustomTypeAttributeDraft {
                            name: "zip".to_string(),
                            original_name: Some("zip".to_string()),
                            data_type: "varchar(12)".to_string(),
                            comment: None,
                        },
                        CustomTypeAttributeDraft {
                            name: "country".to_string(),
                            original_name: None,
                            data_type: "text".to_string(),
                            comment: None,
                        },
                    ],
                },
            },
        };
        case.apply(&edit).await?;
        let details = case.details("address").await?;
        assert_eq!(
            details.members.iter().map(|member| member.name.clone()).collect::<Vec<_>>(),
            vec!["town", "zip", "country"]
        );
        assert_eq!(details.members[0].comment.as_deref(), Some("town name"));
        assert_eq!(details.members[1].data_type, "character varying(12)");

        // Dropping an attribute is flagged destructive but still allowed.
        let drop_attribute = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: Some(draft_identity(&case.schema, "address", CustomTypeKind::Composite)),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "address".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Composite {
                    attributes: vec![
                        CustomTypeAttributeDraft {
                            name: "town".to_string(),
                            original_name: Some("town".to_string()),
                            data_type: "text".to_string(),
                            comment: Some("town name".to_string()),
                        },
                        CustomTypeAttributeDraft {
                            name: "country".to_string(),
                            original_name: Some("country".to_string()),
                            data_type: "text".to_string(),
                            comment: None,
                        },
                    ],
                },
            },
        };
        let drop_attribute = case.bind(drop_attribute).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, drop_attribute.clone()).await?;
        assert!(preview.destructive, "{:?}", preview.warnings);
        apply_custom_type_change_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeChangeRequest { change: drop_attribute, expected_plan_revision: preview.plan_revision },
        )
        .await?;
        assert_eq!(case.details("address").await?.members.len(), 2);
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("composite round trip");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_domain_default_not_null_and_constraints() {
    let case = LiveCase::open().await;
    let result = async {
        let create = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "email".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "text".to_string(),
                    collation: None,
                    default: Some("''::text".to_string()),
                    not_null: false,
                    constraints: vec![CustomTypeDomainConstraintDraft {
                        name: "email_valid".to_string(),
                        original_name: None,
                        expression: "VALUE ~ '.+@.+'".to_string(),
                        validated: None,
                    }],
                },
            },
        };
        case.apply(&create).await?;

        // Keep the constraint body exactly as the catalog rendered it: this test
        // is about renaming a constraint, not rewriting its expression.
        let created = case.details("email").await?;
        let live_body = created.properties.domain_constraints[0].definition.clone();
        let edit = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: Some(draft_identity(&case.schema, "email", CustomTypeKind::Domain)),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "email".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "text".to_string(),
                    collation: None,
                    default: Some("'unknown@example.com'::text".to_string()),
                    not_null: true,
                    constraints: vec![
                        CustomTypeDomainConstraintDraft {
                            name: "email_format".to_string(),
                            original_name: Some("email_valid".to_string()),
                            expression: live_body,
                            validated: None,
                        },
                        CustomTypeDomainConstraintDraft {
                            name: "email_not_empty".to_string(),
                            original_name: None,
                            expression: "VALUE <> ''".to_string(),
                            validated: None,
                        },
                    ],
                },
            },
        };
        case.apply(&edit).await?;
        let details = case.details("email").await?;
        assert_eq!(details.properties.not_null, Some(true));
        assert_eq!(details.properties.default.as_deref(), Some("'unknown@example.com'::text"));
        assert_eq!(
            details.properties.domain_constraints.iter().map(|entry| entry.name.clone()).collect::<Vec<_>>(),
            vec!["email_format", "email_not_empty"]
        );

        // Dropping a constraint is destructive. The surviving constraint keeps
        // its *current* name as `original_name`, because that is what the
        // planner matches against the live catalog.
        let mut drop_constraint = edit.clone();
        if let CustomTypeDraftDefinition::Domain { constraints, .. } = &mut drop_constraint.draft.definition {
            constraints.retain(|constraint| constraint.name == "email_format");
            for constraint in constraints.iter_mut() {
                constraint.original_name = Some(constraint.name.clone());
            }
        }
        let drop_constraint = case.bind(drop_constraint).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, drop_constraint.clone())
                .await?;
        assert!(preview.destructive, "{:?}", preview.warnings);
        apply_custom_type_change_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeChangeRequest { change: drop_constraint, expected_plan_revision: preview.plan_revision },
        )
        .await?;
        assert_eq!(case.details("email").await?.properties.domain_constraints.len(), 1);
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("domain round trip");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_range_and_immutable_changes_are_refused() {
    let case = LiveCase::open().await;
    let result = async {
        let create = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "price_range".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Range {
                    subtype: "numeric".to_string(),
                    subtype_opclass: None,
                    canonical_function: None,
                    subtype_diff_function: None,
                    multirange_name: None,
                },
            },
        };
        case.apply(&create).await?;

        // A range's definition has no ALTER form.
        let subtype_change = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: Some(draft_identity(&case.schema, "price_range", CustomTypeKind::Range)),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "price_range".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Range {
                    subtype: "integer".to_string(),
                    subtype_opclass: None,
                    canonical_function: None,
                    subtype_diff_function: None,
                    multirange_name: None,
                },
            },
        };
        let subtype_change = case.bind(subtype_change).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, subtype_change).await?;
        assert!(
            preview.blocked_changes.iter().any(|issue| issue.code == "range.definition_immutable"),
            "{:?}",
            preview.blocked_changes
        );

        // A domain's base type is equally immutable.
        let domain = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "amount".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "numeric".to_string(),
                    collation: None,
                    default: None,
                    not_null: false,
                    constraints: Vec::new(),
                },
            },
        };
        case.apply(&domain).await?;
        let base_change = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: Some(draft_identity(&case.schema, "amount", CustomTypeKind::Domain)),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "amount".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "integer".to_string(),
                    collation: None,
                    default: None,
                    not_null: false,
                    constraints: Vec::new(),
                },
            },
        };
        let base_change = case.bind(base_change).await?;
        let preview = preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, base_change).await?;
        assert!(
            preview.blocked_changes.iter().any(|issue| issue.code == "domain.base_type_immutable"),
            "{:?}",
            preview.blocked_changes
        );

        // A new type cannot take a name that is already in the namespace.
        let duplicate = enum_draft(&case.schema, "price_range", &["x"]);
        let duplicate = case.bind(duplicate).await?;
        let preview = preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, duplicate).await?;
        assert!(
            preview.blocked_changes.iter().any(|issue| issue.code == "identity.name_taken"),
            "{:?}",
            preview.blocked_changes
        );
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("range and immutable changes");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_escape_string_domain_expressions() {
    let case = LiveCase::open().await;
    let result = async {
        let s = &case.schema;
        let request = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: s.clone(),
                name: "escaped_domain".into(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "text".into(),
                    collation: None,
                    default: Some(r"E'it\'s'".into()),
                    not_null: false,
                    constraints: vec![CustomTypeDomainConstraintDraft {
                        name: "escaped_check".into(),
                        original_name: None,
                        expression: r"CHECK (VALUE <> e'blocked\'s)  (; --')".into(),
                        validated: Some(false),
                    }],
                },
            },
        };
        case.apply(&request).await?;
        case.exec(&[
            format!("CREATE TABLE \"{s}\".escaped_values (value \"{s}\".escaped_domain)"),
            format!("INSERT INTO \"{s}\".escaped_values DEFAULT VALUES"),
        ])
        .await?;
        let client = case.pool.get().await.map_err(|error| error.to_string())?;
        let row = client
            .query_one(&format!("SELECT value::text FROM \"{s}\".escaped_values"), &[])
            .await
            .map_err(|error| error.to_string())?;
        if row.get::<_, String>(0) != "it's" {
            return Err("escape-string default changed on the server".into());
        }
        let rejected_insert = format!(r#"INSERT INTO "{s}".escaped_values VALUES (E'blocked\'s)  (; --')"#);
        if case.exec(&[rejected_insert]).await.is_ok() {
            return Err("escape-string CHECK did not reject its exact literal".into());
        }
        // Only the two spaces differ from the forbidden value.
        case.exec(&[format!(r#"INSERT INTO "{s}".escaped_values VALUES (E'blocked\'s) (; --')"#)]).await?;
        let details = case.details("escaped_domain").await?;
        let mut edit = request;
        edit.target = Some(draft_identity(s, "escaped_domain", CustomTypeKind::Domain));
        if let CustomTypeDraftDefinition::Domain { collation, default, constraints, .. } = &mut edit.draft.definition {
            *collation = details.properties.collation;
            *default = Some(r"E'edited\'s'".into());
            constraints[0].original_name = Some("escaped_check".into());
            constraints[0].expression = r"CHECK (VALUE <> e'blocked\'s) (; --') NOT VALID".into();
        }
        case.apply(&edit).await?;
        if case.exec(&[format!(r#"INSERT INTO "{s}".escaped_values VALUES (E'blocked\'s) (; --')"#)]).await.is_ok() {
            return Err("replacing CHECK lost the literal's whitespace change".into());
        }
        case.exec(&[format!("INSERT INTO \"{s}\".escaped_values DEFAULT VALUES")]).await?;
        let row = client
            .query_one(&format!("SELECT count(*) FROM \"{s}\".escaped_values WHERE value::text = 'edited''s'"), &[])
            .await
            .map_err(|error| error.to_string())?;
        if row.get::<_, i64>(0) != 1 {
            return Err("edited escape-string default was not applied".into());
        }
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("escape-string defaults and CHECK expressions");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_domain_automatic_dependencies_allow_restrict() {
    let case = LiveCase::open().await;
    let result = async {
        let s = &case.schema;
        case.exec(&[
            format!("CREATE DOMAIN \"{s}\".positive AS integer CONSTRAINT positive_check CHECK (VALUE > 0)"),
            // This constraint has both automatic ownership and a normal
            // expression dependency on the same domain.
            format!("ALTER DOMAIN \"{s}\".positive ADD CONSTRAINT self_reference CHECK (pg_typeof(VALUE) <> '\"{s}\".positive'::regtype)"),
        ]).await?;
        let request = CustomTypeDropRequest { target: draft_identity(s, "positive", CustomTypeKind::Domain), cascade: false };
        let initial = preview_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, request.clone()).await?;
        if !initial.dependencies_complete || initial.dependencies.len() != 2
            || initial.dependencies.iter().any(|dependency| dependency.requires_cascade != Some(false))
            || initial.warnings.iter().any(|warning| warning.code == "drop.restrict_dependents") {
            return Err(format!("own constraints incorrectly require CASCADE: {initial:?}"));
        }
        case.exec(&[format!("CREATE TABLE \"{s}\".amounts (amount \"{s}\".positive)")]).await?;
        let external = preview_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, request.clone()).await?;
        if !external.dependencies.iter().any(|dependency| dependency.kind == "column" && dependency.requires_cascade == Some(true))
            || !external.warnings.iter().any(|warning| warning.code == "drop.restrict_dependents") {
            return Err(format!("external column no longer warns about RESTRICT: {external:?}"));
        }
        let stale = apply_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, ApplyCustomTypeDropRequest {
            request: request.clone(), expected_plan_revision: initial.plan_revision,
        }).await;
        if !stale.is_err_and(|error| error.contains("changed on the server")) {
            return Err("a new external column did not invalidate the drop preview".into());
        }
        if case.exec(&[format!("DROP DOMAIN \"{s}\".positive RESTRICT")]).await.is_ok() {
            return Err("RESTRICT unexpectedly removed a type with an external column".into());
        }
        case.exec(&[format!("DROP TABLE \"{s}\".amounts")]).await?;
        let preview = preview_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, request.clone()).await?;
        apply_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, ApplyCustomTypeDropRequest {
            request, expected_plan_revision: preview.plan_revision,
        }).await?;
        if case.details("positive").await.is_ok() {
            return Err("RESTRICT did not remove the domain".into());
        }
        Ok::<(), String>(())
    }.await;
    case.finish().await;
    result.expect("automatic domain dependencies and RESTRICT");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_dependencies_and_drop_behaviour() {
    let case = LiveCase::open().await;
    let result = async {
        case.apply(&enum_draft(&case.schema, "status", &["draft", "published"])).await?;
        case.exec(&[format!(
            "CREATE TABLE \"{}\".\"orders\" (id integer, state \"{}\".\"status\")",
            case.schema, case.schema
        )])
        .await?;

        let target = draft_identity(&case.schema, "status", CustomTypeKind::Enum);
        let dependencies =
            list_custom_type_dependencies_core(&case.state, CONNECTION_ID, &case.database, &case.schema, "status")
                .await?;
        assert!(
            dependencies
                .iter()
                .any(|dependency| dependency.kind == "column" && dependency.description.contains("orders")),
            "expected the orders.state column in {dependencies:?}"
        );

        let restrict = preview_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            CustomTypeDropRequest { target: target.clone(), cascade: false },
        )
        .await?;
        assert_eq!(restrict.statement, format!("DROP TYPE \"{}\".\"status\" RESTRICT;", case.schema));
        assert!(restrict.dependencies_complete);
        assert!(!restrict.dependencies.is_empty());
        assert!(
            restrict.warnings.iter().any(|issue| issue.code == "drop.restrict_dependents"),
            "{:?}",
            restrict.warnings
        );
        let error = apply_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeDropRequest {
                request: CustomTypeDropRequest { target: target.clone(), cascade: false },
                expected_plan_revision: restrict.plan_revision.clone(),
            },
        )
        .await
        .expect_err("RESTRICT is refused by the server while a column uses the type");
        assert!(!error.is_empty());
        // The failed drop left the type in place.
        assert!(case.details("status").await.is_ok());

        let cascade = preview_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            CustomTypeDropRequest { target: target.clone(), cascade: true },
        )
        .await?;
        assert_eq!(cascade.statement, format!("DROP TYPE \"{}\".\"status\" CASCADE;", case.schema));
        apply_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeDropRequest {
                request: CustomTypeDropRequest { target, cascade: true },
                expected_plan_revision: cascade.plan_revision,
            },
        )
        .await?;
        assert!(case.details("status").await.is_err(), "the dropped type must not be readable");

        // A domain is dropped as a DOMAIN, never as a TYPE.
        case.apply(&CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "amount".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "numeric".to_string(),
                    collation: None,
                    default: None,
                    not_null: false,
                    constraints: Vec::new(),
                },
            },
        })
        .await?;
        let domain = preview_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            CustomTypeDropRequest {
                target: draft_identity(&case.schema, "amount", CustomTypeKind::Domain),
                cascade: false,
            },
        )
        .await?;
        assert_eq!(domain.statement, format!("DROP DOMAIN \"{}\".\"amount\" RESTRICT;", case.schema));

        // Dropping something that is already gone must be refused before the user
        // can confirm it, rather than failing at the server.
        let missing = preview_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            CustomTypeDropRequest {
                target: draft_identity(&case.schema, "missing_domain", CustomTypeKind::Domain),
                cascade: false,
            },
        )
        .await
        .expect_err("a missing target must be refused");
        assert!(missing.contains("no longer exists or could not be read"), "{missing}");
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("dependencies and drop");
}

/// The fragment boundary must hold on a real server: a draft whose field carries
/// a statement terminator is refused in the plan, and — as a second line of
/// defence — the executed batch is verified to match the reviewed plan.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_injection_attempts_are_refused_without_touching_the_database() {
    let case = LiveCase::open().await;
    let result = async {
        // A real table the injected statement would try to drop.
        case.exec(&[format!("CREATE TABLE \"{}\".\"orders\" (id integer)", case.schema)]).await?;

        let default_injection = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "email".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "text".to_string(),
                    collation: None,
                    default: Some(format!("0; DROP TABLE \"{}\".\"orders\"; --", case.schema)),
                    not_null: false,
                    constraints: Vec::new(),
                },
            },
        };
        let default_injection = case.bind(default_injection).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, default_injection.clone())
                .await?;
        assert!(preview.statements.is_empty(), "{:?}", preview.statements);
        assert!(
            preview.blocked_changes.iter().any(|issue| issue.code == "fragment.invalid_expression"),
            "{:?}",
            preview.blocked_changes
        );
        // apply refuses, so the table survives.
        let error = apply_custom_type_change_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeChangeRequest {
                change: default_injection,
                expected_plan_revision: preview.plan_revision.clone(),
            },
        )
        .await;
        assert!(error.is_err());

        // A CHECK body is the other place a fragment is spliced in.
        let check_injection = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "email".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "text".to_string(),
                    collation: None,
                    default: None,
                    not_null: false,
                    constraints: vec![CustomTypeDomainConstraintDraft {
                        name: "c".to_string(),
                        original_name: None,
                        expression: format!("VALUE <> ''; DROP TABLE \"{}\".\"orders\"; --", case.schema),
                        validated: None,
                    }],
                },
            },
        };
        let check_injection = case.bind(check_injection).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, check_injection).await?;
        assert!(preview.statements.is_empty(), "{:?}", preview.statements);
        assert!(preview.blocked_changes.iter().any(|issue| issue.code == "fragment.invalid_expression"));

        // The table is still there and no type was created.
        let rows = case.exec(&[format!("SELECT 1 FROM \"{}\".\"orders\" LIMIT 1", case.schema)]).await;
        assert!(rows.is_ok(), "the injected statement must not have run: {rows:?}");
        assert!(case.details("email").await.is_err());
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("injection attempts");
}

/// A literal that merely *contains* a semicolon is data, not a terminator.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_expression_literals_keep_their_exact_contents() {
    let case = LiveCase::open().await;
    let result = async {
        let create = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "code".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "text".to_string(),
                    collation: None,
                    default: None,
                    not_null: false,
                    constraints: vec![CustomTypeDomainConstraintDraft {
                        // Two spaces and a semicolon inside the literal: the
                        // server must store exactly this.
                        name: "code_shape".to_string(),
                        original_name: None,
                        expression: "VALUE <> 'a  b;c'".to_string(),
                        validated: None,
                    }],
                },
            },
        };
        case.apply(&create).await?;
        let details = case.details("code").await?;
        let definition = details.properties.domain_constraints[0].definition.clone();
        assert!(definition.contains("'a  b;c'"), "the literal must round-trip unchanged, got {definition}");

        // The domain actually rejects a value that equals the literal.
        case.exec(&[format!(
            "CREATE TABLE \"{}\".\"codes\" (id integer, value \"{}\".\"code\")",
            case.schema, case.schema
        )])
        .await?;
        let rejected = case.exec(&[format!("INSERT INTO \"{}\".\"codes\" VALUES (1, 'a  b;c')", case.schema)]).await;
        assert!(rejected.is_err(), "the constraint must reject the literal value");
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("literal fidelity");
}

/// Base types and multiranges keep the generic-property-only contract.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_base_and_multirange_protections() {
    let case = LiveCase::open().await;
    let result = async {
        // A multirange companion is created by naming it on the range.
        case.apply(&CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "price_range".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Range {
                    subtype: "numeric".to_string(),
                    subtype_opclass: None,
                    canonical_function: None,
                    subtype_diff_function: None,
                    multirange_name: Some("price_multirange".to_string()),
                },
            },
        })
        .await?;

        let companion = case.details("price_multirange").await?;
        assert_eq!(companion.kind, CustomTypeKind::Multirange, "kind must survive the round trip");

        // Reusing its real kind, a rename is refused rather than mis-planned.
        let rename = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: Some(draft_identity(&case.schema, "price_multirange", CustomTypeKind::Multirange)),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "renamed_multirange".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::None { type_kind: CustomTypeKind::Multirange },
            },
        };
        let rename = case.bind(rename).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, rename.clone()).await?;
        assert!(
            preview.blocked_changes.iter().any(|issue| issue.code == "multirange.rename_unsupported"),
            "{:?}",
            preview.blocked_changes
        );
        assert!(preview.statements.is_empty(), "{:?}", preview.statements);

        // Its comment is still editable, and the plan carries the real kind.
        let comment = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: Some(draft_identity(&case.schema, "price_multirange", CustomTypeKind::Multirange)),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "price_multirange".to_string(),
                owner: None,
                comment: Some("prices".to_string()),
                definition: CustomTypeDraftDefinition::None { type_kind: CustomTypeKind::Multirange },
            },
        };
        case.apply(&comment).await?;
        assert_eq!(case.details("price_multirange").await?.comment.as_deref(), Some("prices"));

        // A base type accepts a rename through the same generic path.
        let base_info = case.details("price_range").await?;
        let base_rename = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: Some(draft_identity(&case.schema, "price_range", base_info.kind)),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "money_range".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::None { type_kind: base_info.kind },
            },
        };
        let base_rename = case.bind(base_rename).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, base_rename.clone()).await?;
        assert!(preview.blocked_changes.is_empty(), "{:?}", preview.blocked_changes);
        assert_eq!(preview.resulting_identity.kind, base_info.kind);
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("base and multirange protections");
}

/// A pending CASCADE must be invalidated when a dependent appears afterwards.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_a_new_dependency_invalidates_a_drop_plan() {
    let case = LiveCase::open().await;
    let result = async {
        case.apply(&enum_draft(&case.schema, "status", &["draft"])).await?;
        let target = draft_identity(&case.schema, "status", CustomTypeKind::Enum);

        // Preview the drop while nothing depends on the type.
        let preview = preview_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            CustomTypeDropRequest { target: target.clone(), cascade: true },
        )
        .await?;
        assert!(preview.dependencies.is_empty(), "{:?}", preview.dependencies);

        // Someone else starts using the type.
        case.exec(&[format!(
            "CREATE TABLE \"{}\".\"orders\" (id integer, state \"{}\".\"status\")",
            case.schema, case.schema
        )])
        .await?;

        // The statement is unchanged, but the plan must no longer apply: the user
        // never agreed to cascade a table away.
        let error = apply_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeDropRequest {
                request: CustomTypeDropRequest { target: target.clone(), cascade: true },
                expected_plan_revision: preview.plan_revision.clone(),
            },
        )
        .await
        .expect_err("a new dependency must invalidate the plan");
        assert!(error.contains("changed on the server"), "{error}");

        // The table and the type both survive.
        assert!(case.details("status").await.is_ok());
        assert!(case.exec(&[format!("SELECT 1 FROM \"{}\".\"orders\" LIMIT 1", case.schema)]).await.is_ok());
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("drop revision");
}

/// A dependency in a different table can share the column name of the dependency
/// the user reviewed. Dependency identity must therefore include the parent
/// object, or the revision would not move and an unreviewed table would be
/// cascaded away.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_a_same_named_dependency_in_another_table_invalidates_a_drop_plan() {
    let case = LiveCase::open().await;
    let result = async {
        case.apply(&enum_draft(&case.schema, "status", &["draft"])).await?;
        case.exec(&[format!(
            "CREATE TABLE \"{}\".\"orders\" (id integer, state \"{}\".\"status\")",
            case.schema, case.schema
        )])
        .await?;
        let target = draft_identity(&case.schema, "status", CustomTypeKind::Enum);

        // Preview while `orders.state` is the only dependent.
        let preview = preview_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            CustomTypeDropRequest { target: target.clone(), cascade: true },
        )
        .await?;
        assert!(
            preview.dependencies.iter().any(|dependency| dependency.description.contains("orders")),
            "{:?}",
            preview.dependencies
        );

        // A second table adds a dependency whose *column name is identical*.
        case.exec(&[format!(
            "CREATE TABLE \"{}\".\"invoices\" (id integer, state \"{}\".\"status\")",
            case.schema, case.schema
        )])
        .await?;

        let error = apply_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeDropRequest {
                request: CustomTypeDropRequest { target: target.clone(), cascade: true },
                expected_plan_revision: preview.plan_revision.clone(),
            },
        )
        .await
        .expect_err("the same-named dependency in another table must invalidate the plan");
        assert!(error.contains("changed on the server"), "{error}");

        // Nothing was cascaded.
        assert!(case.details("status").await.is_ok());
        for table in ["orders", "invoices"] {
            assert!(
                case.exec(&[format!("SELECT 1 FROM \"{}\".\"{table}\" LIMIT 1", case.schema)]).await.is_ok(),
                "{table} must survive"
            );
        }
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("same-named dependency");
}

/// Same name, same kind, same definition — but a different object. The catalog
/// identity is what makes this detectable.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_a_recreated_type_invalidates_a_drop_plan() {
    let case = LiveCase::open().await;
    let result = async {
        case.apply(&enum_draft(&case.schema, "status", &["draft"])).await?;
        let before = case.details("status").await?;
        assert!(before.catalog_id.is_some(), "the driver must expose a catalog identity");

        let target = draft_identity(&case.schema, "status", CustomTypeKind::Enum);
        let preview = preview_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            CustomTypeDropRequest { target: target.clone(), cascade: false },
        )
        .await?;

        // Someone else drops and recreates the type with an identical definition.
        case.exec(&[format!("DROP TYPE \"{}\".\"status\"", case.schema)]).await?;
        case.apply(&enum_draft(&case.schema, "status", &["draft"])).await?;
        let after = case.details("status").await?;
        assert_ne!(before.catalog_id, after.catalog_id, "a recreated type must get a new identity");

        let error = apply_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeDropRequest {
                request: CustomTypeDropRequest { target, cascade: false },
                expected_plan_revision: preview.plan_revision.clone(),
            },
        )
        .await
        .expect_err("a recreated type must invalidate the plan");
        assert!(error.contains("changed on the server"), "{error}");
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("recreated type");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_stale_plan_is_refused() {
    let case = LiveCase::open().await;
    let result = async {
        case.apply(&enum_draft(&case.schema, "status", &["a"])).await?;
        let edit = enum_edit(&case.schema, "status", &[(Some("a"), "a"), (None, "b")]);
        let edit = case.bind(edit).await?;
        let stale = preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, edit.clone()).await?;
        assert!(stale.blocked_changes.is_empty(), "{:?}", stale.blocked_changes);

        // Another session changes the type after the preview.
        case.exec(&[format!("ALTER TYPE \"{}\".\"status\" ADD VALUE 'c'", case.schema)]).await?;

        let error = apply_custom_type_change_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeChangeRequest { change: edit, expected_plan_revision: stale.plan_revision },
        )
        .await
        .expect_err("a stale plan must be refused");
        assert!(error.contains("changed on the server"), "{error}");

        // Re-previewing picks up the external change and succeeds.
        let fresh = enum_edit(&case.schema, "status", &[(Some("a"), "a"), (Some("c"), "c"), (None, "b")]);
        case.apply(&fresh).await?;
        let values = case
            .details("status")
            .await?
            .members
            .into_iter()
            .filter_map(|member| member.enum_value)
            .collect::<Vec<_>>();
        assert_eq!(values, vec!["a", "c", "b"], "{values:?}");
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("stale plan");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_type_fragment_cannot_hide_a_drop_attribute_action() {
    let case = LiveCase::open().await;
    let result = async {
        case.exec(&[format!("CREATE TYPE \"{}\".address AS (secret text)", case.schema)]).await?;
        let request = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: Some(draft_identity(&case.schema, "address", CustomTypeKind::Composite)),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "address".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Composite {
                    attributes: vec![
                        CustomTypeAttributeDraft {
                            name: "secret".to_string(),
                            original_name: Some("secret".to_string()),
                            data_type: "text".to_string(),
                            comment: None,
                        },
                        CustomTypeAttributeDraft {
                            name: "extra".to_string(),
                            original_name: None,
                            data_type: "text, DROP ATTRIBUTE secret".to_string(),
                            comment: None,
                        },
                    ],
                },
            },
        };
        let request = case.bind(request).await?;
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, request.clone()).await?;
        if preview.blocked_changes.is_empty() || !preview.statements.is_empty() {
            return Err(format!("unsafe type fragment was accepted: {preview:?}"));
        }
        if apply_custom_type_change_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeChangeRequest { change: request, expected_plan_revision: preview.plan_revision },
        )
        .await
        .is_ok()
        {
            return Err("unsafe change was applied".to_string());
        }
        let details = case.details("address").await?;
        if details.members.len() != 1 || details.members[0].name != "secret" {
            return Err("the original attribute was modified".to_string());
        }
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("single-statement injection protection");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_unicode_check_and_qualified_collation() {
    let case = LiveCase::open().await;
    let result = async {
        for (name, collation) in [("qualified_domain", "pg_catalog.\"C\""), ("quoted_domain", "\"C\"")] {
            case.apply(&CustomTypeChangeRequest {
                expected_snapshot_revision: None,
                target: None,
                draft: CustomTypeDraft {
                    schema: case.schema.clone(),
                    name: name.to_string(),
                    owner: None,
                    comment: None,
                    definition: CustomTypeDraftDefinition::Domain {
                        base_type: "text".to_string(),
                        collation: Some(collation.to_string()),
                        default: None,
                        not_null: false,
                        constraints: vec![CustomTypeDomainConstraintDraft {
                            name: "ck".to_string(),
                            original_name: None,
                            expression: "'中文' <> VALUE".to_string(),
                            validated: None,
                        }],
                    },
                },
            })
            .await?;
            case.exec(&[format!("SELECT 'ok'::\"{}\".{name}", case.schema)]).await?;
            if case.exec(&[format!("SELECT '中文'::\"{}\".{name}", case.schema)]).await.is_ok() {
                return Err("the CHECK did not preserve the Chinese literal".to_string());
            }
            let details = case.details(name).await?;
            if details.properties.collation.as_deref() != Some("pg_catalog.\"C\"") {
                return Err(format!("wrong collation: {:?}", details.properties.collation));
            }
        }
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("unicode CHECK and collation");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_enum_rename_can_reuse_the_freed_label() {
    let case = LiveCase::open().await;
    let result = async {
        case.apply(&enum_draft(&case.schema, "status", &["draft", "published"])).await?;
        case.apply(&enum_edit(
            &case.schema,
            "status",
            &[(Some("draft"), "pending"), (None, "draft"), (Some("published"), "published")],
        ))
        .await?;
        let labels = case
            .details("status")
            .await?
            .members
            .into_iter()
            .filter_map(|member| member.enum_value)
            .collect::<Vec<_>>();
        if labels != ["pending", "draft", "published"] {
            return Err(format!("wrong enum order: {labels:?}"));
        }
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("reuse renamed enum label");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_array_and_transitive_dependencies_invalidate_cascade_plans() {
    let case = LiveCase::open().await;
    let result = async {
        let s = &case.schema;
        case.apply(&enum_draft(s, "status", &["draft"])).await?;
        let request =
            CustomTypeDropRequest { target: draft_identity(s, "status", CustomTypeKind::Enum), cascade: true };
        let empty = preview_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, request.clone()).await?;
        if !empty.dependencies_complete || !empty.dependencies.is_empty() {
            return Err(format!("unexpected initial dependencies: {empty:?}"));
        }
        case.exec(&[
            format!("CREATE DOMAIN \"{s}\".status_domain AS \"{s}\".status[]"),
            format!("CREATE TABLE \"{s}\".orders (id integer, states \"{s}\".status[], codes \"{s}\".status_domain)"),
            format!(
                "CREATE TABLE \"{s}\".defaults_only (id integer, label text DEFAULT 'draft'::\"{s}\".status::text)"
            ),
        ])
        .await?;
        let stale = apply_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeDropRequest { request: request.clone(), expected_plan_revision: empty.plan_revision },
        )
        .await;
        if !stale.is_err_and(|error| error.contains("changed on the server")) {
            return Err("an array dependency did not invalidate the plan".to_string());
        }
        let before_view =
            preview_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, request.clone()).await?;
        case.exec(&[
            format!("CREATE VIEW \"{s}\".orders_view AS SELECT id FROM \"{s}\".orders WHERE cardinality(states) > 0"),
            format!("CREATE VIEW \"{s}\".nested_view AS SELECT * FROM \"{s}\".orders_view"),
        ])
        .await?;
        let stale = apply_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeDropRequest { request: request.clone(), expected_plan_revision: before_view.plan_revision },
        )
        .await;
        if !stale.is_err_and(|error| error.contains("changed on the server")) {
            return Err("a transitive view dependency did not invalidate the plan".to_string());
        }
        let preview =
            preview_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, request.clone()).await?;
        if !preview.dependencies_complete {
            return Err(format!("dependency query failed: {:?}", preview.warnings));
        }
        for (kind, name) in [
            ("column", "states"),
            ("column", "codes"),
            ("type", "status_domain"),
            ("view", "orders_view"),
            ("view", "nested_view"),
        ] {
            if !preview.dependencies.iter().any(|dep| dep.kind == kind && dep.name == name) {
                return Err(format!("missing {kind} {name}: {:?}", preview.dependencies));
            }
        }
        if !preview.dependencies.iter().any(|dep| dep.kind == "default") {
            return Err("the default's dependency was omitted".to_string());
        }
        if preview.dependencies.iter().any(|dep| dep.kind == "table" || dep.catalog_id.is_none()) {
            return Err(format!("wrong dependent identity or whole-table promotion: {:?}", preview.dependencies));
        }
        apply_custom_type_drop_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeDropRequest { request, expected_plan_revision: preview.plan_revision },
        )
        .await?;
        // CASCADE removes the array/domain columns and views, but both tables
        // and their unrelated columns survive. The text column loses its default.
        case.exec(&[format!("SELECT id FROM \"{s}\".orders"), format!("SELECT id, label FROM \"{s}\".defaults_only")])
            .await?;
        for query in [format!("SELECT states FROM \"{s}\".orders"), format!("SELECT * FROM \"{s}\".nested_view")] {
            if case.exec(&[query]).await.is_ok() {
                return Err("CASCADE left a dependent object behind".to_string());
            }
        }
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("array and transitive dependency closure");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_domain_not_valid_create_and_edit_catalog_expression() {
    let case = LiveCase::open().await;
    let result = async {
        let mut request = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "positive".into(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "integer".into(),
                    collation: None,
                    default: None,
                    not_null: false,
                    constraints: vec![CustomTypeDomainConstraintDraft {
                        name: "ck".into(),
                        original_name: None,
                        expression: "VALUE > 0".into(),
                        validated: Some(false),
                    }],
                },
            },
        };
        case.apply(&request).await?;
        let before = case.details("positive").await?;
        assert_eq!(before.properties.domain_constraints[0].validated, Some(false));
        request.target = Some(CustomTypeIdentity {
            schema: case.schema.clone(),
            name: "positive".into(),
            kind: CustomTypeKind::Domain,
        });
        request.expected_snapshot_revision = before.snapshot_revision;
        if let CustomTypeDraftDefinition::Domain { constraints, .. } = &mut request.draft.definition {
            constraints[0].original_name = Some("ck".into());
            constraints[0].expression = before.properties.domain_constraints[0].definition.replace("> 0", "> 1");
        }
        case.apply(&request).await?;
        let after = case.details("positive").await?;
        assert_eq!(after.properties.domain_constraints[0].validated, Some(false));
        assert!(after.properties.domain_constraints[0].definition.contains("> 1"));
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("NOT VALID domain round trip");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_repreview_cannot_accept_an_editing_baseline_changed_by_another_session() {
    let case = LiveCase::open().await;
    let result = async {
        case.exec(&[format!("CREATE DOMAIN \"{}\".d AS integer DEFAULT 1", case.schema)]).await?;
        let before = case.details("d").await?;
        let request = CustomTypeChangeRequest {
            expected_snapshot_revision: before.snapshot_revision,
            target: Some(CustomTypeIdentity {
                schema: case.schema.clone(),
                name: "d".into(),
                kind: CustomTypeKind::Domain,
            }),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: "d".into(),
                owner: before.owner,
                comment: Some("only change the comment".into()),
                definition: CustomTypeDraftDefinition::Domain {
                    base_type: "integer".into(),
                    collation: None,
                    default: before.properties.default,
                    not_null: false,
                    constraints: vec![],
                },
            },
        };
        let preview =
            preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, request.clone()).await?;
        case.exec(&[format!("ALTER DOMAIN \"{}\".d SET DEFAULT 2", case.schema)]).await?;
        let error = preview_custom_type_change_core(&case.state, CONNECTION_ID, &case.database, request.clone())
            .await
            .unwrap_err();
        assert!(error.contains("since editing began"), "{error}");
        let error = apply_custom_type_change_core(
            &case.state,
            CONNECTION_ID,
            &case.database,
            ApplyCustomTypeChangeRequest { change: request, expected_plan_revision: preview.plan_revision },
        )
        .await
        .unwrap_err();
        assert!(error.contains("since editing began"), "{error}");
        let after = case.details("d").await?;
        assert_eq!(after.properties.default.as_deref(), Some("2"));
        assert!(after.comment.is_none());
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("stale editor cannot overwrite a concurrent change after re-preview");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_unicode_range_with_generated_multirange_can_be_commented() {
    let case = LiveCase::open().await;
    let result = async {
        case.exec(&[format!("CREATE TYPE \"{}\".\"价格区间\" AS RANGE (subtype = numeric)", case.schema)]).await?;
        let before = case.details("价格区间").await?;
        assert_eq!(before.properties.range_multirange_name.as_deref(), Some("价格区间_multirange"));
        let request = CustomTypeChangeRequest {
            expected_snapshot_revision: before.snapshot_revision,
            target: Some(CustomTypeIdentity {
                schema: case.schema.clone(),
                name: before.name.clone(),
                kind: CustomTypeKind::Range,
            }),
            draft: CustomTypeDraft {
                schema: case.schema.clone(),
                name: before.name,
                owner: before.owner,
                comment: Some("价格范围".into()),
                definition: CustomTypeDraftDefinition::Range {
                    subtype: before.properties.range_subtype.unwrap(),
                    subtype_opclass: before.properties.range_subtype_opclass,
                    canonical_function: before.properties.range_canonical_function,
                    subtype_diff_function: before.properties.range_subtype_diff_function,
                    multirange_name: before.properties.range_multirange_name,
                },
            },
        };
        case.apply(&request).await?;
        assert_eq!(case.details("价格区间").await?.comment.as_deref(), Some("价格范围"));
        Ok::<(), String>(())
    }
    .await;
    case.finish().await;
    result.expect("Unicode range comment");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_spaced_type_identity_survives_create_edit_dependencies_and_drop() {
    let case = LiveCase::open().await;
    let result = async {
        case.apply(&enum_draft(&case.schema, "status", &["plain"])).await?;
        case.apply(&enum_draft(&case.schema, " status ", &["spaced"])).await?;
        let spaced = case.details(" status ").await?;
        assert_eq!(spaced.name, " status ");
        assert_eq!(spaced.members[0].enum_value.as_deref(), Some("spaced"));
        case.exec(&[format!(
            "CREATE TABLE \"{s}\".plain_table (state \"{s}\".status); CREATE TABLE \"{s}\".spaced_table (state \"{s}\".\" status \")", s = case.schema,
        )]).await?;
        let dependencies = list_custom_type_dependencies_core(&case.state, CONNECTION_ID, &case.database, &case.schema, " status ").await?;
        assert!(dependencies.iter().any(|d| d.description.contains("spaced_table")), "{dependencies:?}");
        assert!(!dependencies.iter().any(|d| d.description.contains("plain_table")), "{dependencies:?}");
        let mut edit = enum_edit(&case.schema, " status ", &[(Some("spaced"), "spaced"), (None, "added")]);
        edit.expected_snapshot_revision = spaced.snapshot_revision;
        edit.draft.name = " renamed ".into();
        edit.draft.comment = Some("spaced only".into());
        let identity = case.apply(&edit).await?;
        assert_eq!(identity.name, " renamed ");
        assert!(case.details(" status ").await.is_err());
        let renamed = case.details(" renamed ").await?;
        assert_eq!(renamed.comment.as_deref(), Some("spaced only"));
        assert_eq!(renamed.members.len(), 2);
        let drop = CustomTypeDropRequest { target: identity, cascade: true };
        let preview = preview_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, drop.clone()).await?;
        assert!(preview.dependencies.iter().any(|d| d.description.contains("spaced_table")));
        assert!(!preview.dependencies.iter().any(|d| d.description.contains("plain_table")));
        apply_custom_type_drop_core(&case.state, CONNECTION_ID, &case.database, ApplyCustomTypeDropRequest {
            request: drop, expected_plan_revision: preview.plan_revision,
        }).await?;
        assert!(case.details(" renamed ").await.is_err());
        let plain = case.details("status").await?;
        assert_eq!(plain.comment, None);
        assert_eq!(plain.members.len(), 1);
        assert_eq!(plain.members[0].enum_value.as_deref(), Some("plain"));
        case.exec(&[format!("INSERT INTO \"{}\".plain_table VALUES ('plain')", case.schema)]).await?;
        Ok::<(), String>(())
    }.await;
    case.finish().await;
    result.expect("spaced type identities remain distinct");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn live_copied_domain_ddl_preserves_not_valid_constraints() {
    let case = LiveCase::open().await;
    let result = async {
        case.exec(&[format!(
            "CREATE DOMAIN \"{s}\".d AS text; ALTER DOMAIN \"{s}\".d ADD CONSTRAINT \" spaced check \" CHECK (VALUE <> 'a  b') NOT VALID", s = case.schema,
        )]).await?;
        let original = case.details("d").await?;
        let ddl = original.ddl.as_ref().expect("domain DDL");
        assert!(ddl.complete, "{ddl:?}");
        case.exec(&[ddl.sql.replace("\"d\"", "\"copied_d\"")]).await?;
        let copied = case.details("copied_d").await?;
        assert_eq!(copied.properties.domain_constraints.len(), 1);
        let constraint = &copied.properties.domain_constraints[0];
        assert_eq!(constraint.validated, Some(false));
        assert_eq!(constraint.name, " spaced check ");
        assert_eq!(constraint.definition, original.properties.domain_constraints[0].definition);
        assert!(constraint.definition.contains("'a  b'"));
        Ok::<(), String>(())
    }.await;
    case.finish().await;
    result.expect("copied NOT VALID domain DDL replays correctly");
}
