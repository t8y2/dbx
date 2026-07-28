# r-nacos initialization

The service initializes the `admin` administrator from `RNACOS_INIT_ADMIN_USERNAME` and `RNACOS_INIT_ADMIN_PASSWORD` when its data volume is empty. The DBX recipe defaults the password to `123456`; set `DB_PASSWORD` before the first start to choose another password.

The named `data` volume preserves the initialized account. Changing `DB_PASSWORD` after the first start does not change the existing administrator password. Run `make db-reset DB=rnacos@0.8 CONFIRM=1` before starting again when a fresh account is required.
