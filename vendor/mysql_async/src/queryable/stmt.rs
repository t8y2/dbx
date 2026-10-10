// Copyright (c) 2017 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use crossbeam_utils::atomic::AtomicCell;
use futures_util::FutureExt;
use mysql_common::{
    io::ParseBuf,
    named_params::ParsedNamedParams,
    packets::{ComStmtClose, StmtPacket},
};

use std::{borrow::Cow, fmt, ptr::NonNull, sync::Arc};

use crate::{
    conn::routines::{ExecBulkRoutine, ExecRoutine, PrepareRoutine},
    consts::CapabilityFlags,
    error::*,
    Column, Params,
};

use super::AsQuery;

/// Result of a `StatementLike::to_statement` call.
pub enum ToStatementResult<'a> {
    /// Statement is immediately available.
    Immediate(Statement),
    /// We need some time to get a statement and the operation itself may fail.
    Mediate(crate::BoxFuture<'a, Statement>),
}

pub trait StatementLike: Send + Sync {
    /// Returns a statement.
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a;
}

fn to_statement_move<'a, T: AsQuery + 'a>(
    stmt: T,
    conn: &'a mut crate::Conn,
) -> ToStatementResult<'a> {
    let fut = async move {
        let query = stmt.as_query();
        let parsed = ParsedNamedParams::parse(query.as_ref())?;
        let inner_stmt = match conn.get_cached_stmt(parsed.query()) {
            Some(inner_stmt) => inner_stmt,
            None => {
                conn.prepare_statement(Cow::Borrowed(parsed.query()))
                    .await?
            }
        };
        Ok(Statement::new(
            inner_stmt,
            parsed
                .params()
                .iter()
                .map(|x| x.as_ref().to_vec())
                .collect::<Vec<_>>(),
        ))
    }
    .boxed();
    ToStatementResult::Mediate(fut)
}

impl StatementLike for Cow<'_, str> {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for &'_ str {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for String {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for Box<str> {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for Arc<str> {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for Cow<'_, [u8]> {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for &'_ [u8] {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for Vec<u8> {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for Box<[u8]> {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for Arc<[u8]> {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        to_statement_move(self, conn)
    }
}

impl StatementLike for Statement {
    fn to_statement<'a>(self, _conn: &'a mut crate::Conn) -> ToStatementResult<'static>
    where
        Self: 'a,
    {
        ToStatementResult::Immediate(self.clone())
    }
}

impl<T: StatementLike + Clone> StatementLike for &'_ T {
    fn to_statement<'a>(self, conn: &'a mut crate::Conn) -> ToStatementResult<'a>
    where
        Self: 'a,
    {
        self.clone().to_statement(conn)
    }
}

/// Statement data.
#[derive(Debug, Eq, PartialEq)]
pub struct StmtInner {
    pub(crate) raw_query: Arc<[u8]>,
    columns: Option<Arc<[Column]>>,
    /// This cached value overrides the column metadata stored in the `inner` field.
    ///
    /// See MARIADB_CLIENT_CACHE_METADATA capability.
    columns_cache: ColumnCache,
    params: Option<Box<[Column]>>,
    stmt_packet: StmtPacket,
    connection_id: u32,
}

impl StmtInner {
    pub(crate) fn from_payload(
        pld: &[u8],
        connection_id: u32,
        raw_query: Arc<[u8]>,
    ) -> std::io::Result<Self> {
        let stmt_packet = ParseBuf(pld).parse(())?;

        Ok(Self {
            raw_query,
            columns: None,
            columns_cache: ColumnCache::new(),
            params: None,
            stmt_packet,
            connection_id,
        })
    }

    pub(crate) fn with_params(mut self, params: Vec<Column>) -> Self {
        self.params = if params.is_empty() {
            None
        } else {
            Some(params.into_boxed_slice())
        };
        self
    }

    pub(crate) fn with_columns(mut self, columns: Vec<Column>) -> Self {
        self.columns = if columns.is_empty() {
            None
        } else {
            Some(Arc::from(columns))
        };
        self
    }

    pub(crate) fn columns(&self) -> Arc<[Column]> {
        self.columns_cache
            .get_columns()
            .or_else(|| self.columns.clone())
            .unwrap_or_default()
    }

    pub fn update_columns_metadata(&self, columns: Vec<Column>) {
        self.columns_cache.set_columns(columns);
    }

    pub(crate) fn params(&self) -> &[Column] {
        self.params.as_ref().map(AsRef::as_ref).unwrap_or(&[])
    }

    pub(crate) fn id(&self) -> u32 {
        self.stmt_packet.statement_id()
    }

    pub(crate) const fn connection_id(&self) -> u32 {
        self.connection_id
    }

    pub(crate) fn num_params(&self) -> u16 {
        self.stmt_packet.num_params()
    }

    pub(crate) fn num_columns(&self) -> u16 {
        self.stmt_packet.num_columns()
    }
}

/// Prepared statement.
///
/// Statement is only valid for connection with id `Statement::connection_id()`.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Statement {
    pub(crate) inner: Arc<StmtInner>,
    /// An empty vector in case of no named params.
    pub(crate) named_params: Vec<Vec<u8>>,
}

impl Statement {
    pub(crate) fn new(inner: Arc<StmtInner>, named_params: Vec<Vec<u8>>) -> Self {
        Self {
            inner,
            named_params,
        }
    }

    /// Returned columns.
    pub fn columns(&self) -> Arc<[Column]> {
        self.inner.columns()
    }

    /// Overrides columns metadata for this statement.
    ///
    /// See MARIADB_CLIENT_CACHE_METADATA capability.
    pub(crate) fn update_columns_metadata(&self, columns: Vec<Column>) {
        self.inner.update_columns_metadata(columns);
    }

    /// Required parameters.
    pub fn params(&self) -> &[Column] {
        self.inner.params()
    }

    /// MySql statement identifier.
    pub fn id(&self) -> u32 {
        self.inner.id()
    }

    /// MySql connection identifier.
    pub fn connection_id(&self) -> u32 {
        self.inner.connection_id()
    }

    /// Number of parameters.
    pub fn num_params(&self) -> u16 {
        self.inner.num_params()
    }

    /// Number of columns.
    pub fn num_columns(&self) -> u16 {
        self.inner.num_columns()
    }
}

impl crate::Conn {
    /// Low-level helpers, that reads the given number of column packets terminated by EOF packet.
    ///
    /// Requires `num > 0`.
    pub(crate) async fn read_column_defs<U>(&mut self, num: U) -> Result<Vec<Column>>
    where
        U: Into<usize>,
    {
        let num = num.into();
        debug_assert!(num > 0);
        let packets = self.read_packets(num).await?;
        let defs = packets
            .into_iter()
            .map(|x| ParseBuf(&x).parse(()))
            .collect::<std::result::Result<Vec<Column>, _>>()
            .map_err(Error::from)?;

        if !self.has_capabilities(CapabilityFlags::CLIENT_DEPRECATE_EOF) {
            self.read_packet().await?;
        }

        Ok(defs)
    }

    /// Helper, that retrieves `Statement` from `StatementLike`.
    pub(crate) async fn get_statement<U>(&mut self, stmt_like: U) -> Result<Statement>
    where
        U: StatementLike,
    {
        match stmt_like.to_statement(self) {
            ToStatementResult::Immediate(statement) => Ok(statement),
            ToStatementResult::Mediate(statement) => statement.await,
        }
    }

    /// Low-level helper, that prepares the given statement.
    ///
    /// `raw_query` is a query with `?` placeholders (if any).
    async fn prepare_statement(&mut self, raw_query: Cow<'_, [u8]>) -> Result<Arc<StmtInner>> {
        let inner_stmt = self.routine(PrepareRoutine::new(raw_query)).await?;

        if let Some(old_stmt) = self.cache_stmt(&inner_stmt) {
            self.close_statement(old_stmt.id()).await?;
        }

        Ok(inner_stmt)
    }

    /// Helper, that executes the given statement with the given params.
    pub(crate) async fn execute_statement<P>(
        &mut self,
        statement: &Statement,
        params: P,
    ) -> Result<()>
    where
        P: Into<Params>,
    {
        self.routine(ExecRoutine::new(statement, params.into()))
            .await?;
        Ok(())
    }

    /// Helper, that executes the given statement as a bulk operation
    ///
    /// Available in MariaDb with MARIADB_CLIENT_STMT_BULK_OPERATIONS capability.
    pub(crate) async fn execute_bulk<P, I>(
        &mut self,
        statement: &Statement,
        params: I,
    ) -> Result<()>
    where
        P: Into<Params> + Send,
        I: IntoIterator<Item = P> + Send,
        I::IntoIter: Send,
    {
        self.routine(ExecBulkRoutine::new(statement, params))
            .await?;
        Ok(())
    }

    /// Helper, that closes statement with the given id.
    pub(crate) async fn close_statement(&mut self, id: u32) -> Result<()> {
        self.stmt_cache_mut().remove(id);
        self.write_command(&ComStmtClose::new(id)).await
    }
}

/// This is to make raw Arc pointer Send and Sync
///
/// This splits fat `*const [Column]` pointer to its components
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
struct ColumnsArcPtr((NonNull<Column>, usize));

impl ColumnsArcPtr {
    fn from_arc(arc: Arc<[Column]>) -> Self {
        let len = arc.len();
        let ptr = Arc::into_raw(arc);
        // SAFETY: the `Arc` structure itself contains NonNull so this is either safe
        // or someone created a broken `Arc` using unsafe code.
        let ptr = unsafe { NonNull::new_unchecked(ptr as *const Column as *mut Column) };
        Self((ptr, len))
    }

    fn to_arc(self) -> Arc<[Column]> {
        let columns = self.into_arc();
        let clone = columns.clone();
        // ignore the pointer because it is already stored in self
        let _ = Arc::into_raw(columns);
        clone
    }

    fn into_arc(self) -> Arc<[Column]> {
        let fat_pointer = NonNull::slice_from_raw_parts(self.0 .0, self.0 .1);
        // SAFETY: non-null pointer always points to a valid Arc
        unsafe { Arc::from_raw(fat_pointer.as_ptr()) }
    }
}

unsafe impl Send for ColumnsArcPtr {}
unsafe impl Sync for ColumnsArcPtr {}

struct ColumnCache {
    columns: AtomicCell<Option<ColumnsArcPtr>>,
}

impl ColumnCache {
    fn new() -> Self {
        Self {
            columns: AtomicCell::new(None),
        }
    }

    fn get_columns(&self) -> Option<Arc<[Column]>> {
        self.columns.load().map(|x| x.to_arc())
    }

    fn set_columns(&self, new_columns: Vec<Column>) {
        let new_columns: Arc<[Column]> = new_columns.into();
        let new_ptr = ColumnsArcPtr::from_arc(new_columns);

        let Some(old_ptr) = self.columns.swap(Some(new_ptr)) else {
            return;
        };

        // drop the old `Arc`
        old_ptr.into_arc();
    }
}

impl fmt::Debug for ColumnCache {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ColumnCache")
            .field("columns", &self.get_columns())
            .finish()
    }
}

impl PartialEq for ColumnCache {
    fn eq(&self, other: &Self) -> bool {
        self.get_columns() == other.get_columns()
    }
}

impl Eq for ColumnCache {}

impl Drop for ColumnCache {
    fn drop(&mut self) {
        // drop `Arc` if any
        self.columns.load().map(|x| x.into_arc());
    }
}
