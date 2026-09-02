package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"go.etcd.io/etcd/api/v3/mvccpb"
	clientv3 "go.etcd.io/etcd/client/v3"
)

const defaultListLimit = 100
const preserveLeaseMaxAttempts = 3

func (s *etcdSession) listPrefix(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	prefix := stringOrDefault(params, "prefix", "")
	limit := intOrDefault(params, "limit", defaultListLimit)
	if limit < 1 {
		limit = 1
	}
	revision := longOrNull(params, "revision")
	includeValues := boolOrDefault(params, "includeValues", false)
	continuation := stringOrNull(params, "continuation")

	start := prefixStart(prefix)
	if continuation != nil && *continuation != "" {
		decoded, err := base64.StdEncoding.DecodeString(*continuation)
		if err != nil {
			return nil, err
		}
		start = string(decoded)
	}

	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	options := []clientv3.OpOption{
		clientv3.WithRange(prefixEnd(prefix)),
		clientv3.WithLimit(int64(limit)),
		clientv3.WithSort(clientv3.SortByKey, clientv3.SortAscend),
	}
	if revision != nil && *revision > 0 {
		options = append(options, clientv3.WithRev(*revision))
	}
	response, err := client.Get(ctx, start, options...)
	if err != nil {
		return nil, err
	}

	keys := make([]any, 0, len(response.Kvs))
	for _, item := range response.Kvs {
		row := metadataMap(item)
		row["key"] = displayBytes(item.Key)
		row["keyBytes"] = bytesObject(item.Key)
		if includeValues {
			row["value"] = valueObject(item.Value)
		}
		keys = append(keys, row)
	}

	result := map[string]any{"keys": keys}
	if response.More && len(response.Kvs) > 0 {
		result["continuation"] = nextContinuation(response.Kvs[len(response.Kvs)-1].Key)
	} else {
		result["continuation"] = nil
	}
	result["revision"] = longString(response.Header.Revision)
	return result, nil
}

func (s *etcdSession) get(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	key, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	revision := longOrNull(params, "revision")

	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	options := []clientv3.OpOption{}
	if revision != nil && *revision > 0 {
		options = append(options, clientv3.WithRev(*revision))
	}
	response, err := client.Get(ctx, key, options...)
	if err != nil {
		return nil, err
	}
	if len(response.Kvs) == 0 {
		return map[string]any{"found": false, "key": nil, "value": nil, "metadata": nil}, nil
	}
	item := response.Kvs[0]
	result := map[string]any{
		"found":    true,
		"key":      displayBytes(item.Key),
		"keyBytes": bytesObject(item.Key),
	}
	if !boolOrDefault(params, "metadataOnly", false) {
		result["value"] = valueObject(item.Value)
	} else {
		result["value"] = nil
	}
	metadata, err := s.metadataWithTtl(item)
	if err != nil {
		return nil, err
	}
	result["metadata"] = metadata
	return result, nil
}

func (s *etcdSession) put(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	key, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	value, err := parseValueObject(rawObject(params, "value"))
	if err != nil {
		return nil, err
	}
	expectedModRevision := longOrNull(params, "expectedModRevision")
	expectedCreateRevision := longOrNull(params, "expectedCreateRevision")
	leaseValue := longOrNull(params, "lease")
	ttlValue := longOrNull(params, "ttl")
	preserveLease := boolOrDefault(params, "preserveLease", false)
	hasLease := leaseValue != nil
	hasTtl := ttlValue != nil
	if (hasLease && hasTtl) || (preserveLease && (hasLease || hasTtl)) {
		return nil, errors.New("lease, ttl, and preserveLease cannot be specified together")
	}

	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if preserveLease {
		revision, err := putPreservingLease(client, ctx, key, value)
		if err != nil {
			return nil, err
		}
		return map[string]any{"revision": longString(revision)}, nil
	}

	var leaseID clientv3.LeaseID
	var grantedLeaseID clientv3.LeaseID
	if hasTtl {
		if *ttlValue <= 0 {
			return nil, errors.New("ttl must be a positive integer")
		}
		grant, err := client.Lease.Grant(ctx, *ttlValue)
		if err != nil {
			return nil, err
		}
		grantedLeaseID = grant.ID
		leaseID = grant.ID
	} else if hasLease {
		leaseID = clientv3.LeaseID(*leaseValue)
	}

	revision, err := func() (int64, error) {
		if expectedModRevision != nil || expectedCreateRevision != nil {
			var comparisons []clientv3.Cmp
			if expectedModRevision != nil {
				comparisons = append(comparisons, clientv3.Compare(clientv3.ModRevision(key), "=", *expectedModRevision))
			}
			if expectedCreateRevision != nil {
				comparisons = append(comparisons, clientv3.Compare(clientv3.CreateRevision(key), "=", *expectedCreateRevision))
			}
			txn := client.Txn(ctx).If(comparisons...).Then(clientv3.OpPut(key, value, clientv3.WithLease(leaseID)))
			response, err := txn.Commit()
			if err != nil {
				return 0, err
			}
			if !response.Succeeded {
				return 0, errors.New("ETCD_CAS_CONFLICT: key changed after it was loaded")
			}
			return response.Header.Revision, nil
		}
		response, err := client.Put(ctx, key, value, clientv3.WithLease(leaseID))
		if err != nil {
			return 0, err
		}
		return response.Header.Revision, nil
	}()
	if err != nil && grantedLeaseID != 0 {
		_, _ = client.Lease.Revoke(context.Background(), grantedLeaseID)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"revision": longString(revision)}, nil
}

func putPreservingLease(client *clientv3.Client, ctx context.Context, key, value string) (int64, error) {
	for attempt := 0; attempt < preserveLeaseMaxAttempts; attempt++ {
		existing, err := client.Get(ctx, key)
		if err != nil {
			return 0, err
		}
		if len(existing.Kvs) == 0 || existing.Kvs[0].Lease <= 0 {
			return 0, errors.New("Cannot preserve lease: key does not exist or has no lease")
		}
		current := existing.Kvs[0]
		txn := client.Txn(ctx).
			If(clientv3.Compare(clientv3.ModRevision(key), "=", current.ModRevision)).
			Then(clientv3.OpPut(key, value, clientv3.WithLease(clientv3.LeaseID(current.Lease))))
		response, err := txn.Commit()
		if err != nil {
			return 0, err
		}
		if response.Succeeded {
			return response.Header.Revision, nil
		}
	}
	return 0, errors.New("Cannot preserve lease: key changed concurrently; retry the save")
}

func (s *etcdSession) delete(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	key, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	expectedModRevision := longOrNull(params, "expectedModRevision")

	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if expectedModRevision != nil {
		txn := client.Txn(ctx).
			If(clientv3.Compare(clientv3.ModRevision(key), "=", *expectedModRevision)).
			Then(clientv3.OpDelete(key))
		response, err := txn.Commit()
		if err != nil {
			return nil, err
		}
		if !response.Succeeded {
			return nil, errors.New("ETCD_CAS_CONFLICT: key changed after it was loaded")
		}
		return map[string]any{"deleted": int64(1), "revision": longString(response.Header.Revision)}, nil
	}
	response, err := client.Delete(ctx, key)
	if err != nil {
		return nil, err
	}
	return map[string]any{"deleted": response.Deleted, "revision": longString(response.Header.Revision)}, nil
}

func (s *etcdSession) rename(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	sourceKey, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	newKey := stringOrNull(params, "newKey")
	if newKey == nil || *newKey == "" {
		return nil, errors.New("ETCD_NEWKEY_REQUIRED")
	}
	targetKey := *newKey
	if sourceKey == targetKey {
		return map[string]any{"renamed": true, "revision": nil}, nil
	}

	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	sourceResponse, err := client.Get(ctx, sourceKey)
	if err != nil {
		return nil, err
	}
	if len(sourceResponse.Kvs) == 0 {
		return nil, errors.New("ETCD_NOT_FOUND: source key does not exist")
	}
	source := sourceResponse.Kvs[0]
	expected := longOrNull(params, "expectedModRevision")
	expectedRevision := source.ModRevision
	if expected != nil {
		expectedRevision = *expected
	}
	putOption := []clientv3.OpOption{}
	if source.Lease != 0 {
		putOption = append(putOption, clientv3.WithLease(clientv3.LeaseID(source.Lease)))
	}
	txn := client.Txn(ctx).
		If(
			clientv3.Compare(clientv3.ModRevision(sourceKey), "=", expectedRevision),
			clientv3.Compare(clientv3.CreateRevision(targetKey), "=", 0),
		).
		Then(
			clientv3.OpPut(targetKey, string(source.Value), putOption...),
			clientv3.OpDelete(sourceKey),
		)
	response, err := txn.Commit()
	if err != nil {
		return nil, err
	}
	if !response.Succeeded {
		return nil, errors.New("ETCD_CAS_CONFLICT: source changed or target already exists")
	}
	return map[string]any{"renamed": true, "revision": longString(response.Header.Revision)}, nil
}

func (s *etcdSession) metadataWithTtl(item *mvccpb.KeyValue) (map[string]any, error) {
	metadata := metadataMap(item)
	if item.Lease > 0 {
		client, err := s.activeClient()
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
		defer cancel()
		lease, err := client.Lease.TimeToLive(ctx, clientv3.LeaseID(item.Lease))
		if err != nil {
			return nil, err
		}
		metadata["ttl"] = lease.TTL
	}
	return metadata, nil
}

func metadataMap(item *mvccpb.KeyValue) map[string]any {
	return map[string]any{
		"createRevision": longString(item.CreateRevision),
		"modRevision":    longString(item.ModRevision),
		"version":        longString(item.Version),
		"lease":          longString(item.Lease),
		"valueSize":      len(item.Value),
	}
}

func prefixEnd(prefix string) string {
	if prefix == "" {
		return "\x00"
	}
	end := []byte(prefix)
	for i := len(end) - 1; i >= 0; i-- {
		if end[i] < 0xff {
			end[i]++
			return string(end[:i+1])
		}
	}
	return "\x00"
}

func prefixStart(prefix string) string {
	if prefix == "" {
		return "\x00"
	}
	return prefix
}

func nextContinuation(key []byte) string {
	next := make([]byte, len(key)+1)
	copy(next, key)
	return base64.StdEncoding.EncodeToString(next)
}

func keyBytesParam(params map[string]json.RawMessage) (string, error) {
	if encoded := rawObject(params, "keyBytes"); encoded != nil {
		value, err := parseValueObject(encoded)
		if err != nil {
			return "", err
		}
		return value, nil
	}
	if raw, ok := params["key"]; ok && raw != nil && string(raw) != "null" {
		var key string
		if err := json.Unmarshal(raw, &key); err != nil {
			return "", err
		}
		return key, nil
	}
	return "", errors.New("Key is required")
}

func rawObject(params map[string]json.RawMessage, key string) map[string]json.RawMessage {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil
	}
	return object
}

func bytesObject(bytes []byte) map[string]any {
	return map[string]any{
		"encoding": "base64",
		"data":     base64.StdEncoding.EncodeToString(bytes),
	}
}

func valueObject(value []byte) map[string]any {
	if utf8.Valid(value) {
		return map[string]any{"encoding": "utf8", "data": string(value)}
	}
	return bytesObject(value)
}

func displayBytes(bytes []byte) string {
	if utf8.Valid(bytes) {
		return string(bytes)
	}
	return base64.StdEncoding.EncodeToString(bytes)
}

func parseValueObject(value map[string]json.RawMessage) (string, error) {
	if value == nil {
		value = map[string]json.RawMessage{}
	}
	encoding := stringOrDefault(value, "encoding", "utf8")
	data := stringOrDefault(value, "data", "")
	if encoding == "base64" {
		decoded, err := base64.StdEncoding.DecodeString(data)
		if err != nil {
			return "", err
		}
		return string(decoded), nil
	}
	if encoding != "utf8" {
		return "", fmt.Errorf("Unsupported value encoding: %s", encoding)
	}
	return data, nil
}

func longString(value int64) string {
	return strconv.FormatInt(value, 10)
}

func unsignedLongString(value int64) string {
	return strconv.FormatUint(uint64(value), 10)
}

func stringOrNull(params map[string]json.RawMessage, key string) *string {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		var text *string
		return text
	}
	return &value
}

func stringOrDefault(params map[string]json.RawMessage, key string, fallback string) string {
	value := stringOrNull(params, key)
	if value == nil {
		return fallback
	}
	return *value
}

func intOrDefault(params map[string]json.RawMessage, key string, fallback int) int {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return fallback
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	return value
}

func boolOrDefault(params map[string]json.RawMessage, key string, fallback bool) bool {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return fallback
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	return value
}

func longOrNull(params map[string]json.RawMessage, key string) *int64 {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return &value
}

func requiredPositiveLong(params map[string]json.RawMessage, field string) (int64, error) {
	value := longOrNull(params, field)
	if value == nil || *value <= 0 {
		return 0, fmt.Errorf("ETCD_INVALID_%s: a positive integer is required", strings.ToUpper(field))
	}
	return *value, nil
}

func requiredString(params map[string]json.RawMessage, field string) (string, error) {
	value := stringOrNull(params, field)
	if value == nil || *value == "" {
		return "", fmt.Errorf("ETCD_%s_REQUIRED", strings.ToUpper(field))
	}
	return *value, nil
}
