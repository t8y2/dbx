// Copyright (c) 2020 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use futures_core::ready;
use mysql_common::{
    binlog::{
        consts::{BinlogVersion::Version4, EventType},
        events::{Event, TableMapEvent, TransactionPayloadEvent},
        EventStreamReader,
    },
    io::ParseBuf,
    packets::{ComRegisterSlave, ErrPacket, NetworkStreamTerminator, OkPacketDeserializer},
};

use std::{
    future::Future,
    io::{Cursor, ErrorKind},
    pin::Pin,
    task::{Context, Poll},
};

use crate::{connection_like::ConnectionInner, queryable::Queryable};
use crate::{error::DriverError, io::ReadPacket, Conn, Error, IoError, Result};

use self::request::BinlogStreamRequest;

pub mod request;

impl super::Conn {
    /// Turns this connection into a binlog stream.
    ///
    /// You can use SHOW BINARY LOGS to get the current logfile and position from the master.
    /// If the request’s filename is empty, the server will send the binlog-stream of the first known binlog.
    pub async fn get_binlog_stream(
        mut self,
        request: BinlogStreamRequest<'_>,
    ) -> Result<BinlogStream> {
        self.request_binlog(request).await?;

        Ok(BinlogStream::new(self))
    }

    async fn register_as_slave(
        &mut self,
        com_register_slave: ComRegisterSlave<'_>,
    ) -> crate::Result<()> {
        self.query_drop("SET @master_binlog_checksum='ALL'").await?;
        self.write_command(&com_register_slave).await?;

        // Server will respond with OK.
        self.read_packet().await?;

        Ok(())
    }

    async fn request_binlog(&mut self, request: BinlogStreamRequest<'_>) -> crate::Result<()> {
        self.register_as_slave(request.register_slave).await?;
        self.write_command(&request.binlog_request.as_cmd()).await?;
        Ok(())
    }
}

/// Binlog event stream.
///
/// Stream initialization is lazy, i.e. binlog won't be requested until this stream is polled.
pub struct BinlogStream {
    read_packet: ReadPacket<'static, 'static>,
    esr: EventStreamReader,
    // TODO: Use 'static reader here (requires impl on the mysql_common side).
    /// Uncompressed Transaction_payload_event we are iterating over (if any).
    tpe: Option<Cursor<Vec<u8>>>,
}

impl BinlogStream {
    /// `conn` is a `Conn` with `request_binlog` executed on it.
    pub(super) fn new(conn: Conn) -> Self {
        BinlogStream {
            read_packet: ReadPacket::new(conn),
            esr: EventStreamReader::new(Version4),
            tpe: None,
        }
    }

    /// Returns a table map event for the given table id.
    pub fn get_tme(&self, table_id: u64) -> Option<&TableMapEvent<'static>> {
        self.esr.get_tme(table_id)
    }

    /// Closes the stream's `Conn`. Additionally, the connection is dropped, so its associated
    /// pool (if any) will regain a connection slot.
    pub async fn close(self) -> Result<()> {
        match self.read_packet.0.inner {
            // `close_conn` requires ownership of `Conn`. That's okay, because
            // `BinLogStream`'s connection is always owned.
            ConnectionInner::Conn(conn) => {
                if let Err(Error::Io(IoError::Io(ref error))) = conn.close_conn().await {
                    // If the binlog was requested with the flag BINLOG_DUMP_NON_BLOCK,
                    // the connection's file handler will already have been closed (EOF).
                    if error.kind() == ErrorKind::BrokenPipe {
                        return Ok(());
                    }
                }
            }
            ConnectionInner::ConnMut(_) => {}
            ConnectionInner::Tx(_) => {}
        }

        Ok(())
    }
}

impl futures_core::stream::Stream for BinlogStream {
    type Item = Result<Event>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        {
            let Self {
                ref mut tpe,
                ref mut esr,
                ..
            } = *self;

            if let Some(tpe) = tpe.as_mut() {
                match esr.read_decompressed(tpe) {
                    Ok(Some(event)) => return Poll::Ready(Some(Ok(event))),
                    Ok(None) => self.tpe = None,
                    Err(err) => return Poll::Ready(Some(Err(err.into()))),
                }
            }
        }

        let packet = match ready!(Pin::new(&mut self.read_packet).poll(cx)) {
            Ok(packet) => packet,
            Err(err) => return Poll::Ready(Some(Err(err.into()))),
        };

        let first_byte = packet.first().copied();

        if first_byte == Some(255) {
            if let Ok(ErrPacket::Error(err)) =
                ParseBuf(&packet).parse(self.read_packet.conn_ref().capabilities())
            {
                return Poll::Ready(Some(Err(From::from(err))));
            }
        }

        if first_byte == Some(254)
            && packet.len() < 8
            && ParseBuf(&packet)
                .parse::<OkPacketDeserializer<NetworkStreamTerminator>>(
                    self.read_packet.conn_ref().capabilities(),
                )
                .is_ok()
        {
            return Poll::Ready(None);
        }

        if first_byte == Some(0) {
            let event_data = &packet[1..];
            match self.esr.read(event_data) {
                Ok(Some(event)) => {
                    if event.header().event_type_raw() == EventType::TRANSACTION_PAYLOAD_EVENT as u8
                    {
                        #[allow(clippy::single_match)]
                        match event.read_event::<TransactionPayloadEvent<'_>>() {
                            Ok(e) => self.tpe = Some(Cursor::new(e.danger_decompress())),
                            Err(_) => (/* TODO: Log the error */),
                        }
                    }
                    Poll::Ready(Some(Ok(event)))
                }
                Ok(None) => Poll::Ready(None),
                Err(err) => Poll::Ready(Some(Err(err.into()))),
            }
        } else {
            Poll::Ready(Some(Err(DriverError::UnexpectedPacket {
                payload: packet.to_vec(),
            }
            .into())))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::StreamExt;
    use mysql_common::binlog::events::EventData;
    use tokio::time::timeout;

    use crate::prelude::*;
    use crate::{test_misc::get_opts, *};

    async fn gen_dummy_data(conn: &mut Conn) -> super::Result<()> {
        "CREATE TABLE IF NOT EXISTS customers (customer_id int not null)"
            .ignore(&mut *conn)
            .await?;

        let mut tx = conn.start_transaction(Default::default()).await?;
        for i in 0_u8..100 {
            "INSERT INTO customers(customer_id) VALUES (?)"
                .with((i,))
                .ignore(&mut tx)
                .await?;
        }
        tx.commit().await?;

        "DROP TABLE customers".ignore(conn).await?;

        Ok(())
    }

    async fn create_binlog_stream_conn(pool: Option<&Pool>) -> super::Result<(Conn, Vec<u8>, u64)> {
        let mut conn = match pool {
            None => Conn::new(get_opts()).await.unwrap(),
            Some(pool) => pool.get_conn().await.unwrap(),
        };

        if conn.server_version() >= (8, 0, 31) && conn.server_version() < (9, 0, 0) {
            let _ = "SET binlog_transaction_compression=ON"
                .ignore(&mut conn)
                .await;
        }

        if let Ok(Some(gtid_mode)) = "SELECT @@GLOBAL.GTID_MODE"
            .first::<String, _>(&mut conn)
            .await
        {
            if !gtid_mode.starts_with("ON") {
                panic!(
                    "GTID_MODE is disabled \
                        (enable using --gtid_mode=ON --enforce_gtid_consistency=ON)"
                );
            }
        }

        let row: crate::Row = "SHOW BINARY LOGS".first(&mut conn).await.unwrap().unwrap();
        let filename = row.get(0).unwrap();
        let position = row.get(1).unwrap();

        gen_dummy_data(&mut conn).await.unwrap();
        Ok((conn, filename, position))
    }

    #[tokio::test]
    async fn should_read_binlog() -> super::Result<()> {
        read_binlog_streams_and_close_their_connections(None, (12, 13, 14))
            .await
            .unwrap();

        let pool = Pool::new(get_opts());
        read_binlog_streams_and_close_their_connections(Some(&pool), (15, 16, 17))
            .await
            .unwrap();

        // Disconnecting the pool verifies that closing the binlog connections
        // left the pool in a sane state.
        timeout(Duration::from_secs(10), pool.disconnect())
            .await
            .unwrap()
            .unwrap();

        Ok(())
    }

    async fn read_binlog_streams_and_close_their_connections(
        pool: Option<&Pool>,
        binlog_server_ids: (u32, u32, u32),
    ) -> super::Result<()> {
        // iterate using COM_BINLOG_DUMP
        let (conn, filename, pos) = create_binlog_stream_conn(pool).await.unwrap();
        let is_mariadb = conn.inner.is_mariadb;

        let mut binlog_stream = conn
            .get_binlog_stream(
                BinlogStreamRequest::new(binlog_server_ids.0)
                    .with_filename(&filename)
                    .with_pos(pos),
            )
            .await
            .unwrap();

        let mut events_num = 0;
        while let Ok(Some(event)) = timeout(Duration::from_secs(10), binlog_stream.next()).await {
            let event = event.unwrap();
            events_num += 1;

            // assert that event type is known
            event.header().event_type().unwrap();

            // iterate over rows of an event
            if let EventData::RowsEvent(re) = event.read_data()?.unwrap() {
                let tme = binlog_stream.get_tme(re.table_id());
                for row in re.rows(tme.unwrap()) {
                    row.unwrap();
                }
            }
        }
        assert!(events_num > 0);
        timeout(Duration::from_secs(10), binlog_stream.close())
            .await
            .unwrap()
            .unwrap();

        if !is_mariadb {
            // iterate using COM_BINLOG_DUMP_GTID
            let (conn, filename, pos) = create_binlog_stream_conn(pool).await.unwrap();

            let mut binlog_stream = conn
                .get_binlog_stream(
                    BinlogStreamRequest::new(binlog_server_ids.1)
                        .with_gtid()
                        .with_filename(&filename)
                        .with_pos(pos),
                )
                .await
                .unwrap();

            events_num = 0;
            while let Ok(Some(event)) = timeout(Duration::from_secs(10), binlog_stream.next()).await
            {
                let event = event.unwrap();
                events_num += 1;

                // assert that event type is known
                event.header().event_type().unwrap();

                // iterate over rows of an event
                if let EventData::RowsEvent(re) = event.read_data()?.unwrap() {
                    let tme = binlog_stream.get_tme(re.table_id());
                    for row in re.rows(tme.unwrap()) {
                        row.unwrap();
                    }
                }
            }
            assert!(events_num > 0);
            timeout(Duration::from_secs(10), binlog_stream.close())
                .await
                .unwrap()
                .unwrap();
        }

        // iterate using COM_BINLOG_DUMP with BINLOG_DUMP_NON_BLOCK flag
        let (conn, filename, pos) = create_binlog_stream_conn(pool).await.unwrap();

        let mut binlog_stream = conn
            .get_binlog_stream(
                BinlogStreamRequest::new(binlog_server_ids.2)
                    .with_filename(&filename)
                    .with_pos(pos)
                    .with_non_blocking(),
            )
            .await
            .unwrap();

        events_num = 0;
        while let Some(event) = binlog_stream.next().await {
            let event = event.unwrap();
            events_num += 1;
            event.header().event_type().unwrap();
            event.read_data().unwrap();
        }
        assert!(events_num > 0);
        timeout(Duration::from_secs(10), binlog_stream.close())
            .await
            .unwrap()
            .unwrap();

        Ok(())
    }
}
