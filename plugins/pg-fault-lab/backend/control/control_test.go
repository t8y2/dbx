package control

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/faultproxy"
)

func start(t *testing.T, inject bool) *Instance {
	t.Helper()
	i, e := Start(faultproxy.Config{Upstream: "127.0.0.1:55432", Listen: "127.0.0.1:0", AllowInjection: inject, DisposableLab: true})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(i.Close)
	return i
}
func TestObserveCapabilityCannotInject(t *testing.T) {
	i := start(t, true)
	request := Request{Method: "add_rule", Rule: faultproxy.Rule{Selector: faultproxy.Selector{Application: "control_test"}, Phase: "execute", Action: "pause", Hits: 1, TTLMS: 1000}}
	r, e := Call(i.Observe, request)
	if e != nil || r.Error == "" {
		t.Fatal("observe mutation allowed", r, e)
	}
	wrong := i.Observe
	wrong.Capability = "wrong"
	r, e = Call(wrong, Request{Method: "snapshot"})
	if e != nil || r.Error != "unauthorized" {
		t.Fatal(r, e)
	}
	crossed := *i.Inject
	crossed.Capability = i.Observe.Capability
	r, e = Call(crossed, request)
	if e != nil || r.Error != "unauthorized" {
		t.Fatal("read capability worked on inject", r, e)
	}
	r, e = Call(*i.Inject, request)
	if e != nil || r.Error != "" {
		t.Fatal(r, e)
	}
	r, e = Call(i.Observe, Request{Method: "snapshot"})
	if e != nil || r.Error != "" {
		t.Fatal(r, e)
	}
	b, _ := json.Marshal(r)
	for _, secret := range []string{i.Observe.Capability, i.Inject.Capability} {
		if strings.Contains(string(b), secret) {
			t.Fatal("capability leaked in snapshot")
		}
	}
	i.Close()
	if _, e = Call(i.Observe, Request{Method: "snapshot"}); e == nil {
		t.Fatal("control listener retained after close")
	}
}
func TestObserveOnlyCreatesNoInjector(t *testing.T) {
	i := start(t, false)
	if i.Inject != nil {
		t.Fatal("injector created by default")
	}
	if _, e := Dispatch(i.Server, Request{Method: "add_rule"}, true); e != faultproxy.ErrReadOnly {
		t.Fatal("core authorization bypass", e)
	}
}
func TestRejectRemoteControlEndpoint(t *testing.T) {
	if _, e := Call(Endpoint{Address: "example.com:443"}, Request{}); e == nil {
		t.Fatal("remote endpoint accepted")
	}
}
