use crate::MetaDataColumn;
use bytes::buf::UninitSlice;
use bytes::{BufMut, BytesMut};
use std::borrow::{Borrow, BorrowMut};
use std::ops::{Deref, DerefMut};

pub(crate) struct BytesMutWithDataColumns<'a> {
    bytes: &'a mut BytesMut,
    data_columns: &'a Vec<MetaDataColumn<'a>>,
}

impl<'a> BytesMutWithDataColumns<'a> {
    pub fn new(bytes: &'a mut BytesMut, data_columns: &'a Vec<MetaDataColumn<'a>>) -> Self {
        BytesMutWithDataColumns {
            bytes,
            data_columns,
        }
    }

    pub fn data_columns(&self) -> &'a Vec<MetaDataColumn<'a>> {
        self.data_columns
    }
}

unsafe impl<'a> BufMut for BytesMutWithDataColumns<'a> {
    fn remaining_mut(&self) -> usize {
        self.bytes.remaining_mut()
    }

    unsafe fn advance_mut(&mut self, cnt: usize) {
        self.bytes.advance_mut(cnt)
    }

    fn chunk_mut(&mut self) -> &mut UninitSlice {
        self.bytes.chunk_mut()
    }
}

impl<'a> Borrow<[u8]> for BytesMutWithDataColumns<'a> {
    fn borrow(&self) -> &[u8] {
        self.bytes.deref()
    }
}

impl<'a> BorrowMut<[u8]> for BytesMutWithDataColumns<'a> {
    fn borrow_mut(&mut self) -> &mut [u8] {
        self.bytes.borrow_mut()
    }
}

impl<'a> Deref for BytesMutWithDataColumns<'a> {
    type Target = BytesMut;

    fn deref(&self) -> &Self::Target {
        self.bytes
    }
}

impl<'a> DerefMut for BytesMutWithDataColumns<'a> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.bytes
    }
}
