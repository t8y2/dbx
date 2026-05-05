use dbx_core::connection::AppState;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

pub struct WebState {
    pub app: Arc<AppState>,
    pub data_dir: PathBuf,
    pub password_hash: Option<String>,
    pub sessions: RwLock<HashSet<String>>,
    pub sse_channels: RwLock<HashMap<String, broadcast::Sender<String>>>,
}
