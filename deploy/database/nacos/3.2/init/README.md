# Nacos 3.2 initialization

After the Nacos service becomes healthy, the database environment command synchronously sets the first-run `nacos` administrator password to `123456` (or `DB_PASSWORD`) through the authentication API. Later starts verify those credentials without overwriting the account. The named data volume preserves the initialized account.
