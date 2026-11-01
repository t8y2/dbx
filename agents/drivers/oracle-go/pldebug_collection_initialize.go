package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type plDebugCollectionOperation struct {
	sql      string
	variable string
	input    *plDebugNativeInput
}

type plDebugCollectionInitializer struct {
	prefix         string
	timezonePrefix string
	declarations   string
	names          []string
	operations     []plDebugCollectionOperation
}

func (builder *plDebugCollectionInitializer) statement(sql string) {
	builder.operations = append(builder.operations, plDebugCollectionOperation{sql: sql})
}

func (builder *plDebugCollectionInitializer) local(kind string) string {
	name := fmt.Sprintf("%sCOL_%d", builder.prefix, len(builder.names))
	builder.names = append(builder.names, name)
	builder.declarations += "  " + name + " " + kind + ";\n"
	return name
}

func (builder *plDebugCollectionInitializer) record(input *plDebugRecordInput, variable string) error {
	field := func(path []string) string {
		target := variable
		for _, part := range path {
			target += "." + quoteIdentifier(part)
		}
		return target
	}
	for _, leaf := range input.leaves {
		value := leaf.input
		builder.scalar(value, field(leaf.path))
	}
	for _, collection := range input.collections {
		if err := builder.collection(collection.input, field(collection.path)); err != nil {
			return err
		}
	}
	for _, object := range input.objects {
		if err := builder.object(object.input, field(object.path)); err != nil {
			return err
		}
	}
	return nil
}

func (builder *plDebugCollectionInitializer) collection(input *plDebugCollectionInput, variable string) error {
	indexType := input.definition.text("INDEX_BY")
	if input.null {
		builder.statement(variable + " := NULL;")
		return nil
	}
	maximum := int64(0)
	values := map[int64]string{}
	if indexType != "" {
		builder.statement(variable + ".DELETE;")
	} else {
		for _, entry := range input.entries {
			index, _ := strconv.ParseInt(entry.index, 10, 32)
			if index > maximum {
				maximum = index
			}
		}
		if maximum > 8192 {
			return errors.New("collection initialization span exceeds allocation budget")
		}
	}
	for _, entry := range input.entries {
		key := entry.index
		if indexType == "VARCHAR2" {
			key = builder.local("VARCHAR2(32767)")
			binding := plDebugNativeInput{argument: plDebugNativeArgument{Mode: "IN", Type: "VARCHAR2"}, state: "value", value: entry.index}
			builder.operations = append(builder.operations, plDebugCollectionOperation{variable: key, input: &binding})
			builder.statement("IF " + variable + ".EXISTS(" + key + ") THEN RAISE_APPLICATION_ERROR(-20995,'collection index collision in target session'); END IF;")
		}
		target := variable + "(" + key + ")"
		if indexType == "" {
			kind := ""
			if entry.scalar != nil {
				kind = entry.scalar.argument.Type
				switch kind {
				case "VARCHAR2", "CHAR":
					kind = "VARCHAR2(32767)"
				case "NCHAR", "NVARCHAR2":
					kind = "NVARCHAR2(32767)"
				case "PL/SQL BOOLEAN":
					kind = "BOOLEAN"
				case "RAW":
					kind = "RAW(32767)"
				case "TIMESTAMP":
					kind = "TIMESTAMP(9)"
				case plDebugTimestampTZ, plDebugTimestampLTZ:
					kind = strings.Replace(kind, "TIMESTAMP", "TIMESTAMP(9)", 1)
				case "INTERVAL YEAR TO MONTH":
					kind = "INTERVAL YEAR(9) TO MONTH"
				case "INTERVAL DAY TO SECOND":
					kind = "INTERVAL DAY(9) TO SECOND(9)"
				}
			} else if entry.collection != nil {
				kind = entry.collection.reference.declaration()
			} else if entry.record != nil {
				kind = entry.record.reference.declaration()
			} else if entry.object != nil {
				kind = entry.object.reference.declaration()
			}
			if kind == "" {
				return errors.New("collection element has no normalized input")
			}
			target = builder.local(kind)
			index, _ := strconv.ParseInt(entry.index, 10, 32)
			values[index] = target
		}
		if entry.scalar != nil {
			builder.scalar(*entry.scalar, target)
		} else if entry.collection != nil {
			if err := builder.collection(entry.collection, target); err != nil {
				return err
			}
		} else if entry.record != nil {
			local := target
			if indexType != "" {
				local = builder.local(entry.record.reference.declaration())
			}
			if err := builder.record(entry.record, local); err != nil {
				return err
			}
			if local != target {
				builder.statement(target + " := " + local + ";")
			}
		} else if entry.object != nil {
			if err := builder.object(entry.object, target); err != nil {
				return err
			}
		} else {
			return errors.New("collection element has no normalized input")
		}
	}
	if indexType == "" {
		arguments := make([]string, maximum)
		seed := ""
		if len(input.entries) > 0 {
			index, _ := strconv.ParseInt(input.entries[0].index, 10, 32)
			seed = values[index]
		}
		for index := int64(1); index <= maximum; index++ {
			value := values[index]
			if value == "" {
				value = seed
			}
			arguments[index-1] = value
		}
		builder.statement(variable + " := " + input.reference.declaration() + "(" + strings.Join(arguments, ",") + ");")
	}
	if indexType == "" && input.definition.text("COLL_TYPE") == "TABLE" {
		present := map[int64]bool{}
		maximum := int64(0)
		for _, entry := range input.entries {
			index, _ := strconv.ParseInt(entry.index, 10, 32)
			present[index] = true
			if index > maximum {
				maximum = index
			}
		}
		for index := int64(1); index <= maximum; index++ {
			if !present[index] {
				builder.statement(fmt.Sprintf("%s.DELETE(%d);", variable, index))
			}
		}
	}
	return nil
}
