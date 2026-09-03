package main

import (
	"encoding/json"
	"fmt"
	"strings"

	clientv3 "go.etcd.io/etcd/client/v3"
)

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
	response, err := client.Auth.UserGet(ctx, user)
	if err != nil {
		return nil, err
	}
	return map[string]any{"user": user, "roles": response.Roles}, nil
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
