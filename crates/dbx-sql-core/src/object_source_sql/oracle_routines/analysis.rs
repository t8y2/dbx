//! Fail-closed analysis of the small static PL/SQL subset used by comparison
//! deployment. Ordinary source saves and transfers do not use this restriction.
use super::*;
use sqlparser::ast::{
    Expr, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr, Ident, ObjectName, SelectFlavor, SelectItem,
    SetExpr, Statement, TableFactor,
};
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Location, TokenWithSpan};
use std::collections::BTreeMap;

mod package;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleDraftName {
    pub value: String,
    pub quoted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleDraftParameter {
    pub name: OracleDraftName,
    pub mode: String,
    pub data_type: String,
    pub has_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_expression: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OracleDraftPackageMemberKind {
    Variable,
    Constant,
    Exception,
    Procedure,
    Function,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleDraftPackageMember {
    pub name: OracleDraftName,
    pub kind: OracleDraftPackageMemberKind,
    pub parameters: Vec<OracleDraftParameter>,
    pub return_type: Option<String>,
    pub data_type: Option<String>,
    pub default_expression: Option<String>,
    pub public: bool,
    pub defined: bool,
    pub line: u64,
    pub column: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleDraftPackageCall {
    pub caller: Option<OracleDraftName>,
    pub callee: OracleDraftName,
    pub line: u64,
    pub column: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OracleDraftReferenceRole {
    Relation,
    Value,
    Function,
    Procedure,
    Exception,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleDraftReference {
    pub parts: Vec<OracleDraftName>,
    pub role: OracleDraftReferenceRole,
    pub argument_writable: Vec<bool>,
    pub query: Option<usize>,
    pub local_binding: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_binding: Option<OracleDraftPackageMemberKind>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub out_of_scope_binding: bool,
    pub line: u64,
    pub column: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleDraftQuery {
    pub relation_reference: usize,
    pub alias: Option<OracleDraftName>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleDraftIssue {
    pub code: String,
    pub message: String,
    pub line: u64,
    pub column: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OracleRoutineDraftAnalysis {
    pub complete: bool,
    pub parameters: Vec<OracleDraftParameter>,
    pub references: Vec<OracleDraftReference>,
    pub queries: Vec<OracleDraftQuery>,
    pub issues: Vec<OracleDraftIssue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub package_members: Vec<OracleDraftPackageMember>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub package_calls: Vec<OracleDraftPackageCall>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_package_initialization: bool,
}

fn canonical(ident: &Ident) -> String {
    if ident.quote_style.is_some() {
        ident.value.clone()
    } else {
        ident.value.to_uppercase()
    }
}
fn name(ident: &Ident) -> OracleDraftName {
    OracleDraftName { value: canonical(ident), quoted: ident.quote_style.is_some() }
}
fn object_parts(value: &ObjectName) -> Result<Vec<Ident>, String> {
    value
        .0
        .iter()
        .map(|part| part.as_ident().cloned().ok_or_else(|| "Computed object names require manual correction".into()))
        .collect()
}

struct Analysis<'a> {
    input: &'a EditableObjectSourceSqlInput,
    tokens: Vec<TokenWithSpan>,
    pos: usize,
    bindings: BTreeMap<String, bool>,
    output: OracleRoutineDraftAnalysis,
    issue_position: Option<Location>,
    package_context: Option<package::PackageContext>,
}

impl Analysis<'_> {
    fn current(&self) -> Option<&TokenWithSpan> {
        self.tokens.get(self.pos)
    }
    fn word(&self, value: &str) -> bool {
        self.current().is_some_and(|token| token_unquoted_word_is(&token.token, value))
    }
    fn consume_word(&mut self, value: &str) -> bool {
        if self.word(value) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn consume(&mut self, value: Token) -> bool {
        if self.current().is_some_and(|token| token.token == value) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn expect_word(&mut self, value: &str) -> Result<(), String> {
        if self.consume_word(value) {
            Ok(())
        } else {
            Err(format!("Expected {value}; edit this draft to the supported static form"))
        }
    }
    fn expect(&mut self, value: Token) -> Result<(), String> {
        if self.consume(value.clone()) {
            Ok(())
        } else {
            Err(format!("Expected {value} in the static routine draft"))
        }
    }
    fn ident(&mut self) -> Result<Ident, String> {
        let token = self.current().ok_or("Routine draft ended unexpectedly")?;
        let Token::Word(word) = &token.token else {
            return Err("Expected an exact identifier".into());
        };
        let ident = Ident { value: word.value.clone(), quote_style: word.quote_style, span: token.span };
        self.pos += 1;
        Ok(ident)
    }
    fn parts(&mut self) -> Result<Vec<Ident>, String> {
        let mut result = vec![self.ident()?];
        while self.consume(Token::Period) {
            result.push(self.ident()?);
        }
        if result.len() > 3 {
            return Err("Only a local object, owner.object or owner.package.member can be resolved".into());
        }
        Ok(result)
    }
    fn scalar_type(&mut self) -> Result<String, String> {
        let token = self.current().ok_or("A scalar type is required")?;
        let Token::Word(word) = &token.token else {
            return Err("A built-in scalar type is required".into());
        };
        let data_type = word.value.to_uppercase();
        if word.quote_style.is_some()
            || !matches!(
                data_type.as_str(),
                "NUMBER"
                    | "NUMERIC"
                    | "DECIMAL"
                    | "INTEGER"
                    | "INT"
                    | "SMALLINT"
                    | "PLS_INTEGER"
                    | "BINARY_INTEGER"
                    | "SIMPLE_INTEGER"
                    | "VARCHAR2"
                    | "VARCHAR"
                    | "NVARCHAR2"
                    | "CHAR"
                    | "NCHAR"
                    | "BOOLEAN"
                    | "DATE"
                    | "TIMESTAMP"
                    | "RAW"
                    | "FLOAT"
                    | "BINARY_FLOAT"
                    | "BINARY_DOUBLE"
            )
        {
            return Err("This automatic plan supports built-in scalar declarations; keep this draft for manual correction or deselect the object".into());
        }
        self.pos += 1;
        if self.consume(Token::LParen) {
            for index in 0..2 {
                let _ = self.consume(Token::Minus);
                if !self.current().is_some_and(
                    |token| matches!(&token.token, Token::Number(number, _) if number.parse::<u32>().is_ok()),
                ) {
                    return Err("Only literal numeric precision or length is supported".into());
                }
                self.pos += 1;
                if index == 0 && self.consume(Token::Comma) {
                    continue;
                }
                break;
            }
            let _ = self.consume_word("CHAR") || self.consume_word("BYTE");
            self.expect(Token::RParen)?;
        }
        Ok(data_type)
    }
    fn expression_tokens_until(&mut self, terminators: &[Token]) -> Result<Vec<TokenWithSpan>, String> {
        let start = self.pos;
        let mut depth = 0usize;
        while let Some(token) = self.current() {
            if depth == 0 && terminators.contains(&token.token) {
                break;
            }
            match token.token {
                Token::LParen => depth += 1,
                Token::RParen if depth > 0 => depth -= 1,
                Token::EOF => break,
                _ => {}
            }
            self.pos += 1;
        }
        if depth != 0 || start == self.pos {
            return Err("A complete scalar expression is required".into());
        }
        Ok(self.tokens[start..self.pos].to_vec())
    }
    fn expression(&mut self, tokens: Vec<TokenWithSpan>, query: Option<usize>) -> Result<Expr, String> {
        let position = tokens.first().map(|token| token.span.start);
        let result = (|| {
            let mut parser = Parser::new(&OracleDialect {}).with_tokens_with_locations(tokens);
            let expr =
                parser.parse_expr().map_err(|error| format!("Cannot analyze this scalar expression: {error}"))?;
            if parser.peek_token_ref().token != Token::EOF {
                return Err("Expression has unsupported trailing syntax".into());
            }
            self.visit_expr(&expr, query)?;
            Ok(expr)
        })();
        if result.is_err() {
            self.issue_position = position;
        }
        result
    }
    fn reference(
        &mut self,
        parts: &[Ident],
        role: OracleDraftReferenceRole,
        arguments: Vec<bool>,
        query: Option<usize>,
    ) -> Result<(), String> {
        if parts.is_empty() || parts.len() > 3 {
            return Err("Reference does not have an exact supported identity".into());
        }
        self.check_package_lexical_reference(parts, &role, query)?;
        let mut local = self.bindings.get(&canonical(&parts[0])).copied();
        let mut package_binding = None;
        if query.is_some() && role == OracleDraftReferenceRole::Value && self.package_local_exception(parts) {
            package_binding = Some(OracleDraftPackageMemberKind::Exception);
            local = None;
        }
        if query.is_none() && local.is_some() {
            if parts.len() == 1 && role == OracleDraftReferenceRole::Value {
                return Ok(());
            }
            return Err("A local scalar shadows this call or qualifier; use an unambiguous static target name".into());
        }
        if local.is_none() && package_binding.is_none() {
            match self.package_reference(parts, &role, &arguments, query)? {
                package::PackageReference::Closed => return Ok(()),
                package::PackageReference::SqlValue(kind) => package_binding = Some(kind),
                package::PackageReference::External => {}
            }
        }
        self.output.references.push(OracleDraftReference {
            parts: parts.iter().map(name).collect(),
            role,
            argument_writable: arguments,
            query,
            local_binding: local,
            package_binding,
            out_of_scope_binding: query.is_some()
                && local.is_none()
                && package_binding.is_none()
                && self.package_exited_binding(parts),
            line: parts[0].span.start.line,
            column: parts[0].span.start.column,
        });
        Ok(())
    }
    fn writable(&self, expr: &Expr) -> bool {
        if let Expr::Identifier(ident) = expr {
            if let Some(writable) = self.bindings.get(&canonical(ident)) {
                return *writable;
            }
        }
        self.package_writable(expr)
    }
    fn call(
        &mut self,
        function: &sqlparser::ast::Function,
        query: Option<usize>,
        procedure: bool,
    ) -> Result<(), String> {
        if function.uses_odbc_syntax
            || function.parameters != FunctionArguments::None
            || function.filter.is_some()
            || function.null_treatment.is_some()
            || function.over.is_some()
            || !function.within_group.is_empty()
        {
            return Err("Call modifiers require manual correction before automatic deployment".into());
        }
        let parts = object_parts(&function.name)?;
        let args = match &function.args {
            FunctionArguments::None => &[][..],
            FunctionArguments::List(list) if list.duplicate_treatment.is_none() && list.clauses.is_empty() => {
                list.args.as_slice()
            }
            _ => return Err("Only positional scalar call arguments are supported".into()),
        };
        // COUNT(*) has a closed SQL aggregate meaning, not a guessed unresolved
        // routine. Other calls go through the Core name/argument resolver.
        if query.is_some()
            && !procedure
            && parts.len() == 1
            && parts[0].quote_style.is_none()
            && parts[0].value.eq_ignore_ascii_case("COUNT")
            && matches!(args, [FunctionArg::Unnamed(FunctionArgExpr::Wildcard)])
        {
            return Ok(());
        }
        let mut writable = Vec::new();
        for arg in args {
            let FunctionArg::Unnamed(FunctionArgExpr::Expr(expr)) = arg else {
                return Err("Named, wildcard or query call arguments are not supported by this automatic plan".into());
            };
            self.visit_expr(expr, query)?;
            writable.push(query.is_none() && self.writable(expr));
        }
        self.reference(
            &parts,
            if procedure { OracleDraftReferenceRole::Procedure } else { OracleDraftReferenceRole::Function },
            writable,
            query,
        )
    }
    fn visit_expr(&mut self, expr: &Expr, query: Option<usize>) -> Result<(), String> {
        match expr {
            Expr::Value(value) if matches!(value.value, sqlparser::ast::Value::Number(_, _) | sqlparser::ast::Value::SingleQuotedString(_) | sqlparser::ast::Value::NationalStringLiteral(_) | sqlparser::ast::Value::QuoteDelimitedStringLiteral(_) | sqlparser::ast::Value::NationalQuoteDelimitedStringLiteral(_) | sqlparser::ast::Value::Boolean(_) | sqlparser::ast::Value::Null) => Ok(()),
            Expr::Identifier(ident) if self.package_context.is_some() && ident.quote_style.is_none() && matches!(canonical(ident).as_str(), "TRUE" | "FALSE") => Ok(()),
            Expr::Identifier(ident) => self.reference(std::slice::from_ref(ident), OracleDraftReferenceRole::Value, Vec::new(), query),
            Expr::CompoundIdentifier(parts) => self.reference(parts, OracleDraftReferenceRole::Value, Vec::new(), query),
            Expr::Nested(expr) | Expr::IsNull(expr) | Expr::IsNotNull(expr) => self.visit_expr(expr, query),
            Expr::UnaryOp { op, expr } if matches!(op.to_string().as_str(), "+" | "-" | "NOT") => self.visit_expr(expr, query),
            Expr::BinaryOp { left, op, right } if matches!(op.to_string().as_str(), "+" | "-" | "*" | "/" | "%" | "||" | "AND" | "OR" | "=" | "<>" | "!=" | "<" | ">" | "<=" | ">=") => { self.visit_expr(left, query)?; self.visit_expr(right, query) },
            Expr::Function(function) => self.call(function, query, false),
            _ => Err("This expression needs a supported static form before automatic deployment; nested queries, methods and extra scopes are not inferred".into()),
        }
    }
    fn declare_binding(&mut self, ident: &Ident, writable: bool) -> Result<(), String> {
        if self.bindings.insert(canonical(ident), writable).is_some() {
            return Err("Duplicate or shadowed local declarations require manual correction".into());
        }
        Ok(())
    }
    fn parse(&mut self) -> Result<(), String> {
        if self.input.object_type == ObjectSourceKind::Package {
            return package::parse_specification(self);
        }
        if self.input.object_type == ObjectSourceKind::PackageBody {
            return Err("Package body analysis requires its complete final specification".into());
        }
        self.expect_word("CREATE")?;
        if self.consume_word("OR") {
            self.expect_word("REPLACE")?;
        }
        let _ = self.consume_word("EDITIONABLE") || self.consume_word("NONEDITIONABLE");
        self.expect_word(object_type_keyword(&self.input.object_type))?;
        self.parts()?; // Existing identity validator checked owner/name/kind.
        if self.consume(Token::LParen) && !self.consume(Token::RParen) {
            loop {
                let ident = self.ident()?;
                let mode = if self.consume_word("IN") {
                    if self.consume_word("OUT") {
                        "IN OUT"
                    } else {
                        "IN"
                    }
                } else if self.consume_word("OUT") {
                    "OUT"
                } else {
                    "IN"
                };
                let data_type = self.scalar_type()?;
                let has_default = self.consume_word("DEFAULT") || self.consume(Token::Assignment);
                if has_default {
                    if mode != "IN" {
                        return Err("Only IN parameters can have a default in this automatic plan".into());
                    }
                    let tokens = self.expression_tokens_until(&[Token::Comma, Token::RParen])?;
                    self.expression(tokens, None)?;
                }
                self.declare_binding(&ident, mode != "IN")?;
                self.output.parameters.push(OracleDraftParameter {
                    name: name(&ident),
                    mode: mode.into(),
                    data_type,
                    has_default,
                    default_expression: None,
                });
                if self.consume(Token::RParen) {
                    break;
                }
                self.expect(Token::Comma)?;
            }
        }
        if self.input.object_type == ObjectSourceKind::Function {
            self.expect_word("RETURN")?;
            self.scalar_type()?;
        }
        if self.consume_word("AUTHID") {
            self.expect_word("DEFINER")?;
        }
        if !self.consume_word("AS") && !self.consume_word("IS") {
            return Err(
                "Unknown routine header option; only a static AUTHID DEFINER scalar routine is supported".into()
            );
        }
        while !self.word("BEGIN") {
            if self.current().is_none()
                || self.word("FUNCTION")
                || self.word("PROCEDURE")
                || self.word("DECLARE")
                || self.word("CURSOR")
                || self.word("TYPE")
            {
                return Err("Local routines, cursors and additional declaration scopes need manual correction or removal from this plan".into());
            }
            let ident = self.ident()?;
            let constant = self.consume_word("CONSTANT");
            self.scalar_type()?;
            if self.consume_word("NOT") {
                self.expect_word("NULL")?;
            }
            let initialized = self.consume(Token::Assignment) || self.consume_word("DEFAULT");
            if initialized {
                let tokens = self.expression_tokens_until(&[Token::SemiColon])?;
                self.expression(tokens, None)?;
            } else if constant {
                return Err("A scalar constant needs a complete initializer".into());
            }
            self.expect(Token::SemiColon)?;
            self.declare_binding(&ident, !constant)?;
        }
        self.expect_word("BEGIN")?;
        while !self.word("END") {
            let start = self.pos;
            let tokens = self.expression_tokens_until(&[Token::SemiColon])?;
            self.expect(Token::SemiColon)?;
            if let Err(error) = self.statement(tokens) {
                if self.issue_position.is_none() {
                    self.issue_position = self.tokens.get(start).map(|token| token.span.start);
                }
                return Err(error);
            }
        }
        self.expect_word("END")?;
        if !self.current().is_some_and(|token| token.token == Token::SemiColon) {
            let end_name = self.ident()?;
            if canonical(&end_name) != self.input.name {
                return Err("The outer END name does not match the selected routine".into());
            }
        }
        self.expect(Token::SemiColon)?;
        if self.pos != self.tokens.len() {
            return Err("Extra statements or unsupported trailing routine syntax are not approved".into());
        }
        for reference in &self.output.references {
            if reference.query.is_none()
                && reference.local_binding.is_none()
                && reference.parts.len() == 1
                && self.bindings.contains_key(&reference.parts[0].value)
            {
                return Err(format!("Forward or self declaration can shadow reference {} at {}:{}; qualify the intended external routine", reference.parts[0].value, reference.line, reference.column));
            }
        }
        Ok(())
    }
    fn statement(&mut self, tokens: Vec<TokenWithSpan>) -> Result<(), String> {
        let is_word =
            |index: usize, value| tokens.get(index).is_some_and(|token| token_unquoted_word_is(&token.token, value));
        if tokens.len() == 1 && is_word(0, "NULL") {
            return Ok(());
        }
        if is_word(0, "RETURN") {
            if self.package_context.as_ref().is_some_and(|context| context.current_kind().is_none()) {
                return Err("Package initialization cannot RETURN a member result".into());
            }
            let procedure = self
                .package_context
                .as_ref()
                .and_then(|context| context.current_kind())
                .map_or(self.input.object_type == ObjectSourceKind::Procedure, |kind| {
                    kind == OracleDraftPackageMemberKind::Procedure
                });
            if tokens.len() == 1 {
                return if procedure { Ok(()) } else { Err("A scalar function RETURN needs an expression".into()) };
            }
            if procedure || (self.package_context.is_none() && self.input.object_type != ObjectSourceKind::Function) {
                return Err("A procedure RETURN cannot return a value".into());
            }
            self.expression(tokens[1..].to_vec(), None)?;
            return Ok(());
        }
        if is_word(0, "SELECT") {
            return self.select(tokens);
        }
        if [
            "IF",
            "LOOP",
            "WHILE",
            "FOR",
            "BEGIN",
            "DECLARE",
            "EXCEPTION",
            "EXECUTE",
            "OPEN",
            "CLOSE",
            "FETCH",
            "RAISE",
            "INSERT",
            "UPDATE",
            "DELETE",
            "MERGE",
        ]
        .iter()
        .any(|word| is_word(0, word))
        {
            return Err("This automatic plan supports NULL, RETURN, scalar assignment, static calls and single-relation SELECT INTO; correct or deselect this object".into());
        }
        if tokens.get(1).is_some_and(|token| token.token == Token::Assignment) {
            let Token::Word(word) = &tokens[0].token else {
                return Err("Assignment needs a local scalar target".into());
            };
            let ident = Ident { value: word.value.clone(), quote_style: word.quote_style, span: tokens[0].span };
            if !self.writable(&Expr::Identifier(ident)) {
                return Err("Assignment target is not a writable local scalar".into());
            }
            self.expression(tokens[2..].to_vec(), None)?;
            return Ok(());
        }
        if self.package_context.is_some() {
            if let Some(assignment) = tokens.iter().position(|token| token.token == Token::Assignment) {
                let mut parser =
                    Parser::new(&OracleDialect {}).with_tokens_with_locations(tokens[..assignment].to_vec());
                let target = parser.parse_expr().map_err(|error| error.to_string())?;
                if parser.peek_token_ref().token != Token::EOF || !self.writable(&target) {
                    return Err("Assignment target is not a writable scalar in this package scope".into());
                }
                self.expression(tokens[assignment + 1..].to_vec(), None)?;
                return Ok(());
            }
        }
        let mut parser = Parser::new(&OracleDialect {}).with_tokens_with_locations(tokens);
        let expr = parser.parse_expr().map_err(|error| error.to_string())?;
        if parser.peek_token_ref().token != Token::EOF {
            return Err("Statement is not a complete static procedure call".into());
        }
        match expr {
            Expr::Function(function) => self.call(&function, None, true),
            Expr::Identifier(ident) => self.reference(&[ident], OracleDraftReferenceRole::Procedure, Vec::new(), None),
            Expr::CompoundIdentifier(parts) => {
                self.reference(&parts, OracleDraftReferenceRole::Procedure, Vec::new(), None)
            }
            _ => Err("Only a complete static procedure call is supported in this statement position".into()),
        }
    }
    fn select(&mut self, tokens: Vec<TokenWithSpan>) -> Result<(), String> {
        let mut depth = 0isize;
        let mut into = None;
        let mut from = None;
        for (index, token) in tokens.iter().enumerate() {
            match token.token {
                Token::LParen => depth += 1,
                Token::RParen => depth -= 1,
                _ => {}
            }
            if depth == 0 && token_unquoted_word_is(&token.token, "INTO") && into.replace(index).is_some() {
                return Err("SELECT has more than one INTO scope".into());
            }
            if depth == 0 && token_unquoted_word_is(&token.token, "FROM") && from.replace(index).is_some() {
                return Err("SELECT has more than one FROM scope".into());
            }
        }
        let (into, from) = into
            .zip(from)
            .filter(|(into, from)| into < from)
            .ok_or("A single SELECT INTO ... FROM relation is required")?;
        let targets = &tokens[into + 1..from];
        if targets.is_empty() {
            return Err("SELECT INTO needs local scalar targets".into());
        }
        let mut count = 0;
        for (index, token) in targets.iter().enumerate() {
            if index % 2 == 1 {
                if token.token != Token::Comma {
                    return Err("INTO targets must be a simple scalar list".into());
                }
                continue;
            }
            let Token::Word(word) = &token.token else {
                return Err("INTO targets must be local scalar identifiers".into());
            };
            let ident = Ident { value: word.value.clone(), quote_style: word.quote_style, span: token.span };
            if !self.writable(&Expr::Identifier(ident)) {
                return Err("INTO target is not a writable local scalar".into());
            }
            count += 1;
        }
        if targets.len().is_multiple_of(2) {
            return Err("SELECT INTO target list is incomplete".into());
        }
        let query_tokens = tokens[..into].iter().chain(&tokens[from..]).cloned().collect();
        let statements = Parser::new(&OracleDialect {})
            .with_tokens_with_locations(query_tokens)
            .parse_statements()
            .map_err(|error| error.to_string())?;
        let [Statement::Query(query)] = statements.as_slice() else {
            return Err("A complete single SELECT is required".into());
        };
        if query.with.is_some()
            || query.order_by.is_some()
            || query.limit_clause.is_some()
            || query.fetch.is_some()
            || !query.locks.is_empty()
            || query.for_clause.is_some()
            || query.settings.is_some()
            || query.format_clause.is_some()
            || !query.pipe_operators.is_empty()
        {
            return Err("Additional SELECT query scopes or clauses need manual correction".into());
        }
        let SetExpr::Select(select) = query.body.as_ref() else {
            return Err("Set operations or nested SELECT bodies are not supported".into());
        };
        if !select.optimizer_hints.is_empty()
            || select.distinct.is_some()
            || select.select_modifiers.is_some()
            || select.top.is_some()
            || select.exclude.is_some()
            || select.into.is_some()
            || !select.lateral_views.is_empty()
            || select.prewhere.is_some()
            || !select.connect_by.is_empty()
            || !matches!(&select.group_by, GroupByExpr::Expressions(values, modifiers) if values.is_empty() && modifiers.is_empty())
            || !select.cluster_by.is_empty()
            || !select.distribute_by.is_empty()
            || !select.sort_by.is_empty()
            || select.having.is_some()
            || !select.named_window.is_empty()
            || select.qualify.is_some()
            || select.value_table_mode.is_some()
            || select.flavor != SelectFlavor::Standard
        {
            return Err("Only a plain single-relation SELECT with optional WHERE is supported".into());
        }
        if select.projection.len() != count || select.from.len() != 1 || !select.from[0].joins.is_empty() {
            return Err("SELECT projection and scalar INTO targets must match; joins require manual correction".into());
        }
        let TableFactor::Table {
            name: relation,
            alias,
            args,
            with_hints,
            version,
            with_ordinality,
            partitions,
            json_path,
            sample,
            index_hints,
        } = &select.from[0].relation
        else {
            return Err("SELECT requires one ordinary table or view".into());
        };
        if args.is_some()
            || !with_hints.is_empty()
            || version.is_some()
            || *with_ordinality
            || !partitions.is_empty()
            || json_path.is_some()
            || sample.is_some()
            || !index_hints.is_empty()
            || alias.as_ref().is_some_and(|alias| !alias.columns.is_empty())
        {
            return Err("Table functions, derived names and relation modifiers are not supported".into());
        }
        let parts = object_parts(relation)?;
        if parts.len() > 2 {
            return Err("A relation must be name or owner.name without a database link".into());
        }
        let query_index = self.output.queries.len();
        let relation_reference = self.output.references.len();
        self.reference(&parts, OracleDraftReferenceRole::Relation, Vec::new(), Some(query_index))?;
        self.output
            .queries
            .push(OracleDraftQuery { relation_reference, alias: alias.as_ref().map(|alias| name(&alias.name)) });
        for item in &select.projection {
            match item {
                SelectItem::UnnamedExpr(expr) | SelectItem::ExprWithAlias { expr, .. } => {
                    self.visit_expr(expr, Some(query_index))?
                }
                _ => return Err("Project scalar expressions explicitly rather than SELECT *".into()),
            }
        }
        if let Some(expr) = &select.selection {
            self.visit_expr(expr, Some(query_index))?;
        }
        Ok(())
    }
}

pub fn analyze_oracle_routine_draft(input: EditableObjectSourceSqlInput) -> OracleRoutineDraftAnalysis {
    analyze_draft(input, None)
}

pub fn analyze_oracle_package_body_draft(
    input: EditableObjectSourceSqlInput,
    specification: EditableObjectSourceSqlInput,
) -> OracleRoutineDraftAnalysis {
    if input.object_type != ObjectSourceKind::PackageBody
        || specification.object_type != ObjectSourceKind::Package
        || input.database_type != specification.database_type
        || input.schema != specification.schema
        || input.name != specification.name
    {
        return OracleRoutineDraftAnalysis {
            issues: vec![OracleDraftIssue {
                code: "manual-static-correction".into(),
                message: "The body requires its exact final specification identity and product".into(),
                line: 1,
                column: 1,
            }],
            ..Default::default()
        };
    }
    let contract = analyze_oracle_routine_draft(specification);
    if !contract.complete {
        return contract;
    }
    let has_package_initialization = contract.has_package_initialization;
    let mut analysis = analyze_draft(input, Some(contract.package_members));
    analysis.has_package_initialization |= has_package_initialization;
    analysis
}

fn analyze_draft(
    input: EditableObjectSourceSqlInput,
    contract: Option<Vec<OracleDraftPackageMember>>,
) -> OracleRoutineDraftAnalysis {
    let mut analysis = Analysis {
        input: &input,
        tokens: Vec::new(),
        pos: 0,
        bindings: BTreeMap::new(),
        output: OracleRoutineDraftAnalysis::default(),
        issue_position: None,
        package_context: None,
    };
    let parsed: Result<(), String> = (|| {
        validate_oracle_routine_target_definition(input.clone(), None)?;
        analysis.tokens = Tokenizer::new(&OracleDialect {}, &input.source)
            .tokenize_with_location()
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|token| !matches!(token.token, Token::Whitespace(_) | Token::EOF))
            .collect();
        if let Some(contract) = contract {
            package::parse_body(&mut analysis, contract)
        } else {
            analysis.parse()
        }
    })();
    match parsed {
        Ok(()) => analysis.output.complete = true,
        Err(message) => {
            let position = analysis
                .issue_position
                .or_else(|| analysis.current().or_else(|| analysis.tokens.last()).map(|token| token.span.start));
            analysis.output.issues.push(OracleDraftIssue {
                code: "manual-static-correction".into(),
                message,
                line: position.map_or(1, |position| position.line),
                column: position.map_or(1, |position| position.column),
            });
        }
    }
    analysis.output
}

#[cfg(test)]
mod tests;
