use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
use rdkafka::bindings as rdsys;
use rdkafka::client::DefaultClientContext;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{BaseConsumer, Consumer, StreamConsumer};
use rdkafka::error::KafkaError;
use rdkafka::message::{Header, Headers, Message, Timestamp};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::{Offset, TopicPartitionList};
use serde::{Deserialize, Serialize};
use std::ffi::CStr;
use std::ptr;

use crate::models::connection::ConnectionConfig;

use super::{connection_timeout, with_connection_timeout};

const DEFAULT_KAFKA_PORT: u16 = 9092;

pub struct KafkaConnectionHandle {
    admin: Arc<AdminClient<DefaultClientContext>>,
    config: ConnectionConfig,
}

impl KafkaConnectionHandle {
    pub(crate) fn connection_config(&self) -> &ConnectionConfig {
        &self.config
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaTopicSummary {
    pub name: String,
    pub partition_count: i32,
    pub internal: bool,
    pub message_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaTopicDetail {
    pub name: String,
    pub partition_count: i32,
    pub replication_factor: i32,
    pub partitions: Vec<KafkaPartitionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaPartitionInfo {
    pub partition: i32,
    pub leader: i32,
    pub replicas: Vec<i32>,
    pub isr: Vec<i32>,
    pub offset_begin: Option<i64>,
    pub offset_end: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaMessageRecord {
    pub partition: i32,
    pub offset: i64,
    pub timestamp: i64,
    pub key: Option<KafkaPayload>,
    pub value: Option<KafkaPayload>,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaPayload {
    pub encoding: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaProduceResult {
    pub topic: String,
    pub partition: i32,
    pub offset: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KafkaFetchOffset {
    Earliest,
    Latest,
    Offset(i64),
}

/// API-facing offset selector (matches frontend `KafkaStartOffset`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum KafkaStartOffset {
    Named(String),
    Offset { offset: i64 },
}

impl KafkaStartOffset {
    pub fn to_fetch_offset(&self) -> Result<KafkaFetchOffset, String> {
        match self {
            KafkaStartOffset::Named(value) if value.eq_ignore_ascii_case("earliest") => Ok(KafkaFetchOffset::Earliest),
            KafkaStartOffset::Named(value) if value.eq_ignore_ascii_case("latest") => Ok(KafkaFetchOffset::Latest),
            KafkaStartOffset::Offset { offset } => Ok(KafkaFetchOffset::Offset(*offset)),
            KafkaStartOffset::Named(value) => Err(format!("Unsupported Kafka start offset: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaBrokerInfo {
    pub id: i32,
    pub host: String,
    pub port: i32,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaAclEntry {
    pub resource_type: String,
    pub resource_name: String,
    pub pattern_type: String,
    pub principal: String,
    pub host: String,
    pub operation: String,
    pub permission: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaConsumerGroupSummary {
    pub group_id: String,
    pub state: String,
    pub protocol_type: String,
    pub member_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaConsumerGroupPartitionLag {
    pub topic: String,
    pub partition: i32,
    pub committed_offset: i64,
    pub end_offset: i64,
    pub lag: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaConsumerGroupDetail {
    pub group_id: String,
    pub state: String,
    pub protocol_type: String,
    pub member_count: i32,
    pub partitions: Vec<KafkaConsumerGroupPartitionLag>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaCreateTopicRequest {
    pub name: String,
    pub partitions: i32,
    pub replication_factor: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaCreateTopicResult {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaDeleteTopicResult {
    pub name: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaProduceRequest {
    pub topic: String,
    #[serde(default)]
    pub key: Option<String>,
    pub value: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub partition: Option<i32>,
}

pub async fn connect(config: &ConnectionConfig) -> Result<KafkaConnectionHandle, String> {
    let client_config = build_client_config(config)?;
    let admin = tokio::task::spawn_blocking(move || client_config.create())
        .await
        .map_err(|e| format!("Kafka connect task failed: {e}"))?
        .map_err(|e| format!("Kafka admin client creation failed: {e}"))?;

    Ok(KafkaConnectionHandle { admin: Arc::new(admin), config: config.clone() })
}

pub async fn test_connection(handle: &KafkaConnectionHandle) -> Result<(), String> {
    let admin = Arc::clone(&handle.admin);
    let timeout = Duration::from_secs(handle.config.effective_connect_timeout_secs());
    with_connection_timeout("Kafka", connection_timeout(), async move {
        tokio::task::spawn_blocking(move || admin.inner().fetch_metadata(None, timeout))
            .await
            .map_err(|e| format!("Kafka metadata task failed: {e}"))?
            .map(|_| ())
            .map_err(|e| format!("Kafka metadata fetch failed: {e}"))
    })
    .await
}

pub async fn list_topics(
    handle: &KafkaConnectionHandle,
    prefix: Option<&str>,
    limit: usize,
) -> Result<Vec<KafkaTopicSummary>, String> {
    let metadata = fetch_cluster_metadata(handle).await?;
    let search = prefix.map(str::trim).filter(|value| !value.is_empty());

    let mut topics: Vec<KafkaTopicSummary> = metadata
        .topics()
        .iter()
        .filter_map(|topic| {
            let name = topic.name().to_string();
            if name.is_empty() {
                return None;
            }
            if let Some(search) = search {
                if !topic_matches_search(&name, search) {
                    return None;
                }
            }
            Some(KafkaTopicSummary {
                name,
                partition_count: topic.partitions().len() as i32,
                internal: topic.name().starts_with("__"),
                message_count: None,
            })
        })
        .collect();

    topics.sort_by(|left, right| left.name.cmp(&right.name));
    if limit > 0 {
        topics.truncate(limit);
    }
    Ok(topics)
}

pub async fn fetch_cluster_metadata_for_handle(
    handle: &KafkaConnectionHandle,
) -> Result<rdkafka::metadata::Metadata, String> {
    fetch_cluster_metadata(handle).await
}

pub fn count_topics_messages(
    config: &ConnectionConfig,
    topic_partitions: Vec<(String, Vec<i32>)>,
    timeout: Duration,
    mut progress: impl FnMut(&str, Option<i64>) -> bool,
) -> Result<(), String> {
    if topic_partitions.is_empty() {
        return Ok(());
    }

    let consumer = create_base_consumer(config, &format!("{}-topic-counts", config.kafka_consumer_group))?;
    for (topic, partition_ids) in topic_partitions {
        let count = topic_message_count(&consumer, &topic, &partition_ids, timeout);
        if !progress(&topic, count) {
            break;
        }
    }
    Ok(())
}

pub async fn get_topic_message_count(handle: &KafkaConnectionHandle, topic: &str) -> Result<Option<i64>, String> {
    let topic = topic.trim();
    if topic.is_empty() {
        return Err("Kafka topic name is required".to_string());
    }

    let metadata = fetch_cluster_metadata(handle).await?;
    let partition_ids: Vec<i32> = metadata
        .topics()
        .iter()
        .find(|candidate| candidate.name() == topic)
        .map(|candidate| candidate.partitions().iter().map(|partition| partition.id()).collect())
        .ok_or_else(|| format!("Kafka topic '{topic}' was not found"))?;

    let config = handle.config.clone();
    let timeout = Duration::from_secs(handle.config.effective_connect_timeout_secs().max(1));
    let topic = topic.to_string();
    let mut result = None;

    tokio::task::spawn_blocking(move || {
        count_topics_messages(&config, vec![(topic, partition_ids)], timeout, |_, count| {
            result = count;
            false
        })
    })
    .await
    .map_err(|e| format!("Kafka topic message count task failed: {e}"))??;

    Ok(result)
}

fn topic_message_count(consumer: &BaseConsumer, topic: &str, partition_ids: &[i32], timeout: Duration) -> Option<i64> {
    if partition_ids.is_empty() {
        return Some(0);
    }

    let mut total = 0i64;
    for &partition_id in partition_ids {
        let (low, high) = consumer.fetch_watermarks(topic, partition_id, timeout).ok()?;
        total = total.checked_add(high.saturating_sub(low))?;
    }
    Some(total)
}

fn topic_name_word_boundary(text: &str, index: usize) -> bool {
    if index == 0 {
        return true;
    }
    matches!(text.as_bytes().get(index - 1), Some(b'_' | b'-' | b'.' | b' ' | b'/' | b'\\'))
}

fn topic_matches_fuzzy_subsequence(text: &str, query: &str) -> bool {
    if query.len() < 2 || query.len() > text.len() {
        return false;
    }

    let text_chars: Vec<char> = text.chars().collect();
    let query_chars: Vec<char> = query.chars().collect();
    let mut matched = 0usize;

    for (index, ch) in text_chars.iter().enumerate() {
        if topic_name_word_boundary(text, index) && index > 0 {
            matched = 0;
        }
        if matched < query_chars.len() && *ch == query_chars[matched] {
            matched += 1;
        }
    }

    matched == query_chars.len()
}

fn topic_matches_search(name: &str, query: &str) -> bool {
    let query = query.trim();
    if query.is_empty() {
        return true;
    }

    let name_lower = name.to_lowercase();
    let query_lower = query.to_lowercase();
    if name_lower.contains(&query_lower) {
        return true;
    }

    topic_matches_fuzzy_subsequence(&name_lower, &query_lower)
}

pub async fn describe_topic(handle: &KafkaConnectionHandle, topic: &str) -> Result<KafkaTopicDetail, String> {
    let topic = topic.trim();
    if topic.is_empty() {
        return Err("Kafka topic name is required".to_string());
    }

    let metadata = fetch_cluster_metadata(handle).await?;
    let metadata_topic = metadata
        .topics()
        .iter()
        .find(|candidate| candidate.name() == topic)
        .ok_or_else(|| format!("Kafka topic '{topic}' was not found"))?;

    let consumer = create_consumer(&handle.config, &format!("{}-describe", handle.config.kafka_consumer_group))?;
    let mut partitions = Vec::with_capacity(metadata_topic.partitions().len());

    for partition in metadata_topic.partitions() {
        let id = partition.id();
        let (low_offset, high_offset) = consumer
            .fetch_watermarks(topic, id, Duration::from_secs(handle.config.effective_connect_timeout_secs()))
            .map_err(|e| format!("Kafka watermark fetch failed for partition {id}: {e}"))?;

        partitions.push(KafkaPartitionInfo {
            partition: id,
            leader: partition.leader(),
            replicas: partition.replicas().to_vec(),
            isr: partition.isr().to_vec(),
            offset_begin: Some(low_offset),
            offset_end: Some(high_offset),
        });
    }

    partitions.sort_by_key(|partition| partition.partition);
    let replication_factor = partitions.first().map(|partition| partition.replicas.len() as i32).unwrap_or(0);
    Ok(KafkaTopicDetail {
        name: topic.to_string(),
        partition_count: partitions.len() as i32,
        replication_factor,
        partitions,
    })
}

pub async fn fetch_messages(
    handle: &KafkaConnectionHandle,
    topic: &str,
    partition: i32,
    start_offset: KafkaFetchOffset,
    limit: usize,
    timeout: Duration,
) -> Result<Vec<KafkaMessageRecord>, String> {
    let topic = topic.trim();
    if topic.is_empty() {
        return Err("Kafka topic name is required".to_string());
    }
    if limit == 0 {
        return Ok(Vec::new());
    }

    let consumer = create_consumer(
        &handle.config,
        &format!("{}-fetch-{}", handle.config.kafka_consumer_group, uuid::Uuid::new_v4()),
    )?;

    let (low, high) = consumer
        .fetch_watermarks(topic, partition, timeout)
        .map_err(|e| format!("Kafka watermark fetch failed for partition {partition}: {e}"))?;
    if matches!(start_offset, KafkaFetchOffset::Latest) && high <= low {
        return Ok(Vec::new());
    }
    let assign_offset = resolve_fetch_assign_offset(start_offset, limit, low, high)?;

    let mut assignment = TopicPartitionList::new();
    assignment
        .add_partition_offset(topic, partition, assign_offset)
        .map_err(|e| format!("Kafka partition assignment failed: {e}"))?;
    consumer.assign(&assignment).map_err(|e| format!("Kafka consumer assign failed: {e}"))?;

    let mut records = Vec::with_capacity(limit.min(256));
    while records.len() < limit {
        let message = match tokio::time::timeout(timeout, consumer.recv()).await {
            Ok(Ok(message)) => message,
            Ok(Err(KafkaError::PartitionEOF(_))) => break,
            Ok(Err(e)) => return Err(format!("Kafka message fetch failed: {e}")),
            Err(_) => break,
        };

        if message.topic() != topic || message.partition() != partition {
            continue;
        }

        records.push(message_to_record(&message));
    }

    Ok(records)
}

/// Long-lived partition tail: keeps consuming until `should_stop` returns true.
/// `start_offset = None` means only messages produced after tail starts.
pub async fn run_partition_tail<F, S, Fut>(
    handle: &KafkaConnectionHandle,
    topic: &str,
    partition: i32,
    start_offset: Option<i64>,
    mut on_message: F,
    mut should_stop: S,
) -> Result<(), String>
where
    F: FnMut(KafkaMessageRecord),
    S: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let topic = topic.trim();
    if topic.is_empty() {
        return Err("Kafka topic name is required".to_string());
    }

    let consumer = create_consumer(
        &handle.config,
        &format!("{}-tail-{}", handle.config.kafka_consumer_group, uuid::Uuid::new_v4()),
    )?;
    let timeout = Duration::from_secs(handle.config.effective_connect_timeout_secs().max(1));
    let (low, high) = consumer
        .fetch_watermarks(topic, partition, timeout)
        .map_err(|e| format!("Kafka watermark fetch failed for partition {partition}: {e}"))?;

    let assign_offset = match start_offset {
        Some(offset) if offset < 0 => return Err(format!("Kafka offset must be non-negative, got {offset}")),
        Some(offset) => Offset::Offset(offset),
        None => Offset::Offset(if high <= low { low } else { high }),
    };

    let mut assignment = TopicPartitionList::new();
    assignment
        .add_partition_offset(topic, partition, assign_offset)
        .map_err(|e| format!("Kafka partition assignment failed: {e}"))?;
    consumer.assign(&assignment).map_err(|e| format!("Kafka consumer assign failed: {e}"))?;

    loop {
        if should_stop().await {
            break;
        }

        match tokio::time::timeout(Duration::from_millis(500), consumer.recv()).await {
            Ok(Ok(message)) => {
                if message.topic() != topic || message.partition() != partition {
                    continue;
                }
                on_message(message_to_record(&message));
            }
            Ok(Err(KafkaError::PartitionEOF(_))) => continue,
            Ok(Err(e)) => return Err(format!("Kafka tail consume failed: {e}")),
            Err(_) => continue,
        }
    }

    Ok(())
}

pub async fn list_brokers(handle: &KafkaConnectionHandle) -> Result<Vec<KafkaBrokerInfo>, String> {
    let metadata = fetch_cluster_metadata(handle).await?;
    let mut brokers: Vec<KafkaBrokerInfo> = metadata
        .brokers()
        .iter()
        .map(|broker| {
            let host = broker.host().to_string();
            let port = broker.port();
            KafkaBrokerInfo { id: broker.id(), host: host.clone(), port, address: format!("{host}:{port}") }
        })
        .collect();
    brokers.sort_by_key(|broker| broker.id);
    Ok(brokers)
}

pub async fn list_acls(handle: &KafkaConnectionHandle) -> Result<Vec<KafkaAclEntry>, String> {
    let admin = Arc::clone(&handle.admin);
    let timeout = Duration::from_secs(handle.config.effective_connect_timeout_secs().max(1));
    tokio::task::spawn_blocking(move || describe_acls_sync(&admin, timeout))
        .await
        .map_err(|e| format!("Kafka list ACLs task failed: {e}"))?
}

pub async fn list_consumer_groups(handle: &KafkaConnectionHandle) -> Result<Vec<KafkaConsumerGroupSummary>, String> {
    let admin = Arc::clone(&handle.admin);
    let timeout = Duration::from_secs(handle.config.effective_connect_timeout_secs());

    tokio::task::spawn_blocking(move || {
        let group_list =
            admin.inner().fetch_group_list(None, timeout).map_err(|e| format!("Kafka fetch group list failed: {e}"))?;

        let mut groups: Vec<KafkaConsumerGroupSummary> = group_list
            .groups()
            .iter()
            .filter(|group| group.protocol_type() == "consumer")
            .map(|group| KafkaConsumerGroupSummary {
                group_id: group.name().to_string(),
                state: group.state().to_string(),
                protocol_type: group.protocol_type().to_string(),
                member_count: group.members().len() as i32,
            })
            .collect();

        groups.sort_by(|left, right| left.group_id.cmp(&right.group_id));
        Ok(groups)
    })
    .await
    .map_err(|e| format!("Kafka list consumer groups task failed: {e}"))?
}

pub async fn describe_consumer_group(
    handle: &KafkaConnectionHandle,
    group_id: &str,
) -> Result<KafkaConsumerGroupDetail, String> {
    let group_id = group_id.trim();
    if group_id.is_empty() {
        return Err("Kafka consumer group id is required".to_string());
    }

    let admin = Arc::clone(&handle.admin);
    let config = handle.config.clone();
    let timeout = Duration::from_secs(handle.config.effective_connect_timeout_secs());
    let group_id = group_id.to_string();

    tokio::task::spawn_blocking(move || describe_consumer_group_sync(&admin, &config, &group_id, timeout))
        .await
        .map_err(|e| format!("Kafka describe consumer group task failed: {e}"))?
}

fn validate_create_topic_request(req: &KafkaCreateTopicRequest) -> Result<String, String> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err("Kafka topic name is required".to_string());
    }
    if req.partitions < 1 {
        return Err("Kafka topic partitions must be at least 1".to_string());
    }
    if req.replication_factor < 1 {
        return Err("Kafka topic replication factor must be at least 1".to_string());
    }
    Ok(name)
}

pub async fn create_topic(
    handle: &KafkaConnectionHandle,
    req: KafkaCreateTopicRequest,
) -> Result<KafkaCreateTopicResult, String> {
    let name = validate_create_topic_request(&req)?;

    let topic = NewTopic::new(&name, req.partitions, TopicReplication::Fixed(req.replication_factor));
    let timeout = Duration::from_secs(handle.config.effective_connect_timeout_secs());
    let opts = AdminOptions::new().request_timeout(Some(timeout)).operation_timeout(Some(timeout));

    let results =
        handle.admin.create_topics(&[topic], &opts).await.map_err(|e| format!("Kafka create topic failed: {e}"))?;

    match results.into_iter().next() {
        Some(Ok(created_name)) => Ok(KafkaCreateTopicResult { name: created_name }),
        Some(Err((topic_name, code))) => Err(format!("Kafka create topic '{topic_name}' failed: {code:?}")),
        None => Err("Kafka create topic returned no result".to_string()),
    }
}

pub async fn delete_topic(handle: &KafkaConnectionHandle, topic: &str) -> Result<KafkaDeleteTopicResult, String> {
    let topic = topic.trim();
    if topic.is_empty() {
        return Err("Kafka topic name is required".to_string());
    }

    let timeout = Duration::from_secs(handle.config.effective_connect_timeout_secs());
    let opts = AdminOptions::new().request_timeout(Some(timeout)).operation_timeout(Some(timeout));

    let results =
        handle.admin.delete_topics(&[topic], &opts).await.map_err(|e| format!("Kafka delete topic failed: {e}"))?;

    match results.into_iter().next() {
        Some(Ok(deleted_name)) => Ok(KafkaDeleteTopicResult { name: deleted_name, deleted: true }),
        Some(Err((topic_name, code))) => Err(format!("Kafka delete topic '{topic_name}' failed: {code:?}")),
        None => Err("Kafka delete topic returned no result".to_string()),
    }
}

pub async fn produce_message(
    handle: &KafkaConnectionHandle,
    topic: &str,
    key: Option<&str>,
    value: Option<&[u8]>,
    headers: Option<Vec<(String, Vec<u8>)>>,
    partition: Option<i32>,
) -> Result<KafkaProduceResult, String> {
    let topic = topic.trim();
    if topic.is_empty() {
        return Err("Kafka topic name is required".to_string());
    }

    let mut client_config = build_client_config(&handle.config)?;
    client_config.set("message.timeout.ms", "30000");
    let producer: FutureProducer =
        client_config.create().map_err(|e| format!("Kafka producer creation failed: {e}"))?;

    let header_entries = headers;
    let mut record = FutureRecord::to(topic);
    if let Some(key) = key.filter(|value| !value.is_empty()) {
        record = record.key(key);
    }
    if let Some(value) = value {
        record = record.payload(value);
    }
    if let Some(partition) = partition {
        record = record.partition(partition);
    }
    if let Some(header_entries) = &header_entries {
        let mut owned_headers = rdkafka::message::OwnedHeaders::new();
        for (key, value) in header_entries {
            owned_headers = owned_headers.insert(Header { key: key.as_str(), value: Some(value.as_slice()) });
        }
        record = record.headers(owned_headers);
    }

    let delivery_timeout = Duration::from_secs(handle.config.effective_query_timeout_secs().max(5));
    let delivery =
        producer.send(record, delivery_timeout).await.map_err(|(err, _)| format!("Kafka produce failed: {err}"))?;

    Ok(KafkaProduceResult { topic: topic.to_string(), partition: delivery.0, offset: delivery.1 })
}

fn cstr_ptr_to_string(ptr: *const std::os::raw::c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
}

fn describe_acls_sync(
    admin: &AdminClient<DefaultClientContext>,
    timeout: Duration,
) -> Result<Vec<KafkaAclEntry>, String> {
    let rk = admin.inner().native_ptr();
    let timeout_ms = timeout.as_millis().min(i64::MAX as u128) as i32;
    let mut err_buf = vec![0i8; 512];

    let filter = unsafe {
        rdsys::rd_kafka_AclBindingFilter_new(
            rdsys::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_ANY,
            ptr::null(),
            rdsys::rd_kafka_ResourcePatternType_t::RD_KAFKA_RESOURCE_PATTERN_ANY,
            ptr::null(),
            ptr::null(),
            rdsys::rd_kafka_AclOperation_t::RD_KAFKA_ACL_OPERATION_ANY,
            rdsys::rd_kafka_AclPermissionType_t::RD_KAFKA_ACL_PERMISSION_TYPE_ANY,
            err_buf.as_mut_ptr(),
            err_buf.len(),
        )
    };
    if filter.is_null() {
        let err = err_buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8 as char).collect::<String>();
        return Err(format!("Kafka ACL filter creation failed: {err}"));
    }

    let opts =
        unsafe { rdsys::rd_kafka_AdminOptions_new(rk, rdsys::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_DESCRIBEACLS) };
    if opts.is_null() {
        unsafe { rdsys::rd_kafka_AclBinding_destroy(filter) };
        return Err("Kafka ACL admin options creation failed".to_string());
    }
    unsafe {
        rdsys::rd_kafka_AdminOptions_set_request_timeout(opts, timeout_ms, err_buf.as_mut_ptr(), err_buf.len());
    }

    let queue = unsafe { rdsys::rd_kafka_queue_new(rk) };
    if queue.is_null() {
        unsafe {
            rdsys::rd_kafka_AdminOptions_destroy(opts);
            rdsys::rd_kafka_AclBinding_destroy(filter);
        }
        return Err("Kafka ACL queue creation failed".to_string());
    }

    unsafe {
        rdsys::rd_kafka_DescribeAcls(rk, filter, opts, queue);
        rdsys::rd_kafka_AclBinding_destroy(filter);
        rdsys::rd_kafka_AdminOptions_destroy(opts);
    }

    let event = unsafe { rdsys::rd_kafka_queue_poll(queue, timeout_ms) };
    unsafe { rdsys::rd_kafka_queue_destroy(queue) };

    if event.is_null() {
        return Err("Kafka DescribeAcls timed out".to_string());
    }

    let event_type = unsafe { rdsys::rd_kafka_event_type(event) };
    if event_type != rdsys::RD_KAFKA_EVENT_DESCRIBEACLS_RESULT {
        let err = unsafe { cstr_ptr_to_string(rdsys::rd_kafka_event_error_string(event)) };
        unsafe { rdsys::rd_kafka_event_destroy(event) };
        return Err(if err.is_empty() {
            "Kafka DescribeAcls failed".to_string()
        } else {
            format!("Kafka DescribeAcls failed: {err}")
        });
    }

    let result = unsafe { rdsys::rd_kafka_event_DescribeAcls_result(event) };
    let mut count = 0usize;
    let acls_ptr = unsafe { rdsys::rd_kafka_DescribeAcls_result_acls(result, &mut count) };

    let mut entries = Vec::with_capacity(count);
    if !acls_ptr.is_null() && count > 0 {
        let acls_slice = unsafe { std::slice::from_raw_parts(acls_ptr, count) };
        for &acl in acls_slice {
            if acl.is_null() {
                continue;
            }
            let binding_error = unsafe { rdsys::rd_kafka_AclBinding_error(acl) };
            if !binding_error.is_null() {
                continue;
            }
            let restype = unsafe { rdsys::rd_kafka_AclBinding_restype(acl) };
            let resource_type = unsafe { cstr_ptr_to_string(rdsys::rd_kafka_ResourceType_name(restype)) };
            let resource_name = unsafe { cstr_ptr_to_string(rdsys::rd_kafka_AclBinding_name(acl)) };
            let pattern_type_val = unsafe { rdsys::rd_kafka_AclBinding_resource_pattern_type(acl) };
            let pattern_type =
                unsafe { cstr_ptr_to_string(rdsys::rd_kafka_ResourcePatternType_name(pattern_type_val)) };
            let principal = unsafe { cstr_ptr_to_string(rdsys::rd_kafka_AclBinding_principal(acl)) };
            let host = unsafe { cstr_ptr_to_string(rdsys::rd_kafka_AclBinding_host(acl)) };
            let operation_val = unsafe { rdsys::rd_kafka_AclBinding_operation(acl) };
            let operation = unsafe { cstr_ptr_to_string(rdsys::rd_kafka_AclOperation_name(operation_val)) };
            let permission_val = unsafe { rdsys::rd_kafka_AclBinding_permission_type(acl) };
            let permission = unsafe { cstr_ptr_to_string(rdsys::rd_kafka_AclPermissionType_name(permission_val)) };

            entries.push(KafkaAclEntry {
                resource_type,
                resource_name,
                pattern_type,
                principal,
                host,
                operation,
                permission,
            });
        }
    }

    entries.sort_by(|left, right| {
        left.resource_type
            .cmp(&right.resource_type)
            .then_with(|| left.resource_name.cmp(&right.resource_name))
            .then_with(|| left.principal.cmp(&right.principal))
            .then_with(|| left.operation.cmp(&right.operation))
    });

    unsafe { rdsys::rd_kafka_event_destroy(event) };
    Ok(entries)
}

async fn fetch_cluster_metadata(handle: &KafkaConnectionHandle) -> Result<rdkafka::metadata::Metadata, String> {
    let admin = Arc::clone(&handle.admin);
    let timeout = Duration::from_secs(handle.config.effective_connect_timeout_secs());
    tokio::task::spawn_blocking(move || admin.inner().fetch_metadata(None, timeout))
        .await
        .map_err(|e| format!("Kafka metadata task failed: {e}"))?
        .map_err(|e| format!("Kafka metadata fetch failed: {e}"))
}

fn build_client_config(config: &ConnectionConfig) -> Result<ClientConfig, String> {
    let mut client_config = ClientConfig::new();
    client_config.set("bootstrap.servers", config.kafka_bootstrap_servers());

    let security_protocol = config
        .kafka_security_protocol
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| infer_security_protocol(config));
    client_config.set("security.protocol", &security_protocol);

    if let Some(mechanism) = config.kafka_sasl_mechanism.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        client_config.set("sasl.mechanism", mechanism);
    }
    if !config.username.trim().is_empty() {
        client_config.set("sasl.username", config.username.trim());
    }
    if !config.password.is_empty() {
        client_config.set("sasl.password", &config.password);
    }

    if !config.ca_cert_path.trim().is_empty() {
        client_config.set("ssl.ca.location", expand_cert_path(config.ca_cert_path.trim()));
    }
    if !config.client_cert_path.trim().is_empty() {
        client_config.set("ssl.certificate.location", expand_cert_path(config.client_cert_path.trim()));
    }
    if !config.client_key_path.trim().is_empty() {
        client_config.set("ssl.key.location", expand_cert_path(config.client_key_path.trim()));
    }

    let timeout_ms = config.effective_connect_timeout_secs().saturating_mul(1000).max(1000);
    client_config.set("socket.timeout.ms", timeout_ms.to_string());
    client_config.set("api.version.request.timeout.ms", timeout_ms.to_string());
    Ok(client_config)
}

fn describe_consumer_group_sync(
    admin: &AdminClient<DefaultClientContext>,
    config: &ConnectionConfig,
    group_id: &str,
    timeout: Duration,
) -> Result<KafkaConsumerGroupDetail, String> {
    let group_list = admin
        .inner()
        .fetch_group_list(Some(group_id), timeout)
        .map_err(|e| format!("Kafka fetch group list failed: {e}"))?;

    let group_info = group_list
        .groups()
        .iter()
        .find(|group| group.name() == group_id)
        .ok_or_else(|| format!("Kafka consumer group '{group_id}' was not found"))?;

    if group_info.protocol_type() != "consumer" {
        return Err(format!("Kafka group '{group_id}' is not a consumer group"));
    }

    let consumer = create_base_consumer(config, group_id)?;
    let metadata =
        admin.inner().fetch_metadata(None, timeout).map_err(|e| format!("Kafka metadata fetch failed: {e}"))?;

    let mut assignment = TopicPartitionList::new();
    for topic in metadata.topics() {
        let topic_name = topic.name();
        if topic_name.is_empty() || topic_name.starts_with("__") {
            continue;
        }
        for partition in topic.partitions() {
            assignment.add_partition(topic_name, partition.id());
        }
    }

    consumer.assign(&assignment).map_err(|e| format!("Kafka consumer assign failed: {e}"))?;

    let committed = consumer.committed(timeout).map_err(|e| format!("Kafka committed offset fetch failed: {e}"))?;

    let mut partitions = Vec::with_capacity(committed.count());
    for element in committed.elements() {
        let topic = element.topic();
        let partition_id = element.partition();
        let committed_offset = committed_offset_value(element.offset());
        let (_, end_offset) = consumer
            .fetch_watermarks(topic, partition_id, timeout)
            .map_err(|e| format!("Kafka watermark fetch failed for partition {partition_id}: {e}"))?;
        let lag = if committed_offset >= 0 { (end_offset - committed_offset).max(0) } else { end_offset };

        partitions.push(KafkaConsumerGroupPartitionLag {
            topic: topic.to_string(),
            partition: partition_id,
            committed_offset,
            end_offset,
            lag,
        });
    }

    partitions.sort_by(|left, right| left.topic.cmp(&right.topic).then_with(|| left.partition.cmp(&right.partition)));

    Ok(KafkaConsumerGroupDetail {
        group_id: group_id.to_string(),
        state: group_info.state().to_string(),
        protocol_type: group_info.protocol_type().to_string(),
        member_count: group_info.members().len() as i32,
        partitions,
    })
}

fn committed_offset_value(offset: Offset) -> i64 {
    match offset {
        Offset::Offset(value) => value,
        _ => -1,
    }
}

fn resolve_fetch_assign_offset(
    start_offset: KafkaFetchOffset,
    limit: usize,
    low: i64,
    high: i64,
) -> Result<Offset, String> {
    match start_offset {
        KafkaFetchOffset::Earliest => Ok(Offset::Beginning),
        KafkaFetchOffset::Latest => {
            let start = high.saturating_sub(limit as i64).max(low);
            Ok(Offset::Offset(start))
        }
        KafkaFetchOffset::Offset(value) => {
            if value < 0 {
                return Err(format!("Kafka offset must be non-negative, got {value}"));
            }
            Ok(Offset::Offset(value))
        }
    }
}

fn create_base_consumer(config: &ConnectionConfig, group_id: &str) -> Result<BaseConsumer, String> {
    let mut client_config = build_client_config(config)?;
    client_config.set("group.id", group_id);
    client_config.set("enable.auto.commit", "false");
    client_config.create().map_err(|e| format!("Kafka consumer creation failed: {e}"))
}

fn create_consumer(config: &ConnectionConfig, group_id: &str) -> Result<StreamConsumer, String> {
    let mut client_config = build_client_config(config)?;
    client_config.set("group.id", group_id);
    client_config.set("enable.auto.commit", "false");
    client_config.set("enable.partition.eof", "true");
    client_config.set("auto.offset.reset", "earliest");
    client_config.create().map_err(|e| format!("Kafka consumer creation failed: {e}"))
}

fn infer_security_protocol(config: &ConnectionConfig) -> String {
    let has_sasl = !config.username.trim().is_empty()
        || config.kafka_sasl_mechanism.as_deref().is_some_and(|m| !m.trim().is_empty());
    match (config.ssl, has_sasl) {
        (true, true) => "SASL_SSL".to_string(),
        (true, false) => "SSL".to_string(),
        (false, true) => "SASL_PLAINTEXT".to_string(),
        (false, false) => "PLAINTEXT".to_string(),
    }
}

fn message_to_record(message: &impl Message) -> KafkaMessageRecord {
    let headers = message
        .headers()
        .map(|headers| {
            headers
                .iter()
                .map(|header| {
                    let key = header.key.to_string();
                    let value = header.value.map(|bytes| payload_to_text(bytes)).unwrap_or_default();
                    (key, value)
                })
                .collect()
        })
        .unwrap_or_default();

    KafkaMessageRecord {
        partition: message.partition(),
        offset: message.offset(),
        timestamp: message_timestamp(message.timestamp()).unwrap_or(0),
        key: message.key().map(bytes_to_payload),
        value: message.payload().map(bytes_to_payload),
        headers,
    }
}

fn message_timestamp(timestamp: Timestamp) -> Option<i64> {
    match timestamp {
        Timestamp::CreateTime(value) | Timestamp::LogAppendTime(value) => Some(value),
        Timestamp::NotAvailable => None,
    }
}

fn bytes_to_payload(bytes: &[u8]) -> KafkaPayload {
    KafkaPayload { encoding: payload_encoding(bytes).to_string(), data: payload_to_text(bytes) }
}

fn payload_encoding(bytes: &[u8]) -> &'static str {
    if std::str::from_utf8(bytes).is_ok() {
        "utf8"
    } else {
        "base64"
    }
}

fn payload_to_text(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        text.to_string()
    } else {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }
}

fn expand_cert_path(path: &str) -> String {
    let home = || std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok();
    if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        if let Some(home) = home() {
            return format!("{}{}", home, &path[1..]);
        }
    }
    if let Some(rest) = path.strip_prefix("$HOME") {
        if let Some(home) = home() {
            return format!("{home}{rest}");
        }
    }
    if let Some(rest) = path.strip_prefix("${HOME}") {
        if let Some(home) = home() {
            return format!("{home}{rest}");
        }
    }
    if let Some(rest) = path.strip_prefix("%USERPROFILE%") {
        if let Ok(home) = std::env::var("USERPROFILE") {
            return format!("{home}{rest}");
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{
        default_connect_timeout_secs, default_idle_timeout_secs, default_kafka_consumer_group,
        default_query_timeout_secs, default_redis_key_separator, ConnectionConfig, DatabaseType,
    };

    fn kafka_config() -> ConnectionConfig {
        ConnectionConfig {
            id: "kafka".to_string(),
            name: "Kafka".to_string(),
            db_type: DatabaseType::Kafka,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "127.0.0.1".to_string(),
            port: DEFAULT_KAFKA_PORT,
            username: "user".to_string(),
            password: "secret".to_string(),
            database: None,
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: default_connect_timeout_secs(),
            query_timeout_secs: default_query_timeout_secs(),
            idle_timeout_secs: default_idle_timeout_secs(),
            ssl: true,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: default_redis_key_separator(),
            etcd_endpoints: String::new(),
            kafka_bootstrap_servers: String::new(),
            kafka_security_protocol: None,
            kafka_sasl_mechanism: Some("PLAIN".to_string()),
            kafka_consumer_group: default_kafka_consumer_group(),
            kafka_schema_registry_url: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
        }
    }

    #[test]
    fn infers_sasl_ssl_when_tls_and_credentials_are_enabled() {
        let config = kafka_config();

        assert_eq!(infer_security_protocol(&config), "SASL_SSL");
        assert_eq!(config.kafka_bootstrap_servers(), "127.0.0.1:9092");
    }

    #[test]
    fn uses_explicit_bootstrap_servers_when_configured() {
        let mut config = kafka_config();
        config.kafka_bootstrap_servers = "broker1:9092,broker2:9092".to_string();

        assert_eq!(config.kafka_bootstrap_servers(), "broker1:9092,broker2:9092");
        assert_eq!(config.connection_url(), "kafka://user:secret@broker1:9092,broker2:9092");
        assert_eq!(config.redacted_connection_url(), "kafka://broker1:9092,broker2:9092");
    }

    #[test]
    fn encodes_binary_payload_as_base64() {
        let payload = bytes_to_payload(&[0xff, 0x00, 0x61]);

        assert_eq!(payload.encoding, "base64");
    }

    #[test]
    fn kafka_topic_types_serialize_camel_case() {
        let summary = serde_json::to_value(KafkaTopicSummary {
            name: "events".to_string(),
            partition_count: 3,
            internal: false,
            message_count: Some(42),
        })
        .unwrap();
        assert_eq!(summary["name"], "events");
        assert_eq!(summary["partitionCount"], 3);
        assert_eq!(summary["internal"], false);
        assert_eq!(summary["messageCount"], 42);
        assert!(summary.get("partition_count").is_none());

        let detail = serde_json::to_value(KafkaTopicDetail {
            name: "events".to_string(),
            partition_count: 1,
            replication_factor: 2,
            partitions: vec![KafkaPartitionInfo {
                partition: 0,
                leader: 1,
                replicas: vec![1, 2],
                isr: vec![1, 2],
                offset_begin: Some(0),
                offset_end: Some(42),
            }],
        })
        .unwrap();
        assert_eq!(detail["partitionCount"], 1);
        assert_eq!(detail["replicationFactor"], 2);
        assert_eq!(detail["partitions"][0]["offsetBegin"], 0);
        assert_eq!(detail["partitions"][0]["offsetEnd"], 42);
        assert!(detail.get("partition_count").is_none());
        assert!(detail.get("replication_factor").is_none());
    }

    #[test]
    fn kafka_message_types_serialize_camel_case() {
        let payload =
            serde_json::to_value(KafkaPayload { encoding: "utf8".to_string(), data: "hello".to_string() }).unwrap();
        assert_eq!(payload["encoding"], "utf8");
        assert_eq!(payload["data"], "hello");

        let record = serde_json::to_value(KafkaMessageRecord {
            partition: 0,
            offset: 12,
            timestamp: 1_700_000_000,
            key: Some(KafkaPayload { encoding: "utf8".to_string(), data: "k".to_string() }),
            value: Some(KafkaPayload { encoding: "utf8".to_string(), data: "v".to_string() }),
            headers: vec![("trace-id".to_string(), "abc".to_string())],
        })
        .unwrap();
        assert_eq!(record["partition"], 0);
        assert_eq!(record["offset"], 12);
        assert_eq!(record["timestamp"], 1_700_000_000);
        assert_eq!(record["key"]["data"], "k");
        assert_eq!(record["value"]["data"], "v");
        assert_eq!(record["headers"][0][0], "trace-id");

        let produced =
            serde_json::to_value(KafkaProduceResult { topic: "events".to_string(), partition: 1, offset: 99 }).unwrap();
        assert_eq!(produced["topic"], "events");
        assert_eq!(produced["partition"], 1);
        assert_eq!(produced["offset"], 99);
    }

    #[test]
    fn kafka_consumer_group_types_serialize_camel_case() {
        let summary = serde_json::to_value(KafkaConsumerGroupSummary {
            group_id: "dbx-consumer".to_string(),
            state: "Stable".to_string(),
            protocol_type: "consumer".to_string(),
            member_count: 2,
        })
        .unwrap();
        assert_eq!(summary["groupId"], "dbx-consumer");
        assert_eq!(summary["protocolType"], "consumer");
        assert_eq!(summary["memberCount"], 2);
        assert!(summary.get("group_id").is_none());

        let detail = serde_json::to_value(KafkaConsumerGroupDetail {
            group_id: "dbx-consumer".to_string(),
            state: "Stable".to_string(),
            protocol_type: "consumer".to_string(),
            member_count: 1,
            partitions: vec![KafkaConsumerGroupPartitionLag {
                topic: "events".to_string(),
                partition: 0,
                committed_offset: 10,
                end_offset: 15,
                lag: 5,
            }],
        })
        .unwrap();
        assert_eq!(detail["partitions"][0]["committedOffset"], 10);
        assert_eq!(detail["partitions"][0]["endOffset"], 15);
        assert_eq!(detail["partitions"][0]["lag"], 5);
    }

    #[test]
    fn kafka_topic_mutation_results_serialize_camel_case() {
        let created = serde_json::to_value(KafkaCreateTopicResult { name: "new-topic".to_string() }).unwrap();
        assert_eq!(created["name"], "new-topic");

        let deleted =
            serde_json::to_value(KafkaDeleteTopicResult { name: "old-topic".to_string(), deleted: true }).unwrap();
        assert_eq!(deleted["name"], "old-topic");
        assert_eq!(deleted["deleted"], true);
    }

    #[test]
    fn kafka_create_topic_request_deserializes_camel_case() {
        let req: KafkaCreateTopicRequest = serde_json::from_value(serde_json::json!({
            "name": "new-topic",
            "partitions": 6,
            "replicationFactor": 2
        }))
        .unwrap();

        assert_eq!(req.name, "new-topic");
        assert_eq!(req.partitions, 6);
        assert_eq!(req.replication_factor, 2);
    }

    #[test]
    fn validate_create_topic_request_rejects_invalid_values() {
        assert_eq!(
            validate_create_topic_request(&KafkaCreateTopicRequest {
                name: String::new(),
                partitions: 1,
                replication_factor: 1,
            }),
            Err("Kafka topic name is required".to_string())
        );
        assert_eq!(
            validate_create_topic_request(&KafkaCreateTopicRequest {
                name: "   ".to_string(),
                partitions: 1,
                replication_factor: 1,
            }),
            Err("Kafka topic name is required".to_string())
        );
        assert_eq!(
            validate_create_topic_request(&KafkaCreateTopicRequest {
                name: "events".to_string(),
                partitions: 0,
                replication_factor: 1,
            }),
            Err("Kafka topic partitions must be at least 1".to_string())
        );
        assert_eq!(
            validate_create_topic_request(&KafkaCreateTopicRequest {
                name: "events".to_string(),
                partitions: 1,
                replication_factor: 0,
            }),
            Err("Kafka topic replication factor must be at least 1".to_string())
        );
        assert_eq!(
            validate_create_topic_request(&KafkaCreateTopicRequest {
                name: "  events  ".to_string(),
                partitions: 3,
                replication_factor: 2,
            }),
            Ok("events".to_string())
        );
    }

    #[test]
    fn kafka_produce_request_deserializes_camel_case_with_defaults() {
        let req: KafkaProduceRequest = serde_json::from_value(serde_json::json!({
            "topic": "events",
            "value": "payload",
            "key": "id-1",
            "headers": [["trace-id", "abc"]],
            "partition": 2
        }))
        .unwrap();

        assert_eq!(req.topic, "events");
        assert_eq!(req.value, "payload");
        assert_eq!(req.key.as_deref(), Some("id-1"));
        assert_eq!(req.headers, vec![("trace-id".to_string(), "abc".to_string())]);
        assert_eq!(req.partition, Some(2));

        let minimal: KafkaProduceRequest =
            serde_json::from_value(serde_json::json!({ "topic": "events", "value": "payload" })).unwrap();
        assert!(minimal.key.is_none());
        assert!(minimal.headers.is_empty());
        assert!(minimal.partition.is_none());
    }

    #[test]
    fn topic_matches_search_supports_substring_and_fuzzy_queries() {
        assert!(topic_matches_search("orders.events.v1", "events"));
        assert!(topic_matches_search("ORDERS.EVENTS.V1", "events"));
        assert!(topic_matches_search("orders.events.v1", "oev"));
        assert!(!topic_matches_search("orders.events.v1", "billing"));
        assert!(topic_matches_search("any-topic", ""));
    }

    #[test]
    fn resolve_fetch_assign_offset_uses_absolute_offsets_for_latest() {
        let offset = resolve_fetch_assign_offset(KafkaFetchOffset::Latest, 100, 0, 250).unwrap();
        assert!(matches!(offset, Offset::Offset(150)));

        let offset = resolve_fetch_assign_offset(KafkaFetchOffset::Latest, 100, 40, 80).unwrap();
        assert!(matches!(offset, Offset::Offset(40)));

        let offset = resolve_fetch_assign_offset(KafkaFetchOffset::Earliest, 100, 0, 250).unwrap();
        assert!(matches!(offset, Offset::Beginning));

        let err = resolve_fetch_assign_offset(KafkaFetchOffset::Offset(-1), 100, 0, 250).unwrap_err();
        assert!(err.contains("non-negative"));
    }

    #[test]
    fn kafka_start_offset_deserializes_named_and_numeric_offsets() {
        let earliest: KafkaStartOffset = serde_json::from_value(serde_json::json!("earliest")).unwrap();
        assert!(matches!(earliest.to_fetch_offset().unwrap(), KafkaFetchOffset::Earliest));

        let latest: KafkaStartOffset = serde_json::from_value(serde_json::json!("latest")).unwrap();
        assert!(matches!(latest.to_fetch_offset().unwrap(), KafkaFetchOffset::Latest));

        let numeric: KafkaStartOffset = serde_json::from_value(serde_json::json!({ "offset": 42 })).unwrap();
        assert!(matches!(numeric.to_fetch_offset().unwrap(), KafkaFetchOffset::Offset(42)));

        let unsupported: KafkaStartOffset = serde_json::from_value(serde_json::json!("middle")).unwrap();
        assert!(unsupported.to_fetch_offset().is_err());
    }
}
