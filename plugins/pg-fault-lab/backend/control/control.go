// Package control is the single dispatch surface used by DBX, MCP and CLI.
package control

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/faultproxy"
)

type Request struct {
	Capability string          `json:"capability,omitempty"`
	Method     string          `json:"method"`
	Rule       faultproxy.Rule `json:"rule,omitempty"`
	ID         string          `json:"id,omitempty"`
}
type Response struct {
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func Dispatch(s *faultproxy.Server, r Request, canInject bool) (any, error) {
	if r.Method == "snapshot" {
		return s.Snapshot(), nil
	}
	if !canInject {
		return nil, faultproxy.ErrReadOnly
	}
	switch r.Method {
	case "add_rule":
		return s.AddRule(r.Rule)
	case "delete_rule":
		return nil, s.DeleteRule(r.ID)
	case "resume":
		return nil, s.Resume(r.ID, false)
	case "abort":
		return nil, s.Resume(r.ID, true)
	default:
		return nil, errors.New("unknown fault-lab method")
	}
}

// Endpoint capabilities are ephemeral, process-local and never included in a
// snapshot/event/MCP tool result. They grant access only to this disposable lab.
type Endpoint struct {
	Address    string `json:"address"`
	Capability string `json:"capability"`
}
type Instance struct {
	Server    *faultproxy.Server
	Observe   Endpoint
	Inject    *Endpoint
	listeners []net.Listener
	wg        sync.WaitGroup
	once      sync.Once
}

func Start(cfg faultproxy.Config) (*Instance, error) {
	s, err := faultproxy.New(cfg)
	if err != nil {
		return nil, err
	}
	if err = s.Start(); err != nil {
		return nil, err
	}
	i := &Instance{Server: s}
	i.Observe, err = i.listen(false)
	if err != nil {
		i.Close()
		return nil, err
	}
	if cfg.AllowInjection {
		e, err := i.listen(true)
		if err != nil {
			i.Close()
			return nil, err
		}
		i.Inject = &e
	}
	return i, nil
}
func (i *Instance) listen(write bool) (Endpoint, error) {
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return Endpoint{}, errors.New("ephemeral capability creation failed")
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return Endpoint{}, errors.New("could not bind loopback control endpoint")
	}
	endpoint := Endpoint{Address: l.Addr().String(), Capability: hex.EncodeToString(secret[:])}
	i.listeners = append(i.listeners, l)
	i.wg.Add(1)
	go func() {
		defer i.wg.Done()
		sem := make(chan struct{}, 16)
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			select {
			case sem <- struct{}{}:
			default:
				conn.Close()
				continue
			}
			i.wg.Add(1)
			go func() {
				defer i.wg.Done()
				defer func() { <-sem }()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(3 * time.Second))
				var r Request
				dec := json.NewDecoder(io.LimitReader(conn, 64<<10))
				dec.DisallowUnknownFields()
				if err := dec.Decode(&r); err != nil {
					json.NewEncoder(conn).Encode(Response{Error: "invalid bounded control request"})
					return
				}
				if subtle.ConstantTimeCompare([]byte(r.Capability), []byte(endpoint.Capability)) != 1 {
					json.NewEncoder(conn).Encode(Response{Error: "unauthorized"})
					return
				}
				r.Capability = ""
				result, err := Dispatch(i.Server, r, write)
				reply := Response{Result: result}
				if err != nil {
					reply.Error = err.Error()
				}
				json.NewEncoder(conn).Encode(reply)
			}()
		}
	}()
	return endpoint, nil
}
func (i *Instance) Close() {
	i.once.Do(func() {
		for _, l := range i.listeners {
			l.Close()
		}
		i.Server.Close()
		i.wg.Wait()
	})
}
func Call(endpoint Endpoint, r Request) (Response, error) {
	var out Response
	host, _, err := net.SplitHostPort(endpoint.Address)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() {
		return out, errors.New("control endpoint must be numeric loopback")
	}
	conn, err := net.DialTimeout("tcp", endpoint.Address, 3*time.Second)
	if err != nil {
		return out, errors.New("control endpoint unavailable")
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	r.Capability = endpoint.Capability
	if err = json.NewEncoder(conn).Encode(r); err != nil {
		return out, err
	}
	err = json.NewDecoder(io.LimitReader(conn, 2<<20)).Decode(&out)
	return out, err
}
