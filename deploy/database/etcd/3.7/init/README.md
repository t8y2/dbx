# etcd 3.7 initialization

After the server is healthy, the recipe runner creates `root` with password `123456` (or `DB_PASSWORD`), grants it the `root` role, and enables etcd authentication. The named volume keeps the initialized authentication state.
