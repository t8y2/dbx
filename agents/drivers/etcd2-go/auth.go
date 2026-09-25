package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// v2 auth wire format (etcd 2.3 etcdserver/etcdhttp/client_auth.go):
// a role PUT body without grant/revoke creates the role; a body carrying
// grant/revoke updates it incrementally and must not carry permissions.
// Permission entries are glob patterns: a trailing "*" grants a prefix,
// anything else matches a single key exactly.

type v2RWPermission struct {
	Read  []string `json:"read"`
	Write []string `json:"write"`
}

type v2Permissions struct {
	KV v2RWPermission `json:"kv"`
}

type v2Role struct {
	Role        string         `json:"role"`
	Permissions *v2Permissions `json:"permissions"`
	Grant       *v2Permissions `json:"grant,omitempty"`
	Revoke      *v2Permissions `json:"revoke,omitempty"`
}

// v2UserRecord is the GET shape of /v2/auth/users/<name>: roles come back
// as full role objects, not plain names.
type v2UserRecord struct {
	User  string `json:"user"`
	Roles []struct {
		Role string `json:"role"`
	} `json:"roles"`
}

// v2UserDocument is the PUT shape: grant/revoke carry role names.
type v2UserDocument struct {
	User     string   `json:"user"`
	Password string   `json:"password,omitempty"`
	Roles    []string `json:"roles,omitempty"`
	Grant    []string `json:"grant,omitempty"`
	Revoke   []string `json:"revoke,omitempty"`
}

func (s *etcd2Session) authUserList(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	body, _, err := client.do(ctx, http.MethodGet, "/v2/auth/users", "", nil)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Users []v2UserRecord `json:"users"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	users := make([]string, 0, len(parsed.Users))
	for _, user := range parsed.Users {
		users = append(users, user.User)
	}
	return map[string]any{"users": users}, nil
}

func (s *etcd2Session) authUserGet(params map[string]json.RawMessage) (any, error) {
	user, err := requiredString(params, "user")
	if err != nil {
		return nil, err
	}
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	body, _, err := client.do(ctx, http.MethodGet, "/v2/auth/users/"+escapePathSegment(user), "", nil)
	if err != nil {
		return nil, err
	}
	var parsed v2UserRecord
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	roles := make([]string, 0, len(parsed.Roles))
	for _, role := range parsed.Roles {
		roles = append(roles, role.Role)
	}
	return map[string]any{"user": parsed.User, "roles": roles}, nil
}

// authUserAdd relies on the create-or-update PUT: HTTP 201 means created,
// HTTP 200 means the user existed and only the password would change.
func (s *etcd2Session) authUserAdd(params map[string]json.RawMessage) (any, error) {
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
	payload := v2UserDocument{User: user, Password: password}
	_, response, err := client.doJSON(ctx, http.MethodPut, "/v2/auth/users/"+escapePathSegment(user), payload)
	if err != nil {
		return nil, err
	}
	if response != nil && response.StatusCode == http.StatusOK {
		return nil, fmt.Errorf("auth: User %s already exists.", user)
	}
	return map[string]bool{"created": true}, nil
}

func (s *etcd2Session) authUserDelete(params map[string]json.RawMessage) (any, error) {
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
	if _, _, err := client.do(ctx, http.MethodDelete, "/v2/auth/users/"+escapePathSegment(user), "", nil); err != nil {
		return nil, err
	}
	return map[string]bool{"deleted": true}, nil
}

// authUserChangePassword reuses the create-or-update PUT: the server
// replaces the stored password hash when the user exists.
func (s *etcd2Session) authUserChangePassword(params map[string]json.RawMessage) (any, error) {
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
	payload := v2UserDocument{User: user, Password: password}
	if _, _, err := client.doJSON(ctx, http.MethodPut, "/v2/auth/users/"+escapePathSegment(user), payload); err != nil {
		return nil, err
	}
	return map[string]bool{"changed": true}, nil
}

func (s *etcd2Session) authUserGrantRevokeRole(params map[string]json.RawMessage, grant bool) (any, error) {
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
	payload := v2UserDocument{User: user, Grant: []string{role}}
	if !grant {
		payload = v2UserDocument{User: user, Revoke: []string{role}}
	}
	if _, _, err := client.doJSON(ctx, http.MethodPut, "/v2/auth/users/"+escapePathSegment(user), payload); err != nil {
		return nil, err
	}
	return map[string]bool{"updated": true}, nil
}

func (s *etcd2Session) authRoleList(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	body, _, err := client.do(ctx, http.MethodGet, "/v2/auth/roles", "", nil)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Roles []v2Role `json:"roles"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	roles := make([]string, 0, len(parsed.Roles))
	for _, role := range parsed.Roles {
		roles = append(roles, role.Role)
	}
	return map[string]any{"roles": roles}, nil
}

func (s *etcd2Session) authRoleGet(params map[string]json.RawMessage) (any, error) {
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
	body, _, err := client.do(ctx, http.MethodGet, "/v2/auth/roles/"+escapePathSegment(role), "", nil)
	if err != nil {
		return nil, err
	}
	var parsed v2Role
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	permissions := []map[string]any{}
	if parsed.Permissions != nil {
		permissions = append(permissions, v2PermissionRows("read", parsed.Permissions.KV.Read)...)
		permissions = append(permissions, v2PermissionRows("write", parsed.Permissions.KV.Write)...)
	}
	return map[string]any{"role": parsed.Role, "permissions": permissions}, nil
}

// v2PermissionRows converts stored v2 patterns into the
// {access, key, rangeEnd, resource} rows the v3 agent emits: a trailing
// "*" displays as a prefix grant, anything else as an exact key.
func v2PermissionRows(access string, entries []string) []map[string]any {
	rows := []map[string]any{}
	for _, entry := range entries {
		if strings.HasSuffix(entry, "*") {
			base := strings.TrimSuffix(entry, "*")
			rows = append(rows, map[string]any{
				"access":   access,
				"key":      bytesObject([]byte(base)),
				"rangeEnd": bytesObject([]byte(prefixEnd(base))),
				"resource": "prefix",
			})
		} else {
			rows = append(rows, map[string]any{
				"access":   access,
				"key":      bytesObject([]byte(entry)),
				"rangeEnd": bytesObject(nil),
				"resource": "key",
			})
		}
	}
	return rows
}

func (s *etcd2Session) authRoleAdd(params map[string]json.RawMessage) (any, error) {
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
	payload := v2Role{Role: role}
	if _, _, err := client.doJSON(ctx, http.MethodPut, "/v2/auth/roles/"+escapePathSegment(role), payload); err != nil {
		return nil, err
	}
	return map[string]bool{"created": true}, nil
}

func (s *etcd2Session) authRoleDelete(params map[string]json.RawMessage) (any, error) {
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
	if _, _, err := client.do(ctx, http.MethodDelete, "/v2/auth/roles/"+escapePathSegment(role), "", nil); err != nil {
		return nil, err
	}
	return map[string]bool{"deleted": true}, nil
}

// v2PermissionPattern maps the protocol's resource model onto the v2 glob
// convention: exact keys stay bare, prefixes and "all" become "/path/*".
func v2PermissionPattern(resource, key string) string {
	switch resource {
	case "all":
		return "/*"
	case "prefix":
		return strings.TrimSuffix(key, "/") + "/*"
	default:
		return key
	}
}

// authRolePermission maps grants/revokes onto the server's incremental
// grant/revoke role update (one PUT per access direction).
func (s *etcd2Session) authRolePermission(params map[string]json.RawMessage, grant bool) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	role, err := requiredString(params, "role")
	if err != nil {
		return nil, err
	}
	resource := stringOrDefault(params, "resource", "key")
	key, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(key, "/") {
		key = "/" + key
	}
	pattern := v2PermissionPattern(resource, key)

	var accesses []string
	if grant {
		access := strings.ToUpper(stringOrDefault(params, "access", ""))
		switch access {
		case "READ":
			accesses = []string{"read"}
		case "WRITE":
			accesses = []string{"write"}
		case "READWRITE":
			accesses = []string{"read", "write"}
		default:
			return nil, fmt.Errorf("ETCD_INVALID_ACCESS: access must be READ, WRITE, or READWRITE, got %s", access)
		}
	} else {
		accesses = []string{"read", "write"}
	}

	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	for _, access := range accesses {
		document := v2Role{Role: role}
		direction := v2Permissions{KV: v2RWPermission{}}
		if access == "read" {
			direction.KV.Read = []string{pattern}
		} else {
			direction.KV.Write = []string{pattern}
		}
		if grant {
			document.Grant = &direction
		} else {
			document.Revoke = &direction
		}
		if _, _, err := client.doJSON(ctx, http.MethodPut, "/v2/auth/roles/"+escapePathSegment(role), document); err != nil {
			return nil, err
		}
	}
	return map[string]bool{"updated": true}, nil
}

func (c *authenticatedClient) doJSON(ctx context.Context, method, path string, payload any) ([]byte, *http.Response, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, err
	}
	return c.do(ctx, method, path, string(encoded), map[string]string{"Content-Type": "application/json"})
}

func escapePathSegment(segment string) string {
	return strings.ReplaceAll(segment, "/", "%2F")
}
