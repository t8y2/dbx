use crate::docs::hue_to_hex;
use crate::docs::{
    Cardinality, DocEnum, DocTable, FieldRef, Relationship, SchemaSnapshot, SnapshotWarning, TableGroup,
};
use crate::types::{ColumnInfo, IndexInfo};

/// DBML accepts bare identifiers matching `[A-Za-z_][A-Za-z0-9_]*`;
/// everything else needs double quotes.
pub(crate) fn quote_identifier(value: &str) -> String {
    let plain = !value.is_empty()
        && value.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');

    if plain {
        value.to_string()
    } else {
        format!("\"{}\"", value.replace('"', "\\\""))
    }
}

/// `schema.name` when qualifying, bare `name` otherwise. Both parts quoted
/// independently so an irregular schema or table name is handled correctly.
pub(crate) fn qualified(schema: Option<&str>, name: &str, qualify: bool) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(schema) if qualify => format!("{}.{}", quote_identifier(schema), quote_identifier(name)),
        _ => quote_identifier(name),
    }
}

/// Notes always use triple quotes so an apostrophe in prose can never break
/// the file.
///
/// Two things need escaping. A literal `'''` inside the prose, obviously —
/// and also a SINGLE trailing quote, which is subtler: the note `he said '`
/// would otherwise render as `'''he said ''''`, four quotes in a row, and a
/// parser scanning for the closing `'''` would close early and strand the
/// fourth. DBML honours `\'` inside triple quotes.
pub(crate) fn render_note(value: &str) -> String {
    let escaped = value.replace("'''", "\\'''");
    let escaped = match escaped.strip_suffix('\'') {
        Some(head) => format!("{head}\\'"),
        None => escaped,
    };
    format!("'''{escaped}'''")
}

fn looks_like_expression(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2 {
        return false;
    }
    if trimmed.parse::<f64>().is_ok() {
        return false;
    }
    if matches!(trimmed.to_ascii_lowercase().as_str(), "true" | "false" | "null") {
        return false;
    }
    true
}

/// `default: …` for a column, or None when it has no default.
/// Expressions go in backticks, literals stay as written.
pub(crate) fn render_default(column: &ColumnInfo) -> Option<String> {
    let value = column.column_default.as_deref()?.trim();
    if value.is_empty() {
        return None;
    }

    if looks_like_expression(value) {
        Some(format!("default: `{value}`"))
    } else {
        Some(format!("default: {value}"))
    }
}

/// True when `data_type` is MySQL's inline `ENUM(...)` spelling rather than
/// a genuine named type. PostgreSQL reports a named enum type's own
/// identifier in `data_type` instead (e.g. `"ConversationStatus"`) — only
/// the inline MySQL spelling needs a synthesized name.
pub(crate) fn is_inline_enum_spelling(data_type: &str) -> bool {
    let trimmed = data_type.trim();
    trimmed.get(..5).is_some_and(|prefix| prefix.eq_ignore_ascii_case("enum(")) && trimmed.ends_with(')')
}

/// PostgreSQL's `format_type` double-quotes an identifier that needs it
/// (e.g. `"ConversationStatus"`); strip that quoting so the bare name can be
/// used as a DBML identifier directly — `quote_identifier` re-quotes it if
/// DBML itself requires that.
pub(crate) fn unquote_pg_identifier(value: &str) -> String {
    let trimmed = value.trim();
    match trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        true => trimmed[1..trimmed.len() - 1].replace("\"\"", "\""),
        false => trimmed.to_string(),
    }
}

/// The enum name a column's `enum_values` refers to: the synthesized
/// `{table}_{column}` name for MySQL's inline `ENUM(...)` columns, or the
/// native type name for a genuine named enum type (e.g. PostgreSQL).
///
/// This is the single source of truth for that name — `synthesize_enum`
/// (collector) and `render_type` (below) both go through it, so a column's
/// type reference and its `Enum` block name can never drift apart again.
pub(crate) fn enum_type_name(column: &ColumnInfo, table_name: &str) -> String {
    if is_inline_enum_spelling(&column.data_type) {
        format!("{table_name}_{}", column.name)
    } else {
        unquote_pg_identifier(&column.data_type)
    }
}

/// DBML does not validate type names, so native types pass through intact.
/// Precision is reconstructed only when the engine reported a bare type.
pub(crate) fn render_type(column: &ColumnInfo, table_schema: Option<&str>, table_name: &str, qualify: bool) -> String {
    // A column carrying enum values is emitted as a named enum elsewhere in
    // the document. This must produce the SAME string `render_enum` produces
    // for that block — including schema qualification — or the reference
    // dangles and the Enum block becomes an orphan.
    if column.enum_values.as_ref().is_some_and(|values| !values.is_empty()) {
        return qualified(table_schema, &enum_type_name(column, table_name), qualify);
    }

    let base = column.data_type.trim();
    if base.contains('(') {
        return base.to_string();
    }

    if let Some(length) = column.character_maximum_length.filter(|value| *value > 0) {
        return format!("{base}({length})");
    }

    if let Some(precision) = column.numeric_precision.filter(|value| *value > 0) {
        return match column.numeric_scale {
            Some(scale) if scale > 0 => format!("{base}({precision},{scale})"),
            _ => format!("{base}({precision})"),
        };
    }

    base.to_string()
}

fn column_settings(column: &ColumnInfo, table: &DocTable) -> Vec<String> {
    let mut settings = Vec::new();

    if column.is_primary_key {
        settings.push("pk".to_string());
    }

    let extra = column.extra.as_deref().unwrap_or("").to_ascii_lowercase();
    if extra.contains("auto_increment") || extra.contains("identity") {
        settings.push("increment".to_string());
    }

    if !column.is_nullable && !column.is_primary_key {
        settings.push("not null".to_string());
    }

    if let Some(default) = render_default(column) {
        settings.push(default);
    }

    if let Some(note) = table.column_notes.get(&column.name) {
        settings.push(format!("note: {}", render_note(&note.note)));
    } else if let Some(comment) = column.comment.as_deref().filter(|value| !value.trim().is_empty()) {
        settings.push(format!("note: {}", render_note(comment)));
    }

    settings
}

fn render_index(index: &IndexInfo) -> String {
    let columns = index.columns.iter().map(|c| quote_identifier(c)).collect::<Vec<_>>().join(", ");

    let mut settings = vec![format!("name: '{}'", index.name.replace('\'', "\\'"))];
    if index.is_unique {
        settings.push("unique".to_string());
    }

    format!("    ({columns}) [{}]\n", settings.join(", "))
}

/// Render one `Table` block.
///
/// The primary-key index is skipped because columns already carry `pk`.
/// Indexes DBML cannot express are skipped and recorded in `warnings`
/// rather than dropped silently.
pub(crate) fn render_table(table: &DocTable, qualify: bool, warnings: &mut Vec<SnapshotWarning>) -> String {
    let name = qualified(table.schema.as_deref(), &table.name, qualify);

    let mut out = format!("Table {name} {{\n");

    for column in &table.columns {
        let settings = column_settings(column, table);
        let rendered_settings = if settings.is_empty() { String::new() } else { format!(" [{}]", settings.join(", ")) };
        out.push_str(&format!(
            "  {} {}{}\n",
            quote_identifier(&column.name),
            render_type(column, table.schema.as_deref(), &table.name, qualify),
            rendered_settings
        ));
    }

    let emittable: Vec<&IndexInfo> = table
        .indexes
        .iter()
        .filter(|index| {
            if index.is_primary {
                return false;
            }
            if index.filter.as_deref().is_some_and(|f| !f.trim().is_empty()) {
                warnings.push(SnapshotWarning::DbmlOmitted {
                    table: table.qualified_name(),
                    item: index.name.clone(),
                    reason: "partial index filter has no DBML equivalent".to_string(),
                });
                return false;
            }
            if index.included_columns.as_ref().is_some_and(|columns| !columns.is_empty()) {
                warnings.push(SnapshotWarning::DbmlOmitted {
                    table: table.qualified_name(),
                    item: index.name.clone(),
                    reason: "included columns have no DBML equivalent".to_string(),
                });
                return false;
            }
            !index.columns.is_empty()
        })
        .collect();

    if !emittable.is_empty() {
        out.push_str("\n  Indexes {\n");
        for index in emittable {
            out.push_str(&render_index(index));
        }
        out.push_str("  }\n");
    }

    if let Some(note) = table.note.as_deref().filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!("\n  Note: {}\n", render_note(note)));
    }

    out.push_str("}\n");
    out
}

fn qualified_field(field: &FieldRef, qualify: bool) -> String {
    let table = qualified(field.schema.as_deref(), &field.table, qualify);
    format!("{table}.{}", quote_identifier(&field.column))
}

/// One `Ref` line. `>` is many-to-one, `-` is one-to-one.
pub(crate) fn render_ref(relationship: &Relationship, qualify: bool) -> String {
    let operator = match relationship.cardinality {
        Cardinality::ManyToOne => ">",
        Cardinality::OneToOne => "-",
    };

    let mut actions = Vec::new();
    if let Some(update) = relationship.on_update.as_deref().filter(|v| !v.trim().is_empty()) {
        actions.push(format!("update: {}", update.to_lowercase()));
    }
    if let Some(delete) = relationship.on_delete.as_deref().filter(|v| !v.trim().is_empty()) {
        actions.push(format!("delete: {}", delete.to_lowercase()));
    }
    let settings = if actions.is_empty() { String::new() } else { format!(" [{}]", actions.join(", ")) };

    let label = match relationship.name.as_deref().filter(|v| !v.trim().is_empty()) {
        Some(name) => format!("Ref {}", quote_identifier(name)),
        None => "Ref".to_string(),
    };

    format!(
        "{label}: {} {operator} {}{settings}\n",
        qualified_field(&relationship.from, qualify),
        qualified_field(&relationship.to, qualify)
    )
}

pub(crate) fn render_enum(value: &DocEnum, qualify: bool) -> String {
    let name = qualified(value.schema.as_deref(), &value.name, qualify);

    let mut out = format!("Enum {name} {{\n");
    for variant in &value.values {
        out.push_str(&format!("  {}\n", quote_identifier(variant)));
    }
    if let Some(note) = value.note.as_deref().filter(|v| !v.trim().is_empty()) {
        out.push_str(&format!("\n  Note: {}\n", render_note(note)));
    }
    out.push_str("}\n");
    out
}

/// A `TableGroup` block. Returns an empty string when the group has no
/// members, since DBML rejects an empty group body.
pub(crate) fn render_group(group: &TableGroup, members: &[&DocTable], qualify: bool) -> String {
    if members.is_empty() {
        return String::new();
    }

    let mut out = format!("TableGroup {} [color: {}] {{\n", quote_identifier(&group.name), hue_to_hex(group.hue));

    for member in members {
        let name = qualified(member.schema.as_deref(), &member.name, qualify);
        out.push_str(&format!("  {name}\n"));
    }

    if let Some(note) = group.note.as_deref().filter(|v| !v.trim().is_empty()) {
        out.push_str(&format!("\n  Note: {}\n", render_note(note)));
    }

    out.push_str("}\n");
    out
}

/// DBML text plus every construct that could not be represented in it.
#[derive(Debug, Clone)]
pub struct DbmlOutput {
    pub text: String,
    pub warnings: Vec<SnapshotWarning>,
}

fn render_project(snapshot: &SchemaSnapshot) -> String {
    let mut out = format!("Project {} {{\n", quote_identifier(&snapshot.project.name));
    out.push_str(&format!("  database_type: '{}'\n", snapshot.project.database_type.replace('\'', "\\'")));
    if let Some(note) = snapshot.project.note.as_deref().filter(|v| !v.trim().is_empty()) {
        out.push_str(&format!("  Note: {}\n", render_note(note)));
    }
    out.push_str("}\n");
    out
}

/// Serialize a snapshot to DBML.
///
/// DBML is an interchange format, not a backup: check constraints, partial
/// indexes, included columns, collations and generated columns have no
/// representation. Each omission is reported in `warnings` so the HTML
/// documentation — which *is* the complete record — can mark it.
pub fn to_dbml(snapshot: &SchemaSnapshot) -> DbmlOutput {
    let qualify = snapshot.project.schemas.len() > 1;
    // Start from the collector's warnings so omissions discovered at collection
    // time (skipped tables, unsupported comments) survive into the output
    // alongside those discovered while rendering.
    let mut warnings = snapshot.warnings.clone();
    let mut sections: Vec<String> = vec![render_project(snapshot)];

    for value in &snapshot.enums {
        sections.push(render_enum(value, qualify));
    }

    for group in &snapshot.groups {
        let members: Vec<&DocTable> =
            snapshot.tables.iter().filter(|table| table.group_id.as_deref() == Some(group.id.as_str())).collect();
        let rendered = render_group(group, &members, qualify);
        if !rendered.is_empty() {
            sections.push(rendered);
        }
    }

    for table in &snapshot.tables {
        sections.push(render_table(table, qualify, &mut warnings));
    }

    if !snapshot.relationships.is_empty() {
        let refs: String = snapshot.relationships.iter().map(|rel| render_ref(rel, qualify)).collect();
        sections.push(refs);
    }

    DbmlOutput { text: sections.join("\n"), warnings }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ColumnInfo;

    fn col(name: &str, data_type: &str) -> ColumnInfo {
        ColumnInfo { name: name.to_string(), data_type: data_type.to_string(), ..ColumnInfo::default() }
    }

    #[test]
    fn plain_identifiers_are_not_quoted() {
        assert_eq!(quote_identifier("orders"), "orders");
        assert_eq!(quote_identifier("order_items"), "order_items");
        assert_eq!(quote_identifier("_private"), "_private");
        assert_eq!(quote_identifier("t2"), "t2");
    }

    #[test]
    fn irregular_identifiers_are_quoted() {
        assert_eq!(quote_identifier("order items"), "\"order items\"");
        assert_eq!(quote_identifier("2fast"), "\"2fast\"");
        assert_eq!(quote_identifier("user-profile"), "\"user-profile\"");
        assert_eq!(quote_identifier(""), "\"\"");
    }

    #[test]
    fn embedded_double_quotes_are_escaped() {
        assert_eq!(quote_identifier("we\"ird"), "\"we\\\"ird\"");
    }

    #[test]
    fn notes_always_use_triple_quotes_so_apostrophes_are_safe() {
        assert_eq!(render_note("Bob's orders"), "'''Bob's orders'''");
    }

    #[test]
    fn notes_escape_a_literal_triple_quote() {
        assert_eq!(render_note("a ''' b"), "'''a \\''' b'''");
    }

    #[test]
    fn multiline_notes_are_preserved() {
        assert_eq!(render_note("line one\nline two"), "'''line one\nline two'''");
    }

    #[test]
    fn a_note_ending_in_a_single_quote_does_not_break_the_delimiter() {
        // Without escaping this yields four quotes in a row and a parser
        // closes the string early.
        assert_eq!(render_note("Deprecated in '24'"), "'''Deprecated in '24\\''''");
    }

    #[test]
    fn expression_defaults_use_backticks_and_literals_use_quotes() {
        let mut expression = col("created_at", "timestamptz");
        expression.column_default = Some("now()".to_string());
        assert_eq!(render_default(&expression).as_deref(), Some("default: `now()`"));

        let mut sequence = col("id", "integer");
        sequence.column_default = Some("nextval('orders_id_seq'::regclass)".to_string());
        assert_eq!(render_default(&sequence).as_deref(), Some("default: `nextval('orders_id_seq'::regclass)`"));

        let mut literal = col("status", "text");
        literal.column_default = Some("'pending'".to_string());
        assert_eq!(render_default(&literal).as_deref(), Some("default: 'pending'"));

        let mut number = col("qty", "integer");
        number.column_default = Some("0".to_string());
        assert_eq!(render_default(&number).as_deref(), Some("default: 0"));

        let mut boolean = col("active", "boolean");
        boolean.column_default = Some("true".to_string());
        assert_eq!(render_default(&boolean).as_deref(), Some("default: true"));

        assert_eq!(render_default(&col("plain", "text")), None);
    }

    #[test]
    fn types_pass_through_verbatim_when_already_parameterised() {
        assert_eq!(render_type(&col("total", "numeric(10,2)"), None, "orders", false), "numeric(10,2)");
        assert_eq!(render_type(&col("meta", "jsonb"), None, "orders", false), "jsonb");
        assert_eq!(
            render_type(&col("at", "timestamp with time zone"), None, "orders", false),
            "timestamp with time zone"
        );
    }

    #[test]
    fn bare_types_are_reconstructed_from_precision_metadata() {
        let mut varchar = col("email", "character varying");
        varchar.character_maximum_length = Some(255);
        assert_eq!(render_type(&varchar, None, "orders", false), "character varying(255)");

        let mut decimal = col("total", "numeric");
        decimal.numeric_precision = Some(10);
        decimal.numeric_scale = Some(2);
        assert_eq!(render_type(&decimal, None, "orders", false), "numeric(10,2)");

        let mut integer = col("count", "numeric");
        integer.numeric_precision = Some(8);
        integer.numeric_scale = Some(0);
        assert_eq!(render_type(&integer, None, "orders", false), "numeric(8)");
    }

    #[test]
    fn an_inline_enum_column_references_the_synthesized_enum_name() {
        let mut status = col("status", "enum('pending','shipped')");
        status.enum_values = Some(vec!["pending".to_string(), "shipped".to_string()]);
        assert_eq!(render_type(&status, None, "orders", false), "orders_status");
    }

    #[test]
    fn a_named_enum_type_column_references_its_own_native_name_not_a_synthesized_one() {
        // PostgreSQL reports the enum's own type name in `data_type` rather
        // than an inline `ENUM(...)` spelling — that native name must be
        // used verbatim, not the `{table}_{column}` scheme MySQL needs.
        let mut status = col("status", "ConversationStatus");
        status.enum_values = Some(vec!["open".to_string(), "closed".to_string()]);
        assert_eq!(render_type(&status, None, "conversations", false), "ConversationStatus");
    }

    #[test]
    fn a_quoted_native_enum_type_name_is_unquoted_for_the_reference() {
        // `format_type` double-quotes an identifier that needs it (mixed
        // case, here). The DBML reference must be the bare name so
        // `quote_identifier` can decide on its own quoting.
        let mut status = col("status", "\"ConversationStatus\"");
        status.enum_values = Some(vec!["open".to_string()]);
        assert_eq!(render_type(&status, None, "conversations", false), "ConversationStatus");
    }

    #[test]
    fn a_multi_schema_enum_reference_is_qualified_like_its_enum_block() {
        let mut status = col("status", "enum('pending','shipped')");
        status.enum_values = Some(vec!["pending".to_string(), "shipped".to_string()]);

        // qualify=true is what to_dbml sets for a multi-schema snapshot. The
        // column's type must match render_enum's block name exactly, or the
        // reference dangles.
        let reference = render_type(&status, Some("public"), "orders", true);

        let block = DocEnum {
            schema: Some("public".to_string()),
            name: "orders_status".to_string(),
            values: vec!["pending".to_string()],
            note: None,
            synthesized: true,
        };
        let rendered_block = render_enum(&block, true);

        // Anchored, not `contains`: a bare unqualified reference is a substring
        // of the qualified block name, so `contains` would pass against the very
        // bug this test exists to catch.
        assert!(
            rendered_block.starts_with(&format!("Enum {reference} {{\n")),
            "column reference `{reference}` must be exactly the Enum block name in:\n{rendered_block}"
        );
    }

    use crate::docs::{ColumnNote, DocTable, NoteSource, SnapshotWarning, TableKind};
    use crate::types::IndexInfo;
    use std::collections::BTreeMap;

    fn doc_table(name: &str, columns: Vec<ColumnInfo>, indexes: Vec<IndexInfo>) -> DocTable {
        DocTable {
            schema: Some("public".to_string()),
            name: name.to_string(),
            kind: TableKind::Table,
            columns,
            indexes,
            foreign_keys: vec![],
            group_id: None,
            note: None,
            note_source: NoteSource::None,
            shadowed_note: None,
            column_notes: BTreeMap::new(),
            estimated_rows: None,
            view_definition: None,
        }
    }

    #[test]
    fn renders_a_table_with_columns_and_settings() {
        let mut id = col("id", "integer");
        id.is_primary_key = true;
        id.extra = Some("auto_increment".to_string());

        let mut user_id = col("user_id", "integer");
        user_id.is_nullable = false;

        // ColumnInfo::default() gives is_nullable=false (i.e. NOT NULL), so a
        // genuinely nullable column has to say so explicitly.
        let mut nullable = col("shipped_at", "timestamptz");
        nullable.is_nullable = true;

        let mut table = doc_table("orders", vec![id, user_id, nullable], vec![]);
        table.note = Some("Checkout rows.".to_string());
        table.column_notes.insert(
            "user_id".to_string(),
            ColumnNote { note: "Owning customer".to_string(), source: NoteSource::Local, shadowed: None },
        );

        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);

        assert!(out.starts_with("Table orders {\n"), "got:\n{out}");
        assert!(out.contains("id integer [pk, increment]"), "got:\n{out}");
        assert!(out.contains("user_id integer [not null, note: '''Owning customer''']"), "got:\n{out}");
        assert!(out.contains("shipped_at timestamptz\n"), "got:\n{out}");
        assert!(out.contains("Note: '''Checkout rows.'''"), "got:\n{out}");
        assert!(out.ends_with("}\n"), "got:\n{out}");
    }

    #[test]
    fn qualifies_the_table_name_when_requested() {
        let table = doc_table("orders", vec![col("id", "integer")], vec![]);
        let mut warnings = Vec::new();
        assert!(render_table(&table, true, &mut warnings).starts_with("Table public.orders {"));
    }

    #[test]
    fn renders_an_indexes_block() {
        let index = IndexInfo {
            name: "idx_orders_user_placed".to_string(),
            columns: vec!["user_id".to_string(), "placed_at".to_string()],
            is_unique: false,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let table = doc_table("orders", vec![col("user_id", "integer")], vec![index]);

        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);

        assert!(out.contains("Indexes {"), "got:\n{out}");
        assert!(out.contains("(user_id, placed_at) [name: 'idx_orders_user_placed']"), "got:\n{out}");
        assert!(warnings.is_empty());
    }

    #[test]
    fn a_unique_index_carries_the_unique_setting() {
        let index = IndexInfo {
            name: "uq_orders_ref".to_string(),
            columns: vec!["reference".to_string()],
            is_unique: true,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let table = doc_table("orders", vec![col("reference", "text")], vec![index]);
        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);
        assert!(out.contains("(reference) [name: 'uq_orders_ref', unique]"), "got:\n{out}");
    }

    #[test]
    fn the_primary_key_index_is_skipped_because_columns_already_carry_pk() {
        let index = IndexInfo {
            name: "orders_pkey".to_string(),
            columns: vec!["id".to_string()],
            is_unique: true,
            is_primary: true,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let mut id = col("id", "integer");
        id.is_primary_key = true;
        let table = doc_table("orders", vec![id], vec![index]);

        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);
        assert!(!out.contains("orders_pkey"), "got:\n{out}");
    }

    #[test]
    fn a_filtered_index_is_omitted_and_warned_about() {
        let index = IndexInfo {
            name: "idx_orders_open".to_string(),
            columns: vec!["status".to_string()],
            is_unique: false,
            is_primary: false,
            filter: Some("status <> 'cancelled'".to_string()),
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let table = doc_table("orders", vec![col("status", "text")], vec![index]);

        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);

        assert!(!out.contains("idx_orders_open"), "filtered index must not be emitted, got:\n{out}");
        assert_eq!(warnings.len(), 1);
        match &warnings[0] {
            SnapshotWarning::DbmlOmitted { table, item, reason } => {
                assert_eq!(table, "public.orders");
                assert_eq!(item, "idx_orders_open");
                assert!(reason.contains("filter"), "got {reason}");
            }
            other => panic!("unexpected warning: {other:?}"),
        }
    }

    use crate::docs::{Cardinality, DocEnum, FieldRef, Relationship, TableGroup};

    fn relationship(cardinality: Cardinality) -> Relationship {
        Relationship {
            id: "r1".to_string(),
            name: Some("fk_orders_user".to_string()),
            from: FieldRef {
                schema: Some("public".to_string()),
                table: "orders".to_string(),
                column: "user_id".to_string(),
            },
            to: FieldRef { schema: Some("public".to_string()), table: "users".to_string(), column: "id".to_string() },
            cardinality,
            on_update: None,
            on_delete: Some("CASCADE".to_string()),
        }
    }

    #[test]
    fn many_to_one_uses_the_gt_operator() {
        let out = render_ref(&relationship(Cardinality::ManyToOne), false);
        assert_eq!(out, "Ref fk_orders_user: orders.user_id > users.id [delete: cascade]\n");
    }

    #[test]
    fn one_to_one_uses_the_dash_operator() {
        let out = render_ref(&relationship(Cardinality::OneToOne), false);
        assert!(out.contains("orders.user_id - users.id"), "got {out}");
    }

    #[test]
    fn refs_qualify_both_sides_together() {
        let out = render_ref(&relationship(Cardinality::ManyToOne), true);
        assert!(out.contains("public.orders.user_id > public.users.id"), "got {out}");
    }

    #[test]
    fn referential_actions_are_lowercased_and_both_emitted() {
        let mut rel = relationship(Cardinality::ManyToOne);
        rel.on_update = Some("NO ACTION".to_string());
        rel.on_delete = Some("RESTRICT".to_string());
        let out = render_ref(&rel, false);
        assert!(out.contains("[update: no action, delete: restrict]"), "got {out}");
    }

    #[test]
    fn an_unnamed_ref_omits_the_name() {
        let mut rel = relationship(Cardinality::ManyToOne);
        rel.name = None;
        assert!(render_ref(&rel, false).starts_with("Ref: orders.user_id"), "got {}", render_ref(&rel, false));
    }

    #[test]
    fn renders_an_enum_block() {
        let value = DocEnum {
            schema: Some("public".to_string()),
            name: "order_status".to_string(),
            values: vec!["pending".to_string(), "shipped".to_string()],
            note: None,
            synthesized: false,
        };
        let out = render_enum(&value, false);
        assert_eq!(out, "Enum order_status {\n  pending\n  shipped\n}\n");
    }

    #[test]
    fn renders_a_table_group_with_colour_and_note() {
        let group = TableGroup {
            id: "order-management".to_string(),
            name: "Order Management".to_string(),
            hue: 28,
            note: Some("Checkout to carrier handoff.".to_string()),
        };
        let orders = doc_table("orders", vec![], vec![]);
        let items = doc_table("order_items", vec![], vec![]);

        let out = render_group(&group, &[&orders, &items], false);

        assert!(out.starts_with("TableGroup \"Order Management\" [color: #"), "got:\n{out}");
        assert!(out.contains("\n  orders\n"), "got:\n{out}");
        assert!(out.contains("\n  order_items\n"), "got:\n{out}");
        assert!(out.contains("Note: '''Checkout to carrier handoff.'''"), "got:\n{out}");
    }

    #[test]
    fn an_empty_group_renders_nothing() {
        let group = TableGroup { id: "empty".to_string(), name: "Empty".to_string(), hue: 0, note: None };
        assert_eq!(render_group(&group, &[], false), "");
    }

    use crate::docs::{ProjectMeta, SchemaSnapshot};

    fn snapshot(tables: Vec<DocTable>, schemas: Vec<&str>) -> SchemaSnapshot {
        SchemaSnapshot {
            format_version: 1,
            project: ProjectMeta {
                name: "Ecommerce".to_string(),
                database_type: "PostgreSQL".to_string(),
                database: Some("shop".to_string()),
                schemas: schemas.into_iter().map(str::to_string).collect(),
                generated_at: "2026-08-02T12:00:00Z".to_string(),
                note: Some("Storefront database.".to_string()),
            },
            tables,
            relationships: vec![],
            groups: vec![],
            enums: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn emits_a_project_block_first() {
        let out = to_dbml(&snapshot(vec![], vec!["public"]));
        assert!(out.text.starts_with("Project Ecommerce {\n"), "got:\n{}", out.text);
        assert!(out.text.contains("database_type: 'PostgreSQL'"), "got:\n{}", out.text);
        assert!(out.text.contains("Note: '''Storefront database.'''"), "got:\n{}", out.text);
    }

    #[test]
    fn a_single_schema_snapshot_uses_bare_table_names() {
        let out = to_dbml(&snapshot(vec![doc_table("orders", vec![col("id", "integer")], vec![])], vec!["public"]));
        assert!(out.text.contains("Table orders {"), "got:\n{}", out.text);
        assert!(!out.text.contains("Table public.orders"), "got:\n{}", out.text);
    }

    #[test]
    fn a_multi_schema_snapshot_qualifies_every_table() {
        let mut analytics = doc_table("daily_sales", vec![col("id", "integer")], vec![]);
        analytics.schema = Some("analytics".to_string());

        let out = to_dbml(&snapshot(
            vec![doc_table("orders", vec![col("id", "integer")], vec![]), analytics],
            vec!["public", "analytics"],
        ));

        assert!(out.text.contains("Table public.orders {"), "got:\n{}", out.text);
        assert!(out.text.contains("Table analytics.daily_sales {"), "got:\n{}", out.text);
    }

    #[test]
    fn sections_appear_in_order_project_enums_groups_tables_refs() {
        let mut snap = snapshot(vec![doc_table("orders", vec![col("id", "integer")], vec![])], vec!["public"]);
        snap.enums.push(DocEnum {
            schema: Some("public".to_string()),
            name: "order_status".to_string(),
            values: vec!["pending".to_string()],
            note: None,
            synthesized: false,
        });
        snap.groups.push(TableGroup {
            id: "order-management".to_string(),
            name: "Order Management".to_string(),
            hue: 28,
            note: None,
        });
        snap.tables[0].group_id = Some("order-management".to_string());
        snap.relationships.push(relationship(Cardinality::ManyToOne));

        let text = to_dbml(&snap).text;
        let project = text.find("Project ").expect("project");
        let enum_at = text.find("Enum ").expect("enum");
        let group = text.find("TableGroup ").expect("group");
        let table = text.find("Table orders").expect("table");
        let reference = text.find("Ref ").expect("ref");

        assert!(project < enum_at, "project before enums:\n{text}");
        assert!(enum_at < group, "enums before groups:\n{text}");
        assert!(group < table, "groups before tables:\n{text}");
        assert!(table < reference, "tables before refs:\n{text}");
    }

    #[test]
    fn warnings_from_table_rendering_reach_the_output() {
        let index = IndexInfo {
            name: "idx_partial".to_string(),
            columns: vec!["status".to_string()],
            is_unique: false,
            is_primary: false,
            filter: Some("status <> 'x'".to_string()),
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let out =
            to_dbml(&snapshot(vec![doc_table("orders", vec![col("status", "text")], vec![index])], vec!["public"]));
        assert_eq!(out.warnings.len(), 1);
    }

    #[test]
    fn a_group_referencing_a_missing_table_is_skipped() {
        let mut snap = snapshot(vec![doc_table("orders", vec![col("id", "integer")], vec![])], vec!["public"]);
        snap.groups.push(TableGroup { id: "ghost".to_string(), name: "Ghost".to_string(), hue: 200, note: None });
        assert!(!to_dbml(&snap).text.contains("Ghost"), "got:\n{}", to_dbml(&snap).text);
    }

    #[test]
    fn collector_warnings_survive_into_the_output() {
        let mut snap = snapshot(vec![], vec!["public"]);
        snap.warnings.push(SnapshotWarning::TableSkipped {
            table: "public.secret".to_string(),
            reason: "permission denied".to_string(),
        });

        let out = to_dbml(&snap);

        assert_eq!(out.warnings.len(), 1, "collector warnings must not be dropped");
        match &out.warnings[0] {
            SnapshotWarning::TableSkipped { table, .. } => assert_eq!(table, "public.secret"),
            other => panic!("unexpected warning: {other:?}"),
        }
    }
}
