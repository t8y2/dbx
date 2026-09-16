module github.com/t8y2/dbx/agents/drivers/hive-go

go 1.23.0

require (
	github.com/beltran/gosasl v1.0.0
	github.com/go-zookeeper/zk v1.0.4
	github.com/golang-auth/go-gssapi/v2 v2.0.0
	github.com/jcmturner/krb5test v0.0.0-20201230140143-102e4b78cdb8
	github.com/pavlo-v-chernykh/keystore-go/v4 v4.5.0
	github.com/t8y2/dbx/agents/go-common/gohive v0.0.0
	software.sslmate.com/src/go-pkcs12 v0.7.3
)

require (
	github.com/alexbrainman/sspi v0.0.0-20250919150558-7d374ff0d59e // indirect
	github.com/apache/thrift v0.22.0 // indirect
	github.com/beltran/gohive/v2 v2.1.0 // indirect
	github.com/hashicorp/go-uuid v1.0.2 // indirect
	github.com/jcmturner/aescts/v2 v2.0.0 // indirect
	github.com/jcmturner/dnsutils/v2 v2.0.0 // indirect
	github.com/jcmturner/gofork v1.0.0 // indirect
	github.com/jcmturner/gokrb5 v8.4.2+incompatible // indirect
	github.com/jcmturner/gokrb5/v8 v8.4.2 // indirect
	github.com/jcmturner/rpc/v2 v2.0.3 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	golang.org/x/crypto v0.39.0 // indirect
	golang.org/x/net v0.41.0 // indirect
)

replace github.com/beltran/gosasl => ../../go-common/gosasl

replace github.com/golang-auth/go-gssapi/v2 => ../../go-common/go-gssapi

replace github.com/t8y2/dbx/agents/go-common/gohive => ../../go-common/gohive
