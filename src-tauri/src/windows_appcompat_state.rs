//! Ownership rules for the startup compatibility registry changes.
//! Kept independent of Win32 so the same rules are tested on every CI host.

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LayerValue {
    pub value_type: u32,
    pub data: Vec<u8>,
}

pub(crate) trait LayerRegistry {
    type Error;

    fn current(&self, name: &str) -> Result<Option<LayerValue>, Self::Error>;
    fn write(&self, name: &str, value: &LayerValue) -> Result<(), Self::Error>;
    fn delete(&self, name: &str) -> Result<(), Self::Error>;
    fn owned(&self) -> Result<Vec<(String, LayerValue)>, Self::Error>;
    fn remember(&self, name: &str, value: &LayerValue) -> Result<(), Self::Error>;
    fn forget(&self, name: &str) -> Result<(), Self::Error>;
}

/// Never overwrite a pre-existing user/application setting. Record only values
/// we create, before writing them, so ownership survives a recovery relaunch.
pub(crate) fn set_if_unconfigured<R: LayerRegistry>(
    registry: &R,
    name: &str,
    value: &LayerValue,
) -> Result<bool, R::Error> {
    if registry.current(name)?.is_some() {
        return Ok(false);
    }
    registry.remember(name, value)?;
    // Re-check after recording ownership in case another app set a layer.
    if registry.current(name)?.is_some() {
        registry.forget(name)?;
        return Ok(false);
    }
    if let Err(error) = registry.write(name, value) {
        let _ = registry.forget(name);
        return Err(error);
    }
    Ok(true)
}

/// Remove only DBX-owned values that still equal what DBX wrote. Other apps'
/// paths and subsequent user edits are left in place, including their type.
pub(crate) fn remove_owned<R: LayerRegistry>(registry: &R) -> Result<u32, R::Error> {
    let mut removed = 0;
    for (name, expected) in registry.owned()? {
        if registry.current(&name)?.as_ref() == Some(&expected) {
            registry.delete(&name)?;
            removed += 1;
        }
        registry.forget(&name)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct Registry {
        layers: RefCell<BTreeMap<String, LayerValue>>,
        owned: RefCell<BTreeMap<String, LayerValue>>,
        fail_write: bool,
    }

    impl LayerRegistry for Registry {
        type Error = &'static str;

        fn current(&self, name: &str) -> Result<Option<LayerValue>, Self::Error> {
            Ok(self.layers.borrow().get(name).cloned())
        }
        fn write(&self, name: &str, value: &LayerValue) -> Result<(), Self::Error> {
            if self.fail_write {
                return Err("write failed");
            }
            self.layers.borrow_mut().insert(name.to_string(), value.clone());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), Self::Error> {
            self.layers.borrow_mut().remove(name);
            Ok(())
        }
        fn owned(&self) -> Result<Vec<(String, LayerValue)>, Self::Error> {
            Ok(self.owned.borrow().iter().map(|(name, value)| (name.clone(), value.clone())).collect())
        }
        fn remember(&self, name: &str, value: &LayerValue) -> Result<(), Self::Error> {
            self.owned.borrow_mut().insert(name.to_string(), value.clone());
            Ok(())
        }
        fn forget(&self, name: &str) -> Result<(), Self::Error> {
            self.owned.borrow_mut().remove(name);
            Ok(())
        }
    }

    fn win8() -> LayerValue {
        LayerValue { value_type: 1, data: b"~ WIN8RTM".to_vec() }
    }

    #[test]
    fn preexisting_layers_are_preserved_and_never_claimed() {
        for value in [win8(), LayerValue { value_type: 2, data: b"~ HIGHDPIAWARE".to_vec() }] {
            let registry = Registry::default();
            registry.write("runtime", &value).unwrap();
            assert!(!set_if_unconfigured(&registry, "runtime", &win8()).unwrap());
            assert_eq!(remove_owned(&registry), Ok(0));
            assert_eq!(registry.current("runtime").unwrap(), Some(value));
            assert!(registry.owned().unwrap().is_empty());
        }
    }

    #[test]
    fn cleanup_only_removes_owned_values_even_when_foreign_values_match() {
        let registry = Registry::default();
        registry.write("other-app/msedgewebview2.exe", &win8()).unwrap();
        assert!(set_if_unconfigured(&registry, "dbx-runtime", &win8()).unwrap());
        assert_eq!(remove_owned(&registry), Ok(1));
        assert_eq!(registry.current("dbx-runtime").unwrap(), None);
        assert_eq!(registry.current("other-app/msedgewebview2.exe").unwrap(), Some(win8()));
    }

    #[test]
    fn cleanup_preserves_later_edits_including_registry_type_changes() {
        for changed in [
            LayerValue { value_type: 1, data: b"~ WIN8RTM HIGHDPIAWARE".to_vec() },
            LayerValue { value_type: 2, ..win8() },
        ] {
            let registry = Registry::default();
            set_if_unconfigured(&registry, "runtime", &win8()).unwrap();
            registry.write("runtime", &changed).unwrap();
            assert_eq!(remove_owned(&registry), Ok(0));
            assert_eq!(registry.current("runtime").unwrap(), Some(changed));
            assert!(registry.owned().unwrap().is_empty());
        }
    }

    #[test]
    fn failed_writes_do_not_claim_ownership() {
        let registry = Registry { fail_write: true, ..Registry::default() };
        assert_eq!(set_if_unconfigured(&registry, "runtime", &win8()), Err("write failed"));
        assert!(registry.owned().unwrap().is_empty());
        assert_eq!(registry.current("runtime").unwrap(), None);
    }

    #[test]
    fn repeated_startup_keeps_ownership_for_later_cleanup() {
        let registry = Registry::default();
        assert!(set_if_unconfigured(&registry, "runtime", &win8()).unwrap());
        assert!(!set_if_unconfigured(&registry, "runtime", &win8()).unwrap());
        assert_eq!(remove_owned(&registry), Ok(1));
        assert_eq!(remove_owned(&registry), Ok(0));
    }
}
