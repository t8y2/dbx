use std::collections::HashSet;

use crate::docs::{Cardinality, DocTable, FieldRef, Relationship};
use crate::types::ForeignKeyInfo;

/// True when `column` alone is guaranteed unique on `table` — either it is a
/// single-column primary key, or a single-column unique index covers it.
///
/// A composite unique index over (a, b) does NOT make `a` unique, which is
/// why the column count is checked.
fn column_is_unique(table: &DocTable, column: &str) -> bool {
    let primary_columns: Vec<&str> =
        table.columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.as_str()).collect();

    if primary_columns.len() == 1 && primary_columns[0] == column {
        return true;
    }

    table
        .indexes
        .iter()
        .any(|index| (index.is_unique || index.is_primary) && index.columns.len() == 1 && index.columns[0] == column)
}

fn cardinality_for(table: &DocTable, foreign_key: &ForeignKeyInfo) -> Cardinality {
    if column_is_unique(table, &foreign_key.column) {
        Cardinality::OneToOne
    } else {
        Cardinality::ManyToOne
    }
}

fn relationship_id(source: &DocTable, foreign_key: &ForeignKeyInfo) -> String {
    [
        source.qualified_name().as_str(),
        if foreign_key.name.is_empty() { "foreign_key" } else { foreign_key.name.as_str() },
        foreign_key.column.as_str(),
        foreign_key.ref_table.as_str(),
        foreign_key.ref_column.as_str(),
    ]
    .join(":")
}

/// Resolve a foreign key's target against the tables actually present.
///
/// Resolution order mirrors SQL's own: an explicit `ref_schema` wins; an
/// unqualified reference resolves inside the source table's own schema;
/// only then do we consider a bare-name match elsewhere — and an ambiguous
/// one is dropped rather than guessed at, because a wrong edge is worse
/// than a missing one.
fn find_target<'a>(tables: &'a [DocTable], source: &DocTable, foreign_key: &ForeignKeyInfo) -> Option<&'a DocTable> {
    // An explicit ref_schema is authoritative: the database told us exactly
    // which schema the key points at. If that schema was not collected, the
    // edge must be DROPPED, not resolved elsewhere. Falling through would bind
    // it to a same-named table in a different schema — `sales.orders` pointing
    // at `archive.customers` would render as pointing at `sales.customers`,
    // which is a confidently wrong diagram rather than an incomplete one.
    if let Some(ref_schema) = foreign_key.ref_schema.as_deref().filter(|s| !s.is_empty()) {
        return tables.iter().find(|t| t.name == foreign_key.ref_table && t.schema.as_deref() == Some(ref_schema));
    }

    if let Some(found) = tables.iter().find(|t| t.name == foreign_key.ref_table && t.schema == source.schema) {
        return Some(found);
    }

    let mut matches = tables.iter().filter(|t| t.name == foreign_key.ref_table);
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first)
}

/// Build the relationship set for a snapshot.
///
/// Foreign keys pointing at tables outside the collected set are dropped —
/// the target may live in a schema the user did not select, and a dangling
/// edge renders as a relationship to nothing.
pub fn build_relationships(tables: &[DocTable]) -> Vec<Relationship> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut relationships = Vec::new();

    for source in tables {
        for foreign_key in &source.foreign_keys {
            let Some(target) = find_target(tables, source, foreign_key) else { continue };

            if !source.columns.iter().any(|c| c.name == foreign_key.column) {
                continue;
            }

            let id = relationship_id(source, foreign_key);
            if !seen.insert(id.clone()) {
                continue;
            }

            relationships.push(Relationship {
                id,
                name: (!foreign_key.name.is_empty()).then(|| foreign_key.name.clone()),
                from: FieldRef {
                    schema: source.schema.clone(),
                    table: source.name.clone(),
                    column: foreign_key.column.clone(),
                },
                to: FieldRef {
                    schema: target.schema.clone(),
                    table: target.name.clone(),
                    column: foreign_key.ref_column.clone(),
                },
                cardinality: cardinality_for(source, foreign_key),
                on_update: foreign_key.on_update.clone(),
                on_delete: foreign_key.on_delete.clone(),
            });
        }
    }

    relationships
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::{NoteSource, TableKind};
    use crate::types::{ColumnInfo, ForeignKeyInfo, IndexInfo};
    use std::collections::BTreeMap;

    fn column(name: &str, primary: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: "integer".to_string(),
            is_nullable: false,
            is_primary_key: primary,
            ..ColumnInfo::default()
        }
    }

    fn fk(name: &str, column: &str, ref_table: &str, ref_column: &str) -> ForeignKeyInfo {
        ForeignKeyInfo {
            name: name.to_string(),
            column: column.to_string(),
            ref_schema: Some("public".to_string()),
            ref_table: ref_table.to_string(),
            ref_column: ref_column.to_string(),
            on_update: None,
            on_delete: Some("CASCADE".to_string()),
        }
    }

    fn table_in(schema: &str, name: &str, fks: Vec<ForeignKeyInfo>) -> DocTable {
        DocTable {
            schema: Some(schema.to_string()),
            name: name.to_string(),
            kind: TableKind::Table,
            columns: vec![column("id", true), column("customer_id", false)],
            indexes: Vec::new(),
            foreign_keys: fks,
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
    fn an_unresolvable_explicit_ref_schema_does_not_fall_back_to_another_schema() {
        // sales.orders -> archive.customers, but only the `sales` schema was
        // collected. `archive.customers` is absent, and `sales.customers`
        // exists with the same bare name. Falling through to the source-schema
        // tier would bind the edge to sales.customers — a different table than
        // the foreign key names — and render a plausible but wrong diagram.
        let mut fk = fk("orders_customer_fk", "customer_id", "customers", "id");
        fk.ref_schema = Some("archive".to_string());

        let tables = vec![table_in("sales", "orders", vec![fk]), table_in("sales", "customers", Vec::new())];

        let relationships = build_relationships(&tables);
        assert!(
            relationships.is_empty(),
            "expected the edge to be dropped, got {:?}",
            relationships.iter().map(|r| (&r.from.table, &r.to.table)).collect::<Vec<_>>()
        );
    }

    fn unique_index(name: &str, columns: &[&str]) -> IndexInfo {
        IndexInfo {
            name: name.to_string(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            is_unique: true,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        }
    }

    fn table(name: &str, columns: Vec<ColumnInfo>, indexes: Vec<IndexInfo>, fks: Vec<ForeignKeyInfo>) -> DocTable {
        DocTable {
            schema: Some("public".to_string()),
            name: name.to_string(),
            kind: TableKind::Table,
            columns,
            indexes,
            foreign_keys: fks,
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
    fn plain_foreign_key_is_many_to_one() {
        let tables = vec![
            table(
                "orders",
                vec![column("id", true), column("user_id", false)],
                vec![],
                vec![fk("fk_orders_user", "user_id", "users", "id")],
            ),
            table("users", vec![column("id", true)], vec![], vec![]),
        ];

        let rels = build_relationships(&tables);

        assert_eq!(rels.len(), 1);
        assert_eq!(rels[0].cardinality, Cardinality::ManyToOne);
        assert_eq!(rels[0].from.table, "orders");
        assert_eq!(rels[0].from.column, "user_id");
        assert_eq!(rels[0].to.table, "users");
        assert_eq!(rels[0].to.column, "id");
        assert_eq!(rels[0].on_delete.as_deref(), Some("CASCADE"));
    }

    #[test]
    fn foreign_key_on_a_unique_column_is_one_to_one() {
        let tables = vec![
            table(
                "shipments",
                vec![column("id", true), column("order_id", false)],
                vec![unique_index("uq_shipments_order", &["order_id"])],
                vec![fk("fk_shipments_order", "order_id", "orders", "id")],
            ),
            table("orders", vec![column("id", true)], vec![], vec![]),
        ];

        let rels = build_relationships(&tables);

        assert_eq!(rels.len(), 1);
        assert_eq!(rels[0].cardinality, Cardinality::OneToOne);
    }

    #[test]
    fn foreign_key_on_a_primary_key_column_is_one_to_one() {
        let tables = vec![
            table(
                "user_profiles",
                vec![column("user_id", true)],
                vec![],
                vec![fk("fk_profile_user", "user_id", "users", "id")],
            ),
            table("users", vec![column("id", true)], vec![], vec![]),
        ];

        assert_eq!(build_relationships(&tables)[0].cardinality, Cardinality::OneToOne);
    }

    #[test]
    fn multi_column_unique_index_does_not_make_a_single_column_unique() {
        // uq(a, b) does NOT make `a` alone unique, so the FK stays many-to-one.
        let tables = vec![
            table(
                "order_items",
                vec![column("order_id", false), column("product_id", false)],
                vec![unique_index("uq_items", &["order_id", "product_id"])],
                vec![fk("fk_items_order", "order_id", "orders", "id")],
            ),
            table("orders", vec![column("id", true)], vec![], vec![]),
        ];

        assert_eq!(build_relationships(&tables)[0].cardinality, Cardinality::ManyToOne);
    }

    #[test]
    fn self_referencing_foreign_key_is_supported() {
        let tables = vec![table(
            "categories",
            vec![column("id", true), column("parent_id", false)],
            vec![],
            vec![fk("fk_cat_parent", "parent_id", "categories", "id")],
        )];

        let rels = build_relationships(&tables);

        assert_eq!(rels.len(), 1);
        assert_eq!(rels[0].from.table, "categories");
        assert_eq!(rels[0].to.table, "categories");
    }

    #[test]
    fn foreign_key_to_an_absent_table_is_dropped() {
        // The target may live outside the selected schema. A dangling edge
        // would render as a relationship to nothing.
        let tables = vec![table(
            "orders",
            vec![column("user_id", false)],
            vec![],
            vec![fk("fk_orders_user", "user_id", "users", "id")],
        )];

        assert!(build_relationships(&tables).is_empty());
    }

    #[test]
    fn relationship_ids_are_stable_and_unique() {
        let tables = vec![
            table(
                "orders",
                vec![column("user_id", false), column("merchant_id", false)],
                vec![],
                vec![fk("fk_a", "user_id", "users", "id"), fk("fk_b", "merchant_id", "users", "id")],
            ),
            table("users", vec![column("id", true)], vec![], vec![]),
        ];

        let rels = build_relationships(&tables);
        assert_eq!(rels.len(), 2);
        assert_ne!(rels[0].id, rels[1].id);
        assert_eq!(build_relationships(&tables)[0].id, rels[0].id);
    }

    #[test]
    fn an_unqualified_foreign_key_resolves_within_the_source_schema() {
        let mut orders = table(
            "orders",
            vec![column("id", true), column("user_id", false)],
            vec![],
            vec![ForeignKeyInfo {
                name: "fk_orders_user".to_string(),
                column: "user_id".to_string(),
                ref_schema: None,
                ref_table: "users".to_string(),
                ref_column: "id".to_string(),
                on_update: None,
                on_delete: None,
            }],
        );
        orders.schema = Some("tenant_a".to_string());

        let mut users_a = table("users", vec![column("id", true)], vec![], vec![]);
        users_a.schema = Some("tenant_a".to_string());
        let mut users_b = table("users", vec![column("id", true)], vec![], vec![]);
        users_b.schema = Some("tenant_b".to_string());

        // tenant_b listed FIRST so a naive first-match would pick the wrong one.
        let rels = build_relationships(&[users_b, orders, users_a]);

        assert_eq!(rels.len(), 1);
        assert_eq!(rels[0].to.schema.as_deref(), Some("tenant_a"));
    }

    #[test]
    fn an_ambiguous_bare_name_reference_is_dropped_rather_than_guessed() {
        let mut orders = table(
            "orders",
            vec![column("id", true), column("user_id", false)],
            vec![],
            vec![ForeignKeyInfo {
                name: "fk_orders_user".to_string(),
                column: "user_id".to_string(),
                ref_schema: None,
                ref_table: "users".to_string(),
                ref_column: "id".to_string(),
                on_update: None,
                on_delete: None,
            }],
        );
        orders.schema = Some("app".to_string());

        let mut users_a = table("users", vec![column("id", true)], vec![], vec![]);
        users_a.schema = Some("tenant_a".to_string());
        let mut users_b = table("users", vec![column("id", true)], vec![], vec![]);
        users_b.schema = Some("tenant_b".to_string());

        assert!(build_relationships(&[orders, users_a, users_b]).is_empty());
    }
}
