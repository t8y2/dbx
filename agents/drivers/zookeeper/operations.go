package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/go-zookeeper/zk"
)

const defaultListLimit = 100

type valueObject struct {
	Encoding string `json:"encoding"`
	Data     string `json:"data"`
}

type getRequest struct {
	Key string `json:"key"`
}

type putRequest struct {
	Key        string      `json:"key"`
	Value      valueObject `json:"value"`
	WriteMode  string      `json:"writeMode"`
	CreateMode string      `json:"createMode"`
}

type deleteRequest struct {
	Key       string `json:"key"`
	Recursive bool   `json:"recursive"`
}

type listRequest struct {
	Prefix       string `json:"prefix"`
	Recursive    *bool  `json:"recursive"`
	Limit        int    `json:"limit"`
	Continuation string `json:"continuation"`
}

type listCursor struct {
	Root      string `json:"root"`
	Recursive bool   `json:"recursive"`
	Offset    int    `json:"offset"`
}

type listResponse struct {
	Keys         []map[string]any `json:"keys"`
	Continuation *string          `json:"continuation"`
}

func (service *server) get(params json.RawMessage) (map[string]any, error) {
	client, err := service.requireClient()
	if err != nil {
		return nil, err
	}
	var request getRequest
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, err
	}
	path := normalizePath(request.Key)
	exists, _, err := client.Exists(path)
	if err != nil {
		return nil, err
	}
	if !exists {
		return map[string]any{"found": false, "key": path, "value": nil, "metadata": nil}, nil
	}
	data, stat, err := client.Get(path)
	if err == zk.ErrNoNode {
		return map[string]any{"found": false, "key": path, "value": nil, "metadata": nil}, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"found":    true,
		"key":      path,
		"value":    encodeValue(data),
		"metadata": statMetadata(stat),
	}, nil
}

func (service *server) put(params json.RawMessage) (map[string]any, error) {
	client, err := service.requireClient()
	if err != nil {
		return nil, err
	}
	var request putRequest
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, err
	}
	path := normalizePath(request.Key)
	if path == "/" {
		return nil, errors.New("Root znode cannot be modified")
	}
	data, err := decodeValue(request.Value)
	if err != nil {
		return nil, err
	}
	writeMode := request.WriteMode
	if writeMode == "" {
		writeMode = "upsert"
	}
	switch writeMode {
	case "create":
		return createNode(client, path, data, request.CreateMode)
	case "update":
		stat, err := client.Set(path, data)
		if err != nil {
			return nil, err
		}
		return putResult(stat), nil
	case "upsert":
		exists, _, err := client.Exists(path)
		if err != nil {
			return nil, err
		}
		if exists {
			stat, err := client.Set(path, data)
			if err != nil {
				return nil, err
			}
			return putResult(stat), nil
		}
		if err := createParents(client, parentPath(path)); err != nil {
			return nil, err
		}
		createdPath, err := client.Create(path, data, 0)
		if err != nil {
			return nil, err
		}
		_, stat, err := client.Get(createdPath)
		if err != nil {
			return nil, err
		}
		return putResult(stat), nil
	default:
		return nil, fmt.Errorf("Unsupported writeMode: %s", writeMode)
	}
}

func createNode(client znodeClient, path string, data []byte, mode string) (map[string]any, error) {
	flags, err := createFlags(mode)
	if err != nil {
		return nil, err
	}
	if err := createParents(client, parentPath(path)); err != nil {
		return nil, err
	}
	createdPath, err := client.Create(path, data, flags)
	if err != nil {
		return nil, err
	}
	_, stat, err := client.Get(createdPath)
	if err != nil {
		return nil, err
	}
	result := putResult(stat)
	result["key"] = createdPath
	result["createdKey"] = createdPath
	return result, nil
}

func createFlags(mode string) (int32, error) {
	switch mode {
	case "", "persistent":
		return 0, nil
	case "ephemeral":
		return zk.FlagEphemeral, nil
	case "persistent_sequential":
		return zk.FlagSequence, nil
	case "ephemeral_sequential":
		return zk.FlagEphemeral | zk.FlagSequence, nil
	default:
		return 0, fmt.Errorf("Unsupported createMode: %s", mode)
	}
}

func createParents(client znodeClient, parent string) error {
	if parent == "/" {
		return nil
	}
	current := ""
	for _, segment := range strings.Split(strings.Trim(parent, "/"), "/") {
		current = childPath(current, segment)
		exists, _, err := client.Exists(current)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		if _, err := client.Create(current, nil, 0); err != nil && err != zk.ErrNodeExists {
			return err
		}
	}
	return nil
}

func (service *server) delete(params json.RawMessage) (map[string]any, error) {
	client, err := service.requireClient()
	if err != nil {
		return nil, err
	}
	var request deleteRequest
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, err
	}
	path := normalizePath(request.Key)
	if path == "/" {
		return nil, errors.New("Root znode cannot be deleted")
	}
	exists, _, err := client.Exists(path)
	if err != nil {
		return nil, err
	}
	if !exists {
		return map[string]any{"deleted": 0}, nil
	}
	if !request.Recursive {
		if err := client.Delete(path); err != nil {
			if err == zk.ErrNoNode {
				return map[string]any{"deleted": 0}, nil
			}
			return nil, err
		}
		return map[string]any{"deleted": 1}, nil
	}
	deleted, err := deleteSubtree(client, path)
	if err != nil {
		return nil, err
	}
	return map[string]any{"deleted": deleted}, nil
}

func deleteSubtree(client znodeClient, path string) (int, error) {
	children, _, err := client.Children(path)
	if err == zk.ErrNoNode {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, child := range children {
		count, err := deleteSubtree(client, childPath(path, child))
		if err != nil {
			return deleted, err
		}
		deleted += count
	}
	if err := client.Delete(path); err != nil {
		if err == zk.ErrNoNode {
			return deleted, nil
		}
		return deleted, err
	}
	return deleted + 1, nil
}

func (service *server) listPrefix(params json.RawMessage) (listResponse, error) {
	client, err := service.requireClient()
	if err != nil {
		return listResponse{}, err
	}
	var request listRequest
	if err := json.Unmarshal(params, &request); err != nil {
		return listResponse{}, err
	}
	root := normalizePath(request.Prefix)
	recursive := true
	if request.Recursive != nil {
		recursive = *request.Recursive
	}
	limit := request.Limit
	if limit < 1 {
		limit = defaultListLimit
	}
	cursor := listCursor{Root: root, Recursive: recursive}
	if strings.TrimSpace(request.Continuation) != "" {
		decoded, err := decodeCursor(request.Continuation)
		if err != nil {
			return listResponse{}, err
		}
		if decoded.Root != root || decoded.Recursive != recursive {
			return listResponse{}, errors.New("Continuation does not match request")
		}
		cursor = decoded
	}
	exists, _, err := client.Exists(root)
	if err != nil {
		return listResponse{}, err
	}
	if !exists {
		return listResponse{Keys: []map[string]any{}, Continuation: nil}, nil
	}
	var paths []string
	if recursive {
		paths, err = listRecursive(client, root)
	} else {
		paths, err = listDirectChildren(client, root)
	}
	if err != nil {
		return listResponse{}, err
	}
	sort.Strings(paths)
	offset := maxInt(0, cursor.Offset)
	if offset > len(paths) {
		offset = len(paths)
	}
	end := minInt(len(paths), offset+limit)
	rows, err := service.rowsWithMetadata(client, paths[offset:end])
	if err != nil {
		return listResponse{}, err
	}
	var continuation *string
	if end < len(paths) {
		encoded, err := encodeCursor(listCursor{Root: root, Recursive: recursive, Offset: end})
		if err != nil {
			return listResponse{}, err
		}
		continuation = &encoded
	}
	return listResponse{Keys: rows, Continuation: continuation}, nil
}

func listDirectChildren(client znodeClient, root string) ([]string, error) {
	children, _, err := client.Children(root)
	if err == zk.ErrNoNode {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	sort.Strings(children)
	paths := make([]string, 0, len(children))
	for _, child := range children {
		paths = append(paths, childPath(root, child))
	}
	return paths, nil
}

func listRecursive(client znodeClient, root string) ([]string, error) {
	result := make([]string, 0)
	if err := collectRecursive(client, root, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func collectRecursive(client znodeClient, root string, result *[]string) error {
	children, _, err := client.Children(root)
	if err == zk.ErrNoNode {
		return nil
	}
	if err != nil {
		return err
	}
	sort.Strings(children)
	for _, child := range children {
		path := childPath(root, child)
		*result = append(*result, path)
		if err := collectRecursive(client, path, result); err != nil {
			return err
		}
	}
	return nil
}

func (service *server) rowsWithMetadata(client znodeClient, paths []string) ([]map[string]any, error) {
	if len(paths) == 0 {
		return []map[string]any{}, nil
	}
	rows := make([]map[string]any, len(paths))
	jobs := make(chan int)
	workers := minInt(service.statLookupConcurrency, len(paths))
	var waitGroup sync.WaitGroup
	var firstError error
	var errorMutex sync.Mutex
	for worker := 0; worker < workers; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for index := range jobs {
				exists, stat, err := client.Exists(paths[index])
				if err == zk.ErrNoNode || !exists {
					continue
				}
				if err != nil {
					errorMutex.Lock()
					if firstError == nil {
						firstError = err
					}
					errorMutex.Unlock()
					continue
				}
				row := statMetadata(stat)
				row["key"] = paths[index]
				rows[index] = row
			}
		}()
	}
	for index := range paths {
		jobs <- index
	}
	close(jobs)
	waitGroup.Wait()
	if firstError != nil {
		return nil, firstError
	}
	filtered := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if row != nil {
			filtered = append(filtered, row)
		}
	}
	return filtered, nil
}

func statMetadata(stat *zk.Stat) map[string]any {
	return map[string]any{
		"czxid":          stat.Czxid,
		"mzxid":          stat.Mzxid,
		"pzxid":          stat.Pzxid,
		"ctime":          stat.Ctime,
		"mtime":          stat.Mtime,
		"version":        stat.Version,
		"cversion":       stat.Cversion,
		"aversion":       stat.Aversion,
		"ephemeralOwner": stat.EphemeralOwner,
		"dataLength":     stat.DataLength,
		"numChildren":    stat.NumChildren,
		"createRevision": stat.Czxid,
		"modRevision":    stat.Mzxid,
		"valueSize":      stat.DataLength,
	}
}

func putResult(stat *zk.Stat) map[string]any {
	return map[string]any{"version": stat.Version, "mtime": stat.Mtime}
}

func encodeValue(data []byte) valueObject {
	if utf8.Valid(data) {
		return valueObject{Encoding: "utf8", Data: string(data)}
	}
	return valueObject{Encoding: "base64", Data: base64.StdEncoding.EncodeToString(data)}
}

func decodeValue(value valueObject) ([]byte, error) {
	switch value.Encoding {
	case "", "utf8":
		return []byte(value.Data), nil
	case "base64":
		return base64.StdEncoding.DecodeString(value.Data)
	default:
		return nil, fmt.Errorf("Unsupported value encoding: %s", value.Encoding)
	}
}

func encodeCursor(cursor listCursor) (string, error) {
	payload, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(payload), nil
}

func decodeCursor(value string) (listCursor, error) {
	payload, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return listCursor{}, err
	}
	var cursor listCursor
	if err := json.Unmarshal(payload, &cursor); err != nil {
		return listCursor{}, err
	}
	return cursor, nil
}

func normalizePath(value string) string {
	if value == "" || value == "/" {
		return "/"
	}
	normalized := value
	if !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	for len(normalized) > 1 && strings.HasSuffix(normalized, "/") {
		normalized = strings.TrimSuffix(normalized, "/")
	}
	return normalized
}

func childPath(parent, child string) string {
	if parent == "" || parent == "/" {
		return "/" + strings.Trim(child, "/")
	}
	return strings.TrimRight(parent, "/") + "/" + strings.Trim(child, "/")
}

func parentPath(value string) string {
	path := normalizePath(value)
	separator := strings.LastIndex(path, "/")
	if separator <= 0 {
		return "/"
	}
	return path[:separator]
}
