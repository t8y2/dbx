module github.com/xue-ding-e/dbx/plugins/pg-fault-lab

go 1.25.0

require (
	github.com/jackc/pgx/v5 v5.11.0
	github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk v0.0.0-00010101000000-000000000000
	gorm.io/driver/postgres v1.6.3
	gorm.io/gen v0.3.29
	gorm.io/gorm v1.31.2
	gorm.io/plugin/dbresolver v1.6.2
)

require (
	filippo.io/edwards25519 v1.1.0 // indirect
	github.com/go-sql-driver/mysql v1.8.1 // indirect
	github.com/google/uuid v1.3.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/jinzhu/inflection v1.0.0 // indirect
	github.com/jinzhu/now v1.1.5 // indirect
	golang.org/x/exp v0.0.0-20240112132812-db7319d0e0e3 // indirect
	golang.org/x/mod v0.27.0 // indirect
	golang.org/x/sync v0.17.0 // indirect
	golang.org/x/text v0.29.0 // indirect
	golang.org/x/tools v0.36.0 // indirect
	gorm.io/datatypes v1.2.4 // indirect
	gorm.io/driver/mysql v1.5.7 // indirect
	gorm.io/hints v1.1.0 // indirect
)

replace github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk => ../../sdk/go/dbx-plugin-sdk
