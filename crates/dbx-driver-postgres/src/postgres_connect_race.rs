//! RFC 8305-style (Happy Eyeballs) address racing for PostgreSQL connections.
//!
//! `tokio_postgres::Config::connect` resolves a hostname and then tries the
//! resolved addresses strictly sequentially: one unreachable address (for
//! example a broken NAT64 IPv6 route) consumes the entire connect timeout
//! before the next address is attempted, so the connection fails even though
//! a later address would succeed (#10955).
//!
//! `race_staggered` instead launches one full attempt per target — the next
//! attempt only after [`HAPPY_EYEBALLS_STAGGER`] has elapsed since the
//! previous launch, and immediately when an earlier attempt fails outright —
//! and keeps the first successful attempt. Attempts that are still in flight
//! when one succeeds are simply dropped, which closes their sockets.

use std::future::Future;
use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

use tokio::time::Instant;

/// Delay before the next address attempt starts while earlier attempts are
/// still in flight. RFC 8305 recommends 250 ms for dual-stack hosts.
pub(crate) const HAPPY_EYEBALLS_STAGGER: Duration = Duration::from_millis(250);

type Attempt<T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send>>;

enum Step<K, T, E> {
    Success(K, T),
    Failed(E),
}

/// Races the given targets, staggered: attempt *n* starts
/// [`HAPPY_EYEBALLS_STAGGER`] after attempt *n-1* only while earlier attempts
/// are still in flight — a failed attempt retires immediately and the next
/// target launches right away, mirroring RFC 8305's guidance to move on
/// without waiting once an address answered negatively. The first successful
/// attempt wins the race; the last error is returned when every attempt has
/// failed. There is no internal deadline: callers bound the race by dropping
/// the returned future (the surrounding connection-timeout wrapper does that).
pub(crate) async fn race_staggered<K, T, E>(
    targets: Vec<K>,
    mut make_attempt: impl FnMut(K) -> Attempt<T, E>,
) -> Result<(K, T), E>
where
    K: Send + Copy,
    T: Send,
    E: Send,
{
    assert!(!targets.is_empty(), "race_staggered needs at least one target");
    let mut remaining: Vec<K> = targets;
    let mut attempts: Vec<(K, Attempt<T, E>)> = Vec::new();
    let mut last_err: Option<E> = None;
    // First attempt launches immediately; the next one is paced by the stagger.
    let mut next_launch = Instant::now();

    loop {
        if !remaining.is_empty() && Instant::now() >= next_launch {
            let target = remaining.remove(0);
            let attempt = make_attempt(target);
            attempts.push((target, attempt));
            next_launch = Instant::now() + HAPPY_EYEBALLS_STAGGER;
        }

        if attempts.is_empty() {
            if remaining.is_empty() {
                return Err(last_err.expect("at least one attempt has failed"));
            }
            tokio::time::sleep_until(next_launch).await;
            continue;
        }

        // One poll pass retires failed attempts so the loop can launch the
        // next target right away; pending attempts stay registered with the
        // waker and keep the pass pending.
        let step = std::future::poll_fn(|cx| {
            let mut idx = 0;
            while idx < attempts.len() {
                let (target, mut attempt) = attempts.swap_remove(idx);
                match attempt.as_mut().poll(cx) {
                    Poll::Ready(Ok(value)) => return Poll::Ready(Some(Step::Success(target, value))),
                    Poll::Ready(Err(err)) => return Poll::Ready(Some(Step::Failed(err))),
                    Poll::Pending => {
                        attempts.insert(idx, (target, attempt));
                        idx += 1;
                    }
                }
            }
            Poll::Pending
        });

        if remaining.is_empty() {
            // Every target is already in flight, so there is no stagger timer
            // left to arm — waiting is driven by the attempts alone.
            match step.await {
                Some(Step::Success(target, value)) => return Ok((target, value)),
                Some(Step::Failed(err)) => last_err = Some(err),
                None => unreachable!("the poll pass resolves only per settled attempt"),
            }
        } else {
            let wake_at = next_launch;
            tokio::select! {
                biased;
                step = step => match step {
                    Some(Step::Success(target, value)) => return Ok((target, value)),
                    Some(Step::Failed(err)) => {
                        last_err = Some(err);
                        next_launch = Instant::now();
                    }
                    None => unreachable!("the poll pass resolves only per settled attempt"),
                },
                _ = tokio::time::sleep_until(wake_at) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// Test attempt: TCP connect, one "ping" write, one reply byte. A server
    /// that accepts but never replies keeps the attempt in flight forever,
    /// which is exactly the blackhole behavior being raced against.
    async fn ping_attempt(addr: SocketAddr) -> io::Result<()> {
        let mut stream = TcpStream::connect(addr).await?;
        stream.write_all(b"ping").await?;
        let mut reply = [0u8; 1];
        stream.read_exact(&mut reply).await?;
        Ok(())
    }

    fn make_ping_attempt(addr: SocketAddr) -> Attempt<(), io::Error> {
        Box::pin(async move { ping_attempt(addr).await })
    }

    /// Accepts every connection, replies "x", and counts accepts.
    async fn spawn_echo_server(listener: TcpListener, accepts: Option<Arc<AtomicUsize>>) {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            if let Some(accepts) = &accepts {
                accepts.fetch_add(1, Ordering::SeqCst);
            }
            tokio::spawn(async move {
                let mut ping = [0u8; 4];
                let _ = socket.read_exact(&mut ping).await;
                let _ = socket.write_all(b"x").await;
                // Hold the socket open until the peer closes it.
                let mut drained = [0u8; 16];
                while let Ok(read) = socket.read(&mut drained).await {
                    if read == 0 {
                        break;
                    }
                }
            });
        }
    }

    /// Accepts connections and holds them without replying (stalled attempt).
    async fn spawn_silent_server(listener: TcpListener) {
        loop {
            if let Ok((socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    // Hold the accepted socket open forever; the client's read
                    // blocks, keeping its attempt in flight.
                    std::future::pending::<()>().await;
                    drop(socket);
                });
            }
        }
    }

    async fn bind_echo(accepts: Option<Arc<AtomicUsize>>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind echo server");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(spawn_echo_server(listener, accepts));
        addr
    }

    async fn bind_silent() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind silent server");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(spawn_silent_server(listener));
        addr
    }

    #[tokio::test]
    async fn stalled_first_address_falls_back_to_the_next_one() {
        let stalled = bind_silent().await;
        let healthy = bind_echo(None).await;

        let started = Instant::now();
        let (winner, ()) = race_staggered(vec![stalled, healthy], |addr| make_ping_attempt(addr))
            .await
            .expect("healthy address should win the race");

        assert_eq!(winner, healthy);
        // The winner comes from the staggered second attempt, not the first.
        assert!(started.elapsed() >= HAPPY_EYEBALLS_STAGGER, "fallback should respect the stagger");
        assert!(started.elapsed() < Duration::from_secs(10), "fallback should not wait for the stalled attempt");
    }

    #[tokio::test]
    async fn healthy_first_address_wins_immediately() {
        let healthy = bind_echo(None).await;
        let never_tried = bind_silent().await;

        let started = Instant::now();
        let (winner, ()) = race_staggered(vec![healthy, never_tried], |addr| make_ping_attempt(addr))
            .await
            .expect("healthy first address should win immediately");

        assert_eq!(winner, healthy);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn failing_attempts_retire_immediately_until_one_succeeds() {
        // Ports with no listener: connections are refused instantly.
        let refused_a = bind_silent_drop().await;
        let refused_b = bind_silent_drop().await;
        let healthy = bind_echo(None).await;

        let started = Instant::now();
        let (winner, ()) = race_staggered(vec![refused_a, refused_b, healthy], |addr| make_ping_attempt(addr))
            .await
            .expect("healthy address should win after refusals");

        assert_eq!(winner, healthy);
        assert!(started.elapsed() < Duration::from_secs(10), "refusals must not pace the race");
    }

    #[tokio::test]
    async fn all_attempts_failing_returns_the_last_error() {
        let refused_a = bind_silent_drop().await;
        let refused_b = bind_silent_drop().await;

        let started = Instant::now();
        let result: Result<(SocketAddr, ()), io::Error> =
            race_staggered(vec![refused_a, refused_b], |addr| make_ping_attempt(addr)).await;

        assert!(result.is_err(), "every address refuses");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn every_attempt_stalled_is_cancellable_by_the_caller() {
        let stalled_a = bind_silent().await;
        let stalled_b = bind_silent().await;

        // No internal deadline: the caller's connection-timeout wrapper bounds
        // the race by dropping it, exactly like the pool's create timeout.
        let raced = tokio::time::timeout(
            Duration::from_millis(500),
            race_staggered(vec![stalled_a, stalled_b], |addr| make_ping_attempt(addr)),
        )
        .await;

        assert!(raced.is_err(), "stalled race must stay cancellable, not resolve");
    }

    #[tokio::test]
    async fn mixed_refusal_stall_and_success_races_to_the_healthy_address() {
        let refused = bind_silent_drop().await;
        let stalled = bind_silent().await;
        let healthy = bind_echo(None).await;

        let (winner, ()) = race_staggered(vec![refused, stalled, healthy], |addr| make_ping_attempt(addr))
            .await
            .expect("healthy address should win");

        assert_eq!(winner, healthy);
    }

    /// Binds a port and immediately drops the listener so connections to it
    /// are refused.
    async fn bind_silent_drop() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind refused port");
        listener.local_addr().expect("local addr")
    }
}
