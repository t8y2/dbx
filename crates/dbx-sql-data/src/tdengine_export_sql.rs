//! TDengine export classification helpers (#14976).
//!
//! A TDengine super table (STABLE) has no rows of its own: the data lives in the
//! child tables. Exporting it like an ordinary table writes an `INSERT` without
//! a `tbname` column (rejected with `tbname column should not be null`) and the
//! same rows again for every child table.
//!
//! Tags are declared on the child table and restored by its
//! `CREATE TABLE ... USING <stable> TAGS (...)` DDL, so a tag column must not be
//! part of the INSERT column list.
//!
//! Both decisions are pure string checks on the metadata the TDengine driver
//! already returns, so they are unit tested here without a live instance.

/// Whether a `TableInfo::table_type` names a super table.
///
/// The TDengine driver reports `STABLE`; older/alternative sources are covered
/// by the usual aliases.
pub fn is_tdengine_stable_table_type(table_type: Option<&str>) -> bool {
    matches!(
        table_type.map(|value| value.trim().to_ascii_uppercase()).as_deref(),
        Some("STABLE") | Some("SUPER TABLE") | Some("SUPERTABLE")
    )
}

/// Whether a column belongs to the tag set of a TDengine table.
///
/// `DESCRIBE` puts `TAG` in the note column, which the driver stores in
/// `ColumnInfo::extra`, and mirrors it into `ColumnInfo::comment`.
pub fn is_tdengine_tag_column(comment: Option<&str>, extra: Option<&str>) -> bool {
    let mentions_tag = |value: Option<&str>| {
        value
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("TAG") || value.to_ascii_uppercase().contains("TAG"))
    };
    mentions_tag(comment) || mentions_tag(extra)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_table_type_accepts_the_driver_value_and_aliases() {
        for value in ["STABLE", "stable", " super table ", "SUPERTABLE"] {
            assert!(is_tdengine_stable_table_type(Some(value)), "{value} should be a stable");
        }
    }

    #[test]
    fn stable_table_type_rejects_child_tables_and_views() {
        for value in ["TABLE", "CHILD TABLE", "VIEW"] {
            assert!(!is_tdengine_stable_table_type(Some(value)), "{value} should not be a stable");
        }
        assert!(!is_tdengine_stable_table_type(None));
    }

    #[test]
    fn tag_column_is_recognized_from_the_describe_note() {
        assert!(is_tdengine_tag_column(Some("TAG"), Some("TAG")));
        assert!(is_tdengine_tag_column(None, Some("TAG")));
        assert!(is_tdengine_tag_column(None, Some(" tag ")));
    }

    #[test]
    fn data_columns_are_not_mistaken_for_tags() {
        assert!(!is_tdengine_tag_column(None, None));
        assert!(!is_tdengine_tag_column(None, Some("PRIMARY KEY")));
        assert!(!is_tdengine_tag_column(None, Some("")));
    }
}
