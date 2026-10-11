use std::collections::BTreeMap;

use crate::types::{
    CustomTypeAttributeDraft, CustomTypeChangeRequest, CustomTypeDetails, CustomTypeDomainConstraint,
    CustomTypeDomainConstraintDraft, CustomTypeDraft, CustomTypeDraftDefinition, CustomTypeDropRequest,
    CustomTypeEnumValueDraft, CustomTypeIdentity, CustomTypeKind, CustomTypeManagementCapabilities, CustomTypeMember,
    CustomTypeOperation, CustomTypeOperationCapability, CustomTypePlanIssueSeverity, CustomTypeProperties,
    CustomTypeTransactionPolicy,
};

use super::{plan_custom_type_change, plan_custom_type_drop, CustomTypeSqlDialect};

fn all_supported() -> CustomTypeManagementCapabilities {
    capabilities(true)
}

fn capabilities(supported: bool) -> CustomTypeManagementCapabilities {
    let mut operations = BTreeMap::new();
    for operation in CustomTypeOperation::ALL {
        operations.insert(
            operation,
            if supported {
                CustomTypeOperationCapability::supported()
            } else {
                CustomTypeOperationCapability::unsupported("not_verified", "not verified on this connection")
            },
        );
    }
    CustomTypeManagementCapabilities {
        database_type: "postgres".to_string(),
        product_version: Some("16.0".to_string()),
        compatibility_mode: None,
        operations,
        capability_revision: "cap-1".to_string(),
    }
}

fn without(operation: CustomTypeOperation) -> CustomTypeManagementCapabilities {
    let mut capabilities = all_supported();
    capabilities.operations.insert(
        operation,
        CustomTypeOperationCapability::unsupported("not_verified", "not verified on this connection"),
    );
    capabilities
}

fn enum_snapshot() -> CustomTypeDetails {
    CustomTypeDetails {
        snapshot_revision: None,
        name: "status".to_string(),
        schema: "app".to_string(),
        kind: CustomTypeKind::Enum,
        catalog_id: None,
        comment: Some("order status".to_string()),
        members: vec![enum_member(1, "draft"), enum_member(2, "published")],
        properties: CustomTypeProperties::default(),
        ddl: None,
        owner: Some("app_owner".to_string()),
    }
}

fn enum_member(ordinal: i32, value: &str) -> CustomTypeMember {
    CustomTypeMember {
        name: String::new(),
        data_type: String::new(),
        ordinal,
        nullable: None,
        default: None,
        comment: None,
        enum_value: Some(value.to_string()),
    }
}

fn composite_snapshot() -> CustomTypeDetails {
    CustomTypeDetails {
        snapshot_revision: None,
        name: "address".to_string(),
        schema: "app".to_string(),
        kind: CustomTypeKind::Composite,
        catalog_id: None,
        comment: None,
        members: vec![attribute(1, "city", "text", Some("city name")), attribute(2, "zip", "numeric(6)", None)],
        properties: CustomTypeProperties::default(),
        ddl: None,
        owner: None,
    }
}

fn attribute(ordinal: i32, name: &str, data_type: &str, comment: Option<&str>) -> CustomTypeMember {
    CustomTypeMember {
        name: name.to_string(),
        data_type: data_type.to_string(),
        ordinal,
        nullable: None,
        default: None,
        comment: comment.map(str::to_string),
        enum_value: None,
    }
}

fn domain_snapshot() -> CustomTypeDetails {
    CustomTypeDetails {
        snapshot_revision: None,
        name: "email".to_string(),
        schema: "app".to_string(),
        kind: CustomTypeKind::Domain,
        catalog_id: None,
        comment: None,
        members: Vec::new(),
        properties: CustomTypeProperties {
            base_type: Some("text".to_string()),
            not_null: Some(false),
            default: Some("''::text".to_string()),
            collation: Some("C".to_string()),
            domain_constraints: vec![CustomTypeDomainConstraint {
                name: "email_valid".to_string(),
                definition: "CHECK ((VALUE <> ''::text))".to_string(),
                validated: Some(true),
            }],
            ..Default::default()
        },
        ddl: None,
        owner: None,
    }
}

fn range_snapshot() -> CustomTypeDetails {
    CustomTypeDetails {
        snapshot_revision: None,
        name: "price_range".to_string(),
        schema: "app".to_string(),
        kind: CustomTypeKind::Range,
        catalog_id: None,
        comment: None,
        members: Vec::new(),
        properties: CustomTypeProperties {
            range_subtype: Some("numeric".to_string()),
            range_subtype_opclass: Some("pg_catalog.numeric_ops".to_string()),
            ..Default::default()
        },
        ddl: None,
        owner: None,
    }
}

fn draft(definition: CustomTypeDraftDefinition) -> CustomTypeDraft {
    CustomTypeDraft { schema: "app".to_string(), name: "status".to_string(), owner: None, comment: None, definition }
}

fn edit_request(target: &CustomTypeDetails, definition: CustomTypeDraftDefinition) -> CustomTypeChangeRequest {
    CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: Some(CustomTypeIdentity {
            schema: target.schema.clone(),
            name: target.name.clone(),
            kind: target.kind,
        }),
        draft: CustomTypeDraft {
            schema: target.schema.clone(),
            name: target.name.clone(),
            owner: target.owner.clone(),
            comment: target.comment.clone(),
            definition,
        },
    }
}

fn plan_for(snapshot: Option<&CustomTypeDetails>, request: &CustomTypeChangeRequest) -> super::CustomTypePlan {
    plan_custom_type_change(CustomTypeSqlDialect::Postgres, snapshot, request, &all_supported())
}

/// Extract the single-quoted literals from a generated statement.
fn quoted_literals(statement: &str) -> Vec<String> {
    let bytes = statement.as_bytes();
    let mut values = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'\'' {
            index += 1;
            continue;
        }
        let mut value = String::new();
        index += 1;
        while index < bytes.len() {
            if bytes[index] == b'\'' {
                if bytes.get(index + 1) == Some(&b'\'') {
                    value.push('\'');
                    index += 2;
                    continue;
                }
                index += 1;
                break;
            }
            value.push(bytes[index] as char);
            index += 1;
        }
        values.push(value);
    }
    values
}

/// Replay generated enum statements against a simulated label set, asserting
/// that every statement is legal *at the point it runs*.
///
/// This is the property review finding 5 was about: an anchor must already
/// exist, and a rename target must not be occupied. Asserting the exact
/// statement text instead would pass while the statements were still wrong.
fn assert_enum_statements_are_sequentially_valid(existing: &[&str], statements: &[String]) -> Vec<String> {
    const PREFIX: &str = "ALTER TYPE \"app\".\"status\" ";
    let mut labels = existing.iter().map(|value| (*value).to_string()).collect::<Vec<_>>();
    for statement in statements {
        if let Some(rest) = statement.strip_prefix(&format!("{PREFIX}RENAME VALUE ")) {
            let literals = quoted_literals(rest);
            let (from, to) = (literals[0].clone(), literals[1].clone());
            let position = labels
                .iter()
                .position(|label| *label == from)
                .unwrap_or_else(|| panic!("{statement}: {from} does not exist yet"));
            assert!(!labels.contains(&to), "{statement}: {to} is still occupied");
            labels[position] = to;
            continue;
        }
        if let Some(rest) = statement.strip_prefix(&format!("{PREFIX}ADD VALUE ")) {
            let literals = quoted_literals(rest);
            let value = literals[0].clone();
            assert!(!labels.contains(&value), "{statement}: {value} already exists");
            // Position matters: PostgreSQL gives the new label a sort order
            // immediately before/after the anchor, or appends it. Modelling only
            // membership would let a wrong anchor pass.
            let anchor = literals.get(1).cloned();
            let before = rest.contains(" BEFORE ");
            match anchor {
                None => labels.push(value),
                Some(anchor) => {
                    let position = labels
                        .iter()
                        .position(|label| *label == anchor)
                        .unwrap_or_else(|| panic!("{statement}: anchor {anchor} does not exist yet"));
                    labels.insert(if before { position } else { position + 1 }, value);
                }
            }
            continue;
        }
        panic!("unexpected enum statement: {statement}");
    }
    labels
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

#[test]
fn identifiers_and_literals_escape_their_own_quote_character() {
    assert_eq!(super::quote_ident(r#"we"ird"#), r#""we""ird""#);
    assert_eq!(super::quote_literal("it's \"quoted\""), r#"'it''s "quoted"'"#);
    assert_eq!(super::qualified(r#"we"ird"#, r#"ty"pe"#), r#""we""ird"."ty""pe""#);
}

#[test]
fn literals_with_backslashes_use_explicit_escape_strings() {
    for (value, expected) in [
        (r"a\b", r"E'a\\b'"),
        (r"\'; SELECT 1; --", r"E'\\''; SELECT 1; --'"),
        (r"ends\", r"E'ends\\'"),
        (r"two\\slashes", r"E'two\\\\slashes'"),
    ] {
        assert_eq!(super::quote_literal(value), expected);
    }
}

#[test]
fn create_enum_keeps_unicode_and_quote_literals_intact() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: draft(CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "已归档".to_string(), original_value: None },
                CustomTypeEnumValueDraft { value: "it's".to_string(), original_value: None },
            ],
        }),
    };
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements, vec!["CREATE TYPE \"app\".\"status\" AS ENUM ('已归档', 'it''s');"]);
}

#[test]
fn create_domain_names_constraints_and_keeps_expressions_raw() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: CustomTypeDraft {
            schema: "app".to_string(),
            name: "email".to_string(),
            owner: None,
            comment: None,
            definition: CustomTypeDraftDefinition::Domain {
                base_type: "text".to_string(),
                collation: Some("C".to_string()),
                default: Some("''::text".to_string()),
                not_null: true,
                constraints: vec![CustomTypeDomainConstraintDraft {
                    name: "email_valid".to_string(),
                    original_name: None,
                    expression: "CHECK (VALUE ~ '.+@.+')".to_string(),
                    validated: None,
                }],
            },
        },
    };
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements[0],
        "CREATE DOMAIN \"app\".\"email\" AS text\n  COLLATE \"C\"\n  DEFAULT ''::text\n  NOT NULL\n  CONSTRAINT \"email_valid\" CHECK (VALUE ~ '.+@.+');"
    );
}

#[test]
fn domain_escape_strings_preserve_quotes_whitespace_and_wrapping_parentheses() {
    let literal = r"E'it\'s)  (fine; --'";
    assert_eq!(super::canonical_expression(&format!(" {literal}  ||  'x' ")), format!("{literal} || 'x'"),);
    let expression = format!("VALUE <> {literal}");
    let mut snapshot = domain_snapshot();
    snapshot.properties.domain_constraints[0].definition = format!("CHECK ({expression}) NOT VALID");
    snapshot.properties.domain_constraints[0].validated = Some(false);
    let mut request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".into(),
            collation: Some("C".into()),
            default: snapshot.properties.default.clone(),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".into(),
                original_name: Some("email_valid".into()),
                expression: snapshot.properties.domain_constraints[0].definition.clone(),
                validated: Some(false),
            }],
        },
    );
    let unchanged = plan_for(Some(&snapshot), &request);
    assert!(unchanged.blocked_changes.is_empty(), "{:?}", unchanged.blocked_changes);
    assert!(unchanged.statements.is_empty());
    if let CustomTypeDraftDefinition::Domain { default, constraints, .. } = &mut request.draft.definition {
        *default = Some(r"E'it\'s'".into());
        constraints[0].expression = format!("CHECK ({}) NOT VALID", expression.replace("  ", " "));
    }
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert!(plan.destructive, "a whitespace change inside the literal must replace the constraint");
    assert_eq!(
        plan.statements,
        vec![
            r#"ALTER DOMAIN "app"."email" SET DEFAULT E'it\'s';"#,
            r#"ALTER DOMAIN "app"."email" DROP CONSTRAINT "email_valid" RESTRICT;"#,
            r#"ALTER DOMAIN "app"."email" ADD CONSTRAINT "email_valid" CHECK (VALUE <> E'it\'s) (fine; --') NOT VALID;"#,
        ]
    );
}

#[test]
fn create_range_can_name_the_multirange_companion() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: CustomTypeDraft {
            schema: "app".to_string(),
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
    };
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements[0],
        "CREATE TYPE \"app\".\"price_range\" AS RANGE (\n  subtype = numeric,\n  multirange_type_name = \"price_multirange\"\n);"
    );
}

#[test]
fn create_range_multirange_name_is_gated_by_capability() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: CustomTypeDraft {
            schema: "app".to_string(),
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
    };
    let plan = plan_custom_type_change(
        CustomTypeSqlDialect::Postgres,
        None,
        &request,
        &without(CustomTypeOperation::CreateRangeMultirangeName),
    );
    assert!(plan.statements.is_empty());
    assert_eq!(plan.blocked_changes.len(), 1);
    assert_eq!(plan.blocked_changes[0].code, "not_verified");
}

#[test]
fn create_composite_requires_at_least_one_attribute() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: CustomTypeDraft {
            schema: "app".to_string(),
            name: "address".to_string(),
            owner: None,
            comment: None,
            definition: CustomTypeDraftDefinition::Composite { attributes: Vec::new() },
        },
    };
    let plan = plan_for(None, &request);
    assert!(plan.statements.is_empty());
    assert_eq!(plan.blocked_changes[0].code, "composite.no_attributes");
}

#[test]
fn create_blocks_when_the_operation_is_not_verified() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: draft(CustomTypeDraftDefinition::Enum {
            values: vec![CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: None }],
        }),
    };
    let plan = plan_custom_type_change(CustomTypeSqlDialect::Postgres, None, &request, &capabilities(false));
    assert!(plan.statements.is_empty());
    assert_eq!(plan.blocked_changes[0].code, "not_verified");
}

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

#[test]
fn enum_appends_a_value_with_an_after_anchor() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
                CustomTypeEnumValueDraft { value: "archived".to_string(), original_value: None },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements, vec!["ALTER TYPE \"app\".\"status\" ADD VALUE 'archived' AFTER 'published';"]);
}

#[test]
fn enum_inserts_at_the_head_with_a_before_anchor() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "new".to_string(), original_value: None },
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements, vec!["ALTER TYPE \"app\".\"status\" ADD VALUE 'new' BEFORE 'draft';"]);
}

#[test]
fn enum_anchors_consecutive_additions_on_each_other() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft { value: "review".to_string(), original_value: None },
                CustomTypeEnumValueDraft { value: "approved".to_string(), original_value: None },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER TYPE \"app\".\"status\" ADD VALUE 'review' AFTER 'draft';",
            "ALTER TYPE \"app\".\"status\" ADD VALUE 'approved' AFTER 'review';",
        ]
    );
    assert_eq!(plan.transaction_policy, CustomTypeTransactionPolicy::Required);
}

#[test]
fn enum_rename_and_addition_share_one_plan() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "pending".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
                CustomTypeEnumValueDraft { value: "archived".to_string(), original_value: None },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER TYPE \"app\".\"status\" RENAME VALUE 'draft' TO 'pending';",
            "ALTER TYPE \"app\".\"status\" ADD VALUE 'archived' AFTER 'published';",
        ]
    );
}

#[test]
fn enum_removal_is_blocked() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![CustomTypeEnumValueDraft {
                value: "published".to_string(),
                original_value: Some("published".to_string()),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty());
    assert_eq!(plan.blocked_changes[0].code, "enum.remove_value_unsupported");
}

#[test]
fn enum_reordering_existing_values_is_blocked() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("draft".to_string()) },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty());
    assert_eq!(plan.blocked_changes[0].code, "enum.reorder_existing_unsupported");
}

#[test]
fn enum_duplicate_labels_are_blocked() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
                CustomTypeEnumValueDraft { value: "published".to_string(), original_value: None },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty());
    assert_eq!(plan.blocked_changes[0].code, "enum.duplicate_value");
}

#[test]
fn enum_renaming_without_capability_is_blocked() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "pending".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
            ],
        },
    );
    let plan = plan_custom_type_change(
        CustomTypeSqlDialect::Postgres,
        Some(&snapshot),
        &request,
        &without(CustomTypeOperation::AlterEnumRenameValue),
    );
    assert!(plan.statements.is_empty());
    assert_eq!(plan.blocked_changes[0].code, "not_verified");
}

#[test]
fn enum_add_value_outside_a_transaction_refuses_multi_statement_plans() {
    let snapshot = enum_snapshot();
    let mut request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
                CustomTypeEnumValueDraft { value: "archived".to_string(), original_value: None },
            ],
        },
    );
    let capabilities = without(CustomTypeOperation::AlterEnumAddValueInTransaction);

    // Adding a value on its own stays a single autocommit statement, which is
    // exactly what a kernel that refuses ADD VALUE in a transaction supports.
    let single = plan_custom_type_change(CustomTypeSqlDialect::Postgres, Some(&snapshot), &request, &capabilities);
    assert!(single.blocked_changes.is_empty(), "{:?}", single.blocked_changes);
    assert_eq!(single.transaction_policy, CustomTypeTransactionPolicy::Autocommit);

    // Combining it with a comment change cannot be made atomic, so the plan is
    // refused instead of silently applying half of it.
    request.draft.comment = Some("changed".to_string());
    let combined = plan_custom_type_change(CustomTypeSqlDialect::Postgres, Some(&snapshot), &request, &capabilities);
    assert!(combined.blocked_changes.iter().any(|issue| issue.code == "enum.add_value_requires_autocommit"));
    assert_eq!(combined.transaction_policy, CustomTypeTransactionPolicy::Autocommit);
}

#[test]
fn single_statement_plan_runs_without_an_explicit_transaction() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
                CustomTypeEnumValueDraft { value: "archived".to_string(), original_value: None },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert_eq!(plan.transaction_policy, CustomTypeTransactionPolicy::Autocommit);
}

#[test]
fn multi_statement_plan_is_refused_when_the_backend_cannot_roll_ddl_back() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "pending".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
                CustomTypeEnumValueDraft { value: "archived".to_string(), original_value: None },
            ],
        },
    );
    let plan = plan_custom_type_change(
        CustomTypeSqlDialect::Postgres,
        Some(&snapshot),
        &request,
        &without(CustomTypeOperation::TransactionalDdl),
    );
    assert!(plan.blocked_changes.iter().any(|issue| issue.code == "transaction_unsupported"));
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

#[test]
fn composite_adds_renames_alters_and_drops_in_identity_order() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![
                CustomTypeAttributeDraft {
                    name: "city_name".to_string(),
                    original_name: Some("city".to_string()),
                    data_type: "text".to_string(),
                    comment: Some("city name".to_string()),
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
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER TYPE \"app\".\"address\" RENAME ATTRIBUTE \"city\" TO \"city_name\" RESTRICT;",
            "ALTER TYPE \"app\".\"address\" ALTER ATTRIBUTE \"zip\" SET DATA TYPE varchar(12) RESTRICT;",
            "ALTER TYPE \"app\".\"address\" ADD ATTRIBUTE \"country\" text RESTRICT;",
        ]
    );
}

#[test]
fn composite_attribute_comment_change_uses_the_final_attribute_name() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
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
                    data_type: "numeric(6)".to_string(),
                    comment: None,
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER TYPE \"app\".\"address\" RENAME ATTRIBUTE \"city\" TO \"town\" RESTRICT;",
            "COMMENT ON COLUMN \"app\".\"address\".\"town\" IS 'town name';",
        ]
    );
}

#[test]
fn composite_unchanged_attributes_produce_no_statements() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![
                CustomTypeAttributeDraft {
                    name: "city".to_string(),
                    original_name: Some("city".to_string()),
                    data_type: "text".to_string(),
                    comment: Some("city name".to_string()),
                },
                CustomTypeAttributeDraft {
                    name: "zip".to_string(),
                    original_name: Some("zip".to_string()),
                    data_type: "numeric(6)".to_string(),
                    comment: None,
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
}

#[test]
fn composite_dropping_an_attribute_is_destructive() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![CustomTypeAttributeDraft {
                name: "city".to_string(),
                original_name: Some("city".to_string()),
                data_type: "text".to_string(),
                comment: Some("city name".to_string()),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert!(plan.destructive);
    assert_eq!(plan.statements, vec!["ALTER TYPE \"app\".\"address\" DROP ATTRIBUTE \"zip\" RESTRICT;"]);
    assert!(plan.warnings.iter().any(|issue| issue.severity == CustomTypePlanIssueSeverity::Destructive));
}

#[test]
fn composite_drop_then_reuse_of_the_freed_name_is_ordered_correctly() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![
                CustomTypeAttributeDraft {
                    name: "zip".to_string(),
                    original_name: Some("city".to_string()),
                    data_type: "text".to_string(),
                    // Keeping the comment unchanged keeps this test focused on
                    // statement ordering; comment diffing has its own test.
                    comment: Some("city name".to_string()),
                },
                CustomTypeAttributeDraft {
                    name: "city".to_string(),
                    original_name: None,
                    data_type: "text".to_string(),
                    comment: None,
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER TYPE \"app\".\"address\" DROP ATTRIBUTE \"zip\" RESTRICT;",
            "ALTER TYPE \"app\".\"address\" RENAME ATTRIBUTE \"city\" TO \"zip\" RESTRICT;",
            "ALTER TYPE \"app\".\"address\" ADD ATTRIBUTE \"city\" text RESTRICT;",
        ]
    );
}

#[test]
fn composite_clearing_an_attribute_comment_emits_is_null() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![
                CustomTypeAttributeDraft {
                    name: "city".to_string(),
                    original_name: Some("city".to_string()),
                    data_type: "text".to_string(),
                    comment: None,
                },
                CustomTypeAttributeDraft {
                    name: "zip".to_string(),
                    original_name: Some("zip".to_string()),
                    data_type: "numeric(6)".to_string(),
                    comment: None,
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements, vec!["COMMENT ON COLUMN \"app\".\"address\".\"city\" IS NULL;"]);
}

#[test]
fn composite_duplicate_names_are_blocked() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![
                CustomTypeAttributeDraft {
                    name: "a".to_string(),
                    original_name: None,
                    data_type: "text".to_string(),
                    comment: None,
                },
                CustomTypeAttributeDraft {
                    name: "a".to_string(),
                    original_name: None,
                    data_type: "text".to_string(),
                    comment: None,
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty());
    assert_eq!(plan.blocked_changes[0].code, "composite.invalid_attributes");
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

#[test]
fn domain_default_and_not_null_changes_are_planned_in_order() {
    let snapshot = domain_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("'unknown@example.com'::text".to_string()),
            not_null: true,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "CHECK ((VALUE <> ''::text))".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER DOMAIN \"app\".\"email\" SET DEFAULT 'unknown@example.com'::text;",
            "ALTER DOMAIN \"app\".\"email\" SET NOT NULL;",
        ]
    );
}

#[test]
fn domain_dropping_the_default_uses_drop_default() {
    let snapshot = domain_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: None,
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "CHECK ((VALUE <> ''::text))".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements, vec!["ALTER DOMAIN \"app\".\"email\" DROP DEFAULT;"]);
}

#[test]
fn domain_unchanged_definition_produces_no_statements() {
    let snapshot = domain_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "CHECK ((VALUE <> ''::text))".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
}

#[test]
fn domain_constraint_rename_and_expression_change_are_distinguished() {
    let snapshot = domain_snapshot();
    let renamed = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_format".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "CHECK ((VALUE <> ''::text))".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &renamed);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec!["ALTER DOMAIN \"app\".\"email\" RENAME CONSTRAINT \"email_valid\" TO \"email_format\";"]
    );

    let rewritten = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "VALUE ~ '.+@.+'".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &rewritten);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert!(plan.destructive);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER DOMAIN \"app\".\"email\" DROP CONSTRAINT \"email_valid\" RESTRICT;",
            "ALTER DOMAIN \"app\".\"email\" ADD CONSTRAINT \"email_valid\" CHECK (VALUE ~ '.+@.+');",
        ]
    );
}

#[test]
fn a_renamed_constraint_with_a_new_body_is_dropped_and_re_added_once() {
    // Regression: renaming a constraint *and* rewriting its body must not emit a
    // rename plus a drop of the old name; by the time the drop ran, the old name
    // would already be gone.
    let snapshot = domain_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_format".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "VALUE ~ '.+@.+'".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER DOMAIN \"app\".\"email\" DROP CONSTRAINT \"email_valid\" RESTRICT;",
            "ALTER DOMAIN \"app\".\"email\" ADD CONSTRAINT \"email_format\" CHECK (VALUE ~ '.+@.+');",
        ]
    );
    // Exactly one drop and one add: no stray rename statement.
    assert_eq!(plan.statements.iter().filter(|s| s.contains("RENAME CONSTRAINT")).count(), 0);
    assert_eq!(plan.statements.iter().filter(|s| s.contains("DROP CONSTRAINT")).count(), 1);
    assert_eq!(plan.statements.iter().filter(|s| s.contains("ADD CONSTRAINT")).count(), 1);
}

#[test]
fn domain_base_type_and_collation_changes_are_blocked() {
    let snapshot = domain_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "citext".to_string(),
            collation: Some("en_US".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: Vec::new(),
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    let codes = plan.blocked_changes.iter().map(|issue| issue.code.as_str()).collect::<Vec<_>>();
    assert!(codes.contains(&"domain.base_type_immutable"), "{codes:?}");
    assert!(codes.contains(&"domain.collation_immutable"), "{codes:?}");
}

#[test]
fn domain_validate_constraint_only_fires_when_the_catalog_says_invalid() {
    let mut snapshot = domain_snapshot();
    snapshot.properties.domain_constraints[0].validated = Some(false);
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "CHECK ((VALUE <> ''::text))".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements, vec!["ALTER DOMAIN \"app\".\"email\" VALIDATE CONSTRAINT \"email_valid\";"]);
}

// ---------------------------------------------------------------------------
// Range and general properties
// ---------------------------------------------------------------------------

#[test]
fn range_definition_changes_are_blocked_but_rename_still_works() {
    let snapshot = range_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Range {
            subtype: "integer".to_string(),
            subtype_opclass: None,
            canonical_function: None,
            subtype_diff_function: None,
            multirange_name: None,
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.iter().any(|issue| issue.code == "range.definition_immutable"));

    let mut renamed = request.clone();
    renamed.draft.name = "money_range".to_string();
    renamed.draft.definition = CustomTypeDraftDefinition::Range {
        subtype: "numeric".to_string(),
        subtype_opclass: Some("pg_catalog.numeric_ops".to_string()),
        canonical_function: None,
        subtype_diff_function: None,
        multirange_name: None,
    };
    let plan = plan_for(Some(&snapshot), &renamed);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements, vec!["ALTER TYPE \"app\".\"price_range\" RENAME TO \"money_range\";"]);
    assert_eq!(plan.resulting_identity.name, "money_range");
}

#[test]
fn rename_schema_and_comment_follow_structure_changes_with_owner_last() {
    let snapshot = enum_snapshot();
    let mut request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
                CustomTypeEnumValueDraft { value: "archived".to_string(), original_value: None },
            ],
        },
    );
    request.draft.name = "order_status".to_string();
    request.draft.schema = "shared".to_string();
    request.draft.owner = Some("app_owner2".to_string());
    request.draft.comment = Some("updated".to_string());
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER TYPE \"app\".\"status\" ADD VALUE 'archived' AFTER 'published';",
            "ALTER TYPE \"app\".\"status\" RENAME TO \"order_status\";",
            "ALTER TYPE \"app\".\"order_status\" SET SCHEMA \"shared\";",
            "COMMENT ON TYPE \"shared\".\"order_status\" IS 'updated';",
            "ALTER TYPE \"shared\".\"order_status\" OWNER TO \"app_owner2\";",
        ]
    );
    assert_eq!(plan.resulting_identity.schema, "shared");
    assert_eq!(plan.resulting_identity.name, "order_status");
}

#[test]
fn type_kind_cannot_change() {
    let snapshot = enum_snapshot();
    let mut request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![CustomTypeAttributeDraft {
                name: "a".to_string(),
                original_name: None,
                data_type: "text".to_string(),
                comment: None,
            }],
        },
    );
    request.target =
        Some(CustomTypeIdentity { schema: "app".to_string(), name: "status".to_string(), kind: CustomTypeKind::Enum });
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.iter().any(|issue| issue.code == "type.kind_immutable"));
    assert!(plan.statements.is_empty());
}

#[test]
fn missing_name_and_schema_are_blocked() {
    let mut request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: draft(CustomTypeDraftDefinition::Enum {
            values: vec![CustomTypeEnumValueDraft { value: "a".to_string(), original_value: None }],
        }),
    };
    request.draft.name = "   ".to_string();
    request.draft.schema = String::new();
    let plan = plan_for(None, &request);
    let codes = plan.blocked_changes.iter().map(|issue| issue.code.as_str()).collect::<Vec<_>>();
    assert!(codes.contains(&"identity.name_required"), "{codes:?}");
    assert!(codes.contains(&"identity.schema_required"), "{codes:?}");
}

#[test]
fn create_applies_comment_and_owner_against_the_new_identity() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: CustomTypeDraft {
            schema: "app".to_string(),
            name: "status".to_string(),
            owner: Some("app_owner".to_string()),
            comment: Some("order status".to_string()),
            definition: CustomTypeDraftDefinition::Enum {
                values: vec![CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: None }],
            },
        },
    };
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "CREATE TYPE \"app\".\"status\" AS ENUM ('draft');",
            "COMMENT ON TYPE \"app\".\"status\" IS 'order status';",
            "ALTER TYPE \"app\".\"status\" OWNER TO \"app_owner\";",
        ]
    );
}

#[test]
fn identical_input_produces_byte_identical_output() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![
                CustomTypeAttributeDraft {
                    name: "city_name".to_string(),
                    original_name: Some("city".to_string()),
                    data_type: "text".to_string(),
                    comment: Some("city name".to_string()),
                },
                CustomTypeAttributeDraft {
                    name: "zip".to_string(),
                    original_name: Some("zip".to_string()),
                    data_type: "varchar(12)".to_string(),
                    comment: None,
                },
            ],
        },
    );
    let first = plan_for(Some(&snapshot), &request);
    let second = plan_for(Some(&snapshot), &request);
    assert_eq!(first.statements, second.statements);
    assert_eq!(first.transaction_policy, second.transaction_policy);
}

// ---------------------------------------------------------------------------
// Drop
// ---------------------------------------------------------------------------

#[test]
fn drop_uses_domain_for_domains_and_restrict_by_default() {
    let snapshot = domain_snapshot();
    let preview = plan_custom_type_drop(
        CustomTypeSqlDialect::Postgres,
        &CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: "app".to_string(),
                name: "email".to_string(),
                kind: CustomTypeKind::Domain,
            },
            cascade: false,
        },
        &all_supported(),
    );
    assert_eq!(preview.statement, "DROP DOMAIN \"app\".\"email\" RESTRICT;");
    assert!(preview.blocked_changes.is_empty());
    let _ = snapshot;
}

#[test]
fn drop_cascade_is_gated_and_spelled_out() {
    let preview = plan_custom_type_drop(
        CustomTypeSqlDialect::Postgres,
        &CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: "app".to_string(),
                name: "status".to_string(),
                kind: CustomTypeKind::Enum,
            },
            cascade: true,
        },
        &all_supported(),
    );
    assert_eq!(preview.statement, "DROP TYPE \"app\".\"status\" CASCADE;");
}

#[test]
fn multirange_cannot_be_dropped_on_its_own() {
    let preview = plan_custom_type_drop(
        CustomTypeSqlDialect::Postgres,
        &CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: "app".to_string(),
                name: "_price_range".to_string(),
                kind: CustomTypeKind::Multirange,
            },
            cascade: true,
        },
        &all_supported(),
    );
    assert_eq!(preview.blocked_changes[0].code, "drop.multirange_companion");
}

#[test]
fn drop_blocks_when_the_operation_is_not_verified() {
    let preview = plan_custom_type_drop(
        CustomTypeSqlDialect::Postgres,
        &CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: "app".to_string(),
                name: "status".to_string(),
                kind: CustomTypeKind::Enum,
            },
            cascade: false,
        },
        &capabilities(false),
    );
    assert_eq!(preview.blocked_changes[0].code, "not_verified");
}

// ---------------------------------------------------------------------------
// Fragment injection (review finding 1)
// ---------------------------------------------------------------------------

#[test]
fn a_default_value_cannot_smuggle_a_second_statement() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: CustomTypeDraft {
            schema: "app".to_string(),
            name: "email".to_string(),
            owner: None,
            comment: None,
            definition: CustomTypeDraftDefinition::Domain {
                base_type: "text".to_string(),
                collation: None,
                default: Some("0; DROP TABLE app.orders; --".to_string()),
                not_null: false,
                constraints: Vec::new(),
            },
        },
    };
    let plan = plan_for(None, &request);
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
    assert_eq!(plan.blocked_changes[0].code, "fragment.invalid_expression");
}

#[test]
fn every_expression_field_rejects_a_statement_terminator() {
    let cases: Vec<(&str, CustomTypeDraftDefinition)> = vec![
        (
            "domain base type",
            CustomTypeDraftDefinition::Domain {
                base_type: "text; DROP TABLE t".to_string(),
                collation: None,
                default: None,
                not_null: false,
                constraints: Vec::new(),
            },
        ),
        (
            "domain collation",
            CustomTypeDraftDefinition::Domain {
                base_type: "text".to_string(),
                collation: Some("C; DROP TABLE t".to_string()),
                default: None,
                not_null: false,
                constraints: Vec::new(),
            },
        ),
        (
            "domain check expression",
            CustomTypeDraftDefinition::Domain {
                base_type: "text".to_string(),
                collation: None,
                default: None,
                not_null: false,
                constraints: vec![CustomTypeDomainConstraintDraft {
                    name: "c".to_string(),
                    original_name: None,
                    expression: "VALUE <> ''; DROP TABLE t".to_string(),
                    validated: None,
                }],
            },
        ),
        (
            "composite attribute type",
            CustomTypeDraftDefinition::Composite {
                attributes: vec![CustomTypeAttributeDraft {
                    name: "a".to_string(),
                    original_name: None,
                    data_type: "text; DROP TABLE t".to_string(),
                    comment: None,
                }],
            },
        ),
        (
            "range subtype",
            CustomTypeDraftDefinition::Range {
                subtype: "numeric; DROP TABLE t".to_string(),
                subtype_opclass: None,
                canonical_function: None,
                subtype_diff_function: None,
                multirange_name: None,
            },
        ),
        (
            "range canonical function",
            CustomTypeDraftDefinition::Range {
                subtype: "numeric".to_string(),
                subtype_opclass: None,
                canonical_function: Some("f(); DROP TABLE t".to_string()),
                subtype_diff_function: None,
                multirange_name: None,
            },
        ),
    ];
    for (label, definition) in cases {
        let request = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: "app".to_string(),
                name: "thing".to_string(),
                owner: None,
                comment: None,
                definition,
            },
        };
        let plan = plan_for(None, &request);
        assert!(plan.statements.is_empty(), "{label} produced {:?}", plan.statements);
        assert!(
            plan.blocked_changes.iter().any(|issue| issue.code.starts_with("fragment.")),
            "{label}: {:?}",
            plan.blocked_changes
        );
    }
}

#[test]
fn an_edit_field_cannot_smuggle_a_second_statement_either() {
    let snapshot = domain_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("'x'; DROP TABLE app.orders; --".to_string()),
            not_null: false,
            constraints: Vec::new(),
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
    assert_eq!(plan.blocked_changes[0].code, "fragment.invalid_expression");
}

#[test]
fn an_expression_may_still_contain_a_terminator_inside_a_literal() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: CustomTypeDraft {
            schema: "app".to_string(),
            name: "email".to_string(),
            owner: None,
            comment: None,
            definition: CustomTypeDraftDefinition::Domain {
                base_type: "text".to_string(),
                collation: None,
                default: Some("'a;b'::text".to_string()),
                not_null: false,
                constraints: Vec::new(),
            },
        },
    };
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert!(plan.statements[0].contains("'a;b'::text"), "{:?}", plan.statements);
}

// ---------------------------------------------------------------------------
// Expression emission preserves literal contents (review finding 2)
// ---------------------------------------------------------------------------

#[test]
fn a_check_expression_keeps_whitespace_inside_its_string_literals() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: CustomTypeDraft {
            schema: "app".to_string(),
            name: "email".to_string(),
            owner: None,
            comment: None,
            definition: CustomTypeDraftDefinition::Domain {
                base_type: "text".to_string(),
                collation: None,
                default: None,
                not_null: false,
                constraints: vec![CustomTypeDomainConstraintDraft {
                    name: "no_double_space".to_string(),
                    original_name: None,
                    expression: "VALUE <> 'a  b'".to_string(),
                    validated: None,
                }],
            },
        },
    };
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    // Exactly two spaces: collapsing them would change the constraint's meaning.
    assert!(plan.statements[0].contains("VALUE <> 'a  b'"), "{}", plan.statements[0]);
}

#[test]
fn replacing_a_constraint_keeps_the_literal_whitespace_the_user_typed() {
    let snapshot = domain_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "VALUE <> 'a  b'".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    let added = plan.statements.last().expect("an add statement");
    assert!(added.contains("VALUE <> 'a  b'"), "{added}");
}

#[test]
fn an_unchanged_constraint_is_still_detected_as_unchanged_despite_literal_spacing() {
    // The catalog renders the expression with different outer parentheses than a
    // user would type; comparison has to see through that without rewriting the
    // literal that is actually stored.
    let snapshot = domain_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "CHECK ((VALUE <> ''::text))".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
}

#[test]
fn a_whitespace_only_difference_inside_a_literal_is_a_real_change() {
    let mut snapshot = domain_snapshot();
    snapshot.properties.domain_constraints[0].definition = "CHECK ((VALUE <> 'a b'::text))".to_string();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "CHECK ((VALUE <> 'a  b'::text))".to_string(),
                validated: Some(true),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert!(!plan.statements.is_empty(), "the literal change must be planned");
}

// ---------------------------------------------------------------------------
// Rename ordering (review finding 5)
// ---------------------------------------------------------------------------

#[test]
fn an_added_enum_value_anchors_on_a_label_that_exists_at_that_point() {
    let snapshot = enum_snapshot();
    // Insert before a value that is itself being renamed in the same plan.
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "new".to_string(), original_value: None },
                CustomTypeEnumValueDraft { value: "renamed".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    // The rename must be emitted first: the anchor `draft` still exists at that
    // point, whereas `renamed` only exists after the rename.
    let final_labels = assert_enum_statements_are_sequentially_valid(&["draft", "published"], &plan.statements);
    assert_eq!(final_labels, vec!["new", "renamed", "published"]);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER TYPE \"app\".\"status\" RENAME VALUE 'draft' TO 'renamed';",
            "ALTER TYPE \"app\".\"status\" ADD VALUE 'new' BEFORE 'renamed';",
        ]
    );
}

#[test]
fn swapping_two_enum_labels_routes_through_a_temporary_name() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "published".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("published".to_string()) },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    let final_labels = assert_enum_statements_are_sequentially_valid(&["draft", "published"], &plan.statements);
    assert_eq!(final_labels, vec!["published", "draft"]);
    // A pure swap cannot be done without routing one label through a free name.
    assert_eq!(plan.statements.len(), 3, "{:?}", plan.statements);
    assert!(plan.statements[0].contains("RENAME VALUE 'draft' TO 'dbx_tmp_rename_"), "{:?}", plan.statements);
}

#[test]
fn a_rename_chain_runs_in_reverse_dependency_order() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "x".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: Some("published".to_string()) },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    // `draft -> x` has to run first: `published -> draft` needs `draft` free.
    let final_labels = assert_enum_statements_are_sequentially_valid(&["draft", "published"], &plan.statements);
    assert_eq!(final_labels, vec!["x", "draft"]);
    assert_eq!(
        plan.statements.first().map(String::as_str),
        Some("ALTER TYPE \"app\".\"status\" RENAME VALUE 'draft' TO 'x';")
    );
}

#[test]
fn renaming_onto_a_label_owned_by_a_value_that_stays_is_blocked() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { value: "published".to_string(), original_value: Some("draft".to_string()) },
                CustomTypeEnumValueDraft {
                    value: "published".to_string(),
                    original_value: Some("published".to_string()),
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    // Either it is reported as a rename conflict or as a duplicate label; both
    // refuse the plan, which is the point.
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
    assert!(!plan.blocked_changes.is_empty());
}

#[test]
fn swapping_two_composite_attributes_is_ordered_correctly() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![
                CustomTypeAttributeDraft {
                    name: "zip".to_string(),
                    original_name: Some("city".to_string()),
                    data_type: "text".to_string(),
                    comment: Some("city name".to_string()),
                },
                CustomTypeAttributeDraft {
                    name: "city".to_string(),
                    original_name: Some("zip".to_string()),
                    data_type: "numeric(6)".to_string(),
                    comment: None,
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements.len(), 3, "{:?}", plan.statements);
    assert!(plan.statements[0].contains("TO \"dbx_tmp_rename_"), "{:?}", plan.statements);
    // The last step completes the routed rename onto the final requested name.
    assert!(plan.statements[2].contains("TO \"zip\""), "{:?}", plan.statements);
}

#[test]
fn swapping_two_domain_constraint_names_is_ordered_correctly() {
    let mut snapshot = domain_snapshot();
    snapshot.properties.domain_constraints = vec![
        CustomTypeDomainConstraint {
            name: "a".to_string(),
            definition: "CHECK ((VALUE <> ''::text))".to_string(),
            validated: Some(true),
        },
        CustomTypeDomainConstraint {
            name: "b".to_string(),
            definition: "CHECK ((VALUE <> ''::text))".to_string(),
            validated: Some(true),
        },
    ];
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![
                CustomTypeDomainConstraintDraft {
                    name: "b".to_string(),
                    original_name: Some("a".to_string()),
                    expression: "CHECK ((VALUE <> ''::text))".to_string(),
                    validated: Some(true),
                },
                CustomTypeDomainConstraintDraft {
                    name: "a".to_string(),
                    original_name: Some("b".to_string()),
                    expression: "CHECK ((VALUE <> ''::text))".to_string(),
                    validated: Some(true),
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements.len(), 3, "{:?}", plan.statements);
    assert!(plan.statements[0].contains("TO \"dbx_tmp_rename_"), "{:?}", plan.statements);
}

// ---------------------------------------------------------------------------
// Domain constraint validation direction (review finding 8)
// ---------------------------------------------------------------------------

#[test]
fn un_validating_a_constraint_is_blocked_instead_of_silently_ignored() {
    let mut snapshot = domain_snapshot();
    snapshot.properties.domain_constraints[0].validated = Some(true);
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".to_string(),
                original_name: Some("email_valid".to_string()),
                expression: "CHECK ((VALUE <> ''::text))".to_string(),
                validated: Some(false),
            }],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
    assert_eq!(plan.blocked_changes[0].code, "domain.unvalidate_constraint_unsupported");
}

// ---------------------------------------------------------------------------
// Kinds with no structured editor (review finding 6)
// ---------------------------------------------------------------------------

fn none_draft(kind: CustomTypeKind) -> CustomTypeDraft {
    CustomTypeDraft {
        schema: "app".to_string(),
        name: "amount_t".to_string(),
        owner: None,
        comment: None,
        definition: CustomTypeDraftDefinition::None { type_kind: kind },
    }
}

#[test]
fn a_base_type_can_be_renamed_and_commented() {
    let mut snapshot = range_snapshot();
    snapshot.kind = CustomTypeKind::Base;
    snapshot.name = "amount_t".to_string();
    snapshot.properties = CustomTypeProperties::default();
    let mut request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: Some(CustomTypeIdentity {
            schema: "app".to_string(),
            name: "amount_t".to_string(),
            kind: CustomTypeKind::Base,
        }),
        draft: none_draft(CustomTypeKind::Base),
    };
    request.draft.name = "money_t".to_string();
    request.draft.comment = Some("money".to_string());
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER TYPE \"app\".\"amount_t\" RENAME TO \"money_t\";",
            "COMMENT ON TYPE \"app\".\"money_t\" IS 'money';",
        ]
    );
    assert_eq!(plan.resulting_identity.kind, CustomTypeKind::Base);
}

#[test]
fn a_base_type_cannot_be_created_from_the_designer() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: none_draft(CustomTypeKind::Base),
    };
    let plan = plan_for(None, &request);
    assert!(plan.statements.is_empty());
    assert_eq!(plan.blocked_changes[0].code, "create.kind_unsupported");
}

#[test]
fn a_multirange_cannot_be_renamed_or_moved() {
    let mut snapshot = range_snapshot();
    snapshot.kind = CustomTypeKind::Multirange;
    snapshot.name = "_price_range".to_string();
    let mut request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: Some(CustomTypeIdentity {
            schema: "app".to_string(),
            name: "_price_range".to_string(),
            kind: CustomTypeKind::Multirange,
        }),
        draft: none_draft(CustomTypeKind::Multirange),
    };
    request.draft.name = "renamed_multirange".to_string();
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
    assert_eq!(plan.blocked_changes[0].code, "multirange.rename_unsupported");

    // Its comment is still editable.
    let mut comment_only = request.clone();
    comment_only.draft.name = "_price_range".to_string();
    comment_only.draft.comment = Some("prices".to_string());
    let plan = plan_for(Some(&snapshot), &comment_only);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements, vec!["COMMENT ON TYPE \"app\".\"_price_range\" IS 'prices';"]);
}

#[test]
fn composite_swap_followed_by_type_and_comment_changes_uses_final_names() {
    let snapshot = composite_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: vec![
                // original city becomes zip and changes both type and comment
                CustomTypeAttributeDraft {
                    name: "zip".to_string(),
                    original_name: Some("city".to_string()),
                    data_type: "varchar(80)".to_string(),
                    comment: Some("postal city".to_string()),
                },
                // original zip becomes city
                CustomTypeAttributeDraft {
                    name: "city".to_string(),
                    original_name: Some("zip".to_string()),
                    data_type: "numeric(6)".to_string(),
                    comment: None,
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements.iter().filter(|sql| sql.contains("RENAME ATTRIBUTE")).count(), 3);
    let alter = plan.statements.iter().find(|sql| sql.contains("ALTER ATTRIBUTE")).expect("type change after the swap");
    assert!(alter.contains("ALTER ATTRIBUTE \"zip\""), "{alter}");
    assert!(!alter.contains("dbx_tmp_rename"), "{alter}");
    let comment = plan
        .statements
        .iter()
        .find(|sql| sql.contains("COMMENT ON COLUMN") && sql.contains("postal city"))
        .expect("comment change after the swap");
    assert!(comment.contains(".\"zip\" IS"), "{comment}");
    assert!(!comment.contains("dbx_tmp_rename"), "{comment}");
}

#[test]
fn domain_constraint_swap_followed_by_validate_uses_the_final_name() {
    let mut snapshot = domain_snapshot();
    snapshot.properties.domain_constraints = vec![
        CustomTypeDomainConstraint {
            name: "a".to_string(),
            definition: "CHECK ((VALUE <> ''::text))".to_string(),
            validated: Some(false),
        },
        CustomTypeDomainConstraint {
            name: "b".to_string(),
            definition: "CHECK ((VALUE <> ''::text))".to_string(),
            validated: Some(true),
        },
    ];
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".to_string(),
            collation: Some("C".to_string()),
            default: Some("''::text".to_string()),
            not_null: false,
            constraints: vec![
                CustomTypeDomainConstraintDraft {
                    name: "b".to_string(),
                    original_name: Some("a".to_string()),
                    expression: "CHECK ((VALUE <> ''::text))".to_string(),
                    validated: Some(true),
                },
                CustomTypeDomainConstraintDraft {
                    name: "a".to_string(),
                    original_name: Some("b".to_string()),
                    expression: "CHECK ((VALUE <> ''::text))".to_string(),
                    validated: Some(true),
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements.iter().filter(|sql| sql.contains("RENAME CONSTRAINT")).count(), 3);
    let validate =
        plan.statements.iter().find(|sql| sql.contains("VALIDATE CONSTRAINT")).expect("validation after the swap");
    assert!(validate.contains("VALIDATE CONSTRAINT \"b\""), "{validate}");
    assert!(!validate.contains("dbx_tmp_rename"), "{validate}");
}

#[test]
fn type_fragments_cannot_add_actions_columns_or_range_options() {
    for fragment in ["text, DROP ATTRIBUTE zip", "text CASCADE", "text, extra text", "numeric, subtype_diff = evil"] {
        assert!(super::validate_fragment(super::FragmentKind::TypeExpression, "type", fragment).is_err(), "{fragment}");
    }
    for fragment in
        ["numeric(18, 4)", "timestamp(3) with time zone", "double precision", "\"app\".\"A, B\"[]", "integer[][]"]
    {
        assert!(super::validate_fragment(super::FragmentKind::TypeExpression, "type", fragment).is_ok(), "{fragment}");
    }
    assert!(super::validate_fragment(super::FragmentKind::ValueExpression, "default", "0 CHECK (false)").is_err());
    assert!(super::validate_fragment(super::FragmentKind::ValueExpression, "default", "coalesce(NULL, 1)").is_ok());

    let snapshot = composite_snapshot();
    for original_name in [None, Some("city".to_string())] {
        let request = edit_request(
            &snapshot,
            CustomTypeDraftDefinition::Composite {
                attributes: vec![CustomTypeAttributeDraft {
                    name: "city".to_string(),
                    original_name,
                    data_type: "text, DROP ATTRIBUTE zip".to_string(),
                    comment: None,
                }],
            },
        );
        let plan = plan_for(Some(&snapshot), &request);
        assert!(plan.is_blocked());
        assert!(plan.statements.is_empty());
    }
}

#[test]
fn domain_unicode_check_and_qualified_collation_preserve_sql() {
    for (collation, expected) in
        [("pg_catalog.\"C\"", "\"pg_catalog\".\"C\""), ("\"C\"", "\"C\""), ("\"a.b\".\"c\"\"d\"", "\"a.b\".\"c\"\"d\"")]
    {
        let request = CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: draft(CustomTypeDraftDefinition::Domain {
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
            }),
        };
        let plan = plan_for(None, &request);
        assert!(!plan.is_blocked(), "{:?}", plan.blocked_changes);
        assert!(plan.statements[0].contains(&format!("COLLATE {expected}\n")), "{:?}", plan.statements);
        assert!(plan.statements[0].contains("CHECK ('中文' <> VALUE)"));
    }
    for expression in ["'中文' <> VALUE", "'😀' <> VALUE", "检查(VALUE)"] {
        assert_eq!(super::canonical_check_expression(expression), expression);
    }
}

#[test]
fn enum_can_reuse_a_label_freed_by_a_rename() {
    let snapshot = enum_snapshot();
    let request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Enum {
            values: vec![
                CustomTypeEnumValueDraft { original_value: Some("draft".to_string()), value: "pending".to_string() },
                CustomTypeEnumValueDraft { original_value: None, value: "draft".to_string() },
                CustomTypeEnumValueDraft {
                    original_value: Some("published".to_string()),
                    value: "published".to_string(),
                },
            ],
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(!plan.is_blocked(), "{:?}", plan.blocked_changes);
    assert_eq!(
        assert_enum_statements_are_sequentially_valid(&["draft", "published"], &plan.statements),
        vec!["pending", "draft", "published"]
    );
}

#[test]
fn create_not_valid_domain_constraints_uses_an_atomic_alter() {
    let request = CustomTypeChangeRequest {
        expected_snapshot_revision: None,
        target: None,
        draft: draft(CustomTypeDraftDefinition::Domain {
            base_type: "integer".into(),
            collation: None,
            default: None,
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "positive".into(),
                original_name: None,
                expression: "VALUE > 0".into(),
                validated: Some(false),
            }],
        }),
    };
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty());
    assert_eq!(plan.transaction_policy, CustomTypeTransactionPolicy::Required);
    assert_eq!(
        plan.statements,
        [
            "CREATE DOMAIN \"app\".\"status\" AS integer;",
            "ALTER DOMAIN \"app\".\"status\" ADD CONSTRAINT \"positive\" CHECK (VALUE > 0) NOT VALID;",
        ]
    );
    let mut caps = all_supported();
    caps.operations.insert(
        CustomTypeOperation::TransactionalDdl,
        CustomTypeOperationCapability::unsupported("no_transaction", "unavailable"),
    );
    assert!(plan_custom_type_change(CustomTypeSqlDialect::Postgres, None, &request, &caps).is_blocked());
}

#[test]
fn check_catalog_not_valid_suffix_is_outside_the_expression() {
    assert_eq!(super::postgres::check_body("CHECK ((VALUE > 1)) NOT VALID"), "(VALUE > 1)");
    assert_eq!(super::postgres::check_body("check (VALUE <> 'NOT VALID') not  valid"), "VALUE <> 'NOT VALID'");
    assert_eq!(super::postgres::check_body("VALUE <> 'NOT VALID'"), "VALUE <> 'NOT VALID'");
    let mut snapshot = domain_snapshot();
    snapshot.properties.domain_constraints[0].definition = "CHECK (VALUE <> 'a  b') NOT VALID".into();
    snapshot.properties.domain_constraints[0].validated = Some(false);
    let mut request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".into(),
            collation: Some("C".into()),
            default: Some("''::text".into()),
            not_null: false,
            constraints: vec![CustomTypeDomainConstraintDraft {
                name: "email_valid".into(),
                original_name: Some("email_valid".into()),
                expression: "CHECK (VALUE <> 'a  b') NOT VALID".into(),
                validated: Some(false),
            }],
        },
    );
    assert!(plan_for(Some(&snapshot), &request).statements.is_empty());
    if let CustomTypeDraftDefinition::Domain { constraints, .. } = &mut request.draft.definition {
        constraints[0].expression = "CHECK (VALUE <> 'b  c') NOT VALID".into();
    }
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty());
    assert_eq!(
        plan.statements[1],
        "ALTER DOMAIN \"app\".\"email\" ADD CONSTRAINT \"email_valid\" CHECK (VALUE <> 'b  c') NOT VALID;"
    );
}

#[test]
fn multirange_names_are_raw_names_and_are_always_quoted() {
    for name in ["价格区间_multirange", "price ranges", "x\"; DROP TABLE t; --"] {
        let mut snapshot = range_snapshot();
        snapshot.properties.range_multirange_name = Some(name.into());
        let mut request = edit_request(
            &snapshot,
            CustomTypeDraftDefinition::Range {
                subtype: "numeric".into(),
                subtype_opclass: Some("pg_catalog.numeric_ops".into()),
                canonical_function: None,
                subtype_diff_function: None,
                multirange_name: Some(name.into()),
            },
        );
        request.draft.comment = Some("new comment".into());
        let plan = plan_for(Some(&snapshot), &request);
        assert!(!plan.is_blocked(), "{:?}", plan.blocked_changes);
        assert_eq!(plan.statements.len(), 1);
        assert!(plan.statements[0].starts_with("COMMENT ON TYPE"));
        request.target = None;
        let plan = plan_for(None, &request);
        assert!(!plan.is_blocked());
        assert!(plan.statements[0].contains(&format!("multirange_type_name = {}", super::quote_ident(name))));
    }
}

#[test]
fn identifiers_preserve_outer_whitespace_through_create_edit_and_drop() {
    let mut snapshot = enum_snapshot();
    snapshot.schema = " app ".into();
    snapshot.name = " status ".into();
    snapshot.owner = Some(" owner ".into());
    let definition = CustomTypeDraftDefinition::Enum {
        values: snapshot
            .members
            .iter()
            .map(|member| CustomTypeEnumValueDraft {
                value: member.enum_value.clone().unwrap(),
                original_value: member.enum_value.clone(),
            })
            .collect(),
    };
    let mut request = edit_request(&snapshot, definition);
    assert!(plan_for(Some(&snapshot), &request).statements.is_empty());
    request.draft.name = " renamed ".into();
    request.draft.schema = " moved ".into();
    request.draft.owner = Some(" new owner ".into());
    request.draft.comment = Some("changed".into());
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(
        plan.statements,
        vec![
            "ALTER TYPE \" app \".\" status \" RENAME TO \" renamed \";",
            "ALTER TYPE \" app \".\" renamed \" SET SCHEMA \" moved \";",
            "COMMENT ON TYPE \" moved \".\" renamed \" IS 'changed';",
            "ALTER TYPE \" moved \".\" renamed \" OWNER TO \" new owner \";",
        ]
    );
    request.target = None;
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert_eq!(plan.statements[0], "CREATE TYPE \" moved \".\" renamed \" AS ENUM ('draft', 'published');");
    assert_eq!(plan.resulting_identity.name, " renamed ");
    let drop = plan_custom_type_drop(
        CustomTypeSqlDialect::Postgres,
        &CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: snapshot.schema.clone(),
                name: snapshot.name.clone(),
                kind: snapshot.kind,
            },
            cascade: false,
        },
        &all_supported(),
    );
    assert_eq!(drop.statement, "DROP TYPE \" app \".\" status \" RESTRICT;");
}

#[test]
fn composite_spaced_attribute_names_are_distinct_and_unchanged() {
    let mut snapshot = composite_snapshot();
    snapshot.members = vec![attribute(1, "city", "text", None), attribute(2, " city ", "text", None)];
    let mut request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Composite {
            attributes: snapshot
                .members
                .iter()
                .map(|member| CustomTypeAttributeDraft {
                    name: member.name.clone(),
                    original_name: Some(member.name.clone()),
                    data_type: member.data_type.clone(),
                    comment: None,
                })
                .collect(),
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
    request.target = None;
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert!(plan.statements[0].contains("\"city\" text,\n  \" city \" text"));
}

#[test]
fn domain_spaced_constraint_names_are_distinct_and_unchanged() {
    let mut snapshot = domain_snapshot();
    snapshot.properties.domain_constraints = ["check", " check "]
        .iter()
        .map(|name| CustomTypeDomainConstraint {
            name: (*name).into(),
            definition: "CHECK ((VALUE <> ''::text))".into(),
            validated: Some(true),
        })
        .collect();
    let mut request = edit_request(
        &snapshot,
        CustomTypeDraftDefinition::Domain {
            base_type: "text".into(),
            collation: Some("C".into()),
            default: Some("''::text".into()),
            not_null: false,
            constraints: snapshot
                .properties
                .domain_constraints
                .iter()
                .map(|c| CustomTypeDomainConstraintDraft {
                    name: c.name.clone(),
                    original_name: Some(c.name.clone()),
                    expression: c.definition.clone(),
                    validated: c.validated,
                })
                .collect(),
        },
    );
    let plan = plan_for(Some(&snapshot), &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert!(plan.statements.is_empty(), "{:?}", plan.statements);
    request.target = None;
    let plan = plan_for(None, &request);
    assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
    assert!(plan.statements[0].contains("CONSTRAINT \"check\""));
    assert!(plan.statements[0].contains("CONSTRAINT \" check \""));
}

#[test]
fn range_companion_name_comparison_preserves_whitespace_and_case() {
    let mut snapshot = range_snapshot();
    snapshot.properties.range_multirange_name = Some(" My Range ".into());
    for (name, unchanged) in [(" My Range ", true), ("My Range", false), (" my range ", false)] {
        let request = edit_request(
            &snapshot,
            CustomTypeDraftDefinition::Range {
                subtype: "numeric".into(),
                subtype_opclass: None,
                canonical_function: None,
                subtype_diff_function: None,
                multirange_name: Some(name.into()),
            },
        );
        let plan = plan_for(Some(&snapshot), &request);
        assert_eq!(plan.blocked_changes.is_empty(), unchanged, "{name}: {:?}", plan.blocked_changes);
    }
}
