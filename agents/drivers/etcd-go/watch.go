package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"go.etcd.io/etcd/api/v3/mvccpb"
	clientv3 "go.etcd.io/etcd/client/v3"
)

const (
	maxWatches                 = 4
	maxWatchBatches            = 256
	maxWatchEvents             = 10000
	maxWatchBufferBytes        = int64(8 * 1024 * 1024)
	maxSessionWatchBufferBytes = int64(16 * 1024 * 1024)
)

type bufferedWatchBatch struct {
	payload       map[string]any
	bufferedBytes int64
}

// watchState buffers watch events for the polling host. Terminal states are
// only surfaced after the buffer drains, mirroring the Java implementation.
type watchState struct {
	watchID string
	session *etcdSession

	mu                sync.Mutex
	batches           []bufferedWatchBatch
	eventCount        int
	bufferedBytes     int64
	terminalReason    string
	terminalMessage   string
	compactedRevision *int64
	watchCancel       context.CancelFunc
	closed            bool
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
	w.closeWatcherLocked()
}

func (w *watchState) fail(reason, message string, compacted *int64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.terminalReason == "" {
		w.terminalReason = reason
		w.terminalMessage = message
		w.compactedRevision = compacted
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
		terminal := map[string]any{
			"reason":  w.terminalReason,
			"message": w.terminalMessage,
		}
		if w.compactedRevision != nil {
			terminal["compactedRevision"] = longString(*w.compactedRevision)
		} else {
			terminal["compactedRevision"] = nil
		}
		result["terminal"] = terminal
	}
	return result
}

func (w *watchState) close() {
	w.mu.Lock()
	w.failLocked("stopped", "watch stopped", nil)
	w.clearBufferedLocked()
	w.closed = true
	cancel := w.watchCancel
	w.watchCancel = nil
	w.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (w *watchState) failLocked(reason, message string, compacted *int64) {
	if w.terminalReason == "" {
		w.terminalReason = reason
		w.terminalMessage = message
		w.compactedRevision = compacted
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

func (w *watchState) attachWatcher(cancel context.CancelFunc) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.terminalReason != "" {
		cancel()
		return
	}
	w.watchCancel = cancel
}

func (w *watchState) closeWatcherLocked() {
	cancel := w.watchCancel
	w.watchCancel = nil
	if cancel != nil {
		go cancel()
	}
}

func watchEventBufferBytes(item, previous *mvccpb.KeyValue) int64 {
	bytes := int64(512 + estimatedBufferedBytes(len(item.Key)))
	bytes += estimatedBufferedBytes(len(item.Value))
	if previous != nil && previous.Version > 0 {
		bytes += estimatedBufferedBytes(len(previous.Value))
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

func (s *etcdSession) watchCount() int {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	return len(s.watches)
}

func (s *etcdSession) registerWatch(id string, state *watchState) bool {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	if _, exists := s.watches[id]; exists {
		return false
	}
	s.watches[id] = state
	return true
}

func (s *etcdSession) removeWatch(id string) *watchState {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	state := s.watches[id]
	delete(s.watches, id)
	return state
}

func (s *etcdSession) watchStart(params map[string]json.RawMessage) (any, error) {
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
	requestedRevision := longOrNull(params, "startRevision")
	var startedRevision int64
	if requestedRevision != nil && *requestedRevision > 0 {
		startedRevision = *requestedRevision
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
		response, err := client.Get(ctx, "\x00", clientv3.WithRange("\x00"), clientv3.WithCountOnly())
		cancel()
		if err != nil {
			return nil, err
		}
		startedRevision = response.Header.Revision + 1
	}

	watchID := newWatchID()
	state := &watchState{watchID: watchID, session: s}
	options := []clientv3.OpOption{clientv3.WithRev(startedRevision)}
	if boolOrDefault(params, "includePrevKv", false) {
		options = append(options, clientv3.WithPrevKV())
	}
	if scope == "prefix" {
		options = append(options, clientv3.WithRange(prefixEnd(key)))
	}
	watchCtx, watchCancel := context.WithCancel(context.Background())
	channel := client.Watch(watchCtx, key, options...)
	go consumeWatchChannel(channel, state)
	state.attachWatcher(watchCancel)
	s.registerWatch(watchID, state)
	return map[string]any{"watchId": watchID, "startedRevision": longString(startedRevision)}, nil
}

func consumeWatchChannel(channel clientv3.WatchChan, state *watchState) {
	for response := range channel {
		if response.Err() != nil {
			state.fail("error", response.Err().Error(), nil)
			continue
		}
		if response.Canceled {
			if response.CompactRevision > 0 {
				compacted := response.CompactRevision
				state.fail("compacted", "ETCD_COMPACTED", &compacted)
			} else {
				state.fail("closed", "watch closed", nil)
			}
			continue
		}
		if len(response.Events) == 0 {
			continue
		}
		events := make([]map[string]any, 0, len(response.Events))
		bufferedBytes := int64(128)
		overflowed := false
		for _, event := range response.Events {
			item := event.Kv
			var previous *mvccpb.KeyValue
			if event.PrevKv != nil {
				previous = event.PrevKv
			}
			bufferedBytes += watchEventBufferBytes(item, previous)
			if bufferedBytes > maxWatchBufferBytes {
				state.failOverflow()
				overflowed = true
				break
			}
			events = append(events, watchEventRow(event, item, previous))
		}
		if overflowed {
			continue
		}
		state.append(response.Header.Revision, events, bufferedBytes)
	}
}

func (w *watchState) failOverflow() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.overflowLocked()
}

func watchEventRow(event *clientv3.Event, item, previous *mvccpb.KeyValue) map[string]any {
	row := map[string]any{
		"eventType": eventType(event),
		"revision":  longString(item.ModRevision),
		"key":       displayBytes(item.Key),
		"keyBytes":  bytesObject(item.Key),
	}
	if event.Type == mvccpb.DELETE {
		row["value"] = nil
	} else {
		row["value"] = valueObject(item.Value)
	}
	if previous != nil && previous.Version > 0 {
		row["previousValue"] = valueObject(previous.Value)
	} else {
		row["previousValue"] = nil
	}
	if event.Type == mvccpb.DELETE && previous != nil {
		row["metadata"] = metadataMap(previous)
	} else {
		row["metadata"] = metadataMap(item)
	}
	return row
}

func eventType(event *clientv3.Event) string {
	if event.Type == mvccpb.DELETE {
		return "delete"
	}
	return "put"
}

func (s *etcdSession) watchPoll(params map[string]json.RawMessage) (any, error) {
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

func (s *etcdSession) watchStop(params map[string]json.RawMessage) (any, error) {
	if state := s.removeWatch(stringOrDefault(params, "watchId", "")); state != nil {
		state.close()
	}
	return map[string]bool{"stopped": true}, nil
}
