module github.com/beltran/gosasl

go 1.23.0

require (
	github.com/alexbrainman/sspi v0.0.0-20250919150558-7d374ff0d59e
	github.com/golang-auth/go-gssapi/v2 v2.2.2
)

require (
	github.com/hashicorp/go-uuid v1.0.3 // indirect
	github.com/jcmturner/aescts/v2 v2.0.0 // indirect
	github.com/jcmturner/dnsutils/v2 v2.0.0 // indirect
	github.com/jcmturner/gofork v1.7.6 // indirect
	github.com/jcmturner/gokrb5 v8.4.4+incompatible // indirect
	github.com/jcmturner/gokrb5/v8 v8.4.4 // indirect
	github.com/jcmturner/rpc/v2 v2.0.3 // indirect
	golang.org/x/crypto v0.6.0 // indirect
	golang.org/x/net v0.7.0 // indirect
)

replace github.com/golang-auth/go-gssapi/v2 => ../go-gssapi
