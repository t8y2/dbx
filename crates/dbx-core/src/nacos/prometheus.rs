use std::collections::{HashMap, HashSet};
use std::io;
use std::time::Duration;

use futures::StreamExt;
use prometheus_parse::{Labels, Sample, Scrape, Value};
use sha2::{Digest, Sha256};

use crate::nacos::config::{NacosAdminConfig, NacosImplementation, NacosMetricsMode};
use crate::nacos::types::{
    NacosPrometheusConfigMetrics, NacosPrometheusNamingMetrics, NacosPrometheusResourceMetrics,
    NacosPrometheusSnapshot, NacosPrometheusSource, NacosPrometheusTrafficMetrics,
};

const SCRAPE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SCRAPE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn endpoint_candidates(cfg: &NacosAdminConfig) -> Result<Vec<String>, String> {
    match cfg.metrics_mode {
        NacosMetricsMode::Disabled => return Ok(Vec::new()),
        NacosMetricsMode::Custom => return Ok(vec![cfg.metrics_url.clone()]),
        NacosMetricsMode::Auto => {}
    }

    let base = cfg.server_addr.trim_end_matches('/');
    let context = cfg.context_path.trim_end_matches('/');
    let raw = match cfg.implementation.as_ref().unwrap_or(&NacosImplementation::Nacos) {
        NacosImplementation::Nacos => vec![
            format!("{base}{context}/actuator/prometheus"),
            format!("{base}/nacos/actuator/prometheus"),
            format!("{base}/actuator/prometheus"),
        ],
        NacosImplementation::RNacos => {
            vec![format!("{base}/metrics"), format!("{base}{context}/metrics"), format!("{base}/rnacos/metrics")]
        }
    };

    let mut seen = HashSet::new();
    raw.into_iter()
        .map(|candidate| {
            reqwest::Url::parse(&candidate)
                .map(|url| url.to_string())
                .map_err(|error| format!("Nacos Prometheus metrics URL is invalid: {error}"))
        })
        .filter(|candidate| match candidate {
            Ok(value) => seen.insert(value.clone()),
            Err(_) => true,
        })
        .collect()
}

pub(crate) async fn scrape(
    client: &reqwest::Client,
    cfg: &NacosAdminConfig,
) -> Result<Option<NacosPrometheusSnapshot>, String> {
    scrape_with_timeout(client, cfg, SCRAPE_TIMEOUT).await
}

async fn scrape_with_timeout(
    client: &reqwest::Client,
    cfg: &NacosAdminConfig,
    timeout: Duration,
) -> Result<Option<NacosPrometheusSnapshot>, String> {
    let candidates = endpoint_candidates(cfg)?;
    if candidates.is_empty() {
        return Ok(None);
    }
    let candidate_summary =
        candidates.iter().map(|candidate| redact_endpoint(candidate)).collect::<Vec<_>>().join(", ");

    tokio::time::timeout(timeout, async {
        let mut errors = Vec::new();
        for endpoint in candidates {
            match scrape_endpoint(client, cfg, &endpoint).await {
                Ok(snapshot) => return Ok(Some(snapshot)),
                Err(error) => errors.push(format!("{}: {error}", redact_endpoint(&endpoint))),
            }
        }
        Err(format!("Prometheus metrics unavailable: {}", errors.join("; ")))
    })
    .await
    .map_err(|_| {
        format!("Prometheus metrics unavailable: scrape timed out after {timeout:?} while trying {candidate_summary}")
    })?
}

async fn scrape_endpoint(
    client: &reqwest::Client,
    cfg: &NacosAdminConfig,
    endpoint: &str,
) -> Result<NacosPrometheusSnapshot, String> {
    let response = client
        .get(endpoint)
        .timeout(SCRAPE_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("request failed: {}", error.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("returned HTTP {}", response.status()));
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("failed to read response: {}", error.without_url()))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_SCRAPE_BYTES {
            return Err(format!("response exceeds {MAX_SCRAPE_BYTES} bytes"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "response is not valid UTF-8".to_string())?;
    parse_scrape(&body, cfg.implementation.as_ref().unwrap_or(&NacosImplementation::Nacos), endpoint)
}

pub(crate) fn parse_scrape(
    body: &str,
    implementation: &NacosImplementation,
    endpoint: &str,
) -> Result<NacosPrometheusSnapshot, String> {
    let lines = body.lines().map(|line| Ok::<_, io::Error>(line.to_string()));
    let scrape = Scrape::parse(lines).map_err(|error| format!("failed to parse metrics: {error}"))?;
    if scrape.samples.is_empty() {
        return Err("response contains no Prometheus samples".to_string());
    }
    let source = NacosPrometheusSource {
        kind: match implementation {
            NacosImplementation::Nacos => "nacos",
            NacosImplementation::RNacos => "rnacos",
        }
        .to_string(),
        endpoint: redact_endpoint(endpoint),
        fingerprint: Some(endpoint_fingerprint(endpoint)),
    };
    Ok(match implementation {
        NacosImplementation::Nacos => normalize_nacos(source, &scrape.samples),
        NacosImplementation::RNacos => normalize_rnacos(source, &scrape.samples),
    })
}

fn normalize_nacos(source: NacosPrometheusSource, samples: &[Sample]) -> NacosPrometheusSnapshot {
    let heap_used = scalar_sum_filtered(samples, "jvm_memory_used_bytes", |labels| label_eq(labels, "area", "heap"));
    let heap_max = scalar_sum_filtered(samples, "jvm_memory_max_bytes", |labels| label_eq(labels, "area", "heap"));
    let memory_ratio = ratio(heap_used, heap_max);
    let http_count = scalar_sum(samples, "http_server_requests_seconds_count");
    let grpc_count = scalar_sum_any(samples, &["grpc_server_requests_seconds_count", "grpc_server_requests_count"]);

    NacosPrometheusSnapshot {
        source,
        resource: NacosPrometheusResourceMetrics {
            cpu_ratio: scalar_max_any(samples, &["system_cpu_usage", "process_cpu_usage"]).and_then(normalize_ratio),
            memory_ratio,
            memory_used_bytes: heap_used,
            memory_max_bytes: heap_max,
            rss_bytes: None,
            vms_bytes: None,
            system_total_memory_bytes: None,
            load_1m: scalar_max(samples, "system_load_average_1m"),
            jvm_daemon_threads: scalar_sum(samples, "jvm_threads_daemon"),
            gc_pause_count: scalar_sum_any(samples, &["jvm_gc_pause_seconds_count", "jvm_gc_pause_count"]),
        },
        traffic: NacosPrometheusTrafficMetrics {
            http_requests_total: http_count,
            grpc_requests_total: grpc_count,
            http_errors_total: scalar_sum_filtered(samples, "http_server_requests_seconds_count", is_error_labels),
            grpc_errors_total: scalar_sum_filtered_any(
                samples,
                &["grpc_server_requests_seconds_count", "grpc_server_requests_count"],
                is_grpc_error_labels,
            ),
            http_duration_seconds_total: scalar_sum(samples, "http_server_requests_seconds_sum"),
            http_duration_count: http_count,
            grpc_duration_seconds_total: scalar_sum_any(
                samples,
                &["grpc_server_requests_seconds_sum", "grpc_server_requests_sum"],
            ),
            grpc_duration_count: grpc_count,
            http_p50_ms: quantile_ms(samples, "http_server_requests_seconds", 0.5, 1_000.0),
            http_p95_ms: quantile_ms(samples, "http_server_requests_seconds", 0.95, 1_000.0),
            http_p99_ms: quantile_ms(samples, "http_server_requests_seconds", 0.99, 1_000.0),
            grpc_p50_ms: quantile_ms_any(
                samples,
                &["grpc_server_requests_seconds", "grpc_server_requests"],
                0.5,
                1_000.0,
            ),
            grpc_p95_ms: quantile_ms_any(
                samples,
                &["grpc_server_requests_seconds", "grpc_server_requests"],
                0.95,
                1_000.0,
            ),
            grpc_p99_ms: quantile_ms_any(
                samples,
                &["grpc_server_requests_seconds", "grpc_server_requests"],
                0.99,
                1_000.0,
            ),
            executor_pool_size: scalar_max_filtered(samples, "grpc_server_executor", |labels| {
                label_in(labels, "name", &["poolSize", "pool_size"])
            }),
            executor_active_count: scalar_max_filtered(samples, "grpc_server_executor", |labels| {
                label_in(labels, "name", &["activeCount", "active_count"])
            }),
            executor_queued_tasks: scalar_max_filtered(samples, "grpc_server_executor", |labels| {
                label_in(labels, "name", &["queuedTasks", "queueSize", "queued_tasks"])
            }),
        },
        config: NacosPrometheusConfigMetrics {
            config_count: monitor(samples, "config", &["configCount"]),
            get_config_total: monitor(samples, "config", &["getConfig", "getConfigCount"]),
            publish_total: monitor(samples, "config", &["publish", "publishCount"]),
            long_polling: monitor(samples, "config", &["longPolling"]),
            listener_clients: None,
            listener_keys: None,
            notify_tasks: monitor(samples, "config", &["notifyTask"]),
            notify_client_tasks: monitor(samples, "config", &["notifyClientTask"]),
            dump_tasks: monitor(samples, "config", &["dumpTask"]),
            subscriber_count: scalar_sum(samples, "nacos_config_subscriber"),
        },
        naming: NacosPrometheusNamingMetrics {
            service_count: monitor(samples, "naming", &["serviceCount"]),
            instance_count: monitor(samples, "naming", &["ipCount", "instanceCount"]),
            subscriber_count: monitor(samples, "naming", &["subscriberCount"])
                .or_else(|| scalar_sum(samples, "nacos_naming_subscriber")),
            connection_count: monitor(samples, "core", &["longConnection"]),
            total_push: monitor(samples, "naming", &["totalPush"]),
            failed_push: monitor(samples, "naming", &["failedPush"]),
            empty_push: monitor(samples, "naming", &["emptyPush"]),
            push_pending_tasks: monitor(
                samples,
                "naming",
                &["pushPendingTaskCount", "pushPendingTask", "pushPendingTasks"],
            ),
            avg_push_cost_ms: monitor(samples, "naming", &["avgPushCost"]),
            max_push_cost_ms: monitor(samples, "naming", &["maxPushCost"]),
            leader_status: monitor(samples, "naming", &["leaderStatus"]),
        },
    }
}

fn normalize_rnacos(source: NacosPrometheusSource, samples: &[Sample]) -> NacosPrometheusSnapshot {
    let mib = 1024.0 * 1024.0;
    let http_count = scalar_sum(samples, "http_request_total_count");
    let grpc_count = scalar_sum(samples, "grpc_request_total_count");
    let rss_mib = scalar_sum(samples, "app_rss_memory");
    let system_memory_mib = scalar_sum(samples, "sys_total_memory");
    NacosPrometheusSnapshot {
        source,
        resource: NacosPrometheusResourceMetrics {
            cpu_ratio: scalar_max(samples, "app_cpu_usage").and_then(normalize_percentage),
            memory_ratio: scalar_max(samples, "app_memory_usage")
                .and_then(normalize_percentage)
                .or_else(|| ratio(rss_mib, system_memory_mib)),
            memory_used_bytes: rss_mib.map(|value| value * mib),
            memory_max_bytes: system_memory_mib.map(|value| value * mib),
            rss_bytes: rss_mib.map(|value| value * mib),
            vms_bytes: scalar_sum(samples, "app_vms_memory").map(|value| value * mib),
            system_total_memory_bytes: system_memory_mib.map(|value| value * mib),
            load_1m: None,
            jvm_daemon_threads: None,
            gc_pause_count: None,
        },
        traffic: NacosPrometheusTrafficMetrics {
            http_requests_total: http_count,
            grpc_requests_total: grpc_count,
            http_errors_total: None,
            grpc_errors_total: None,
            http_duration_seconds_total: scalar_sum(samples, "http_request_handle_rt_histogram_sum")
                .or_else(|| scalar_sum(samples, "http_request_handle_rt_summary_sum"))
                .map(|value| value / 1_000.0),
            http_duration_count: scalar_sum(samples, "http_request_handle_rt_histogram_count")
                .or_else(|| scalar_sum(samples, "http_request_handle_rt_summary_count"))
                .or(http_count),
            grpc_duration_seconds_total: scalar_sum(samples, "grpc_request_handle_rt_histogram_sum")
                .or_else(|| scalar_sum(samples, "grpc_request_handle_rt_summary_sum"))
                .map(|value| value / 1_000.0),
            grpc_duration_count: scalar_sum(samples, "grpc_request_handle_rt_histogram_count")
                .or_else(|| scalar_sum(samples, "grpc_request_handle_rt_summary_count"))
                .or(grpc_count),
            http_p50_ms: quantile_ms_any(
                samples,
                &["http_request_handle_rt_summary", "http_request_handle_rt_histogram"],
                0.5,
                1.0,
            ),
            http_p95_ms: quantile_ms_any(
                samples,
                &["http_request_handle_rt_summary", "http_request_handle_rt_histogram"],
                0.95,
                1.0,
            ),
            http_p99_ms: quantile_ms_any(
                samples,
                &["http_request_handle_rt_summary", "http_request_handle_rt_histogram"],
                0.99,
                1.0,
            ),
            grpc_p50_ms: quantile_ms_any(
                samples,
                &["grpc_request_handle_rt_summary", "grpc_request_handle_rt_histogram"],
                0.5,
                1.0,
            ),
            grpc_p95_ms: quantile_ms_any(
                samples,
                &["grpc_request_handle_rt_summary", "grpc_request_handle_rt_histogram"],
                0.95,
                1.0,
            ),
            grpc_p99_ms: quantile_ms_any(
                samples,
                &["grpc_request_handle_rt_summary", "grpc_request_handle_rt_histogram"],
                0.99,
                1.0,
            ),
            executor_pool_size: None,
            executor_active_count: None,
            executor_queued_tasks: None,
        },
        config: NacosPrometheusConfigMetrics {
            config_count: scalar_sum(samples, "config_data_size")
                .or_else(|| scalar_sum(samples, "config_index_config_size")),
            get_config_total: None,
            publish_total: None,
            long_polling: None,
            listener_clients: scalar_sum(samples, "config_listener_client_size"),
            listener_keys: scalar_sum(samples, "config_listener_key_size"),
            notify_tasks: None,
            notify_client_tasks: None,
            dump_tasks: None,
            subscriber_count: scalar_sum(samples, "config_subscriber_client_size")
                .or_else(|| scalar_sum(samples, "config_subscriber_client_value_size")),
        },
        naming: NacosPrometheusNamingMetrics {
            service_count: scalar_sum(samples, "naming_service_size")
                .or_else(|| scalar_sum(samples, "naming_index_service_size")),
            instance_count: scalar_sum(samples, "naming_instance_size"),
            subscriber_count: scalar_sum(samples, "naming_subscriber_client_size")
                .or_else(|| scalar_sum(samples, "naming_subscriber_client_value_size")),
            connection_count: scalar_sum(samples, "grpc_conn_size"),
            total_push: None,
            failed_push: None,
            empty_push: None,
            push_pending_tasks: None,
            avg_push_cost_ms: None,
            max_push_cost_ms: None,
            leader_status: None,
        },
    }
}

fn scalar_value(sample: &Sample) -> Option<f64> {
    let value = match sample.value {
        Value::Counter(value) | Value::Gauge(value) | Value::Untyped(value) => value,
        Value::Histogram(_) | Value::Summary(_) => return None,
    };
    value.is_finite().then_some(value)
}

fn scalar_sum(samples: &[Sample], metric: &str) -> Option<f64> {
    scalar_sum_filtered(samples, metric, |_| true)
}

fn scalar_sum_any(samples: &[Sample], metrics: &[&str]) -> Option<f64> {
    metrics.iter().find_map(|metric| scalar_sum(samples, metric))
}

fn scalar_sum_filtered(samples: &[Sample], metric: &str, predicate: impl Fn(&Labels) -> bool) -> Option<f64> {
    let values =
        samples.iter().filter(|sample| sample.metric == metric && predicate(&sample.labels)).filter_map(scalar_value);
    sum_non_empty(values)
}

fn scalar_sum_filtered_any(
    samples: &[Sample],
    metrics: &[&str],
    predicate: impl Fn(&Labels) -> bool + Copy,
) -> Option<f64> {
    metrics.iter().find_map(|metric| scalar_sum_filtered(samples, metric, predicate))
}

fn scalar_max(samples: &[Sample], metric: &str) -> Option<f64> {
    scalar_max_filtered(samples, metric, |_| true)
}

fn scalar_max_any(samples: &[Sample], metrics: &[&str]) -> Option<f64> {
    metrics.iter().find_map(|metric| scalar_max(samples, metric))
}

fn scalar_max_filtered(samples: &[Sample], metric: &str, predicate: impl Fn(&Labels) -> bool) -> Option<f64> {
    samples
        .iter()
        .filter(|sample| sample.metric == metric && predicate(&sample.labels))
        .filter_map(scalar_value)
        .reduce(f64::max)
}

fn sum_non_empty(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut found = false;
    let sum = values.fold(0.0, |sum, value| {
        found = true;
        sum + value
    });
    found.then_some(sum)
}

fn monitor(samples: &[Sample], module: &str, names: &[&str]) -> Option<f64> {
    names.iter().find_map(|name| {
        scalar_sum_filtered(samples, "nacos_monitor", |labels| {
            label_eq(labels, "module", module) && label_eq(labels, "name", name)
        })
    })
}

fn label_eq(labels: &Labels, key: &str, value: &str) -> bool {
    labels.get(key).is_some_and(|current| current.eq_ignore_ascii_case(value))
}

fn label_in(labels: &Labels, key: &str, values: &[&str]) -> bool {
    values.iter().any(|value| label_eq(labels, key, value))
}

fn is_error_labels(labels: &Labels) -> bool {
    if let Some(status) = labels.get("status").or_else(|| labels.get("code")) {
        return !status.starts_with('2') && status != "0";
    }
    labels.get("outcome").is_some_and(|outcome| !matches!(outcome.to_ascii_uppercase().as_str(), "SUCCESS" | "UNKNOWN"))
}

fn is_grpc_error_labels(labels: &Labels) -> bool {
    if labels.get("success").is_some_and(|value| value.eq_ignore_ascii_case("false")) {
        return true;
    }
    labels
        .get("errorCode")
        .or_else(|| labels.get("error_code"))
        .or_else(|| labels.get("code"))
        .is_some_and(|value| value != "0" && !value.eq_ignore_ascii_case("OK"))
        || labels.get("result").is_some_and(|value| !matches!(value.to_ascii_uppercase().as_str(), "SUCCESS" | "OK"))
}

fn ratio(numerator: Option<f64>, denominator: Option<f64>) -> Option<f64> {
    match (numerator, denominator) {
        (Some(numerator), Some(denominator)) if denominator > 0.0 => normalize_ratio(numerator / denominator),
        _ => None,
    }
}

fn normalize_ratio(value: f64) -> Option<f64> {
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    Some((if value > 1.0 { value / 100.0 } else { value }).clamp(0.0, 1.0))
}

fn normalize_percentage(value: f64) -> Option<f64> {
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    Some((value / 100.0).clamp(0.0, 1.0))
}

fn endpoint_fingerprint(endpoint: &str) -> String {
    format!("{:x}", Sha256::digest(endpoint.as_bytes()))
}

fn redact_endpoint(endpoint: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(endpoint) else {
        return endpoint.split_once('?').map_or(endpoint, |(base, _)| base).to_string();
    };
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn quantile_ms(samples: &[Sample], metric: &str, quantile: f64, multiplier: f64) -> Option<f64> {
    let mut histogram_buckets = HashMap::<u64, (f64, f64)>::new();
    let mut summary_quantiles = Vec::new();
    for sample in samples.iter().filter(|sample| sample.metric == metric) {
        match &sample.value {
            Value::Histogram(values) => {
                for value in values {
                    if value.less_than.is_nan() || !value.count.is_finite() {
                        continue;
                    }
                    histogram_buckets
                        .entry(value.less_than.to_bits())
                        .and_modify(|(_, count)| *count += value.count)
                        .or_insert((value.less_than, value.count));
                }
            }
            Value::Summary(values) => summary_quantiles.push(values),
            _ => {}
        }
    }

    if !histogram_buckets.is_empty() {
        return histogram_quantile(histogram_buckets.into_values(), quantile).map(|value| value * multiplier);
    }
    // Prometheus summaries are already-calculated client-side quantiles and
    // cannot be aggregated across label sets without changing their meaning.
    let [values] = summary_quantiles.as_slice() else {
        return None;
    };
    nearest_quantile(values.iter().map(|value| (value.quantile, value.count)), quantile).map(|value| value * multiplier)
}

fn quantile_ms_any(samples: &[Sample], metrics: &[&str], quantile: f64, multiplier: f64) -> Option<f64> {
    metrics.iter().find_map(|metric| quantile_ms(samples, metric, quantile, multiplier))
}

fn nearest_quantile(values: impl Iterator<Item = (f64, f64)>, target: f64) -> Option<f64> {
    values
        .filter(|(quantile, value)| quantile.is_finite() && value.is_finite())
        .min_by(|left, right| {
            (left.0 - target).abs().partial_cmp(&(right.0 - target).abs()).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(_, value)| value)
}

fn histogram_quantile(values: impl Iterator<Item = (f64, f64)>, target: f64) -> Option<f64> {
    let mut buckets =
        values.filter(|(boundary, count)| !boundary.is_nan() && count.is_finite() && *count >= 0.0).collect::<Vec<_>>();
    buckets.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut previous_count = 0.0;
    for (_, count) in &mut buckets {
        *count = count.max(previous_count);
        previous_count = *count;
    }
    let total = buckets.last()?.1;
    if total <= 0.0 {
        return None;
    }
    let threshold = total * target.clamp(0.0, 1.0);
    let index = buckets.iter().position(|(_, count)| *count >= threshold)?;
    let (upper_bound, upper_count) = buckets[index];
    if upper_bound.is_infinite() {
        return (index > 0).then_some(buckets[index - 1].0).filter(|boundary| boundary.is_finite());
    }
    let (lower_bound, lower_count) = if index == 0 { (0.0, 0.0) } else { buckets[index - 1] };
    if upper_count <= lower_count {
        return Some(upper_bound);
    }
    Some(lower_bound + (upper_bound - lower_bound) * ((threshold - lower_count) / (upper_count - lower_count)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_and_deduplicates_nacos_endpoints() {
        let cfg = test_config(NacosImplementation::Nacos, "http://127.0.0.1:8818", "/nacos");
        assert_eq!(
            endpoint_candidates(&cfg).unwrap(),
            vec!["http://127.0.0.1:8818/nacos/actuator/prometheus", "http://127.0.0.1:8818/actuator/prometheus",]
        );
    }

    #[test]
    fn derives_rnacos_endpoints() {
        let cfg = test_config(NacosImplementation::RNacos, "http://127.0.0.1:3848", "/nacos");
        assert_eq!(
            endpoint_candidates(&cfg).unwrap(),
            vec![
                "http://127.0.0.1:3848/metrics",
                "http://127.0.0.1:3848/nacos/metrics",
                "http://127.0.0.1:3848/rnacos/metrics",
            ]
        );
    }

    #[test]
    fn disabled_mode_skips_scraping() {
        let mut cfg = test_config(NacosImplementation::Nacos, "http://127.0.0.1:8818", "/nacos");
        cfg.metrics_mode = NacosMetricsMode::Disabled;
        assert!(endpoint_candidates(&cfg).unwrap().is_empty());
    }

    #[test]
    fn parses_nacos_metrics_and_labels() {
        let body = r#"
# TYPE system_cpu_usage gauge
system_cpu_usage 0.25
# TYPE jvm_memory_used_bytes gauge
jvm_memory_used_bytes{area="heap",id="a"} 100
jvm_memory_used_bytes{area="heap",id="b"} 50
# TYPE jvm_memory_max_bytes gauge
jvm_memory_max_bytes{area="heap",id="a"} 400
# TYPE http_server_requests_seconds counter
http_server_requests_seconds_count{status="200"} 90
http_server_requests_seconds_count{status="500"} 10
http_server_requests_seconds_sum 25
# TYPE nacos_monitor gauge
nacos_monitor{module="naming",name="serviceCount"} 12
nacos_monitor{module="core",name="longConnection"} 8
nacos_monitor{module="naming",name="pushPendingTaskCount"} 3
# TYPE nacos_naming_subscriber gauge
nacos_naming_subscriber{version="v1"} 2
nacos_naming_subscriber{version="v2"} 4
"#;
        let parsed = parse_scrape(body, &NacosImplementation::Nacos, "http://localhost/metrics").unwrap();
        assert_eq!(parsed.resource.cpu_ratio, Some(0.25));
        assert_eq!(parsed.resource.memory_used_bytes, Some(150.0));
        assert_eq!(parsed.resource.memory_ratio, Some(0.375));
        assert_eq!(parsed.traffic.http_requests_total, Some(100.0));
        assert_eq!(parsed.traffic.http_errors_total, Some(10.0));
        assert_eq!(parsed.naming.service_count, Some(12.0));
        assert_eq!(parsed.naming.connection_count, Some(8.0));
        assert_eq!(parsed.naming.subscriber_count, Some(6.0));
        assert_eq!(parsed.naming.push_pending_tasks, Some(3.0));
    }

    #[test]
    fn aggregates_histogram_buckets_across_label_sets() {
        let body = r#"
# TYPE http_server_requests_seconds histogram
http_server_requests_seconds_bucket{route="a",le="1"} 50
http_server_requests_seconds_bucket{route="a",le="10"} 50
http_server_requests_seconds_bucket{route="a",le="+Inf"} 50
http_server_requests_seconds_sum{route="a"} 25
http_server_requests_seconds_count{route="a"} 50
http_server_requests_seconds_bucket{route="b",le="1"} 0
http_server_requests_seconds_bucket{route="b",le="10"} 50
http_server_requests_seconds_bucket{route="b",le="+Inf"} 50
http_server_requests_seconds_sum{route="b"} 250
http_server_requests_seconds_count{route="b"} 50
"#;
        let parsed = parse_scrape(body, &NacosImplementation::Nacos, "http://localhost/metrics").unwrap();
        assert_eq!(parsed.traffic.http_p50_ms, Some(1_000.0));
    }

    #[test]
    fn redacts_endpoint_query_from_snapshot_source() {
        let parsed = parse_scrape(
            "# TYPE system_cpu_usage gauge\nsystem_cpu_usage 0.25\n",
            &NacosImplementation::Nacos,
            "http://localhost/metrics?token=secret&node=a",
        )
        .unwrap();
        let other_source = parse_scrape(
            "# TYPE system_cpu_usage gauge\nsystem_cpu_usage 0.25\n",
            &NacosImplementation::Nacos,
            "http://localhost/metrics?token=secret&node=b",
        )
        .unwrap();
        assert_eq!(parsed.source.endpoint, "http://localhost/metrics");
        assert_ne!(parsed.source.fingerprint, other_source.source.fingerprint);
        assert!(!parsed.source.fingerprint.as_deref().unwrap().contains("secret"));
    }

    #[test]
    fn parses_rnacos_units_counts_and_summary() {
        let body = r#"
# TYPE app_cpu_usage gauge
app_cpu_usage 12.5
# TYPE app_rss_memory gauge
app_rss_memory 10
# TYPE sys_total_memory gauge
sys_total_memory 100
# TYPE naming_service_size gauge
naming_service_size 4
# TYPE grpc_conn_size gauge
grpc_conn_size 3
# TYPE http_request_total_count counter
http_request_total_count 20
# TYPE http_request_handle_rt_summary summary
http_request_handle_rt_summary{quantile="0.5"} 5
http_request_handle_rt_summary{quantile="0.95"} 15
http_request_handle_rt_summary_sum 100
http_request_handle_rt_summary_count 20
"#;
        let parsed = parse_scrape(body, &NacosImplementation::RNacos, "http://localhost/metrics").unwrap();
        assert_eq!(parsed.resource.cpu_ratio, Some(0.125));
        assert_eq!(parsed.resource.rss_bytes, Some(10.0 * 1024.0 * 1024.0));
        assert_eq!(parsed.resource.memory_ratio, Some(0.1));
        assert_eq!(parsed.naming.service_count, Some(4.0));
        assert_eq!(parsed.naming.connection_count, Some(3.0));
        assert_eq!(parsed.traffic.http_p95_ms, Some(15.0));
        assert_eq!(parsed.traffic.http_duration_seconds_total, Some(0.1));
    }

    #[test]
    fn converts_low_rnacos_percentages_to_ratios() {
        let body = r#"
# TYPE app_cpu_usage gauge
app_cpu_usage 0.5
# TYPE app_memory_usage gauge
app_memory_usage 1
"#;
        let parsed = parse_scrape(body, &NacosImplementation::RNacos, "http://localhost/metrics").unwrap();
        assert_eq!(parsed.resource.cpu_ratio, Some(0.005));
        assert_eq!(parsed.resource.memory_ratio, Some(0.01));
    }

    #[test]
    fn rejects_responses_without_samples() {
        assert!(parse_scrape("<html>not metrics</html>", &NacosImplementation::Nacos, "http://localhost/metrics")
            .unwrap_err()
            .contains("no Prometheus samples"));
    }

    #[tokio::test]
    async fn falls_back_after_a_missing_auto_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0_u8; 2048];
                let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await.unwrap();
                if index == 0 {
                    let body = "not found";
                    let response = format!(
                        "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    tokio::io::AsyncWriteExt::write_all(&mut socket, response.as_bytes()).await.unwrap();
                } else {
                    let body = "# TYPE system_cpu_usage gauge\nsystem_cpu_usage 0.4\n";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    tokio::io::AsyncWriteExt::write_all(&mut socket, response.as_bytes()).await.unwrap();
                }
            }
        });
        let cfg = test_config(NacosImplementation::Nacos, &format!("http://{address}"), "");
        let client = reqwest::Client::new();
        let parsed = scrape(&client, &cfg).await.unwrap().unwrap();
        assert_eq!(parsed.resource.cpu_ratio, Some(0.4));
        assert!(parsed.source.endpoint.ends_with("/nacos/actuator/prometheus"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_oversized_scrapes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 2048];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await.unwrap();
            let body = vec![b'x'; MAX_SCRAPE_BYTES + 1];
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes()).await;
            let _ = tokio::io::AsyncWriteExt::write_all(&mut socket, &body).await;
        });
        let mut cfg = test_config(NacosImplementation::Nacos, "http://127.0.0.1:8848", "");
        cfg.metrics_mode = NacosMetricsMode::Custom;
        cfg.metrics_url = format!("http://{address}/metrics");
        let error = scrape(&reqwest::Client::new(), &cfg).await.unwrap_err();
        assert!(error.contains("exceeds"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn redacts_endpoint_query_from_scrape_errors() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 2048];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await.unwrap();
            let response = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            tokio::io::AsyncWriteExt::write_all(&mut socket, response.as_bytes()).await.unwrap();
        });
        let mut cfg = test_config(NacosImplementation::Nacos, "http://127.0.0.1:8848", "");
        cfg.metrics_mode = NacosMetricsMode::Custom;
        cfg.metrics_url = format!("http://{address}/metrics?token=secret");
        let error = scrape(&reqwest::Client::new(), &cfg).await.unwrap_err();
        assert!(error.contains(&format!("http://{address}/metrics")));
        assert!(!error.contains("secret"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn times_out_without_exposing_endpoint_query() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 2048];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await.unwrap();
            std::future::pending::<()>().await;
        });
        let mut cfg = test_config(NacosImplementation::Nacos, "http://127.0.0.1:8848", "");
        cfg.metrics_mode = NacosMetricsMode::Custom;
        cfg.metrics_url = format!("http://{address}/metrics?token=secret");
        let error = scrape_with_timeout(&reqwest::Client::new(), &cfg, Duration::from_millis(25)).await.unwrap_err();
        assert!(error.contains("timed out"));
        assert!(error.contains(&format!("http://{address}/metrics")));
        assert!(!error.contains("secret"));
        server.abort();
    }

    fn test_config(implementation: NacosImplementation, server_addr: &str, context_path: &str) -> NacosAdminConfig {
        NacosAdminConfig {
            implementation: Some(implementation),
            version_mode: None,
            server_addr: server_addr.to_string(),
            display_server_addr: server_addr.to_string(),
            namespace: String::new(),
            context_path: context_path.to_string(),
            rnacos_console_addr: String::new(),
            rnacos_history_enabled: None,
            rnacos_console_auth: Default::default(),
            auth: Default::default(),
            tls_skip_verify: false,
            metrics_mode: NacosMetricsMode::Auto,
            metrics_url: String::new(),
            page_size: 20,
            connect_override: None,
        }
    }
}
