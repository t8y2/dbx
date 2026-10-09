//! Explicit compatibility for legacy text bytes stored in a LATIN1 database.
//! The wire protocol remains UTF8. ISO-8859-1 here is the byte carrier, not
//! Windows-1252 (in particular, bytes 0x80..0x9f must round-trip unchanged).
use bytes::BytesMut;
use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokio_postgres::types::{FromSql, IsNull, Kind, ToSql, Type};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TextEncoding(pub &'static encoding_rs::Encoding);

impl TextEncoding {
    pub fn from_params(client: Option<&str>, server: Option<&str>) -> Result<Option<Self>, String> {
        let normalized = |s: &str| s.trim().replace(['-', '_'], "").to_ascii_uppercase();
        match (client, server) {
            (None, None) => Ok(None),
            (Some(client), Some(server)) => {
                if !matches!(normalized(server).as_str(), "LATIN1" | "ISO88591") {
                    return Err("serverEncoding must be LATIN1 or ISO-8859-1 for legacy text conversion".into());
                }
                let encoding = match normalized(client).as_str() {
                    "GB18030" => encoding_rs::GB18030,
                    "GBK" => encoding_rs::GBK,
                    "UTF8" => encoding_rs::UTF_8,
                    _ => return Err("clientEncoding must be GB18030, GBK or UTF-8".into()),
                };
                Ok(Some(Self(encoding)))
            }
            _ => Err("clientEncoding and serverEncoding must be configured together".into()),
        }
    }

    pub fn decode(self, text: &str) -> Result<String, String> {
        if text.is_ascii() {
            return Ok(text.to_owned());
        }
        let bytes = text
            .chars()
            .map(|c| u8::try_from(u32::from(c)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "PostgreSQL legacy text contains characters outside ISO-8859-1".to_string())?;
        self.0
            .decode_without_bom_handling_and_without_replacement(&bytes)
            .map(|s| s.into_owned())
            .ok_or_else(|| format!("Invalid {} bytes in PostgreSQL legacy text", self.0.name()))
    }

    pub fn encode(self, text: &str) -> Result<String, String> {
        if text.is_ascii() {
            return Ok(text.to_owned());
        }
        let (bytes, _, errors) = self.0.encode(text);
        if errors {
            return Err(format!("Text cannot be represented in {}", self.0.name()));
        }
        Ok(bytes.iter().map(|b| char::from(*b)).collect())
    }

    pub fn encode_sql(self, sql: &str) -> Result<String, String> {
        use sqlparser::tokenizer::{Token, Tokenizer};
        if sql.is_ascii() {
            return Ok(sql.into());
        }
        let tokens = Tokenizer::new(&sqlparser::dialect::PostgreSqlDialect {}, sql)
            .with_unescape(false)
            .tokenize_with_location()
            .map_err(|e| e.to_string())?;
        let mut positions = vec![vec![0usize]];
        for (offset, ch) in sql.char_indices() {
            let next = offset + ch.len_utf8();
            if ch == '\n' {
                positions.push(vec![next]);
            } else {
                positions.last_mut().unwrap().push(next);
            }
        }
        let byte_offset = |location: sqlparser::tokenizer::Location| -> Result<usize, String> {
            positions
                .get(location.line.saturating_sub(1) as usize)
                .and_then(|line| line.get(location.column.saturating_sub(1) as usize))
                .copied()
                .ok_or_else(|| "Invalid PostgreSQL SQL token position".into())
        };
        let mut result = String::new();
        let mut previous = 0;
        for (index, token) in tokens.iter().enumerate() {
            let significant: Vec<_> =
                tokens[index + 1..].iter().filter(|t| !matches!(t.token, Token::Whitespace(_))).take(3).collect();
            let json_type = |token: &Token| matches!(token, Token::Word(w) if w.value.eq_ignore_ascii_case("json") || w.value.eq_ignore_ascii_case("jsonb"));
            let previous_tokens: Vec<_> =
                tokens[..index].iter().rev().filter(|t| !matches!(t.token, Token::Whitespace(_))).take(2).collect();
            let in_cast = matches!(previous_tokens.as_slice(), [open, cast] if open.token == Token::LParen && matches!(&cast.token, Token::Word(word) if word.value.eq_ignore_ascii_case("CAST")));
            let json_cast = matches!(significant.as_slice(), [colon, ty, ..] if colon.token == Token::DoubleColon && json_type(&ty.token))
                || (in_cast
                    && matches!(significant.as_slice(), [as_word, ty, close] if matches!(&as_word.token, Token::Word(w) if w.value.eq_ignore_ascii_case("AS")) && json_type(&ty.token) && close.token == Token::RParen));
            let start = byte_offset(token.span.start)?;
            let end = byte_offset(token.span.end)?;
            result.push_str(&self.encode(&sql[previous..start])?);
            let original = &sql[start..end];
            match &token.token {
                Token::Word(word) if word.quote_style.is_none() && !word.value.is_ascii() => {
                    result.push('"');
                    result.push_str(&self.encode(&word.value)?.replace('"', "\"\""));
                    result.push('"');
                }
                Token::SingleQuotedString(value) if json_cast => {
                    let json = value.replace("''", "'");
                    let encoded = self.transform_json(json.as_bytes(), true)?;
                    let encoded = String::from_utf8(encoded).map_err(|e| e.to_string())?;
                    result.push('\'');
                    result.push_str(&encoded.replace('\'', "''"));
                    result.push('\'');
                }
                Token::EscapedStringLiteral(_) => {
                    // Preserve the user's existing escapes; escape backslashes
                    // introduced by multibyte encoding separately.
                    for ch in original.chars() {
                        if ch.is_ascii() {
                            result.push(ch);
                        } else {
                            result.push_str(&self.encode(&ch.to_string())?.replace('\\', "\\\\"));
                        }
                    }
                }
                _ => result.push_str(&self.encode(original)?),
            }
            previous = end;
        }
        result.push_str(&self.encode(&sql[previous..])?);
        Ok(result)
    }

    pub fn encode_copy_text(self, data: &[u8]) -> Result<Vec<u8>, String> {
        let text = std::str::from_utf8(data).map_err(|_| "COPY text input must be UTF-8")?;
        let mut output = String::new();
        for line in text.split_inclusive('\n') {
            let newline = line.ends_with('\n');
            let line = line.strip_suffix('\n').unwrap_or(line);
            for (i, field) in line.split('\t').enumerate() {
                if i != 0 {
                    output.push('\t');
                }
                if field == "\\N" {
                    output.push_str(field);
                    continue;
                }
                let mut decoded = String::new();
                let mut chars = field.chars();
                while let Some(ch) = chars.next() {
                    if ch != '\\' {
                        decoded.push(ch);
                        continue;
                    }
                    let next = chars.next().ok_or("Incomplete COPY text escape")?;
                    decoded.push(match next {
                        '\\' => '\\',
                        't' => '\t',
                        'n' => '\n',
                        'r' => '\r',
                        'b' => '\u{8}',
                        'f' => '\u{c}',
                        'v' => '\u{b}',
                        // DBX's COPY writer only emits the escapes above. Do
                        // not guess how arbitrary byte escapes were encoded.
                        _ => return Err("Unsupported COPY text escape with clientEncoding; use INSERT".into()),
                    });
                }
                for ch in self.encode(&decoded)?.chars() {
                    match ch {
                        '\\' => output.push_str("\\\\"),
                        '\t' => output.push_str("\\t"),
                        '\n' => output.push_str("\\n"),
                        '\r' => output.push_str("\\r"),
                        '\u{8}' => output.push_str("\\b"),
                        '\u{c}' => output.push_str("\\f"),
                        '\u{b}' => output.push_str("\\v"),
                        _ => output.push(ch),
                    }
                }
            }
            if newline {
                output.push('\n');
            }
        }
        Ok(output.into_bytes())
    }

    fn transforms(self, ty: &Type) -> bool {
        match ty.kind() {
            Kind::Domain(inner) | Kind::Array(inner) => self.transforms(inner),
            Kind::Enum(_) => true,
            _ => matches!(
                *ty,
                Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN | Type::JSON | Type::JSONB
            ),
        }
    }

    fn transform(self, ty: &Type, raw: &[u8], encode: bool) -> Result<Vec<u8>, String> {
        match ty.kind() {
            Kind::Domain(inner) => return self.transform(inner, raw, encode),
            Kind::Array(inner) => return self.transform_array(inner, raw, encode),
            Kind::Enum(_) => return self.transform_text(raw, encode),
            _ => {}
        }
        if *ty == Type::JSON {
            return self.transform_json(raw, encode);
        }
        if matches!(*ty, Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN) {
            return self.transform_text(raw, encode);
        }
        if *ty == Type::JSONB {
            let Some((&1, value)) = raw.split_first() else {
                return Err("Invalid PostgreSQL jsonb version".into());
            };
            let mut result = vec![1];
            result.extend(self.transform_json(value, encode)?);
            return Ok(result);
        }
        Ok(raw.to_vec())
    }

    fn transform_json(self, raw: &[u8], encode: bool) -> Result<Vec<u8>, String> {
        fn visit(codec: TextEncoding, value: &mut serde_json::Value, encode: bool) -> Result<(), String> {
            let text = |s: &str| if encode { codec.encode(s) } else { codec.decode(s) };
            match value {
                serde_json::Value::String(s) => *s = text(s)?,
                serde_json::Value::Array(values) => {
                    for v in values {
                        visit(codec, v, encode)?;
                    }
                }
                serde_json::Value::Object(object) => {
                    let mut result = serde_json::Map::new();
                    for (key, mut value) in std::mem::take(object) {
                        visit(codec, &mut value, encode)?;
                        result.insert(text(&key)?, value);
                    }
                    *object = result;
                }
                _ => {}
            }
            Ok(())
        }
        let mut value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
        visit(self, &mut value, encode)?;
        serde_json::to_vec(&value).map_err(|e| e.to_string())
    }

    fn transform_text(self, raw: &[u8], encode: bool) -> Result<Vec<u8>, String> {
        let text = std::str::from_utf8(raw).map_err(|_| "Invalid UTF-8 in PostgreSQL text protocol")?;
        Ok(if encode { self.encode(text)? } else { self.decode(text)? }.into_bytes())
    }

    fn transform_array(self, inner: &Type, raw: &[u8], encode: bool) -> Result<Vec<u8>, String> {
        fn int(raw: &[u8], pos: &mut usize) -> Result<i32, String> {
            let end = pos.checked_add(4).ok_or("Invalid PostgreSQL array length")?;
            let bytes = raw.get(*pos..end).ok_or("Truncated PostgreSQL array")?;
            *pos = end;
            Ok(i32::from_be_bytes(bytes.try_into().unwrap()))
        }
        let mut pos = 0;
        let dimensions = int(raw, &mut pos)?;
        if !(0..=6).contains(&dimensions) {
            return Err("Invalid PostgreSQL array dimensions".into());
        }
        int(raw, &mut pos)?;
        int(raw, &mut pos)?;
        let mut count = if dimensions == 0 { 0usize } else { 1usize };
        for _ in 0..dimensions {
            let n = int(raw, &mut pos)?;
            count = count
                .checked_mul(usize::try_from(n).map_err(|_| "Invalid PostgreSQL array length")?)
                .ok_or("Invalid PostgreSQL array length")?;
            int(raw, &mut pos)?;
        }
        // Every element has a four-byte length, including NULLs.
        if count > raw.len().saturating_sub(pos) / 4 {
            return Err("Truncated PostgreSQL array".into());
        }
        let mut result = raw[..pos].to_vec();
        for _ in 0..count {
            let length = int(raw, &mut pos)?;
            if length == -1 {
                result.extend((-1i32).to_be_bytes());
                continue;
            }
            let end = pos
                .checked_add(usize::try_from(length).map_err(|_| "Invalid PostgreSQL array element")?)
                .ok_or("Invalid PostgreSQL array element")?;
            let bytes = raw.get(pos..end).ok_or("Truncated PostgreSQL array element")?;
            pos = end;
            let value = self.transform(inner, bytes, encode)?;
            result
                .extend(i32::try_from(value.len()).map_err(|_| "PostgreSQL array element is too large")?.to_be_bytes());
            result.extend(value);
        }
        if pos != raw.len() {
            return Err("Trailing PostgreSQL array bytes".into());
        }
        Ok(result)
    }
}

type EncodingRegistry = HashMap<usize, (Weak<deadpool_postgres::StatementCache>, TextEncoding)>;
fn registry() -> &'static Mutex<EncodingRegistry> {
    static REGISTRY: OnceLock<Mutex<EncodingRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) fn register(client: &deadpool_postgres::ClientWrapper, encoding: TextEncoding) {
    let cache = &client.statement_cache;
    let mut registry = registry().lock().unwrap_or_else(|e| e.into_inner());
    registry.retain(|_, (cache, _)| cache.strong_count() > 0);
    registry.insert(Arc::as_ptr(cache) as usize, (Arc::downgrade(cache), encoding));
}
pub(crate) fn for_client(client: &deadpool_postgres::Client) -> Option<TextEncoding> {
    let cache = &client.statement_cache;
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(Arc::as_ptr(cache) as usize))
        .filter(|(weak, _)| weak.ptr_eq(&Arc::downgrade(cache)))
        .map(|(_, encoding)| *encoding)
}

#[derive(Debug)]
pub enum PgError {
    Native(tokio_postgres::Error),
    Encoding(String),
}
impl PgError {
    pub fn as_db_error(&self) -> Option<&tokio_postgres::error::DbError> {
        match self {
            Self::Native(e) => e.as_db_error(),
            Self::Encoding(_) => None,
        }
    }
    #[cfg(test)]
    pub fn __private_api_timeout() -> Self {
        tokio_postgres::Error::__private_api_timeout().into()
    }
}
impl From<tokio_postgres::Error> for PgError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Native(e)
    }
}
impl From<String> for PgError {
    fn from(e: String) -> Self {
        Self::Encoding(e)
    }
}
impl fmt::Display for PgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Native(e) => e.fmt(f),
            Self::Encoding(e) => f.write_str(e),
        }
    }
}
impl Error for PgError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Native(e) => Some(e),
            Self::Encoding(_) => None,
        }
    }
}

struct Raw(Vec<u8>);
impl<'a> FromSql<'a> for Raw {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn Error + Send + Sync>> {
        Ok(Self(raw.to_vec()))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

#[derive(Debug)]
pub struct Row {
    original: tokio_postgres::Row,
    // Decoded column names exist only for connections with a configured text
    // encoding; without one the original names are already correct and a
    // per-row Vec<String> would tax every result row of every ordinary query.
    names: Option<Vec<String>>,
    values: Option<Vec<Option<Vec<u8>>>>,
}
impl Row {
    pub(crate) fn new(original: tokio_postgres::Row, encoding: Option<TextEncoding>) -> Result<Self, PgError> {
        let (names, values) = match encoding {
            None => (None, None),
            Some(e) => {
                let names = original.columns().iter().map(|c| e.decode(c.name())).collect::<Result<_, _>>()?;
                let values = Some(
                    original
                        .columns()
                        .iter()
                        .enumerate()
                        .map(|(i, c)| {
                            if !e.transforms(c.type_()) {
                                return Ok(None);
                            }
                            let value: Option<Raw> = original.try_get(i)?;
                            value.map(|raw| e.transform(c.type_(), &raw.0, false)).transpose().map_err(PgError::from)
                        })
                        .collect::<Result<_, PgError>>()?,
                );
                (Some(names), values)
            }
        };
        Ok(Self { original, names, values })
    }
    pub fn columns(&self) -> &[tokio_postgres::Column] {
        self.original.columns()
    }
    #[track_caller]
    pub fn get<'a, I, T>(&'a self, idx: I) -> T
    where
        I: tokio_postgres::row::RowIndex + fmt::Display,
        T: FromSql<'a>,
    {
        self.try_get(idx).unwrap_or_else(|e| panic!("{e}"))
    }

    pub fn try_get<'a, I, T>(&'a self, idx: I) -> Result<T, PgError>
    where
        I: tokio_postgres::row::RowIndex + fmt::Display,
        T: FromSql<'a>,
    {
        let resolved = match self.names.as_deref() {
            Some(names) => idx.__idx(names),
            None => idx.__idx(self.original.columns()),
        };
        let Some(i) = resolved else {
            return Err(PgError::Encoding(format!("Unknown PostgreSQL column {idx}")));
        };
        let Some(values) = &self.values else {
            return self.original.try_get(i).map_err(Into::into);
        };
        let Some(raw) = values[i].as_deref() else {
            return self.original.try_get(i).map_err(Into::into);
        };
        let ty = self.columns()[i].type_();
        if !T::accepts(ty) {
            return Err(PgError::Encoding(format!("Cannot decode PostgreSQL type {}", ty.name())));
        }
        T::from_sql_nullable(ty, Some(raw)).map_err(|e| PgError::Encoding(e.to_string()))
    }
}

#[derive(Debug)]
struct Param<'a> {
    inner: &'a (dyn ToSql + Sync),
    encoding: Option<TextEncoding>,
}
impl ToSql for Param<'_> {
    fn to_sql(&self, ty: &Type, out: &mut BytesMut) -> Result<IsNull, Box<dyn Error + Send + Sync>> {
        let mut buffer = BytesMut::new();
        let null = self.inner.to_sql_checked(ty, &mut buffer)?;
        if matches!(null, IsNull::No) {
            if let Some(e) = self.encoding {
                out.extend(e.transform(ty, &buffer, true).map_err(std::io::Error::other)?);
            } else {
                out.extend(buffer);
            }
        }
        Ok(null)
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    tokio_postgres::types::to_sql_checked!();
}

pub trait Statement {
    fn sql(&self) -> Option<&str> {
        None
    }
    fn prepared(&self) -> Option<&tokio_postgres::Statement> {
        None
    }
}
impl Statement for str {
    fn sql(&self) -> Option<&str> {
        Some(self)
    }
}
impl Statement for String {
    fn sql(&self) -> Option<&str> {
        Some(self)
    }
}
impl Statement for tokio_postgres::Statement {
    fn prepared(&self) -> Option<&tokio_postgres::Statement> {
        Some(self)
    }
}

pub struct Client<'a> {
    original: &'a deadpool_postgres::Client,
    pub(crate) encoding: Option<TextEncoding>,
}
impl<'a> Client<'a> {
    pub fn new(original: &'a deadpool_postgres::Client) -> Self {
        Self { original, encoding: for_client(original) }
    }
    pub fn encode(&self, text: &str) -> Result<String, PgError> {
        self.encoding.map_or_else(|| Ok(text.into()), |e| e.encode_sql(text).map_err(Into::into))
    }
    pub fn decode(&self, text: &str) -> Result<String, PgError> {
        self.encoding.map_or_else(|| Ok(text.into()), |e| e.decode(text).map_err(Into::into))
    }
    async fn statement<T: Statement + ?Sized>(&self, stmt: &T) -> Result<tokio_postgres::Statement, PgError> {
        if let Some(stmt) = stmt.prepared() {
            return Ok(stmt.clone());
        }
        self.prepare(stmt.sql().expect("SQL statement")).await
    }
    fn params<'b>(&self, params: &[&'b (dyn ToSql + Sync)]) -> Vec<Param<'b>> {
        params.iter().map(|inner| Param { inner: *inner, encoding: self.encoding }).collect()
    }
    pub async fn prepare(&self, sql: &str) -> Result<tokio_postgres::Statement, PgError> {
        Ok(self.original.prepare(&self.encode(sql)?).await?)
    }
    pub async fn prepare_cached(&self, sql: &str) -> Result<tokio_postgres::Statement, PgError> {
        Ok(self.original.prepare_cached(&self.encode(sql)?).await?)
    }
    pub async fn query<T: Statement + ?Sized>(
        &self,
        sql: &T,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, PgError> {
        let stmt = self.statement(sql).await?;
        let params = self.params(params);
        let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as _).collect();
        self.original.query(&stmt, &refs).await?.into_iter().map(|row| Row::new(row, self.encoding)).collect()
    }
    pub async fn query_one<T: Statement + ?Sized>(
        &self,
        sql: &T,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Row, PgError> {
        let stmt = self.statement(sql).await?;
        let params = self.params(params);
        let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as _).collect();
        Row::new(self.original.query_one(&stmt, &refs).await?, self.encoding)
    }
    pub async fn query_opt<T: Statement + ?Sized>(
        &self,
        sql: &T,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, PgError> {
        let stmt = self.statement(sql).await?;
        let params = self.params(params);
        let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as _).collect();
        self.original.query_opt(&stmt, &refs).await?.map(|row| Row::new(row, self.encoding)).transpose()
    }
    pub async fn execute<T: Statement + ?Sized>(
        &self,
        sql: &T,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, PgError> {
        let stmt = self.statement(sql).await?;
        let params = self.params(params);
        let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as _).collect();
        Ok(self.original.execute(&stmt, &refs).await?)
    }
    pub async fn query_typed(&self, sql: &str, params: &[(&(dyn ToSql + Sync), Type)]) -> Result<Vec<Row>, PgError> {
        let wrapped: Vec<_> =
            params.iter().map(|(inner, _)| Param { inner: *inner, encoding: self.encoding }).collect();
        let refs: Vec<_> =
            wrapped.iter().zip(params).map(|(p, (_, t))| (p as &(dyn ToSql + Sync), t.clone())).collect();
        self.original
            .query_typed(&self.encode(sql)?, &refs)
            .await?
            .into_iter()
            .map(|r| Row::new(r, self.encoding))
            .collect()
    }
    pub async fn query_typed_one(&self, sql: &str, params: &[(&(dyn ToSql + Sync), Type)]) -> Result<Row, PgError> {
        let wrapped: Vec<_> =
            params.iter().map(|(inner, _)| Param { inner: *inner, encoding: self.encoding }).collect();
        let refs: Vec<_> =
            wrapped.iter().zip(params).map(|(p, (_, t))| (p as &(dyn ToSql + Sync), t.clone())).collect();
        Row::new(self.original.query_typed_one(&self.encode(sql)?, &refs).await?, self.encoding)
    }
    pub async fn execute_typed(&self, sql: &str, params: &[(&(dyn ToSql + Sync), Type)]) -> Result<u64, PgError> {
        let wrapped: Vec<_> =
            params.iter().map(|(inner, _)| Param { inner: *inner, encoding: self.encoding }).collect();
        let refs: Vec<_> =
            wrapped.iter().zip(params).map(|(p, (_, t))| (p as &(dyn ToSql + Sync), t.clone())).collect();
        Ok(self.original.execute_typed(&self.encode(sql)?, &refs).await?)
    }
    pub async fn batch_execute(&self, sql: &str) -> Result<(), PgError> {
        Ok(self.original.batch_execute(&self.encode(sql)?).await?)
    }
    pub async fn simple_query_raw(&self, sql: &str) -> Result<tokio_postgres::SimpleQueryStream, PgError> {
        Ok(self.original.simple_query_raw(&self.encode(sql)?).await?)
    }
    pub async fn query_raw<'b, T, I>(&self, stmt: &T, params: I) -> Result<RowStream, PgError>
    where
        T: Statement + ?Sized,
        I: IntoIterator<Item = &'b (dyn ToSql + Sync)>,
        I::IntoIter: ExactSizeIterator,
    {
        let stmt = self.statement(stmt).await?;
        let params: Vec<_> = params.into_iter().map(|inner| Param { inner, encoding: self.encoding }).collect();
        let stream = self.original.query_raw(&stmt, params.iter().map(|p| p as &(dyn ToSql + Sync))).await?;
        Ok(RowStream { original: Box::pin(stream), encoding: self.encoding })
    }
    pub async fn query_typed_raw<'b, I>(&self, sql: &str, params: I) -> Result<RowStream, PgError>
    where
        I: IntoIterator<Item = (&'b (dyn ToSql + Sync), Type)>,
        I::IntoIter: ExactSizeIterator,
    {
        let params: Vec<_> =
            params.into_iter().map(|(inner, t)| (Param { inner, encoding: self.encoding }, t)).collect();
        let stream = self
            .original
            .query_typed_raw(&self.encode(sql)?, params.iter().map(|(p, t)| (p as &(dyn ToSql + Sync), t.clone())))
            .await?;
        Ok(RowStream { original: Box::pin(stream), encoding: self.encoding })
    }
}
impl std::ops::Deref for Client<'_> {
    type Target = deadpool_postgres::Client;
    fn deref(&self) -> &Self::Target {
        self.original
    }
}
pub struct RowStream {
    original: std::pin::Pin<Box<tokio_postgres::RowStream>>,
    pub(crate) encoding: Option<TextEncoding>,
}
impl RowStream {
    pub fn columns(&self) -> &[tokio_postgres::Column] {
        self.original.columns()
    }
}
impl futures::Stream for RowStream {
    type Item = Result<Row, PgError>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let encoding = self.encoding;
        self.original
            .as_mut()
            .poll_next(cx)
            .map(|item| item.map(|r| r.map_err(PgError::from).and_then(|r| Row::new(r, encoding))))
    }
}

impl std::ops::Deref for Row {
    type Target = tokio_postgres::Row;
    fn deref(&self) -> &Self::Target {
        &self.original
    }
}

pub trait ValueRow {
    fn columns(&self) -> &[tokio_postgres::Column];
    fn try_get<'a, I, T>(&'a self, idx: I) -> Result<T, PgError>
    where
        I: tokio_postgres::row::RowIndex + fmt::Display,
        T: FromSql<'a>;
}
impl ValueRow for Row {
    fn columns(&self) -> &[tokio_postgres::Column] {
        self.columns()
    }
    fn try_get<'a, I, T>(&'a self, idx: I) -> Result<T, PgError>
    where
        I: tokio_postgres::row::RowIndex + fmt::Display,
        T: FromSql<'a>,
    {
        self.try_get(idx)
    }
}
impl ValueRow for tokio_postgres::Row {
    fn columns(&self) -> &[tokio_postgres::Column] {
        self.columns()
    }
    fn try_get<'a, I, T>(&'a self, idx: I) -> Result<T, PgError>
    where
        I: tokio_postgres::row::RowIndex + fmt::Display,
        T: FromSql<'a>,
    {
        self.try_get(idx).map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latin1_carrier_round_trips_gb18030_including_four_byte_characters() {
        let codec = TextEncoding(encoding_rs::GB18030);
        let carrier: String = [0xd6, 0xd0, 0xce, 0xc4, 0x94, 0x39, 0xfc, 0x36].into_iter().map(char::from).collect();
        assert_eq!(codec.decode(&carrier).unwrap(), "中文😀");
        assert_eq!(codec.encode("中文😀").unwrap(), carrier);
        assert!(codec.decode("café").is_err());
        assert!(codec.decode("中文").is_err());
        let utf8 = TextEncoding(encoding_rs::UTF_8);
        assert_eq!(utf8.decode(&utf8.encode("中文\u{80}").unwrap()).unwrap(), "中文\u{80}");
    }

    #[test]
    fn json_transcoding_preserves_escaping_and_nulls() {
        let codec = TextEncoding(encoding_rs::GB18030);
        let value = serde_json::json!({"中文": ["乗\\folder", "😀", null, 42]});
        let encoded = codec.transform_json(&serde_json::to_vec(&value).unwrap(), true).unwrap();
        let decoded = codec.transform_json(&encoded, false).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&decoded).unwrap(), value);
    }

    #[test]
    fn sql_encoding_preserves_unquoted_names_and_escape_literals() {
        let codec = TextEncoding(encoding_rs::GB18030);
        let sql = "SELECT 中文列, E'乗\\n', '中文' AS 中文别名 -- 中文\nFROM 中文表";
        let encoded = codec.encode_sql(sql).unwrap();
        assert!(encoded.starts_with(&format!("SELECT \"{}\",", codec.encode("中文列").unwrap())));
        assert!(encoded.contains("E'\u{81}\\\\\\n'"));
        assert!(encoded.ends_with(&format!("FROM \"{}\"", codec.encode("中文表").unwrap())));
        assert_eq!(codec.encode_sql("select 'plain\\text' as x").unwrap(), "select 'plain\\text' as x");
        assert!(codec.encode_sql("SELECT * FROM (SELECT 'plain' AS json) 中文别名").is_ok());
    }

    #[test]
    fn copy_transcoding_preserves_backslashes_tabs_newlines_and_nulls() {
        let codec = TextEncoding(encoding_rs::GB18030);
        let encoded = codec.encode_copy_text("乗\\\\folder\\t中文\\n😀\t\\N\n".as_bytes()).unwrap();
        let text = String::from_utf8(encoded).unwrap();
        assert!(text.starts_with("\u{81}\\\\\\\\folder\\t"));
        assert!(text.ends_with("\t\\N\n"));
    }
}
