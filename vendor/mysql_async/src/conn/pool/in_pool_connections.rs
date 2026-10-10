use std::{
    collections::VecDeque,
    sync::{atomic::Ordering, Arc},
};

use super::{metrics::Metrics, IdlingConn};

#[derive(Default, Debug)]
pub(crate) struct InPoolConnections {
    pub(crate) connections: VecDeque<IdlingConn>,
    pub(crate) metrics: Arc<Metrics>,
}

impl InPoolConnections {
    pub(crate) fn new(capacity: usize, metrics: Arc<Metrics>) -> Self {
        Self {
            connections: VecDeque::with_capacity(capacity),
            metrics,
        }
    }

    pub(crate) fn push_back(&mut self, conn: IdlingConn) {
        self.metrics
            .connections_in_pool
            .fetch_add(1, Ordering::Relaxed);
        self.connections.push_back(conn);
    }

    pub(crate) fn pop_back(&mut self) -> Option<IdlingConn> {
        let res = self.connections.pop_back();
        if res.is_some() {
            self.metrics
                .connections_in_pool
                .fetch_sub(1, Ordering::Relaxed);
        }

        res
    }

    pub(crate) fn pop_front(&mut self) -> Option<IdlingConn> {
        let res = self.connections.pop_front();
        if res.is_some() {
            self.metrics
                .connections_in_pool
                .fetch_sub(1, Ordering::Relaxed);
        }

        res
    }

    pub(crate) fn len(&self) -> usize {
        self.connections.len()
    }
}
