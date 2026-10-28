package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

type plDebugRetainedResult struct {
	manifest map[string]interface{}
	text     []uint16
	binary   []byte
}

type plDebugResultCache struct {
	generation string
	used       int
	entries    []plDebugRetainedResult
}

func (plan *plDebugNativePlan) resultPayloadBudget() int {
	left := plDebugTypedResultBytes - 4096
	for _, argument := range plan.outputs() {
		if !argument.retainedOutput() {
			continue
		}
		path := "$return"
		if argument.Name != nil {
			path = *argument.Name
		}
		maximum := map[string]interface{}{"generation": strings.Repeat("x", 32), "resultId": strings.Repeat("x", 32), "encoding": "base64", "length": plDebugTypedResultBytes, "lengthUnit": "utf16", "complete": false, "truncated": false, "state": "available", "error": strings.Repeat("x", 64), "errorPath": path}
		encoded, _ := json.Marshal(maximum)
		left -= len(encoded)
	}
	if left < 0 {
		return 0
	}
	return left
}

func plDebugResultToken() (string, error) {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(token[:]), nil
}

func plDebugCopyResultMap(source map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{}, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func (cache *plDebugResultCache) retain(data []byte, binary bool, path string) (map[string]interface{}, error) {
	return cache.retainWithState(data, binary, path, true, "")
}

func (cache *plDebugResultCache) retainWithState(data []byte, binary bool, path string, sourceComplete bool, sourceError string) (map[string]interface{}, error) {
	const reserve = 4096
	remaining := plDebugTypedResultBytes - cache.used - reserve
	if remaining < 0 {
		return nil, errors.New("debugger result cache budget exhausted")
	}
	if cache.generation == "" {
		var err error
		cache.generation, err = plDebugResultToken()
		if err != nil {
			return nil, err
		}
	}
	id, err := plDebugResultToken()
	if err != nil {
		return nil, err
	}
	complete := sourceComplete
	encoding, unit := "utf16", "utf16"
	entry := plDebugRetainedResult{}
	bytes := len(data)
	length := 0
	if binary {
		encoding, unit = "base64", "bytes"
		capacity := remaining / 4 * 3
		if len(data) > capacity {
			data = data[:capacity]
			complete = false
		}
		entry.binary = append([]byte{}, data...)
		bytes = base64.StdEncoding.EncodedLen(len(data))
		length = len(data)
	} else {
		if !utf8.Valid(data) {
			return nil, errors.New("debugger result text is not UTF-8")
		}
		if len(data) > remaining {
			end := remaining
			for end > 0 && !utf8.RuneStart(data[end]) {
				end--
			}
			data = data[:end]
			complete = false
		}
		entry.text = utf16.Encode([]rune(string(data)))
		bytes = len(data)
		length = len(entry.text)
	}
	state := "available"
	if !complete {
		state = "partial"
	}
	entry.manifest = map[string]interface{}{"generation": cache.generation, "resultId": id, "encoding": encoding, "length": length, "lengthUnit": unit, "complete": complete, "truncated": !complete && sourceError == "", "state": state, "errorPath": path}
	if sourceError != "" {
		entry.manifest["error"] = sourceError
	}
	metadata, err := json.Marshal(entry.manifest)
	if err != nil {
		return nil, err
	}
	if len(metadata) > reserve || bytes+len(metadata) > plDebugTypedResultBytes-cache.used {
		return nil, errors.New("debugger result metadata exceeds cache budget")
	}
	cache.used += bytes + len(metadata)
	cache.entries = append(cache.entries, entry)
	return plDebugCopyResultMap(entry.manifest), nil
}

func (cache *plDebugResultCache) manifests() []map[string]interface{} {
	result := []map[string]interface{}{}
	for _, entry := range cache.entries {
		result = append(result, plDebugCopyResultMap(entry.manifest))
	}
	return result
}

func (cache *plDebugResultCache) page(generation, id string, offset, limit int) (map[string]interface{}, error) {
	if generation != cache.generation || generation == "" {
		return nil, errors.New("unknown debugger result identity")
	}
	for _, entry := range cache.entries {
		if entry.manifest["resultId"] != id {
			continue
		}
		length := entry.manifest["length"].(int)
		if offset < 0 || offset > length || limit < 1 || limit > 64*1024 {
			return nil, errors.New("invalid debugger result page bounds")
		}
		end := length
		if limit < length-offset {
			end = offset + limit
		}
		var data string
		if entry.manifest["encoding"] == "utf16" {
			if offset > 0 && offset < length && entry.text[offset] >= 0xDC00 && entry.text[offset] <= 0xDFFF {
				return nil, errors.New("result offset splits a surrogate pair")
			}
			if end < length && end > offset && entry.text[end-1] >= 0xD800 && entry.text[end-1] <= 0xDBFF {
				end--
			}
			if end == offset && offset < length {
				return nil, errors.New("page limit cannot contain the next surrogate pair")
			}
			data = string(utf16.Decode(entry.text[offset:end]))
		} else {
			data = base64.StdEncoding.EncodeToString(entry.binary[offset:end])
		}
		result := plDebugCopyResultMap(entry.manifest)
		result["offset"], result["nextOffset"], result["eof"], result["data"] = offset, end, end == length, data
		return result, nil
	}
	return nil, errors.New("unknown debugger result identity")
}

func (entry *plDebugNativeEntry) results() map[string]interface{} {
	entry.mu.Lock()
	defer entry.mu.Unlock()
	state := "pending"
	if entry.captureFinished {
		state = "available"
		if value, ok := entry.namedResult["outParamsState"].(string); ok {
			state = value
		}
	}
	return map[string]interface{}{"results": entry.resultCache.manifests(), "collectionState": state}
}

func (entry *plDebugNativeEntry) resultPage(params map[string]json.RawMessage) (interface{}, error) {
	var offset, limit int
	for _, key := range []string{"offset", "limit"} {
		if bytes.Equal(bytes.TrimSpace(params[key]), []byte("null")) {
			return nil, errors.New("result page bounds must be integers")
		}
	}
	if err := json.Unmarshal(params["offset"], &offset); err != nil {
		return nil, errors.New("result page offset must be an integer")
	}
	if err := json.Unmarshal(params["limit"], &limit); err != nil {
		return nil, errors.New("result page limit must be an integer")
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	return entry.resultCache.page(stringParam(params, "generation"), stringParam(params, "resultId"), offset, limit)
}
