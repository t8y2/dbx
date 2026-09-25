package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
)

// etcdReadRange is a half-open Key range that the current user can read.
// It is derived from the user's roles rather than asking etcd to enumerate
// the global Key space, which a restricted account is not allowed to do.
type etcdReadRange struct {
	start string
	end   string
}

// etcdReadAccess is a short-lived snapshot of the current user's readable
// ranges. etcd remains the authorization boundary for every Key request; the
// cache only avoids repeating AuthStatus, UserGet, and RoleGet while browsing.
type etcdReadAccess struct {
	allKeys   bool
	ranges    []etcdReadRange
	expiresAt time.Time
}

// etcd uses a single NUL byte as an unbounded range end, meaning every Key
// greater than or equal to the range start. It is a protocol sentinel, not a
// byte-string upper bound, so ordinary lexical comparison is incorrect.
const unboundedRangeEnd = "\x00"

// readableKeyRanges returns whether the user can read every Key and otherwise
// the smallest set of non-overlapping read ranges granted by its roles.
func (s *etcdSession) readableKeyRanges() (bool, []etcdReadRange, error) {
	if allKeys, ranges, ok := s.cachedReadAccess(time.Now()); ok {
		return allKeys, ranges, nil
	}
	s.clientMu.Lock()
	username := s.username
	authEnabled := s.authEnabled
	s.clientMu.Unlock()
	client, clientErr := s.activeClient()
	if clientErr == nil {
		authEnabled = s.refreshAuthEnabled(client)
	}
	if !authEnabled || username == "root" {
		s.cacheReadAccess(true, nil)
		return true, nil, nil
	}
	if username == "" {
		s.cacheReadAccess(false, nil)
		return false, nil, nil
	}
	if clientErr != nil {
		return false, nil, clientErr
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	user, err := client.Auth.UserGet(ctx, username)
	if err != nil {
		if isAuthenticationNotEnabled(err) {
			s.disableAuth()
			s.cacheReadAccess(true, nil)
			return true, nil, nil
		}
		return false, nil, err
	}

	ranges := make([]etcdReadRange, 0)
	for _, roleName := range user.Roles {
		if roleName == "root" {
			s.cacheReadAccess(true, nil)
			return true, nil, nil
		}
		role, err := client.Auth.RoleGet(ctx, roleName)
		if err != nil {
			if isAuthenticationNotEnabled(err) {
				s.disableAuth()
				s.cacheReadAccess(true, nil)
				return true, nil, nil
			}
			return false, nil, err
		}
		for _, permission := range role.Perm {
			if strings.EqualFold(permission.PermType.String(), "WRITE") {
				continue
			}
			start := string(permission.Key)
			end := string(permission.RangeEnd)
			if isAllKeyPermission(start, end) {
				s.cacheReadAccess(true, nil)
				return true, nil, nil
			}
			if end == "" {
				// An exact Key permission is represented as a one-Key range.
				end = start + "\x00"
			}
			ranges = append(ranges, etcdReadRange{start: start, end: end})
		}
	}
	ranges = normalizeReadRanges(ranges)
	s.cacheReadAccess(false, ranges)
	return false, ranges, nil
}

func (s *etcdSession) cachedReadAccess(now time.Time) (bool, []etcdReadRange, bool) {
	s.clientMu.Lock()
	defer s.clientMu.Unlock()
	if s.readAccess == nil || !now.Before(s.readAccess.expiresAt) {
		return false, nil, false
	}
	return s.readAccess.allKeys, append([]etcdReadRange(nil), s.readAccess.ranges...), true
}

func (s *etcdSession) cacheReadAccess(allKeys bool, ranges []etcdReadRange) {
	s.clientMu.Lock()
	s.readAccess = &etcdReadAccess{
		allKeys:   allKeys,
		ranges:    append([]etcdReadRange(nil), ranges...),
		expiresAt: time.Now().Add(readAccessCacheTTL),
	}
	s.clientMu.Unlock()
}

func isAllKeyPermission(start, end string) bool {
	return (start == "" && (end == "" || end == unboundedRangeEnd)) || (start == unboundedRangeEnd && end == unboundedRangeEnd)
}

func isUnboundedRangeEnd(end string) bool {
	return end == unboundedRangeEnd
}

func rangeStartAtOrAfterEnd(start, end string) bool {
	return !isUnboundedRangeEnd(end) && bytes.Compare([]byte(start), []byte(end)) >= 0
}

func rangeEndGreater(left, right string) bool {
	if left == right {
		return false
	}
	if isUnboundedRangeEnd(left) {
		return true
	}
	if isUnboundedRangeEnd(right) {
		return false
	}
	return bytes.Compare([]byte(left), []byte(right)) > 0
}

func normalizeReadRanges(ranges []etcdReadRange) []etcdReadRange {
	sort.Slice(ranges, func(i, j int) bool {
		return bytes.Compare([]byte(ranges[i].start), []byte(ranges[j].start)) < 0
	})
	result := make([]etcdReadRange, 0, len(ranges))
	for _, candidate := range ranges {
		if candidate.end == "" || rangeStartAtOrAfterEnd(candidate.start, candidate.end) {
			continue
		}
		if len(result) > 0 {
			last := &result[len(result)-1]
			if isUnboundedRangeEnd(last.end) || bytes.Compare([]byte(candidate.start), []byte(last.end)) <= 0 {
				if rangeEndGreater(candidate.end, last.end) {
					last.end = candidate.end
				}
				continue
			}
		}
		result = append(result, candidate)
	}
	return result
}

func (s *etcdSession) authUserList(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	response, err := client.Auth.UserList(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"users": response.Users}, nil
}

func (s *etcdSession) authUserGet(params map[string]json.RawMessage) (any, error) {
	user := strings.TrimSpace(stringOrDefault(params, "user", ""))
	currentUserRequest := user == ""
	s.clientMu.Lock()
	authUsername := s.username
	authEnabled := s.authEnabled
	s.clientMu.Unlock()
	client, clientErr := s.activeClient()
	if currentUserRequest && clientErr == nil {
		authEnabled = s.refreshAuthEnabled(client)
	}
	if user == "" {
		user = authUsername
	}
	if currentUserRequest && !authEnabled {
		return map[string]any{"user": user, "roles": []string{}, "authEnabled": false}, nil
	}
	if user == "" {
		return nil, errors.New("user is required")
	}
	if clientErr != nil {
		return nil, clientErr
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	response, err := client.Auth.UserGet(ctx, user)
	if err != nil {
		if currentUserRequest && isAuthenticationNotEnabled(err) {
			s.disableAuth()
			return map[string]any{"user": user, "roles": []string{}, "authEnabled": false}, nil
		}
		return nil, err
	}
	return map[string]any{"user": user, "roles": response.Roles, "authEnabled": true}, nil
}

func (s *etcdSession) authUserAdd(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	user, err := requiredString(params, "user")
	if err != nil {
		return nil, err
	}
	password, err := requiredString(params, "password")
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if _, err := client.Auth.UserAdd(ctx, user, password); err != nil {
		return nil, err
	}
	return map[string]bool{"created": true}, nil
}

func (s *etcdSession) authUserDelete(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	user, err := requiredString(params, "user")
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if _, err := client.Auth.UserDelete(ctx, user); err != nil {
		return nil, err
	}
	return map[string]bool{"deleted": true}, nil
}

func (s *etcdSession) authUserChangePassword(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	user, err := requiredString(params, "user")
	if err != nil {
		return nil, err
	}
	password, err := requiredString(params, "password")
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if _, err := client.Auth.UserChangePassword(ctx, user, password); err != nil {
		return nil, err
	}
	return map[string]bool{"changed": true}, nil
}

func (s *etcdSession) authUserGrantRevokeRole(params map[string]json.RawMessage, grant bool) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	user, err := requiredString(params, "user")
	if err != nil {
		return nil, err
	}
	role, err := requiredString(params, "role")
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if grant {
		_, err = client.Auth.UserGrantRole(ctx, user, role)
	} else {
		_, err = client.Auth.UserRevokeRole(ctx, user, role)
	}
	if err != nil {
		return nil, err
	}
	return map[string]bool{"updated": true}, nil
}

func (s *etcdSession) authRoleList(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	response, err := client.Auth.RoleList(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"roles": response.Roles}, nil
}

func (s *etcdSession) authRoleGet(params map[string]json.RawMessage) (any, error) {
	role, err := requiredString(params, "role")
	if err != nil {
		return nil, err
	}
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	response, err := client.Auth.RoleGet(ctx, role)
	if err != nil {
		return nil, err
	}
	permissions := []map[string]any{}
	for _, permission := range response.Perm {
		key := []byte(permission.Key)
		rangeEnd := []byte(permission.RangeEnd)
		resource := "prefix"
		if len(key) == 1 && key[0] == 0 && len(rangeEnd) == 1 && rangeEnd[0] == 0 {
			resource = "all"
		} else if len(rangeEnd) == 0 {
			resource = "key"
		}
		permissions = append(permissions, map[string]any{
			"access":   strings.ToLower(permission.PermType.String()),
			"key":      bytesObject(key),
			"rangeEnd": bytesObject(rangeEnd),
			"resource": resource,
		})
	}
	return map[string]any{"role": role, "permissions": permissions}, nil
}

func (s *etcdSession) authRoleAdd(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	role, err := requiredString(params, "role")
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if _, err := client.Auth.RoleAdd(ctx, role); err != nil {
		return nil, err
	}
	return map[string]bool{"created": true}, nil
}

func (s *etcdSession) authRoleDelete(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	role, err := requiredString(params, "role")
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if _, err := client.Auth.RoleDelete(ctx, role); err != nil {
		return nil, err
	}
	return map[string]bool{"deleted": true}, nil
}

func (s *etcdSession) authRolePermission(params map[string]json.RawMessage, grant bool) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	role, err := requiredString(params, "role")
	if err != nil {
		return nil, err
	}
	resource := stringOrDefault(params, "resource", "key")
	all := resource == "all"
	prefix := resource == "prefix"
	var key string
	var rangeEnd string
	if all {
		key = "\x00"
		rangeEnd = "\x00"
	} else {
		key, err = keyBytesParam(params)
		if err != nil {
			return nil, err
		}
		if prefix {
			rangeEnd = prefixEnd(key)
		}
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	if grant {
		access, err := permissionType(stringOrDefault(params, "access", ""))
		if err != nil {
			return nil, err
		}
		if _, err := client.Auth.RoleGrantPermission(ctx, role, key, rangeEnd, access); err != nil {
			return nil, err
		}
	} else {
		if _, err := client.Auth.RoleRevokePermission(ctx, role, key, rangeEnd); err != nil {
			return nil, err
		}
	}
	return map[string]bool{"updated": true}, nil
}

func permissionType(access string) (clientv3.PermissionType, error) {
	permission, err := clientv3.StrToPermissionType(strings.ToUpper(access))
	if err != nil {
		return 0, fmt.Errorf("ETCD_INVALID_ACCESS: access must be READ, WRITE, or READWRITE, got %s", access)
	}
	return permission, nil
}
