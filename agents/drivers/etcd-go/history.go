package main

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"sync"
	"time"

	"go.etcd.io/etcd/api/v3/mvccpb"
	"go.etcd.io/etcd/api/v3/v3rpc/rpctypes"
	clientv3 "go.etcd.io/etcd/client/v3"
)

const (
	historyDefaultRevisionWindow = int64(10000)
	historyLimitMax              = 500
)

type historyCollector struct {
	mu        sync.Mutex
	rows      []map[string]any
	limit     int
	truncated bool
}

func (c *historyCollector) append(row map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.rows) == c.limit {
		c.rows = c.rows[1:]
		c.truncated = true
	}
	c.rows = append(c.rows, row)
}

func (s *etcdSession) history(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	key, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	limit := intOrDefault(params, "limit", 100)
	if limit < 1 {
		limit = 1
	}
	if limit > historyLimitMax {
		limit = historyLimitMax
	}
	requestedEnd := longOrNull(params, "endRevision")

	ctx, cancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
	latestOptions := []clientv3.OpOption{}
	if requestedEnd != nil && *requestedEnd > 0 {
		latestOptions = append(latestOptions, clientv3.WithRev(*requestedEnd))
	}
	latest, err := client.Get(ctx, key, latestOptions...)
	cancel()
	if err != nil {
		if errors.Is(err, rpctypes.ErrCompacted) {
			if revision, ok := compactedRevisionOf(client, key); ok {
				return nil, errors.New("ETCD_COMPACTED: requested history was compacted at revision " + longString(revision))
			}
			return nil, errors.New("ETCD_COMPACTED: requested history was compacted")
		}
		return nil, err
	}
	var endRevision int64
	if requestedEnd != nil {
		endRevision = *requestedEnd
	} else {
		endRevision = latest.Header.Revision
	}
	var targetKeyRevision int64
	if len(latest.Kvs) == 0 {
		targetKeyRevision = endRevision
	} else {
		targetKeyRevision = latest.Kvs[0].ModRevision
	}
	requestedStart := longOrNull(params, "startRevision")
	startRevision := historyStartRevision(requestedStart, targetKeyRevision)
	if startRevision > targetKeyRevision {
		return map[string]any{
			"events":           []any{},
			"observedRevision": longString(endRevision),
			"truncated":        false,
		}, nil
	}

	collector := &historyCollector{limit: limit, truncated: requestedStart == nil && startRevision > 1}
	created := make(chan struct{})
	var createdOnce sync.Once
	completed := make(chan struct{})
	var completedOnce sync.Once
	var failure error
	var failureMu sync.Mutex

	watchCtx, watchCancel := context.WithCancel(context.Background())
	channel := client.Watch(watchCtx, key,
		clientv3.WithRev(startRevision),
		clientv3.WithPrevKV(),
		clientv3.WithProgressNotify(),
		// clientv3 only posts the created response when this option is set;
		// the created gate relies on it (jetcd withCreateNotify parity).
		clientv3.WithCreatedNotify(),
	)
	go func() {
		for response := range channel {
			if response.Err() != nil {
				failureMu.Lock()
				failure = response.Err()
				failureMu.Unlock()
				completedOnce.Do(func() { close(completed) })
				continue
			}
			if response.Canceled {
				if response.CompactRevision > 0 {
					err := errors.New("ETCD_COMPACTED: requested history was compacted at revision " + longString(response.CompactRevision))
					failureMu.Lock()
					failure = err
					failureMu.Unlock()
				}
				completedOnce.Do(func() { close(completed) })
				continue
			}
			createdOnce.Do(func() { close(created) })
			for _, event := range response.Events {
				item := event.Kv
				revision := item.ModRevision
				if revision > endRevision {
					continue
				}
				var previous *mvccpb.KeyValue
				if event.PrevKv != nil {
					previous = event.PrevKv
				}
				row := map[string]any{
					"eventType": eventType(event),
					"revision":  longString(revision),
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
				collector.append(row)
				if revision >= targetKeyRevision {
					completedOnce.Do(func() { close(completed) })
				}
			}
			if response.IsProgressNotify() && response.Header.Revision >= endRevision {
				completedOnce.Do(func() { close(completed) })
			}
		}
		completedOnce.Do(func() { close(completed) })
	}()
	defer watchCancel()

	select {
	case <-created:
	case <-time.After(5 * time.Second):
		return nil, errors.New("ETCD_HISTORY_TIMEOUT: watcher was not created")
	}
	// For an existing exact key, its latest mod revision is an explicit
	// replay boundary. This avoids relying on progress notifications,
	// which older etcd/jetcd combinations do not consistently emit.
	progressCtx, progressCancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
	_ = client.RequestProgress(progressCtx)
	progressCancel()
	select {
	case <-completed:
	case <-time.After(15 * time.Second):
		return nil, errors.New("ETCD_HISTORY_TIMEOUT: history replay did not reach the requested revision")
	}

	failureMu.Lock()
	historyFailure := failure
	failureMu.Unlock()
	if historyFailure != nil {
		if errors.Is(historyFailure, rpctypes.ErrCompacted) {
			if revision, ok := compactedRevisionOf(client, key); ok {
				return nil, errors.New("ETCD_COMPACTED: requested history was compacted at revision " + longString(revision))
			}
			return nil, errors.New("ETCD_COMPACTED: requested history was compacted")
		}
		return nil, errors.New("ETCD_HISTORY_FAILED: " + historyFailure.Error())
	}

	collector.mu.Lock()
	rows := make([]map[string]any, len(collector.rows))
	copy(rows, collector.rows)
	truncated := collector.truncated
	collector.mu.Unlock()
	sort.SliceStable(rows, func(i, j int) bool {
		a, _ := strconv.ParseInt(rows[i]["revision"].(string), 10, 64)
		b, _ := strconv.ParseInt(rows[j]["revision"].(string), 10, 64)
		return a > b
	})
	serialized := make([]any, len(rows))
	for i, row := range rows {
		serialized[i] = row
	}
	return map[string]any{
		"events":           serialized,
		"observedRevision": longString(endRevision),
		"truncated":        truncated,
	}, nil
}

func historyStartRevision(requestedStart *int64, targetRevision int64) int64 {
	if requestedStart != nil {
		if *requestedStart < 1 {
			return 1
		}
		return *requestedStart
	}
	start := targetRevision - historyDefaultRevisionWindow + 1
	if start < 1 {
		return 1
	}
	return start
}

// compactedRevisionOf recovers the compaction boundary that gRPC errors do not
// carry: a watch from revision 1 is cancelled immediately with the compacted
// revision in its response.
func compactedRevisionOf(client *clientv3.Client, key string) (int64, bool) {
	watchCtx, watchCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer watchCancel()
	channel := client.Watch(watchCtx, key, clientv3.WithRev(1))
	select {
	case response := <-channel:
		if response.CompactRevision > 0 {
			return response.CompactRevision, true
		}
		return 0, false
	case <-watchCtx.Done():
		return 0, false
	}
}
