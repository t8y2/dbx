//! Shared limits for data-only Redis value codecs.
pub(crate) const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_DEPTH: usize = 64;
pub(crate) const MAX_NODES: usize = 32_768;
const MAX_VALUE_WORK: usize = 4 * 1024 * 1024;

pub(crate) struct DecodeBudget<'a> {
    remaining: &'a mut usize,
    local: usize,
    nodes: usize,
}

impl<'a> DecodeBudget<'a> {
    pub(crate) fn new(remaining: &'a mut usize) -> Self {
        let local = (*remaining).min(MAX_VALUE_WORK);
        Self { remaining, local, nodes: 0 }
    }

    pub(crate) fn spend(&mut self, count: usize) -> Result<(), ()> {
        if count > self.local {
            *self.remaining -= self.local;
            self.local = 0;
            return Err(());
        }
        self.local -= count;
        *self.remaining -= count;
        Ok(())
    }

    pub(crate) fn node(&mut self, depth: usize) -> Result<(), ()> {
        if depth >= MAX_DEPTH || self.nodes >= MAX_NODES {
            return Err(());
        }
        self.nodes += 1;
        self.spend(32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_work_debits_the_shared_allowance() {
        let mut remaining = 100;
        {
            let mut budget = DecodeBudget::new(&mut remaining);
            assert!(budget.spend(40).is_ok());
            assert!(budget.spend(61).is_err());
        }
        assert_eq!(remaining, 0);
    }
    #[test]
    fn nodes_and_nesting_are_bounded() {
        let mut remaining = 16 * 1024 * 1024;
        let mut budget = DecodeBudget::new(&mut remaining);
        for _ in 0..MAX_NODES {
            assert!(budget.node(0).is_ok());
        }
        assert!(budget.node(0).is_err());
        assert!(budget.node(MAX_DEPTH).is_err());
    }
}
