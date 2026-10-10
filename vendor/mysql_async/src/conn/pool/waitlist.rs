use keyed_priority_queue::KeyedPriorityQueue;

use std::{
    borrow::Borrow,
    cmp::Reverse,
    hash::{Hash, Hasher},
    sync::atomic,
    sync::Arc,
    task::Waker,
};

use crate::Metrics;

#[derive(Debug)]
pub(crate) struct Waitlist {
    queue: KeyedPriorityQueue<QueuedWaker, QueueId>,
    metrics: Arc<Metrics>,
}

impl Waitlist {
    pub(crate) fn new(metrics: Arc<Metrics>) -> Waitlist {
        Waitlist {
            queue: Default::default(),
            metrics,
        }
    }

    pub(crate) fn push(&mut self, waker: Waker, queue_id: QueueId) {
        // The documentation of Future::poll says:
        //   Note that on multiple calls to poll, only the Waker from
        //   the Context passed to the most recent call should be
        //   scheduled to receive a wakeup.
        //
        // But the the documentation of KeyedPriorityQueue::push says:
        //   Adds new element to queue if missing key or replace its
        //   priority if key exists. In second case doesn’t replace key.
        //
        // This means we have to remove first to have the most recent
        // waker in the queue.
        self.remove(queue_id);
        self.queue.push(QueuedWaker { queue_id, waker }, queue_id);

        self.metrics
            .active_wait_requests
            .fetch_add(1, atomic::Ordering::Relaxed);
    }

    /// Returns `true` if anyone was awaken
    pub(crate) fn wake(&mut self) -> bool {
        match self.queue.pop() {
            Some((qw, _)) => {
                self.metrics
                    .active_wait_requests
                    .fetch_sub(1, atomic::Ordering::Relaxed);
                qw.waker.wake();
                true
            }
            None => false,
        }
    }

    pub(crate) fn remove(&mut self, id: QueueId) {
        if self.queue.remove(&id).is_some() {
            self.metrics
                .active_wait_requests
                .fetch_sub(1, atomic::Ordering::Relaxed);
        }
    }

    pub(crate) fn peek_id(&mut self) -> Option<QueueId> {
        self.queue.peek().map(|(qw, _)| qw.queue_id)
    }

    // only used in tests for now
    #[allow(dead_code)]
    pub(crate) fn len(&self) -> usize {
        self.queue.len()
    }
}

pub(crate) const QUEUE_END_ID: QueueId = QueueId(Reverse(u64::MAX));
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub(crate) struct QueueId(Reverse<u64>);

impl QueueId {
    pub(crate) fn next() -> Self {
        static NEXT_QUEUE_ID: atomic::AtomicU64 = atomic::AtomicU64::new(0);
        let id = NEXT_QUEUE_ID.fetch_add(1, atomic::Ordering::SeqCst);
        QueueId(Reverse(id))
    }
}

#[derive(Debug)]
struct QueuedWaker {
    queue_id: QueueId,
    waker: Waker,
}

impl Eq for QueuedWaker {}

impl Borrow<QueueId> for QueuedWaker {
    fn borrow(&self) -> &QueueId {
        &self.queue_id
    }
}

impl PartialEq for QueuedWaker {
    fn eq(&self, other: &Self) -> bool {
        self.queue_id == other.queue_id
    }
}

impl Hash for QueuedWaker {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.queue_id.hash(state)
    }
}

#[cfg(test)]
mod test {
    use std::cmp::Reverse;
    use std::task::RawWaker;
    use std::task::RawWakerVTable;
    use std::task::Waker;

    use super::*;

    #[test]
    fn waitlist_integrity() {
        const DATA: *const () = &();
        const NOOP_CLONE_FN: unsafe fn(*const ()) -> RawWaker = |_| RawWaker::new(DATA, &RW_VTABLE);
        const NOOP_FN: unsafe fn(*const ()) = |_| {};
        static RW_VTABLE: RawWakerVTable =
            RawWakerVTable::new(NOOP_CLONE_FN, NOOP_FN, NOOP_FN, NOOP_FN);
        let w = unsafe { Waker::from_raw(RawWaker::new(DATA, &RW_VTABLE)) };

        let mut waitlist = Waitlist::new(Default::default());
        assert_eq!(0, waitlist.queue.len());

        waitlist.push(w.clone(), QueueId(Reverse(4)));
        waitlist.push(w.clone(), QueueId(Reverse(2)));
        waitlist.push(w.clone(), QueueId(Reverse(8)));
        waitlist.push(w.clone(), QUEUE_END_ID);
        waitlist.push(w.clone(), QueueId(Reverse(10)));

        waitlist.remove(QueueId(Reverse(8)));

        assert_eq!(4, waitlist.queue.len());

        let (_, id) = waitlist.queue.pop().unwrap();
        assert_eq!(2, id.0 .0);
        let (_, id) = waitlist.queue.pop().unwrap();
        assert_eq!(4, id.0 .0);
        let (_, id) = waitlist.queue.pop().unwrap();
        assert_eq!(10, id.0 .0);
        let (_, id) = waitlist.queue.pop().unwrap();
        assert_eq!(QUEUE_END_ID, id);

        assert_eq!(0, waitlist.queue.len());
    }
}
