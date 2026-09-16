package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	"go.etcd.io/etcd/api/v3/etcdserverpb"
	clientv3 "go.etcd.io/etcd/client/v3"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	maxLeaseAttachedKeys     = 256
	defaultLeaseListLimit    = 100
	maxLeaseListLimit        = 200
	leaseListConcurrency     = 8
	leaseListDeadlineSeconds = 5
)

type leaseListDeadline struct {
	deadline time.Time
}

func (d leaseListDeadline) remaining() (time.Duration, error) {
	remaining := time.Until(d.deadline)
	if remaining <= 0 {
		return 0, errors.New("ETCD_LEASE_LIST_TIMEOUT")
	}
	return remaining, nil
}

func (s *etcdSession) leaseList(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	deadline := leaseListDeadline{deadline: time.Now().Add(leaseListDeadlineSeconds * time.Second)}
	limit := intOrDefault(params, "limit", defaultLeaseListLimit)
	if limit < 1 {
		limit = 1
	}
	if limit > maxLeaseListLimit {
		limit = maxLeaseListLimit
	}
	continuation := stringOrNull(params, "continuation")
	var afterLeaseID *uint64
	if continuation != nil && *continuation != "" {
		parsed, err := parseUnsignedLong(*continuation)
		if err != nil {
			return nil, err
		}
		afterLeaseID = &parsed
	}

	partial := false
	leaseIDs, err := clusterLeaseIDs(client, deadline)
	if err != nil {
		if isLeaseListFallbackError(err) {
			leaseIDs = s.knownLeaseIDs()
			partial = true
		} else {
			return nil, err
		}
	} else {
		for _, id := range leaseIDs {
			s.rememberLease(id)
		}
	}
	leaseIDs = leasePageIDs(leaseIDs, afterLeaseID, limit+1)
	hasMore := len(leaseIDs) > limit
	if len(leaseIDs) > limit {
		leaseIDs = leaseIDs[:limit]
	}

	leases := []map[string]any{}
	var lastProcessedID *uint64
	deadlineReached := false
chunkLoop:
	for offset := 0; offset < len(leaseIDs); offset += leaseListConcurrency {
		end := offset + leaseListConcurrency
		if end > len(leaseIDs) {
			end = len(leaseIDs)
		}
		chunkIDs := leaseIDs[offset:end]

		type ttlResult struct {
			id      uint64
			ttl     int64
			granted int64
			err     error
		}
		results := make([]chan ttlResult, len(chunkIDs))
		for index, id := range chunkIDs {
			channel := make(chan ttlResult, 1)
			results[index] = channel
			go func(id uint64, channel chan ttlResult) {
				remaining, err := deadline.remaining()
				if err != nil {
					channel <- ttlResult{id: id, err: err}
					return
				}
				ctx, cancel := context.WithTimeout(context.Background(), remaining)
				defer cancel()
				response, err := client.Lease.TimeToLive(ctx, clientv3.LeaseID(int64(id)))
				if err != nil {
					channel <- ttlResult{id: id, err: err}
					return
				}
				channel <- ttlResult{id: id, ttl: response.TTL, granted: response.GrantedTTL}
			}(id, channel)
		}
		for _, channel := range results {
			result := <-channel
			id := result.id
			if result.err != nil {
				if errors.Is(result.err, errLeaseListDeadline) || isDeadlineError(result.err) {
					partial = true
					deadlineReached = true
					break chunkLoop
				}
				if status.Code(result.err) == codes.NotFound {
					s.forgetLease(id)
				} else {
					partial = true
				}
				lastProcessedID = &id
				continue
			}
			leases = append(leases, map[string]any{
				"id":         unsignedLongString(int64(id)),
				"ttl":        result.ttl,
				"grantedTtl": result.granted,
			})
			processed := id
			lastProcessedID = &processed
		}
	}

	var nextContinuation any
	if deadlineReached && len(leaseIDs) > 0 {
		if lastProcessedID != nil {
			nextContinuation = unsignedLongString(int64(*lastProcessedID))
		} else if afterLeaseID != nil {
			nextContinuation = unsignedLongString(int64(*afterLeaseID))
		} else {
			nextContinuation = "0"
		}
	} else if hasMore && len(leaseIDs) > 0 {
		nextContinuation = unsignedLongString(int64(leaseIDs[len(leaseIDs)-1]))
	}
	return map[string]any{
		"leases":           leases,
		"partial":          partial,
		"nextContinuation": nextContinuation,
	}, nil
}

var errLeaseListDeadline = errors.New("ETCD_LEASE_LIST_TIMEOUT")

func isDeadlineError(err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || status.Code(err) == codes.DeadlineExceeded
}

func isLeaseListFallbackError(err error) bool {
	if errors.Is(err, errLeaseListDeadline) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	code := status.Code(err)
	return code == codes.Unimplemented || code == codes.DeadlineExceeded
}

func parseUnsignedLong(value string) (uint64, error) {
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid lease continuation: %s", value)
	}
	return parsed, nil
}

func leasePageIDs(leaseIDs []uint64, afterLeaseID *uint64, fetchLimit int) []uint64 {
	sorted := make([]uint64, len(leaseIDs))
	copy(sorted, leaseIDs)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	result := []uint64{}
	for _, id := range sorted {
		if afterLeaseID != nil && id <= *afterLeaseID {
			continue
		}
		if len(result) >= fetchLimit {
			break
		}
		result = append(result, id)
	}
	return result
}

func clusterLeaseIDs(client *clientv3.Client, deadline leaseListDeadline) ([]uint64, error) {
	remaining, err := deadline.remaining()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), remaining)
	defer cancel()
	leaseClient := etcdserverpb.NewLeaseClient(client.ActiveConnection())
	response, err := leaseClient.LeaseLeases(ctx, &etcdserverpb.LeaseLeasesRequest{})
	if err != nil {
		return nil, err
	}
	ids := make([]uint64, 0, len(response.Leases))
	for _, lease := range response.Leases {
		ids = append(ids, uint64(lease.ID))
	}
	return ids, nil
}

func (s *etcdSession) leaseGet(params map[string]json.RawMessage) (any, error) {
	id, err := requiredPositiveLong(params, "id")
	if err != nil {
		return nil, err
	}
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	options := []clientv3.LeaseOption{}
	if boolOrDefault(params, "includeKeys", false) {
		options = append(options, clientv3.WithAttachedKeys())
	}
	response, err := client.Lease.TimeToLive(ctx, clientv3.LeaseID(id), options...)
	if err != nil {
		return nil, err
	}
	s.rememberLease(uint64(id))
	keys := []map[string]any{}
	for index, key := range response.Keys {
		if index >= maxLeaseAttachedKeys {
			break
		}
		keys = append(keys, bytesObject(key))
	}
	return map[string]any{
		"id":         unsignedLongString(int64(response.ID)),
		"ttl":        response.TTL,
		"grantedTtl": response.GrantedTTL,
		"keys":       keys,
		"truncated":  len(response.Keys) > maxLeaseAttachedKeys,
	}, nil
}

func (s *etcdSession) leaseGrant(params map[string]json.RawMessage) (any, error) {
	ttl, err := requiredPositiveLong(params, "ttl")
	if err != nil {
		return nil, err
	}
	requestedID := longOrNull(params, "id")
	if requestedID != nil && *requestedID < 0 {
		return nil, errors.New("id must be a positive integer or 0")
	}
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	var grantedID clientv3.LeaseID
	var grantedTTL int64
	if requestedID == nil || *requestedID == 0 {
		response, err := client.Lease.Grant(ctx, ttl)
		if err != nil {
			return nil, err
		}
		grantedID = response.ID
		grantedTTL = response.TTL
	} else {
		leaseClient := etcdserverpb.NewLeaseClient(client.ActiveConnection())
		response, err := leaseClient.LeaseGrant(ctx, &etcdserverpb.LeaseGrantRequest{TTL: ttl, ID: *requestedID})
		if err != nil {
			return nil, err
		}
		grantedID = clientv3.LeaseID(response.ID)
		grantedTTL = response.TTL
	}
	s.rememberLease(uint64(grantedID))
	return map[string]any{
		"id":  unsignedLongString(int64(grantedID)),
		"ttl": grantedTTL,
	}, nil
}

func (s *etcdSession) leaseKeepAlive(params map[string]json.RawMessage) (any, error) {
	id, err := requiredPositiveLong(params, "id")
	if err != nil {
		return nil, err
	}
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	response, err := client.Lease.KeepAliveOnce(ctx, clientv3.LeaseID(id))
	if err != nil {
		return nil, err
	}
	s.rememberLease(uint64(id))
	return map[string]any{
		"id":  unsignedLongString(id),
		"ttl": response.TTL,
	}, nil
}

func (s *etcdSession) leaseRevoke(params map[string]json.RawMessage) (any, error) {
	id, err := requiredPositiveLong(params, "id")
	if err != nil {
		return nil, err
	}
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if _, err := client.Lease.Revoke(ctx, clientv3.LeaseID(id)); err != nil {
		return nil, err
	}
	s.forgetLease(uint64(id))
	return map[string]any{
		"id":      unsignedLongString(id),
		"revoked": true,
	}, nil
}
