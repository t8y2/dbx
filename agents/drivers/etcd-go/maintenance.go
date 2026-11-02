package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"go.etcd.io/etcd/api/v3/v3rpc/rpctypes"
	clientv3 "go.etcd.io/etcd/client/v3"
)

func jsonUnmarshal(raw json.RawMessage, target any) error {
	return json.Unmarshal(raw, target)
}

func (s *etcdSession) compact(params map[string]json.RawMessage) (any, error) {
	revision, err := requiredPositiveLong(params, "revision")
	if err != nil {
		return nil, err
	}
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
	_, err = client.Get(ctx, "\x00", clientv3.WithRange("\x00"), clientv3.WithCountOnly(), clientv3.WithRev(revision))
	cancel()
	if err != nil {
		if errors.Is(err, rpctypes.ErrCompacted) {
			if compacted, ok := compactedRevisionOf(client, "\x00"); ok {
				return nil, errors.New("ETCD_INVALID_REVISION: revision was already compacted at " + longString(compacted))
			}
			return nil, errors.New("ETCD_INVALID_REVISION: revision was already compacted")
		}
		return nil, err
	}
	currentCtx, currentCancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
	current, err := client.Get(currentCtx, "\x00", clientv3.WithRange("\x00"), clientv3.WithCountOnly())
	currentCancel()
	if err != nil {
		return nil, err
	}
	if revision > current.Header.Revision {
		return nil, errors.New("ETCD_INVALID_REVISION: revision is newer than the current revision")
	}
	compactCtx, compactCancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
	defer compactCancel()
	if _, err := client.Compact(compactCtx, revision); err != nil {
		return nil, err
	}
	return map[string]any{"revision": longString(revision)}, nil
}

func (s *etcdSession) defrag(params map[string]json.RawMessage) (any, error) {
	var targets []string
	if raw := params["endpoints"]; len(raw) > 0 && string(raw) != "null" {
		var list []string
		if jsonUnmarshal(raw, &list) == nil {
			for _, endpoint := range list {
				if endpoint != "" && !containsString(targets, endpoint) {
					targets = append(targets, endpoint)
				}
			}
		}
	}
	if len(targets) == 0 {
		return nil, errors.New("ETCD_DEFRAG_TARGET_REQUIRED: at least one endpoint is required")
	}
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}

	members := []map[string]any{}
	remaining := targets
	for len(remaining) > 0 {
		endpoint, err := nextDefragEndpoint(client, remaining)
		if err != nil {
			return nil, err
		}
		started := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
		_, defragErr := client.Maintenance.Defragment(ctx, endpoint)
		cancel()
		durationMs := time.Since(started).Milliseconds()
		if defragErr != nil {
			members = append(members, map[string]any{
				"endpoint":   endpoint,
				"status":     "failed",
				"durationMs": durationMs,
				"error":      defragErr.Error(),
			})
			appendUnexecutedDefragMembers(&members, remaining, endpoint)
			break
		}
		members = append(members, map[string]any{
			"endpoint":   endpoint,
			"status":     "succeeded",
			"durationMs": durationMs,
		})
		remaining = removeString(remaining, endpoint)
	}
	return map[string]any{"members": members}, nil
}

func appendUnexecutedDefragMembers(members *[]map[string]any, remaining []string, failedEndpoint string) {
	for _, endpoint := range remaining {
		if endpoint == failedEndpoint {
			continue
		}
		*members = append(*members, map[string]any{
			"endpoint":   endpoint,
			"status":     "not_executed",
			"durationMs": nil,
			"error":      nil,
		})
	}
}

// nextDefragEndpoint re-evaluates leadership before each member so a leader
// change is not defragmented early.
func nextDefragEndpoint(client *clientv3.Client, remaining []string) (string, error) {
	var leaderEndpoint string
	for _, endpoint := range remaining {
		ctx, cancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
		statusResponse, err := client.Maintenance.Status(ctx, endpoint)
		cancel()
		if err != nil {
			// The following defragment call reports this member as the failed step.
			continue
		}
		if statusResponse.Header.MemberId == statusResponse.Leader {
			leaderEndpoint = endpoint
			break
		}
	}
	for _, endpoint := range remaining {
		if endpoint != leaderEndpoint {
			return endpoint, nil
		}
	}
	if leaderEndpoint == "" {
		return remaining[0], nil
	}
	return leaderEndpoint, nil
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func removeString(values []string, target string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != target {
			result = append(result, value)
		}
	}
	return result
}
