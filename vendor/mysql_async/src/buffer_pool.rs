// Copyright (c) 2021 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use crossbeam_queue::ArrayQueue;
use std::{mem::take, ops::Deref, sync::Arc};

#[derive(Debug)]
pub struct BufferPool {
    buffer_size_cap: usize,
    buffer_init_cap: usize,
    pool: ArrayQueue<Vec<u8>>,
}

impl BufferPool {
    pub fn new() -> Self {
        let pool_cap = std::env::var("MYSQL_ASYNC_BUFFER_POOL_CAP")
            .ok()
            .and_then(|x| x.parse().ok())
            .unwrap_or(128_usize);

        let buffer_size_cap = std::env::var("MYSQL_ASYNC_BUFFER_SIZE_CAP")
            .ok()
            .and_then(|x| x.parse().ok())
            .unwrap_or(4 * 1024 * 1024);

        let buffer_init_cap = std::env::var("MYSQL_ASYNC_BUFFER_INIT_CAP")
            .ok()
            .and_then(|x| x.parse().ok())
            .unwrap_or(0);

        Self {
            pool: ArrayQueue::new(pool_cap),
            buffer_size_cap,
            buffer_init_cap,
        }
    }

    pub fn get(self: &Arc<Self>) -> PooledBuf {
        let buf = self
            .pool
            .pop()
            .unwrap_or_else(|| Vec::with_capacity(self.buffer_init_cap));
        debug_assert_eq!(buf.len(), 0);
        PooledBuf(buf, self.clone())
    }

    pub fn get_with<T: AsRef<[u8]>>(self: &Arc<Self>, content: T) -> PooledBuf {
        let mut buf = self.get();
        buf.as_mut().extend_from_slice(content.as_ref());
        buf
    }

    fn put(self: &Arc<Self>, mut buf: Vec<u8>) {
        // SAFETY:
        // 1. OK – 0 is always within capacity
        // 2. OK - nothing to initialize
        unsafe { buf.set_len(0) }

        buf.shrink_to(self.buffer_size_cap);

        // ArrayQueue will make sure to drop the buffer if capacity is exceeded
        let _ = self.pool.push(buf);
    }
}

impl Default for BufferPool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
pub struct PooledBuf(Vec<u8>, Arc<BufferPool>);

impl AsMut<Vec<u8>> for PooledBuf {
    fn as_mut(&mut self) -> &mut Vec<u8> {
        &mut self.0
    }
}

impl Deref for PooledBuf {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.0.deref()
    }
}

impl Drop for PooledBuf {
    fn drop(&mut self) {
        self.1.put(take(&mut self.0))
    }
}
