package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	admin "github.com/amigoer/rocketmq-admin-go"
	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
)

type aclWire struct {
	Subject  string          `json:"subject"`
	Policies []aclPolicyWire `json:"policies"`
}

type aclPolicyWire struct {
	PolicyType string         `json:"policyType,omitempty"`
	Entries    []aclEntryWire `json:"entries"`
}

type aclEntryWire struct {
	Resource  string   `json:"resource"`
	Actions   []string `json:"actions"`
	SourceIPs []string `json:"sourceIps"`
	Decision  string   `json:"decision"`
}

func (a *rocketMQAgent) listACLs(params map[string]any) (any, error) {
	_, config, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	address, err := a.brokerAddressForName(stringValue(params, "brokerName"))
	if err != nil {
		return nil, err
	}
	response, err := invokeRemotingWithClient(ctx, address, remoting.NewRequest(remoting.ListAcl, map[string]string{
		"subjectFilter":  strings.TrimPrefix(stringValue(params, "principal", "subject"), "User:"),
		"resourceFilter": stringValue(params, "resourceName"),
	}))
	if err != nil {
		return nil, err
	}
	var wrapper struct {
		Acls []aclWire `json:"acls"`
	}
	body := repairRocketMQJSON(response.Body)
	if len(body) > 0 && body[0] == '[' {
		if err := json.Unmarshal(body, &wrapper.Acls); err != nil {
			return nil, fmt.Errorf("decode ACL list: %w", err)
		}
	} else if err := json.Unmarshal(body, &wrapper); err != nil {
		return nil, fmt.Errorf("decode ACL list: %w", err)
	}
	principalFilter := strings.TrimPrefix(stringValue(params, "principal", "subject"), "User:")
	resourceFilter := stringValue(params, "resourceName")
	rows := make([]map[string]any, 0)
	for _, acl := range wrapper.Acls {
		if principalFilter != "" && acl.Subject != principalFilter && acl.Subject != "User:"+principalFilter {
			continue
		}
		for _, policy := range acl.Policies {
			for _, entry := range policy.Entries {
				if resourceFilter != "" && entry.Resource != resourceFilter {
					continue
				}
				actions := entry.Actions
				if len(actions) == 0 {
					actions = []string{"ALL"}
				}
				for _, action := range actions {
					host := "*"
					if len(entry.SourceIPs) > 0 {
						host = strings.Join(entry.SourceIPs, ",")
					}
					rows = append(rows, map[string]any{
						"resourceType": "TOPIC", "resourceName": entry.Resource,
						"patternType": "LITERAL", "principal": acl.Subject,
						"host": host, "operation": normalizeACLOperation(action),
						"permissionType": entry.Decision,
					})
				}
			}
		}
	}
	return map[string]any{"acls": rows}, nil
}

func (a *rocketMQAgent) createACLs(params map[string]any) (any, error) {
	client, config, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	address, err := a.brokerAddressForName(stringValue(params, "brokerName"))
	if err != nil {
		return nil, err
	}
	entries, _ := params["acls"].([]any)
	for _, raw := range entries {
		entry, _ := raw.(map[string]any)
		if _, hasAccessKey := entry["accessKey"]; hasAccessKey || entry["secretKey"] != nil {
			if err := client.UpdatePlainAccessConfig(ctx, address, plainAccessConfig(entry)); err != nil {
				return nil, err
			}
			continue
		}
		subject := strings.TrimPrefix(stringValue(entry, "principal", "subject"), "User:")
		if subject == "" {
			return nil, fmt.Errorf("ACL principal is required")
		}
		resource := stringValue(entry, "resourceName")
		if resource == "" {
			resource = "*"
		}
		host := stringValue(entry, "host")
		if host == "" {
			host = "*"
		}
		decision := stringValue(entry, "permissionType")
		if decision == "" {
			decision = "ALLOW"
		}
		acl := aclWire{Subject: subject, Policies: []aclPolicyWire{{Entries: []aclEntryWire{{
			Resource: resource, Actions: []string{mapACLOperation(stringValue(entry, "operation"))},
			SourceIPs: []string{host}, Decision: decision,
		}}}}}
		body, marshalErr := json.Marshal(acl)
		if marshalErr != nil {
			return nil, marshalErr
		}
		command := remoting.NewRequest(remoting.CreateAcl, map[string]string{"subject": subject})
		command.Body = body
		if _, err := invokeRemotingWithClient(ctx, address, command); err != nil {
			return nil, err
		}
	}
	return okResult(), nil
}

func (a *rocketMQAgent) deleteACLs(params map[string]any) (any, error) {
	client, config, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), config.RequestTimeout)
	defer cancel()
	address, err := a.brokerAddressForName(stringValue(params, "brokerName"))
	if err != nil {
		return nil, err
	}
	filters, _ := params["filters"].([]any)
	if len(filters) == 0 {
		listed, listErr := a.listACLs(params)
		if listErr != nil {
			return nil, listErr
		}
		for _, row := range listed.(map[string]any)["acls"].([]map[string]any) {
			filters = append(filters, row)
		}
	}
	deleted := 0
	seen := make(map[string]struct{})
	for _, raw := range filters {
		filter, _ := raw.(map[string]any)
		if accessKey := stringValue(filter, "accessKey"); accessKey != "" {
			if err := client.DeletePlainAccessConfig(ctx, address, accessKey); err != nil {
				return nil, err
			}
			deleted++
			continue
		}
		subject := strings.TrimPrefix(stringValue(filter, "principal", "subject"), "User:")
		resource := stringValue(filter, "resourceName")
		key := subject + "|" + resource
		if subject == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		fields := map[string]string{"subject": subject}
		if resource != "" {
			fields["resource"] = resource
		}
		if _, err := invokeRemotingWithClient(ctx, address, remoting.NewRequest(remoting.DeleteAcl, fields)); err != nil {
			return nil, err
		}
		deleted++
	}
	return map[string]any{"ok": true, "deleted": deleted}, nil
}

func plainAccessConfig(entry map[string]any) admin.PlainAccessConfig {
	return admin.PlainAccessConfig{
		AccessKey: stringValue(entry, "accessKey"), SecretKey: stringValue(entry, "secretKey"),
		WhiteRemoteAddress: stringValue(entry, "whiteRemoteAddress"),
		Admin:              boolValue(entry, false, "admin"),
		DefaultTopicPerm:   stringValue(entry, "defaultTopicPerm"),
		DefaultGroupPerm:   stringValue(entry, "defaultGroupPerm"),
		TopicPerms:         stringSlice(entry["topicPerms"]), GroupPerms: stringSlice(entry["groupPerms"]),
	}
}

func stringSlice(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, fmt.Sprint(item))
	}
	return result
}

func mapACLOperation(operation string) string {
	switch strings.ToUpper(operation) {
	case "WRITE", "PRODUCE", "PUB":
		return "PUB"
	case "READ", "CONSUME", "SUB":
		return "SUB"
	default:
		return "ALL"
	}
}

func normalizeACLOperation(operation string) string {
	switch strings.ToUpper(operation) {
	case "PUB":
		return "WRITE"
	case "SUB":
		return "READ"
	default:
		return strings.ToUpper(operation)
	}
}
