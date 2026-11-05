package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const plDebugTimestampTZ = "TIMESTAMP WITH TIME ZONE"
const plDebugTimestampLTZ = "TIMESTAMP WITH LOCAL TIME ZONE"

type plDebugNativeTimezoneInput struct {
	wall   plDebugNativeTemporalInput
	offset string
	region *string
	bytes  int
}

func (a plDebugNativeArgument) timezone() bool {
	name := plDebugNativeScalarTypeName(a.Type)
	return a.scalar() && (name == plDebugTimestampTZ || name == plDebugTimestampLTZ)
}

var plDebugTimezoneOffsetText = regexp.MustCompile(`^[+-][0-9]{2}:[0-9]{2}$`)

func plDebugNativeTimezoneOffset(text string) (string, error) {
	invalid := errors.New("timezone offset requires a minute offset from -12:59 through +14:00")
	if !plDebugTimezoneOffsetText.MatchString(text) {
		return "", invalid
	}
	hour, _ := strconv.Atoi(text[1:3])
	minute, _ := strconv.Atoi(text[4:6])
	if minute > 59 {
		return "", invalid
	}
	total := hour*60 + minute
	if text[0] == '-' {
		total = -total
	}
	if total < -779 || total > 840 {
		return "", invalid
	}
	sign := "+"
	if total < 0 {
		sign = "-"
		total = -total
	}
	return fmt.Sprintf("%s%02d:%02d", sign, total/60, total%60), nil
}

func plDebugDecodeTimezoneInput(raw json.RawMessage, ltz bool, remaining int) (plDebugNativeTimezoneInput, error) {
	invalid := errors.New("timezone input requires its exact structured text components")
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return plDebugNativeTimezoneInput{}, invalid
	}
	text := func(name string) (string, error) {
		var value string
		field, ok := fields[name]
		if !ok || bytes.Equal(bytes.TrimSpace(field), []byte("null")) {
			return "", invalid
		}
		if err := json.Unmarshal(field, &value); err != nil || !utf8.ValidString(value) {
			return "", invalid
		}
		return value, nil
	}
	result := plDebugNativeTimezoneInput{}
	var local string
	if ltz {
		if len(fields) != 1 {
			return result, invalid
		}
		instant, err := text("instant")
		if err != nil || !strings.HasSuffix(instant, "Z") {
			return result, invalid
		}
		local = strings.TrimSuffix(instant, "Z")
		result.bytes = len(instant)
	} else {
		if len(fields) < 2 || len(fields) > 3 {
			return result, invalid
		}
		for key := range fields {
			if key != "local" && key != "offset" && key != "region" {
				return result, invalid
			}
		}
		var err error
		local, err = text("local")
		if err != nil {
			return result, err
		}
		offset, err := text("offset")
		if err != nil {
			return result, err
		}
		result.offset, err = plDebugNativeTimezoneOffset(offset)
		if err != nil {
			return result, err
		}
		result.bytes = len(local) + len(offset)
		if region, ok := fields["region"]; ok && !bytes.Equal(bytes.TrimSpace(region), []byte("null")) {
			value, err := text("region")
			if err != nil || value == "" || len(value) > 128 {
				return result, invalid
			}
			result.region = &value
			result.bytes += len(value)
		}
	}
	if result.bytes > remaining {
		return result, errors.New("timezone input byte budget exceeded")
	}
	var err error
	result.wall, err = plDebugNativeTemporalComponents(local, true)
	if err != nil {
		return plDebugNativeTimezoneInput{}, err
	}
	return result, nil
}

func plDebugNativeScalarTypeName(name string) string {
	switch name {
	case "TIMESTAMP WITH TZ":
		return "TIMESTAMP WITH TIME ZONE"
	case "TIMESTAMP WITH LOCAL TZ":
		return "TIMESTAMP WITH LOCAL TIME ZONE"
	default:
		return name
	}
}

func plDebugNativeConstructorScalarType(row plDebugNativeMetadataRow) string {
	name := row.text("ATTR_TYPE_NAME")
	if row["ATTR_TYPE_OWNER"] == nil && row["ATTR_TYPE_PACKAGE"] == nil {
		return plDebugNativeScalarTypeName(name)
	}
	return name
}

func plDebugNativeTimezoneDeclarations(prefix string) string {
	return plDebugNativeTimezoneTypeDeclarations(prefix) + strings.ReplaceAll(`FUNCTION @P@TIME_TEXT(V @P@TS9) RETURN VARCHAR2 IS BEGIN
 IF V IS NULL THEN RETURN NULL; END IF;
 RETURN CASE WHEN EXTRACT(YEAR FROM V)>9999 THEN '+'||TO_CHAR(EXTRACT(YEAR FROM V),'FM9999990','NLS_NUMERIC_CHARACTERS=''.,''') ELSE TO_CHAR(EXTRACT(YEAR FROM V),'FM0000','NLS_NUMERIC_CHARACTERS=''.,''') END
 ||'-'||TO_CHAR(EXTRACT(MONTH FROM V),'FM00','NLS_NUMERIC_CHARACTERS=''.,''')||'-'||TO_CHAR(EXTRACT(DAY FROM V),'FM00','NLS_NUMERIC_CHARACTERS=''.,''')
 ||'T'||TO_CHAR(EXTRACT(HOUR FROM V),'FM00','NLS_NUMERIC_CHARACTERS=''.,''')||':'||TO_CHAR(EXTRACT(MINUTE FROM V),'FM00','NLS_NUMERIC_CHARACTERS=''.,''')
 ||':'||TO_CHAR(EXTRACT(SECOND FROM V),'FM00.000000000','NLS_NUMERIC_CHARACTERS=''.,''');
END;
PROCEDURE @P@TZ_INPUT(W @P@TS9,O VARCHAR2,R VARCHAR2,V OUT @P@TZ9) IS Z @P@TZ9; ACTUAL_W @P@TS9; ACTUAL_R VARCHAR2(128); BEGIN
 IF W IS NULL THEN V:=NULL; RETURN; END IF;
 Z:=FROM_TZ(W,O);
 IF R IS NOT NULL THEN SELECT Z AT TIME ZONE (R) INTO Z FROM SYS.DUAL; END IF;
 SELECT CAST(Z AS TIMESTAMP(9)) INTO ACTUAL_W FROM SYS.DUAL;
 ACTUAL_R:=EXTRACT(TIMEZONE_REGION FROM Z);
 IF Z IS NULL OR ACTUAL_W IS NULL OR ACTUAL_W<>W OR TO_CHAR(Z,'TZH:TZM') IS NULL OR TO_CHAR(Z,'TZH:TZM')<>O
 OR (R IS NOT NULL AND (ACTUAL_R IS NULL OR ACTUAL_R='UNKNOWN')) THEN RAISE_APPLICATION_ERROR(-20992,'timezone input component mismatch'); END IF;
 V:=Z;
END;
PROCEDURE @P@LTZ_INPUT(W @P@TS9,V OUT @P@LTZ9) IS Z @P@TZ9; BEGIN
 IF W IS NULL THEN V:=NULL; RETURN; END IF;
 Z:=FROM_TZ(W,'+00:00');
 SELECT CAST(Z AS TIMESTAMP(9) WITH LOCAL TIME ZONE) INTO V FROM SYS.DUAL;
 IF V IS NULL THEN RAISE_APPLICATION_ERROR(-20992,'LTZ input conversion returned NULL'); END IF;
END;
PROCEDURE @P@TZ_PARTS(V @P@TZ9,L OUT VARCHAR2,O OUT VARCHAR2,I OUT VARCHAR2,C OUT VARCHAR2) IS W @P@TS9; U @P@TS9; BEGIN
 L:=NULL; O:=NULL; I:=NULL; C:=NULL;
 IF V IS NULL THEN RETURN; END IF;
 SELECT CAST(V AS TIMESTAMP(9)),SYS_EXTRACT_UTC(V) INTO W,U FROM SYS.DUAL;
 L:=@P@TIME_TEXT(W); I:=@P@TIME_TEXT(U); O:=TO_CHAR(V,'TZH:TZM'); C:=EXTRACT(TIMEZONE_REGION FROM V);
 IF L IS NULL OR I IS NULL OR O IS NULL OR C IS NULL THEN RAISE_APPLICATION_ERROR(-20992,'incomplete TZ output components'); END IF;
END;
PROCEDURE @P@LTZ_PARTS(V @P@LTZ9,L OUT VARCHAR2,O OUT VARCHAR2,I OUT VARCHAR2,C OUT VARCHAR2) IS
 W @P@TS9; U @P@TS9; WD NUMBER; UD NUMBER; SECONDS_OFFSET NUMBER; MINUTES_OFFSET INTEGER; DAY_OFFSET INTEGER; BEGIN
 L:=NULL; O:=NULL; I:=NULL; C:=SESSIONTIMEZONE;
 IF C IS NULL THEN RAISE_APPLICATION_ERROR(-20992,'LTZ session timezone unavailable'); END IF;
 IF V IS NULL THEN RETURN; END IF;
 SELECT CAST(V AS TIMESTAMP(9)),SYS_EXTRACT_UTC(V) INTO W,U FROM SYS.DUAL;
 IF W IS NULL OR U IS NULL OR EXTRACT(SECOND FROM W)-TRUNC(EXTRACT(SECOND FROM W))<>EXTRACT(SECOND FROM U)-TRUNC(EXTRACT(SECOND FROM U)) THEN RAISE_APPLICATION_ERROR(-20992,'inconsistent LTZ temporal components'); END IF;
 WD:=EXTRACT(YEAR FROM W)*10000+EXTRACT(MONTH FROM W)*100+EXTRACT(DAY FROM W);
 UD:=EXTRACT(YEAR FROM U)*10000+EXTRACT(MONTH FROM U)*100+EXTRACT(DAY FROM U);
 DAY_OFFSET:=CASE WHEN WD=UD THEN 0 WHEN WD>UD THEN 1 ELSE -1 END;
 SECONDS_OFFSET:=(EXTRACT(HOUR FROM W)-EXTRACT(HOUR FROM U))*3600+(EXTRACT(MINUTE FROM W)-EXTRACT(MINUTE FROM U))*60+EXTRACT(SECOND FROM W)-EXTRACT(SECOND FROM U)+DAY_OFFSET*86400;
 IF MOD(SECONDS_OFFSET,60)<>0 OR SECONDS_OFFSET < -46740 OR SECONDS_OFFSET>50400 THEN RAISE_APPLICATION_ERROR(-20992,'LTZ offset outside exact minute range'); END IF;
 MINUTES_OFFSET:=ABS(SECONDS_OFFSET)/60;
 O:=CASE WHEN SECONDS_OFFSET<0 THEN '-' ELSE '+' END||TO_CHAR(TRUNC(MINUTES_OFFSET/60),'FM00','NLS_NUMERIC_CHARACTERS=''.,''')||':'||TO_CHAR(MOD(MINUTES_OFFSET,60),'FM00','NLS_NUMERIC_CHARACTERS=''.,''');
 L:=@P@TIME_TEXT(W); I:=@P@TIME_TEXT(U);
 IF L IS NULL OR I IS NULL THEN RAISE_APPLICATION_ERROR(-20992,'incomplete LTZ output components'); END IF;
END;
`, "@P@", prefix)
}

func plDebugNativeTimezoneTypeDeclarations(prefix string) string {
	return "SUBTYPE " + prefix + "TS9 IS TIMESTAMP(9);\nSUBTYPE " + prefix + "TZ9 IS TIMESTAMP(9) WITH TIME ZONE;\nSUBTYPE " + prefix + "LTZ9 IS TIMESTAMP(9) WITH LOCAL TIME ZONE;\n"
}

func (builder *plDebugCollectionInitializer) timezone(input plDebugNativeInput, variable string) {
	value := plDebugNativeTimezoneInput{}
	if input.value != nil {
		value = input.value.(plDebugNativeTimezoneInput)
	}
	wall := builder.local("TIMESTAMP(9)")
	binding := plDebugNativeInput{argument: plDebugNativeArgument{Mode: "IN", Type: "TIMESTAMP"}, state: input.state}
	if input.value != nil {
		binding.value = value.wall
	}
	builder.operations = append(builder.operations, plDebugCollectionOperation{variable: wall, input: &binding})
	prefix := builder.timezonePrefix
	if prefix == "" {
		prefix = builder.prefix
	}
	if plDebugNativeScalarTypeName(input.argument.Type) == plDebugTimestampLTZ {
		builder.statement(prefix + "LTZ_INPUT(" + wall + "," + variable + ");")
		return
	}
	arguments := []string{wall}
	var offset *string
	if input.value != nil {
		offset = &value.offset
	}
	for _, component := range []*string{offset, value.region} {
		local := builder.local("VARCHAR2(128)")
		part := plDebugNativeInput{argument: plDebugNativeArgument{Mode: "IN", Type: "VARCHAR2"}, state: "null"}
		if component != nil {
			part.state = "value"
			part.value = *component
		}
		builder.operations = append(builder.operations, plDebugCollectionOperation{variable: local, input: &part})
		arguments = append(arguments, local)
	}
	arguments = append(arguments, variable)
	builder.statement(prefix + "TZ_INPUT(" + strings.Join(arguments, ",") + ");")
}

func (p *plDebugNativePlan) timezoneTypes() bool {
	for _, argument := range p.target.Arguments {
		if argument.timezone() {
			return true
		}
	}
	if p.typedSignature == nil {
		return false
	}
	for _, node := range p.typedSignature.TypeGraph.Nodes {
		for _, rows := range []struct {
			rows   []plDebugNativeMetadataRow
			prefix string
		}{{node.Attributes, "ATTR_TYPE_"}, {node.Collections, "ELEM_TYPE_"}} {
			for _, row := range rows.rows {
				if row[rows.prefix+"OWNER"] == nil && row[rows.prefix+"PACKAGE"] == nil {
					kind := plDebugNativeScalarTypeName(row.text(rows.prefix + "NAME"))
					if kind == plDebugTimestampTZ || kind == plDebugTimestampLTZ {
						return true
					}
				}
			}
		}
	}
	return false
}

var plDebugTimezoneOutputText = regexp.MustCompile(`^(0000|[0-9]{4}|\+10000)-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{9})$`)

func plDebugNativeTimezoneOutputText(text string) bool {
	parts := plDebugTimezoneOutputText.FindStringSubmatch(text)
	if parts == nil {
		return false
	}
	year, _ := strconv.Atoi(parts[1])
	month, _ := strconv.Atoi(parts[2])
	day, _ := strconv.Atoi(parts[3])
	hour, _ := strconv.Atoi(parts[4])
	minute, _ := strconv.Atoi(parts[5])
	second, _ := strconv.Atoi(parts[6])
	if month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 {
		return false
	}
	days := []int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
		days[1] = 29
	}
	return day <= days[month-1]
}

func plDebugNativeTimezoneResult(argument plDebugNativeArgument, parts [4]sql.NullString, copied, executionComplete bool) (map[string]interface{}, error) {
	invalid := errors.New("incomplete or invalid timezone output components")
	if !copied {
		return nil, invalid
	}
	ltz := plDebugNativeScalarTypeName(argument.Type) == plDebugTimestampLTZ
	present := func(index int) bool { return parts[index].Valid && parts[index].String != "" }
	context := parts[3].String
	if ltz && (!present(3) || len(context) > 128 || !utf8.ValidString(context)) {
		return nil, invalid
	}
	kind := "timestamp_tz"
	if ltz {
		kind = "timestamp_ltz"
	}
	if !present(0) && !present(1) && !present(2) && (!present(3) || ltz) {
		if !executionComplete {
			return nil, invalid
		}
		result := plDebugNativeResultField(argument, nil, "null")
		result["typedValue"] = map[string]interface{}{"kind": kind, "value": nil}
		if ltz {
			result["sessionTimeZone"] = context
		}
		return result, nil
	}
	for index := range parts {
		if !present(index) {
			return nil, invalid
		}
	}
	local, offset, instant := parts[0].String, parts[1].String, parts[2].String
	if !plDebugNativeTimezoneOutputText(local) || !plDebugNativeTimezoneOutputText(instant) || local[len(local)-9:] != instant[len(instant)-9:] || len(context) > 128 || !utf8.ValidString(context) {
		return nil, invalid
	}
	canonical, err := plDebugNativeTimezoneOffset(offset)
	if err != nil || canonical != offset {
		return nil, invalid
	}
	value := map[string]interface{}{"local": local, "offset": offset, "instant": instant + "Z"}
	display := local + offset
	if ltz {
		value["sessionTimeZone"] = context
	} else if context == "UNKNOWN" {
		value["region"], value["regionState"] = nil, "not_returned"
	} else {
		value["region"], value["regionState"] = context, "value"
		display += "[" + context + "]"
	}
	result := plDebugNativeResultField(argument, display, "value")
	result["typedValue"] = map[string]interface{}{"kind": kind, "value": value}
	return result, nil
}

func (encoder plDebugCompositeEncoder) timezoneDeclarations() string {
	p := encoder.prefix
	quote := func(expression string) string {
		return "IF NOT " + p + "Q(" + expression + ") THEN RAISE_APPLICATION_ERROR(-20996,'timezone JSON budget'); END IF;\n"
	}
	result := ""
	for _, ltz := range []bool{false, true} {
		name, kind, formal, parts := "TZ_VALUE", "timestamp_tz", p+"TZ9", "TZ_PARTS"
		if ltz {
			name, kind, formal, parts = "LTZ_VALUE", "timestamp_ltz", p+"LTZ9", "LTZ_PARTS"
		}
		result += "PROCEDURE " + p + name + "(V IN " + formal + ") IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(" + p + "JSON); B0 INTEGER:=" + encoder.budget + "; L1 VARCHAR2(40); O1 VARCHAR2(6); I1 VARCHAR2(40); C1 VARCHAR2(128); BEGIN\n " + p + "GUARD; " + p + parts + "(V,L1,O1,I1,C1);\n IF V IS NULL THEN " + p + "APP('{\"kind\":\"" + kind + "\",\"state\":\"null\",\"value\":null');\n"
		if ltz {
			result += p + "APP(',\"sessionTimeZone\":'); " + quote("C1")
		}
		result += p + "CLOSE_J('}'); RETURN; END IF;\n " + p + "APP('{\"kind\":\"" + kind + "\",\"state\":\"value\",\"value\":{\"local\":'); " + quote("L1") + p + "APP(',\"offset\":'); " + quote("O1") + p + "APP(',\"instant\":'); " + quote("I1||'Z'")
		if ltz {
			result += p + "APP(',\"sessionTimeZone\":'); " + quote("C1")
		} else {
			result += "IF C1='UNKNOWN' THEN " + p + "APP(',\"region\":null,\"regionState\":\"not_returned\"'); ELSE " + p + "APP(',\"region\":'); " + quote("C1") + p + "APP(',\"regionState\":\"value\"'); END IF;\n"
		}
		result += p + "CLOSE_J('}}');\nEXCEPTION WHEN OTHERS THEN " + p + "FAIL(SQLCODE,L0,B0); END;\n"
	}
	return result
}
