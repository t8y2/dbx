package main

import (
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"

	go_ora "github.com/sijms/go-ora/v2"
)

type plDebugNativeBody struct {
	Declarations       string
	Source             string
	After              string
	RollbackCondition  string
	CallLine           int
	CallLastLine       int
	PrivateNames       []string
	ScopedDeclarations string
	Initialization     string
	Completion         string
}

type plDebugNativeNamedCall struct {
	plan         *plDebugNativePlan
	phase        sql.NullInt64
	values       []sql.NullString
	copied       []sql.NullInt64
	arguments    []interface{}
	oci          bool
	ociValues    []string
	lobs         map[int]*plDebugLobOutput
	lengths      []sql.NullInt64
	timezones    map[int]*[4]sql.NullString
	ociTimezones map[int]*[4]string
	inputZone    sql.NullString
	ociInputZone string
}

func (p *plDebugNativePlan) supplied() []plDebugNativeInput {
	result := []plDebugNativeInput{}
	for _, input := range p.arguments {
		if input.state != "default" {
			result = append(result, input)
		}
	}
	return result
}
func (p *plDebugNativePlan) outputs() []plDebugNativeArgument {
	result := []plDebugNativeArgument{}
	for _, input := range p.arguments {
		if input.argument.output() {
			result = append(result, input.argument)
		}
	}
	if returned := p.target.returns(); returned != nil {
		result = append(result, *returned)
	}
	return result
}
func (p *plDebugNativePlan) inputCount() int {
	count := 0
	for _, input := range p.boundInputs() {
		if input.argument.input() {
			count++
		}
	}
	return count
}

func (p *plDebugNativePlan) boundInputs() []plDebugNativeInput {
	result := []plDebugNativeInput{}
	for _, input := range p.supplied() {
		if (input.argument.national() || input.argument.Type == "NCLOB" || input.argument.timezone()) && input.argument.input() || input.object != nil || input.collection != nil || input.record != nil && input.record.needsInitializer() {
			builder := plDebugCollectionInitializer{prefix: "DBX_BIND_"}
			var err error
			if input.argument.national() || input.argument.Type == "NCLOB" || input.argument.timezone() {
				builder.scalar(input, "ROOT")
			} else if input.object != nil {
				err = builder.object(input.object, "ROOT")
			} else if input.collection != nil {
				err = builder.collection(input.collection, "ROOT")
			} else {
				err = builder.record(input.record, "ROOT")
			}
			if err != nil {
				panic(err)
			}
			for _, operation := range builder.operations {
				if operation.input != nil {
					binding := *operation.input
					name := *input.argument.Name + "." + operation.variable
					binding.argument.Name = &name
					result = append(result, binding)
				}
			}
			continue
		}
		if input.record == nil {
			result = append(result, input)
			continue
		}
		for _, leaf := range input.record.leaves {
			binding := leaf.input
			name := *input.argument.Name + "." + strings.Join(leaf.path, ".")
			binding.argument.Name = &name
			result = append(result, binding)
		}
	}
	return result
}
func (p *plDebugNativePlan) prefixCount() int {
	count := p.inputCount() + 1 + 2*len(p.outputs())
	if p.timezoneTypes() {
		count++
	}
	for _, a := range p.outputs() {
		if a.timezone() {
			count += 3
		}
		if a.retainedOutput() {
			count++
		}
	}
	return count
}

func (p *plDebugNativePlan) block() (plDebugNativeBlock, error) {
	block, err := plDebugNativeCaptureRender(p.target.routine(), p.prefixCount(), false, p.render)
	if err == nil && p.typedSignature != nil && len(block.SQL) > 1024*1024 {
		return plDebugNativeBlock{}, errors.New("typed debugger generated SQL byte budget exceeded")
	}
	return block, err
}

func (p *plDebugNativePlan) render(prefix string) plDebugNativeBody {
	phase := prefix + "PHASE"
	declarations := "  " + phase + " INTEGER := 0;\n"
	scoped := ""
	names := []string{phase}
	locals := map[int64]string{}
	recordTypes := map[int64]string{}
	for _, a := range p.target.Arguments {
		if a.Level == 0 && a.composite() {
			if ref, err := plDebugNativeArgumentTypeRef(a); err == nil && ref != nil {
				recordTypes[a.Position] = ref.declaration()
			}
		}
	}
	for _, input := range p.supplied() {
		if input.record != nil {
			recordTypes[input.argument.Position] = input.record.reference.declaration()
		}
	}
	declare := func(a plDebugNativeArgument, index int) {
		name := fmt.Sprintf("%sARG_%d", prefix, index)
		locals[a.Position] = name
		names = append(names, name)
		kind := "VARCHAR2(32767)"
		if a.Type == "NUMBER" {
			kind = "NUMBER"
		}
		if a.Type == "BINARY_INTEGER" {
			kind = "BINARY_INTEGER"
		}
		if a.binaryFloat() {
			kind = a.Type
		}
		if a.Type == "PL/SQL BOOLEAN" {
			kind = "BOOLEAN"
		}
		if a.Type == "DATE" {
			kind = "DATE"
		}
		if a.Type == "TIMESTAMP" {
			kind = "TIMESTAMP(9)"
		}
		if a.timezone() {
			kind = strings.Replace(plDebugNativeScalarTypeName(a.Type), "TIMESTAMP", "TIMESTAMP(9)", 1)
		}
		if a.Type == "CLOB" || a.Type == "NCLOB" || a.Type == "BLOB" {
			kind = a.Type
		}
		if a.Type == "RAW" {
			kind = "RAW(32767)"
		}
		if a.national() {
			kind = "NVARCHAR2(32767)"
			if p.typedSignature != nil && p.typedSignature.NationalCharacterSet == "AL16UTF16" {
				kind = "NVARCHAR2(16383)"
			}
		}
		if a.Type == "INTERVAL YEAR TO MONTH" {
			kind = "INTERVAL YEAR(9) TO MONTH"
		}
		if a.Type == "INTERVAL DAY TO SECOND" {
			kind = "INTERVAL DAY(9) TO SECOND(9)"
		}
		if recordTypes[a.Position] != "" {
			kind = recordTypes[a.Position]
		}
		if p.typedSignature != nil {
			scoped += "  " + name + " " + kind + ";\n"
			if a.Mode == "IN OUT" && (a.Type == "CLOB" || a.Type == "BLOB") {
				scoped += "  " + name + "_INPUT " + kind + ";\n"
				names = append(names, name+"_INPUT")
			}
			if a.Type == "DATE" && a.output() {
				scoped += "  " + name + "_TS TIMESTAMP(9);\n"
				names = append(names, name+"_TS")
			}
			if (a.Type == "DATE" || a.Type == "TIMESTAMP") && a.input() {
				scoped += "  " + name + "_SEC NUMBER;\n"
				names = append(names, name+"_SEC")
			}
		} else {
			declarations += "  " + name + " " + kind + ";\n"
		}
	}
	supplied := p.supplied()
	for index, input := range supplied {
		declare(input.argument, index)
	}
	if returned := p.target.returns(); returned != nil {
		declare(*returned, len(supplied))
	}
	body := ""
	index := 0
	bindings := []plDebugNativeInput{}
	initialization := map[int]string{}
	secondsLocals := map[int64]string{}
	for _, input := range supplied {
		if (input.argument.national() || input.argument.Type == "NCLOB" || input.argument.timezone()) && input.argument.input() || input.object != nil || input.collection != nil || input.record != nil && input.record.needsInitializer() {
			builder := plDebugCollectionInitializer{prefix: fmt.Sprintf("%sINPUT_%d_", prefix, input.argument.Position), timezonePrefix: prefix}
			var err error
			if input.argument.national() || input.argument.Type == "NCLOB" || input.argument.timezone() {
				builder.scalar(input, locals[input.argument.Position])
			} else if input.object != nil {
				err = builder.object(input.object, locals[input.argument.Position])
			} else if input.collection != nil {
				err = builder.collection(input.collection, locals[input.argument.Position])
			} else {
				err = builder.record(input.record, locals[input.argument.Position])
			}
			if err != nil {
				panic(err)
			}
			scoped += builder.declarations
			names = append(names, builder.names...)
			for _, operation := range builder.operations {
				if operation.input == nil {
					initialization[len(bindings)] += "    " + operation.sql + "\n"
					continue
				}
				binding := *operation.input
				position := -int64(len(bindings) + 1)
				binding.argument.Position = position
				locals[position] = operation.variable
				if binding.argument.Type == "DATE" || binding.argument.Type == "TIMESTAMP" {
					seconds := fmt.Sprintf("%sBIND_%d_SEC", prefix, len(bindings))
					secondsLocals[position] = seconds
					scoped += "  " + seconds + " NUMBER;\n"
					names = append(names, seconds)
				}
				bindings = append(bindings, binding)
			}
			continue
		}
		if input.record == nil {
			bindings = append(bindings, input)
			continue
		}
		for _, leaf := range input.record.leaves {
			binding := leaf.input
			position := -int64(len(bindings) + 1)
			binding.argument.Position = position
			variable := locals[input.argument.Position]
			for _, field := range leaf.path {
				variable += "." + quoteIdentifier(field)
			}
			locals[position] = variable
			if binding.argument.Type == "DATE" || binding.argument.Type == "TIMESTAMP" {
				seconds := fmt.Sprintf("%sBIND_%d_SEC", prefix, len(bindings))
				secondsLocals[position] = seconds
				scoped += "  " + seconds + " NUMBER;\n"
				names = append(names, seconds)
			}
			bindings = append(bindings, binding)
		}
	}
	for bindingIndex, input := range bindings {
		body += initialization[bindingIndex]
		if input.argument.input() {
			index++
			sign := ""
			if input.argument.decimalCarrier() && input.value != nil && strings.HasPrefix(input.value.(string), "-") {
				sign = "-"
			}
			if input.argument.binaryFloat() {
				body += fmt.Sprintf("    %s := SYS.UTL_RAW.CAST_TO_%s(HEXTORAW(:%d),SYS.UTL_RAW.BIG_ENDIAN);\n", locals[input.argument.Position], input.argument.Type, index)
			} else if input.argument.Type == plDebugNationalChunkType {
				body += fmt.Sprintf("    %s := %s || UNISTR(:%d);\n", locals[input.argument.Position], locals[input.argument.Position], index)
			} else if input.argument.Type == "INTERVAL YEAR TO MONTH" || input.argument.Type == "INTERVAL DAY TO SECOND" {
				function := "TO_YMINTERVAL"
				declaration := "INTERVAL YEAR(9) TO MONTH"
				extra := ""
				if input.argument.Type == "INTERVAL DAY TO SECOND" {
					function = "TO_DSINTERVAL"
					declaration = "INTERVAL DAY(9) TO SECOND(9)"
					extra = ",'NLS_NUMERIC_CHARACTERS=''.,'''"
				}
				body += fmt.Sprintf("    SELECT CAST(%s(:%d%s) AS %s) INTO %s FROM SYS.DUAL;\n", function, index, extra, declaration, locals[input.argument.Position])
			} else if input.argument.Type == "PL/SQL BOOLEAN" {
				body += fmt.Sprintf("    %s := CASE :%d WHEN 1 THEN TRUE WHEN 0 THEN FALSE ELSE NULL END;\n", locals[input.argument.Position], index)
			} else if input.argument.Type == "DATE" || input.argument.Type == "TIMESTAMP" {
				variable := locals[input.argument.Position]
				seconds := variable + "_SEC"
				if secondsLocals[input.argument.Position] != "" {
					seconds = secondsLocals[input.argument.Position]
				}
				day := "1970-01-01"
				if input.value != nil {
					day = input.value.(plDebugNativeTemporalInput).day
				}
				body += fmt.Sprintf("    %s := %s:%d;\n", seconds, sign, index)
				converted := "DATE '" + day + "' + " + seconds + " / 86400"
				if input.argument.Type == "TIMESTAMP" {
					body += "    " + variable + " := TIMESTAMP '" + day + " 00:00:00';\n"
					converted = variable + " + NUMTODSINTERVAL(FLOOR(" + seconds + "), 'SECOND') + NUMTODSINTERVAL(" + seconds + " - FLOOR(" + seconds + "), 'SECOND')"
				}
				body += "    " + variable + " := " + converted + ";\n"
			} else {
				body += fmt.Sprintf("    %s := %s:%d;\n", locals[input.argument.Position], sign, index)
				if input.value == nil && (input.argument.Type == "CLOB" || input.argument.Type == "BLOB") {
					body += fmt.Sprintf("    %s := NULL;\n", locals[input.argument.Position])
				}
				if lob, ok := input.value.(plDebugLobInput); ok && lob.bytes == 0 && input.argument.Type != "RAW" {
					body += fmt.Sprintf("    SYS.DBMS_LOB.CREATETEMPORARY(%s, TRUE, SYS.DBMS_LOB.CALL);\n", locals[input.argument.Position])
				}
				if input.argument.Mode == "IN OUT" && (input.argument.Type == "CLOB" || input.argument.Type == "BLOB") {
					body += fmt.Sprintf("    %s_INPUT := %s;\n", locals[input.argument.Position], locals[input.argument.Position])
				}
			}
		}
	}
	body += initialization[len(bindings)]
	body += plDebugCompositeCaptureContext(p.compositeOutputNodes, prefix)
	if p.timezoneTypes() {
		name := prefix + "INPUT_ZONE"
		declarations += "  " + name + " VARCHAR2(128);\n"
		names = append(names, name)
		body += "    " + name + " := SESSIONTIMEZONE;\n"
	}
	body += "    " + phase + " := 1;\n"
	callLine := strings.Count(body, "\n") + 1
	body += "    "
	if p.target.returns() != nil {
		body += locals[0] + " := "
	}
	actuals := []string{}
	for _, input := range supplied {
		actuals = append(actuals, quoteIdentifier(*input.argument.Name)+" => "+locals[input.argument.Position])
	}
	body += p.target.routine() + "(" + strings.Join(actuals, ", ") + ");\n"
	callLastLine := strings.Count(body, "\n")
	body += "    " + phase + " := 2;\n"
	// The phase is the first OUT register, before any result-field conversion.
	// Each field's acknowledgement follows its value: a failed/missing transfer
	// cannot turn an unassigned destination into a verified SQL NULL.
	index++
	after := fmt.Sprintf("  :%d := %s;\n", index, phase)
	completion := ""
	if p.typedSignature != nil {
		completion, after = fmt.Sprintf("  :%d := %s;\n", p.prefixCount(), phase), ""
		index--
	}
	lobLeft := ""
	var encoder *plDebugCompositeEncoder
	nationalScalar := false
	characterScalar := false
	for _, argument := range p.outputs() {
		nationalScalar = nationalScalar || argument.national() || argument.Type == "NCLOB"
		characterScalar = characterScalar || argument.Type == "CHAR"
	}
	if len(p.compositeOutputNodes) > 0 || nationalScalar || characterScalar {
		value := newPLDebugCompositeEncoder(p.compositeOutputNodes, prefix, prefix+"LOB_LEFT")
		value.nationalScalar = nationalScalar
		value.timezone = p.timezoneTypes()
		encoder = &value
		names = append(names, encoder.privateNames()...)
	}
	for field, a := range p.outputs() {
		done := fmt.Sprintf("%sDONE_%d", prefix, field)
		declarations += "  " + done + " INTEGER := 0;\n"
		names = append(names, done)
		value := locals[a.Position]
		prepareExport := ""
		if a.decimalCarrier() {
			value = "TO_CHAR(" + value + ", 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')"
		}
		if a.binaryFloat() {
			value = "RAWTOHEX(SYS.UTL_RAW.CAST_FROM_" + a.Type + "(" + value + ",SYS.UTL_RAW.BIG_ENDIAN))"
		}
		if a.Type == "PL/SQL BOOLEAN" {
			value = "CASE WHEN " + value + " IS NULL THEN NULL WHEN " + value + " THEN 'true' ELSE 'false' END"
		}
		if a.Type == "DATE" {
			prepareExport = "    " + value + "_TS := " + value + ";\n"
			value += "_TS"
		}
		if a.Type == "DATE" || a.Type == "TIMESTAMP" {
			value = plDebugNativeTemporalExport(value, a.Type == "TIMESTAMP")
		}
		if a.interval() {
			value = "REPLACE(TO_CHAR(" + value + "),',','.')"
		}
		if a.timezone() {
			components := []string{}
			for component, size := range []int{40, 6, 40, 128} {
				name := fmt.Sprintf("%sTZ_%d_%d", prefix, field, component)
				scoped += fmt.Sprintf("  %s VARCHAR2(%d);\n", name, size)
				names = append(names, name)
				components = append(components, name)
			}
			procedure := "TZ_PARTS"
			if plDebugNativeScalarTypeName(a.Type) == plDebugTimestampLTZ {
				procedure = "LTZ_PARTS"
			}
			after += fmt.Sprintf("  IF %s >= 2 THEN\n    BEGIN\n      %s%s(%s,%s);\n", phase, prefix, procedure, value, strings.Join(components, ","))
			for _, component := range components {
				index++
				after += fmt.Sprintf("      :%d := %s;\n", index, component)
			}
			after += fmt.Sprintf("      %s := 1;\n    EXCEPTION WHEN OTHERS THEN %s := -1;\n    END;\n  END IF;\n", done, done)
			index++
			after += fmt.Sprintf("  :%d := %s;\n", index, done)
			continue
		}
		if a.retainedOutput() {
			if lobLeft == "" {
				lobLeft = prefix + "LOB_LEFT"
				declarations += fmt.Sprintf("  %s INTEGER := %d;\n", lobLeft, p.resultPayloadBudget())
				names = append(names, lobLeft)
			}
			exported, length := fmt.Sprintf("%sLOB_%d", prefix, field), fmt.Sprintf("%sLEN_%d", prefix, field)
			carrierType := a.Type
			if carrierType == "RAW" {
				carrierType = "BLOB"
			}
			if a.composite() || a.national() || a.Type == "NCLOB" || a.Type == "CHAR" {
				carrierType = "CLOB"
			}
			scoped += "  " + exported + " " + carrierType + ";\n"
			if a.Type == "CLOB" {
				scoped += "  " + exported + "_POS INTEGER;\n  " + exported + "_CH VARCHAR2(32767);\n  " + exported + "_COST INTEGER;\n"
				names = append(names, exported+"_POS", exported+"_CH", exported+"_COST")
			}
			declarations += "  " + length + " INTEGER := -2;\n"
			names = append(names, exported, length)
			index++
			exportSQL := plDebugRenderLobExport(a.Type == "BLOB", value, exported, length, done, lobLeft, index)
			if a.Type == "RAW" {
				exportSQL = plDebugRenderRawExport(value, exported, length, done, lobLeft, index)
			}
			if a.composite() || a.national() || a.Type == "NCLOB" || a.Type == "CHAR" {
				ref, _ := plDebugNativeArgumentTypeRef(a)
				encoded := ""
				if a.national() || a.Type == "NCLOB" || a.Type == "CHAR" {
					procedure := "NTV"
					if a.Type == "CHAR" {
						procedure = "TXT"
					}
					if a.Type == "NCLOB" {
						procedure = "NCLB"
					}
					encoded = encoder.beginEncode() + "      " + prefix + procedure + "(" + value + ");\n"
				} else {
					encoded = encoder.encode(*ref, value)
				}
				exportSQL = encoded + fmt.Sprintf("      %s := %sJSON;\n      %s := SYS.DBMS_LOB.GETLENGTH(%s);\n      IF %sHALT THEN %s := 4; ELSIF %sERRORS <> %sROOT_ERRORS THEN %s := 5; ELSE %s := 3; END IF;\n      :%d := %s;\n", exported, prefix, length, exported, prefix, done, prefix, prefix, done, done, index, exported)
			}
			after += fmt.Sprintf("  IF %s >= 2 THEN\n    BEGIN\n", phase) + exportSQL + fmt.Sprintf("    EXCEPTION WHEN OTHERS THEN %s := -1;\n    END;\n  END IF;\n", done)
			index++
			after += fmt.Sprintf("  :%d := %s;\n", index, done)
			index++
			after += fmt.Sprintf("  :%d := %s;\n", index, length)
			continue
		}
		index++
		after += fmt.Sprintf("  IF %s >= 2 THEN\n    BEGIN\n%s      :%d := %s;\n      %s := 1;\n    EXCEPTION WHEN OTHERS THEN %s := -1;\n    END;\n  END IF;\n", phase, prepareExport, index, value, done, done)
		index++
		after += fmt.Sprintf("  :%d := %s;\n", index, done)
	}
	if encoder != nil {
		scoped += encoder.declarations()
	}
	if p.timezoneTypes() {
		index++
		after += fmt.Sprintf("  :%d := %sINPUT_ZONE;\n", index, prefix)
	}
	if p.timezoneTypes() && encoder == nil {
		types := plDebugNativeTimezoneTypeDeclarations(prefix)
		declarations += types
		scoped += strings.TrimPrefix(plDebugNativeTimezoneDeclarations(prefix), types)
		for _, suffix := range []string{"TS9", "TZ9", "LTZ9", "TIME_TEXT", "TZ_INPUT", "LTZ_INPUT", "TZ_PARTS", "LTZ_PARTS"} {
			names = append(names, prefix+suffix)
		}
	}
	result := plDebugNativeBody{Declarations: declarations, Source: body, After: after, RollbackCondition: phase + " < 2", CallLine: callLine, CallLastLine: callLastLine, PrivateNames: names}
	if p.typedSignature != nil {
		result.ScopedDeclarations = scoped
		result.Initialization = "    " + phase + " := -1;\n"
		result.After += "  " + phase + " := 3;\n"
		result.Completion = completion
	}
	return result
}

func (p *plDebugNativePlan) bind(oci bool) (*plDebugNativeNamedCall, error) {
	if p.typedSignature != nil && p.prefixCount()+7 > 16384 {
		return nil, errors.New("typed debugger bind count budget exceeded")
	}
	outputs := p.outputs()
	call := &plDebugNativeNamedCall{plan: p, values: make([]sql.NullString, len(outputs)), copied: make([]sql.NullInt64, len(outputs)), oci: oci, lobs: map[int]*plDebugLobOutput{}, lengths: make([]sql.NullInt64, len(outputs)), timezones: map[int]*[4]sql.NullString{}, ociTimezones: map[int]*[4]string{}}
	if oci {
		call.ociValues = make([]string, len(p.outputs()))
	}
	for _, input := range p.boundInputs() {
		if !input.argument.input() {
			continue
		}
		var value interface{}
		if input.argument.Type == "RAW" {
			value = []byte{}
		}
		if input.value == nil && (input.argument.Type == "CLOB" || input.argument.Type == "BLOB") {
			if oci {
				var err error
				value, err = plDebugNativeOCILobInput(plDebugLobInput{}, input.argument.Type == "BLOB")
				if err != nil {
					return nil, err
				}
			} else if input.argument.Type == "BLOB" {
				value = go_ora.Blob{}
			} else {
				value = go_ora.Clob{}
			}
		}
		if input.value != nil {
			if lob, ok := input.value.(plDebugLobInput); ok {
				if input.argument.Type == "RAW" {
					value = lob.binary
				} else if oci {
					var err error
					value, err = plDebugNativeOCILobInput(lob, input.argument.Type == "BLOB")
					if err != nil {
						return nil, err
					}
				} else if input.argument.Type == "BLOB" {
					value = go_ora.Blob{Data: lob.binary, Valid: true}
				} else {
					value = go_ora.Clob{String: lob.text, Valid: true}
				}
			} else if input.argument.decimalCarrier() || input.argument.Type == "DATE" || input.argument.Type == "TIMESTAMP" {
				text := ""
				if input.argument.decimalCarrier() {
					text = input.value.(string)
				} else {
					text = input.value.(plDebugNativeTemporalInput).seconds
				}
				magnitude := strings.TrimPrefix(text, "-")
				scientific, err := plDebugNativeNumberMagnitude(magnitude)
				if err != nil {
					return nil, fmt.Errorf("parameter %s: %w", *input.argument.Name, err)
				}
				if oci {
					var err error
					value, err = plDebugNativeOCINumber(magnitude)
					if err != nil {
						return nil, fmt.Errorf("parameter %s: %w", *input.argument.Name, err)
					}
				} else {
					number, err := go_ora.NewNumberFromString(scientific)
					if err != nil {
						return nil, fmt.Errorf("parameter %s: %w", *input.argument.Name, err)
					}
					value = number
				}
			} else if input.argument.Type == "PL/SQL BOOLEAN" {
				value = int64(0)
				if input.value.(bool) {
					value = int64(1)
				}
			} else {
				value = input.value
			}
		}
		call.arguments = append(call.arguments, value)
	}
	if p.typedSignature == nil {
		call.arguments = append(call.arguments, plDebugOutArg(oci, &call.phase))
	}
	for i := range call.values {
		a := outputs[i]
		if a.timezone() {
			parts, ociParts := new([4]sql.NullString), new([4]string)
			call.timezones[i], call.ociTimezones[i] = parts, ociParts
			for component, size := range []int{40, 6, 40, 128} {
				var binding interface{} = go_ora.Out{Dest: &parts[component], Size: size}
				if oci {
					binding = sql.Out{Dest: &ociParts[component]}
				}
				call.arguments = append(call.arguments, binding)
			}
			call.arguments = append(call.arguments, plDebugOutArg(oci, &call.copied[i]))
			continue
		}
		if a.retainedOutput() {
			lob, err := newPLDebugLobOutput(oci, a.Type == "BLOB" || a.Type == "RAW", &call.copied[i], &call.lengths[i])
			if err != nil {
				return nil, err
			}
			lob.nationalLob = a.Type == "NCLOB"
			call.lobs[i] = lob
			call.arguments = append(call.arguments, lob.bind, plDebugOutArg(oci, &call.copied[i]), plDebugOutArg(oci, &call.lengths[i]))
			continue
		}
		var value interface{}
		if oci {
			value = sql.Out{Dest: &call.ociValues[i]}
		} else {
			value = go_ora.Out{Dest: &call.values[i], Size: 32767}
		}
		call.arguments = append(call.arguments, value, plDebugOutArg(oci, &call.copied[i]))
	}
	if p.typedSignature != nil {
		if p.timezoneTypes() {
			var binding interface{} = go_ora.Out{Dest: &call.inputZone, Size: 128}
			if oci {
				binding = sql.Out{Dest: &call.ociInputZone}
			}
			call.arguments = append(call.arguments, binding)
		}
		call.arguments = append(call.arguments, plDebugOutArg(oci, &call.phase))
	}
	return call, nil
}

func (c *plDebugNativeNamedCall) lobOutputs() []*plDebugLobOutput {
	outputs := []*plDebugLobOutput{}
	for i := range c.values {
		if lob := c.lobs[i]; lob != nil {
			outputs = append(outputs, lob)
		}
	}
	return outputs
}

func plDebugNativeNumberMagnitude(text string) (string, error) {
	if text == "0" {
		return "0", nil
	}
	fraction := 0
	if point := strings.IndexByte(text, '.'); point >= 0 {
		fraction = len(text) - point - 1
	}
	digits := strings.TrimLeft(strings.ReplaceAll(text, ".", ""), "0")
	short := strings.TrimRight(digits, "0")
	exponent := len(digits) - len(short) - fraction
	digits = short
	leadingExponent := len(digits) - 1 + exponent
	pairs := len(digits)
	if leadingExponent%2 == 0 {
		pairs++
	}
	if (pairs+1)/2 > 20 {
		return "", errors.New("NUMBER input exceeds the exact 20-base-100-digit transport capacity")
	}
	// v2.9.0 accepts a scientific mantissa without leading zero groups. Its
	// decimal-form encoder emits invalid groups for fractions, and its signed
	// encoder omits some negative terminators. Bind a positive magnitude and
	// apply the sign in the already typed PL/SQL local, before the named call.
	return digits + "e" + strconv.Itoa(exponent), nil
}

func (p *plDebugNativePlan) unread(state string) map[string]interface{} {
	params := []map[string]interface{}{}
	var returned interface{}
	for _, a := range p.outputs() {
		item := plDebugNativeResultField(a, nil, state)
		if a.Position == 0 {
			returned = item
		} else {
			params = append(params, item)
		}
	}
	return map[string]interface{}{"outParams": params, "outParamsState": state, "returnValue": returned}
}

func plDebugNativeResultField(a plDebugNativeArgument, value interface{}, state string) map[string]interface{} {
	result := map[string]interface{}{"type": a.Type, "value": value, "state": state}
	if a.binaryFloat() && (state == "value" || state == "null") {
		result["typedValue"] = map[string]interface{}{"kind": strings.ToLower(a.Type), "value": value}
	}
	if a.Position > 0 {
		result["name"], result["mode"] = *a.Name, a.Mode
	}
	if a.Type == "PL/SQL BOOLEAN" && (state == "value" || state == "null") {
		var typed interface{}
		if value != nil {
			typed = value == "true"
		}
		result["typedValue"] = map[string]interface{}{"kind": "boolean", "value": typed}
	}
	if (a.Type == "DATE" || a.Type == "TIMESTAMP") && (state == "value" || state == "null") {
		kind := "date"
		if a.Type == "TIMESTAMP" {
			kind = "timestamp"
		}
		result["typedValue"] = map[string]interface{}{"kind": kind, "value": value}
	}
	if a.interval() && (state == "value" || state == "null") {
		kind := "interval_year_month"
		if a.Type == "INTERVAL DAY TO SECOND" {
			kind = "interval_day_second"
		}
		result["typedValue"] = map[string]interface{}{"kind": kind, "value": value}
	}
	return result
}

func (c *plDebugNativeNamedCall) result(capture plDebugNativeCapture, executionErr error) map[string]interface{} {
	result := c.plan.unread("unavailable")
	result["executionOutcome"], result["executionStage"] = "unknown", "unknown"
	minimum, maximum := int64(0), int64(2)
	if c.plan.typedSignature != nil {
		minimum, maximum = -1, 3
	}
	if !c.phase.Valid || c.phase.Int64 < minimum || c.phase.Int64 > maximum {
		result["resultError"] = "No verified named-target execution phase was returned"
		return result
	}
	if c.phase.Int64 < 2 {
		stage := "input_preparation"
		if c.phase.Int64 == -1 {
			stage = "argument_initialization"
		}
		if c.phase.Int64 == 1 {
			stage = "calling"
		}
		result["executionStage"] = stage
		if c.phase.Int64 <= 0 {
			result["inputError"] = plDebugNativeString(capture.Message)
		}
		if capture.Code.Valid && capture.Code.Int64 != 0 {
			outcome := "not_started"
			if c.phase.Int64 == 1 {
				outcome = "failed"
			}
			result["executionOutcome"] = outcome
		}
		return result
	}
	result["executionOutcome"], result["executionStage"] = "succeeded", "returned"
	params := []map[string]interface{}{}
	var returned interface{}
	partial := false
	if c.plan.timezoneTypes() {
		zone := c.inputZone
		if c.oci {
			zone = sql.NullString{String: c.ociInputZone, Valid: c.ociInputZone != ""}
		}
		if !zone.Valid || zone.String == "" || len(zone.String) > 128 {
			partial = true
			result["resultError"] = "The input session timezone could not be verified"
		} else {
			result["inputSessionTimeZone"] = zone.String
		}
	}
	for i, a := range c.plan.outputs() {
		if a.timezone() {
			parts := [4]sql.NullString{}
			if saved := c.timezones[i]; saved != nil {
				parts = *saved
			}
			if c.oci {
				if saved := c.ociTimezones[i]; saved != nil {
					for index, value := range saved {
						parts[index] = sql.NullString{String: value, Valid: value != ""}
					}
				}
			}
			item, err := plDebugNativeTimezoneResult(a, parts, c.copied[i].Valid && c.copied[i].Int64 == 1, executionErr == nil)
			if err != nil {
				partial = true
				item = plDebugNativeResultField(a, nil, "error")
				item["error"] = "The returned timezone components could not be verified"
			}
			if a.Position == 0 {
				returned = item
			} else {
				params = append(params, item)
			}
			continue
		}
		if lob := c.lobs[i]; lob != nil {
			var value interface{}
			if lob.reference == nil {
				value = lob.value()
			}
			item := plDebugNativeResultField(a, value, lob.state)
			if lob.reference != nil {
				item["value"] = nil
				item["resultRef"] = plDebugCopyResultMap(lob.reference)
				if lob.state == "value" && lob.reference["length"] == 0 {
					item["state"] = "empty"
				}
			}
			if lob.state != "null" && lob.state != "value" {
				partial = true
				item["error"] = "This returned result field could not be verified"
			}
			kind := "clob"
			if lob.binary {
				kind = "blob"
			}
			if a.Type == "RAW" {
				kind = "raw"
			}
			if a.composite() || a.national() || a.Type == "NCLOB" || a.Type == "CHAR" {
				item["typedValue"] = map[string]interface{}{"kind": "composite", "format": "json"}
			}
			if a.Type == "NCLOB" {
				if source := lob.nationalSource; source != nil {
					item["state"], item["sourceLength"], item["retainedLength"], item["lengthUnit"] = source.State, source.SourceLength, source.RetainedLength, source.LengthUnit
				} else {
					item["state"], item["error"] = "error", "The national LOB source summary could not be verified"
					partial = true
				}
			}
			if !a.composite() && !a.national() && a.Type != "NCLOB" && a.Type != "CHAR" && lob.reference == nil && (lob.state == "value" || lob.state == "null") {
				item["typedValue"] = map[string]interface{}{"kind": kind, "value": lob.value()}
			}
			if a.Position == 0 {
				returned = item
			} else {
				params = append(params, item)
			}
			continue
		}
		fieldValue := c.values[i]
		if c.oci {
			fieldValue = sql.NullString{String: c.ociValues[i], Valid: c.ociValues[i] != ""}
		}
		state := "error"
		var value interface{}
		if c.copied[i].Valid && c.copied[i].Int64 == 1 {
			if fieldValue.Valid && fieldValue.String != "" {
				state = "value"
				value = fieldValue.String
				if a.binaryFloat() {
					normalized, err := plDebugNativeBinaryFloatHex(fieldValue.String, a.Type == "BINARY_DOUBLE")
					if err != nil {
						state, value = "error", nil
					} else {
						value = normalized
					}
				}
				if a.decimalCarrier() {
					normalized, err := plDebugNativeDecimal(fieldValue.String)
					if err != nil {
						state = "error"
						value = nil
					} else {
						value = normalized
					}
				}
				if a.Type == "PL/SQL BOOLEAN" && fieldValue.String != "true" && fieldValue.String != "false" {
					state, value = "error", nil
				}
				if a.Type == "DATE" || a.Type == "TIMESTAMP" {
					if _, err := plDebugNativeTemporal(fieldValue.String, a.Type == "TIMESTAMP"); err != nil {
						state, value = "error", nil
					}
				}
			} else if executionErr == nil {
				state = "null"
			}
		}
		item := plDebugNativeResultField(a, value, state)
		if state == "error" {
			partial = true
			item["error"] = "This returned result field could not be verified"
		}
		if a.Position == 0 {
			returned = item
		} else {
			params = append(params, item)
		}
	}
	result["outParams"], result["returnValue"], result["outParamsState"] = params, returned, "available"
	if partial {
		result["outParamsState"], result["resultError"] = "partial", "Some returned result fields could not be verified"
	}
	if executionErr != nil {
		result["resultError"] = "The target returned, but its result or output transfer failed"
	}
	return result
}
