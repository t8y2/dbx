//! Pure SQL planning for PostgreSQL-family user-defined type management.
//!
//! The planner answers one question: *given the type as it exists in the
//! catalog and the end state the user wants, which statements produce that end
//! state — or why is it impossible?* It never connects to a database, reads
//! global state, or executes anything, which is what makes the whole
//! create/edit/drop surface unit-testable.
//!
//! Callers (dbx-core) are responsible for reading the snapshot, deciding which
//! operations the connection supports, hashing the plan into a revision, and
//! executing the statements under a transaction policy.

mod fragment;
mod postgres;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};

use crate::types::{
    ApplyCustomTypeChangeRequest, CustomTypeAttributeDraft, CustomTypeChangePreview, CustomTypeChangeRequest,
    CustomTypeDetails, CustomTypeDomainConstraintDraft, CustomTypeDraft, CustomTypeDraftDefinition,
    CustomTypeDropPreview, CustomTypeDropRequest, CustomTypeIdentity, CustomTypeKind, CustomTypeManagementCapabilities,
    CustomTypeOperation, CustomTypePlanIssue, CustomTypePlanIssueSeverity, CustomTypeTransactionPolicy,
};

pub use fragment::{validate_fragment, validate_identifier_fragment, FragmentKind};
pub use postgres::{canonical_check_expression, canonical_expression, qualified, quote_ident, quote_literal};

/// Engines with a custom type DDL implementation.
///
/// Deliberately an enum rather than a `DatabaseType` so a newly added
/// PostgreSQL-family engine cannot inherit this planner by accident: the caller
/// must map it explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustomTypeSqlDialect {
    Postgres,
}

/// Everything the planner decided, before dbx-core attaches a revision.
#[derive(Debug, Clone)]
pub struct CustomTypePlan {
    pub statements: Vec<String>,
    pub warnings: Vec<CustomTypePlanIssue>,
    pub blocked_changes: Vec<CustomTypePlanIssue>,
    pub destructive: bool,
    pub transaction_policy: CustomTypeTransactionPolicy,
    pub resulting_identity: CustomTypeIdentity,
}

impl CustomTypePlan {
    pub fn is_blocked(&self) -> bool {
        !self.blocked_changes.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

#[derive(Default)]
struct PlanBuilder {
    statements: Vec<String>,
    warnings: Vec<CustomTypePlanIssue>,
    blocked: Vec<CustomTypePlanIssue>,
    destructive: bool,
    has_enum_add_value: bool,
}

impl PlanBuilder {
    fn push(&mut self, statement: String) {
        self.statements.push(statement);
    }

    fn warn(&mut self, code: &str, path: &str, message: impl Into<String>) {
        self.issue(code, path, CustomTypePlanIssueSeverity::Warning, message);
    }

    fn destructive(&mut self, code: &str, path: &str, message: impl Into<String>) {
        self.destructive = true;
        self.issue(code, path, CustomTypePlanIssueSeverity::Destructive, message);
    }

    fn block(&mut self, code: &str, path: &str, message: impl Into<String>) {
        self.issue(code, path, CustomTypePlanIssueSeverity::Blocking, message);
    }

    fn issue(&mut self, code: &str, path: &str, severity: CustomTypePlanIssueSeverity, message: impl Into<String>) {
        let issue = CustomTypePlanIssue {
            code: code.to_string(),
            message: message.into(),
            path: Some(path.to_string()),
            severity,
        };
        match severity {
            CustomTypePlanIssueSeverity::Blocking => self.blocked.push(issue),
            CustomTypePlanIssueSeverity::Warning | CustomTypePlanIssueSeverity::Destructive => {
                self.warnings.push(issue)
            }
        }
    }

    /// Gate one statement-producing step on a runtime capability.
    ///
    /// The user-facing reason comes from the capability itself so that "why is
    /// this disabled" is answered once, in dbx-core, instead of every planner
    /// branch inventing its own explanation.
    fn require(
        &mut self,
        capabilities: &CustomTypeManagementCapabilities,
        operation: CustomTypeOperation,
        path: &str,
        fallback: &str,
    ) -> bool {
        match capabilities.operations.get(&operation) {
            Some(capability) if capability.supported => true,
            Some(capability) => {
                let code = capability.reason_code.clone().unwrap_or_else(|| "operation_unsupported".to_string());
                let message = capability.reason.clone().unwrap_or_else(|| fallback.to_string());
                self.block(&code, path, message);
                false
            }
            None => {
                self.block("operation_unsupported", path, fallback);
                false
            }
        }
    }

    fn finish(
        mut self,
        capabilities: &CustomTypeManagementCapabilities,
        identity: CustomTypeIdentity,
    ) -> CustomTypePlan {
        let transaction_policy = self.resolve_transaction_policy(capabilities);
        // Blocked issues are the authoritative list; a plan with no statements
        // but no blocked issue is a genuine no-op and the caller reports it.
        self.warnings.dedup_by(|left, right| left.code == right.code && left.path == right.path);
        CustomTypePlan {
            statements: self.statements,
            warnings: self.warnings,
            blocked_changes: self.blocked,
            destructive: self.destructive,
            transaction_policy,
            resulting_identity: identity,
        }
    }

    fn resolve_transaction_policy(
        &mut self,
        capabilities: &CustomTypeManagementCapabilities,
    ) -> CustomTypeTransactionPolicy {
        if self.statements.len() <= 1 {
            return CustomTypeTransactionPolicy::Autocommit;
        }
        if !capabilities.supports(CustomTypeOperation::TransactionalDdl) {
            self.block(
                "transaction_unsupported",
                "",
                "This connection cannot roll a multi-statement type change back, so the change is refused instead of risking a partial result.",
            );
            return CustomTypeTransactionPolicy::Autocommit;
        }
        if self.has_enum_add_value && !capabilities.supports(CustomTypeOperation::AlterEnumAddValueInTransaction) {
            self.block(
                "enum.add_value_requires_autocommit",
                "definition.values",
                "This server cannot run ALTER TYPE ... ADD VALUE inside a transaction, so adding a value cannot be combined with other changes. Save the new value on its own first.",
            );
            return CustomTypeTransactionPolicy::Autocommit;
        }
        CustomTypeTransactionPolicy::Required
    }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

pub fn plan_custom_type_change(
    dialect: CustomTypeSqlDialect,
    snapshot: Option<&CustomTypeDetails>,
    request: &CustomTypeChangeRequest,
    capabilities: &CustomTypeManagementCapabilities,
) -> CustomTypePlan {
    match dialect {
        CustomTypeSqlDialect::Postgres => plan_postgres_change(snapshot, request, capabilities),
    }
}

/// Build the statement that removes a type, refusing the cases the UI must send
/// back to the user instead.
pub fn plan_custom_type_drop(
    dialect: CustomTypeSqlDialect,
    request: &CustomTypeDropRequest,
    capabilities: &CustomTypeManagementCapabilities,
) -> CustomTypeDropPreview {
    match dialect {
        CustomTypeSqlDialect::Postgres => plan_postgres_drop(request, capabilities),
    }
}

fn plan_postgres_drop(
    request: &CustomTypeDropRequest,
    capabilities: &CustomTypeManagementCapabilities,
) -> CustomTypeDropPreview {
    let mut builder = PlanBuilder::default();
    let target = &request.target;
    let kind = target.kind;
    validate_identity(&mut builder, &target.schema, &target.name, "target");

    // A multirange is generated by its range type. Dropping only the companion
    // would leave the range's `rngmultitypid` pointing at nothing, and dropping
    // a range removes the companion anyway, so the UI sends the user to the
    // range instead of emitting a statement that cannot be safe.
    if kind == CustomTypeKind::Multirange {
        builder.block(
            "drop.multirange_companion",
            "target",
            "This multirange is generated by its range type and cannot be dropped on its own. Edit or drop the range type instead.",
        );
    }
    let operation = if request.cascade { CustomTypeOperation::DropCascade } else { CustomTypeOperation::DropRestrict };
    let fallback = if request.cascade {
        "Dropping types with CASCADE is not verified on this connection."
    } else {
        "Dropping types is not verified on this connection."
    };
    builder.require(capabilities, operation, "target", fallback);

    let statement = postgres::drop_statement(kind, &target.schema, &target.name, request.cascade);
    if !builder.blocked.is_empty() {
        // Still return the statement text: the confirmation dialog shows the
        // user what *would* run, and the blocking reasons explain what must be
        // resolved first.
        return CustomTypeDropPreview {
            statement,
            dependencies: Vec::new(),
            dependencies_complete: true,
            warnings: builder.warnings,
            blocked_changes: builder.blocked,
            plan_revision: String::new(),
        };
    }
    builder.push(statement.clone());
    CustomTypeDropPreview {
        statement,
        dependencies: Vec::new(),
        dependencies_complete: true,
        warnings: builder.warnings,
        blocked_changes: builder.blocked,
        plan_revision: String::new(),
    }
}

/// Turn a plan into the transport-facing preview. `plan_revision` is supplied
/// by the caller because it hashes data (the snapshot and the capability set)
/// the planner never sees.
pub fn preview_from_plan(plan: CustomTypePlan, plan_revision: String) -> CustomTypeChangePreview {
    CustomTypeChangePreview {
        statements: plan.statements,
        warnings: plan.warnings,
        blocked_changes: plan.blocked_changes,
        destructive: plan.destructive,
        transaction_policy: plan.transaction_policy,
        plan_revision,
        resulting_identity: plan.resulting_identity,
    }
}

/// Convenience for callers that already hold an [`ApplyCustomTypeChangeRequest`].
pub fn request_from_apply(apply: &ApplyCustomTypeChangeRequest) -> &CustomTypeChangeRequest {
    &apply.change
}

// ---------------------------------------------------------------------------
// Change planning
// ---------------------------------------------------------------------------

fn plan_postgres_change(
    snapshot: Option<&CustomTypeDetails>,
    request: &CustomTypeChangeRequest,
    capabilities: &CustomTypeManagementCapabilities,
) -> CustomTypePlan {
    let draft = &request.draft;
    let mut builder = PlanBuilder::default();
    let kind = draft.definition.kind();

    if let Some(target) = request.target.as_ref() {
        if target.kind != kind {
            builder.block(
                "type.kind_immutable",
                "definition",
                "A type's kind cannot be changed. Create a new type instead.",
            );
        }
    }

    validate_identity(&mut builder, &draft.schema, &draft.name, "name");
    validate_definition_fragments(&mut builder, &draft.definition, true);
    let schema_ok = validate_qualified_schema(&mut builder, draft.schema.as_str());

    if !builder.blocked.is_empty() {
        // No statement may be produced from a draft with an unusable fragment:
        // the fragment would be spliced into the statement text verbatim.
        let identity = CustomTypeIdentity { schema: draft.schema.clone(), name: draft.name.clone(), kind };
        return builder.finish(capabilities, identity);
    }
    let _ = schema_ok;

    match snapshot {
        None => plan_create(&mut builder, draft, capabilities),
        Some(snapshot) => plan_edit(&mut builder, snapshot, draft, capabilities),
    }

    let identity = CustomTypeIdentity { schema: draft.schema.clone(), name: draft.name.clone(), kind };
    builder.finish(capabilities, identity)
}

fn validate_identity(builder: &mut PlanBuilder, schema: &str, name: &str, path: &str) {
    if schema.trim().is_empty() {
        builder.block("identity.schema_required", path, "A schema is required.");
    }
    if name.trim().is_empty() {
        builder.block("identity.name_required", path, "A name is required.");
    }
}

/// Validate every user-supplied SQL fragment before it is spliced into a
/// statement.
///
/// This runs for create *and* edit, because an edit can carry a fragment the
/// user just typed (a changed default, a rewritten CHECK body, a new attribute
/// type). Anything rejected here becomes a blocking issue, so no statement is
/// emitted and apply cannot be reached.
fn validate_definition_fragments(
    builder: &mut PlanBuilder,
    definition: &CustomTypeDraftDefinition,
    enum_values_are_literals: bool,
) {
    match definition {
        CustomTypeDraftDefinition::Enum { .. } => {
            // Enum labels are emitted through `quote_literal`, so they cannot
            // terminate a statement; nothing to validate.
            let _ = enum_values_are_literals;
        }
        CustomTypeDraftDefinition::Composite { attributes } => {
            for (index, attribute) in attributes.iter().enumerate() {
                let field = format!("Attribute \"{}\" data type", attribute.name.as_str());
                if let Err(message) = validate_fragment(FragmentKind::TypeExpression, &field, &attribute.data_type) {
                    builder.block(
                        "fragment.invalid_type_expression",
                        "definition.attributes",
                        with_index(index, &message),
                    );
                }
            }
        }
        CustomTypeDraftDefinition::Domain { base_type, collation, default, constraints, .. } => {
            if let Err(message) = validate_fragment(FragmentKind::TypeExpression, "Base type", base_type) {
                builder.block("fragment.invalid_type_expression", "definition.baseType", message);
            }
            if let Some(collation) = collation.as_deref().filter(|value| !value.trim().is_empty()) {
                if let Err(message) = validate_fragment(FragmentKind::QualifiedName, "Collation", collation) {
                    builder.block("fragment.invalid_name", "definition.collation", message);
                }
            }
            if let Some(default) = default.as_deref().filter(|value| !value.trim().is_empty()) {
                if let Err(message) = validate_fragment(FragmentKind::ValueExpression, "Default value", default) {
                    builder.block("fragment.invalid_expression", "definition.default", message);
                }
            }
            for (index, constraint) in constraints.iter().enumerate() {
                let field = format!("Constraint \"{}\" expression", constraint.name.as_str());
                if let Err(message) = validate_fragment(FragmentKind::Expression, &field, &constraint.expression) {
                    builder.block("fragment.invalid_expression", "definition.constraints", with_index(index, &message));
                }
            }
        }
        // No fragments: this kind has no structured fields to splice in.
        CustomTypeDraftDefinition::None { .. } => {}
        CustomTypeDraftDefinition::Range {
            subtype,
            subtype_opclass,
            canonical_function,
            subtype_diff_function,
            multirange_name,
            ..
        } => {
            if let Err(message) = validate_fragment(FragmentKind::TypeExpression, "Range subtype", subtype) {
                builder.block("fragment.invalid_type_expression", "definition.subtype", message);
            }
            for (path, field, value) in [
                ("definition.subtypeOpclass", "Subtype opclass", subtype_opclass),
                ("definition.canonicalFunction", "Canonical function", canonical_function),
                ("definition.subtypeDiffFunction", "Subtype diff function", subtype_diff_function),
            ] {
                let Some(value) = value.as_deref().filter(|value| !value.trim().is_empty()) else {
                    continue;
                };
                if let Err(message) = validate_fragment(FragmentKind::QualifiedName, field, value) {
                    builder.block("fragment.invalid_name", path, message);
                }
            }
            if let Some(multirange_name) = multirange_name.as_deref().filter(|value| !value.trim().is_empty()) {
                // A raw catalog name, like draft.name, not an SQL fragment.
                // Emission always quote_ident's it, including spaces/Unicode/quotes.
                if multirange_name.contains('\0') {
                    builder.block(
                        "fragment.invalid_name",
                        "definition.multirangeName",
                        "Multirange type name cannot contain a NUL character.",
                    );
                }
            }
        }
    }
}

/// The schema and type name are user-supplied too, but they go through
/// `quote_ident`; the only thing that can go wrong is a name that is not a name
/// at all (e.g. a whitespace-only or control-character value), which would
/// produce a quoted identifier PostgreSQL rejects.
fn validate_qualified_schema(builder: &mut PlanBuilder, schema: &str) -> bool {
    if schema.is_empty() {
        return false;
    }
    // A quoted identifier may contain almost anything, so the only rejection is
    // a NUL byte, which PostgreSQL cannot store in an identifier.
    if schema.contains('\0') {
        builder.block("identity.schema_invalid", "schema", "A schema name cannot contain a NUL character.");
        return false;
    }
    true
}

/// Point a fragment error at the failing row when it came from a list.
fn with_index(index: usize, message: &str) -> String {
    format!("[{index}]: {message}")
}

fn plan_create(builder: &mut PlanBuilder, draft: &CustomTypeDraft, capabilities: &CustomTypeManagementCapabilities) {
    let schema = draft.schema.as_str();
    let name = draft.name.as_str();
    match &draft.definition {
        CustomTypeDraftDefinition::Enum { values } => {
            if !builder.require(
                capabilities,
                CustomTypeOperation::CreateEnum,
                "definition",
                "Creating enum types is not verified on this connection.",
            ) {
                return;
            }
            if let Some(duplicate) = first_duplicate(values.iter().map(|entry| entry.value.as_str())) {
                builder.block(
                    "enum.duplicate_value",
                    "definition.values",
                    format!("Duplicate enum value: {duplicate}"),
                );
                return;
            }
            if values.is_empty() {
                builder.warn(
                    "enum.empty",
                    "definition.values",
                    "The enum is created without values; values can be added later.",
                );
            }
            let labels = values.iter().map(|entry| entry.value.clone()).collect::<Vec<_>>();
            builder.push(postgres::create_enum(schema, name, &labels));
        }
        CustomTypeDraftDefinition::Composite { attributes } => {
            if !builder.require(
                capabilities,
                CustomTypeOperation::CreateComposite,
                "definition",
                "Creating composite types is not verified on this connection.",
            ) {
                return;
            }
            if let Err(message) = validate_attributes(attributes) {
                builder.block("composite.invalid_attributes", "definition.attributes", message);
                return;
            }
            if attributes.is_empty() {
                builder.block(
                    "composite.no_attributes",
                    "definition.attributes",
                    "A composite type needs at least one attribute.",
                );
                return;
            }
            let fields = attributes
                .iter()
                .map(|attribute| (attribute.name.as_str().to_string(), attribute.data_type.clone()))
                .collect::<Vec<_>>();
            builder.push(postgres::create_composite(schema, name, &fields));
            for attribute in attributes {
                if let Some(comment) = normalize_comment(attribute.comment.as_deref()) {
                    builder.push(postgres::comment_on_composite_attribute(
                        schema,
                        name,
                        attribute.name.as_str(),
                        Some(comment),
                    ));
                }
            }
        }
        CustomTypeDraftDefinition::Domain { base_type, collation, default, not_null, constraints } => {
            if !builder.require(
                capabilities,
                CustomTypeOperation::CreateDomain,
                "definition",
                "Creating domains is not verified on this connection.",
            ) {
                return;
            }
            if base_type.trim().is_empty() {
                builder.block("domain.base_type_required", "definition.baseType", "A domain needs a base type.");
                return;
            }
            if let Err(message) = validate_constraints(constraints) {
                builder.block("domain.invalid_constraints", "definition.constraints", message);
                return;
            }
            builder.push(postgres::create_domain(
                schema,
                name,
                base_type,
                collation.as_deref(),
                default.as_deref(),
                *not_null,
                constraints,
            ));
            for constraint in constraints.iter().filter(|constraint| constraint.validated == Some(false)) {
                if builder.require(
                    capabilities,
                    CustomTypeOperation::AlterDomainAddConstraint,
                    "definition.constraints",
                    "Adding domain constraints is not supported on this connection.",
                ) {
                    builder.push(postgres::alter_domain_add_constraint(
                        schema,
                        name,
                        constraint.name.as_str(),
                        &constraint.expression,
                        Some(false),
                    ));
                }
            }
        }
        CustomTypeDraftDefinition::Range {
            subtype,
            subtype_opclass,
            canonical_function,
            subtype_diff_function,
            multirange_name,
        } => {
            if !builder.require(
                capabilities,
                CustomTypeOperation::CreateRange,
                "definition",
                "Creating range types is not verified on this connection.",
            ) {
                return;
            }
            if subtype.trim().is_empty() {
                builder.block("range.subtype_required", "definition.subtype", "A range type needs a subtype.");
                return;
            }
            if multirange_name.as_deref().is_some_and(|value| !value.is_empty())
                && !builder.require(
                    capabilities,
                    CustomTypeOperation::CreateRangeMultirangeName,
                    "definition.multirangeName",
                    "Naming the multirange companion is not supported on this server version.",
                )
            {
                return;
            }
            builder.push(postgres::create_range(
                schema,
                name,
                subtype,
                subtype_opclass.as_deref(),
                canonical_function.as_deref(),
                subtype_diff_function.as_deref(),
                multirange_name.as_deref(),
            ));
        }
        // Base types have no structured creation form (their I/O functions
        // cannot be derived from a catalog), so there is nothing to emit.
        CustomTypeDraftDefinition::None { .. } => {
            builder.block(
                "create.kind_unsupported",
                "definition",
                "This kind cannot be created from the designer. Use a SQL editor instead.",
            );
        }
    }

    // Comment and owner are separate statements for a freshly created type, and
    // they use the final identity because nothing was renamed.
    if let Some(comment) = normalize_comment(draft.comment.as_deref()) {
        builder.push(postgres::comment_on_type(draft.definition.kind(), schema, name, Some(comment)));
    }
    if let Some(owner) = draft.owner.as_deref().filter(|value| !value.is_empty()) {
        if builder.require(
            capabilities,
            CustomTypeOperation::AlterOwner,
            "owner",
            "Changing a type's owner is not verified on this connection.",
        ) {
            builder.push(postgres::alter_owner(draft.definition.kind(), schema, name, owner));
        }
    }
}

fn plan_edit(
    builder: &mut PlanBuilder,
    snapshot: &CustomTypeDetails,
    draft: &CustomTypeDraft,
    capabilities: &CustomTypeManagementCapabilities,
) {
    let kind = snapshot.kind;
    if kind != draft.definition.kind() {
        // plan_postgres_change already blocked this; do not emit statements
        // against a type we cannot describe consistently.
        return;
    }

    // Structural changes run before the rename so they can keep referring to
    // the name the catalog still has.
    let old_schema = snapshot.schema.as_str().to_string();
    let old_name = snapshot.name.as_str().to_string();
    let mut final_name = old_name.clone();
    let mut final_schema = old_schema.clone();

    // A multirange is generated by its range type: renaming or moving it would
    // leave `pg_range.rngmultitypid` describing a name that no longer exists, and
    // the next range alteration would silently reintroduce the old name. Its
    // comment and owner are still editable.
    if kind == CustomTypeKind::Multirange {
        if draft.name.as_str() != old_name {
            builder.block(
                "multirange.rename_unsupported",
                "name",
                "A multirange is generated by its range type and cannot be renamed. Rename the range type instead.",
            );
        }
        if draft.schema.as_str() != old_schema {
            builder.block(
                "multirange.set_schema_unsupported",
                "schema",
                "A multirange is generated by its range type and cannot be moved to another schema. Move the range type instead.",
            );
        }
    }

    match (&draft.definition, kind) {
        (CustomTypeDraftDefinition::Enum { values }, CustomTypeKind::Enum) => {
            plan_enum_diff(builder, snapshot, values, &old_schema, &old_name, capabilities);
        }
        (CustomTypeDraftDefinition::Composite { attributes }, CustomTypeKind::Composite) => {
            plan_composite_diff(builder, snapshot, attributes, &old_schema, &old_name, capabilities);
        }
        (
            CustomTypeDraftDefinition::Domain { base_type, collation, default, not_null, constraints },
            CustomTypeKind::Domain,
        ) => {
            plan_domain_diff(
                builder,
                snapshot,
                base_type,
                collation.as_deref(),
                default.as_deref(),
                *not_null,
                constraints,
                &old_schema,
                &old_name,
                capabilities,
            );
        }
        (
            CustomTypeDraftDefinition::Range {
                subtype,
                subtype_opclass,
                canonical_function,
                subtype_diff_function,
                multirange_name,
            },
            CustomTypeKind::Range,
        ) => {
            plan_range_diff(
                builder,
                snapshot,
                subtype,
                subtype_opclass.as_deref(),
                canonical_function.as_deref(),
                subtype_diff_function.as_deref(),
                multirange_name.as_deref(),
                capabilities,
            );
        }
        // A kind with no structured editor only reaches here for
        // rename/schema/owner/comment; the snapshot kind and the draft kind
        // already matched, so there is nothing structural to plan.
        _ => {}
    }

    // A blocked structural change invalidates everything below: the identity
    // these statements would reference is the one the structural phase was
    // supposed to produce. Emitting them would show the user a plan that can
    // never run, so the plan stays empty whenever it is blocked.
    if !builder.blocked.is_empty() {
        return;
    }

    // Rename and schema move establish the identity used by comment and owner.
    // Transfer ownership last: the current role may then lose permission to
    // change the comment when it does not inherit the new owner's privileges.
    if draft.name.as_str() != old_name
        && builder.require(
            capabilities,
            CustomTypeOperation::AlterRename,
            "name",
            "Renaming a type is not verified on this connection.",
        )
    {
        builder.push(postgres::alter_rename(kind, &final_schema, &final_name, draft.name.as_str()));
        final_name = draft.name.as_str().to_string();
    }
    if draft.schema.as_str() != old_schema
        && builder.require(
            capabilities,
            CustomTypeOperation::AlterSetSchema,
            "schema",
            "Moving a type to another schema is not verified on this connection.",
        )
    {
        builder.push(postgres::alter_set_schema(kind, &final_schema, &final_name, draft.schema.as_str()));
        final_schema = draft.schema.as_str().to_string();
    }
    let snapshot_comment = normalize_comment(snapshot.comment.as_deref());
    let draft_comment = normalize_comment(draft.comment.as_deref());
    if snapshot_comment != draft_comment
        && builder.require(
            capabilities,
            CustomTypeOperation::AlterComment,
            "comment",
            "Changing a type's comment is not verified on this connection.",
        )
    {
        builder.push(postgres::comment_on_type(kind, &final_schema, &final_name, draft_comment));
    }
    if let Some(owner) = draft.owner.as_deref().filter(|value| !value.is_empty()) {
        if snapshot.owner.as_deref() != Some(owner)
            && builder.require(
                capabilities,
                CustomTypeOperation::AlterOwner,
                "owner",
                "Changing a type's owner is not verified on this connection.",
            )
        {
            builder.push(postgres::alter_owner(kind, &final_schema, &final_name, owner));
        }
    }
}

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

fn plan_enum_diff(
    builder: &mut PlanBuilder,
    snapshot: &CustomTypeDetails,
    values: &[crate::types::CustomTypeEnumValueDraft],
    schema: &str,
    name: &str,
    capabilities: &CustomTypeManagementCapabilities,
) {
    const PATH: &str = "definition.values";
    let existing = snapshot.members.iter().filter_map(|member| member.enum_value.clone()).collect::<Vec<_>>();
    let existing_set = existing.iter().cloned().collect::<BTreeSet<_>>();

    // Identity of existing entries: an entry can only be an existing value if it
    // carries `original_value`, and each original may appear at most once.
    let mut seen_originals = BTreeSet::new();
    for entry in values {
        if let Some(original) = entry.original_value.as_deref() {
            if !existing_set.contains(original) {
                builder.block(
                    "enum.unknown_original_value",
                    PATH,
                    format!("Enum value \"{original}\" no longer exists. Refresh the type before saving."),
                );
            }
            if !seen_originals.insert(original.to_string()) {
                builder.block(
                    "enum.duplicate_original_value",
                    PATH,
                    format!("Enum value \"{original}\" appears twice in the draft."),
                );
            }
        }
    }

    // Removal and reordering of existing values are not expressible in
    // PostgreSQL, and pretending otherwise would silently produce a type that
    // disagrees with the table the user just edited.
    let draft_existing_order = values.iter().filter_map(|entry| entry.original_value.clone()).collect::<Vec<_>>();
    let mut missing =
        existing.iter().filter(|value| !draft_existing_order.contains(*value)).cloned().collect::<Vec<_>>();
    if !missing.is_empty() {
        missing.sort();
        builder.block(
            "enum.remove_value_unsupported",
            PATH,
            format!("{} cannot be removed from an enum.", missing.join(", ")),
        );
    }
    let kept_order = existing.iter().filter(|value| draft_existing_order.contains(*value)).cloned().collect::<Vec<_>>();
    if kept_order != draft_existing_order {
        builder.block(
            "enum.reorder_existing_unsupported",
            PATH,
            "Existing enum values cannot be reordered. Insert new values before or after an existing one instead.",
        );
    }

    let mut final_values = Vec::with_capacity(values.len());
    for entry in values {
        final_values.push(entry.value.clone());
    }
    if let Some(duplicate) = first_duplicate(final_values.iter().map(String::as_str)) {
        builder.block("enum.duplicate_value", PATH, format!("Duplicate enum value: {duplicate}"));
    }

    if !builder.blocked.is_empty() {
        return;
    }

    let has_additions = values.iter().any(|entry| entry.original_value.is_none());
    if has_additions
        && !builder.require(
            capabilities,
            CustomTypeOperation::AlterEnumAddValue,
            PATH,
            "Adding enum values is not verified on this connection.",
        )
    {
        return;
    }
    let has_renames =
        values.iter().any(|entry| entry.original_value.as_deref().is_some_and(|original| original != entry.value));
    if has_renames
        && !builder.require(
            capabilities,
            CustomTypeOperation::AlterEnumRenameValue,
            PATH,
            "Renaming enum values is not verified on this connection.",
        )
    {
        return;
    }

    // Two phases, because a single pass cannot express either case correctly.
    //
    // Phase 1 renames every existing value to its final label, so the label set
    // is settled. Phase 2 then adds the new values, anchored on labels that
    // Phase 1 has already guaranteed exist. Doing this in one pass would emit
    // `ADD VALUE 'new' BEFORE 'renamed'` before `'renamed'` existed, and a
    // label swap would try to rename onto a name that was still taken.
    //
    // Enum *order* is unaffected: renames do not change `enumsortorder`, and
    // each addition is anchored against the final neighbour, so the resulting
    // order matches the list the user is looking at.
    let renames = values
        .iter()
        .filter_map(|entry| {
            let original = entry.original_value.as_deref()?;
            (original != entry.value).then(|| (original.to_string(), entry.value.clone()))
        })
        .collect::<Vec<_>>();
    let live_names = existing.iter().cloned().collect::<BTreeSet<_>>();
    let occupied_by_additions = values
        .iter()
        .filter(|entry| entry.original_value.is_none())
        .map(|entry| entry.value.clone())
        .collect::<BTreeSet<_>>();
    let Some(rename_steps) = order_renames(builder, &renames, &live_names, PATH, "enum value") else {
        return;
    };
    for step in &rename_steps {
        builder.push(postgres::alter_enum_rename_value(schema, name, &step.from, &step.to));
    }

    // Phase 2: additions, each anchored on the nearest preceding final label, or
    // on the nearest following one when the new value is at the head. Labels
    // that only exist because of an addition are usable anchors too, because the
    // additions themselves run in final order.
    let mut labels_present = values
        .iter()
        .filter(|entry| entry.original_value.is_some())
        .map(|entry| entry.value.clone())
        .collect::<BTreeSet<_>>();
    for (index, entry) in values.iter().enumerate() {
        if entry.original_value.is_some() {
            continue;
        }
        if occupied_by_additions.contains(&entry.value) && labels_present.contains(&entry.value) {
            builder.block("enum.duplicate_value", PATH, format!("Duplicate enum value: {}", entry.value));
            return;
        }
        let position = enum_add_position(&final_values, index, &labels_present);
        builder.push(postgres::alter_enum_add_value(schema, name, &entry.value, position));
        builder.has_enum_add_value = true;
        labels_present.insert(entry.value.clone());
    }
}

/// One rename step: the name as it exists now, and the name it must become.
struct RenameStep {
    from: String,
    to: String,
}

/// Order renames so every statement's target name is free when it runs.
///
/// PostgreSQL refuses `RENAME ... TO <name>` while `<name>` is taken, so the
/// order is not free: `a -> b, b -> a` cannot be emitted in draft order, and
/// `a -> b, b -> c` must run back to front. Renames whose target is still
/// occupied are deferred; a pure cycle is broken by routing one member through a
/// temporary name.
///
/// Returns `None` when the plan must not be emitted (a blocking issue was
/// recorded), so callers can bail out without generating statements.
fn order_renames(
    builder: &mut PlanBuilder,
    renames: &[(String, String)],
    live_names: &BTreeSet<String>,
    path: &str,
    object_label: &str,
) -> Option<Vec<RenameStep>> {
    if renames.is_empty() {
        return Some(Vec::new());
    }
    let renamed_away = renames.iter().map(|(from, _)| from.clone()).collect::<BTreeSet<_>>();
    // A target that is already taken and is *not* being renamed away cannot be
    // produced by this plan at all; report it instead of emitting a failing
    // statement.
    for (from, to) in renames {
        if to != from && live_names.contains(to) && !renamed_away.contains(to) {
            builder.block(
                "rename.target_taken",
                path,
                format!("{object_label} \"{to}\" already exists; rename it away or choose another name."),
            );
        }
    }
    if !builder.blocked.is_empty() {
        return None;
    }

    let mut occupied = live_names.clone();
    let mut remaining = renames.to_vec();
    let mut steps = Vec::with_capacity(renames.len());
    // Bounded by the number of renames: each iteration either emits at least one
    // step or breaks to the cycle handler.
    while !remaining.is_empty() {
        let mut progressed = false;
        let mut deferred = Vec::new();
        for (from, to) in remaining.drain(..) {
            if occupied.contains(&to) {
                deferred.push((from, to));
                continue;
            }
            occupied.remove(&from);
            occupied.insert(to.clone());
            steps.push(RenameStep { from, to });
            progressed = true;
        }
        remaining = deferred;
        if remaining.is_empty() {
            break;
        }
        if !progressed {
            // Pure cycle over the remaining names: route the first one through a
            // free temporary name so the rest can then be renamed onto it.
            let reserved = occupied
                .iter()
                .cloned()
                .chain(remaining.iter().map(|(_, to)| to.clone()))
                .chain(remaining.iter().map(|(from, _)| from.clone()))
                .collect::<BTreeSet<_>>();
            let temp = free_temp_name(&reserved, steps.len());
            let (from, to) = remaining.remove(0);
            occupied.remove(&from);
            occupied.insert(temp.clone());
            steps.push(RenameStep { from: from.clone(), to: temp.clone() });
            remaining.push((temp, to));
        }
    }
    Some(steps)
}

/// A temporary name that collides with nothing in `reserved`.
fn free_temp_name(reserved: &BTreeSet<String>, salt: usize) -> String {
    for attempt in 0..1024 {
        let candidate = format!("dbx_tmp_rename_{}_{}", salt, attempt);
        if !reserved.contains(&candidate) {
            return candidate;
        }
    }
    format!("dbx_tmp_rename_{}_overflow", salt)
}

/// Where a new enum value should be inserted.
///
/// Anchoring is derived from the final order rather than from the DOM action the
/// user performed, so dragging or editing rarely-used rows still produces a
/// statement that matches the list the user is looking at.
///
/// `labels_present` is the set of labels that exist at this point in the
/// generated sequence; an anchor outside it would reference a label the database
/// does not have yet, which is exactly the bug this signature prevents.
fn enum_add_position<'a>(
    final_values: &'a [String],
    index: usize,
    labels_present: &BTreeSet<String>,
) -> Option<postgres::EnumAddPosition<'a>> {
    let preceding = final_values.iter().take(index).rev().find(|label| labels_present.contains(*label));
    if let Some(label) = preceding {
        return Some(postgres::EnumAddPosition::After(label.as_str()));
    }
    let following = final_values.iter().skip(index + 1).find(|label| labels_present.contains(*label));
    following.map(|label| postgres::EnumAddPosition::Before(label.as_str()))
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

fn plan_composite_diff(
    builder: &mut PlanBuilder,
    snapshot: &CustomTypeDetails,
    attributes: &[CustomTypeAttributeDraft],
    schema: &str,
    name: &str,
    capabilities: &CustomTypeManagementCapabilities,
) {
    const PATH: &str = "definition.attributes";
    if let Err(message) = validate_attributes(attributes) {
        builder.block("composite.invalid_attributes", PATH, message);
        return;
    }

    let live = snapshot.members.iter().map(|member| member.name.clone()).collect::<Vec<_>>();
    let live_set = live.iter().cloned().collect::<BTreeSet<_>>();
    let draft_originals =
        attributes.iter().filter_map(|attribute| attribute.original_name.clone()).collect::<BTreeSet<_>>();

    for attribute in attributes {
        if let Some(original) = attribute.original_name.as_deref() {
            if !live_set.contains(original) {
                builder.block(
                    "composite.unknown_original_attribute",
                    PATH,
                    format!("Attribute \"{original}\" no longer exists. Refresh the type before saving."),
                );
            }
        }
    }
    if !builder.blocked.is_empty() {
        return;
    }

    // Drops run first: a rename onto the name of a dropped attribute would fail
    // if the drop had not happened yet.
    for attribute in &live {
        if draft_originals.contains(attribute) {
            continue;
        }
        if builder.require(
            capabilities,
            CustomTypeOperation::AlterCompositeDropAttribute,
            PATH,
            "Dropping composite attributes is not verified on this connection.",
        ) {
            builder.destructive(
                "composite.drop_attribute",
                PATH,
                format!("Attribute \"{attribute}\" is dropped; existing values lose that field."),
            );
            builder.push(postgres::alter_composite_drop_attribute(schema, name, attribute));
        }
    }

    // Renames, then type changes, then additions — each phase references the
    // names that exist after the previous phase.
    let mut resolved = BTreeMap::new();
    for attribute in attributes {
        if let Some(original) = attribute.original_name.as_deref() {
            resolved.insert(original.to_string(), original.to_string());
        }
    }
    let renames = attributes
        .iter()
        .filter_map(|attribute| {
            let original = attribute.original_name.as_deref()?;
            let final_name = attribute.name.as_str();
            (final_name != original).then(|| (original.to_string(), final_name.to_string()))
        })
        .collect::<Vec<_>>();
    if !renames.is_empty()
        && !builder.require(
            capabilities,
            CustomTypeOperation::AlterCompositeRenameAttribute,
            PATH,
            "Renaming composite attributes is not verified on this connection.",
        )
    {
        return;
    }
    // Attributes dropped above are already gone, so their names are free.
    let occupied =
        live.iter().filter(|attribute| draft_originals.contains(*attribute)).cloned().collect::<BTreeSet<_>>();
    let Some(rename_steps) = order_renames(builder, &renames, &occupied, PATH, "attribute") else {
        return;
    };
    for step in &rename_steps {
        builder.push(postgres::alter_composite_rename_attribute(schema, name, &step.from, &step.to));
    }
    // Rename *steps* describe transient catalog state (a cycle may pass through
    // dbx_tmp_rename_*), but every later operation is expressed in terms of the
    // original draft identity and must reference that object's final name.
    // Mapping step.from -> step.to would leave `city -> dbx_tmp_...` after a
    // swap and make ALTER ATTRIBUTE / COMMENT ON COLUMN target a name that no
    // longer exists once the rename sequence finishes.
    for (original, final_name) in &renames {
        resolved.insert(original.clone(), final_name.clone());
    }
    let live_types = snapshot
        .members
        .iter()
        .map(|member| (member.name.clone(), member.data_type.clone()))
        .collect::<BTreeMap<_, _>>();
    let live_comments =
        snapshot.members.iter().map(|member| (member.name.clone(), member.comment.clone())).collect::<BTreeMap<_, _>>();
    for attribute in attributes {
        let Some(original) = attribute.original_name.as_deref() else {
            continue;
        };
        let Some(current) = resolved.get(original) else {
            continue;
        };
        let Some(live_type) = live_types.get(original) else {
            continue;
        };
        if canonical_expression(live_type) == canonical_expression(&attribute.data_type) {
            continue;
        }
        if builder.require(
            capabilities,
            CustomTypeOperation::AlterCompositeAlterAttributeType,
            PATH,
            "Changing a composite attribute's type is not verified on this connection.",
        ) {
            builder.warn(
                "composite.alter_attribute_type",
                PATH,
                format!(
                    "Attribute \"{current}\" changes type; existing values must be castable to {}.",
                    attribute.data_type.trim()
                ),
            );
            builder.push(postgres::alter_composite_alter_attribute_type(schema, name, current, &attribute.data_type));
        }
    }
    for attribute in attributes {
        if attribute.original_name.is_some() {
            continue;
        }
        if builder.require(
            capabilities,
            CustomTypeOperation::AlterCompositeAddAttribute,
            PATH,
            "Adding composite attributes is not verified on this connection.",
        ) {
            builder.push(postgres::alter_composite_add_attribute(
                schema,
                name,
                attribute.name.as_str(),
                &attribute.data_type,
            ));
        }
    }

    // Attribute comments are written against the final attribute names, and
    // only when they actually differ from the catalog.
    for attribute in attributes {
        let final_attribute = match attribute.original_name.as_deref() {
            Some(original) => resolved.get(original).map(String::as_str).unwrap_or(original),
            None => attribute.name.as_str(),
        };
        let live_comment = attribute
            .original_name
            .as_deref()
            .and_then(|original| live_comments.get(original))
            .and_then(|comment| comment.clone());
        let draft_comment = normalize_comment(attribute.comment.as_deref()).map(str::to_string);
        if attribute.original_name.is_some() && live_comment == draft_comment {
            continue;
        }
        if attribute.original_name.is_none() && draft_comment.is_none() {
            continue;
        }
        builder.push(postgres::comment_on_composite_attribute(schema, name, final_attribute, draft_comment.as_deref()));
    }
}

fn validate_attributes(attributes: &[CustomTypeAttributeDraft]) -> Result<(), String> {
    let mut names = BTreeSet::new();
    for attribute in attributes {
        let name = attribute.name.as_str();
        if name.is_empty() {
            return Err("Every attribute needs a name.".to_string());
        }
        if attribute.data_type.trim().is_empty() {
            return Err(format!("Attribute \"{name}\" needs a data type."));
        }
        if !names.insert(name.to_string()) {
            return Err(format!("Duplicate attribute name: {name}"));
        }
    }
    let originals = attributes.iter().filter_map(|attribute| attribute.original_name.clone()).collect::<Vec<_>>();
    let unique_originals = originals.iter().cloned().collect::<BTreeSet<_>>();
    if unique_originals.len() != originals.len() {
        return Err("An attribute appears more than once in the draft.".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn plan_domain_diff(
    builder: &mut PlanBuilder,
    snapshot: &CustomTypeDetails,
    base_type: &str,
    collation: Option<&str>,
    default: Option<&str>,
    not_null: bool,
    constraints: &[CustomTypeDomainConstraintDraft],
    schema: &str,
    name: &str,
    capabilities: &CustomTypeManagementCapabilities,
) {
    // The base type and collation of a domain have no ALTER form; changing them
    // would need a rebuild of every dependent column, so the editor keeps them
    // read-only and the planner refuses the change instead of guessing.
    if let Some(live_base) = snapshot.properties.base_type.as_deref() {
        if canonical_expression(live_base) != canonical_expression(base_type) {
            builder.block(
                "domain.base_type_immutable",
                "definition.baseType",
                "A domain's base type cannot be changed after creation.",
            );
        }
    }
    if let (Some(live_collation), Some(draft_collation)) =
        (snapshot.properties.collation.as_deref(), collation.map(str::trim).filter(|value| !value.is_empty()))
    {
        if live_collation.trim() != draft_collation {
            builder.block(
                "domain.collation_immutable",
                "definition.collation",
                "A domain's collation cannot be changed after creation.",
            );
        }
    }
    const PATH: &str = "definition.constraints";
    if let Err(message) = validate_constraints(constraints) {
        builder.block("domain.invalid_constraints", PATH, message);
        return;
    }
    if !builder.blocked.is_empty() {
        return;
    }

    let live_default = normalize_comment(snapshot.properties.default.as_deref());
    let draft_default = normalize_comment(default);
    if live_default != draft_default
        && builder.require(
            capabilities,
            CustomTypeOperation::AlterDomainDefault,
            "definition.default",
            "Changing a domain's default is not verified on this connection.",
        )
    {
        match draft_default {
            Some(value) => builder.push(postgres::alter_domain_set_default(schema, name, value)),
            None => builder.push(postgres::alter_domain_drop_default(schema, name)),
        }
    }

    let live_not_null = snapshot.properties.not_null.unwrap_or(false);
    if live_not_null != not_null
        && builder.require(
            capabilities,
            CustomTypeOperation::AlterDomainNotNull,
            "definition.notNull",
            "Changing a domain's NOT NULL is not verified on this connection.",
        )
    {
        if not_null {
            builder.warn(
                "domain.set_not_null",
                "definition.notNull",
                "Setting NOT NULL validates every existing value and can lock the dependent columns.",
            );
        }
        builder.push(postgres::alter_domain_set_not_null(schema, name, not_null));
    }

    let live_constraints = snapshot
        .properties
        .domain_constraints
        .iter()
        .map(|constraint| (constraint.name.clone(), constraint.definition.clone(), constraint.validated))
        .collect::<Vec<_>>();
    let live_names = live_constraints.iter().map(|(constraint, _, _)| constraint.clone()).collect::<BTreeSet<_>>();
    let draft_originals =
        constraints.iter().filter_map(|constraint| constraint.original_name.clone()).collect::<BTreeSet<_>>();

    for constraint in constraints {
        if let Some(original) = constraint.original_name.as_deref() {
            if !live_names.contains(original) {
                builder.block(
                    "domain.unknown_original_constraint",
                    "definition.constraints",
                    format!("Constraint \"{original}\" no longer exists. Refresh the type before saving."),
                );
            }
        }
    }
    if !builder.blocked.is_empty() {
        return;
    }

    // Three groups, planned in an order that makes every statement valid when it
    // runs:
    //
    //   1. drops  — replaced (expression changed) and removed constraints
    //   2. renames— only the constraints that survive with a new name
    //   3. adds   — the replacement bodies and the genuinely new constraints
    //
    // A constraint whose body changed is dropped and re-added rather than
    // renamed, because PostgreSQL has no "replace constraint expression". Its
    // re-add already carries the final name, so it must stay out of the rename
    // group: renaming first and then dropping the old name would fail.
    struct ConstraintPlan {
        original: Option<String>,
        final_name: String,
        expression: String,
        validated: Option<bool>,
        live_definition: Option<String>,
        live_validated: Option<bool>,
        replaced: bool,
    }

    let mut plans = Vec::with_capacity(constraints.len());
    for constraint in constraints {
        let original = constraint.original_name.clone();
        let live =
            original.as_deref().and_then(|name| live_constraints.iter().find(|(live_name, _, _)| live_name == name));
        let replaced = match (live, original.as_deref()) {
            (Some((_, live_definition, _)), Some(_)) => {
                canonical_check_expression(live_definition) != canonical_check_expression(&constraint.expression)
            }
            _ => false,
        };
        plans.push(ConstraintPlan {
            original,
            final_name: constraint.name.as_str().to_string(),
            expression: constraint.expression.clone(),
            validated: constraint.validated,
            live_definition: live.map(|(_, definition, _)| definition.clone()),
            live_validated: live.and_then(|(_, _, validated)| *validated),
            replaced,
        });
    }

    let removed = live_constraints
        .iter()
        .filter(|(live_name, _, _)| !draft_originals.contains(live_name))
        .map(|(live_name, _, _)| live_name.clone())
        .collect::<Vec<_>>();

    // --- 1. drops -----------------------------------------------------------
    let replaced_names =
        plans.iter().filter(|plan| plan.replaced).filter_map(|plan| plan.original.clone()).collect::<Vec<_>>();
    if (!removed.is_empty() || !replaced_names.is_empty())
        && !builder.require(
            capabilities,
            CustomTypeOperation::AlterDomainDropConstraint,
            "definition.constraints",
            "Dropping or replacing domain constraints is not verified on this connection.",
        )
    {
        return;
    }
    if !replaced_names.is_empty()
        && !builder.require(
            capabilities,
            CustomTypeOperation::AlterDomainAddConstraint,
            "definition.constraints",
            "Replacing a domain constraint is not verified on this connection.",
        )
    {
        return;
    }
    for name_to_drop in replaced_names.iter().chain(removed.iter()) {
        if replaced_names.contains(name_to_drop) {
            builder.destructive(
                "domain.replace_constraint",
                "definition.constraints",
                format!("Constraint \"{name_to_drop}\" is dropped and re-created with a new definition."),
            );
        } else {
            builder.destructive(
                "domain.drop_constraint",
                "definition.constraints",
                format!("Constraint \"{name_to_drop}\" is dropped."),
            );
        }
        builder.push(postgres::alter_domain_drop_constraint(schema, name, name_to_drop));
    }

    // --- 2. renames ---------------------------------------------------------
    // Only constraints that keep their body and change their name. The occupied
    // set excludes everything dropped above, because those names are free by the
    // time the renames run.
    let rename_occupied = live_constraints
        .iter()
        .map(|(live_name, _, _)| live_name.clone())
        .filter(|live_name| !removed.contains(live_name) && !replaced_names.contains(live_name))
        .collect::<BTreeSet<_>>();
    let renames = plans
        .iter()
        .filter(|plan| !plan.replaced)
        .filter_map(|plan| {
            let original = plan.original.as_deref()?;
            (plan.final_name != original).then(|| (original.to_string(), plan.final_name.clone()))
        })
        .collect::<Vec<_>>();
    let Some(rename_steps) = order_renames(builder, &renames, &rename_occupied, "definition.constraints", "constraint")
    else {
        return;
    };
    if !rename_steps.is_empty()
        && !builder.require(
            capabilities,
            CustomTypeOperation::AlterDomainRenameConstraint,
            "definition.constraints",
            "Renaming domain constraints is not verified on this connection.",
        )
    {
        return;
    }
    let mut resolved_names = BTreeMap::new();
    for step in &rename_steps {
        builder.push(postgres::alter_domain_rename_constraint(schema, name, &step.from, &step.to));
    }
    // As with composite attributes, transient step names are not object
    // identities. Validation must target the final name associated with each
    // original constraint, never a cycle-breaking temporary name.
    for (original, final_name) in &renames {
        resolved_names.insert(original.clone(), final_name.clone());
    }

    // --- 3. adds, then validation ------------------------------------------
    for plan in &plans {
        let Some(original) = plan.original.as_deref() else {
            // A brand new constraint.
            if builder.require(
                capabilities,
                CustomTypeOperation::AlterDomainAddConstraint,
                "definition.constraints",
                "Adding domain constraints is not verified on this connection.",
            ) {
                builder.push(postgres::alter_domain_add_constraint(
                    schema,
                    name,
                    &plan.final_name,
                    &plan.expression,
                    plan.validated,
                ));
            }
            continue;
        };

        if plan.replaced {
            builder.push(postgres::alter_domain_add_constraint(
                schema,
                name,
                &plan.final_name,
                &plan.expression,
                plan.validated,
            ));
            continue;
        }

        // PostgreSQL can only move a constraint from NOT VALID to validated;
        // there is no statement that un-validates one. Saying so is better than
        // accepting the toggle and then planning nothing.
        if plan.live_validated == Some(true) && plan.validated == Some(false) {
            builder.block(
                "domain.unvalidate_constraint_unsupported",
                "definition.constraints",
                format!(
                    "Constraint \"{original}\" is already validated; PostgreSQL cannot mark a constraint NOT VALID again."
                ),
            );
            continue;
        }
        let resolved = resolved_names.get(original).cloned().unwrap_or_else(|| original.to_string());
        if plan.live_validated == Some(false)
            && plan.validated == Some(true)
            && builder.require(
                capabilities,
                CustomTypeOperation::AlterDomainValidateConstraint,
                "definition.constraints",
                "Validating a domain constraint is not verified on this connection.",
            )
        {
            builder.push(postgres::alter_domain_validate_constraint(schema, name, &resolved));
        }
        // `live_definition` is kept on the plan for diagnostics; the comparison
        // itself already happened when `replaced` was decided.
        let _ = &plan.live_definition;
    }
}

/// Cheap structural checks for a domain's constraint list.
///
/// Fragment validity (a statement terminator, a comment, an unbalanced quote) is
/// checked separately in [`validate_definition_fragments`], because that question
/// applies to every kind's expression fields.
fn validate_constraints(constraints: &[CustomTypeDomainConstraintDraft]) -> Result<(), String> {
    let mut names = BTreeSet::new();
    for constraint in constraints {
        let name = constraint.name.as_str();
        if name.is_empty() {
            return Err("Every constraint needs a name.".to_string());
        }
        if constraint.expression.trim().is_empty() {
            return Err(format!("Constraint \"{name}\" needs a CHECK expression."));
        }
        if !names.insert(name.to_string()) {
            return Err(format!("Duplicate constraint name: {name}"));
        }
    }
    let originals = constraints.iter().filter_map(|constraint| constraint.original_name.clone()).collect::<Vec<_>>();
    if originals.iter().cloned().collect::<BTreeSet<_>>().len() != originals.len() {
        return Err("A constraint appears more than once in the draft.".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn plan_range_diff(
    builder: &mut PlanBuilder,
    snapshot: &CustomTypeDetails,
    subtype: &str,
    subtype_opclass: Option<&str>,
    canonical: Option<&str>,
    subtype_diff: Option<&str>,
    multirange_name: Option<&str>,
    _capabilities: &CustomTypeManagementCapabilities,
) {
    // PostgreSQL has no ALTER for any of these; the editor keeps them read-only.
    // A value the UI did not send (`None`) means "unchanged", not "clear it".
    let immutable = [
        ("definition.subtype", "subtype", snapshot.properties.range_subtype.as_deref(), Some(subtype)),
        (
            "definition.subtypeOpclass",
            "subtype_opclass",
            snapshot.properties.range_subtype_opclass.as_deref(),
            subtype_opclass,
        ),
        (
            "definition.canonicalFunction",
            "canonical",
            snapshot.properties.range_canonical_function.as_deref(),
            canonical,
        ),
        (
            "definition.subtypeDiffFunction",
            "subtype_diff",
            snapshot.properties.range_subtype_diff_function.as_deref(),
            subtype_diff,
        ),
    ];
    for (path, label, live, draft) in immutable {
        let Some(draft) = draft.map(str::trim).filter(|value| !value.is_empty()) else {
            continue;
        };
        let live_normalized = live.map(canonical_expression).unwrap_or_default();
        if live_normalized != canonical_expression(draft) {
            builder.block(
                "range.definition_immutable",
                path,
                format!("A range type's {label} cannot be changed after creation."),
            );
        }
    }
    // This field is a raw catalog identifier, not a SQL expression. Whitespace
    // and case are part of the companion's identity.
    if let Some(name) = multirange_name.filter(|value| !value.is_empty()) {
        if snapshot.properties.range_multirange_name.as_deref() != Some(name) {
            builder.block(
                "range.definition_immutable",
                "definition.multirangeName",
                "A range type's multirange_type_name cannot be changed after creation.",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn normalize_comment(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn first_duplicate<'a>(values: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut seen = BTreeSet::new();
    for value in values {
        if !seen.insert(value.to_string()) {
            return Some(value.to_string());
        }
    }
    None
}
