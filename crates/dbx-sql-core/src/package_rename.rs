//! Guarded Oracle package migration and separately requested cleanup plans.

use crate::models::connection::DatabaseType;
use crate::object_source_sql::RoutineRenameObjectSourceInput;

/// Build only after the caller explicitly selects removal following caller migration.
/// Recheck compilation, signatures, grants and complete dependencies immediately
/// before DROP, then read back both identities rather than trusting a DDL response.
pub fn build_package_cleanup_steps(input: &RoutineRenameObjectSourceInput) -> Result<Vec<String>, String> {
    let creation = build_package_rename_steps(input)?;
    let validation = &creation[creation.len() - 3];
    let owner = input.schema.as_deref().unwrap();
    let literal = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let schema = literal(owner);
    let old = literal(&input.name);
    let new = literal(&input.new_name);
    let body_count = usize::from(input.package_body_source.is_some());
    let object_count = 1 + body_count;
    let drop = literal(&format!("DROP PACKAGE {}.{}", quoted(owner), quoted(&input.name)));
    let cleanup = format!("-- Explicit cleanup after external and dynamic callers have been migrated.
DECLARE n PLS_INTEGER;
BEGIN
  IF SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')<>{schema} THEN RAISE_APPLICATION_ERROR(-20041,'Package cleanup schema mismatch.'); END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={old} AND OBJECT_TYPE='PACKAGE';
  IF n<>1 THEN RAISE_APPLICATION_ERROR(-20041,'Original package is missing or inaccessible; reload before cleanup.'); END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={old} AND OBJECT_TYPE='PACKAGE BODY';
  IF n<>{body_count} THEN RAISE_APPLICATION_ERROR(-20041,'Original package body changed; reload both definitions.'); END IF;
  IF SYS_CONTEXT('USERENV','SESSION_USER') NOT IN ({schema},'SYS') THEN
    SELECT COUNT(*) INTO n FROM SYS.USER_SYS_PRIVS WHERE PRIVILEGE='DROP ANY PROCEDURE';
    IF n=0 THEN RAISE_APPLICATION_ERROR(-20042,'Cross-owner cleanup requires direct DROP ANY PROCEDURE.'); END IF;
  END IF;
  {validation}
  SELECT COUNT(*) INTO n FROM SYS.DBA_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={new} AND OBJECT_TYPE IN ('PACKAGE','PACKAGE BODY');
  IF n<>{object_count} THEN RAISE_APPLICATION_ERROR(-20043,'Replacement package pair changed; original retained.'); END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_TAB_PRIVS a WHERE a.OWNER={schema} AND a.TABLE_NAME={old}
    AND (a.PRIVILEGE<>'EXECUTE' OR a.HIERARCHY='YES' OR NOT EXISTS (SELECT 1 FROM SYS.DBA_TAB_PRIVS b WHERE b.OWNER={schema} AND b.TABLE_NAME={new} AND b.GRANTEE=a.GRANTEE AND b.PRIVILEGE=a.PRIVILEGE AND (a.GRANTABLE='NO' OR b.GRANTABLE='YES')));
  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20044,'Replacement grants differ; original retained.'); END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_DEPENDENCIES WHERE REFERENCED_OWNER={schema} AND REFERENCED_NAME={old}
    AND REFERENCED_TYPE IN ('PACKAGE','PACKAGE BODY') AND NOT (OWNER={schema} AND NAME={old} AND TYPE IN ('PACKAGE','PACKAGE BODY'));
  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20045,'Static callers still reference the original package; migrate and validate them first.'); END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_DEPENDENCIES d LEFT JOIN SYS.DBA_OBJECTS o ON o.OWNER=d.OWNER AND o.OBJECT_NAME=d.NAME AND o.OBJECT_TYPE=d.TYPE
    WHERE d.REFERENCED_OWNER={schema} AND d.REFERENCED_NAME={new} AND d.REFERENCED_TYPE IN ('PACKAGE','PACKAGE BODY') AND (o.STATUS IS NULL OR o.STATUS<>'VALID');
  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20045,'Replacement callers are invalid or inaccessible; original retained.'); END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_SYNONYMS WHERE TABLE_OWNER={schema} AND TABLE_NAME={old} AND DB_LINK IS NULL;
  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20046,'Local synonyms still reference the original package.'); END IF;
  EXECUTE IMMEDIATE {drop};
END;");
    let readback = format!("SELECT
  (SELECT COUNT(*) FROM SYS.DBA_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={old} AND OBJECT_TYPE IN ('PACKAGE','PACKAGE BODY')) AS OLD_OBJECTS,
  (SELECT COUNT(*) FROM SYS.DBA_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={new} AND OBJECT_TYPE IN ('PACKAGE','PACKAGE BODY') AND STATUS='VALID') AS VALID_NEW_OBJECTS,
  (SELECT COUNT(*) FROM SYS.DBA_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={new} AND OBJECT_TYPE IN ('PACKAGE','PACKAGE BODY')) AS NEW_OBJECTS,
  (SELECT COUNT(*) FROM SYS.ALL_ERRORS WHERE OWNER={schema} AND NAME={new} AND TYPE IN ('PACKAGE','PACKAGE BODY') AND ATTRIBUTE='ERROR') AS COMPILE_ERRORS
FROM DUAL");
    Ok(vec![cleanup, readback])
}

/// A package migration intentionally ends with both names present. External and
/// dynamic callers require a separate, explicit migration before removing the old name.
pub fn build_package_rename_steps(input: &RoutineRenameObjectSourceInput) -> Result<Vec<String>, String> {
    let owner = input.schema.as_deref().ok_or("A package owner is required.")?;
    let sources = prepare_package_rename_sources(
        input.database_type,
        owner,
        &input.name,
        &input.new_name,
        &input.source,
        input.package_body_source.as_deref(),
    )?;
    let literal = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let schema = literal(owner);
    let old = literal(&input.name);
    let new = literal(&input.new_name);
    let body_count = usize::from(sources.create_body.is_some());
    let object_count = 1 + body_count;
    let preflight = format!("-- Preflight: no DDL. Complete dependency/grant visibility is required.
DECLARE n PLS_INTEGER;
BEGIN
  IF SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') <> {schema} THEN
    RAISE_APPLICATION_ERROR(-20031, 'DBX package migration: execution schema differs from selected owner.');
  END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={old} AND OBJECT_TYPE='PACKAGE';
  IF n<>1 THEN RAISE_APPLICATION_ERROR(-20032, 'Original package is missing or inaccessible.'); END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={old} AND OBJECT_TYPE='PACKAGE BODY';
  IF n<>{body_count} THEN RAISE_APPLICATION_ERROR(-20033, 'Package body visibility or source changed; reload both definitions.'); END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={new};
  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20034, 'Replacement name already exists; nothing changed.'); END IF;
  IF SYS_CONTEXT('USERENV', 'SESSION_USER')={schema} AND SYS_CONTEXT('USERENV', 'SESSION_USER')<>'SYS' THEN
    SELECT COUNT(*) INTO n FROM SYS.SESSION_PRIVS WHERE PRIVILEGE IN ('CREATE PROCEDURE','CREATE ANY PROCEDURE');
    IF n=0 THEN RAISE_APPLICATION_ERROR(-20035, 'Package creation privilege is unavailable.'); END IF;
  END IF;
  IF SYS_CONTEXT('USERENV', 'SESSION_USER') NOT IN ({schema}, 'SYS') THEN
    SELECT COUNT(*) INTO n FROM SYS.USER_SYS_PRIVS WHERE PRIVILEGE='CREATE ANY PROCEDURE';
    IF n=0 THEN RAISE_APPLICATION_ERROR(-20035, 'Cross-owner package creation requires direct CREATE ANY PROCEDURE.'); END IF;
  END IF;
  SELECT COUNT(*) INTO n FROM SYS.DBA_DEPENDENCIES WHERE REFERENCED_OWNER={schema} AND REFERENCED_NAME={old};
  SELECT COUNT(*) INTO n FROM SYS.DBA_SYNONYMS WHERE TABLE_OWNER={schema} AND TABLE_NAME={old};
  SELECT COUNT(*) INTO n FROM SYS.DBA_TAB_PRIVS WHERE OWNER={schema} AND TABLE_NAME={old} AND (PRIVILEGE<>'EXECUTE' OR HIERARCHY='YES');
  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20036, 'Unsupported package grants; migrate manually.'); END IF;
  IF SYS_CONTEXT('USERENV', 'SESSION_USER') NOT IN ({schema}, 'SYS') THEN
    SELECT COUNT(*) INTO n FROM SYS.DBA_TAB_PRIVS WHERE OWNER={schema} AND TABLE_NAME={old};
    IF n>0 THEN
      SELECT COUNT(*) INTO n FROM SYS.USER_SYS_PRIVS WHERE PRIVILEGE='GRANT ANY OBJECT PRIVILEGE';
      IF n=0 THEN RAISE_APPLICATION_ERROR(-20036, 'Cross-owner grant migration requires direct GRANT ANY OBJECT PRIVILEGE.'); END IF;
    END IF;
  END IF;
END;");
    let procedures = |name: &str| {
        format!("SELECT PROCEDURE_NAME,SUBPROGRAM_ID,OVERLOAD FROM SYS.ALL_PROCEDURES WHERE OWNER={schema} AND OBJECT_NAME={name} AND OBJECT_TYPE='PACKAGE' AND PROCEDURE_NAME IS NOT NULL")
    };
    let arguments = |name: &str| {
        format!("SELECT OBJECT_NAME,SUBPROGRAM_ID,POSITION,SEQUENCE,DATA_LEVEL,ARGUMENT_NAME,IN_OUT,DATA_TYPE,DATA_LENGTH,DATA_PRECISION,DATA_SCALE,TYPE_OWNER,CASE WHEN TYPE_OWNER={schema} AND TYPE_NAME={name} THEN {old} ELSE TYPE_NAME END TYPE_NAME,TYPE_SUBNAME,DEFAULTED FROM SYS.ALL_ARGUMENTS WHERE OWNER={schema} AND PACKAGE_NAME={name}")
    };
    let mut comparisons = String::new();
    for (left, right) in [(procedures(&old), procedures(&new)), (arguments(&old), arguments(&new))] {
        for (a, b) in [(&left, &right), (&right, &left)] {
            comparisons.push_str(&format!("\n  SELECT COUNT(*) INTO n FROM ({a} MINUS {b});\n  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20038, 'Package members or overload signatures differ; original retained.'); END IF;"));
        }
    }
    let validate = format!("-- Validate the specification and body together, including public overloads.
DECLARE n PLS_INTEGER; compile_error VARCHAR2(1500);
BEGIN
  SELECT COUNT(*) INTO n FROM SYS.ALL_OBJECTS WHERE OWNER={schema} AND OBJECT_NAME={new} AND OBJECT_TYPE IN ('PACKAGE','PACKAGE BODY') AND STATUS='VALID';
  IF n<>{object_count} THEN
    SELECT MIN(SUBSTR(TEXT,1,1400)) INTO compile_error FROM SYS.ALL_ERRORS WHERE OWNER={schema} AND NAME={new} AND TYPE IN ('PACKAGE','PACKAGE BODY');
    RAISE_APPLICATION_ERROR(-20037, 'New package is not VALID; original retained. ' || compile_error);
  END IF;
  SELECT COUNT(*) INTO n FROM SYS.ALL_ERRORS WHERE OWNER={schema} AND NAME={new} AND TYPE IN ('PACKAGE','PACKAGE BODY') AND ATTRIBUTE='ERROR';
  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20037, 'New package has compilation errors; original retained.'); END IF;{comparisons}
END;");
    let target = format!("{}.{}", quoted(owner), quoted(&input.new_name));
    let grant_prefix = literal(&format!("GRANT EXECUTE ON {target} TO "));
    let grants = format!(
        r#"-- Copy effective EXECUTE grants and verify them; never remove the original.
DECLARE n PLS_INTEGER; grant_sql VARCHAR2(4000);
BEGIN
  FOR r IN (SELECT DISTINCT GRANTEE,GRANTABLE FROM SYS.DBA_TAB_PRIVS WHERE OWNER={schema} AND TABLE_NAME={old} AND PRIVILEGE='EXECUTE') LOOP
    grant_sql := {grant_prefix} || CASE WHEN r.GRANTEE='PUBLIC' THEN 'PUBLIC' ELSE '"' || REPLACE(r.GRANTEE,'"','""') || '"' END;
    IF r.GRANTABLE='YES' THEN grant_sql := grant_sql || ' WITH GRANT OPTION'; END IF;
    EXECUTE IMMEDIATE grant_sql;
  END LOOP;
  SELECT COUNT(*) INTO n FROM SYS.DBA_TAB_PRIVS a WHERE a.OWNER={schema} AND a.TABLE_NAME={old}
    AND NOT EXISTS (SELECT 1 FROM SYS.DBA_TAB_PRIVS b WHERE b.OWNER={schema} AND b.TABLE_NAME={new} AND b.GRANTEE=a.GRANTEE AND b.PRIVILEGE=a.PRIVILEGE AND (a.GRANTABLE='NO' OR b.GRANTABLE='YES'));
  IF n<>0 THEN RAISE_APPLICATION_ERROR(-20039, 'Package grant verification failed; both names retained.'); END IF;
END;"#
    );
    let dependencies = format!("-- Migration is incomplete: review external and dynamic callers before any separate DROP.
SELECT 'STATIC_DEPENDENCIES' AS KIND, COUNT(*) AS REMAINING FROM SYS.DBA_DEPENDENCIES WHERE REFERENCED_OWNER={schema} AND REFERENCED_NAME={old} AND NOT (OWNER={schema} AND NAME={old})
UNION ALL
SELECT 'SYNONYMS',COUNT(*) FROM SYS.DBA_SYNONYMS WHERE TABLE_OWNER={schema} AND TABLE_NAME={old}");
    let mut steps = vec![preflight, sources.create_specification];
    if let Some(body) = sources.create_body {
        steps.push(body);
    }
    steps.extend([validate, grants, dependencies]);
    Ok(steps)
}

#[derive(Debug, Clone, PartialEq)]
pub struct PackageRenameSources {
    pub original_specification: String,
    pub original_body: Option<String>,
    pub create_specification: String,
    pub create_body: Option<String>,
}

pub fn prepare_package_rename_sources(
    database_type: DatabaseType,
    owner: &str,
    name: &str,
    new_name: &str,
    specification: &str,
    body: Option<&str>,
) -> Result<PackageRenameSources, String> {
    if !matches!(database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) {
        return Err("Package source rename requires Oracle or OceanBase Oracle.".into());
    }
    if owner.is_empty() || name.is_empty() || new_name.is_empty() || name == new_name {
        return Err("A schema and two different nonempty package names are required.".into());
    }
    Ok(PackageRenameSources {
        original_specification: specification.to_owned(),
        original_body: body.map(str::to_owned),
        create_specification: rewrite_package(specification, owner, name, new_name, false)?,
        create_body: body.map(|source| rewrite_package(source, owner, name, new_name, true)).transpose()?,
    })
}

#[derive(Debug)]
struct Lexeme<'a> {
    start: usize,
    end: usize,
    text: &'a str,
    identifier: Option<String>,
}

impl Lexeme<'_> {
    fn keyword(&self, word: &str) -> bool {
        !self.text.starts_with('"') && self.text.eq_ignore_ascii_case(word)
    }
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn rewrite_package(source: &str, owner: &str, name: &str, new_name: &str, body: bool) -> Result<String, String> {
    let tokens = lex(source)?;
    let invalid = || "Package source declaration or final END does not match the selected object.".to_string();
    let is = |index: usize, word: &str| tokens.get(index).is_some_and(|token| token.keyword(word));
    if !is(0, "CREATE") {
        return Err(invalid());
    }
    let mut index = 1;
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    if is(index, "OR") {
        if !is(index + 1, "REPLACE") {
            return Err(invalid());
        }
        for token in &tokens[index..index + 2] {
            edits.push((token.start, token.end, String::new()));
        }
        index += 2;
    }
    if is(index, "EDITIONABLE") || is(index, "NONEDITIONABLE") {
        index += 1;
    }
    if !is(index, "PACKAGE") {
        return Err(invalid());
    }
    index += 1;
    if is(index, "BODY") != body {
        return Err(invalid());
    }
    if body {
        index += 1;
    }
    let first = tokens.get(index).ok_or_else(invalid)?;
    let mut declared_name = first.identifier.as_deref().ok_or_else(invalid)?;
    let name_start = first.start;
    let mut name_end = first.end;
    index += 1;
    if is(index, ".") {
        if declared_name != owner {
            return Err(invalid());
        }
        let second = tokens.get(index + 1).ok_or_else(invalid)?;
        declared_name = second.identifier.as_deref().ok_or_else(invalid)?;
        name_end = second.end;
        index += 2;
    }
    if declared_name != name {
        return Err(invalid());
    }
    edits.push((name_start, name_end, format!("{}.{}", quoted(owner), quoted(new_name))));

    let mut end = tokens.len();
    if end > 0 && is(end - 1, "/") {
        edits.push((tokens[end - 1].start, tokens[end - 1].end, String::new()));
        end -= 1;
    }
    if end < index + 2 || !is(end - 1, ";") {
        return Err(invalid());
    }
    let end_name = if is(end - 2, "END") {
        None
    } else if end >= 3 && is(end - 3, "END") && tokens[end - 2].identifier.as_deref() == Some(name) {
        Some(end - 2)
    } else {
        return Err(invalid());
    };
    if let Some(last) = end_name {
        edits.push((tokens[last].start, tokens[last].end, quoted(new_name)));
    }

    let owner_qualified_reference = tokens[index..end].windows(5).any(|window| {
        window[0].identifier.as_deref() == Some(owner)
            && window[1].text == "."
            && window[2].identifier.as_deref() == Some(name)
            && window[3].text == "."
    });
    if owner_qualified_reference
        && (index..end).any(|current| {
            tokens[current].identifier.as_deref() == Some(owner)
                && !is(current + 1, ".")
                && (current == 0 || !is(current - 1, "."))
        })
    {
        return Err("The schema qualifier may be shadowed by a local identifier; resolve it before renaming.".into());
    }

    for current in index..end {
        let token = &tokens[current];
        if token.identifier.as_deref() != Some(name) || Some(current) == end_name {
            continue;
        }
        if current > 0 && is(current - 1, ".") {
            // ExternalOwner.OldPackage.Member is unrelated. Only the selected
            // owner's exact qualification establishes a self-reference here.
            if current < 2 || tokens[current - 2].identifier.as_deref() != Some(owner) {
                continue;
            }
            if current >= 3 && is(current - 3, ".") {
                continue;
            }
        }
        if !is(current + 1, ".") || tokens.get(current + 2).and_then(|token| token.identifier.as_ref()).is_none() {
            return Err("A package-name identifier is used outside a proven self-reference; resolve shadowing manually before renaming.".into());
        }
        edits.push((token.start, token.end, quoted(new_name)));
    }
    edits.sort_by_key(|edit| edit.0);
    let mut result = source.to_owned();
    for (start, end, replacement) in edits.into_iter().rev() {
        result.replace_range(start..end, &replacement);
    }
    Ok(result)
}

/// Record byte spans while leaving comments and literals untouched. Reject an
/// unterminated token instead of making a partial rewrite of untrusted source.
fn lex(source: &str) -> Result<Vec<Lexeme<'_>>, String> {
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < source.len() {
        let rest = &source[offset..];
        let ch = rest.chars().next().unwrap();
        if ch.is_whitespace() {
            offset += ch.len_utf8();
            continue;
        }
        if rest.starts_with("--") {
            offset += rest.find('\n').unwrap_or(rest.len());
            continue;
        }
        if rest.starts_with("/*") {
            offset += rest.find("*/").ok_or("Unterminated package source comment.")? + 2;
            continue;
        }
        let start = offset;
        let mut identifier = None;
        let alternative_prefix = if rest.get(..3).is_some_and(|value| value.eq_ignore_ascii_case("nq'")) {
            3
        } else if rest.starts_with("q'") || rest.starts_with("Q'") {
            2
        } else {
            0
        };
        if alternative_prefix > 0 && rest.len() > alternative_prefix {
            let delimiter = rest[alternative_prefix..].chars().next().unwrap();
            let close = match delimiter {
                '[' => ']',
                '(' => ')',
                '{' => '}',
                '<' => '>',
                other => other,
            };
            let content = alternative_prefix + delimiter.len_utf8();
            let marker = format!("{close}'");
            offset += content
                + rest[content..].find(&marker).ok_or("Unterminated alternative-quoted package literal.")?
                + marker.len();
        } else if ch == '\'' || ch == '"' {
            offset += 1;
            loop {
                let next = source[offset..].chars().next().ok_or("Unterminated quoted package token.")?;
                offset += next.len_utf8();
                if next != ch {
                    continue;
                }
                if source[offset..].starts_with(ch) {
                    offset += 1;
                    continue;
                }
                break;
            }
            if ch == '"' {
                identifier = Some(source[start + 1..offset - 1].replace("\"\"", "\""));
            }
        } else if ch.is_alphabetic() || ch == '_' {
            offset += ch.len_utf8();
            while let Some(next) = source[offset..].chars().next() {
                if !next.is_alphanumeric() && !matches!(next, '_' | '$' | '#') {
                    break;
                }
                offset += next.len_utf8();
            }
            identifier = Some(source[start..offset].to_uppercase());
        } else {
            offset += ch.len_utf8();
        }
        result.push(Lexeme { start, end: offset, text: &source[start..offset], identifier });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object_source_sql::build_routine_rename_object_source_statements;
    use crate::types::ObjectSourceKind;

    #[test]
    fn public_package_plan_validates_both_sources_grants_and_members_without_dropping_original() {
        for database_type in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle] {
            for with_body in [false, true] {
                let steps = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
                    package_cleanup: false,
                    database_type,
                    object_type: ObjectSourceKind::Package,
                    schema: Some("APP".into()),
                    name: "PKG".into(),
                    new_name: "NEW_PKG".into(),
                    source: "CREATE PACKAGE PKG AS PROCEDURE RUN; END PKG;".into(),
                    package_body_source: with_body
                        .then(|| "CREATE PACKAGE BODY PKG AS PROCEDURE RUN IS BEGIN NULL; END RUN; END PKG;".into()),
                })
                .unwrap();
                assert_eq!(steps.len(), if with_body { 6 } else { 5 });
                assert!(steps[0].contains("DBA_OBJECTS"));
                assert!(steps[0].contains("DBA_DEPENDENCIES"));
                assert!(steps[1].contains("PACKAGE \"APP\".\"NEW_PKG\""));
                if with_body {
                    assert!(steps[2].contains("PACKAGE BODY \"APP\".\"NEW_PKG\""));
                }
                let validation = &steps[if with_body { 3 } else { 2 }];
                assert!(validation.contains("STATUS='VALID'"));
                assert!(validation.contains("ATTRIBUTE='ERROR'"));
                assert!(validation.contains("SUBPROGRAM_ID"));
                assert!(validation.contains("DEFAULTED"));
                assert!(validation.contains(" MINUS "));
                assert!(steps[steps.len() - 2].contains("GRANT EXECUTE"));
                assert!(steps.last().unwrap().contains("STATIC_DEPENDENCIES"));
                assert!(steps.iter().all(|sql| !sql.contains("DROP PACKAGE") && !sql.contains("CREATE OR REPLACE")));
            }
        }
    }

    #[test]
    fn preserves_source_snapshots_and_prepares_specification_without_a_body() {
        let source = "-- source\nCREATE OR /* keep */ REPLACE PACKAGE APP.PKG AS PROCEDURE RUN; END PKG;\n/";
        let plan = prepare_package_rename_sources(DatabaseType::OceanbaseOracle, "APP", "PKG", "NEW_PKG", source, None)
            .unwrap();
        assert_eq!(plan.original_specification, source);
        assert_eq!(plan.original_body, None);
        assert_eq!(plan.create_body, None);
        assert!(plan.create_specification.contains("CREATE  /* keep */  PACKAGE \"APP\".\"NEW_PKG\""));
        assert!(plan.create_specification.contains("END \"NEW_PKG\";"));
        assert!(!plan.create_specification.contains("DROP"));
    }

    #[test]
    fn rewrites_proven_self_references_but_preserves_external_references_and_literals() {
        let spec = "CREATE PACKAGE PKG AS PROCEDURE RUN; END;";
        let body = "CREATE OR REPLACE PACKAGE BODY PKG AS PROCEDURE RUN IS BEGIN PKG.NEXT; APP.PKG.NEXT; OTHER.PKG.NEXT; EXECUTE IMMEDIATE 'BEGIN PKG.NEXT; END;'; x := q'[PKG.NEXT '中文😀']'; -- PKG.NEXT\nEND RUN; END PKG;";
        let plan =
            prepare_package_rename_sources(DatabaseType::Oracle, "APP", "PKG", "NEW_PKG", spec, Some(body)).unwrap();
        let renamed = plan.create_body.unwrap();
        assert_eq!(plan.original_body.as_deref(), Some(body));
        assert!(renamed.contains("\"NEW_PKG\".NEXT; APP.\"NEW_PKG\".NEXT; OTHER.PKG.NEXT;"));
        assert!(renamed.contains("'BEGIN PKG.NEXT; END;'"));
        assert!(renamed.contains("q'[PKG.NEXT '中文😀']'"));
        assert!(renamed.contains("-- PKG.NEXT"));
        assert!(renamed.contains("END RUN; END \"NEW_PKG\";"));
    }

    #[test]
    fn handles_exact_quoted_owner_package_and_closing_name() {
        let source = "CREATE PACKAGE \"Mixed.Owner\".\"Pkg.Name\" AS PROCEDURE RUN; END \"Pkg.Name\";";
        let plan = prepare_package_rename_sources(
            DatabaseType::OceanbaseOracle,
            "Mixed.Owner",
            "Pkg.Name",
            "New\"Name",
            source,
            None,
        )
        .unwrap();
        assert!(plan.create_specification.contains("PACKAGE \"Mixed.Owner\".\"New\"\"Name\""));
        assert!(plan.create_specification.contains("END \"New\"\"Name\";"));
        assert!(prepare_package_rename_sources(DatabaseType::Oracle, "MIXED.OWNER", "Pkg.Name", "NEW", source, None)
            .is_err());
    }

    #[test]
    fn preserves_national_alternative_literals_containing_apostrophes() {
        let source = "CREATE PACKAGE PKG AS x NVARCHAR2(100) := NQ'[PKG.RUN '中文😀']'; END PKG;";
        let plan = prepare_package_rename_sources(DatabaseType::Oracle, "APP", "PKG", "NEW", source, None).unwrap();
        assert!(plan.create_specification.contains("NQ'[PKG.RUN '中文😀']'"));
    }

    #[test]
    fn package_body_survives_the_existing_web_and_tauri_input_contract() {
        let input: RoutineRenameObjectSourceInput = serde_json::from_value(serde_json::json!({
            "databaseType":"oceanbase-oracle", "objectType":"PACKAGE", "schema":"APP", "name":"PKG", "newName":"NEW",
            "source":"CREATE PACKAGE PKG AS PROCEDURE RUN; END;",
            "packageBodySource":"CREATE PACKAGE BODY PKG AS PROCEDURE RUN IS BEGIN NULL; END; END;"
        }))
        .unwrap();
        assert!(input.package_body_source.is_some());
        assert!(!input.package_cleanup);
        assert_eq!(build_routine_rename_object_source_statements(input).unwrap().len(), 6);
    }

    #[test]
    fn explicit_cleanup_rechecks_both_objects_grants_callers_then_drops_and_reads_back() {
        for database_type in ["oracle", "oceanbase-oracle"] {
            for body in [None, Some("CREATE PACKAGE BODY \"Mixed.Owner\".\"Old\"\"Pkg\" AS END;")] {
                let input = serde_json::from_value(serde_json::json!({
                    "databaseType": database_type, "objectType":"PACKAGE", "schema":"Mixed.Owner",
                    "name":"Old\"Pkg", "newName":"New.Pkg", "source":"CREATE PACKAGE \"Mixed.Owner\".\"Old\"\"Pkg\" AS END;",
                    "packageBodySource": body, "packageCleanup":true
                })).unwrap();
                let steps = build_routine_rename_object_source_statements(input).unwrap();
                assert_eq!(steps.len(), 2);
                let cleanup = &steps[0];
                let drop = cleanup.find("EXECUTE IMMEDIATE").unwrap();
                for required in [
                    "DROP ANY PROCEDURE",
                    "STATUS='VALID'",
                    "ATTRIBUTE='ERROR'",
                    " MINUS ",
                    "DBA_TAB_PRIVS",
                    "DBA_DEPENDENCIES",
                    "Replacement callers are invalid",
                    "DBA_SYNONYMS",
                ] {
                    assert!(cleanup.find(required).unwrap() < drop, "{required}");
                }
                assert!(cleanup.contains("DROP PACKAGE \"Mixed.Owner\".\"Old\"\"Pkg\""));
                assert!(!cleanup.contains("CREATE PACKAGE"));
                for field in ["OLD_OBJECTS", "VALID_NEW_OBJECTS", "NEW_OBJECTS", "COMPILE_ERRORS"] {
                    assert!(steps[1].contains(field));
                }
            }
        }
    }

    #[test]
    fn rejects_wrong_identity_kind_shadowing_and_incomplete_source() {
        for source in [
            "CREATE PACKAGE OTHER AS PROCEDURE RUN; END OTHER;",
            "CREATE PACKAGE BODY PKG AS PROCEDURE RUN; END PKG;",
            "CREATE PACKAGE PKG AS PKG NUMBER; END PKG;",
            "CREATE PACKAGE PKG AS APP NUMBER; x APP.PKG.T; END PKG;",
            "CREATE PACKAGE PKG AS PROCEDURE RUN; END WRONG;",
            "CREATE PACKAGE PKG AS x VARCHAR2(30) := 'unterminated; END;",
        ] {
            assert!(
                prepare_package_rename_sources(DatabaseType::Oracle, "APP", "PKG", "NEW", source, None).is_err(),
                "{source}"
            );
        }
    }
}
