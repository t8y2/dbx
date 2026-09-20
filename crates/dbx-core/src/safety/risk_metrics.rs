use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricType {
    Counter,
    Gauge,
    Histogram,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricEntry {
    pub name: String,
    pub metric_type: MetricType,
    pub description: String,
    pub labels: HashMap<String, String>,
    pub value: MetricValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MetricValue {
    Counter(u64),
    Gauge(f64),
    Histogram(Vec<(f64, u64)>),
}

pub struct DegradationMetrics {
    degradation_total: AtomicU64,
    degradation_level_full: AtomicU64,
    degradation_level_sample: AtomicU64,
    degradation_level_skip: AtomicU64,
    sample_rate_histogram: Mutex<Vec<(f64, u64)>>,
    confidence_gauge: Mutex<f64>,
    auto_upgrade_total: AtomicU64,
    auto_downgrade_total: AtomicU64,
    // Phase 15.5: OSC and rollback metrics
    osc_probe_latency: Mutex<Vec<f64>>,
    osc_execution_gauge: Mutex<f64>,
    rollback_trigger_count: AtomicU64,
    tag_block_count: AtomicU64,
    trace_dropped_count: AtomicU64,
}

impl DegradationMetrics {
    pub fn new() -> Self {
        Self {
            degradation_total: AtomicU64::new(0),
            degradation_level_full: AtomicU64::new(0),
            degradation_level_sample: AtomicU64::new(0),
            degradation_level_skip: AtomicU64::new(0),
            sample_rate_histogram: Mutex::new(Vec::new()),
            confidence_gauge: Mutex::new(0.0),
            auto_upgrade_total: AtomicU64::new(0),
            auto_downgrade_total: AtomicU64::new(0),
            osc_probe_latency: Mutex::new(Vec::new()),
            osc_execution_gauge: Mutex::new(0.0),
            rollback_trigger_count: AtomicU64::new(0),
            tag_block_count: AtomicU64::new(0),
            trace_dropped_count: AtomicU64::new(0),
        }
    }

    pub fn record_degradation(&self, level: &str, sample_rate: f64, confidence: f64) {
        self.degradation_total.fetch_add(1, Ordering::Relaxed);
        match level {
            "full" => {
                self.degradation_level_full.fetch_add(1, Ordering::Relaxed);
            }
            "sample" => {
                self.degradation_level_sample.fetch_add(1, Ordering::Relaxed);
            }
            "skip_with_risk" => {
                self.degradation_level_skip.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
        if let Ok(mut h) = self.sample_rate_histogram.lock() {
            h.push((sample_rate, 1));
        }
        if let Ok(mut g) = self.confidence_gauge.lock() {
            *g = confidence;
        }
    }

    pub fn record_auto_upgrade(&self) {
        self.auto_upgrade_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_auto_downgrade(&self) {
        self.auto_downgrade_total.fetch_add(1, Ordering::Relaxed);
    }

    // --- Phase 15.5: OSC & rollback metrics ---

    pub fn record_osc_probe_latency(&self, latency_ms: f64) {
        if let Ok(mut h) = self.osc_probe_latency.lock() {
            h.push(latency_ms);
            if h.len() > 1000 {
                h.remove(0);
            }
        }
    }

    pub fn set_osc_execution_status(&self, status: f64) {
        if let Ok(mut g) = self.osc_execution_gauge.lock() {
            *g = status;
        }
    }

    pub fn record_rollback_trigger(&self) {
        self.rollback_trigger_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_tag_block(&self) {
        self.tag_block_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_trace_dropped(&self) {
        self.trace_dropped_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> Vec<MetricEntry> {
        let mut entries = vec![
            MetricEntry {
                name: "dbx_degradation_total".to_string(),
                metric_type: MetricType::Counter,
                description: "Total number of degradation decisions".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Counter(self.degradation_total.load(Ordering::Relaxed)),
            },
            MetricEntry {
                name: "dbx_degradation_level_full".to_string(),
                metric_type: MetricType::Counter,
                description: "Number of full compare decisions".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Counter(self.degradation_level_full.load(Ordering::Relaxed)),
            },
            MetricEntry {
                name: "dbx_degradation_level_sample".to_string(),
                metric_type: MetricType::Counter,
                description: "Number of sample compare decisions".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Counter(self.degradation_level_sample.load(Ordering::Relaxed)),
            },
            MetricEntry {
                name: "dbx_degradation_level_skip".to_string(),
                metric_type: MetricType::Counter,
                description: "Number of skip-with-risk decisions".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Counter(self.degradation_level_skip.load(Ordering::Relaxed)),
            },
            MetricEntry {
                name: "dbx_auto_upgrade_total".to_string(),
                metric_type: MetricType::Counter,
                description: "Number of automatic upgrades in degradation chain".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Counter(self.auto_upgrade_total.load(Ordering::Relaxed)),
            },
            MetricEntry {
                name: "dbx_auto_downgrade_total".to_string(),
                metric_type: MetricType::Counter,
                description: "Number of automatic downgrades in degradation chain".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Counter(self.auto_downgrade_total.load(Ordering::Relaxed)),
            },
            MetricEntry {
                name: "dbx_confidence_gauge".to_string(),
                metric_type: MetricType::Gauge,
                description: "Current confidence score".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Gauge(*self.confidence_gauge.lock().unwrap_or_else(|e| e.into_inner())),
            },
        ];

        // Phase 15.5: OSC and rollback metrics
        if let Ok(h) = self.osc_probe_latency.lock() {
            if !h.is_empty() {
                entries.push(MetricEntry {
                    name: "dbx_osc_probe_latency".to_string(),
                    metric_type: MetricType::Histogram,
                    description: "Distribution of OSC probe latency in milliseconds".to_string(),
                    labels: HashMap::new(),
                    value: MetricValue::Histogram(h.iter().map(|&v| (v, 1u64)).collect()),
                });
            }
        }
        entries.extend(vec![
            MetricEntry {
                name: "dbx_osc_execution_status".to_string(),
                metric_type: MetricType::Gauge,
                description: "Current OSC execution status (0=idle, 1=running, 2=completed, -1=error)".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Gauge(*self.osc_execution_gauge.lock().unwrap_or_else(|e| e.into_inner())),
            },
            MetricEntry {
                name: "dbx_rollback_trigger_total".to_string(),
                metric_type: MetricType::Counter,
                description: "Total number of rollback triggers".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Counter(self.rollback_trigger_count.load(Ordering::Relaxed)),
            },
            MetricEntry {
                name: "dbx_tag_block_total".to_string(),
                metric_type: MetricType::Counter,
                description: "Total number of tag policy blocks".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Counter(self.tag_block_count.load(Ordering::Relaxed)),
            },
            MetricEntry {
                name: "dbx_trace_dropped_total".to_string(),
                metric_type: MetricType::Counter,
                description: "Total number of dropped trace entries".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Counter(self.trace_dropped_count.load(Ordering::Relaxed)),
            },
        ]);

        if let Ok(h) = self.sample_rate_histogram.lock() {
            entries.push(MetricEntry {
                name: "dbx_sample_rate_histogram".to_string(),
                metric_type: MetricType::Histogram,
                description: "Distribution of sampling rates used".to_string(),
                labels: HashMap::new(),
                value: MetricValue::Histogram(h.clone()),
            });
        }

        entries
    }
}

impl Default for DegradationMetrics {
    fn default() -> Self {
        Self::new()
    }
}

pub fn export_prometheus(metrics: &[MetricEntry]) -> String {
    let mut out = String::new();
    for entry in metrics {
        let name = &entry.name;
        let desc = &entry.description;
        let labels = if entry.labels.is_empty() {
            String::new()
        } else {
            let pairs: Vec<String> = entry.labels.iter().map(|(k, v)| format!("{k}=\"{v}\"")).collect();
            format!("{{{}}}", pairs.join(","))
        };

        out.push_str(&format!("# HELP {name} {desc}\n"));
        match &entry.metric_type {
            MetricType::Counter => {
                out.push_str(&format!("# TYPE {name} counter\n"));
                if let MetricValue::Counter(v) = &entry.value {
                    out.push_str(&format!("{name}{labels} {v}\n"));
                }
            }
            MetricType::Gauge => {
                out.push_str(&format!("# TYPE {name} gauge\n"));
                if let MetricValue::Gauge(v) = &entry.value {
                    out.push_str(&format!("{name}{labels} {v}\n"));
                }
            }
            MetricType::Histogram => {
                out.push_str(&format!("# TYPE {name} histogram\n"));
                if let MetricValue::Histogram(buckets) = &entry.value {
                    for (le, count) in buckets {
                        out.push_str(&format!("{name}_bucket{{le=\"{le}\"}} {count}\n"));
                    }
                    let total: u64 = buckets.iter().map(|(_, c)| c).sum();
                    out.push_str(&format!("{name}_count{labels} {total}\n"));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn degradation_metrics_records_levels() {
        let metrics = DegradationMetrics::new();
        metrics.record_degradation("full", 1.0, 1.0);
        metrics.record_degradation("sample", 0.1, 0.8);
        metrics.record_degradation("skip_with_risk", 0.0, 0.0);

        let snapshot = metrics.snapshot();
        let total = snapshot.iter().find(|e| e.name == "dbx_degradation_total").unwrap();
        assert_eq!(total.value, MetricValue::Counter(3));
        let full = snapshot.iter().find(|e| e.name == "dbx_degradation_level_full").unwrap();
        assert_eq!(full.value, MetricValue::Counter(1));
        let sample = snapshot.iter().find(|e| e.name == "dbx_degradation_level_sample").unwrap();
        assert_eq!(sample.value, MetricValue::Counter(1));
        let skip = snapshot.iter().find(|e| e.name == "dbx_degradation_level_skip").unwrap();
        assert_eq!(skip.value, MetricValue::Counter(1));
    }

    #[test]
    fn degradation_metrics_auto_chain_events() {
        let metrics = DegradationMetrics::new();
        metrics.record_auto_upgrade();
        metrics.record_auto_upgrade();
        metrics.record_auto_downgrade();

        let snapshot = metrics.snapshot();
        let up = snapshot.iter().find(|e| e.name == "dbx_auto_upgrade_total").unwrap();
        assert_eq!(up.value, MetricValue::Counter(2));
        let down = snapshot.iter().find(|e| e.name == "dbx_auto_downgrade_total").unwrap();
        assert_eq!(down.value, MetricValue::Counter(1));
    }

    #[test]
    fn degradation_metrics_confidence_gauge() {
        let metrics = DegradationMetrics::new();
        metrics.record_degradation("sample", 0.05, 0.85);

        let snapshot = metrics.snapshot();
        let gauge = snapshot.iter().find(|e| e.name == "dbx_confidence_gauge").unwrap();
        assert_eq!(gauge.value, MetricValue::Gauge(0.85));
    }

    #[test]
    fn export_prometheus_counter() {
        let mut labels = HashMap::new();
        labels.insert("level".to_string(), "full".to_string());
        let entries = vec![MetricEntry {
            name: "test_counter".to_string(),
            metric_type: MetricType::Counter,
            description: "A test counter".to_string(),
            labels,
            value: MetricValue::Counter(42),
        }];
        let output = export_prometheus(&entries);
        assert!(output.contains("# HELP test_counter A test counter"));
        assert!(output.contains("# TYPE test_counter counter"));
        assert!(output.contains("test_counter{level=\"full\"} 42"));
    }

    #[test]
    fn export_prometheus_gauge() {
        let entries = vec![MetricEntry {
            name: "test_gauge".to_string(),
            metric_type: MetricType::Gauge,
            description: "A test gauge".to_string(),
            labels: HashMap::new(),
            value: MetricValue::Gauge(3.125),
        }];
        let output = export_prometheus(&entries);
        assert!(output.contains("# TYPE test_gauge gauge"));
        assert!(output.contains("test_gauge 3.125"));
    }

    #[test]
    fn export_prometheus_histogram() {
        let buckets = vec![(0.5, 10u64), (1.0, 5u64), (1.5, 2u64)];
        let entries = vec![MetricEntry {
            name: "test_histogram".to_string(),
            metric_type: MetricType::Histogram,
            description: "A test histogram".to_string(),
            labels: HashMap::new(),
            value: MetricValue::Histogram(buckets),
        }];
        let output = export_prometheus(&entries);
        assert!(output.contains("# TYPE test_histogram histogram"));
        assert!(output.contains("test_histogram_bucket{le=\"0.5\"} 10"));
        assert!(output.contains("test_histogram_bucket{le=\"1\"} 5"));
        assert!(output.contains("test_histogram_count 17"));
    }
}
