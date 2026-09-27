use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde_json::Value;
use tauri::State;
use uuid::Uuid;

const MAX_MEDIA_SOURCES_PER_PLUGIN: usize = 32;
const MEDIA_SOURCE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone)]
pub struct PluginMediaSource {
    pub plugin_id: String,
    pub method: String,
    pub params: Value,
}

struct StoredPluginMediaSource {
    source: PluginMediaSource,
    created_at: Instant,
}

#[derive(Clone, Default)]
pub struct PluginMediaState {
    sources: Arc<Mutex<HashMap<String, StoredPluginMediaSource>>>,
}

impl PluginMediaState {
    pub fn new() -> Self {
        Self::default()
    }

    fn purge_expired(sources: &mut HashMap<String, StoredPluginMediaSource>, now: Instant) {
        sources.retain(|_, source| now.duration_since(source.created_at) < MEDIA_SOURCE_TTL);
    }

    pub(crate) fn get(&self, plugin_id: &str, token: &str) -> Option<PluginMediaSource> {
        let now = Instant::now();
        let mut sources = self.sources.lock().ok()?;
        Self::purge_expired(&mut sources, now);
        let stored = sources.get(token)?;
        (stored.source.plugin_id == plugin_id).then(|| stored.source.clone())
    }

    fn open(&self, plugin_id: String, method: String, params: Value) -> Result<String, String> {
        if method != "filesystem/media/read" {
            return Err("Plugin media URLs only support filesystem/media/read".to_string());
        }
        if !params.is_object() {
            return Err("Plugin media parameters must be an object".to_string());
        }
        let now = Instant::now();
        let mut sources = self.sources.lock().map_err(|_| "Plugin media registry is unavailable".to_string())?;
        Self::purge_expired(&mut sources, now);
        if sources.values().filter(|source| source.source.plugin_id == plugin_id).count()
            >= MAX_MEDIA_SOURCES_PER_PLUGIN
        {
            return Err("Too many active plugin media URLs".to_string());
        }
        let token = Uuid::new_v4().to_string();
        sources.insert(
            token.clone(),
            StoredPluginMediaSource { source: PluginMediaSource { plugin_id, method, params }, created_at: now },
        );
        Ok(token)
    }

    fn close(&self, plugin_id: &str, token: &str) -> Result<(), String> {
        let mut sources = self.sources.lock().map_err(|_| "Plugin media registry is unavailable".to_string())?;
        if sources.get(token).is_some_and(|source| source.source.plugin_id == plugin_id) {
            sources.remove(token);
        }
        Ok(())
    }
}

#[tauri::command]
pub fn plugin_media_open(
    state: State<'_, PluginMediaState>,
    plugin_id: String,
    method: String,
    params: Value,
) -> Result<String, String> {
    state.open(plugin_id, method, params)
}

#[tauri::command]
pub fn plugin_media_close(state: State<'_, PluginMediaState>, plugin_id: String, token: String) -> Result<(), String> {
    state.close(&plugin_id, &token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_tokens_are_scoped_to_the_owning_plugin() {
        let state = PluginMediaState::new();
        let token = state
            .open(
                "sample".to_string(),
                "filesystem/media/read".to_string(),
                serde_json::json!({ "uri": "s3://bucket/video.mp4" }),
            )
            .unwrap();
        assert!(state.get("sample", &token).is_some());
        assert!(state.get("other", &token).is_none());
        state.close("other", &token).unwrap();
        assert!(state.get("sample", &token).is_some());
        state.close("sample", &token).unwrap();
        assert!(state.get("sample", &token).is_none());
    }

    #[test]
    fn media_registry_rejects_arbitrary_backend_methods() {
        let state = PluginMediaState::new();
        assert!(state.open("sample".to_string(), "connection/connect".to_string(), serde_json::json!({})).is_err());
    }
}
