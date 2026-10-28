package main

import "strings"

func (builder *plDebugCollectionInitializer) object(input *plDebugObjectInput, variable string) error {
	if input.null {
		builder.statement(variable + " := NULL;")
		return nil
	}
	arguments := []string{}
	for _, formal := range input.constructor.Parameters {
		var value *plDebugObjectArgument
		for index := range input.arguments {
			if input.arguments[index].formal.Name == formal.Name {
				value = &input.arguments[index]
				break
			}
		}
		if value.defaulted {
			continue
		}
		kind := formal.Type.text("ATTR_TYPE_NAME")
		if owner := formal.Type["ATTR_TYPE_OWNER"]; owner != nil {
			kind = (plDebugNativeTypeRef{Owner: *owner, PackageName: formal.Type["ATTR_TYPE_PACKAGE"], TypeName: kind}).declaration()
		} else {
			if carrier := plDebugNativeConstructorNumericCarrier(formal.Type); carrier != "" {
				kind = carrier
			} else {
				kind = plDebugNativeScalarTypeName(kind)
			}
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
		}
		local := builder.local(kind)
		var err error
		switch {
		case value.scalar != nil:
			builder.scalar(*value.scalar, local)
		case value.record != nil:
			err = builder.record(value.record, local)
		case value.collection != nil:
			err = builder.collection(value.collection, local)
		case value.object != nil:
			err = builder.object(value.object, local)
		}
		if err != nil {
			return err
		}
		arguments = append(arguments, quoteIdentifier(formal.Name)+" => "+local)
	}
	builder.statement(variable + " := " + input.reference.declaration() + "(" + strings.Join(arguments, ",") + ");")
	return nil
}
