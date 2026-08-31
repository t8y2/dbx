# Nacos 2.5 initialization

After the Nacos service becomes healthy, the database environment command synchronously sets the first-run `nacos` administrator password to `123456` (or `DB_PASSWORD`) through the authentication API. Later starts verify those credentials without overwriting the account. The smoke check also verifies that an unauthenticated configuration read is rejected. The named data volume preserves the initialized account.
