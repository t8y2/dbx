package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/control"
	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/faultproxy"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 || args[0] == "plugin" {
		p := newPlugin()
		defer p.close()
		return sdk.NewServer(sdk.Metadata{ID: "io.xuedinge.pg-fault-lab", Version: "0.1.1", Capabilities: []string{"connections"}}, p).Serve()
	}
	switch args[0] {
	case "serve":
		f := flag.NewFlagSet("serve", flag.ContinueOnError)
		cfg := faultproxy.Config{}
		f.StringVar(&cfg.Upstream, "upstream", "127.0.0.1:55432", "disposable PostgreSQL 17 endpoint")
		f.StringVar(&cfg.Listen, "listen", "127.0.0.1:55433", "numeric loopback endpoint")
		f.BoolVar(&cfg.DisposableLab, "disposable-lab", false, "confirm this is a disposable synthetic database")
		f.BoolVar(&cfg.AllowInjection, "allow-injection", false, "create a separate injection control endpoint")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		i, err := control.Start(cfg)
		if err != nil {
			return err
		}
		defer i.Close()
		json.NewEncoder(os.Stdout).Encode(map[string]any{"address": i.Server.Addr(), "observe": i.Observe, "inject": i.Inject})
		done := make(chan os.Signal, 1)
		signal.Notify(done, os.Interrupt, syscall.SIGTERM)
		defer signal.Stop(done)
		<-done
		return nil
	case "ctl":
		f := flag.NewFlagSet("ctl", flag.ContinueOnError)
		address := f.String("address", "", "loopback observe or injection endpoint")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if *address == "" || os.Getenv("DBX_FAULT_CAPABILITY") == "" {
			return errors.New("--address and DBX_FAULT_CAPABILITY required")
		}
		var r control.Request
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 64<<10))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&r); err != nil {
			return errors.New("supply one JSON control request on stdin")
		}
		reply, err := control.Call(control.Endpoint{Address: *address, Capability: os.Getenv("DBX_FAULT_CAPABILITY")}, r)
		if err != nil {
			return err
		}
		json.NewEncoder(os.Stdout).Encode(reply)
		if reply.Error != "" {
			return errors.New("control request failed")
		}
		return nil
	default:
		return errors.New("usage: dbx-pg-fault [plugin | serve --disposable-lab [--allow-injection] | ctl --address IP:PORT]")
	}
}
