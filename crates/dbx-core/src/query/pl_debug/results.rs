use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::collections::BTreeMap;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAGE: usize = 65536;
type Key = (u64, String, String);

#[derive(Default)]
pub(super) struct RetainedResults {
    entries: BTreeMap<Key, RetainedResult>,
    collections: BTreeMap<u64, String>,
    used: usize,
}

struct RetainedResult {
    manifest: Value,
    pages: BTreeMap<usize, Value>,
}

fn identity(value: &Value, key: &str) -> Result<String, String> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| format!("Invalid retained result {key}"))
}

fn number(value: &Value, key: &str) -> Result<usize, String> {
    value[key]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("Invalid retained result {key}"))
}

fn units(value: &Value, encoding: &str) -> Result<Vec<u16>, String> {
    let text = value["data"].as_str().ok_or("Missing retained result page data")?;
    if text.len() > MAX_PAGE * 4 {
        return Err("Retained result page data exceeds its bound".into());
    }
    match encoding {
        "utf16" => Ok(text.encode_utf16().collect()),
        "base64" => {
            let bytes = STANDARD.decode(text).map_err(|_| "Invalid retained result base64")?;
            if STANDARD.encode(&bytes) != text {
                return Err("Noncanonical retained result base64".into());
            }
            Ok(bytes.into_iter().map(u16::from).collect())
        }
        _ => Err("Unknown retained result encoding".into()),
    }
}

fn page_cost(page: &Value) -> usize {
    page["data"].as_str().map_or(0, str::len)
        + json!({"offset":page["offset"],"nextOffset":page["nextOffset"],"eof":page["eof"]}).to_string().len()
}

impl RetainedResult {
    fn missing_ranges(&self) -> Vec<Value> {
        let mut ranges = Vec::new();
        let mut next = 0;
        for (&start, page) in &self.pages {
            if start > next {
                ranges.push(json!({"offset":next,"nextOffset":start}));
            }
            next = next.max(page["nextOffset"].as_u64().unwrap() as usize);
        }
        let length = self.manifest["length"].as_u64().unwrap() as usize;
        if next < length {
            ranges.push(json!({"offset":next,"nextOffset":length}));
        }
        ranges
    }

    fn missing(&self) -> usize {
        let mut next = 0;
        for (&start, page) in &self.pages {
            if start > next {
                break;
            }
            next = next.max(page["nextOffset"].as_u64().unwrap() as usize);
        }
        next
    }
}

impl RetainedResults {
    pub(super) fn manifest(&mut self, generation: u64, value: &Value) -> Result<(), String> {
        let state = value["collectionState"]
            .as_str()
            .filter(|state| matches!(*state, "pending" | "available" | "partial" | "unavailable"))
            .ok_or("Invalid debugger result collection state")?;
        let rows = value["results"].as_array().ok_or("Missing debugger result manifest")?;
        let mut incoming = BTreeMap::new();
        let mut cost = 0;
        for row in rows {
            let key = (generation, identity(row, "generation")?, identity(row, "resultId")?);
            let length = number(row, "length")?;
            let encoding = row["encoding"].as_str().ok_or("Missing retained result encoding")?;
            let unit = match encoding {
                "utf16" => "utf16",
                "base64" => "bytes",
                _ => return Err("Unknown retained result encoding".into()),
            };
            let complete = row["complete"].as_bool().ok_or("Missing retained result completeness")?;
            let truncated = row["truncated"].as_bool().ok_or("Missing retained result truncation")?;
            let size = row.to_string().len();
            if length > MAX_BYTES
                || size > 4096
                || row["lengthUnit"] != unit
                || complete && truncated
                || row["state"] != if complete { "available" } else { "partial" }
                || !complete && !truncated && !row["error"].is_string()
            {
                return Err("Contradictory retained result manifest".into());
            }
            if incoming.insert(key.clone(), row.clone()).is_some() {
                return Err("Duplicate retained result identity".into());
            }
            if let Some(previous) = self.entries.get(&key) {
                if previous.manifest != *row {
                    return Err("Retained result identity changed its manifest".into());
                }
            } else {
                cost += size + std::mem::size_of::<u64>();
            }
        }
        if self.entries.keys().any(|key| key.0 == generation && !incoming.contains_key(key)) {
            return Err("A published retained result disappeared".into());
        }
        if let Some(previous) = self.collections.get(&generation) {
            if previous != "pending"
                && (previous != state || incoming.keys().any(|key| !self.entries.contains_key(key)))
            {
                return Err("A completed result collection changed".into());
            }
        }
        let collection_cost = |state: &str| json!({"generation":generation,"collectionState":state}).to_string().len();
        let previous_cost = self.collections.get(&generation).map_or(0, |state| collection_cost(state));
        let retained_cost = self.used - previous_cost + collection_cost(state) + cost;
        if retained_cost > MAX_BYTES {
            return Err("Retained debugger result budget exceeded".into());
        }
        for (key, manifest) in incoming {
            self.entries.entry(key).or_insert_with(|| RetainedResult { manifest, pages: BTreeMap::new() });
        }
        self.used = retained_cost;
        self.collections.insert(generation, state.into());
        Ok(())
    }

    pub(super) fn manifests(&self, generation: u64) -> Option<Value> {
        let state = self.collections.get(&generation)?;
        let rows: Vec<_> = self
            .entries
            .iter()
            .filter(|(key, _)| key.0 == generation)
            .map(|(_, entry)| {
                let mut manifest = entry.manifest.clone();
                let missing = entry.missing_ranges();
                manifest["retentionState"] = json!(if missing.is_empty() { "complete" } else { "partial" });
                manifest["missingRanges"] = json!(missing);
                manifest
            })
            .collect();
        let retained = state != "pending"
            && state != "unavailable"
            && self
                .entries
                .iter()
                .filter(|(key, _)| key.0 == generation)
                .all(|(_, entry)| entry.missing() == entry.manifest["length"].as_u64().unwrap() as usize);
        Some(
            json!({"results":rows,"collectionState":state,"retentionState":if state == "unavailable" {"unavailable"} else if retained {"complete"} else {"partial"}}),
        )
    }

    pub(super) fn retain_page(&mut self, generation: u64, params: &Value, page: &Value) -> Result<(), String> {
        let key = (generation, identity(params, "generation")?, identity(params, "resultId")?);
        let entry = self.entries.get_mut(&key).ok_or("Unknown retained result identity")?;
        let offset = number(params, "offset")?;
        let limit = number(params, "limit")?;
        let end = number(page, "nextOffset")?;
        let length = number(&entry.manifest, "length")?;
        if limit == 0
            || limit > MAX_PAGE
            || number(page, "offset")? != offset
            || offset > end
            || end > length
            || end - offset > limit
            || end == offset && offset != length
            || page["eof"].as_bool() != Some(end == length)
            || entry.manifest.as_object().unwrap().iter().any(|(key, value)| page.get(key) != Some(value))
        {
            return Err("Contradictory retained result page".into());
        }
        let encoding = entry.manifest["encoding"].as_str().unwrap();
        let incoming = units(page, encoding)?;
        if incoming.len() != end - offset {
            return Err("Retained result page length mismatch".into());
        }
        for (&start, previous) in &entry.pages {
            let previous_end = number(previous, "nextOffset")?;
            let first = start.max(offset);
            let last = previous_end.min(end);
            if first < last
                && units(previous, encoding)?[first - start..last - start] != incoming[first - offset..last - offset]
            {
                return Err("Retained result pages disagree".into());
            }
        }
        if entry.pages.get(&offset).is_some_and(|previous| previous["nextOffset"].as_u64().unwrap() as usize >= end) {
            return Ok(());
        }
        let old = entry.pages.get(&offset).map_or(0, page_cost);
        let cost = page_cost(page);
        if cost > MAX_BYTES - self.used + old {
            return Err("Retained debugger result budget exceeded".into());
        }
        entry.pages.insert(offset, json!({"offset":offset,"nextOffset":end,"eof":end==length,"data":page["data"]}));
        self.used = self.used - old + cost;
        Ok(())
    }

    pub(super) fn page(&self, generation: u64, params: &Value) -> Result<Option<Value>, String> {
        let key = (generation, identity(params, "generation")?, identity(params, "resultId")?);
        let Some(entry) = self.entries.get(&key) else {
            return Ok(None);
        };
        let offset = number(params, "offset")?;
        let limit = number(params, "limit")?;
        let length = number(&entry.manifest, "length")?;
        if offset > length || limit == 0 || limit > MAX_PAGE {
            return Err("Invalid retained result page bounds".into());
        }
        let mut result = entry.manifest.clone();
        if offset == length {
            result
                .as_object_mut()
                .unwrap()
                .extend(json!({"offset":offset,"nextOffset":offset,"eof":true,"data":""}).as_object().unwrap().clone());
            return Ok(Some(result));
        }
        let Some((&start, page)) =
            entry.pages.range(..=offset).rev().find(|(_, page)| page["nextOffset"].as_u64().unwrap() as usize > offset)
        else {
            return Ok(None);
        };
        let previous_end = number(page, "nextOffset")?;
        if previous_end <= offset {
            return Ok(None);
        }
        let encoding = entry.manifest["encoding"].as_str().unwrap();
        let data = units(page, encoding)?;
        let mut end = previous_end.min(offset.saturating_add(limit));
        if encoding == "utf16" && end < previous_end && (0xD800..=0xDBFF).contains(&data[end - start - 1]) {
            end -= 1;
        }
        if end == offset {
            return Err("The page limit cannot contain the next surrogate pair".into());
        }
        let slice = &data[offset - start..end - start];
        let text = if encoding == "utf16" {
            String::from_utf16(slice).map_err(|_| "A result offset splits a surrogate pair")?
        } else {
            STANDARD.encode(slice.iter().map(|value| *value as u8).collect::<Vec<_>>())
        };
        result.as_object_mut().unwrap().extend(
            json!({"offset":offset,"nextOffset":end,"eof":end==length,"data":text}).as_object().unwrap().clone(),
        );
        Ok(Some(result))
    }

    fn next_missing(&self, generation: u64) -> Option<Value> {
        self.entries.iter().filter(|(key, _)| key.0 == generation).find_map(|(key, entry)| {
            let offset = entry.missing();
            (offset < entry.manifest["length"].as_u64().unwrap() as usize)
                .then(|| json!({"generation":key.1,"resultId":key.2,"offset":offset,"limit":MAX_PAGE}))
        })
    }
}

pub(super) async fn retain_before_exit(
    entry: &Arc<Entry>,
    generation: u64,
    channel: &PlDebugAgentChannel,
    agent_id: &str,
) {
    if !channel.supports_retained_pl_debug_results() {
        return;
    }
    {
        let mut data = entry.lock();
        if data.generation != generation {
            return;
        }
        data.snapshot["resultRetentionState"] = json!("pending");
    }
    let retain = async {
        let remaining = || -> Result<Duration, String> {
            let data = entry.lock();
            if data.generation != generation || data.scope != channel.scope() || data.runtime_exited {
                return Err("The original result scope is no longer active".into());
            }
            let deadline = data.close.as_ref().ok_or("No original result cleanup deadline")?.deadline;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("The original result retention deadline expired".into());
            }
            Ok(remaining.min(QUICK_TIMEOUT))
        };
        let manifest = channel
            .call::<Value>("pl_debug_get_results", json!({"debugId":agent_id}), remaining()?, None)
            .await
            .map_err(|_| "The result manifest could not be retained".to_string())?;
        {
            let mut data = entry.lock();
            if data.generation != generation || data.scope != channel.scope() {
                return Err("The original result scope changed".into());
            }
            data.retained_results.manifest(generation, &manifest)?;
        }
        loop {
            let params = entry.lock().retained_results.next_missing(generation);
            let Some(params) = params else {
                break;
            };
            let mut wire = params.clone();
            wire.as_object_mut().unwrap().insert("debugId".into(), json!(agent_id));
            let page = channel
                .call::<Value>("pl_debug_get_result_page", wire, remaining()?, None)
                .await
                .map_err(|_| "A debugger result page could not be retained".to_string())?;
            let mut data = entry.lock();
            if data.generation != generation || data.scope != channel.scope() {
                return Err("The original result scope changed".into());
            }
            data.retained_results.retain_page(generation, &params, &page)?;
        }
        Ok::<(), String>(())
    }
    .await;
    let mut data = entry.lock();
    if data.generation != generation {
        return;
    }
    data.snapshot["resultRetentionState"] = data
        .retained_results
        .manifests(generation)
        .map_or(json!("unavailable"), |value| value["retentionState"].clone());
    if let Err(error) = retain {
        data.snapshot["resultRetentionError"] = json!(error);
    }
}

pub(super) async fn read(entry: &Arc<Entry>, request: PlDebugRead) -> Result<Value, String> {
    let page = matches!(request.kind, PlDebugReadKind::ResultPage);
    let mut params = request.params;
    if page {
        let object = params.as_object_mut().ok_or("Debug result read parameters must be an object")?;
        object.entry("offset").or_insert(json!(0));
        object.entry("limit").or_insert(json!(32000));
        identity(&params, "generation")?;
        identity(&params, "resultId")?;
        let limit = number(&params, "limit")?;
        number(&params, "offset")?;
        if limit == 0 || limit > MAX_PAGE {
            return Err("Invalid debugger result page limit".into());
        }
    }
    let (channel, scope, agent_id, need_manifest) = {
        let data = entry.lock();
        if page {
            if let Some(value) = data.retained_results.page(request.generation, &params)? {
                return Ok(value);
            }
        } else if let Some(value) = data.retained_results.manifests(request.generation) {
            if value["collectionState"] != "pending" || data.runtime_exited || data.generation != request.generation {
                return Ok(value);
            }
        }
        if data.generation != request.generation || data.runtime_exited {
            return Err("The requested result was not retained before its Agent exited".into());
        }
        (
            data.channel.clone(),
            data.scope,
            data.agent_id.clone(),
            data.retained_results
                .manifests(request.generation)
                .is_none_or(|value| value["collectionState"] == "pending"),
        )
    };
    let channel = channel.ok_or("The original result Agent session is not ready")?;
    if channel.scope() != scope {
        return Err("The original result channel scope changed".into());
    }
    if need_manifest {
        let value = channel
            .call::<Value>("pl_debug_get_results", json!({"debugId":agent_id}), QUICK_TIMEOUT, None)
            .await
            .map_err(|error| error.into_legacy_string())?;
        let mut data = entry.lock();
        if data.generation != request.generation || data.scope != scope {
            return Err("The result collection completed for an old Agent scope".into());
        }
        data.retained_results.manifest(request.generation, &value)?;
    }
    {
        let data = entry.lock();
        if !page {
            return data.retained_results.manifests(request.generation).ok_or("No result manifest was retained".into());
        }
        if let Some(value) = data.retained_results.page(request.generation, &params)? {
            return Ok(value);
        }
    }
    let mut wire = params.clone();
    wire.as_object_mut().unwrap().insert("debugId".into(), json!(agent_id));
    let value = channel
        .call::<Value>("pl_debug_get_result_page", wire, QUICK_TIMEOUT, None)
        .await
        .map_err(|error| error.into_legacy_string())?;
    let mut data = entry.lock();
    if data.generation != request.generation || data.scope != scope {
        return Err("The result page completed for an old Agent scope".into());
    }
    data.retained_results.retain_page(request.generation, &params, &value)?;
    data.retained_results.page(request.generation, &params)?.ok_or("The result page was not retained".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Value {
        json!({"generation":"g","resultId":"r","encoding":"utf16","lengthUnit":"utf16","length":5,"complete":true,"truncated":false,"state":"available"})
    }
    fn params(offset: usize, limit: usize) -> Value {
        json!({"generation":"g","resultId":"r","offset":offset,"limit":limit})
    }
    fn page(offset: usize, end: usize, data: &str) -> Value {
        let mut value = manifest();
        value
            .as_object_mut()
            .unwrap()
            .extend(json!({"offset":offset,"nextOffset":end,"eof":end==5,"data":data}).as_object().unwrap().clone());
        value
    }
    #[test]
    fn retained_pages_preserve_unicode_identity_and_reject_conflicting_replies() {
        let mut cache = RetainedResults::default();
        cache.manifest(1, &json!({"collectionState":"available","results":[manifest()]})).unwrap();
        cache.retain_page(1, &params(0, 5), &page(0, 5, "a😀bc")).unwrap();
        assert_eq!(cache.page(1, &params(1, 2)).unwrap().unwrap()["data"], "😀");
        assert!(cache.page(1, &params(2, 2)).is_err());
        assert!(cache.page(2, &params(0, 5)).unwrap().is_none());
        assert!(cache.retain_page(1, &params(0, 5), &page(0, 5, "a😀bd")).is_err());
        assert_eq!(cache.page(1, &params(0, 5)).unwrap().unwrap()["data"], "a😀bc");
        assert_eq!(cache.manifests(1).unwrap()["retentionState"], "complete");
        cache.retain_page(1, &params(3, 1), &page(3, 4, "b")).unwrap();
        assert_eq!(cache.page(1, &params(4, 1)).unwrap().unwrap()["data"], "c");
    }

    #[test]
    fn binary_pages_use_decoded_byte_offsets_and_reject_false_lengths() {
        let mut reference = manifest();
        reference["encoding"] = json!("base64");
        reference["lengthUnit"] = json!("bytes");
        reference["length"] = json!(4);
        let mut cache = RetainedResults::default();
        cache.manifest(1, &json!({"collectionState":"available","results":[reference.clone()]})).unwrap();
        let mut first = reference.clone();
        first
            .as_object_mut()
            .unwrap()
            .extend(json!({"offset":0,"nextOffset":3,"eof":false,"data":"AAEC"}).as_object().unwrap().clone());
        cache.retain_page(1, &params(0, 3), &first).unwrap();
        assert_eq!(cache.page(1, &params(1, 2)).unwrap().unwrap()["data"], "AQI=");
        first["data"] = json!("AA==");
        assert!(cache.retain_page(1, &params(0, 3), &first).is_err());
        let mut last = reference;
        last.as_object_mut()
            .unwrap()
            .extend(json!({"offset":3,"nextOffset":4,"eof":true,"data":"/w=="}).as_object().unwrap().clone());
        cache.retain_page(1, &params(3, 1), &last).unwrap();
        assert_eq!(cache.manifests(1).unwrap()["retentionState"], "complete");
    }

    #[test]
    fn cumulative_budget_across_generations_preserves_previously_retained_data() {
        let mut cache = RetainedResults::default();
        let length = MAX_BYTES / 2;
        let mut reference = manifest();
        reference["length"] = json!(length);
        let data = "a".repeat(MAX_PAGE);
        let mut exhausted = false;
        for generation in 1..=2 {
            cache.manifest(generation, &json!({"collectionState":"available","results":[reference.clone()]})).unwrap();
            for offset in (0..length).step_by(MAX_PAGE) {
                let mut page = reference.clone();
                page.as_object_mut().unwrap().extend(
                    json!({"offset":offset,"nextOffset":offset+MAX_PAGE,"eof":offset+MAX_PAGE==length,"data":data})
                        .as_object()
                        .unwrap()
                        .clone(),
                );
                if let Err(error) = cache.retain_page(generation, &params(offset, MAX_PAGE), &page) {
                    assert!(error.contains("budget"));
                    exhausted = true;
                    break;
                }
            }
        }
        assert!(exhausted);
        assert!(cache.used <= MAX_BYTES);
        assert_eq!(cache.manifests(1).unwrap()["retentionState"], "complete");
        assert_eq!(cache.manifests(2).unwrap()["retentionState"], "partial");
        assert_eq!(cache.page(1, &params(0, 8)).unwrap().unwrap()["data"], "aaaaaaaa");
    }
    #[test]
    fn missing_pages_and_changed_manifest_do_not_erase_confirmed_prefixes() {
        let mut cache = RetainedResults::default();
        cache.manifest(1, &json!({"collectionState":"available","results":[manifest()]})).unwrap();
        cache.retain_page(1, &params(0, 1), &page(0, 1, "a")).unwrap();
        assert_eq!(cache.manifests(1).unwrap()["retentionState"], "partial");
        assert!(cache.page(1, &params(1, 4)).unwrap().is_none());
        assert!(cache.manifest(1, &json!({"collectionState":"available","results":[]})).is_err());
        assert_eq!(cache.page(1, &params(0, 1)).unwrap().unwrap()["data"], "a");
    }
}
