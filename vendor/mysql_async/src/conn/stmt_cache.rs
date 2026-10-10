// Copyright (c) 2017 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use lru::LruCache;
use twox_hash::XxHash64;

use std::{
    borrow::Borrow,
    collections::HashMap,
    hash::{BuildHasherDefault, Hash},
    sync::Arc,
};

use crate::queryable::stmt::StmtInner;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct QueryString(pub Arc<[u8]>);

impl Borrow<[u8]> for QueryString {
    fn borrow(&self) -> &[u8] {
        self.0.as_ref()
    }
}

impl PartialEq<[u8]> for QueryString {
    fn eq(&self, other: &[u8]) -> bool {
        self.0.as_ref() == other
    }
}

pub struct Entry {
    pub stmt: Arc<StmtInner>,
    pub query: QueryString,
}

#[derive(Debug)]
pub struct StmtCache {
    cap: usize,
    cache: LruCache<u32, Entry>,
    query_map: HashMap<QueryString, u32, BuildHasherDefault<XxHash64>>,
}

impl StmtCache {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            cache: LruCache::unbounded(),
            query_map: Default::default(),
        }
    }

    pub fn by_query<T>(&mut self, query: &T) -> Option<&Entry>
    where
        QueryString: Borrow<T>,
        QueryString: PartialEq<T>,
        T: Hash + Eq,
        T: ?Sized,
    {
        let id = self.query_map.get(query).cloned();
        match id {
            Some(id) => self.cache.get(&id),
            None => None,
        }
    }

    pub fn put(&mut self, query: Arc<[u8]>, stmt: Arc<StmtInner>) -> Option<Arc<StmtInner>> {
        if self.cap == 0 {
            return None;
        }

        let query = QueryString(query);

        self.query_map.insert(query.clone(), stmt.id());
        self.cache.put(stmt.id(), Entry { stmt, query });

        if self.cache.len() > self.cap {
            if let Some((_, entry)) = self.cache.pop_lru() {
                self.query_map.remove(entry.query.0.as_ref());
                return Some(entry.stmt);
            }
        }

        None
    }

    pub fn clear(&mut self) {
        self.query_map.clear();
        self.cache.clear();
    }

    pub fn remove(&mut self, id: u32) {
        if let Some(entry) = self.cache.pop(&id) {
            self.query_map.remove::<[u8]>(entry.query.borrow());
        }
    }

    #[cfg(test)]
    pub fn iter(&self) -> impl Iterator<Item = (&u32, &Entry)> {
        self.cache.iter()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.cache.len()
    }
}

impl super::Conn {
    #[cfg(test)]
    pub(crate) fn stmt_cache_ref(&self) -> &StmtCache {
        &self.inner.stmt_cache
    }

    pub(crate) fn stmt_cache_mut(&mut self) -> &mut StmtCache {
        &mut self.inner.stmt_cache
    }

    /// Caches the given statement.
    ///
    /// Returns LRU statement on cache capacity overflow.
    pub(crate) fn cache_stmt(&mut self, stmt: &Arc<StmtInner>) -> Option<Arc<StmtInner>> {
        let query = stmt.raw_query.clone();
        if self.inner.opts.stmt_cache_size() > 0 {
            self.stmt_cache_mut().put(query, stmt.clone())
        } else {
            None
        }
    }

    /// Returns statement, if cached.
    ///
    /// `raw_query` is the query with `?` placeholders (not with `:<name>` placeholders).
    pub(crate) fn get_cached_stmt(&mut self, raw_query: &[u8]) -> Option<Arc<StmtInner>> {
        self.stmt_cache_mut()
            .by_query(raw_query)
            .map(|entry| entry.stmt.clone())
    }
}
