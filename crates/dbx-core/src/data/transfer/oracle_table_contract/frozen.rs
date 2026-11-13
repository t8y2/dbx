use super::{
    length::{finalize_length_semantics, InsertedLengthUnit},
    LengthSemantics, TableShape,
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenTableDdl {
    source_table: String,
    base_ddl: String,
    final_ddl: String,
    source_evidence: serde_json::Value,
    length_semantics_choice: Option<LengthSemantics>,
    inserted_units: Vec<InsertedLengthUnit>,
    shape: TableShape,
}

impl FrozenTableDdl {
    pub(crate) fn external_types(&self) -> std::collections::BTreeSet<(String, String)> {
        self.shape
            .columns
            .iter()
            .filter_map(|(_, kind)| match kind {
                super::types::ColumnType::External { owner, name } => Some((owner.clone(), name.clone())),
                _ => None,
            })
            .collect()
    }

    pub(crate) fn verify_catalog_columns(&self, columns: &[super::CatalogTableColumn]) -> Result<(), String> {
        let mut previous = None;
        let mut names = std::collections::BTreeSet::new();
        let mut actual = Vec::new();
        for column in columns {
            if column.id == 0 || previous.is_some_and(|id| column.id <= id) || !names.insert(&column.name) {
                return Err("The actual table column identities or order are incomplete".into());
            }
            previous = Some(column.id);
            actual.push((
                column.name.clone(),
                super::types::from_catalog(super::types::CatalogColumnType {
                    data_type: &column.data_type,
                    data_type_owner: column.data_type_owner.as_deref(),
                    data_length: column.data_length,
                    char_length: column.char_length,
                    char_used: column.char_used.as_deref(),
                    precision: column.precision,
                    scale: column.scale,
                })?,
            ));
        }
        if actual != self.shape.columns {
            return Err(format!("The actual table {}.{} does not match the confirmed ordered column types; retain the completed table and package drafts", self.owner(), self.name()));
        }
        Ok(())
    }

    pub(crate) fn source_table(&self) -> &str {
        &self.source_table
    }
    pub(crate) fn owner(&self) -> &str {
        &self.shape.owner
    }
    pub(crate) fn name(&self) -> &str {
        &self.shape.name
    }
    pub(crate) fn columns(&self) -> std::collections::BTreeSet<String> {
        self.shape.columns.iter().map(|(name, _)| name.clone()).collect()
    }
    pub(crate) fn length_choice(&self) -> Option<LengthSemantics> {
        self.length_semantics_choice
    }

    pub(crate) fn final_ddl(&self) -> &str {
        &self.final_ddl
    }

    pub(crate) fn from_server_plan(
        source_table: &str,
        owner: &str,
        target_table: &str,
        base_ddl: &str,
        source_evidence: serde_json::Value,
        choice: Option<LengthSemantics>,
    ) -> Result<Self, String> {
        let finalized = finalize_length_semantics(base_ddl, owner, target_table, choice)?;
        let length_semantics_choice = (!finalized.inserted_units.is_empty()).then_some(choice).flatten();
        Ok(Self {
            source_table: source_table.into(),
            base_ddl: base_ddl.into(),
            final_ddl: finalized.sql,
            source_evidence,
            length_semantics_choice,
            inserted_units: finalized.inserted_units,
            shape: finalized.shape,
        })
    }

    pub(crate) fn verify_server_plan(
        &self,
        source_table: &str,
        owner: &str,
        target_table: &str,
        base_ddl: &str,
        source_evidence: serde_json::Value,
    ) -> Result<Self, String> {
        let current = Self::from_server_plan(
            source_table,
            owner,
            target_table,
            base_ddl,
            source_evidence,
            self.length_semantics_choice,
        )?;
        if *self != current {
            return Err("The table source, final SQL or typed structure changed after confirmation; retain the package drafts and refresh before writing".into());
        }
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_confirmed_unit_is_reapplied_to_server_sql_not_to_client_create_text() {
        let sql = "CREATE TABLE \"OWNER\".T(V VARCHAR2(20))";
        let evidence =
            json!({"columns":[{"name":"V","dataType":"VARCHAR2(20)"}],"sourceDdl":"full original definition"});
        let frozen =
            FrozenTableDdl::from_server_plan("S", "OWNER", "T", sql, evidence.clone(), Some(LengthSemantics::Bytes))
                .unwrap();
        assert_eq!(frozen.final_ddl, "CREATE TABLE \"OWNER\".T(V VARCHAR2(20 BYTE))");
        let encoded = serde_json::to_value(&frozen).unwrap();
        assert_eq!(serde_json::from_value::<FrozenTableDdl>(encoded.clone()).unwrap(), frozen);
        assert_eq!(frozen.verify_server_plan("S", "OWNER", "T", sql, evidence.clone()).unwrap(), frozen);
        for key in ["sourceTable", "baseDdl", "finalDdl"] {
            let mut changed = encoded.clone();
            changed[key] = json!("CREATE TABLE OTHER(X NUMBER)");
            let changed: FrozenTableDdl = serde_json::from_value(changed).unwrap();
            assert!(changed.verify_server_plan("S", "OWNER", "T", sql, evidence.clone()).is_err(), "{key}");
        }
        let changed_evidence = json!({"columns":[{"name":"V","dataType":"VARCHAR2(20)"}],"sourceDdl":"a different original owner or source comment"});
        assert!(frozen.verify_server_plan("S", "OWNER", "T", sql, changed_evidence).is_err());
        assert!(frozen
            .verify_server_plan("S", "OWNER", "T", "CREATE TABLE \"OWNER\".T(V VARCHAR2(21))", evidence.clone())
            .is_err());
        assert!(frozen.verify_server_plan("OtherSource", "OWNER", "T", sql, evidence.clone()).is_err());
        assert!(frozen.verify_server_plan("S", "OTHER", "T", sql, evidence).is_err());
    }

    #[test]
    fn explicit_or_national_columns_do_not_retain_an_unused_default_choice() {
        let sql = "CREATE TABLE T(V VARCHAR2(20 CHAR), N NVARCHAR2(10))";
        let frozen =
            FrozenTableDdl::from_server_plan("S", "OWNER", "T", sql, json!({}), Some(LengthSemantics::Bytes)).unwrap();
        assert!(frozen.length_semantics_choice.is_none());
        assert!(frozen.inserted_units.is_empty());
        assert_eq!(frozen.final_ddl, sql);
        assert_eq!(frozen.verify_server_plan("S", "OWNER", "T", sql, json!({})).unwrap(), frozen);
    }
}
