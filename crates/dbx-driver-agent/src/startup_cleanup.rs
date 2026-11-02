use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

#[derive(Clone)]
pub struct StartupCleanup {
    inner: Arc<Inner>,
}

pub struct StartupCleanupGuard {
    inner: Arc<Inner>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartupCleanupSnapshot {
    pub producer_closed: bool,
    pub children_started: usize,
    pub children_exited: usize,
    pub children_with_wait_failure: usize,
    pub reservations_pending: usize,
    pub reservations_transferred: usize,
}

impl StartupCleanupSnapshot {
    pub fn is_settled(&self) -> bool {
        self.producer_closed && self.children_started == self.children_exited && self.reservations_pending == 0
    }
}

struct Inner {
    state: Mutex<State>,
    changed: Notify,
}

#[derive(Default)]
struct State {
    producer_closed: bool,
    children: Vec<ChildState>,
    reservations: Vec<ReservationState>,
}

#[derive(Default)]
struct ChildState {
    exited: bool,
    wait_failed: bool,
}

enum ReservationState {
    Pending,
    Removed,
    Transferred,
}

#[derive(Clone)]
pub(crate) struct StartupChildExit {
    inner: Arc<Inner>,
    index: usize,
}

pub(crate) struct StartupReservationCleanup {
    inner: Arc<Inner>,
    index: usize,
}

impl StartupCleanup {
    pub fn new_pair() -> (StartupCleanupGuard, Self) {
        let inner = Arc::new(Inner { state: Mutex::new(State::default()), changed: Notify::new() });
        (StartupCleanupGuard { inner: inner.clone() }, Self { inner })
    }

    pub fn snapshot(&self) -> StartupCleanupSnapshot {
        let state = self.inner.state.lock().unwrap_or_else(|error| error.into_inner());
        StartupCleanupSnapshot {
            producer_closed: state.producer_closed,
            children_started: state.children.len(),
            children_exited: state.children.iter().filter(|child| child.exited).count(),
            children_with_wait_failure: state.children.iter().filter(|child| child.wait_failed).count(),
            reservations_pending: state
                .reservations
                .iter()
                .filter(|state| matches!(state, ReservationState::Pending))
                .count(),
            reservations_transferred: state
                .reservations
                .iter()
                .filter(|state| matches!(state, ReservationState::Transferred))
                .count(),
        }
    }

    pub async fn wait_until_settled(&self) {
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.snapshot().is_settled() {
                return;
            }
            notified.await;
        }
    }
}

impl StartupCleanupGuard {
    pub(crate) fn child_started(&self) -> StartupChildExit {
        let mut state = self.inner.state.lock().unwrap_or_else(|error| error.into_inner());
        let index = state.children.len();
        state.children.push(ChildState::default());
        StartupChildExit { inner: self.inner.clone(), index }
    }

    pub(crate) fn reservation_started(&self) -> StartupReservationCleanup {
        let mut state = self.inner.state.lock().unwrap_or_else(|error| error.into_inner());
        let index = state.reservations.len();
        state.reservations.push(ReservationState::Pending);
        StartupReservationCleanup { inner: self.inner.clone(), index }
    }
}

impl Drop for StartupCleanupGuard {
    fn drop(&mut self) {
        self.inner.state.lock().unwrap_or_else(|error| error.into_inner()).producer_closed = true;
        self.inner.changed.notify_waiters();
    }
}

impl StartupChildExit {
    pub(crate) fn is_confirmed(&self) -> bool {
        self.inner.state.lock().unwrap_or_else(|error| error.into_inner()).children[self.index].exited
    }

    pub(crate) fn wait_finished(&self, confirmed: bool) {
        let mut state = self.inner.state.lock().unwrap_or_else(|error| error.into_inner());
        let child = &mut state.children[self.index];
        if confirmed {
            child.exited = true;
        } else {
            child.wait_failed = true;
        }
        drop(state);
        self.inner.changed.notify_waiters();
    }
}

impl StartupReservationCleanup {
    pub(crate) fn removed(self) {
        self.finish(ReservationState::Removed);
    }

    pub(crate) fn transferred(self) {
        self.finish(ReservationState::Transferred);
    }

    fn finish(self, result: ReservationState) {
        self.inner.state.lock().unwrap_or_else(|error| error.into_inner()).reservations[self.index] = result;
        self.inner.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpolled_future_drop_closes_an_empty_producer() {
        let (guard, cleanup) = StartupCleanup::new_pair();
        let future = async move { drop(guard) };
        assert!(!cleanup.snapshot().is_settled());
        drop(future);
        assert!(cleanup.snapshot().is_settled());
    }

    #[tokio::test]
    async fn retries_wait_for_every_child_and_actual_reservation_cleanup() {
        let (guard, cleanup) = StartupCleanup::new_pair();
        let first = guard.child_started();
        let second = guard.child_started();
        let reservation = guard.reservation_started();
        drop(guard);
        second.wait_finished(true);
        first.wait_finished(false);
        assert_eq!(cleanup.snapshot().children_exited, 1);
        assert_eq!(cleanup.snapshot().children_with_wait_failure, 1);
        assert!(!cleanup.snapshot().is_settled());
        first.wait_finished(true);
        assert!(!cleanup.snapshot().is_settled());
        reservation.removed();
        cleanup.wait_until_settled().await;
        assert!(cleanup.snapshot().is_settled());
    }

    #[test]
    fn channel_handoff_does_not_confirm_child_exit() {
        let (guard, cleanup) = StartupCleanup::new_pair();
        let child = guard.child_started();
        guard.reservation_started().transferred();
        drop(guard);
        assert_eq!(cleanup.snapshot().reservations_transferred, 1);
        assert!(!cleanup.snapshot().is_settled());
        child.wait_finished(true);
        child.wait_finished(true);
        assert_eq!(cleanup.snapshot().children_exited, 1);
        assert!(cleanup.snapshot().is_settled());
    }
}
