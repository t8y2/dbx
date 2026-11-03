use super::*;
use std::collections::BTreeSet;

pub(super) struct PackageContext {
    owner: Option<String>,
    name: String,
    members: BTreeMap<String, OracleDraftPackageMember>,
    available_values: Option<BTreeSet<String>>,
    current_member: Option<OracleDraftName>,
    local_exceptions: BTreeSet<String>,
    exited_bindings: BTreeSet<String>,
}

pub(super) enum PackageReference {
    External,
    Closed,
    SqlValue(OracleDraftPackageMemberKind),
}

struct DeferredExpression {
    tokens: Vec<TokenWithSpan>,
    bindings: BTreeMap<String, bool>,
    values: BTreeSet<String>,
    caller: Option<OracleDraftName>,
}

impl PackageContext {
    pub(super) fn current_kind(&self) -> Option<OracleDraftPackageMemberKind> {
        self.current_member.as_ref().and_then(|member| self.members.get(&member.value)).map(|member| member.kind)
    }
    fn member<'a>(&'a self, parts: &[Ident]) -> Result<Option<&'a OracleDraftPackageMember>, String> {
        let qualified = match parts {
            [_] => false,
            [package, _] if canonical(package) == self.name => true,
            [owner, package, _]
                if self.owner.as_deref() == Some(canonical(owner).as_str()) && canonical(package) == self.name =>
            {
                true
            }
            _ => return Ok(None),
        };
        let key = canonical(parts.last().ok_or("A package member identity is required")?);
        let member = self.members.get(&key);
        if qualified && member.is_none() {
            return Err(format!("Package member {key} is not declared in the final package draft"));
        }
        Ok(member)
    }
}

pub(super) fn parse_body(analysis: &mut Analysis<'_>, contract: Vec<OracleDraftPackageMember>) -> Result<(), String> {
    let public = contract.iter().cloned().map(|member| (member.name.value.clone(), member)).collect::<BTreeMap<_, _>>();
    analysis.package_context = Some(PackageContext {
        owner: analysis.input.schema.clone(),
        name: analysis.input.name.clone(),
        members: public.clone(),
        available_values: None,
        current_member: None,
        local_exceptions: BTreeSet::new(),
        exited_bindings: BTreeSet::new(),
    });
    body_pass(analysis, &public)?;
    let collected = analysis.package_context.as_ref().expect("body scope was collected").members.clone();
    analysis.pos = 0;
    analysis.bindings.clear();
    analysis.output = OracleRoutineDraftAnalysis::default();
    analysis.package_context = Some(PackageContext {
        owner: analysis.input.schema.clone(),
        name: analysis.input.name.clone(),
        members: collected,
        available_values: None,
        current_member: None,
        local_exceptions: BTreeSet::new(),
        exited_bindings: BTreeSet::new(),
    });
    body_pass(analysis, &public)?;
    analysis.output.package_members =
        analysis.package_context.as_ref().expect("body scope was checked").members.values().cloned().collect();
    Ok(())
}

fn matching_signature(implementation: &OracleDraftPackageMember, contract: &OracleDraftPackageMember) -> bool {
    implementation.kind == contract.kind
        && implementation.return_type == contract.return_type
        && implementation.parameters.len() == contract.parameters.len()
        && implementation.parameters.iter().zip(&contract.parameters).all(|(body, spec)| {
            body.name.value == spec.name.value
                && body.mode == spec.mode
                && body.data_type == spec.data_type
                && body.default_expression.as_ref().is_none_or(|value| spec.default_expression.as_ref() == Some(value))
        })
}

fn body_pass(analysis: &mut Analysis<'_>, public: &BTreeMap<String, OracleDraftPackageMember>) -> Result<(), String> {
    analysis.expect_word("CREATE")?;
    if analysis.consume_word("OR") {
        analysis.expect_word("REPLACE")?;
    }
    if analysis.word("EDITIONABLE") || analysis.word("NONEDITIONABLE") {
        return Err("Package edition options require verified target edition identity and capabilities; retain or explicitly revise this target draft".into());
    }
    analysis.expect_word("PACKAGE")?;
    analysis.expect_word("BODY")?;
    analysis.parts()?;
    if !analysis.consume_word("AS") && !analysis.consume_word("IS") {
        return Err("Expected the package body AS or IS declaration".into());
    }
    let mut declared = BTreeSet::new();
    while !analysis.word("END") && !analysis.word("BEGIN") {
        let kind = if analysis.consume_word("FUNCTION") {
            Some(OracleDraftPackageMemberKind::Function)
        } else if analysis.consume_word("PROCEDURE") {
            Some(OracleDraftPackageMemberKind::Procedure)
        } else {
            None
        };
        if kind.is_none() && ["TYPE", "SUBTYPE", "CURSOR", "PRAGMA"].iter().any(|word| analysis.word(word)) {
            return Err("Package TYPE, cursor and pragma declarations require manual correction".into());
        }
        let ident = analysis.ident()?;
        let key = canonical(&ident);
        if !declared.insert(key.clone()) {
            return Err("Package overloads and duplicate body declarations are not supported".into());
        }
        if let Some(kind) = kind {
            let mut defaults = Vec::new();
            let mut member = OracleDraftPackageMember {
                name: name(&ident),
                kind,
                parameters: parameters(analysis, &BTreeSet::new(), &name(&ident), &mut defaults)?,
                return_type: None,
                data_type: None,
                default_expression: None,
                public: public.contains_key(&key),
                defined: true,
                line: ident.span.start.line,
                column: ident.span.start.column,
            };
            if kind == OracleDraftPackageMemberKind::Function {
                analysis.expect_word("RETURN")?;
                member.return_type = Some(analysis.scalar_type()?);
            }
            if let Some(contract) = public.get(&key) {
                if !matching_signature(&member, contract) {
                    return Err(format!(
                        "Package member {key} does not match its final specification signature or defaults"
                    ));
                }
                member.parameters = contract.parameters.clone();
            }
            analysis.package_context.as_mut().expect("body context exists").members.insert(key.clone(), member.clone());
            analysis.package_context.as_mut().expect("body context exists").current_member = Some(member.name.clone());
            if !analysis.consume_word("IS") && !analysis.consume_word("AS") {
                return Err("A package member needs a complete implementation, not a forward declaration".into());
            }
            analysis.bindings = member
                .parameters
                .iter()
                .map(|parameter| (parameter.name.value.clone(), parameter.mode != "IN"))
                .collect();
            for expression in defaults {
                let bindings = std::mem::replace(&mut analysis.bindings, expression.bindings);
                analysis.expression(expression.tokens, None)?;
                analysis.bindings = bindings;
            }
            scalar_declarations(analysis, false)?;
            analysis.expect_word("BEGIN")?;
            block_contents(analysis, 0, false)?;
            analysis.expect_word("END")?;
            if !analysis.consume(Token::SemiColon) {
                if canonical(&analysis.ident()?) != key {
                    return Err("Package member END name does not match its declaration".into());
                }
                analysis.expect(Token::SemiColon)?;
            }
            analysis.bindings.clear();
            analysis.package_context.as_mut().expect("body context exists").local_exceptions.clear();
            analysis.package_context.as_mut().expect("body context exists").exited_bindings.clear();
            analysis.package_context.as_mut().expect("body context exists").current_member = None;
        } else {
            if public.contains_key(&key) {
                return Err(format!("Package body redeclares public member {key}"));
            }
            let mut member = OracleDraftPackageMember {
                name: name(&ident),
                kind: OracleDraftPackageMemberKind::Variable,
                parameters: Vec::new(),
                return_type: None,
                data_type: None,
                default_expression: None,
                public: false,
                defined: true,
                line: ident.span.start.line,
                column: ident.span.start.column,
            };
            if analysis.consume_word("EXCEPTION") {
                member.kind = OracleDraftPackageMemberKind::Exception;
            } else {
                let constant = analysis.consume_word("CONSTANT");
                if constant {
                    member.kind = OracleDraftPackageMemberKind::Constant;
                }
                member.data_type = Some(analysis.scalar_type()?);
                if analysis.consume_word("NOT") {
                    analysis.expect_word("NULL")?;
                }
                if analysis.consume(Token::Assignment) || analysis.consume_word("DEFAULT") {
                    let tokens = analysis.expression_tokens_until(&[Token::SemiColon])?;
                    member.default_expression = Some(expression_key(&tokens));
                    analysis.output.has_package_initialization = true;
                    analysis.expression(tokens, None)?;
                } else if constant {
                    return Err("Package constants require a complete initializer".into());
                }
            }
            analysis.expect(Token::SemiColon)?;
            analysis.package_context.as_mut().expect("body context exists").members.insert(key, member);
        }
    }
    if analysis.consume_word("BEGIN") {
        analysis.output.has_package_initialization = true;
        block_contents(analysis, 0, false)?;
    }
    analysis.expect_word("END")?;
    if !analysis.consume(Token::SemiColon) {
        if canonical(&analysis.ident()?) != analysis.input.name {
            return Err("The package body END name does not match its identity".into());
        }
        analysis.expect(Token::SemiColon)?;
    }
    if analysis.pos != analysis.tokens.len() {
        return Err("Extra package body statements or trailing syntax are not approved".into());
    }
    for member in public.values().filter(|member| !member.defined) {
        if !declared.contains(&member.name.value) {
            return Err(format!("Public package member {} has no body implementation", member.name.value));
        }
    }
    Ok(())
}

fn scalar_declarations(analysis: &mut Analysis<'_>, shadow: bool) -> Result<(), String> {
    let mut declared: BTreeSet<_> = if shadow { BTreeSet::new() } else { analysis.bindings.keys().cloned().collect() };
    while !analysis.word("BEGIN") {
        if ["FUNCTION", "PROCEDURE", "TYPE", "SUBTYPE", "CURSOR", "PRAGMA"].iter().any(|word| analysis.word(word)) {
            return Err("Nested routines, TYPE, cursor and pragma declarations require manual correction".into());
        }
        let ident = analysis.ident()?;
        let key = canonical(&ident);
        if !declared.insert(key.clone()) {
            return Err("Duplicate local declaration in the same package member or block".into());
        }
        if analysis.consume_word("EXCEPTION") {
            analysis.expect(Token::SemiColon)?;
            analysis.bindings.insert(key.clone(), false);
            analysis.package_context.as_mut().expect("package scope exists").local_exceptions.insert(key);
            continue;
        }
        let constant = analysis.consume_word("CONSTANT");
        analysis.scalar_type()?;
        if analysis.consume_word("NOT") {
            analysis.expect_word("NULL")?;
        }
        if analysis.consume(Token::Assignment) || analysis.consume_word("DEFAULT") {
            let tokens = analysis.expression_tokens_until(&[Token::SemiColon])?;
            analysis.expression(tokens, None)?;
        } else if constant {
            return Err("A scalar constant requires an initializer".into());
        }
        analysis.expect(Token::SemiColon)?;
        analysis.package_context.as_mut().expect("package scope exists").local_exceptions.remove(&key);
        analysis.bindings.insert(key, !constant);
    }
    Ok(())
}

fn statements(analysis: &mut Analysis<'_>, stops: &[&str], loops: usize, handler: bool) -> Result<(), String> {
    let start = analysis.pos;
    while !stops.iter().any(|stop| analysis.word(stop)) {
        let position = analysis.current().map(|token| token.span.start);
        if analysis.consume_word("IF") {
            condition_until(analysis, "THEN")?;
            statements(analysis, &["ELSIF", "ELSE", "END"], loops, handler)?;
            while analysis.consume_word("ELSIF") {
                condition_until(analysis, "THEN")?;
                statements(analysis, &["ELSIF", "ELSE", "END"], loops, handler)?;
            }
            if analysis.consume_word("ELSE") {
                statements(analysis, &["END"], loops, handler)?;
            }
            analysis.expect_word("END")?;
            analysis.expect_word("IF")?;
            analysis.expect(Token::SemiColon)?;
            continue;
        }
        if analysis.word("LOOP") || analysis.word("WHILE") || analysis.word("FOR") {
            let mut old_index = None;
            let mut index_name = None;
            let mut old_exception = false;
            if analysis.consume_word("WHILE") {
                condition_until(analysis, "LOOP")?;
            } else if analysis.consume_word("FOR") {
                let index = analysis.ident()?;
                analysis.expect_word("IN")?;
                let _ = analysis.consume_word("REVERSE");
                let bounds = tokens_until_word(analysis, "LOOP")?;
                let (lower, upper) = range_bounds(bounds)?;
                analysis.expression(lower, None)?;
                analysis.expression(upper, None)?;
                analysis.expect_word("LOOP")?;
                let key = canonical(&index);
                old_index = analysis.bindings.insert(key.clone(), false);
                old_exception =
                    analysis.package_context.as_mut().expect("package context exists").local_exceptions.remove(&key);
                index_name = Some(key);
            } else {
                analysis.expect_word("LOOP")?;
            }
            statements(analysis, &["END"], loops + 1, handler)?;
            analysis.expect_word("END")?;
            analysis.expect_word("LOOP")?;
            analysis.expect(Token::SemiColon)?;
            if let Some(key) = index_name {
                if let Some(value) = old_index {
                    analysis.bindings.insert(key.clone(), value);
                } else {
                    analysis.bindings.remove(&key);
                    analysis
                        .package_context
                        .as_mut()
                        .expect("package context exists")
                        .exited_bindings
                        .insert(key.clone());
                }
                if old_exception {
                    analysis.package_context.as_mut().expect("package context exists").local_exceptions.insert(key);
                }
            }
            continue;
        }
        if analysis.consume_word("EXIT") || analysis.consume_word("CONTINUE") {
            if loops == 0 {
                return Err("EXIT and CONTINUE require a surrounding loop".into());
            }
            if analysis.consume_word("WHEN") {
                let tokens = analysis.expression_tokens_until(&[Token::SemiColon])?;
                analysis.expression(tokens, None)?;
            }
            analysis.expect(Token::SemiColon)?;
            continue;
        }
        if analysis.word("DECLARE") || analysis.word("BEGIN") {
            let saved_bindings = analysis.bindings.clone();
            let saved_exceptions =
                analysis.package_context.as_ref().expect("package context exists").local_exceptions.clone();
            if analysis.consume_word("DECLARE") {
                scalar_declarations(analysis, true)?;
            }
            analysis.expect_word("BEGIN")?;
            block_contents(analysis, loops, handler)?;
            analysis.expect_word("END")?;
            analysis.expect(Token::SemiColon)?;
            let exited =
                analysis.bindings.keys().filter(|key| !saved_bindings.contains_key(*key)).cloned().collect::<Vec<_>>();
            analysis.package_context.as_mut().expect("package context exists").exited_bindings.extend(exited);
            analysis.bindings = saved_bindings;
            analysis.package_context.as_mut().expect("package context exists").local_exceptions = saved_exceptions;
            continue;
        }
        if analysis.consume_word("RAISE") {
            if !analysis.current().is_some_and(|token| token.token == Token::SemiColon) {
                let parts = analysis.parts()?;
                exception_reference(analysis, &parts)?;
            } else if !handler {
                return Err("Bare RAISE is valid only inside an exception handler".into());
            }
            analysis.expect(Token::SemiColon)?;
            continue;
        }
        let tokens = analysis.expression_tokens_until(&[Token::SemiColon])?;
        analysis.expect(Token::SemiColon)?;
        if let Err(error) = analysis.statement(tokens) {
            analysis.issue_position = analysis.issue_position.or(position);
            return Err(error);
        }
    }
    if analysis.pos == start {
        return Err("A package block or control-flow branch requires at least one statement".into());
    }
    Ok(())
}

fn tokens_until_word(analysis: &mut Analysis<'_>, word: &str) -> Result<Vec<TokenWithSpan>, String> {
    let start = analysis.pos;
    let mut depth = 0isize;
    while let Some(token) = analysis.current() {
        if depth == 0 && analysis.word(word) {
            break;
        }
        match token.token {
            Token::LParen => depth += 1,
            Token::RParen => depth -= 1,
            Token::SemiColon if depth == 0 => break,
            _ => {}
        }
        if depth < 0 {
            return Err("Unmatched closing parenthesis in package control flow".into());
        }
        analysis.pos += 1;
    }
    if depth != 0 || analysis.pos == start || !analysis.word(word) {
        return Err(format!("A complete expression followed by {word} is required"));
    }
    Ok(analysis.tokens[start..analysis.pos].to_vec())
}

fn condition_until(analysis: &mut Analysis<'_>, word: &str) -> Result<(), String> {
    let tokens = tokens_until_word(analysis, word)?;
    analysis.expression(tokens, None)?;
    analysis.expect_word(word)
}

fn range_bounds(mut tokens: Vec<TokenWithSpan>) -> Result<(Vec<TokenWithSpan>, Vec<TokenWithSpan>), String> {
    for index in 0..tokens.len().saturating_sub(1) {
        let left = tokens[index].token.to_string();
        let right = tokens[index + 1].token.to_string();
        let left_dot = tokens[index].token == Token::Period
            || matches!(&tokens[index].token, Token::Number(value, _) if value.ends_with('.'));
        let right_dot = tokens[index + 1].token == Token::Period
            || matches!(&tokens[index + 1].token, Token::Number(value, _) if value.starts_with('.'));
        if !left_dot || !right_dot {
            continue;
        }
        let mut upper = tokens.split_off(index + 2);
        let right_token = tokens.pop().expect("range right delimiter exists");
        let left_token = tokens.pop().expect("range left delimiter exists");
        if left != "." {
            let mut token = left_token;
            token.token = Token::Number(left[..left.len() - 1].into(), false);
            token.span.end.column -= 1;
            tokens.push(token);
        }
        if right != "." {
            let mut token = right_token;
            token.token = Token::Number(right[1..].into(), false);
            token.span.start.column += 1;
            upper.insert(0, token);
        }
        if tokens.is_empty() || upper.is_empty() {
            break;
        }
        return Ok((tokens, upper));
    }
    Err("A numeric FOR requires complete lower..upper bounds; cursor loops require manual correction".into())
}

fn exception_reference(analysis: &mut Analysis<'_>, parts: &[Ident]) -> Result<(), String> {
    let context = analysis.package_context.as_ref().expect("package context exists");
    if let [ident] = parts {
        let key = canonical(ident);
        if context.local_exceptions.contains(&key) {
            return Ok(());
        }
        if analysis.bindings.contains_key(&key) {
            return Err(format!("Scalar {key} is not an exception"));
        }
        if ident.quote_style.is_none()
            && [
                "ACCESS_INTO_NULL",
                "CASE_NOT_FOUND",
                "COLLECTION_IS_NULL",
                "CURSOR_ALREADY_OPEN",
                "DUP_VAL_ON_INDEX",
                "INVALID_CURSOR",
                "INVALID_NUMBER",
                "LOGIN_DENIED",
                "NO_DATA_FOUND",
                "NOT_LOGGED_ON",
                "PROGRAM_ERROR",
                "ROWTYPE_MISMATCH",
                "SELF_IS_NULL",
                "STORAGE_ERROR",
                "SUBSCRIPT_BEYOND_COUNT",
                "SUBSCRIPT_OUTSIDE_LIMIT",
                "SYS_INVALID_ROWID",
                "TIMEOUT_ON_RESOURCE",
                "TOO_MANY_ROWS",
                "VALUE_ERROR",
                "ZERO_DIVIDE",
            ]
            .contains(&key.as_str())
        {
            return Ok(());
        }
    }
    if context.member(parts)?.is_some_and(|member| member.kind == OracleDraftPackageMemberKind::Exception) {
        return Ok(());
    }
    if parts.len() >= 2 {
        return analysis.reference(parts, OracleDraftReferenceRole::Exception, Vec::new(), None);
    }
    Err("The exception name is not bound in the final package or lexical scope".into())
}

fn block_contents(analysis: &mut Analysis<'_>, loops: usize, handler: bool) -> Result<(), String> {
    statements(analysis, &["EXCEPTION", "END"], loops, handler)?;
    if analysis.consume_word("EXCEPTION") {
        let mut others = false;
        analysis.expect_word("WHEN")?;
        loop {
            if others {
                return Err("WHEN OTHERS must be the final exception handler".into());
            }
            if analysis.consume_word("OTHERS") {
                others = true;
            } else {
                loop {
                    let parts = analysis.parts()?;
                    exception_reference(analysis, &parts)?;
                    if !analysis.consume_word("OR") {
                        break;
                    }
                }
            }
            analysis.expect_word("THEN")?;
            statements(analysis, &["WHEN", "END"], loops, true)?;
            if !analysis.consume_word("WHEN") {
                break;
            }
        }
    }
    Ok(())
}

impl Analysis<'_> {
    pub(super) fn check_package_lexical_reference(
        &self,
        parts: &[Ident],
        role: &OracleDraftReferenceRole,
        query: Option<usize>,
    ) -> Result<(), String> {
        let Some(context) = &self.package_context else {
            return Ok(());
        };
        if query.is_some() && *role == OracleDraftReferenceRole::Value {
            return Ok(());
        }
        let key = canonical(&parts[0]);
        if context.local_exceptions.contains(&key) && *role != OracleDraftReferenceRole::Exception {
            return Err(format!("Exception {key} cannot be used as a scalar value or call qualifier"));
        }
        if parts.len() == 1
            && !self.bindings.contains_key(&key)
            && !context.members.contains_key(&key)
            && context.exited_bindings.contains(&key)
        {
            return Err(format!(
                "Local binding {key} is outside its lexical block or loop; qualify an intended external reference"
            ));
        }
        Ok(())
    }

    pub(super) fn package_local_exception(&self, parts: &[Ident]) -> bool {
        parts.len() == 1
            && self
                .package_context
                .as_ref()
                .is_some_and(|context| context.local_exceptions.contains(&canonical(&parts[0])))
    }

    pub(super) fn package_exited_binding(&self, parts: &[Ident]) -> bool {
        parts.len() == 1
            && self
                .package_context
                .as_ref()
                .is_some_and(|context| context.exited_bindings.contains(&canonical(&parts[0])))
    }
    pub(super) fn package_reference(
        &mut self,
        parts: &[Ident],
        role: &OracleDraftReferenceRole,
        arguments: &[bool],
        query: Option<usize>,
    ) -> Result<PackageReference, String> {
        if *role == OracleDraftReferenceRole::Relation {
            return Ok(PackageReference::External);
        }
        if parts.len() > 1
            && query
                .and_then(|query| self.output.queries.get(query))
                .and_then(|query| query.alias.as_ref())
                .is_some_and(|alias| alias.value == canonical(&parts[0]))
        {
            return Ok(PackageReference::External);
        }
        let Some(context) = &self.package_context else { return Ok(PackageReference::External) };
        let Some(member) = context.member(parts)? else { return Ok(PackageReference::External) };
        if matches!(
            member.kind,
            OracleDraftPackageMemberKind::Variable
                | OracleDraftPackageMemberKind::Constant
                | OracleDraftPackageMemberKind::Exception
        ) && context.available_values.as_ref().is_some_and(|values| !values.contains(&member.name.value))
        {
            return Err(format!("Package value {} is used before its declaration", member.name.value));
        }
        if query.is_some() && *role == OracleDraftReferenceRole::Value {
            return Ok(PackageReference::SqlValue(member.kind));
        }
        match member.kind {
            OracleDraftPackageMemberKind::Exception if *role == OracleDraftReferenceRole::Exception => {
                return Ok(PackageReference::Closed)
            }
            OracleDraftPackageMemberKind::Variable | OracleDraftPackageMemberKind::Constant
                if *role == OracleDraftReferenceRole::Value =>
            {
                return Ok(PackageReference::Closed)
            }
            OracleDraftPackageMemberKind::Function
                if matches!(role, OracleDraftReferenceRole::Function | OracleDraftReferenceRole::Value) => {}
            OracleDraftPackageMemberKind::Procedure if *role == OracleDraftReferenceRole::Procedure => {}
            _ => return Err(format!("Package member {} has an incompatible scalar or call role", member.name.value)),
        }
        if arguments.len() > member.parameters.len()
            || member.parameters[arguments.len()..].iter().any(|parameter| !parameter.has_default)
        {
            return Err(format!("Package member {} arguments do not match its final declaration", member.name.value));
        }
        if member.parameters.iter().zip(arguments).any(|(parameter, writable)| parameter.mode != "IN" && !writable) {
            return Err(format!("Package member {} OUT arguments require writable scalar targets", member.name.value));
        }
        self.output.package_calls.push(OracleDraftPackageCall {
            caller: context.current_member.clone(),
            callee: member.name.clone(),
            line: parts[0].span.start.line,
            column: parts[0].span.start.column,
        });
        Ok(PackageReference::Closed)
    }

    pub(super) fn package_writable(&self, expr: &Expr) -> bool {
        let parts = match expr {
            Expr::Identifier(ident) => std::slice::from_ref(ident),
            Expr::CompoundIdentifier(parts) => parts,
            _ => return false,
        };
        if parts.first().is_some_and(|ident| self.bindings.contains_key(&canonical(ident))) {
            return false;
        }
        self.package_context
            .as_ref()
            .and_then(|context| context.member(parts).ok().flatten())
            .is_some_and(|member| member.kind == OracleDraftPackageMemberKind::Variable)
    }
}

fn expression_key(tokens: &[TokenWithSpan]) -> String {
    tokens
        .iter()
        .map(|token| match &token.token {
            Token::Word(word) if word.quote_style.is_none() => word.value.to_uppercase(),
            _ => token.token.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn parameters(
    analysis: &mut Analysis<'_>,
    values: &BTreeSet<String>,
    caller: &OracleDraftName,
    deferred: &mut Vec<DeferredExpression>,
) -> Result<Vec<OracleDraftParameter>, String> {
    let mut parameters = Vec::new();
    let mut bindings = BTreeMap::new();
    if !analysis.consume(Token::LParen) || analysis.consume(Token::RParen) {
        return Ok(parameters);
    }
    loop {
        let ident = analysis.ident()?;
        if bindings.contains_key(&canonical(&ident)) {
            return Err("Duplicate package parameter names are not supported".into());
        }
        let mode = if analysis.consume_word("IN") {
            if analysis.consume_word("OUT") {
                "IN OUT"
            } else {
                "IN"
            }
        } else if analysis.consume_word("OUT") {
            "OUT"
        } else {
            "IN"
        };
        let data_type = analysis.scalar_type()?;
        let has_default = analysis.consume_word("DEFAULT") || analysis.consume(Token::Assignment);
        let default_expression = if has_default {
            if mode != "IN" {
                return Err("Only IN parameters can have package defaults".into());
            }
            let tokens = analysis.expression_tokens_until(&[Token::Comma, Token::RParen])?;
            let expression = expression_key(&tokens);
            deferred.push(DeferredExpression {
                tokens,
                bindings: bindings.clone(),
                values: values.clone(),
                caller: Some(caller.clone()),
            });
            Some(expression)
        } else {
            None
        };
        bindings.insert(canonical(&ident), mode != "IN");
        parameters.push(OracleDraftParameter {
            name: name(&ident),
            mode: mode.into(),
            data_type,
            has_default,
            default_expression,
        });
        if analysis.consume(Token::RParen) {
            return Ok(parameters);
        }
        analysis.expect(Token::Comma)?;
    }
}

pub(super) fn parse_specification(analysis: &mut Analysis<'_>) -> Result<(), String> {
    analysis.expect_word("CREATE")?;
    if analysis.consume_word("OR") {
        analysis.expect_word("REPLACE")?;
    }
    if analysis.word("EDITIONABLE") || analysis.word("NONEDITIONABLE") {
        return Err("Package edition options require verified target edition identity and capabilities; retain or explicitly revise this target draft".into());
    }
    analysis.expect_word("PACKAGE")?;
    let declaration = analysis.parts()?;
    let owner = analysis.input.schema.clone().or_else(|| (declaration.len() == 2).then(|| canonical(&declaration[0])));
    if analysis.consume_word("AUTHID") {
        analysis.expect_word("DEFINER")?;
    }
    if !analysis.consume_word("AS") && !analysis.consume_word("IS") {
        return Err("Package headers support only the static AUTHID DEFINER form; retain and revise this draft".into());
    }
    let mut members = Vec::new();
    let mut names = BTreeSet::new();
    let mut values = BTreeSet::new();
    let mut deferred = Vec::new();
    while !analysis.word("END") {
        if analysis.current().is_none() {
            return Err("The package specification needs a complete END".into());
        }
        let method = if analysis.consume_word("FUNCTION") {
            Some(OracleDraftPackageMemberKind::Function)
        } else if analysis.consume_word("PROCEDURE") {
            Some(OracleDraftPackageMemberKind::Procedure)
        } else {
            None
        };
        if method.is_none()
            && ["TYPE", "SUBTYPE", "CURSOR", "PRAGMA", "BEGIN"].iter().any(|keyword| analysis.word(keyword))
        {
            return Err(
                "Package TYPE, cursors, pragmas and additional declaration forms require manual correction".into()
            );
        }
        let ident = analysis.ident()?;
        let member_name = name(&ident);
        if !names.insert(member_name.value.clone()) {
            return Err("Package overloads or duplicate declarations are not supported by this automatic plan".into());
        }
        let mut member = OracleDraftPackageMember {
            name: member_name.clone(),
            kind: OracleDraftPackageMemberKind::Variable,
            parameters: Vec::new(),
            return_type: None,
            data_type: None,
            default_expression: None,
            public: true,
            defined: true,
            line: ident.span.start.line,
            column: ident.span.start.column,
        };
        if let Some(kind) = method {
            member.kind = kind;
            member.defined = false;
            member.parameters = parameters(analysis, &values, &member_name, &mut deferred)?;
            if kind == OracleDraftPackageMemberKind::Function {
                analysis.expect_word("RETURN")?;
                member.return_type = Some(analysis.scalar_type()?);
            }
        } else if analysis.consume_word("EXCEPTION") {
            member.kind = OracleDraftPackageMemberKind::Exception;
            values.insert(member_name.value.clone());
        } else {
            let constant = analysis.consume_word("CONSTANT");
            if constant {
                member.kind = OracleDraftPackageMemberKind::Constant;
            }
            member.data_type = Some(analysis.scalar_type()?);
            if analysis.consume_word("NOT") {
                analysis.expect_word("NULL")?;
            }
            if analysis.consume(Token::Assignment) || analysis.consume_word("DEFAULT") {
                let tokens = analysis.expression_tokens_until(&[Token::SemiColon])?;
                member.default_expression = Some(expression_key(&tokens));
                analysis.output.has_package_initialization = true;
                deferred.push(DeferredExpression {
                    tokens,
                    bindings: BTreeMap::new(),
                    values: values.clone(),
                    caller: None,
                });
            } else if constant {
                return Err("Package constants require a complete initializer".into());
            }
            values.insert(member_name.value.clone());
        }
        analysis.expect(Token::SemiColon)?;
        members.push(member);
    }
    analysis.expect_word("END")?;
    if !analysis.current().is_some_and(|token| token.token == Token::SemiColon) {
        let end = analysis.ident()?;
        if canonical(&end) != analysis.input.name {
            return Err("The package END name does not match its exact identity".into());
        }
    }
    analysis.expect(Token::SemiColon)?;
    if analysis.pos != analysis.tokens.len() {
        return Err("Extra package statements or trailing syntax are not approved".into());
    }
    analysis.package_context = Some(PackageContext {
        owner,
        name: analysis.input.name.clone(),
        members: members.iter().cloned().map(|member| (member.name.value.clone(), member)).collect(),
        available_values: None,
        current_member: None,
        local_exceptions: BTreeSet::new(),
        exited_bindings: BTreeSet::new(),
    });
    analysis.output.package_members = members;
    for expression in deferred {
        analysis.bindings = expression.bindings;
        let context = analysis.package_context.as_mut().expect("package declaration was collected");
        context.available_values = Some(expression.values);
        context.current_member = expression.caller;
        analysis.expression(expression.tokens, None)?;
    }
    analysis.bindings.clear();
    Ok(())
}
