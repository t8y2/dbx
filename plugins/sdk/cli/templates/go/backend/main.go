package main

import (
	"encoding/json"
	"log"
	"sync"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

type plugin struct {
	mutex       sync.Mutex
	connections map[string]struct{}
}

func (plugin *plugin) Handle(
	_ dbxpluginsdk.RequestContext,
	method string,
	params json.RawMessage,
	_ *dbxpluginsdk.Emitter,
) (any, *dbxpluginsdk.PluginError) {
	var values map[string]any
	if err := json.Unmarshal(params, &values); err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "Invalid request parameters")
	}
	switch method {
	case "connection/test":
		connection, _ := values["connection"].(map[string]any)
		return map[string]any{"success": true, "message": "{{PLUGIN_NAME_GO}} is ready", "connection": connection}, nil
	case "connection/connect":
		connectionID, pluginError := requestConnectionID(values)
		if pluginError != nil {
			return nil, pluginError
		}
		plugin.mutex.Lock()
		plugin.connections[connectionID] = struct{}{}
		plugin.mutex.Unlock()
		return map[string]any{"success": true}, nil
	case "connection/disconnect":
		connectionID, pluginError := requestConnectionID(values)
		if pluginError != nil {
			return nil, pluginError
		}
		plugin.mutex.Lock()
		delete(plugin.connections, connectionID)
		plugin.mutex.Unlock()
		return map[string]any{"success": true}, nil
	case "{{METHOD_PREFIX}}/ping":
		return map[string]any{"ok": true, "plugin": "{{PLUGIN_ID}}", "language": "go", "connectionId": values["connectionId"]}, nil
	default:
		return nil, dbxpluginsdk.MethodNotFound(method)
	}
}

func requestConnectionID(values map[string]any) (string, *dbxpluginsdk.PluginError) {
	connection, _ := values["connection"].(map[string]any)
	connectionID, _ := connection["id"].(string)
	if connectionID == "" {
		return "", dbxpluginsdk.NewError(-32602, "Missing connection id")
	}
	return connectionID, nil
}

func main() {
	metadata := dbxpluginsdk.Metadata{
		ID:           "{{PLUGIN_ID}}",
		Version:      "{{VERSION}}",
		Capabilities: []string{"connections"},
	}
	server := dbxpluginsdk.NewServer(metadata, &plugin{connections: map[string]struct{}{}})
	if err := server.Serve(); err != nil {
		log.Fatal(err)
	}
}
