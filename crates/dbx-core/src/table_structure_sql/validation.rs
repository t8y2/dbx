use super::column_format::has_dameng_identity;
use super::dialect::{capabilities_for, StructureDialect};
use super::indexes::has_existing_index_change;
use super::types::{EditableStructureColumn, TableStructureSqlOptions};
use super::util::clean;

pub(super) fn validate_draft(options: &TableStructureSqlOptions) -> Vec<String> {
    let mut warnings = Vec::new();
    let active_columns: Vec<_> = options.columns.iter().filter(|column| !column.marked_for_drop).collect();
    validate_columns(&active_columns, &mut warnings);
    validate_dameng_identity(options, &active_columns, &mut warnings);
    for index in options
        .indexes
        .iter()
        .filter(|index| !index.marked_for_drop && (index.original.is_none() || has_existing_index_change(index)))
    {
        if clean(&index.name).is_empty() {
            warnings.push("Index name cannot be empty.".to_string());
        }
        if index.columns.iter().map(|column| clean(column)).filter(|column| !column.is_empty()).count() == 0 {
            warnings.push(format!(
                "Index \"{}\" needs at least one column.",
                if index.name.is_empty() { "(new)" } else { &index.name }
            ));
        }
    }
    warnings
}

pub(super) fn validate_dameng_identity(
    options: &TableStructureSqlOptions,
    columns: &[&EditableStructureColumn],
    warnings: &mut Vec<String>,
) {
    if capabilities_for(options.database_type).dialect != StructureDialect::Dameng {
        return;
    }

    let identity_columns: Vec<_> = columns.iter().filter(|column| has_dameng_identity(column)).collect();
    if identity_columns.len() > 1 {
        warnings.push("Dameng tables can have only one identity column.".to_string());
    }
    for column in identity_columns {
        if column.extra.as_ref().and_then(|extra| extra.identity.as_ref()).and_then(|identity| identity.increment)
            == Some(0)
        {
            warnings.push(format!("Dameng identity column \"{}\" increment cannot be 0.", column.name));
        }
    }
}

pub(super) fn validate_columns(columns: &[&EditableStructureColumn], warnings: &mut Vec<String>) {
    let mut names = std::collections::HashSet::new();
    for column in columns {
        if clean(&column.name).is_empty() {
            warnings.push("Column name cannot be empty.".to_string());
        }
        if clean(&column.data_type).is_empty() {
            warnings.push(format!(
                "Column \"{}\" type cannot be empty.",
                if column.name.is_empty() { "(new)" } else { &column.name }
            ));
        }
        let key = clean(&column.name).to_lowercase();
        if !key.is_empty() && !names.insert(key) {
            warnings.push(format!("Column \"{}\" is duplicated.", column.name));
        }
    }
}
