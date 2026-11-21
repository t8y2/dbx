package main

import (
	"fmt"
	"net"
	"strconv"
	"sync"
)

// validateEndpointRoutes makes a private, normalized copy before any dial. A
// supplied route table is exhaustive: incomplete tables must never fall back
// to a direct connection outside the configured transport.
func validateEndpointRoutes(servers []string, configured map[string]string) (map[string]string, error) {
	if configured == nil {
		return nil, nil
	}
	routes := make(map[string]string, len(configured))
	for logical, destination := range configured {
		address, err := routedEndpointAddress(logical)
		if err != nil {
			return nil, fmt.Errorf("invalid ZooKeeper endpoint route %q: %w", logical, err)
		}
		dialHost, dialPort, err := net.SplitHostPort(destination)
		if err != nil || !net.ParseIP(dialHost).IsLoopback() || !validEndpointPort(dialPort) {
			return nil, fmt.Errorf("ZooKeeper endpoint route for %q must target a loopback IP and port", logical)
		}
		if _, duplicate := routes[address]; duplicate {
			return nil, fmt.Errorf("duplicate ZooKeeper endpoint route for %q", address)
		}
		routes[address] = destination
	}
	for _, server := range servers {
		address, err := routedEndpointAddress(server)
		if err != nil {
			return nil, err
		}
		if _, ok := routes[address]; !ok {
			return nil, fmt.Errorf("missing ZooKeeper endpoint route for %q", address)
		}
	}
	return routes, nil
}

// routedEndpointAddress uses the numeric port spelling carried by the host's
// route map, while leaving direct connections' existing parsing unchanged.
func routedEndpointAddress(endpoint string) (string, error) {
	address, err := endpointAddress(endpoint)
	if err != nil {
		return "", err
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil || host == "" || !validEndpointPort(port) {
		return "", fmt.Errorf("invalid ZooKeeper endpoint route %q", endpoint)
	}
	value, _ := strconv.Atoi(port) // Validated above.
	return net.JoinHostPort(host, strconv.Itoa(value)), nil
}

func validEndpointPort(port string) bool {
	value, err := strconv.Atoi(port)
	return err == nil && value > 0 && value <= 65535
}

// routedHostProvider preserves logical names for remote DNS and TLS. zk.Connect
// shuffles the input list before Init; keep that order and the library's retry
// cycle semantics without resolving the names on the local machine.
type routedHostProvider struct {
	mu      sync.Mutex
	servers []string
	current int
	last    int
}

func (provider *routedHostProvider) Init(servers []string) error {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if len(servers) == 0 {
		return fmt.Errorf("ZooKeeper routed server list is empty")
	}
	provider.servers = make([]string, len(servers))
	for index, server := range servers {
		address, err := routedEndpointAddress(server)
		if err != nil {
			return err
		}
		provider.servers[index] = address
	}
	provider.current, provider.last = -1, -1
	return nil
}

func (provider *routedHostProvider) Len() int {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return len(provider.servers)
}

func (provider *routedHostProvider) Next() (string, bool) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	provider.current = (provider.current + 1) % len(provider.servers)
	retryStart := provider.current == provider.last
	if provider.last == -1 {
		provider.last = 0
	}
	return provider.servers[provider.current], retryStart
}

func (provider *routedHostProvider) Connected() {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	provider.last = provider.current
}
