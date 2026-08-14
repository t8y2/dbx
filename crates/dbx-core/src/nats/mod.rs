//! NATS support backed by the DBX native Agent.
//!
//! The Rust workspace intentionally does not depend on a NATS client crate.
//! NATS wire-protocol work lives in `agents/drivers/nats`; this module exposes
//! a small, transport-neutral facade for MCP and future desktop/web callers.

mod agent;
mod config;
mod types;

pub use agent::NatsService;
pub use config::NatsConnectionConfig;
pub use types::{
    validate_jetstream_name, NatsCaptureRequest, NatsCaptureResult, NatsConsumerInfo, NatsConsumerList, NatsHeader,
    NatsHistoryRequest, NatsHistoryResult, NatsJetStreamInfo, NatsMessage, NatsPublishRequest, NatsPublishResult,
    NatsServerInfo, NatsStreamInfo, NatsStreamList, NatsSubscriptionErrorEvent, NatsSubscriptionEvent,
    NatsSubscriptionInfo, NatsSubscriptionMessageEvent, NatsSubscriptionRequest, NatsSubscriptionStateEvent,
};
