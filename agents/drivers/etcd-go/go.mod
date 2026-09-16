module github.com/t8y2/dbx/agents/drivers/etcd-go

go 1.26

// The v0.3.1 tag of coreos/go-semver declares the root module without the
// /semver suffix, so the nested module path etcd requires no longer resolves
// upstream. Vendored under go-common from the v0.3.1 tag, package unchanged.
replace github.com/coreos/go-semver/semver => ../../go-common/go-semver

// The pseudo-version recorded in etcd's go.mod predates second-precision
// timestamps and is rejected by modern Go; point at the corrected form.
replace github.com/modern-go/concurrent => github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd

require (
	go.etcd.io/etcd/api/v3 v3.7.1
	go.etcd.io/etcd/client/v3 v3.7.1
	google.golang.org/grpc v1.82.1
)

require (
	github.com/coreos/go-semver/semver v0.3.1 // indirect
	github.com/coreos/go-systemd/v22 v22.7.0 // indirect
	github.com/golang/protobuf v1.5.4 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.29.0 // indirect
	go.etcd.io/etcd/client/pkg/v3 v3.7.1 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.uber.org/zap v1.27.1 // indirect
	golang.org/x/net v0.55.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	golang.org/x/text v0.37.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260414002931-afd174a4e478 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260414002931-afd174a4e478 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
)
