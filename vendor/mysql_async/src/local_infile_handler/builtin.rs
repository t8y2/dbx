// Copyright (c) 2016 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use futures_util::FutureExt;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use crate::{
    error::LocalInfileError,
    local_infile_handler::{BoxFuture, GlobalHandler},
};

/// Handles `LOCAL INFILE` requests from filesystem using an explicit whitelist of paths.
///
/// Example usage:
///
/// ```rust
/// use mysql_async::{OptsBuilder, WhiteListFsHandler};
///
/// # let database_url = "mysql://root:password@127.0.0.1:3307/mysql";
/// let mut opts = OptsBuilder::from_opts(database_url);
/// opts.local_infile_handler(Some(WhiteListFsHandler::new(
///     &["path/to/local_infile.txt"][..],
/// )));
/// ```
#[derive(Clone, Debug)]
pub struct WhiteListFsHandler {
    white_list: HashSet<PathBuf>,
}

impl WhiteListFsHandler {
    pub fn new<A, B>(white_list: B) -> WhiteListFsHandler
    where
        A: Into<PathBuf>,
        B: IntoIterator<Item = A>,
    {
        let mut white_list_set = HashSet::new();
        for path in white_list.into_iter() {
            white_list_set.insert(Into::<PathBuf>::into(path));
        }
        WhiteListFsHandler {
            white_list: white_list_set,
        }
    }
}

impl GlobalHandler for WhiteListFsHandler {
    fn handle(&self, file_name: &[u8]) -> BoxFuture<'static, super::InfileData> {
        let path = String::from_utf8_lossy(file_name);
        let path = self
            .white_list
            .get(Path::new(&*path))
            .cloned()
            .ok_or_else(|| LocalInfileError::PathIsNotInTheWhiteList(path.into_owned()));
        async move {
            let file = File::open(path?).await?;
            Ok(Box::pin(ReaderStream::new(file)) as super::InfileData)
        }
        .boxed()
    }
}
