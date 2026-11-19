use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use super::ConfigLayer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEntry {
    pub timestamp: DateTime<Utc>,
    pub layer: ConfigLayer,
    pub key: String,
    pub action: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceRingBuffer {
    capacity: usize,
    entries: VecDeque<TraceEntry>,
}

impl TraceRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self { capacity, entries: VecDeque::with_capacity(capacity) }
    }

    pub fn push(&mut self, entry: TraceEntry) {
        if self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    pub fn record(&mut self, layer: ConfigLayer, key: &str, action: &str, detail: &str) {
        self.push(TraceEntry {
            timestamp: Utc::now(),
            layer,
            key: key.to_string(),
            action: action.to_string(),
            detail: detail.to_string(),
        });
    }

    pub fn entries(&self) -> impl Iterator<Item = &TraceEntry> {
        self.entries.iter()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn filter_by_layer(&self, layer: ConfigLayer) -> Vec<&TraceEntry> {
        self.entries.iter().filter(|e| e.layer == layer).collect()
    }

    pub fn filter_by_action(&self, action: &str) -> Vec<&TraceEntry> {
        self.entries.iter().filter(|e| e.action == action).collect()
    }

    pub fn export_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(&self.entries)
            .map_err(|e| format!("Failed to serialize {} trace entries: {e}", self.entries.len()))
    }

    pub fn recent(&self, n: usize) -> Vec<&TraceEntry> {
        let n = n.min(self.entries.len());
        self.entries.iter().rev().take(n).collect()
    }

    pub fn stats(&self) -> TraceStats {
        let mut action_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut layer_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

        for entry in &self.entries {
            *action_counts.entry(entry.action.clone()).or_insert(0) += 1;
            *layer_counts.entry(entry.layer.label().to_string()).or_insert(0) += 1;
        }

        TraceStats { total_entries: self.entries.len(), capacity: self.capacity, action_counts, layer_counts }
    }
}

impl Default for TraceRingBuffer {
    fn default() -> Self {
        Self::new(1000)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceStats {
    pub total_entries: usize,
    pub capacity: usize,
    pub action_counts: std::collections::HashMap<String, usize>,
    pub layer_counts: std::collections::HashMap<String, usize>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn sample_entry() -> TraceEntry {
        TraceEntry {
            timestamp: Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
            layer: ConfigLayer::Global,
            key: "host".to_string(),
            action: "read".to_string(),
            detail: "value resolved".to_string(),
        }
    }

    #[test]
    fn test_new_buffer_is_empty() {
        let buf = TraceRingBuffer::new(10);
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
    }

    #[test]
    fn test_push_adds_entry() {
        let mut buf = TraceRingBuffer::new(10);
        buf.push(sample_entry());
        assert_eq!(buf.len(), 1);
    }

    #[test]
    fn test_push_evicts_oldest_when_full() {
        let mut buf = TraceRingBuffer::new(3);
        for i in 0..5 {
            buf.push(TraceEntry {
                timestamp: Utc::now(),
                layer: ConfigLayer::Task,
                key: format!("key{i}"),
                action: "write".to_string(),
                detail: String::new(),
            });
        }
        assert_eq!(buf.len(), 3);
        let entries: Vec<&TraceEntry> = buf.entries().collect();
        assert_eq!(entries[0].key, "key2");
        assert_eq!(entries[2].key, "key4");
    }

    #[test]
    fn test_record_convenience() {
        let mut buf = TraceRingBuffer::new(10);
        buf.record(ConfigLayer::Global, "host", "read", "localhost");
        assert_eq!(buf.len(), 1);
        let entry = buf.entries().next().unwrap();
        assert_eq!(entry.layer, ConfigLayer::Global);
        assert_eq!(entry.key, "host");
        assert_eq!(entry.action, "read");
    }

    #[test]
    fn test_filter_by_layer() {
        let mut buf = TraceRingBuffer::new(10);
        buf.record(ConfigLayer::Global, "host", "read", "");
        buf.record(ConfigLayer::Project, "port", "write", "");
        buf.record(ConfigLayer::Global, "user", "read", "");

        let global_entries = buf.filter_by_layer(ConfigLayer::Global);
        assert_eq!(global_entries.len(), 2);

        let project_entries = buf.filter_by_layer(ConfigLayer::Project);
        assert_eq!(project_entries.len(), 1);

        let task_entries = buf.filter_by_layer(ConfigLayer::Task);
        assert_eq!(task_entries.len(), 0);
    }

    #[test]
    fn test_filter_by_action() {
        let mut buf = TraceRingBuffer::new(10);
        buf.record(ConfigLayer::Global, "host", "read", "");
        buf.record(ConfigLayer::Global, "port", "write", "");
        buf.record(ConfigLayer::Global, "user", "read", "");

        let reads = buf.filter_by_action("read");
        assert_eq!(reads.len(), 2);

        let writes = buf.filter_by_action("write");
        assert_eq!(writes.len(), 1);
    }

    #[test]
    fn test_export_json() {
        let mut buf = TraceRingBuffer::new(10);
        buf.push(sample_entry());
        let json = buf.export_json().unwrap();
        assert!(json.contains("host"));
        assert!(json.contains("read"));
    }

    #[test]
    fn test_recent() {
        let mut buf = TraceRingBuffer::new(10);
        for i in 0..5 {
            buf.record(ConfigLayer::Task, &format!("key{i}"), "write", "");
        }
        let recent = buf.recent(3);
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].key, "key4");
        assert_eq!(recent[2].key, "key2");
    }

    #[test]
    fn test_recent_less_than_n() {
        let mut buf = TraceRingBuffer::new(10);
        buf.record(ConfigLayer::Task, "k1", "read", "");
        let recent = buf.recent(10);
        assert_eq!(recent.len(), 1);
    }

    #[test]
    fn test_clear() {
        let mut buf = TraceRingBuffer::new(10);
        buf.record(ConfigLayer::Task, "k1", "read", "");
        buf.record(ConfigLayer::Task, "k2", "write", "");
        assert_eq!(buf.len(), 2);
        buf.clear();
        assert!(buf.is_empty());
    }

    #[test]
    fn test_stats() {
        let mut buf = TraceRingBuffer::new(100);
        buf.record(ConfigLayer::Global, "host", "read", "");
        buf.record(ConfigLayer::Global, "port", "read", "");
        buf.record(ConfigLayer::Project, "config", "write", "");

        let stats = buf.stats();
        assert_eq!(stats.total_entries, 3);
        assert_eq!(*stats.action_counts.get("read").unwrap(), 2);
        assert_eq!(*stats.action_counts.get("write").unwrap(), 1);
        assert_eq!(*stats.layer_counts.get("global").unwrap(), 2);
        assert_eq!(*stats.layer_counts.get("project").unwrap(), 1);
    }

    #[test]
    fn test_default_capacity() {
        let buf = TraceRingBuffer::default();
        assert_eq!(buf.capacity(), 1000);
    }

    #[test]
    fn test_capacity_set_correctly() {
        let buf = TraceRingBuffer::new(500);
        assert_eq!(buf.capacity(), 500);
    }

    #[test]
    fn test_entry_timestamp_is_set() {
        let mut buf = TraceRingBuffer::new(10);
        buf.record(ConfigLayer::Task, "k", "read", "detail");
        let entry = buf.entries().next().unwrap();
        let now = Utc::now();
        let diff = now - entry.timestamp;
        assert!(diff.num_seconds() < 5);
    }
}
