use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Client as HttpClient, Method};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::{apply_tls_certificates, http_client_builder, with_connection_timeout};
use crate::db::document_result::DocumentQueryResult;
use crate::types::QueryResult;

const SOLR_PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

const SOLR_REST_TABLE_MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const SOLR_REST_TABLE_MAX_ROWS: usize = 2_000;
const SOLR_REST_TABLE_MAX_CELLS: usize = 200_000;
/// `get_columns` 在无显式 schema 字段（schemaless core 只有 dynamicFields）时
/// 抽样文档数量，用于推断列。
const SOLR_SCHEMA_SAMPLE_LIMIT: usize = 50;

#[derive(Clone)]
pub struct SolrClient {
    http: HttpClient,
    /// Base URL including the Solr context path, e.g. `http://host:8983/solr`.
    base_url: String,
    auth: Option<(String, String)>,
    /// `/{core}/schema/uniquekey` 结果缓存：文档的 `_id` 别名、cursorMark 排序
    /// 兜底字段和文档更新都要靠它定位唯一键。
    unique_keys: Arc<Mutex<HashMap<String, Option<String>>>>,
}

impl SolrClient {
    #[allow(clippy::too_many_arguments)]
    pub fn from_config(
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
        tls_enabled: bool,
        url_params: Option<&str>,
        _external_config: Option<&Value>,
        timeout: Duration,
        ca_cert_path: Option<&str>,
        client_cert_path: Option<&str>,
        client_key_path: Option<&str>,
    ) -> Result<Self, String> {
        let base_url = normalize_solr_base_url(url);
        let auth = match (username, password) {
            (Some(u), Some(p)) if !u.is_empty() => Some((u.to_string(), p.to_string())),
            _ => None,
        };
        let mut builder = http_client_builder(timeout)
            .danger_accept_invalid_certs(solr_accept_invalid_certs(tls_enabled, url_params));
        builder = apply_tls_certificates(builder, ca_cert_path, client_cert_path, client_key_path)?;
        let http = builder.build().map_err(|e| format!("Failed to initialize Solr HTTP client: {e}"))?;
        Ok(Self { http, base_url, auth, unique_keys: Arc::new(Mutex::new(HashMap::new())) })
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.request(method, format!("{}{}", self.base_url, path));
        if let Some((ref user, ref pass)) = self.auth {
            req.basic_auth(user, Some(pass))
        } else {
            req
        }
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::GET, path)
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.request(Method::POST, path)
    }

    fn core_path(&self, core: &str, endpoint: &str) -> String {
        format!("/{}/{}", solr_path_segment(core), endpoint.trim_start_matches('/'))
    }

    /// `/schema/uniquekey` 返回 core 的唯一键字段名（通常 `id`）。结果按连接缓存：
    /// 每个分页请求都会用到它，逐页重查浪费一次 HTTP 往返。
    async fn unique_key(&self, core: &str) -> Option<String> {
        if let Some(cached) = self.unique_keys.lock().ok().and_then(|keys| keys.get(core).cloned()) {
            return cached;
        }
        let resolved = self.fetch_unique_key(core).await.unwrap_or(None);
        if let Ok(mut keys) = self.unique_keys.lock() {
            keys.insert(core.to_string(), resolved.clone());
        }
        resolved
    }

    async fn fetch_unique_key(&self, core: &str) -> Result<Option<String>, String> {
        let path = self.core_path(core, "schema/uniquekey?wt=json");
        let resp = self.get(&path).send().await.map_err(|e| format!("Solr request failed: {e}"))?;
        if !resp.status().is_success() {
            return Ok(None);
        }
        let body: Value = resp.json().await.map_err(|e| format!("Solr parse error: {e}"))?;
        Ok(body.get("uniqueKey").and_then(Value::as_str).map(str::to_string))
    }
}

/// `http://host:8983` 需要补 `/solr` 上下文路径；反向代理或显式带路径的 URL 原样保留。
fn normalize_solr_base_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    let has_context_path =
        reqwest::Url::parse(trimmed).map(|u| !u.path().trim_matches('/').is_empty()).unwrap_or(false);
    if has_context_path {
        trimmed.to_string()
    } else {
        format!("{trimmed}/solr")
    }
}

pub fn solr_accept_invalid_certs(tls_enabled: bool, url_params: Option<&str>) -> bool {
    tls_enabled
        || solr_url_params_flag(url_params, "sslmode", &["disable", "allow"])
        || solr_url_params_flag(url_params, "tlsverify", &["false", "0", "no", "off"])
        || solr_url_params_flag(url_params, "verify", &["false", "0", "no", "off"])
        || solr_url_params_flag(url_params, "insecure", &["true", "1", "yes", "on"])
        || solr_url_params_flag(url_params, "accept_invalid_certs", &["true", "1", "yes", "on"])
}

fn solr_url_params_flag(params: Option<&str>, key: &str, expected_values: &[&str]) -> bool {
    params.unwrap_or("").trim().trim_start_matches('?').split('&').filter_map(|pair| pair.split_once('=')).any(
        |(k, v)| {
            k.trim().eq_ignore_ascii_case(key)
                && expected_values.iter().any(|expected| v.trim().eq_ignore_ascii_case(expected))
        },
    )
}

fn solr_path_segment(value: &str) -> String {
    utf8_percent_encode(value, SOLR_PATH_SEGMENT_ENCODE_SET).to_string()
}

fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(err) = source {
        let text = err.to_string();
        if !text.is_empty() && !parts.iter().any(|part| part == &text) {
            parts.push(text);
        }
        source = err.source();
    }
    parts.join(": ")
}

async fn read_solr_json(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("Solr response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Solr error ({status}): {}", solr_error_message(&body)));
    }
    serde_json::from_str(&body).map_err(|e| format!("Solr parse error: {e}"))
}

/// Solr 错误体是 `{"error": {"msg", "code", ...}}`；非 JSON 时回退原文。
fn solr_error_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = value.pointer("/error/msg").and_then(Value::as_str) {
            return msg.to_string();
        }
    }
    body.chars().take(1_000).collect()
}

pub async fn test_connection(client: &mut SolrClient, timeout: Duration) -> Result<(), String> {
    let path = "/admin/info/system?wt=json";
    let resp = with_connection_timeout("Solr", timeout, async {
        client
            .get(path)
            .send()
            .await
            .map_err(|e| format!("Solr connection failed for {}: {}", client.base_url, format_reqwest_error(&e)))
    })
    .await?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Solr error ({status}) for {path}: {}", solr_error_message(&body)));
    }
    Ok(())
}

/// 单机模式枚举 core：`GET /solr/admin/cores?action=STATUS`。
/// SolrCloud 语义上的 collection 列表（`/api/collections`）留待后续扩展。
pub async fn list_cores(client: &SolrClient) -> Result<Vec<String>, String> {
    let resp = client
        .get("/admin/cores?action=STATUS&wt=json")
        .send()
        .await
        .map_err(|e| format!("Solr request failed: {e}"))?;
    let body = read_solr_json(resp).await?;
    let mut names: Vec<String> = body
        .get("status")
        .and_then(Value::as_object)
        .map(|status| status.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    Ok(names)
}

#[derive(Deserialize)]
struct SolrSchemaField {
    name: String,
    #[serde(rename = "type", default)]
    field_type: Option<String>,
    #[serde(default)]
    required: bool,
    #[serde(rename = "multiValued", default)]
    multi_valued: bool,
}

pub async fn get_columns(client: &SolrClient, core: &str) -> Result<Vec<crate::db::ColumnInfo>, String> {
    let path = client.core_path(core, "schema?wt=json");
    let resp = client.get(&path).send().await.map_err(|e| format!("Solr request failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Solr error: {}", solr_error_message(&body)));
    }
    let body: Value = resp.json().await.map_err(|e| format!("Solr parse error: {e}"))?;
    let schema = body.get("schema").unwrap_or(&body);
    let unique_key = schema.get("uniqueKey").and_then(Value::as_str);

    let mut columns: Vec<crate::db::ColumnInfo> = Vec::new();
    if let Some(fields) = schema.get("fields").and_then(Value::as_array) {
        for field in fields {
            let Ok(field) = serde_json::from_value::<SolrSchemaField>(field.clone()) else { continue };
            let mut extras = Vec::new();
            if field.multi_valued {
                extras.push("multiValued");
            }
            if field.required {
                extras.push("required");
            }
            columns.push(crate::db::ColumnInfo {
                name: field.name.clone(),
                data_type: field.field_type.unwrap_or_default(),
                is_nullable: !field.required,
                is_primary_key: unique_key == Some(field.name.as_str()),
                is_unique: unique_key == Some(field.name.as_str()),
                extra: (!extras.is_empty()).then(|| extras.join(",")),
                ..Default::default()
            });
        }
    }
    columns.sort_by(|left, right| left.name.cmp(&right.name));
    if !columns.is_empty() {
        return Ok(columns);
    }

    // Schemaless core 只有 dynamicFields，没有具体列名——抽样文档推断列。
    sample_columns_from_documents(client, core, unique_key).await
}

async fn sample_columns_from_documents(
    client: &SolrClient,
    core: &str,
    unique_key: Option<&str>,
) -> Result<Vec<crate::db::ColumnInfo>, String> {
    let body = serde_json::json!({ "query": "*:*", "limit": SOLR_SCHEMA_SAMPLE_LIMIT });
    let path = client.core_path(core, "query");
    let resp = client.post(&path).json(&body).send().await.map_err(|e| format!("Solr request failed: {e}"))?;
    let body = read_solr_json(resp).await?;
    let docs = body.pointer("/response/docs").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut names = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    let mut types = HashMap::<String, &str>::new();
    for doc in &docs {
        let Some(object) = doc.as_object() else { continue };
        for (key, value) in object {
            if seen.insert(key.clone()) {
                names.push(key.clone());
            }
            let value_type = match value {
                Value::Null => continue,
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::String(_) => "text",
                Value::Array(_) | Value::Object(_) => "json",
            };
            match types.get(key.as_str()) {
                None => {
                    types.insert(key.clone(), value_type);
                }
                Some(existing) if *existing != value_type => {
                    types.insert(key.clone(), "json");
                }
                _ => {}
            }
        }
    }
    names.sort();
    Ok(names
        .into_iter()
        .map(|name| crate::db::ColumnInfo {
            is_primary_key: unique_key == Some(name.as_str()),
            is_unique: unique_key == Some(name.as_str()),
            data_type: types.get(name.as_str()).unwrap_or(&"unknown").to_string(),
            name,
            ..Default::default()
        })
        .collect())
}

// ---------------------------------------------------------------------------
// 文档查询：Mongo 风格 filter JSON → Solr fq 列表（多个 fq 之间是 AND 语义）。
// ---------------------------------------------------------------------------

fn solr_term_value(value: &Value) -> Result<String, String> {
    match value {
        Value::String(text) => Ok(format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(flag) => Ok(flag.to_string()),
        _ => Err("Solr term value must be a string, number, or boolean".to_string()),
    }
}

/// Solr 通配符查询里的特殊字符转义（`\`、`?`、`*`、`:` 等）。
fn solr_escape_wildcard_literal(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(
            ch,
            '\\' | '+' | '-' | '=' | '&' | '|' | '!' | '(' | ')' | '{' | '}' | '[' | ']' | '^' | '"' | '~' | ':' | '/'
        ) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn solr_field_name(field: &str) -> String {
    field.trim().to_string()
}

fn translate_field_term(field: &str, value: &Value) -> Result<String, String> {
    if value.is_null() {
        // `field:*` 是"字段存在"，取反即"字段为空"。纯负查询在 fq 里合法。
        return Ok(format!("-{}:*", solr_field_name(field)));
    }
    if let Value::Array(items) = value {
        return translate_in_filter(field, items);
    }
    Ok(format!("{}:{}", solr_field_name(field), solr_term_value(value)?))
}

fn translate_in_filter(field: &str, items: &[Value]) -> Result<String, String> {
    if items.is_empty() {
        // Mongo `$in: []` 匹配不到任何文档；用恒假条件保持语义一致。
        return Ok("(*:* AND -*:*)".to_string());
    }
    let terms = items.iter().map(solr_term_value).collect::<Result<Vec<_>, _>>()?;
    Ok(format!("{}:({})", solr_field_name(field), terms.join(" OR ")))
}

fn translate_regex_filter(field: &str, pattern: &str) -> String {
    let field = solr_field_name(field);
    // 用户直接手写 `*`/`?` 时视为 Solr 通配符原样透传。
    if pattern.chars().any(|ch| matches!(ch, '*' | '?')) {
        return format!("{field}:{pattern}");
    }
    // begins-with/ends-with 产出的 `^lit`/`lit$` 锚点映射为前缀/后缀通配；
    // 其余按正则字面量反转义后包成 contains 通配。
    if let Some(rest) = pattern.strip_prefix('^') {
        return format!("{field}:{}*", solr_escape_wildcard_literal(&regex_unescape_literal(rest)));
    }
    if let Some(rest) = pattern.strip_suffix('$') {
        return format!("{field}:*{}", solr_escape_wildcard_literal(&regex_unescape_literal(rest)));
    }
    let literal = regex_unescape_literal(pattern);
    if literal == pattern {
        // 没有正则转义也不是通配符——按真实正则走 `field:/re/`。
        if pattern.chars().any(|ch| matches!(ch, '.' | '+' | '{' | '}' | '(' | ')' | '[' | ']' | '|')) {
            return format!("{field}:/{}/", pattern.replace('/', "\\/"));
        }
    }
    format!("{field}:*{}*", solr_escape_wildcard_literal(&literal))
}

/// 反转义前端 `escapeRegexLiteral` 产生的 `\X`（X 为正则元字符）。
/// 只处理反斜杠+元字符的转义对，其余内容原样保留。
fn regex_unescape_literal(pattern: &str) -> String {
    const REGEX_META: &str = ".*+?^${}()|[]\\";
    let mut out = String::with_capacity(pattern.len());
    let mut chars = pattern.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.peek() {
                Some(&next) if REGEX_META.contains(next) => {
                    out.push(next);
                    chars.next();
                }
                _ => out.push(ch),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn translate_field_operator_filter(
    field: &str,
    object: &serde_json::Map<String, Value>,
) -> Result<Vec<String>, String> {
    let field = solr_field_name(field);
    let mut filters = Vec::new();
    let mut range = serde_json::Map::new();

    for (operator, value) in object {
        match operator.as_str() {
            "$options" => {}
            "$eq" => filters.push(translate_field_term(&field, value)?),
            "$ne" => {
                if value.is_null() {
                    filters.push(format!("{field}:*"));
                } else {
                    filters.push(format!("-{field}:{}", solr_term_value(value)?));
                }
            }
            "$gt" => {
                range.insert("gt".to_string(), value.clone());
            }
            "$gte" => {
                range.insert("gte".to_string(), value.clone());
            }
            "$lt" => {
                range.insert("lt".to_string(), value.clone());
            }
            "$lte" => {
                range.insert("lte".to_string(), value.clone());
            }
            "$in" => {
                let items = value.as_array().ok_or_else(|| "$in must be an array".to_string())?;
                filters.push(translate_in_filter(&field, items)?);
            }
            "$nin" => {
                let items = value.as_array().ok_or_else(|| "$nin must be an array".to_string())?;
                if !items.is_empty() {
                    let terms = items.iter().map(solr_term_value).collect::<Result<Vec<_>, _>>()?;
                    filters.push(format!("-({}:({}))", field, terms.join(" OR ")));
                }
            }
            "$regex" => {
                let pattern = value.as_str().ok_or_else(|| "$regex must be a string for Solr filters".to_string())?;
                filters.push(translate_regex_filter(&field, pattern));
            }
            "$not" => {
                let Some(inner) = value.as_object() else {
                    return Err("$not must be a JSON object".to_string());
                };
                let clauses = translate_field_operator_filter(&field, inner)?;
                for clause in clauses {
                    filters.push(format!("-({clause})"));
                }
            }
            "$exists" => match value.as_bool() {
                Some(true) => filters.push(format!("{field}:*")),
                Some(false) => filters.push(format!("-{field}:*")),
                None => return Err("$exists must be a boolean".to_string()),
            },
            other => return Err(format!("Unsupported Solr field filter operator: {other}")),
        }
    }

    if !range.is_empty() {
        // `$gt`/`$lt` → `{`/`}` 开区间，`$gte`/`$lte` → `[`/`]` 闭区间，缺省端点用 `*`。
        let (lower_bound, lower_open) = match (range.get("gt"), range.get("gte")) {
            (Some(v), _) => (solr_range_endpoint(v)?, true),
            (None, Some(v)) => (solr_range_endpoint(v)?, false),
            (None, None) => ("*".to_string(), false),
        };
        let (upper_bound, upper_open) = match (range.get("lt"), range.get("lte")) {
            (Some(v), _) => (solr_range_endpoint(v)?, true),
            (None, Some(v)) => (solr_range_endpoint(v)?, false),
            (None, None) => ("*".to_string(), true),
        };
        filters.push(format!(
            "{field}:{}{lower_bound} TO {upper_bound}{}",
            if lower_open { "{" } else { "[" },
            if upper_open { "}" } else { "]" }
        ));
    }

    Ok(filters)
}

fn solr_range_endpoint(value: &Value) -> Result<String, String> {
    match value {
        Value::Null => Ok("*".to_string()),
        _ => solr_term_value(value),
    }
}

fn translate_solr_document_filter_value(value: &Value) -> Result<Vec<String>, String> {
    let Some(object) = value.as_object() else {
        return Err("Solr filter must be a JSON object".to_string());
    };
    let mut filters = Vec::new();
    for (key, value) in object {
        match key.as_str() {
            "$and" => {
                let items = value.as_array().ok_or_else(|| "$and must be an array".to_string())?;
                for item in items {
                    filters.extend(translate_solr_document_filter_value(item)?);
                }
            }
            "$or" => {
                let items = value.as_array().ok_or_else(|| "$or must be an array".to_string())?;
                let mut groups = Vec::new();
                for item in items {
                    let clauses = translate_solr_document_filter_value(item)?;
                    if clauses.is_empty() {
                        continue;
                    }
                    groups.push(clauses.join(" AND "));
                }
                if !groups.is_empty() {
                    filters.push(format!("({})", groups.join(" OR ")));
                }
            }
            "$solrQuery" => {
                // 逃生舱：直接透传一段 Solr 查询语法作为 fq。
                let raw = value.as_str().ok_or_else(|| "$solrQuery must be a string".to_string())?;
                if !raw.trim().is_empty() {
                    filters.push(raw.trim().to_string());
                }
            }
            key if key.starts_with('$') => {
                return Err(format!("Unsupported Solr filter operator: {key}"));
            }
            field => match value.as_object() {
                Some(object) if object.keys().any(|k| k.starts_with('$')) => {
                    filters.extend(translate_field_operator_filter(field, object)?);
                }
                Some(_) => {
                    return Err("Nested object filters are not supported for Solr".to_string());
                }
                None => filters.push(translate_field_term(field, value)?),
            },
        }
    }
    Ok(filters)
}

fn solr_filters_from_document_filter(filter: Option<&str>) -> Result<Vec<String>, String> {
    let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    let value: Value = serde_json::from_str(filter).map_err(|e| format!("Invalid filter JSON: {e}"))?;
    translate_solr_document_filter_value(&value)
}

/// `{"a": -1, "b": "asc"}` → `"a desc,b asc"`；空输入返回 `None`。
fn solr_sort_from_document_sort(sort: Option<&str>) -> Result<Option<String>, String> {
    let Some(sort) = sort.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(sort).map_err(|e| format!("Invalid sort JSON: {e}"))?;
    let object = value.as_object().ok_or_else(|| "Solr sort must be a JSON object".to_string())?;
    if object.is_empty() {
        return Ok(None);
    }
    let items = object
        .iter()
        .map(|(field, direction)| {
            let order = match direction {
                Value::Number(number) if number.as_i64().unwrap_or(1) < 0 => "desc",
                Value::String(value) if value.eq_ignore_ascii_case("desc") => "desc",
                _ => "asc",
            };
            format!("{} {}", field.trim(), order)
        })
        .collect::<Vec<_>>();
    Ok(Some(items.join(",")))
}

fn solr_query_body(
    filter: Option<&str>,
    sort: Option<&str>,
    offset: u64,
    limit: i64,
    cursor_mark: Option<&str>,
    unique_key: Option<&str>,
) -> Result<Value, String> {
    let filters = solr_filters_from_document_filter(filter)?;
    let mut body = serde_json::json!({
        "query": "*:*",
        "offset": offset,
        "limit": limit.max(0),
    });
    if !filters.is_empty() {
        body["filter"] = Value::Array(filters.into_iter().map(Value::String).collect());
    }
    let mut sort = solr_sort_from_document_sort(sort)?;
    if cursor_mark.is_some() {
        // cursorMark 要求 sort 包含 uniqueKey 字段作稳定 tiebreaker。
        let Some(unique_key) = unique_key else {
            return Err("Solr cursor pagination requires a uniqueKey field in the schema".to_string());
        };
        let uk = unique_key.to_string();
        let has_uk = sort.as_deref().is_some_and(|s| {
            s.split(',').any(|item| item.trim_start().starts_with(&format!("{uk} ")) || item.trim() == uk)
        });
        sort = Some(match sort {
            Some(s) if has_uk => s,
            Some(s) => format!("{s},{uk} asc"),
            None => format!("{uk} asc"),
        });
    }
    if let Some(sort) = sort {
        body["sort"] = Value::String(sort);
    }
    if let Some(mark) = cursor_mark {
        body["params"] = serde_json::json!({ "cursorMark": mark });
    }
    Ok(body)
}

#[derive(Deserialize)]
struct SolrSelectResponse {
    #[serde(default)]
    response: SolrResponseBody,
    #[serde(rename = "nextCursorMark", default)]
    next_cursor_mark: Option<String>,
}

#[derive(Deserialize, Default)]
struct SolrResponseBody {
    #[serde(rename = "numFound", default)]
    num_found: u64,
    #[serde(default)]
    docs: Vec<Value>,
}

async fn solr_select(client: &SolrClient, core: &str, body: &Value) -> Result<SolrSelectResponse, String> {
    let path = client.core_path(core, "query");
    let resp = client.post(&path).json(body).send().await.map_err(|e| format!("Solr request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Solr response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Solr error: {}", solr_error_message(&text)));
    }
    serde_json::from_str(&text).map_err(|e| format!("Solr parse error: {e}"))
}

fn solr_docs_to_document_result(
    docs: Vec<Value>,
    unique_key: Option<&str>,
    total: u64,
    next_cursor: Option<String>,
) -> Result<DocumentQueryResult, String> {
    let documents: Vec<Value> = docs
        .into_iter()
        .map(|doc| {
            let Value::Object(mut map) = doc else { return doc };
            if let Some(uk) = unique_key {
                if let Some(id) = map.get(uk).cloned() {
                    map.insert("_id".to_string(), id);
                }
            }
            Value::Object(map)
        })
        .collect();

    // 与 ES 驱动一致：保留原始 JSON 数字字面量，避免 IPC/JS Number 精度损失。
    let raw_documents = documents
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Solr document serialization failed: {e}"))?;

    Ok(DocumentQueryResult {
        documents,
        raw_documents: Some(raw_documents),
        extended_documents: None,
        total,
        total_is_exact: true,
        next_cursor,
    })
}

pub async fn find_documents(
    client: &SolrClient,
    core: &str,
    skip: u64,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    let unique_key = client.unique_key(core).await;
    let body = solr_query_body(filter, sort, skip, limit, None, None)?;
    let result = solr_select(client, core, &body).await?;
    solr_docs_to_document_result(result.response.docs, unique_key.as_deref(), result.response.num_found, None)
}

/// cursorMark 分页游标：携带过滤条件指纹，翻页途中修改条件时明确报错而不是静默错位。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct SolrPageCursor {
    collection: String,
    filter: Option<String>,
    sort: Option<String>,
    mark: String,
}

fn encode_solr_cursor(cursor: &SolrPageCursor) -> Result<String, String> {
    serde_json::to_string(cursor).map_err(|e| format!("Failed to encode Solr cursor: {e}"))
}

fn decode_solr_cursor(cursor: &str) -> Result<SolrPageCursor, String> {
    serde_json::from_str(cursor).map_err(|e| format!("Invalid Solr cursor: {e}"))
}

pub async fn find_documents_with_cursor(
    client: &SolrClient,
    core: &str,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
    cursor: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    let unique_key = client.unique_key(core).await;
    let mark = match cursor {
        None => "*".to_string(),
        Some(raw) => {
            let decoded = decode_solr_cursor(raw)?;
            if decoded.collection != core || decoded.filter.as_deref() != filter || decoded.sort.as_deref() != sort {
                return Err("Solr cursor cannot be reused after the collection, filter, or sort changed".to_string());
            }
            decoded.mark
        }
    };

    let body = solr_query_body(filter, sort, 0, limit, Some(&mark), unique_key.as_deref())?;
    let result = solr_select(client, core, &body).await?;

    // Solr 用「nextCursorMark == 传入 mark」表示游标耗尽。
    let next_cursor = match result.next_cursor_mark {
        Some(next) if next != mark => Some(encode_solr_cursor(&SolrPageCursor {
            collection: core.to_string(),
            filter: filter.map(str::to_string),
            sort: sort.map(str::to_string),
            mark: next,
        })?),
        _ => None,
    };

    solr_docs_to_document_result(result.response.docs, unique_key.as_deref(), result.response.num_found, next_cursor)
}

/// cursorMark 在服务端无状态，无需释放资源。
pub async fn close_cursor(_client: &SolrClient, _cursor: &str) -> Result<(), String> {
    Ok(())
}

pub async fn count_documents(client: &SolrClient, core: &str, filter: Option<&str>) -> Result<u64, String> {
    let body = solr_query_body(filter, None, 0, 0, None, None)?;
    let result = solr_select(client, core, &body).await?;
    Ok(result.response.num_found)
}

fn solr_update_body_doc(client_doc: &mut serde_json::Map<String, Value>, unique_key: Option<&str>, id: Option<&str>) {
    // `_id`/`_routing` 是前端文档编辑器侧的元字段，不写入 Solr。数值/布尔型
    // `_id`（数值 uniqueKey 的 core）序列化为字符串写入，避免静默丢失文档标识。
    let id_value = id.map(str::to_string).or_else(|| {
        client_doc.get("_id").and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        })
    });
    if let (Some(uk), Some(id)) = (unique_key, id_value) {
        client_doc.insert(uk.to_string(), Value::String(id));
    }
    client_doc.remove("_id");
    client_doc.remove("_routing");
}

async fn solr_post_update(client: &SolrClient, core: &str, body: &Value) -> Result<(), String> {
    // softCommit 让变更立刻对搜索可见（对齐 ES `refresh=true` 的交互语义），
    // 持久化仍由后台 hard commit 保证。
    let path = client.core_path(core, "update?softCommit=true");
    let resp = client.post(&path).json(body).send().await.map_err(|e| format!("Solr request failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Solr error: {}", solr_error_message(&body)));
    }
    Ok(())
}

pub async fn insert_document(client: &SolrClient, core: &str, doc_json: &str) -> Result<String, String> {
    let mut doc: Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let unique_key = client.unique_key(core).await;
    let Value::Object(ref mut map) = doc else {
        return Err("Solr document must be a JSON object".to_string());
    };
    solr_update_body_doc(map, unique_key.as_deref(), None);
    let inserted_id = unique_key.as_deref().and_then(|uk| map.get(uk).and_then(Value::as_str).map(str::to_string));
    solr_post_update(client, core, &Value::Array(vec![doc])).await?;
    Ok(inserted_id.unwrap_or_default())
}

pub async fn update_document(client: &SolrClient, core: &str, id: &str, doc_json: &str) -> Result<u64, String> {
    let mut doc: Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let unique_key = client.unique_key(core).await;
    let Value::Object(ref mut map) = doc else {
        return Err("Solr document must be a JSON object".to_string());
    };
    solr_update_body_doc(map, unique_key.as_deref(), Some(id));
    // Solr 按 uniqueKey 整篇覆盖，等价于 ES 的 PUT /{index}/_doc/{id}。
    solr_post_update(client, core, &Value::Array(vec![doc])).await?;
    Ok(1)
}

pub async fn delete_document(client: &SolrClient, core: &str, id: &str) -> Result<u64, String> {
    solr_post_update(client, core, &serde_json::json!({ "delete": { "id": id } })).await?;
    Ok(1)
}

// ---------------------------------------------------------------------------
// REST console：`METHOD /path` + 可选 JSON body 透传，对齐 ES 编辑器体验。
// ---------------------------------------------------------------------------

struct SolrRestRequest {
    method: Method,
    path: String,
    body: Option<String>,
}

fn strip_leading_solr_comments(input: &str) -> &str {
    let mut rest = input;
    loop {
        rest = rest.trim_start();
        if let Some(comment) = rest.strip_prefix('#').or_else(|| rest.strip_prefix("//")) {
            rest = comment.split_once('\n').map_or("", |(_, remaining)| remaining);
            continue;
        }
        if let Some(comment) = rest.strip_prefix("/*") {
            rest = comment.split_once("*/").map_or("", |(_, remaining)| remaining);
            continue;
        }
        return rest.trim();
    }
}

fn parse_solr_rest_request(input: &str) -> Result<SolrRestRequest, String> {
    let input = strip_leading_solr_comments(input);
    if input.is_empty() {
        return Err("Invalid query: expected METHOD /path".to_string());
    }
    let (request_line, body) = input.split_once('\n').map_or((input, None), |(line, body)| {
        let body = body.trim();
        (line, (!body.is_empty()).then(|| body.to_string()))
    });
    let (method, path) =
        request_line.trim().split_once(char::is_whitespace).ok_or("Invalid query: expected METHOD /path")?;
    let method = method.to_ascii_uppercase();
    let method = Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("Unsupported HTTP method: {method}. Use GET, POST, PUT, DELETE, or HEAD."))?;
    if !matches!(method, Method::GET | Method::POST | Method::PUT | Method::DELETE | Method::HEAD) {
        return Err(format!("Unsupported HTTP method: {}. Use GET, POST, PUT, DELETE, or HEAD.", method.as_str()));
    }

    let mut path = path.trim().to_string();
    if path.is_empty() {
        return Err("Invalid query: expected METHOD /path".to_string());
    }
    if !path.starts_with('/') {
        path = format!("/{path}");
    }
    // base_url 已含 /solr 上下文；用户照抄文档写的 `/solr/xxx` 要去掉前缀避免 /solr/solr。
    if path == "/solr" {
        path = "/".to_string();
    } else if let Some(rest) = path.strip_prefix("/solr/") {
        path = format!("/{rest}");
    }
    // Solr 默认 wt 取决于 handler 配置（老版本常是 XML）；统一补 wt=json 让响应可解析。
    if !path.split('?').nth(1).is_some_and(|query| query.split('&').any(|p| p.split('=').next() == Some("wt"))) {
        path.push(if path.contains('?') { '&' } else { '?' });
        path.push_str("wt=json");
    }
    Ok(SolrRestRequest { method, path, body })
}

fn solr_docs_to_table(docs: &[Value]) -> (Vec<String>, Vec<String>, Vec<Vec<Value>>) {
    let mut columns = Vec::<String>::new();
    let mut column_indexes = HashMap::<String, usize>::new();
    let mut json_column_indexes = HashSet::<usize>::new();
    let mut rows = Vec::<Vec<Value>>::with_capacity(docs.len());

    for doc in docs {
        let mut row = vec![Value::Null; columns.len()];
        if let Some(object) = doc.as_object() {
            for (key, value) in object {
                let is_json_cell = matches!(value, Value::Array(_) | Value::Object(_));
                let value = if is_json_cell { Value::String(value.to_string()) } else { value.clone() };
                match column_indexes.get(key).copied() {
                    Some(index) => {
                        if is_json_cell {
                            json_column_indexes.insert(index);
                        }
                        row[index] = value;
                    }
                    None => {
                        let index = columns.len();
                        if is_json_cell {
                            json_column_indexes.insert(index);
                        }
                        column_indexes.insert(key.clone(), index);
                        columns.push(key.clone());
                        for previous_row in rows.iter_mut() {
                            previous_row.push(Value::Null);
                        }
                        row.push(value);
                    }
                }
            }
        }
        rows.push(row);
    }

    let column_types = columns
        .iter()
        .enumerate()
        .map(|(index, _)| {
            if json_column_indexes.contains(&index) {
                return "json".to_string();
            }
            let mut inferred = None;
            for value in rows.iter().filter_map(|row| row.get(index)) {
                let value_type = match value {
                    Value::Null => continue,
                    Value::Bool(_) => "boolean",
                    Value::Number(_) => "number",
                    Value::String(_) => "text",
                    Value::Array(_) | Value::Object(_) => "json",
                };
                inferred = match inferred {
                    None => Some(value_type),
                    Some(existing) if existing == value_type => Some(existing),
                    Some(_) => Some("json"),
                };
            }
            inferred.unwrap_or("unknown").to_string()
        })
        .collect();
    (columns, column_types, rows)
}

fn solr_table_result(
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<Value>>,
    start: std::time::Instant,
) -> QueryResult {
    let row_count = rows.len() as u64;
    QueryResult {
        columns,
        column_types,
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows,
        affected_rows: row_count,
        execution_time_ms: start.elapsed().as_millis(),
        server_execute_time_us: None,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

fn solr_raw_json_response_result(status: u16, body_text: impl Into<String>, start: std::time::Instant) -> QueryResult {
    QueryResult {
        columns: vec!["status".to_string(), "response".to_string()],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![vec![Value::Number(status.into()), Value::String(body_text.into())]],
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        server_execute_time_us: None,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

fn solr_rest_exceeds_table_limits(docs: &[Value]) -> bool {
    if docs.len() > SOLR_REST_TABLE_MAX_ROWS {
        return true;
    }
    let mut columns = BTreeSet::<&str>::new();
    for doc in docs {
        if let Some(object) = doc.as_object() {
            columns.extend(object.keys().map(String::as_str));
        }
        if docs.len().saturating_mul(columns.len()) > SOLR_REST_TABLE_MAX_CELLS {
            return true;
        }
    }
    false
}

fn parse_solr_rest_response(status: u16, body_text: &str, start: std::time::Instant) -> Result<QueryResult, String> {
    if body_text.trim().is_empty() {
        return Ok(solr_raw_json_response_result(status, "null", start));
    }
    if status >= 400 || body_text.len() > SOLR_REST_TABLE_MAX_BODY_BYTES {
        return Ok(solr_raw_json_response_result(status, body_text, start));
    }
    match serde_json::from_str::<Value>(body_text) {
        Ok(body) => {
            if let Some(docs) = body.pointer("/response/docs").and_then(Value::as_array) {
                if solr_rest_exceeds_table_limits(docs) {
                    return Ok(solr_raw_json_response_result(status, body_text, start));
                }
                let (columns, column_types, rows) = solr_docs_to_table(docs);
                let mut result = solr_table_result(columns, column_types, rows, start);
                // 让前端可以在表格视图与原始 JSON 响应之间切换。
                result.elasticsearch_raw_body = Some(body_text.to_string());
                return Ok(result);
            }
            Ok(solr_raw_json_response_result(
                status,
                serde_json::to_string_pretty(&body).unwrap_or_else(|_| body_text.to_string()),
                start,
            ))
        }
        Err(_) => {
            let rows: Vec<Vec<Value>> = body_text.lines().map(|line| vec![Value::String(line.to_string())]).collect();
            let mut result = solr_table_result(vec!["response".to_string()], Vec::new(), rows, start);
            result.affected_rows = result.rows.len() as u64;
            Ok(result)
        }
    }
}

pub async fn execute_rest_query(client: &SolrClient, input: &str) -> Result<QueryResult, String> {
    let start = std::time::Instant::now();
    let request = parse_solr_rest_request(input)?;
    let mut builder = client.request(request.method, &request.path);
    if let Some(body) = request.body {
        let json: Value = serde_json::from_str(&body).map_err(|e| format!("Invalid JSON body: {e}"))?;
        builder = builder.json(&json);
    }
    let resp = builder.send().await.map_err(|e| format!("Solr request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| format!("Solr response read failed: {e}"))?;
    parse_solr_rest_response(status, &body, start)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base_url_appends_solr_context_when_missing() {
        assert_eq!(normalize_solr_base_url("http://localhost:8983"), "http://localhost:8983/solr");
        assert_eq!(normalize_solr_base_url("http://localhost:8983/"), "http://localhost:8983/solr");
        assert_eq!(normalize_solr_base_url("http://localhost:8983/solr"), "http://localhost:8983/solr");
        assert_eq!(normalize_solr_base_url("http://localhost:8983/solr/"), "http://localhost:8983/solr");
    }

    #[test]
    fn filter_translation_covers_mongo_style_operators() {
        let filters = solr_filters_from_document_filter(Some(
            r#"{"city":"长治","age":{"$gte":18,"$lt":60},"status":{"$ne":"closed"},"tags":{"$in":["a","b"]},"deleted":null}"#,
        ))
        .unwrap();
        assert_eq!(
            filters,
            vec![
                "city:\"长治\"".to_string(),
                "age:[18 TO 60}".to_string(),
                "-status:\"closed\"".to_string(),
                "tags:(\"a\" OR \"b\")".to_string(),
                "-deleted:*".to_string()
            ]
        );
    }

    #[test]
    fn or_group_wraps_clauses() {
        let filters = solr_filters_from_document_filter(Some(r#"{"$or":[{"city":"长治"},{"city":"上海"}]}"#)).unwrap();
        assert_eq!(filters, vec!["(city:\"长治\" OR city:\"上海\")".to_string()]);
    }

    #[test]
    fn sort_translation_matches_solr_syntax() {
        assert_eq!(
            solr_sort_from_document_sort(Some(r#"{"created_at":-1}"#)).unwrap().as_deref(),
            Some("created_at desc")
        );
        assert_eq!(solr_sort_from_document_sort(None).unwrap(), None);
    }

    #[test]
    fn cursor_body_appends_unique_key_sort() {
        let body = solr_query_body(None, Some(r#"{"ts":-1}"#), 0, 10, Some("*"), Some("id")).unwrap();
        assert_eq!(body["sort"], json!("ts desc,id asc"));
        assert_eq!(body["params"], json!({ "cursorMark": "*" }));
    }

    #[test]
    fn rest_request_strips_solr_prefix_and_adds_wt() {
        let req = parse_solr_rest_request("GET /solr/gettingstarted/select?q=*:*").unwrap();
        assert_eq!(req.path, "/gettingstarted/select?q=*:*&wt=json");
        let req = parse_solr_rest_request("GET /gettingstarted/select?q=*:*&wt=xml").unwrap();
        assert_eq!(req.path, "/gettingstarted/select?q=*:*&wt=xml");
    }
}
