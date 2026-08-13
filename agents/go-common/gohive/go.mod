module github.com/t8y2/dbx/agents/go-common/gohive

go 1.23.0

require (
	github.com/apache/thrift v0.22.0
	github.com/beltran/gohive/v2 v2.1.0
	github.com/beltran/gosasl v1.0.0
	github.com/pkg/errors v0.9.1
	golang.org/x/net v0.41.0
)

require (
	github.com/alexbrainman/sspi v0.0.0-20250919150558-7d374ff0d59e // indirect
	github.com/golang-auth/go-gssapi/v2 v2.0.0 // indirect
	github.com/hashicorp/go-uuid v1.0.2 // indirect
	github.com/jcmturner/aescts/v2 v2.0.0 // indirect
	github.com/jcmturner/dnsutils/v2 v2.0.0 // indirect
	github.com/jcmturner/gofork v1.0.0 // indirect
	github.com/jcmturner/gokrb5 v8.4.2+incompatible // indirect
	github.com/jcmturner/gokrb5/v8 v8.4.2 // indirect
	github.com/jcmturner/rpc/v2 v2.0.3 // indirect
	golang.org/x/crypto v0.39.0 // indirect
)

replace github.com/beltran/gosasl => ../gosasl

replace github.com/golang-auth/go-gssapi/v2 => ../go-gssapi
