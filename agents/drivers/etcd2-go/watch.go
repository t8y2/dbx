package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

const (
	maxWatches                 = 4
	maxWatchBatches            = 256
	maxWatchEvents             = 10000
	maxWatchBufferBytes        = int64(8 * 1024 * 1024)
	maxSessionWatchBufferBytes = int64(16 * 1024 * 1024)
	// v2 long polls hold until an event arrives; re-issue the request when a
	// poll is cut off so the pump survives idle periods.
	watchPollTimeout = 5 * time.Minute
)

type bufferedWatchBatch struct {
	payload       map[string]any
	bufferedBytes int64
}

// watchState buffers watch events for the polling host, mirroring the v3
// agent's budget system so host-side expectations stay identical.
type watchState struct {
	watchID string
	session *etcd2Session

	mu              sync.Mutex
	batches         []bufferedWatchBatch
	eventCount      int
	bufferedBytes   int64
	terminalReason  string
	terminalMessage string
	pumpCancel      context.CancelFunc
	closed          bool
}

func (w *watchState) append(revision int64, events []map[string]any, batchBytes int64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.terminalReason != "" {
		return
	}
	if int64(len(w.batches)) >= maxWatchBatches ||
		int64(w.eventCount+len(events)) > maxWatchEvents ||
		batchBytes > maxWatchBufferBytes ||
		w.bufferedBytes+batchBytes > maxWatchBufferBytes ||
		!w.session.reserveWatchBuffer(batchBytes) {
		w.overflowLocked()
		return
	}
	w.batches = append(w.batches, bufferedWatchBatch{
		payload:       map[string]any{"revision": longString(revision), "events": events},
		bufferedBytes: batchBytes,
	})
	w.eventCount += len(events)
	w.bufferedBytes += batchBytes
}

func (w *watchState) overflowLocked() {
	if w.terminalReason != "" {
		return
	}
	w.terminalReason = "overflow"
	w.terminalMessage = "ETCD_WATCH_OVERFLOW: the event buffer reached its byte or event limit"
	w.stopPumpLocked()
}

func (w *watchState) fail(reason, message string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.terminalReason == "" {
		w.terminalReason = reason
		w.terminalMessage = message
	}
}

func (w *watchState) poll() map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	page := make([]any, 0, 64)
	for len(w.batches) > 0 && len(page) < 64 {
		batch := w.batches[0]
		w.batches = w.batches[1:]
		events := batch.payload["events"].([]map[string]any)
		w.eventCount -= len(events)
		w.bufferedBytes -= batch.bufferedBytes
		w.session.releaseWatchBuffer(batch.bufferedBytes)
		page = append(page, batch.payload)
	}
	result := map[string]any{"watchId": w.watchID, "batches": page}
	if w.terminalReason != "" && len(w.batches) == 0 {
		result["terminal"] = map[string]any{
			"reason":  w.terminalReason,
			"message": w.terminalMessage,
		}
	}
	return result
}

func (w *watchState) close() {
	w.mu.Lock()
	w.failLocked("stopped", "watch stopped")
	w.clearBufferedLocked()
	w.closed = true
	cancel := w.pumpCancel
	w.pumpCancel = nil
	w.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (w *watchState) failLocked(reason, message string) {
	if w.terminalReason == "" {
		w.terminalReason = reason
		w.terminalMessage = message
	}
}

func (w *watchState) clearBufferedLocked() {
	if w.bufferedBytes > 0 {
		w.session.releaseWatchBuffer(w.bufferedBytes)
	}
	w.batches = nil
	w.eventCount = 0
	w.bufferedBytes = 0
}

func (w *watchState) attachPump(cancel context.CancelFunc) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.terminalReason != "" {
		cancel()
		return
	}
	w.pumpCancel = cancel
}

func (w *watchState) stopPumpLocked() {
	cancel := w.pumpCancel
	w.pumpCancel = nil
	if cancel != nil {
		go cancel()
	}
}

func watchEventBufferBytes(key, value, previousValue string) int64 {
	bytes := int64(512 + 4*len(key))
	bytes += estimatedBufferedBytes(len(value))
	if previousValue != "" {
		bytes += estimatedBufferedBytes(len(previousValue))
	}
	return bytes
}

func estimatedBufferedBytes(sourceBytes int) int64 {
	if sourceBytes < 0 {
		return 0
	}
	return int64(sourceBytes) * 4
}

func newWatchID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return base64.StdEncoding.EncodeToString(bytes[:])
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(bytes[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexed[0:8], hexed[8:12], hexed[12:16], hexed[16:20], hexed[20:32])
}

func (s *etcd2Session) watchCount() int {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	return len(s.watches)
}

func (s *etcd2Session) registerWatch(id string, state *watchState) bool {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	if _, exists := s.watches[id]; exists {
		return false
	}
	s.watches[id] = state
	return true
}

func (s *etcd2Session) removeWatch(id string) *watchState {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	state := s.watches[id]
	delete(s.watches, id)
	return state
}

func (s *etcd2Session) watchStart(params map[string]json.RawMessage) (any, error) {
	if s.watchCount() >= maxWatches {
		return nil, fmt.Errorf("ETCD_WATCH_LIMIT: at most %d watches are allowed per connection", maxWatches)
	}
	key, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	scope := stringOrDefault(params, "scope", "key")
	if scope != "key" && scope != "prefix" {
		return nil, errors.New("ETCD_WATCH_SCOPE_INVALID: scope must be key or prefix")
	}
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}

	// startRevision maps to the v2 waitIndex: default to the current index+1.
	requestedRevision := longOrNull(params, "startRevision")
	var waitIndex int64
	if requestedRevision != nil && *requestedRevision > 0 {
		waitIndex = *requestedRevision
	} else {
		current, err := client.currentEtcdIndex()
		if err != nil {
			return nil, err
		}
		waitIndex = current + 1
	}

	watchID := newWatchID()
	state := &watchState{watchID: watchID, session: s}
	pumpCtx, pumpCancel := context.WithCancel(context.Background())
	go pumpLongPollWatch(pumpCtx, client, key, scope, waitIndex, boolOrDefault(params, "includePrevKv", false), state)
	state.attachPump(pumpCancel)
	s.registerWatch(watchID, state)
	return map[string]any{"watchId": watchID, "startedRevision": longString(waitIndex)}, nil
}

// currentEtcdIndex reads the X-Etcd-Index header from a lightweight GET.
func (c *authenticatedClient) currentEtcdIndex() (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	response, err := c.request(ctx, http.MethodGet, "/v2/keys/", "", nil)
	if err != nil {
		return 0, err
	}
	defer drainClose(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return 0, errorFromResponse(response.StatusCode, body)
	}
	index, err := strconv.ParseInt(response.Header.Get("X-Etcd-Index"), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("etcd v2 server did not report X-Etcd-Index")
	}
	return index, nil
}

// pumpLongPollWatch drives the v2 wait loop: each response becomes one batch;
// timeouts and connection blips re-issue the same waitIndex.
func pumpLongPollWatch(ctx context.Context, client *authenticatedClient, key, scope string, waitIndex int64, includePrevKv bool, state *watchState) {
	for {
		if ctx.Err() != nil || state.hasTerminal() {
			return
		}
		query := url.Values{}
		query.Set("wait", "true")
		query.Set("waitIndex", strconv.FormatInt(waitIndex, 10))
		if scope == "prefix" {
			query.Set("recursive", "true")
		}
		pollCtx, pollCancel := context.WithTimeout(ctx, watchPollTimeout)
		body, _, err := client.do(pollCtx, http.MethodGet, v2KeyPath(key)+"?"+query.Encode(), "", nil)
		pollCancel()
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				// Idle long poll cut off: keep waiting from the same index.
				continue
			}
			if ctx.Err() != nil {
				return
			}
			var etcdErr *etcdError
			if errors.As(err, &etcdErr) && etcdErr.errorCode == 401 {
				state.fail("error", "ETCD_WATCH_EXPIRED: the watched index was cleared from the etcd v2 event history")
				return
			}
			state.fail("error", "watch failed: "+err.Error())
			return
		}
		var parsed v2KeysResponse
		if jsonErr := json.Unmarshal(body, &parsed); jsonErr != nil {
			state.fail("error", "watch response was not valid etcd v2 JSON: "+jsonErr.Error())
			return
		}
		if parsed.Node == nil {
			waitIndex++
			continue
		}
		events := []map[string]any{}
		bufferedBytes := int64(128)
		node := parsed.Node
		previous := parsed.PrevNode
		deleted := parsed.Action == "delete" || parsed.Action == "expire"
		previousValue := ""
		if previous != nil {
			previousValue = previous.Value
		}
		bufferedBytes += watchEventBufferBytes(node.Key, node.Value, previousValue)
		if bufferedBytes > maxWatchBufferBytes {
			state.mu.Lock()
			state.overflowLocked()
			state.mu.Unlock()
			return
		}
		row := map[string]any{
			"eventType": eventTypeForAction(parsed.Action),
			"revision":  longString(node.ModifiedIndex),
			"key":       node.Key,
			"keyBytes":  bytesObject([]byte(node.Key)),
		}
		if deleted {
			row["value"] = nil
		} else {
			row["value"] = valueObject([]byte(node.Value))
		}
		if includePrevKv && previous != nil && previous.Value != "" {
			row["previousValue"] = valueObject([]byte(previous.Value))
		} else {
			row["previousValue"] = nil
		}
		if deleted && previous != nil {
			row["metadata"] = nodeMetadata(previous)
		} else {
			row["metadata"] = nodeMetadata(node)
		}
		events = append(events, row)
		state.append(node.ModifiedIndex, events, bufferedBytes)
		nextIndex := node.ModifiedIndex + 1
		if nextIndex > waitIndex {
			waitIndex = nextIndex
		} else {
			waitIndex++
		}
	}
}

func eventTypeForAction(action string) string {
	if action == "delete" || action == "expire" || action == "compareAndDelete" {
		return "delete"
	}
	return "put"
}

func (w *watchState) hasTerminal() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.terminalReason != ""
}

func (s *etcd2Session) watchPoll(params map[string]json.RawMessage) (any, error) {
	watchID := stringOrDefault(params, "watchId", "")
	s.watchesMu.Lock()
	state := s.watches[watchID]
	s.watchesMu.Unlock()
	if state == nil {
		return nil, errors.New("ETCD_WATCH_NOT_FOUND: watch does not exist")
	}
	result := state.poll()
	if _, terminal := result["terminal"]; terminal {
		if removed := s.removeWatch(watchID); removed != nil {
			removed.close()
		}
	}
	return result, nil
}

func (s *etcd2Session) watchStop(params map[string]json.RawMessage) (any, error) {
	if state := s.removeWatch(stringOrDefault(params, "watchId", "")); state != nil {
		state.close()
	}
	return map[string]bool{"stopped": true}, nil
}
