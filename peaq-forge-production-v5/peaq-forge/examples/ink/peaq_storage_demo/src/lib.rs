#![cfg_attr(not(feature = "std"), no_std, no_main)]

/// # PeaqStorageDemo
///
/// ink! smart contract demonstrating on-chain machine data storage on peaq.
/// Stores key/value pairs per machine owner address.
///
/// ## Build
///   cargo contract build --release
///
/// ## Test
///   cargo test
///
/// ## Deploy via PEAQ FORGE
///   Use the ink! → Build → Instantiate panels in the UI.
///
#[ink::contract]
mod peaq_storage_demo {
    use ink::storage::Mapping;
    use ink::prelude::string::String;
    use ink::prelude::vec::Vec;

    /// Emitted when a machine data entry is stored.
    #[ink(event)]
    pub struct DataStored {
        #[ink(topic)]
        owner: AccountId,
        key:   String,
        value: String,
    }

    /// Emitted when a machine data entry is removed.
    #[ink(event)]
    pub struct DataRemoved {
        #[ink(topic)]
        owner: AccountId,
        key:   String,
    }

    #[derive(Debug, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    pub enum Error {
        /// Caller is not the owner of this entry.
        Unauthorized,
        /// Key does not exist.
        NotFound,
        /// Key or value exceeds maximum length.
        InputTooLong,
    }

    pub type Result<T> = core::result::Result<T, Error>;

    const MAX_KEY_LEN:   usize = 128;
    const MAX_VALUE_LEN: usize = 1024;

    #[ink(storage)]
    pub struct PeaqStorageDemo {
        /// owner_address + key → value
        data:  Mapping<(AccountId, String), String>,
        /// owner → list of keys (for enumeration)
        keys:  Mapping<AccountId, Vec<String>>,
    }

    impl PeaqStorageDemo {
        #[ink(constructor)]
        pub fn new() -> Self {
            Self {
                data: Mapping::default(),
                keys: Mapping::default(),
            }
        }

        /// Store a key/value pair for the calling account.
        #[ink(message)]
        pub fn set(&mut self, key: String, value: String) -> Result<()> {
            if key.len() > MAX_KEY_LEN || value.len() > MAX_VALUE_LEN {
                return Err(Error::InputTooLong);
            }
            let caller = self.env().caller();
            let map_key = (caller, key.clone());

            // Track key for enumeration
            let mut owner_keys = self.keys.get(caller).unwrap_or_default();
            if !owner_keys.contains(&key) {
                owner_keys.push(key.clone());
                self.keys.insert(caller, &owner_keys);
            }

            self.data.insert(map_key, &value);
            self.env().emit_event(DataStored { owner: caller, key, value });
            Ok(())
        }

        /// Read a value by key for a given account.
        #[ink(message)]
        pub fn get(&self, owner: AccountId, key: String) -> Option<String> {
            self.data.get((owner, key))
        }

        /// Remove a key/value pair. Only the owner can remove their own data.
        #[ink(message)]
        pub fn remove(&mut self, key: String) -> Result<()> {
            let caller = self.env().caller();
            let map_key = (caller, key.clone());

            if self.data.get(map_key.clone()).is_none() {
                return Err(Error::NotFound);
            }

            self.data.remove(map_key);

            // Remove from key list
            let mut owner_keys = self.keys.get(caller).unwrap_or_default();
            owner_keys.retain(|k| k != &key);
            self.keys.insert(caller, &owner_keys);

            self.env().emit_event(DataRemoved { owner: caller, key });
            Ok(())
        }

        /// List all keys stored by an account.
        #[ink(message)]
        pub fn list_keys(&self, owner: AccountId) -> Vec<String> {
            self.keys.get(owner).unwrap_or_default()
        }

        /// Check how many entries an account has.
        #[ink(message)]
        pub fn count(&self, owner: AccountId) -> u32 {
            self.keys.get(owner).unwrap_or_default().len() as u32
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[ink::test]
        fn set_and_get_works() {
            let mut contract = PeaqStorageDemo::new();
            let caller = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>().alice;
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(caller);

            assert!(contract.set("temperature".to_string(), "22.5".to_string()).is_ok());
            assert_eq!(
                contract.get(caller, "temperature".to_string()),
                Some("22.5".to_string())
            );
        }

        #[ink::test]
        fn remove_works() {
            let mut contract = PeaqStorageDemo::new();
            let caller = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>().alice;
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(caller);

            contract.set("key1".to_string(), "val1".to_string()).unwrap();
            assert!(contract.remove("key1".to_string()).is_ok());
            assert_eq!(contract.get(caller, "key1".to_string()), None);
        }

        #[ink::test]
        fn remove_not_found_returns_error() {
            let mut contract = PeaqStorageDemo::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            assert_eq!(contract.remove("ghost".to_string()), Err(Error::NotFound));
        }

        #[ink::test]
        fn key_too_long_returns_error() {
            let mut contract = PeaqStorageDemo::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            let long_key = "x".repeat(129);
            assert_eq!(
                contract.set(long_key, "val".to_string()),
                Err(Error::InputTooLong)
            );
        }

        #[ink::test]
        fn list_keys_works() {
            let mut contract = PeaqStorageDemo::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);

            contract.set("a".to_string(), "1".to_string()).unwrap();
            contract.set("b".to_string(), "2".to_string()).unwrap();
            let keys = contract.list_keys(accounts.alice);
            assert!(keys.contains(&"a".to_string()));
            assert!(keys.contains(&"b".to_string()));
            assert_eq!(contract.count(accounts.alice), 2);
        }

        #[ink::test]
        fn different_owners_isolated() {
            let mut contract = PeaqStorageDemo::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            contract.set("sensor".to_string(), "alice_data".to_string()).unwrap();

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.bob);
            contract.set("sensor".to_string(), "bob_data".to_string()).unwrap();

            assert_eq!(contract.get(accounts.alice, "sensor".to_string()), Some("alice_data".to_string()));
            assert_eq!(contract.get(accounts.bob,   "sensor".to_string()), Some("bob_data".to_string()));
        }
    }
}
