package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
	"golang.org/x/net/proxy"
)

type proxyTargetKind int

const (
	proxyTargetNameServer proxyTargetKind = iota
	proxyTargetBroker
)

type proxyEndpoint struct {
	original  string
	targets   []string
	fallback  bool
	listener  net.Listener
	manager   *proxyManager
	closeOnce sync.Once
}

type proxyManager struct {
	mu              sync.RWMutex
	config          connectionConfig
	byOriginal      map[string]*proxyEndpoint
	originalByLocal map[string]string
	routedOwners    map[string]string
	closed          bool
}

func newProxyManager(config connectionConfig) *proxyManager {
	return &proxyManager{
		config: config, byOriginal: map[string]*proxyEndpoint{},
		originalByLocal: map[string]string{}, routedOwners: map[string]string{},
	}
}

func (manager *proxyManager) ProxyFor(original string, kind proxyTargetKind) (string, error) {
	original = strings.TrimSpace(original)
	if original == "" {
		return "", fmt.Errorf("empty RocketMQ endpoint")
	}
	manager.mu.RLock()
	if endpoint := manager.byOriginal[original]; endpoint != nil {
		address := endpoint.listener.Addr().String()
		manager.mu.RUnlock()
		return address, nil
	}
	manager.mu.RUnlock()

	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.closed {
		return "", fmt.Errorf("RocketMQ proxy manager is closed")
	}
	if endpoint := manager.byOriginal[original]; endpoint != nil {
		return endpoint.listener.Addr().String(), nil
	}
	targets, fallback := manager.routeTargetsLocked(original, kind)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("start RocketMQ endpoint proxy: %w", err)
	}
	endpoint := &proxyEndpoint{original: original, targets: targets, fallback: fallback, listener: listener, manager: manager}
	local := listener.Addr().String()
	manager.byOriginal[original] = endpoint
	manager.originalByLocal[local] = original
	go endpoint.serve()
	return local, nil
}

func (manager *proxyManager) routeTargetsLocked(original string, kind proxyTargetKind) ([]string, bool) {
	if kind == proxyTargetNameServer || manager.config.SocksProxy != nil {
		return []string{original}, false
	}
	if manager.config.BrokerAddr != "" {
		return []string{manager.config.BrokerAddr}, false
	}
	host, port := parseSocketAddress(original)
	if port == "" || !isLikelyUnreachableBrokerHost(host) {
		return []string{original}, false
	}
	nameServerHost, _ := parseSocketAddress(manager.config.NameServers[0])
	routed := formatSocketAddress(nameServerHost, port)
	if owner := manager.routedOwners[routed]; owner == "" || owner == original {
		manager.routedOwners[routed] = original
		return []string{routed, original}, false
	}
	// Multiple private brokers often advertise the same port. Routing a collision to the
	// published host would silently contact the first broker, so keep the original only.
	return []string{original}, true
}

func (manager *proxyManager) LocalForOriginal(original string) string {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	if endpoint := manager.byOriginal[original]; endpoint != nil {
		return endpoint.listener.Addr().String()
	}
	return ""
}

func (manager *proxyManager) OriginalForLocal(local string) string {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	if original := manager.originalByLocal[local]; original != "" {
		return original
	}
	host, port := parseSocketAddress(local)
	if host == "localhost" {
		return manager.originalByLocal[formatSocketAddress("127.0.0.1", port)]
	}
	return ""
}

func (manager *proxyManager) IsCollisionFallback(local string) bool {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	original := manager.originalByLocal[local]
	return original != "" && manager.byOriginal[original] != nil && manager.byOriginal[original].fallback
}

func (manager *proxyManager) Close() {
	manager.mu.Lock()
	if manager.closed {
		manager.mu.Unlock()
		return
	}
	manager.closed = true
	endpoints := make([]*proxyEndpoint, 0, len(manager.byOriginal))
	for _, endpoint := range manager.byOriginal {
		endpoints = append(endpoints, endpoint)
	}
	manager.mu.Unlock()
	for _, endpoint := range endpoints {
		endpoint.closeOnce.Do(func() { _ = endpoint.listener.Close() })
	}
}

func (endpoint *proxyEndpoint) serve() {
	for {
		clientConn, err := endpoint.listener.Accept()
		if err != nil {
			return
		}
		go endpoint.handle(clientConn)
	}
}

func (endpoint *proxyEndpoint) handle(clientConn net.Conn) {
	defer clientConn.Close()
	remoteConn, err := endpoint.dialRemote()
	if err != nil {
		return
	}
	defer remoteConn.Close()

	done := make(chan struct{}, 2)
	go func() {
		_ = endpoint.forward(clientConn, remoteConn, false)
		done <- struct{}{}
	}()
	go func() {
		_ = endpoint.forward(remoteConn, clientConn, true)
		done <- struct{}{}
	}()
	<-done
}

func (endpoint *proxyEndpoint) dialRemote() (net.Conn, error) {
	var lastErr error
	for _, target := range endpoint.targets {
		var conn net.Conn
		var err error
		if socks := endpoint.manager.config.SocksProxy; socks != nil {
			var auth *proxy.Auth
			if socks.Username != "" || socks.Password != "" {
				auth = &proxy.Auth{User: socks.Username, Password: socks.Password}
			}
			dialer, dialErr := proxy.SOCKS5("tcp", formatSocketAddress(socks.Host, fmt.Sprintf("%d", socks.Port)), auth, &net.Dialer{Timeout: endpoint.manager.config.ConnectTimeout})
			if dialErr != nil {
				lastErr = dialErr
				continue
			}
			conn, err = dialer.Dial("tcp", target)
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), endpoint.manager.config.ConnectTimeout)
			conn, err = (&net.Dialer{}).DialContext(ctx, "tcp", target)
			cancel()
		}
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("connect RocketMQ endpoint %s: %w", endpoint.original, lastErr)
}

func (endpoint *proxyEndpoint) forward(source, destination net.Conn, response bool) error {
	for {
		frame, err := readRemotingFrame(source)
		if err != nil {
			return err
		}
		command, err := remoting.Decode(frame[4:])
		if err != nil {
			return err
		}
		if response {
			if err := endpoint.manager.rewriteResponse(command); err != nil {
				return err
			}
		} else {
			signCommand(command, endpoint.manager.config.AccessKey, endpoint.manager.config.SecretKey)
		}
		encoded, err := command.Encode()
		if err != nil {
			return err
		}
		if _, err := destination.Write(encoded); err != nil {
			return err
		}
	}
}

func readRemotingFrame(reader io.Reader) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	length := int(binary.BigEndian.Uint32(header))
	if length <= 0 || length > 64*1024*1024 {
		return nil, fmt.Errorf("invalid RocketMQ frame length: %d", length)
	}
	frame := make([]byte, 4+length)
	copy(frame, header)
	if _, err := io.ReadFull(reader, frame[4:]); err != nil {
		return nil, err
	}
	return frame, nil
}

func signCommand(command *remoting.RemotingCommand, accessKey, secretKey string) {
	if accessKey == "" && secretKey == "" {
		return
	}
	if command.ExtFields == nil {
		command.ExtFields = map[string]string{}
	}
	delete(command.ExtFields, "Signature")
	command.ExtFields["AccessKey"] = accessKey
	keys := make([]string, 0, len(command.ExtFields))
	for key := range command.ExtFields {
		if key != "Signature" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var content strings.Builder
	for _, key := range keys {
		content.WriteString(command.ExtFields[key])
	}
	data := append([]byte(content.String()), command.Body...)
	mac := hmac.New(sha1.New, []byte(secretKey))
	_, _ = mac.Write(data)
	command.ExtFields["Signature"] = base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func (manager *proxyManager) rewriteResponse(command *remoting.RemotingCommand) error {
	if len(command.Body) == 0 {
		return nil
	}
	body := repairRocketMQJSON(command.Body)
	if !json.Valid(body) {
		return nil
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return nil
	}
	changed, err := manager.rewriteJSON(value, "")
	if err != nil || !changed {
		return err
	}
	body, err = json.Marshal(value)
	if err != nil {
		return err
	}
	command.Body = body
	return nil
}

var (
	unquotedNumberKey = regexp.MustCompile(`([{,])(\d+):`)
	unquotedStringKey = regexp.MustCompile(`([{,])([a-zA-Z_][a-zA-Z0-9_]*):`)
)

func repairRocketMQJSON(body []byte) []byte {
	repaired := unquotedNumberKey.ReplaceAll(body, []byte(`$1"$2":`))
	repaired = unquotedStringKey.ReplaceAll(repaired, []byte(`$1"$2":`))
	return repairObjectKeyedMaps(repaired)
}

func repairObjectKeyedMaps(body []byte) []byte {
	result := make([]byte, 0, len(body)+64)
	for index := 0; index < len(body); {
		if index+2 < len(body) && body[index] == ':' && body[index+1] == '{' && body[index+2] == '{' {
			converted, next := convertObjectKeyedMap(body, index+1)
			result = append(result, ':')
			result = append(result, converted...)
			index = next
			continue
		}
		result = append(result, body[index])
		index++
	}
	return result
}

func convertObjectKeyedMap(body []byte, start int) ([]byte, int) {
	if start >= len(body) || body[start] != '{' {
		return []byte("{}"), start
	}
	result := []byte{'{'}
	index := start + 1
	first := true
	for index < len(body) {
		for index < len(body) && isJSONSpace(body[index]) {
			index++
		}
		if index >= len(body) {
			break
		}
		if body[index] == '}' {
			return append(result, '}'), index + 1
		}
		if body[index] == ',' {
			index++
			continue
		}
		if body[index] != '{' {
			return originalJSONMap(body, start)
		}
		keyEnd := matchingBrace(body, index)
		if keyEnd < 0 {
			return body[start:], len(body)
		}
		key := body[index : keyEnd+1]
		index = keyEnd + 1
		for index < len(body) && isJSONSpace(body[index]) {
			index++
		}
		if index >= len(body) || body[index] != ':' {
			return originalJSONMap(body, start)
		}
		index++
		for index < len(body) && isJSONSpace(body[index]) {
			index++
		}
		if index >= len(body) || body[index] != '{' {
			return originalJSONMap(body, start)
		}
		valueEnd := matchingBrace(body, index)
		if valueEnd < 0 {
			return body[start:], len(body)
		}
		if !first {
			result = append(result, ',')
		}
		first = false
		result = append(result, '"')
		result = append(result, escapeJSONString(key)...)
		result = append(result, '"', ':')
		result = append(result, body[index:valueEnd+1]...)
		index = valueEnd + 1
	}
	return append(result, '}'), len(body)
}

func originalJSONMap(body []byte, start int) ([]byte, int) {
	end := matchingBrace(body, start)
	if end < 0 {
		return body[start:], len(body)
	}
	return body[start : end+1], end + 1
}

func matchingBrace(body []byte, start int) int {
	depth := 0
	inString := false
	escaped := false
	for index := start; index < len(body); index++ {
		character := body[index]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if character == '\\' {
				escaped = true
				continue
			}
			if character == '"' {
				inString = false
			}
			continue
		}
		switch character {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return index
			}
		}
	}
	return -1
}

func escapeJSONString(value []byte) []byte {
	result := make([]byte, 0, len(value)+8)
	for _, character := range value {
		switch character {
		case '\\', '"':
			result = append(result, '\\', character)
		case '\n':
			result = append(result, '\\', 'n')
		case '\r':
			result = append(result, '\\', 'r')
		case '\t':
			result = append(result, '\\', 't')
		default:
			result = append(result, character)
		}
	}
	return result
}

func isJSONSpace(character byte) bool {
	return character == ' ' || character == '\n' || character == '\r' || character == '\t'
}

func (manager *proxyManager) rewriteJSON(value any, parentKey string) (bool, error) {
	changed := false
	switch typed := value.(type) {
	case map[string]any:
		if parentKey == "brokerAddrs" {
			for key, raw := range typed {
				address, ok := raw.(string)
				if !ok || address == "" {
					continue
				}
				local, err := manager.ProxyFor(address, proxyTargetBroker)
				if err != nil {
					return changed, err
				}
				typed[key] = local
				changed = true
			}
			return changed, nil
		}
		if parentKey == "filterServerTable" {
			rewritten := make(map[string]any, len(typed))
			for address, raw := range typed {
				local, err := manager.ProxyFor(address, proxyTargetBroker)
				if err != nil {
					return changed, err
				}
				rewritten[local] = raw
				changed = true
			}
			for key := range typed {
				delete(typed, key)
			}
			for key, raw := range rewritten {
				typed[key] = raw
			}
		}
		for key, child := range typed {
			if key == "brokerAddr" {
				if address, ok := child.(string); ok && address != "" {
					local, err := manager.ProxyFor(address, proxyTargetBroker)
					if err != nil {
						return changed, err
					}
					typed[key] = local
					changed = true
					continue
				}
			}
			childChanged, err := manager.rewriteJSON(child, key)
			if err != nil {
				return changed, err
			}
			changed = changed || childChanged
		}
	case []any:
		for _, child := range typed {
			childChanged, err := manager.rewriteJSON(child, parentKey)
			if err != nil {
				return changed, err
			}
			changed = changed || childChanged
		}
	}
	return changed, nil
}
