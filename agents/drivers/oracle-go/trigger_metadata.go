package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
)

type oracleTriggerParent struct {
	Owner      string  `json:"owner"`
	Name       string  `json:"name"`
	ObjectType string  `json:"objectType"`
	ObjectID   *string `json:"objectId,omitempty"`
}

type oracleTriggerDefinition struct {
	Origin   string `json:"origin"`
	Format   string `json:"format"`
	Complete bool   `json:"complete"`
}

type oracleTriggerCompilationError struct {
	Sequence int64   `json:"sequence"`
	Line     int64   `json:"line"`
	Position int64   `json:"position"`
	Text     string  `json:"text"`
	Severity *string `json:"severity,omitempty"`
}

type oracleTriggerReadState struct {
	State   string `json:"state"`
	Message string `json:"message,omitempty"`
}

type oracleTriggerMetadata struct {
	ContractVersion int                               `json:"contractVersion"`
	IdentityMode    string                            `json:"identityMode"`
	Engine          string                            `json:"engine"`
	EngineVersion   *string                           `json:"engineVersion"`
	Owner           string                            `json:"owner"`
	Name            string                            `json:"name"`
	Scope           string                            `json:"scope"`
	ScopeType       *string                           `json:"scopeType,omitempty"`
	ScopeOwner      *string                           `json:"scopeOwner"`
	Parent          *oracleTriggerParent              `json:"parent"`
	ObjectID        *string                           `json:"objectId"`
	LastDDLTime     *string                           `json:"lastDdlTime"`
	Definition      *oracleTriggerDefinition          `json:"definition"`
	Errors          []oracleTriggerCompilationError   `json:"errors"`
	Reads           map[string]oracleTriggerReadState `json:"reads"`
	description     string
	referencing     string
}

func exactMetadataReadParam(params map[string]json.RawMessage) (bool, error) {
	var mode, alias *string
	if value, ok := params["identity_mode"]; ok {
		if err := json.Unmarshal(value, &mode); err != nil {
			return false, err
		}
	}
	if value, ok := params["identityMode"]; ok {
		if err := json.Unmarshal(value, &alias); err != nil {
			return false, err
		}
	}
	if mode != nil && alias != nil && *mode != *alias {
		return false, errors.New("conflicting metadata identity modes")
	}
	if mode == nil {
		mode = alias
	}
	if mode == nil {
		return false, nil
	}
	if *mode != "exact" {
		return false, errors.New("unsupported metadata identity mode")
	}
	return true, nil
}

func oracleTriggerAvailable() oracleTriggerReadState {
	return oracleTriggerReadState{State: "available"}
}
func oracleTriggerMissing(field string) oracleTriggerReadState {
	return oracleTriggerReadState{State: "unavailable", Message: field + " is not exposed by this dictionary"}
}

var oracleTriggerErrorCode = regexp.MustCompile(`ORA-[0-9]{5}`)

func oracleTriggerReadFailure(err error) oracleTriggerReadState {
	code := oracleTriggerErrorCode.FindString(err.Error())
	state := "error"
	switch code {
	case "ORA-01031":
		state = "denied"
	case "ORA-00942", "ORA-00904":
		state = "unavailable"
	}
	message := "Trigger metadata could not be read"
	if code != "" {
		message += " (" + code + ")"
	}
	return oracleTriggerReadState{State: state, Message: message}
}

func triggerText(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func newOracleTriggerMetadata(owner, name string) *oracleTriggerMetadata {
	return &oracleTriggerMetadata{ContractVersion: 1, IdentityMode: "exact", Engine: "oracle", Owner: owner, Name: name,
		Scope: "UNKNOWN", Reads: make(map[string]oracleTriggerReadState)}
}

func oracleTriggerStatement(source, description, condition, referencing string) string {
	if oracleTriggerIsStructured(description, condition, referencing) {
		if body, ok := oracleTriggerBody(source, description); ok {
			return body
		}
	}
	return source
}

func (s *server) readExactTriggerRows(predicate string, args []any, includeSource bool) ([]triggerInfo, error) {
	projection := `t.OWNER, t.TRIGGER_NAME, t.TRIGGERING_EVENT, t.TRIGGER_TYPE, t.STATUS,
t.TABLE_OWNER, t.TABLE_NAME, t.BASE_OBJECT_TYPE, t.DESCRIPTION, t.WHEN_CLAUSE, t.REFERENCING_NAMES,
TO_CHAR(o.OBJECT_ID), TO_CHAR(o.LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS'), o.STATUS`
	join := ""
	if includeSource {
		projection += ", s.LINE, s.TEXT"
		join = " LEFT JOIN ALL_SOURCE s ON s.OWNER=t.OWNER AND s.NAME=t.TRIGGER_NAME AND s.TYPE='TRIGGER'"
	}
	query := "SELECT " + projection + " FROM ALL_TRIGGERS t LEFT JOIN ALL_OBJECTS o " +
		"ON o.OWNER=t.OWNER AND o.OBJECT_NAME=t.TRIGGER_NAME AND o.OBJECT_TYPE='TRIGGER'" + join +
		" WHERE " + predicate + " ORDER BY t.TRIGGER_NAME, t.OWNER"
	if includeSource {
		query += ", s.LINE"
	}
	rows, err := s.queryRows(query, args)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	result := []triggerInfo{}
	type identity struct{ owner, name string }
	type sourceGroup struct {
		index                               int
		description, condition, referencing string
		source                              strings.Builder
		lastLine                            int64
	}
	groups := map[identity]*sourceGroup{}
	for rows.Next() {
		var owner, name string
		var event, timing, status, parentOwner, parentName, scopeType, description, condition, referencing, objectID, ddlTime, validity sql.NullString
		var line sql.NullInt64
		var lineText sql.NullString
		values := []any{&owner, &name, &event, &timing, &status, &parentOwner, &parentName, &scopeType, &description,
			&condition, &referencing, &objectID, &ddlTime, &validity}
		if includeSource {
			values = append(values, &line, &lineText)
		}
		if err := rows.Scan(values...); err != nil {
			return nil, err
		}
		if owner == "" || name == "" {
			return nil, errors.New("trigger dictionary identity is incomplete")
		}
		key := identity{owner, name}
		group := groups[key]
		if group == nil {
			metadata := newOracleTriggerMetadata(owner, name)
			metadata.description, metadata.referencing = description.String, referencing.String
			metadata.ObjectID, metadata.LastDDLTime, metadata.ScopeType = triggerText(objectID), triggerText(ddlTime), triggerText(scopeType)
			if scopeType.Valid {
				switch strings.ToUpper(scopeType.String) {
				case "TABLE", "VIEW", "SCHEMA", "DATABASE", "TIMER":
					metadata.Scope = strings.ToUpper(scopeType.String)
				default:
					metadata.Scope = "OTHER"
				}
			}
			if (metadata.Scope == "TABLE" || metadata.Scope == "VIEW") && parentOwner.Valid && parentName.Valid {
				metadata.Parent = &oracleTriggerParent{Owner: parentOwner.String, Name: parentName.String, ObjectType: metadata.Scope}
			}
			if metadata.Scope == "SCHEMA" {
				metadata.ScopeOwner = triggerText(parentOwner)
			}
			trigger := triggerInfo{Name: name, Event: event.String, Timing: timing.String, Condition: triggerText(condition),
				Enabled: oracleTriggerEnabled(status), OracleMetadata: metadata}
			if validity.Valid && (strings.EqualFold(validity.String, "VALID") || strings.EqualFold(validity.String, "INVALID")) {
				valid := strings.EqualFold(validity.String, "VALID")
				trigger.Valid = &valid
			}
			metadata.Reads["identity"] = oracleTriggerAvailable()
			if metadata.ObjectID == nil {
				metadata.Reads["identity"] = oracleTriggerMissing("Object ID")
			}
			metadata.Reads["scope"] = oracleTriggerAvailable()
			if metadata.Scope == "UNKNOWN" {
				metadata.Reads["scope"] = oracleTriggerMissing("Trigger scope")
			}
			metadata.Reads["parent"] = oracleTriggerAvailable()
			if metadata.Scope == "UNKNOWN" || metadata.Scope == "OTHER" || (metadata.Scope == "TABLE" || metadata.Scope == "VIEW") && metadata.Parent == nil {
				metadata.Reads["parent"] = oracleTriggerMissing("Owning object")
			}
			if metadata.Scope == "SCHEMA" && metadata.ScopeOwner == nil {
				metadata.Reads["scope"] = oracleTriggerMissing("Scope owner")
			}
			metadata.Reads["enabled"] = oracleTriggerAvailable()
			if trigger.Enabled == nil {
				metadata.Reads["enabled"] = oracleTriggerMissing("Enabled state")
			}
			metadata.Reads["validity"] = oracleTriggerAvailable()
			if trigger.Valid == nil {
				metadata.Reads["validity"] = oracleTriggerMissing("Object validity")
			}
			group = &sourceGroup{index: len(result), description: description.String, condition: condition.String, referencing: referencing.String}
			groups[key] = group
			result = append(result, trigger)
		} else if !includeSource {
			return nil, errors.New("exact trigger identity is not unique")
		}
		if includeSource && line.Valid {
			if !lineText.Valid || line.Int64 != group.lastLine+1 {
				return nil, errors.New("trigger source rows are incomplete or duplicated")
			}
			group.source.WriteString(lineText.String)
			group.lastLine = line.Int64
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if includeSource {
		for _, group := range groups {
			source := group.source.String()
			if source == "" {
				continue
			}
			source = oracleTriggerStatement(source, group.description, group.condition, group.referencing)
			result[group.index].Statement = &source
		}
	}
	return result, nil
}

func (s *server) listExactTriggers(parentOwner, parentName string) ([]triggerInfo, error) {
	if parentOwner == "" || parentName == "" {
		return nil, errors.New("exact trigger metadata requires a parent owner and name")
	}
	triggers, err := s.readExactTriggerRows("t.TABLE_OWNER=:1 AND t.TABLE_NAME=:2 AND t.BASE_OBJECT_TYPE IN ('TABLE','VIEW')", []any{parentOwner, parentName}, true)
	if err != nil {
		return nil, err
	}
	for _, trigger := range triggers {
		parent := trigger.OracleMetadata.Parent
		if parent == nil || parent.Owner != parentOwner || parent.Name != parentName {
			return nil, errors.New("owning object identity does not match the exact request")
		}
	}
	return triggers, nil
}

func (s *server) enrichExactTriggerObjects(objects []objectInfo, owner string) {
	indices := []int{}
	for index := range objects {
		if objects[index].ObjectType == "TRIGGER" {
			indices = append(indices, index)
		}
	}
	for start := 0; start < len(indices); start += 500 {
		end := start + 500
		if end > len(indices) {
			end = len(indices)
		}
		batch := indices[start:end]
		args := []any{owner}
		binds := []string{}
		for _, index := range batch {
			args = append(args, objects[index].Name)
			binds = append(binds, fmt.Sprintf(":%d", len(args)))
		}
		triggers, err := s.readExactTriggerRows("t.OWNER=:1 AND t.TRIGGER_NAME IN ("+strings.Join(binds, ",")+")", args, false)
		byName := map[string]triggerInfo{}
		for _, trigger := range triggers {
			if trigger.OracleMetadata.Owner == owner {
				byName[trigger.Name] = trigger
			}
		}
		for _, index := range batch {
			trigger, found := byName[objects[index].Name]
			if err != nil || !found {
				metadata := newOracleTriggerMetadata(owner, objects[index].Name)
				state := oracleTriggerReadState{State: "incomplete", Message: "Trigger changed or is no longer visible; reload"}
				if err != nil {
					state = oracleTriggerReadFailure(err)
				}
				for _, field := range []string{"identity", "scope", "parent", "enabled", "validity"} {
					metadata.Reads[field] = state
				}
				trigger = triggerInfo{Name: objects[index].Name, OracleMetadata: metadata}
			}
			objects[index].Trigger, objects[index].Valid = &trigger, trigger.Valid
			if parent := trigger.OracleMetadata.Parent; parent != nil {
				parentOwner, parentName := parent.Owner, parent.Name
				objects[index].ParentSchema, objects[index].ParentName = &parentOwner, &parentName
			}
		}
	}
}

func (s *server) getExactTriggerSource(owner, name string) (map[string]any, error) {
	if owner == "" || name == "" {
		return nil, errors.New("exact trigger metadata requires owner and name")
	}
	read := func() ([]triggerInfo, error) {
		return s.readExactTriggerRows("t.OWNER=:1 AND t.TRIGGER_NAME=:2", []any{owner, name}, false)
	}
	before, err := read()
	if err != nil {
		return nil, err
	}
	if len(before) == 0 {
		metadata := newOracleTriggerMetadata(owner, name)
		metadata.Reads["identity"] = oracleTriggerReadState{State: "empty", Message: "No visible trigger with this exact owner/name"}
		return map[string]any{"name": name, "object_type": "TRIGGER", "schema": owner, "source": "", "editable": false,
			"trigger": triggerInfo{Name: name, OracleMetadata: metadata}}, nil
	}
	if len(before) != 1 || before[0].OracleMetadata.Owner != owner || before[0].Name != name {
		return nil, errors.New("trigger identity does not match the exact request")
	}
	source, found, sourceErr := s.loadObjectSourceText(owner, name, "TRIGGER")
	origin, format := "ALL_SOURCE", "declaration"
	if sourceErr != nil || !found || source == "" {
		if ddl, ddlErr := s.exactTriggerDDL(owner, name); ddlErr == nil && ddl != "" {
			source, found, sourceErr, origin, format = ddl, true, nil, "DBMS_METADATA", "ddl"
		} else if sourceErr == nil {
			sourceErr = ddlErr
		}
	}
	compilationErrors, errorsErr := s.exactTriggerErrors(owner, name)
	after, err := read()
	if err != nil {
		return nil, err
	}
	stable := len(after) == 1 && reflect.DeepEqual(before[0], after[0])
	trigger := before[0]
	if len(after) == 1 {
		trigger = after[0]
	}
	metadata := trigger.OracleMetadata
	if origin == "ALL_SOURCE" && found && sourceErr == nil && source != "" {
		condition := ""
		if trigger.Condition != nil {
			condition = *trigger.Condition
		}
		statement := oracleTriggerStatement(source, metadata.description, condition, metadata.referencing)
		trigger.Statement = &statement
	}
	metadata.Definition = &oracleTriggerDefinition{Origin: origin, Format: format, Complete: stable && found && sourceErr == nil && source != ""}
	metadata.Reads["definition"] = oracleTriggerAvailable()
	if !metadata.Definition.Complete {
		metadata.Reads["definition"] = oracleTriggerMissing("Complete trigger definition")
	}
	if sourceErr != nil {
		metadata.Reads["definition"] = oracleTriggerReadFailure(sourceErr)
	}
	if !stable {
		state := oracleTriggerReadState{State: "incomplete", Message: "Trigger changed while loading; reload"}
		metadata.Reads["identity"], metadata.Reads["definition"] = state, state
	}
	metadata.Errors, metadata.Reads["errors"] = compilationErrors, oracleTriggerAvailable()
	if errorsErr != nil {
		metadata.Errors = nil
		metadata.Reads["errors"] = oracleTriggerReadFailure(errorsErr)
	}
	return map[string]any{"name": name, "object_type": "TRIGGER", "schema": owner, "source": source, "trigger": trigger}, nil
}

func (s *server) exactTriggerDDL(owner, name string) (string, error) {
	rows, err := s.queryRows("SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM DUAL", []any{"TRIGGER", name, owner})
	if err != nil {
		return "", err
	}
	defer s.closeRows(rows)
	if !rows.Next() {
		return "", rows.Err()
	}
	var source sql.NullString
	if err := rows.Scan(&source); err != nil {
		return "", err
	}
	return source.String, rows.Err()
}

func (s *server) exactTriggerErrors(owner, name string) ([]oracleTriggerCompilationError, error) {
	rows, err := s.queryRows("SELECT SEQUENCE, LINE, POSITION, TEXT, ATTRIBUTE FROM ALL_ERRORS WHERE OWNER=:1 AND NAME=:2 AND TYPE='TRIGGER' ORDER BY SEQUENCE", []any{owner, name})
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	result := []oracleTriggerCompilationError{}
	for rows.Next() {
		var item oracleTriggerCompilationError
		var severity sql.NullString
		if err := rows.Scan(&item.Sequence, &item.Line, &item.Position, &item.Text, &severity); err != nil {
			return nil, err
		}
		item.Severity = triggerText(severity)
		result = append(result, item)
	}
	return result, rows.Err()
}
