package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugParam;
import com.dbx.agent.PlDebugStartRequest;
import com.google.gson.Gson;
import com.google.gson.JsonElement;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.util.Collections;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.concurrent.TimeUnit;

/** Exact dictionary signatures and typed invocation of a named debug target. */
final class PlDebugTarget {
    private static final Gson JSON = new Gson();
    private static final DateTimeFormatter DATE_TEXT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss", Locale.ROOT).withResolverStyle(ResolverStyle.STRICT);
    private static final DateTimeFormatter TIMESTAMP_TEXT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSSSSSSS", Locale.ROOT).withResolverStyle(ResolverStyle.STRICT);
    private static final String TZ = "TIMESTAMP WITH TIME ZONE";
    private static final String LTZ = "TIMESTAMP WITH LOCAL TIME ZONE";

    record Argument(String name, int position, int sequence, int level, String mode, String type,
                    String typeOwner, String typeName, String typeSubname, String defaulted) {
        boolean input() { return !"OUT".equals(mode); }
        boolean output() { return !"IN".equals(mode); }
        boolean scalar() { return level == 0 && typeOwner == null && typeName == null && typeSubname == null; }
        boolean adapted() { return scalar() && ("NUMBER".equals(type) || "VARCHAR2".equals(type)); }
        boolean typedAdapted() { return adapted() || scalar() && (Set.of("INT", "BINARY_INTEGER", "PL/SQL BOOLEAN", "CHAR", "NCHAR", "NVARCHAR2", "DATE", "TIMESTAMP", TZ, LTZ, "CLOB", "BLOB", "RAW", "BINARY_FLOAT", "BINARY_DOUBLE").contains(type)||intervalKind(type)!=null); }

        Map<String, Object> snapshot() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("name", name);
            result.put("position", position);
            result.put("sequence", sequence);
            result.put("dataLevel", level);
            result.put("mode", mode);
            result.put("type", type);
            result.put("typeOwner", typeOwner);
            result.put("typeName", typeName);
            result.put("typeSubname", typeSubname);
            result.put("defaulted", defaulted);
            return result;
        }
    }

    record Candidate(String owner, String name, String packageName, String objectId, int subprogramId,
                     String status, List<Argument> rows) {
        List<Argument> parameters() { return rows.stream().filter(a -> a.level() == 0 && a.position() > 0).toList(); }
        Argument returns() { return rows.stream().filter(a -> a.level() == 0 && a.position() == 0).findFirst().orElse(null); }
        String objectType() { return returns() == null ? "PROCEDURE" : "FUNCTION"; }
        String routine() { return quote(owner) + "." + (packageName == null ? "" : quote(packageName) + ".") + quote(name); }
        String program() { return packageName == null ? name : packageName + "." + name; }

        Map<String, Object> signature() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("schema", owner);
            result.put("objectName", name);
            result.put("packageName", packageName);
            result.put("objectType", objectType());
            result.put("objectId", objectId);
            result.put("subprogramId", subprogramId);
            result.put("status", status);
            result.put("arguments", rows.stream().map(Argument::snapshot).toList());
            return result;
        }

        Map<String, Object> preview() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("signature", signature());
            result.put("parameters", parameters().stream().map(Argument::snapshot).toList());
            result.put("returnValue", returns() == null ? null : returns().snapshot());
            boolean adapted = rows.stream().allMatch(Argument::adapted);
            result.put("parameterTransport", adapted ? "implemented" : "not_implemented");
            if (!adapted) result.put("message", "Some declared parameter types do not yet have a debugger transport adapter");
            return result;
        }
    }

    record Input(Argument argument, String state, Object value) {}
    record TypeBinding(int sequence, PlDebugTypeGraph.Ref reference) {}
    record ZonedInput(BigDecimal localSeconds, String offset, String region) {}

    static String builtinType(Map<String,String> row,String prefix) {
        String name=row.get(prefix+"NAME");
        if(row.get(prefix+"OWNER")!=null||row.get(prefix+"PACKAGE")!=null||name==null)return name;
        if(name.matches("TIMESTAMP\\([0-9]\\)( WITH( LOCAL)? TIME ZONE)?"))return name.replaceFirst("\\([0-9]\\)","");
        if(intervalKind(name)!=null)return intervalKind(name);
        return name;
    }
    static final int MAX_INPUT_BYTES = 8 * 1024 * 1024;
    record LobInput(String text, byte[] bytes, int encodedBytes) {
        boolean empty() { return text != null ? text.isEmpty() : bytes.length == 0; }
    }

    static boolean requiresTypedLobConnection(PlDebugStartRequest request) {
        if (request.getTargetSignature() == null) return false;
        var signature = JSON.toJsonTree(request.getTargetSignature()).getAsJsonObject();
        var version = signature.get("signatureVersion");
        if (version == null || !version.isJsonPrimitive() || !version.getAsJsonPrimitive().isNumber()
            || new BigDecimal(version.getAsString()).compareTo(BigDecimal.valueOf(2)) != 0) return false;
        if (lobRows(signature.get("arguments"), "type")) return true;
        boolean compositeOutput=false;
        var arguments=signature.get("arguments");
        if(arguments!=null&&arguments.isJsonArray())for(var raw:arguments.getAsJsonArray()) {
            if(!raw.isJsonObject())continue;
            var row=raw.getAsJsonObject();
            if(row.has("mode")&&"IN".equals(row.get("mode").getAsString()))continue;
            if(row.has("type")&&Set.of("NCHAR","NVARCHAR2").contains(row.get("type").getAsString()))return true;
            if(row.has("typeOwner")&&!row.get("typeOwner").isJsonNull())compositeOutput=true;
        }
        var graph = signature.get("typeGraph");
        if (graph == null || !graph.isJsonObject()) return false;
        var nodes = graph.getAsJsonObject().get("nodes");
        if (nodes == null || !nodes.isJsonArray()) return false;
        for (var node : nodes.getAsJsonArray()) {
            if (node.isJsonObject() && (lobRows(node.getAsJsonObject().get("attributes"), "ATTR_TYPE_NAME")
                || lobRows(node.getAsJsonObject().get("collections"), "ELEM_TYPE_NAME"))) return true;
            if(compositeOutput&&node.isJsonObject()&&(nationalRows(node.getAsJsonObject().get("attributes"),"ATTR_TYPE_NAME")||nationalRows(node.getAsJsonObject().get("collections"),"ELEM_TYPE_NAME")))return true;
        }
        var frozenGraph=JSON.fromJson(graph,PlDebugTypeGraph.Graph.class);
        int[] visited={0};
        for(var parameter:request.getParams())if(!"OUT".equals(mode(parameter.getMode()))&&constructorLobProfile(frozenGraph,parameter.getTypedValue(),0,visited))return true;
        return false;
    }

    private static boolean constructorLobProfile(PlDebugTypeGraph.Graph graph,JsonElement payload,int depth,int[] visited) {
        if(payload==null||payload.isJsonNull())return false;
        if(depth>16||++visited[0]>8192)throw new IllegalArgumentException("Composite input profile budget exceeded");
        if(!payload.isJsonObject())return false;
        var typed=payload.getAsJsonObject();
        String kind=jsonText(typed,"kind");
        if(!Set.of("record","collection","object").contains(kind))return false;
        var value=typed.get("value");
        if(value==null)throw new IllegalArgumentException("Incomplete composite input profile");
        if(value.isJsonNull())return false;
        JsonElement children=value;
        if("object".equals(kind)) {
            if(!value.isJsonObject())throw new IllegalArgumentException("Incomplete constructor input profile");
            var object=value.getAsJsonObject();var ref=JSON.fromJson(object.get("type"),PlDebugTypeGraph.Ref.class);
            var matches=graph.nodes().stream().filter(node->node.reference().equals(ref)).toList();
            if(matches.size()!=1||matches.getFirst().constructorCalls()==null||!"resolved".equals(matches.getFirst().constructorCalls().state()))throw new IllegalArgumentException("Constructor profile identity is unresolved; refresh its preview");
            String id=jsonText(object,"constructorId");var constructors=matches.getFirst().constructorCalls().constructors().stream().filter(call->call.id().equals(id)).toList();
            if(constructors.size()!=1)throw new IllegalArgumentException("Constructor profile identity is unresolved; refresh its preview");
            if(constructors.getFirst().parameters().stream().anyMatch(formal->formal.type().get("ATTR_TYPE_OWNER")==null&&formal.type().get("ATTR_TYPE_PACKAGE")==null&&Set.of("CLOB","BLOB").contains(formal.type().get("ATTR_TYPE_NAME"))))return true;
            children=object.get("arguments");
        }
        if(children==null||!children.isJsonArray())throw new IllegalArgumentException("Incomplete composite input profile");
        for(var item:children.getAsJsonArray()) {
            if(!item.isJsonObject())throw new IllegalArgumentException("Incomplete composite input profile");
            var child=item.getAsJsonObject();
            if(child.has("value")&&constructorLobProfile(graph,child.get("value"),depth+1,visited))return true;
        }
        return false;
    }

    private static boolean nationalRows(JsonElement rows,String key) {
        if(rows==null||!rows.isJsonArray())return false;
        for(var row:rows.getAsJsonArray())if(row.isJsonObject()) {
            var type=row.getAsJsonObject().get(key);
            if(type!=null&&type.isJsonPrimitive()&&type.getAsJsonPrimitive().isString()&&Set.of("NCHAR","NVARCHAR2").contains(type.getAsString()))return true;
        }
        return false;
    }

    private static boolean lobRows(JsonElement rows, String key) {
        if (rows == null || !rows.isJsonArray()) return false;
        for (var row : rows.getAsJsonArray()) {
            if (!row.isJsonObject()) continue;
            var type = row.getAsJsonObject().get(key);
            if (type != null && type.isJsonPrimitive() && type.getAsJsonPrimitive().isString()
                && Set.of("CLOB", "BLOB").contains(type.getAsString())) return true;
        }
        return false;
    }
    record Results(List<Map<String, Object>> outParams, Map<String, Object> returnValue, String state, String error, String inputSessionTimeZone) {}
    record Slots(int inputs, int outputs, boolean context, boolean inputLobs, List<Integer> outputIndices) {
        int phase() { return inputs + outputs + (context ? 1 : 0) + (inputLobs ? 1 : 0) + 1; }
        int capture() { return phase() + 1 + outputIndices.size(); }
        int contextIndex() { return inputs + outputs + 1; }
        int inputCleanupIndex() { return inputs + outputs + (context ? 1 : 0) + 1; }
    }

    record Plan(Candidate target, List<Input> arguments, PlDebugTypeGraph.Graph graph, Map<Integer, PlDebugTypeGraph.Ref> typeBindings) {
        Plan(Candidate target, List<Input> arguments) { this(target, arguments, null, Map.of()); }
        Plan {
            typeBindings = Map.copyOf(typeBindings);
            if (!typeBindings.isEmpty()) {
                Objects.requireNonNull(graph);
                new PlDebugCompositeOutput(graph, "DBX_VALIDATE_", "DBX_LEFT",outputTypes(target,typeBindings));
                for (Argument argument : target.rows()) if (!argument.scalar()) {
                    PlDebugTypeGraph.Ref ref = typeBindings.get(argument.sequence());
                    if (ref == null || graph.nodes().stream().noneMatch(node -> node.reference().equals(ref))) throw new IllegalArgumentException("Incomplete composite formal type binding");
                    if(argument.input())PlDebugCompositeInput.requireInputAdapter(graph,ref);
                }
                int nodes = 0, physical = 0, slots = 0, sqlBytes = 0;
                for (Input input : arguments) if (typeBindings.containsKey(input.argument().sequence()) && input.argument().input() && !"default".equals(input.state())) {
                    if (!(input.value() instanceof PlDebugCompositeInput.Prepared prepared)) throw new IllegalArgumentException("No verified composite input was prepared");
                    nodes += prepared.nodes(); physical += prepared.physicalElements();
                    var code = PlDebugCompositeInput.render(graph, typeBindings.get(input.argument().sequence()), prepared, "DBX_COUNT_", "DBX_VALUE", "DBX_CHECK");
                    slots += code.slots(); sqlBytes += (code.declarations()+code.preflight()+code.assignments()).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                    if (nodes > 8192 || physical > 8192 || slots > 16384 || sqlBytes > 1_048_576) throw new IllegalArgumentException("Cumulative composite input generation budget exceeded");
                }
            }
        }
        boolean composite(Argument argument) { return typeBindings.containsKey(argument.sequence()); }
        boolean jsonEncoded(Argument argument) { return composite(argument)||national(argument); }
        boolean initializesTypes() { return !typeBindings.isEmpty()||target.rows().stream().anyMatch(PlDebugTarget::national)||inputs().stream().anyMatch(input -> integer(input.argument())||binaryFloat(input.argument())||intervalKind(input.argument().type())!=null); }
        private static List<PlDebugTypeGraph.Ref> outputTypes(Candidate target,Map<Integer,PlDebugTypeGraph.Ref> bindings) {
            return target.rows().stream().filter(Argument::output).map(argument->bindings.get(argument.sequence())).filter(Objects::nonNull).toList();
        }
        PlDebugCompositeInput.Code inputCode(Input input, String prefix) {
            if(national(input.argument()))return PlDebugCompositeInput.nationalCode((String)input.value(),prefix+input.argument().sequence()+"_",local(prefix,input.argument()));
            return PlDebugCompositeInput.render(graph,typeBindings.get(input.argument().sequence()),(PlDebugCompositeInput.Prepared)input.value(),prefix+input.argument().sequence()+"_",local(prefix,input.argument()),prefix+"CHECK_NLS");
        }
        List<Input> supplied() { return arguments.stream().filter(a -> !"default".equals(a.state())).toList(); }
        List<Input> inputs() { return supplied().stream().filter(a -> a.argument().input()).toList(); }
        List<Argument> outputs() {
            List<Argument> result = new ArrayList<>(arguments.stream().map(Input::argument).filter(Argument::output).toList());
            if (target.returns() != null) result.add(target.returns());
            return List.copyOf(result);
        }
        Slots slots() {
            int inputs=0;boolean inputLobs=false;
            for(var input:inputs()) {
                if(jsonEncoded(input.argument())) {var code=inputCode(input,"DBX_COUNT_");inputs+=code.slots();inputLobs|=!code.ownedInputLobs().isEmpty();}
                else {inputs+=TZ.equals(input.argument().type())?3:lob(input.argument())?2:1;inputLobs|=lob(input.argument());}
            }
            int index = inputs + 1;
            List<Integer> offsets = new ArrayList<>();
            for (Argument output : outputs()) { offsets.add(index); index += zoned(output) ? 3 : 1; }
            boolean context=target.rows().stream().anyMatch(a -> LTZ.equals(a.type()))||inputs().stream().anyMatch(input->input.value() instanceof PlDebugCompositeInput.Prepared prepared&&PlDebugCompositeInput.localTimeZone(prepared));
            return new Slots(inputs, index - inputs - 1, context, inputLobs, List.copyOf(offsets));
        }
        int phaseIndex() { return slots().phase(); }
        int captureIndex() { return slots().capture(); }
        Map<String, Object> pendingReturn() { return target.returns() == null ? null : result(target.returns(), null, "pending"); }

        PlDebugOutput.Block block() {
            var block=PlDebugOutput.wrap(target.routine(), this::render);
            if(captureIndex()+4>16384||block.sql().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>1_048_576)throw new IllegalArgumentException("Named target SQL or bind budget exceeded");
            return block;
        }

        private PlDebugOutput.Body render(String prefix) {
            String phase = prefix + "PHASE";
            Set<String> privateNames = new HashSet<>(Set.of(phase));
            StringBuilder declarations = new StringBuilder("  " + phase + " INTEGER := 0;\n");
            StringBuilder nestedDeclarations = new StringBuilder();
            PlDebugCompositeOutput encoder = typeBindings.isEmpty() && outputs().stream().noneMatch(PlDebugTarget::national) ? null : new PlDebugCompositeOutput(graph==null?new PlDebugTypeGraph.Graph(List.of(),List.of()):graph, prefix, prefix + "LOB_LEFT",outputTypes(target,typeBindings));
            Map<Integer, PlDebugCompositeInput.Code> inputCodes = new LinkedHashMap<>();
            for (Input input : inputs()) if (jsonEncoded(input.argument())) inputCodes.put(input.argument().sequence(),inputCode(input,prefix));
            long lobCount = outputs().stream().filter(argument -> lob(argument) || jsonEncoded(argument)).count();
            if (lobCount > 0 || encoder != null) {
                for (String suffix : List.of("LOB_LEFT", "LOB_POS", "LOB_SIZE", "LOB_CHUNK")) privateNames.add(prefix + suffix);
                declarations.append("  ").append(prefix).append("LOB_LEFT INTEGER := ").append(PlDebugResultCache.MAX_BYTES - lobCount * 4096).append(";\n")
                    .append("  ").append(prefix).append("LOB_POS INTEGER;\n  ").append(prefix).append("LOB_SIZE INTEGER;\n  ")
                    .append(prefix).append("LOB_CHUNK VARCHAR2(32767);\n");
            }
            for (Input input : supplied()) declareFormal(declarations, nestedDeclarations, privateNames, prefix, input.argument());
            if (target.returns() != null) declareFormal(declarations, nestedDeclarations, privateNames, prefix, target.returns());
            for (var code : inputCodes.values()) { declarations.append(code.declarations()); privateNames.addAll(code.privateNames()); }
            for (Input input : inputs()) {
                if (lob(input.argument())) {
                    String variable = local(prefix, input.argument());
                    declare(declarations, privateNames, variable + "_I", input.argument());
                    privateNames.add(variable + "_F");
                    declarations.append("  ").append(variable).append("_F INTEGER;\n");
                }
                if ("TIMESTAMP".equals(input.argument().type()) || zoned(input.argument())) {
                    String number = local(prefix, input.argument()) + "_N";
                    privateNames.add(number);
                    declarations.append("  ").append(number).append(" NUMBER;\n");
                    if (zoned(input.argument())) {
                        String variable = local(prefix, input.argument());
                        privateNames.add(variable + "_W");
                        declarations.append("  ").append(variable).append("_W TIMESTAMP(9);\n");
                        if (TZ.equals(input.argument().type())) {
                            privateNames.add(variable + "_O"); privateNames.add(variable + "_R");
                            declarations.append("  ").append(variable).append("_O VARCHAR2(10);\n")
                                .append("  ").append(variable).append("_R VARCHAR2(128);\n");
                        }
                    }
                }
            }
            if (slots().context()) {
                privateNames.add(prefix + "INPUT_ZONE");
                declarations.append("  ").append(prefix).append("INPUT_ZONE VARCHAR2(128);\n");
            }
            if (slots().inputLobs()) {
                privateNames.add(prefix + "LOB_CLEANUP");
                declarations.append("  ").append(prefix).append("LOB_CLEANUP INTEGER := 0;\n");
            }
            List<Argument> outputs = outputs();
            for (int index = 0; index < outputs.size(); index++) {
                String done = prefix + "DONE_" + index;
                privateNames.add(done);
                declarations.append("  ").append(done).append(" INTEGER := 0;\n");
                if (lob(outputs.get(index))) declare(declarations, privateNames, local(prefix, outputs.get(index)) + "_E", outputs.get(index));
            }
            if (encoder != null) { declarations.append(encoder.declarations()); privateNames.addAll(encoder.privateNames()); }
            StringBuilder body = new StringBuilder();
            if (inputs().stream().anyMatch(input->composite(input.argument()))) {
                privateNames.add(prefix+"CHECK_NLS");
                declarations.append("PROCEDURE ").append(prefix).append("CHECK_NLS IS S VARCHAR2(128); C VARCHAR2(128); BEGIN SELECT MAX(CASE WHEN PARAMETER='NLS_SORT' THEN VALUE END), MAX(CASE WHEN PARAMETER='NLS_COMP' THEN VALUE END) INTO S,C FROM SYS.NLS_SESSION_PARAMETERS WHERE PARAMETER IN ('NLS_SORT','NLS_COMP'); IF S IS NULL OR C IS NULL OR ").append(prefix).append("SORT0 IS NULL OR ").append(prefix).append("COMP0 IS NULL OR S<>").append(prefix).append("SORT0 OR C<>").append(prefix).append("COMP0 THEN RAISE_APPLICATION_ERROR(-20994,'Input NLS context changed'); END IF; END;\n");
            }
            if (initializesTypes()) body.append("    ").append(phase).append(" := -1;\n");
            if (encoder != null) body.append(encoder.captureContext());
            if (!typeBindings.isEmpty()) {
                for(var code:inputCodes.values())body.append(code.preflight());
                body.append("    DECLARE\n").append(nestedDeclarations).append("    BEGIN\n");
            }
            for (Input input : inputs()) {
                String variable = local(prefix, input.argument());
                if (jsonEncoded(input.argument())) { body.append(inputCodes.get(input.argument().sequence()).assignments()); continue; }
                if (lob(input.argument())) {
                    body.append("    ").append(variable).append("_F := ?;\n    ").append(variable).append(" := ?;\n")
                        .append("    IF ").append(variable).append("_F = 0 THEN ").append(variable).append(" := NULL;\n")
                        .append("    ELSIF ").append(variable).append("_F = 1 THEN\n      SYS.DBMS_LOB.CREATETEMPORARY(").append(variable).append("_I, TRUE);\n      ").append(variable).append(" := ").append(variable).append("_I;\n")
                        .append("    ELSIF ").append(variable).append(" IS NULL THEN RAISE_APPLICATION_ERROR(-20995, 'LOB input was not transferred');\n    END IF;\n");
                    continue;
                }
                if (zoned(input.argument())) {
                    renderZonedInput(body, variable, input.argument());
                    continue;
                }
                if ("TIMESTAMP".equals(input.argument().type())) {
                    String number = variable + "_N";
                    body.append("    ").append(number).append(" := ?;\n    ").append(variable)
                        .append(" := TIMESTAMP '1970-01-01 00:00:00' + NUMTODSINTERVAL(FLOOR(").append(number)
                        .append("), 'SECOND') + NUMTODSINTERVAL(").append(number).append(" - FLOOR(").append(number).append("), 'SECOND');\n");
                    continue;
                }
                if(intervalKind(input.argument().type())!=null) {
                    body.append("    ").append(variable).append(" := ").append("INTERVAL DAY TO SECOND".equals(intervalKind(input.argument().type()))?"TO_DSINTERVAL(?)":"TO_YMINTERVAL(?)").append(";\n");
                    continue;
                }
                body.append("    ").append(variable).append(switch (input.argument().type()) {
                    case "PL/SQL BOOLEAN" -> " := (? = 1);\n";
                    case "DATE" -> " := DATE '1970-01-01' + ? / 86400;\n";
                    case "BINARY_FLOAT", "BINARY_DOUBLE" -> " := SYS.UTL_RAW.CAST_TO_"+input.argument().type()+"(HEXTORAW(?),1);\n";
                    default -> " := ?;\n";
                });
            }
            if (slots().context()) body.append("    SELECT SESSIONTIMEZONE INTO ").append(prefix).append("INPUT_ZONE FROM DUAL;\n");
            if(inputCodes.values().stream().anyMatch(code->code.keys().stream().anyMatch(binding->"text".equals(binding.kind()))))body.append(prefix).append("CHECK_NLS;\n");
            body.append("    ").append(phase).append(" := 1;\n");
            int callLine = (int) body.chars().filter(c -> c == '\n').count() + 1;
            body.append("    ");
            if (target.returns() != null) body.append(local(prefix, target.returns())).append(" := ");
            body.append(target.routine()).append('(').append(supplied().stream()
                .map(input -> quote(input.argument().name()) + " => " + local(prefix, input.argument()))
                .collect(Collectors.joining(", "))).append(");\n");
            body.append("    ").append(phase).append(" := 2;\n");
            if (encoder != null) body.append("    SYS.DBMS_DEBUG.DEBUG_OFF;\n").append(encoder.beginExport());
            for (int index = 0; index < outputs.size(); index++) {
                String value = local(prefix, outputs.get(index));
                body.append("    BEGIN\n");
                if (jsonEncoded(outputs.get(index))) {
                    body.append(national(outputs.get(index))?encoder.encodeNational(value):encoder.encode(typeBindings.get(outputs.get(index).sequence()), value))
                        .append("      ? := ").append(encoder.valueVariable()).append(";\n      IF ").append(encoder.completeExpression()).append(" THEN ").append(prefix).append("DONE_").append(index).append(" := 1; ELSE ").append(prefix).append("DONE_").append(index).append(" := 3; END IF;\n")
                        .append("      BEGIN SYS.DBMS_LOB.FREETEMPORARY(").append(encoder.valueVariable()).append("); EXCEPTION WHEN OTHERS THEN ").append(prefix).append("DONE_").append(index).append(" := ").append(prefix).append("DONE_").append(index).append(" + 1; END;\n")
                        .append("    EXCEPTION WHEN OTHERS THEN\n      BEGIN IF SYS.DBMS_LOB.ISTEMPORARY(").append(encoder.valueVariable()).append(")=1 THEN SYS.DBMS_LOB.FREETEMPORARY(").append(encoder.valueVariable()).append("); END IF; EXCEPTION WHEN OTHERS THEN NULL; END;\n    END;\n");
                    continue;
                }
                if (lob(outputs.get(index))) {
                    renderLobOutput(body, value, outputs.get(index), prefix, index);
                    continue;
                }
                if (zoned(outputs.get(index))) {
                    renderZonedOutput(body, value, outputs.get(index));
                    body.append("      ").append(prefix).append("DONE_").append(index).append(" := 1;\n")
                        .append("    EXCEPTION WHEN OTHERS THEN NULL;\n    END;\n");
                    continue;
                }
                if ("PL/SQL BOOLEAN".equals(outputs.get(index).type())) value = "CASE WHEN " + value + " IS NULL THEN NULL WHEN " + value + " THEN 1 ELSE 0 END";
                if ("DATE".equals(outputs.get(index).type())) value = "ROUND((" + value + " - DATE '1970-01-01') * 86400)";
                if ("TIMESTAMP".equals(outputs.get(index).type())) value = timestampEpoch(value);
                if (integer(outputs.get(index))) value = "CAST(" + value + " AS NUMBER)";
                if (binaryFloat(outputs.get(index))) value = "RAWTOHEX(SYS.UTL_RAW.CAST_FROM_"+outputs.get(index).type()+"("+value+",1))";
                if(intervalKind(outputs.get(index).type())!=null)value="REPLACE(TO_CHAR("+value+"),',','.')";
                body.append("      ? := ").append(value).append(";\n")
                    .append("      ").append(prefix).append("DONE_").append(index).append(" := 1;\n")
                    .append("    EXCEPTION WHEN OTHERS THEN NULL;\n    END;\n");
            }
            body.append("    ").append(phase).append(" := 3;\n");
            if (!typeBindings.isEmpty()) body.append("    END;\n");
            StringBuilder footer = new StringBuilder();
            if (slots().inputLobs()) {
                List<String> ownedInputs=new ArrayList<>();
                for(Input input:inputs())if(lob(input.argument()))ownedInputs.add(local(prefix,input.argument())+"_I");
                for(var code:inputCodes.values())ownedInputs.addAll(code.ownedInputLobs());
                for (String owned:ownedInputs) {
                    footer.append("  BEGIN\n    IF ").append(owned).append(" IS NOT NULL AND SYS.DBMS_LOB.ISTEMPORARY(").append(owned).append(") = 1 THEN SYS.DBMS_LOB.FREETEMPORARY(").append(owned).append("); END IF;\n")
                        .append("  EXCEPTION WHEN OTHERS THEN ").append(prefix).append("LOB_CLEANUP := 1;\n  END;\n");
                }
            }
            if (slots().context()) footer.append("  ? := ").append(prefix).append("INPUT_ZONE;\n");
            if (slots().inputLobs()) footer.append("  ? := ").append(prefix).append("LOB_CLEANUP;\n");
            footer.append("  ? := ").append(phase).append(";\n");
            for (int index = 0; index < outputs.size(); index++) footer.append("  ? := ").append(prefix).append("DONE_").append(index).append(";\n");
            return new PlDebugOutput.Body(declarations.toString(), body.toString(), footer.toString(), callLine,
                Set.copyOf(privateNames), phase + " < 2");
        }

        private void declareFormal(StringBuilder declarations, StringBuilder nested, Set<String> names, String prefix, Argument argument) {
            String variable = local(prefix, argument);
            if (!composite(argument)) declare(declarations, names, variable, argument);
            else {
                names.add(variable);
                nested.append("      ").append(variable).append(' ').append(typeBindings.get(argument.sequence()).declaration()).append(";\n");
            }
        }

        int bind(CallableStatement call) throws SQLException {
            int index = 1;
            for(Input input:inputs())if(composite(input.argument()))index=bindComposite(call,index,inputCode(input,"DBX_BIND_").keys());
            for (Input input : inputs()) {
                if(jsonEncoded(input.argument())) { index=bindComposite(call,index,inputCode(input,"DBX_BIND_").values()); continue; }
                if (lob(input.argument())) {
                    LobInput value = (LobInput) input.value();
                    call.setInt(index++, value == null ? 0 : value.empty() ? 1 : 2);
                    if (value == null || value.empty()) call.setNull(index++, jdbcType(input.argument()));
                    else if (value.text() != null) call.setCharacterStream(index++, new java.io.StringReader(value.text()), value.text().length());
                    else call.setBinaryStream(index++, new java.io.ByteArrayInputStream(value.bytes()), value.bytes().length);
                    continue;
                }
                if (TZ.equals(input.argument().type())) {
                    ZonedInput value = (ZonedInput) input.value();
                    if (value == null) call.setNull(index++, Types.NUMERIC); else call.setBigDecimal(index++, value.localSeconds());
                    call.setString(index++, value == null ? null : value.offset());
                    call.setString(index++, value == null ? null : value.region());
                    continue;
                }
                int jdbcType = jdbcType(input.argument());
                if (input.value() == null) call.setNull(index, jdbcType);
                else if (jdbcType == Types.NUMERIC) call.setBigDecimal(index, (BigDecimal) input.value());
                else if (jdbcType == Types.VARBINARY) call.setBytes(index, (byte[]) input.value());
                else call.setString(index, (String) input.value());
                index++;
            }
            for (Argument output : outputs()) {
                if (zoned(output)) {
                    call.registerOutParameter(index++, Types.NUMERIC);
                    call.registerOutParameter(index++, TZ.equals(output.type()) ? Types.VARCHAR : Types.NUMERIC);
                    call.registerOutParameter(index++, Types.VARCHAR);
                } else call.registerOutParameter(index++, jsonEncoded(output) ? Types.CLOB : jdbcType(output));
            }
            if (slots().context()) call.registerOutParameter(index++, Types.VARCHAR);
            if (slots().inputLobs()) call.registerOutParameter(index++, Types.INTEGER);
            call.registerOutParameter(index++, Types.INTEGER);
            for (Argument ignored : outputs()) call.registerOutParameter(index++, Types.INTEGER);
            return index;
        }

        private static int bindComposite(CallableStatement call,int index,List<PlDebugCompositeInput.Binding> bindings) throws SQLException {
            for(var binding:bindings) {
                if("clob".equals(binding.kind())||"blob".equals(binding.kind())) {
                    var value=(LobInput)binding.value();
                    if(value==null||value.empty())call.setNull(index,"clob".equals(binding.kind())?Types.CLOB:Types.BLOB);
                    else if(value.text()!=null)call.setCharacterStream(index,new java.io.StringReader(value.text()),value.text().length());
                    else call.setBinaryStream(index,new java.io.ByteArrayInputStream(value.bytes()),value.bytes().length);
                }
                else if(binding.value()==null)call.setNull(index,"raw".equals(binding.kind())?Types.VARBINARY:"text".equals(binding.kind())?Types.VARCHAR:Types.NUMERIC);
                else switch(binding.kind()) {
                    case "number" -> call.setBigDecimal(index,(BigDecimal)binding.value());
                    case "boolean" -> call.setInt(index,(Boolean)binding.value()?1:0);
                    case "text" -> call.setString(index,(String)binding.value());
                    case "raw" -> call.setBytes(index,(byte[])binding.value());
                    case "lob-state" -> call.setInt(index,(Integer)binding.value());
                    default -> throw new IllegalArgumentException("Unknown composite input binding kind");
                }
                index++;
            }
            return index;
        }

        int phase(CallableStatement call) throws SQLException {
            int value = call.getInt(phaseIndex());
            if (call.wasNull() || value < (initializesTypes() ? -1 : 0) || value > 3) throw new SQLException("No verified named-target execution phase was returned");
            return value;
        }

        Results unread(String state) {
            return new Results(outputs().stream().filter(a -> a.position() > 0).map(a -> result(a, null, state)).toList(),
                target.returns() == null ? null : result(target.returns(), null, state), state, null, null);
        }

        Results read(CallableStatement call, int phase) {
            return read(call, phase, new PlDebugResultCache());
        }

        Results read(CallableStatement call, int phase, PlDebugResultCache cache) {
            Slots slots = slots();
            String inputZone = null;
            boolean contextError = false;
            String cleanupError = null;
            if (slots.inputLobs()) {
                try {
                    if (call.getInt(slots.inputCleanupIndex()) != 0 || call.wasNull()) cleanupError = "Temporary input LOB cleanup could not be confirmed";
                } catch (SQLException error) { cleanupError = "Temporary input LOB cleanup could not be read"; }
            }
            if (slots.context()) {
                try {
                    inputZone = call.getString(slots.contextIndex());
                    if (phase >= 1 && (inputZone == null || inputZone.isEmpty())) throw new SQLException("No input session timezone was returned");
                } catch (SQLException error) { contextError = true; }
            }
            if (phase < 2) {
                Results result = unread("unavailable");
                return new Results(result.outParams(), result.returnValue(), result.state(), cleanupError != null ? cleanupError : contextError ? "Input session timezone could not be read" : null, inputZone);
            }
            List<Map<String, Object>> params = new ArrayList<>();
            Map<String, Object> returns = null;
            boolean partial = contextError || cleanupError != null;
            List<Argument> outputs = outputs();
            long transferDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(PlDebugNative.CALL_TIMEOUT_SECONDS);
            for (int index = 0; index < outputs.size(); index++) {
                Argument argument = outputs.get(index);
                Map<String, Object> result = result(argument, null, "unavailable");
                if (phase >= 2) {
                    try {
                        int copied = call.getInt(slots.phase() + 1 + index);
                        if (jsonEncoded(argument)) {
                            boolean present = !call.wasNull();
                            if (!present || copied < 1 || copied > 4) throw new SQLException("This composite result was not exported");
                            var clob = call.getClob(slots.outputIndices().get(index));
                            if (clob == null) throw new SQLException("No composite export was returned");
                            try (var reader = clob.getCharacterStream()) {
                                String path=argument.position()==0?"$return":argument.name();
                                boolean temporal=composite(argument)&&new PlDebugCompositeOutput(graph,"DBX_READ_","DBX_READ_LEFT",List.of(typeBindings.get(argument.sequence()))).temporal();
                                Map<String,Object> manifest;
                                if(temporal) {
                                    var normalized=PlDebugTemporalJson.normalize(reader,cache.remaining(),transferDeadline);
                                    manifest=cache.text(new java.io.StringReader(normalized.text()),path,copied<=2&&normalized.complete(),normalized.error());
                                }else manifest=cache.text(reader,path,copied<=2);
                                boolean releaseUnknown = copied == 2 || copied == 4;
                                result.put("state", Boolean.TRUE.equals(manifest.get("complete")) && !releaseUnknown ? "value" : "partial");
                                if (releaseUnknown) result.put("locatorReleaseState", "unknown");
                                result.put("resultRef", manifest);
                                result.put("typedValue", Map.of("kind", "composite", "format", "json"));
                                if (!Boolean.TRUE.equals(manifest.get("complete")) || releaseUnknown) partial = true;
                            } catch (java.io.IOException | RuntimeException error) { throw new SQLException("Composite export transfer failed", error); }
                            finally {
                                try { clob.free(); }
                                catch (SQLException error) { result.put("locatorReleaseState", "unknown"); result.put("state", "partial"); partial = true; }
                            }
                            if (argument.position() == 0) returns = result; else params.add(result);
                            continue;
                        }
                        if (lob(argument)) {
                            boolean donePresent = !call.wasNull();
                            result = readLob(call, slots.outputIndices().get(index), argument,
                                donePresent && copied >= 1 && copied <= 4, copied <= 2, cache);
                            if (copied == -1 || copied == 2 || copied == 4) {
                                result.put("locatorReleaseState", "unknown");
                                if (!"error".equals(result.get("state"))) result.put("state", "partial");
                            }
                            if (Set.of("error", "partial").contains((String) result.get("state"))) partial = true;
                            if (argument.position() == 0) returns = result;
                            else params.add(result);
                            continue;
                        }
                        if (call.wasNull() || copied != 1) throw new SQLException("This result field was not exported after the target returned");
                        int outputIndex = slots.outputIndices().get(index);
                        if ("RAW".equals(argument.type())) {
                            byte[] bytes = call.getBytes(outputIndex);
                            result = result(argument, null, bytes == null ? "null" : "value");
                            if (bytes != null) {
                                if (bytes.length > 32767) throw new SQLException("RAW result exceeds its PL/SQL capacity");
                                Map<String,Object> reference;
                                try { reference = cache.binary(new java.io.ByteArrayInputStream(bytes), argument.position() == 0 ? "$return" : argument.name(), true); }
                                catch (RuntimeException error) { throw new SQLException("RAW result could not be retained", error); }
                                result.put("resultRef", reference);
                                if (!Boolean.TRUE.equals(reference.get("complete"))) { result.put("state", "partial"); partial = true; }
                            }
                            if (argument.position() == 0) returns = result; else params.add(result);
                            continue;
                        }
                        String value;
                        if (zoned(argument)) result = readZoned(call, outputIndex, argument);
                        else {
                        if (jdbcType(argument) == Types.NUMERIC) {
                            BigDecimal number = call.getBigDecimal(outputIndex);
                            if (number != null && "PL/SQL BOOLEAN".equals(argument.type())) {
                                if (number.compareTo(BigDecimal.ZERO) != 0 && number.compareTo(BigDecimal.ONE) != 0) throw new SQLException("Invalid BOOLEAN result encoding");
                                value = number.compareTo(BigDecimal.ONE) == 0 ? "true" : "false";
                            } else if (number != null && Set.of("DATE", "TIMESTAMP").contains(argument.type())) value = temporalText(number, "TIMESTAMP".equals(argument.type()));
                            else value = number == null ? null : number.toPlainString();
                        } else {
                            value = call.getString(outputIndex);
                            if(value!=null&&binaryFloat(argument))try { value=binaryFloatHex(value,"BINARY_DOUBLE".equals(argument.type())); }
                            catch(IllegalArgumentException error) { throw new SQLException("Invalid binary floating-point result encoding",error); }
                            if(value!=null&&intervalKind(argument.type())!=null)try { value=intervalText(value,"INTERVAL DAY TO SECOND".equals(intervalKind(argument.type()))); }
                            catch(IllegalArgumentException error) { throw new SQLException("Invalid interval result encoding",error); }
                        }
                        result = result(argument, value, value == null ? "null" : value.isEmpty() ? "empty" : "value");
                        }
                    } catch (SQLException error) {
                        result.put("state", "error");
                        result.put("error", "The returned result field could not be read");
                        result.put("sqlState", error.getSQLState());
                        result.put("vendorCode", error.getErrorCode());
                        partial = true;
                    }
                }
                if (argument.position() == 0) returns = result;
                else params.add(result);
            }
            return new Results(List.copyOf(params), returns, partial ? "partial" : "available",
                partial ? cleanupError != null ? cleanupError : contextError ? "Some returned result fields or context could not be read" : "Some returned result fields could not be read" : null, inputZone);
        }
    }

    static String owner(Connection connection, String schema) throws SQLException {
        return owner(connection, schema, 0);
    }

    private static String owner(Connection connection, String schema, long deadlineNanos) throws SQLException {
        if (schema != null && !schema.isEmpty()) return schema;
        try (PreparedStatement statement = metadataStatement(connection, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL", deadlineNanos)) {
            try (ResultSet rows = statement.executeQuery()) {
                if (!rows.next() || rows.getString(1) == null || rows.getString(1).isEmpty()) {
                    throw new SQLException("Current schema could not be determined for the debug target");
                }
                return rows.getString(1);
            }
        }
    }

    static Map<String, Object> preview(Connection connection, PlDebugStartRequest request) throws SQLException {
        String owner = owner(connection, request.getSchema());
        List<Candidate> candidates = load(connection, owner, request);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schema", owner);
        result.put("state", candidates.isEmpty() ? "not_visible" : "available");
        result.put("candidates", candidates.stream().map(Candidate::preview).toList());
        if (candidates.isEmpty()) result.put("message", "The current connection returned no visible matching signature; refresh metadata or check the target");
        return result;
    }

    static List<Map<String, Object>> compileSignatures(Connection connection, String owner,
                                                       PlDebugStartRequest request, long deadlineNanos) throws SQLException {
        return load(connection, owner, request, deadlineNanos).stream().map(Candidate::signature).toList();
    }

    static Map<String, Object> previewTypes(Connection connection, PlDebugStartRequest request, long deadlineNanos) throws SQLException {
        String owner = owner(connection, request.getSchema(), deadlineNanos);
        List<Candidate> candidates = load(connection, owner, request, deadlineNanos);
        Map<String, String> typeOwners = new LinkedHashMap<>();
        List<Map<String, Object>> previews = new ArrayList<>();
        for (Candidate candidate : candidates) {
            Map<String, Object> preview = candidate.preview();
            var signature = typedSignature(connection, candidate, typeOwners, deadlineNanos);
            preview.put("signature", signature);
            String problem=typedTransportProblem(candidate,signature);
            if (problem==null) {
                preview.put("parameterTransport", "implemented");
                preview.remove("message");
            } else {preview.put("parameterTransport","not_implemented");preview.put("message",problem);}
            previews.add(preview);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schema", owner);
        result.put("state", candidates.isEmpty() ? "not_visible" : "available");
        result.put("candidates", List.copyOf(previews));
        result.put("transportLimits", Map.of("inputPayloadBytes", MAX_INPUT_BYTES,
            "requestWireBytes", com.dbx.agent.JsonRpcServer.MAX_TYPED_DEBUG_WIRE_BYTES,
            "resultCacheBytes", PlDebugResultCache.MAX_BYTES));
        return result;
    }

    private static Map<String, Object> typedSignature(Connection connection, Candidate candidate,
                                                     Map<String, String> typeOwners, long deadlineNanos) throws SQLException {
        if (!"VALID".equals(candidate.status())) throw new SQLException("The selected debug object is not confirmed VALID; inspect its compilation errors");
        Map<String, Object> targetVersion = targetVersion(connection, candidate, deadlineNanos);
        List<PlDebugTypeGraph.Ref> roots = new ArrayList<>();
        List<TypeBinding> bindings = new ArrayList<>();
        for (Argument argument : candidate.rows()) {
            if (argument.scalar()) continue;
            if (!"EXT".equals(argument.type()) || argument.typeOwner() == null || argument.typeName() == null) {
                throw new SQLException("This declared type identity does not yet have a verified OceanBase metadata adapter");
            }
            boolean sqlType = argument.typeSubname() == null;
            String container = sqlType ? argument.typeName() : argument.typeSubname();
            String key = JSON.toJson(List.of(argument.typeOwner(), sqlType ? "TYPE" : "PACKAGE", container));
            String owner = typeOwners.get(key);
            if (owner == null) {
                owner = sqlType ? PlDebugTypeMetadata.resolveSqlTypeOwner(connection, container, argument.typeOwner(), deadlineNanos)
                    : PlDebugTypeMetadata.resolveOwner(connection, container, argument.typeOwner(), deadlineNanos);
                typeOwners.put(key, owner);
            }
            var reference = new PlDebugTypeGraph.Ref(owner, argument.typeSubname(), argument.typeName());
            roots.add(reference);
            bindings.add(new TypeBinding(argument.sequence(), reference));
        }
        List<Map<String, String>> details;
        try (PreparedStatement statement = PlDebugTypeMetadata.prepare(connection,
            "SELECT * FROM SYS.ALL_ARGUMENTS WHERE OWNER=? AND OBJECT_ID=? AND SUBPROGRAM_ID=? ORDER BY SEQUENCE", deadlineNanos)) {
            statement.setString(1, candidate.owner());
            statement.setString(2, candidate.objectId());
            statement.setInt(3, candidate.subprogramId());
            details = metadataRows(statement, deadlineNanos);
        }
        if (details.size() != candidate.rows().size()) throw new SQLException("The selected debug argument metadata changed; refresh its preview");
        PlDebugTypeGraph.Graph graph = PlDebugTypeGraph.load(connection, roots, true, deadlineNanos);
        if (!unchanged(connection, candidate, deadlineNanos) || !targetVersion.equals(targetVersion(connection, candidate, deadlineNanos))) {
            throw new SQLException("The selected debug signature or source changed during type preparation");
        }
        Map<String, Object> signature = candidate.signature();
        signature.put("signatureVersion", 2);
        signature.put("metadataPreparation", "type_only");
        signature.put("argumentDetails", List.copyOf(details));
        signature.put("typeGraph", graph);
        if (!bindings.isEmpty()) signature.put("typeBindings", List.copyOf(bindings));
        signature.put("targetVersion", targetVersion);
        return signature;
    }

    private static Map<Integer, PlDebugTypeGraph.Ref> bindings(Map<String, Object> signature) {
        Map<Integer, PlDebugTypeGraph.Ref> result = new LinkedHashMap<>();
        Object values = signature.get("typeBindings");
        if (values instanceof List<?> list) for (Object value : list) {
            TypeBinding binding = (TypeBinding) value;
            if (result.putIfAbsent(binding.sequence(), binding.reference()) != null) throw new IllegalArgumentException("Duplicate composite formal identity");
        }
        return Map.copyOf(result);
    }

    private static String typedTransportProblem(Candidate candidate, Map<String, Object> signature) {
        var missing=candidate.rows().stream().filter(argument -> argument.scalar() && !argument.typedAdapted()).findFirst();
        if(missing.isPresent())return "Debugger parameter transport is not yet implemented for "+(missing.get().position()==0?"the return value":"parameter "+missing.get().name())+" ("+missing.get().type()+")";
        try {
            new Plan(candidate, List.of(), (PlDebugTypeGraph.Graph) signature.get("typeGraph"), bindings(signature));
            return null;
        } catch (IllegalArgumentException error) { return error.getMessage(); }
    }

    private static Map<String, Object> targetVersion(Connection connection, Candidate candidate, long deadlineNanos) throws SQLException {
        String container = candidate.packageName() == null ? candidate.name() : candidate.packageName();
        String types = candidate.packageName() == null ? "'" + candidate.objectType() + "'" : "'PACKAGE','PACKAGE BODY'";
        List<Map<String, String>> objects;
        try (PreparedStatement statement = PlDebugTypeMetadata.prepare(connection,
            "SELECT OBJECT_TYPE,OBJECT_ID,STATUS FROM SYS.ALL_OBJECTS WHERE OWNER=? AND OBJECT_NAME=? AND OBJECT_TYPE IN (" + types + ") ORDER BY OBJECT_TYPE", deadlineNanos)) {
            statement.setString(1, candidate.owner()); statement.setString(2, container);
            objects = metadataRows(statement, deadlineNanos);
        }
        String expectedType = candidate.packageName() == null ? candidate.objectType() : "PACKAGE";
        if (objects.isEmpty() || objects.stream().anyMatch(row -> !"VALID".equals(row.get("STATUS")))
            || objects.stream().filter(row -> expectedType.equals(row.get("OBJECT_TYPE")) && candidate.objectId().equals(row.get("OBJECT_ID"))).count() != 1) {
            throw new SQLException("The selected debug source identity is not confirmed VALID");
        }
        List<Map<String, String>> source;
        try (PreparedStatement statement = PlDebugTypeMetadata.prepare(connection,
            "SELECT TYPE,LINE,TEXT FROM SYS.ALL_SOURCE WHERE OWNER=? AND NAME=? AND TYPE IN (" + types + ") ORDER BY TYPE,LINE", deadlineNanos)) {
            statement.setString(1, candidate.owner()); statement.setString(2, container);
            source = metadataRows(statement, deadlineNanos);
        }
        if (source.isEmpty()) throw new SQLException("The selected debug source version could not be verified");
        return Map.of("objects", objects, "source", source);
    }

    private static List<Map<String, String>> metadataRows(PreparedStatement statement, long deadlineNanos) throws SQLException {
        try (ResultSet rows = statement.executeQuery()) {
            var metadata = rows.getMetaData();
            List<Map<String, String>> result = new ArrayList<>();
            int bytes = 0;
            while (rows.next()) {
                PlDebugTypeMetadata.remainingSeconds(deadlineNanos);
                if (result.size() >= 8192) throw new SQLException("Debug signature metadata row budget exceeded");
                Map<String, String> row = new LinkedHashMap<>();
                for (int index = 1; index <= metadata.getColumnCount(); index++) {
                    String key = metadata.getColumnLabel(index);
                    String value = rows.getString(index);
                    bytes += key.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                    if (value != null) bytes += value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                    if (bytes > 1_048_576 || row.containsKey(key)) throw new SQLException("Debug signature metadata byte or column budget exceeded");
                    row.put(key, value);
                }
                result.add(Collections.unmodifiableMap(row));
            }
            return List.copyOf(result);
        }
    }

    static Plan resolve(Connection connection, String owner, PlDebugStartRequest request) throws SQLException {
        Map<String, Object> selectedSignature = request.getTargetSignature();
        boolean typed = selectedSignature != null && selectedSignature.containsKey("signatureVersion");
        long deadlineNanos = typed ? System.nanoTime() + TimeUnit.SECONDS.toNanos(PlDebugNative.CALL_TIMEOUT_SECONDS) : 0;
        List<Candidate> candidates = load(connection, owner, request, deadlineNanos);
        Map<String, PlDebugParam> supplied = new LinkedHashMap<>();
        for (PlDebugParam param : request.getParams()) {
            if (param == null || param.getName() == null || supplied.putIfAbsent(param.getName(), param) != null) {
                throw new IllegalArgumentException("Debug parameters must have unique exact formal names");
            }
            if (param.getTypedValue() != null && !typed) throw new IllegalArgumentException("A typed parameter value requires a complete versioned debug signature");
        }
        Map<String, Object> baseSignature = selectedSignature;
        if (typed) {
            Object version = selectedSignature.get("signatureVersion");
            if (!(version instanceof Number) || new BigDecimal(version.toString()).compareTo(BigDecimal.valueOf(2)) != 0) {
                throw new IllegalArgumentException("Unsupported debug signature version; refresh its preview");
            }
            var graph = JSON.toJsonTree(selectedSignature.get("typeGraph"));
            var details = JSON.toJsonTree(selectedSignature.get("argumentDetails"));
            var source = JSON.toJsonTree(selectedSignature.get("targetVersion"));
            if (!"type_only".equals(selectedSignature.get("metadataPreparation")) || !details.isJsonArray()
                || !graph.isJsonObject() || !graph.getAsJsonObject().has("nodes") || !graph.getAsJsonObject().get("nodes").isJsonArray()
                || !graph.getAsJsonObject().has("versions") || !graph.getAsJsonObject().get("versions").isJsonArray()
                || !source.isJsonObject() || !source.getAsJsonObject().has("objects") || !source.getAsJsonObject().get("objects").isJsonArray()
                || !source.getAsJsonObject().has("source") || !source.getAsJsonObject().get("source").isJsonArray()) {
                throw new IllegalArgumentException("Incomplete versioned debug type signature; refresh its preview");
            }
            baseSignature = new LinkedHashMap<>(selectedSignature);
            for (String field : List.of("signatureVersion", "metadataPreparation", "argumentDetails", "typeGraph", "typeBindings", "targetVersion")) baseSignature.remove(field);
        }
        Map<String, Object> expectedBase = baseSignature;
        List<Candidate> matches = candidates.stream().filter(candidate -> request.getTargetSignature() == null
            ? describes(candidate, supplied) : JSON.toJsonTree(candidate.signature()).equals(JSON.toJsonTree(expectedBase))).toList();
        if (matches.size() != 1) {
            if (request.getTargetSignature() != null) throw new IllegalArgumentException("The selected debug signature changed or is no longer visible; refresh metadata and confirm again");
            throw new IllegalArgumentException(candidates.isEmpty()
                ? "The current connection returned no visible matching signature; refresh metadata or check the target"
                : "Debug parameter descriptions do not identify one signature; select a complete signature from refreshed metadata");
        }
        Candidate target = matches.getFirst();
        Map<String, Object> currentTyped = typed ? typedSignature(connection, target, new LinkedHashMap<>(), deadlineNanos) : null;
        if (typed && !JSON.toJsonTree(selectedSignature).equals(JSON.toJsonTree(currentTyped))) {
            throw new IllegalArgumentException("The selected debug type graph changed; refresh metadata and confirm again");
        }
        if (!"VALID".equals(target.status())) throw new IllegalArgumentException("The selected debug object is not confirmed VALID; inspect its source and compilation errors");
        if (!describes(target, supplied)) throw new IllegalArgumentException("Parameter names, directions or types do not match the selected signature; refresh metadata");
        if(typed) {
            String problem=typedTransportProblem(target,currentTyped);
            if(problem!=null)throw new IllegalArgumentException(problem);
        } else if (target.rows().stream().anyMatch(a -> !a.adapted())) {
            Argument argument = target.rows().stream().filter(a -> !a.adapted()).findFirst().orElseThrow();
            throw new IllegalArgumentException("Debugger parameter transport is not yet implemented for "
                + (argument.position() == 0 ? "the return value" : "parameter " + argument.name()) + " (" + argument.type() + ")");
        }
        List<Input> inputs = new ArrayList<>();
        int remainingInputBytes = MAX_INPUT_BYTES;
        for (Argument argument : target.parameters()) {
            PlDebugParam param = supplied.get(argument.name());
            String state = param.getInputState() == null ? param.getValue() == null && param.getTypedValue() == null ? "null" : "value" : param.getInputState();
            if (!Set.of("value", "null", "default").contains(state)) throw new IllegalArgumentException("Invalid input state for parameter " + argument.name());
            if (!argument.input()) {
                if (param.getValue() != null || param.getTypedValue() != null || "default".equals(state)) throw new IllegalArgumentException("OUT parameter does not accept input: " + argument.name());
                inputs.add(new Input(argument, "null", null));
                continue;
            }
            if (typed && !lob(argument) && !bindings(currentTyped).containsKey(argument.sequence())) {
                JsonElement payload = param.getTypedValue();
                if (payload != null && payload.isJsonObject()) payload = payload.getAsJsonObject().get("value");
                if (param.getValue() != null) remainingInputBytes -= inputPayloadBytes(JSON.toJsonTree(param.getValue()), remainingInputBytes, 0);
                if (payload != null) remainingInputBytes -= inputPayloadBytes(payload, remainingInputBytes, 0);
            }
            if (typed && bindings(currentTyped).containsKey(argument.sequence())) {
                if (param.getValue() != null) throw new IllegalArgumentException("Composite input requires typedValue, not legacy text");
                if ("default".equals(state)) {
                    if (!"IN".equals(argument.mode()) || !"Y".equals(argument.defaulted()) || param.getTypedValue() != null) throw new IllegalArgumentException("No omittable composite input default was confirmed");
                    inputs.add(new Input(argument,state,null));
                } else {
                    if (!"value".equals(state) || param.getTypedValue() == null) throw new IllegalArgumentException("Composite input requires an explicit typed value including its NULL state");
                    var prepared = PlDebugCompositeInput.prepare((PlDebugTypeGraph.Graph)currentTyped.get("typeGraph"),bindings(currentTyped).get(argument.sequence()),param.getTypedValue(),remainingInputBytes);
                    remainingInputBytes-=prepared.inputBytes();
                    inputs.add(new Input(argument,state,prepared));
                }
                continue;
            }
            Object value = lob(argument) ? lobInput(argument, param, state, remainingInputBytes) : scalarInput(argument, param, state);
            if (value instanceof LobInput input) remainingInputBytes -= input.encodedBytes();
            if ("default".equals(state)) {
                if (!"IN".equals(argument.mode()) || !"Y".equals(argument.defaulted())) {
                    throw new IllegalArgumentException("No omittable input default was confirmed for parameter " + argument.name());
                }
                inputs.add(new Input(argument, state, null));
                continue;
            }
            inputs.add(new Input(argument, state, value));
        }
        Plan plan = typed ? new Plan(target, List.copyOf(inputs), (PlDebugTypeGraph.Graph) currentTyped.get("typeGraph"), bindings(currentTyped)) : new Plan(target, List.copyOf(inputs));
        for (Candidate other : candidates) {
            if (other != target && exactCallMatch(other, plan.supplied(), typed && target.rows().stream().anyMatch(a -> "CHAR".equals(a.type())||national(a)))) {
                throw new IllegalArgumentException("The selected types and omitted defaults still leave an ambiguous PL/SQL call; choose explicit arguments or another signature");
            }
        }
        return plan;
    }

    static int inputPayloadBytes(JsonElement value, int remaining, int depth) {
        if (depth > 32) throw new IllegalArgumentException("Typed debug input nesting budget exceeded");
        if (value == null || value.isJsonNull()) return 0;
        int bytes = 0;
        if (value.isJsonPrimitive()) {
            String text = value.getAsString();
            for (int index = 0; index < text.length(); index++) {
                char next = text.charAt(index);
                int cost;
                if (Character.isHighSurrogate(next)) {
                    if (++index >= text.length() || !Character.isLowSurrogate(text.charAt(index))) throw new IllegalArgumentException("Typed debug input contains invalid UTF-16");
                    cost = 4;
                } else {
                    if (Character.isLowSurrogate(next)) throw new IllegalArgumentException("Typed debug input contains invalid UTF-16");
                    cost = next < 128 ? 1 : next < 2048 ? 2 : 3;
                }
                if (cost > remaining - bytes) throw new IllegalArgumentException("Typed debug input byte budget exceeded");
                bytes += cost;
            }
        } else if (value.isJsonArray()) {
            for (JsonElement child : value.getAsJsonArray()) bytes += inputPayloadBytes(child, remaining - bytes, depth + 1);
        } else {
            for (JsonElement child : value.getAsJsonObject().asMap().values()) bytes += inputPayloadBytes(child, remaining - bytes, depth + 1);
        }
        return bytes;
    }

    static LobInput lobInput(Argument argument, PlDebugParam param, String state, int remaining) {
        if (!"value".equals(state)) {
            if (param.getValue() != null || param.getTypedValue() != null) throw new IllegalArgumentException("NULL or omitted LOB input cannot also contain a value");
            return null;
        }
        var payload = param.getTypedValue();
        if (param.getValue() != null || payload == null || !payload.isJsonObject()) throw new IllegalArgumentException("LOB input requires a typed value");
        var typed = payload.getAsJsonObject();
        String kind = "CLOB".equals(argument.type()) ? "clob" : "blob";
        if (!typed.keySet().equals(Set.of("kind", "value")) || !typed.get("kind").isJsonPrimitive()
            || !typed.getAsJsonPrimitive("kind").isString() || !kind.equals(typed.get("kind").getAsString())) {
            throw new IllegalArgumentException("LOB input does not match its declared type");
        }
        var value = typed.get("value");
        if ("clob".equals(kind)) {
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw new IllegalArgumentException("CLOB input must be text");
            String text = value.getAsString();
            int bytes = 0;
            for (int index = 0; index < text.length(); index++) {
                char next = text.charAt(index);
                int cost;
                if (Character.isHighSurrogate(next)) {
                    if (++index >= text.length() || !Character.isLowSurrogate(text.charAt(index))) throw new IllegalArgumentException("CLOB input contains invalid UTF-16");
                    cost = 4;
                } else {
                    if (Character.isLowSurrogate(next)) throw new IllegalArgumentException("CLOB input contains invalid UTF-16");
                    cost = next < 128 ? 1 : next < 2048 ? 2 : 3;
                }
                if (cost > remaining - bytes) throw new IllegalArgumentException("Typed LOB input byte budget exceeded");
                bytes += cost;
            }
            return new LobInput(text, null, bytes);
        }
        if (!value.isJsonObject()) throw new IllegalArgumentException("BLOB input must declare its base64 encoding");
        var binary = value.getAsJsonObject();
        if (!binary.keySet().equals(Set.of("encoding", "data")) || !binary.get("encoding").isJsonPrimitive()
            || !binary.getAsJsonPrimitive("encoding").isString() || !"base64".equals(binary.get("encoding").getAsString())
            || !binary.get("data").isJsonPrimitive() || !binary.getAsJsonPrimitive("data").isString()) {
            throw new IllegalArgumentException("BLOB input requires explicit base64 data");
        }
        String data = binary.get("data").getAsString();
        if (data.length() % 4 != 0) throw new IllegalArgumentException("BLOB base64 input requires complete padded groups");
        int padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
        long size = (long) data.length() / 4 * 3 - padding;
        if (size > remaining) throw new IllegalArgumentException("Typed LOB input byte budget exceeded");
        byte[] decoded;
        try { decoded = java.util.Base64.getDecoder().decode(data); }
        catch (IllegalArgumentException error) { throw new IllegalArgumentException("BLOB input contains invalid base64 data"); }
        return new LobInput(null, decoded, decoded.length);
    }

    static Object scalarInput(Argument argument, PlDebugParam param, String state) {
        if ("RAW".equals(argument.type())) return rawInput(param, state);
        if(intervalKind(argument.type())!=null) {
            if(!"value".equals(state)) {
                if(param.getValue()!=null||param.getTypedValue()!=null)throw new IllegalArgumentException("NULL or omitted interval input cannot also contain a value");
                return null;
            }
            var payload=param.getTypedValue();
            if(param.getValue()!=null||payload==null||!payload.isJsonObject())throw new IllegalArgumentException("Interval input requires typed text");
            var typed=payload.getAsJsonObject();
            if(!typed.keySet().equals(Set.of("kind","value"))||!typed.get("kind").isJsonPrimitive()||!typed.getAsJsonPrimitive("kind").isString()||!"text".equals(typed.get("kind").getAsString()))throw new IllegalArgumentException("Interval input requires typed text");
            if(typed.get("value").isJsonNull())return null;
            return intervalText(jsonText(typed,"value"),"INTERVAL DAY TO SECOND".equals(intervalKind(argument.type())));
        }
        if (binaryFloat(argument)) {
            if(!"value".equals(state)) {
                if(param.getValue()!=null||param.getTypedValue()!=null)throw new IllegalArgumentException("NULL or omitted floating-point input cannot also contain a value");
                return null;
            }
            var payload=param.getTypedValue();
            if(param.getValue()!=null||payload==null||!payload.isJsonObject())throw new IllegalArgumentException("Binary floating-point input requires a typed hexadecimal value");
            var typed=payload.getAsJsonObject();
            if(!typed.keySet().equals(Set.of("kind","value"))||!typed.get("kind").isJsonPrimitive()||!typed.getAsJsonPrimitive("kind").isString()||!argument.type().toLowerCase(Locale.ROOT).equals(typed.get("kind").getAsString()))throw new IllegalArgumentException("Binary floating-point input kind does not match its declared type");
            if(typed.get("value").isJsonNull())return null;
            if(!typed.get("value").isJsonPrimitive()||!typed.getAsJsonPrimitive("value").isString())throw new IllegalArgumentException("Binary floating-point input requires hexadecimal text");
            return binaryFloatHex(typed.get("value").getAsString(),"BINARY_DOUBLE".equals(argument.type()));
        }
        if(national(argument)) {
            if(!"value".equals(state)) {
                if(param.getValue()!=null||param.getTypedValue()!=null)throw new IllegalArgumentException("NULL or omitted national input cannot also contain a value");
            } else if(param.getTypedValue()==null)throw new IllegalArgumentException("National character input requires a typed text value");
        }
        if (lob(argument)) return lobInput(argument, param, state, MAX_INPUT_BYTES);
        if (zoned(argument)) return zonedInput(argument, param, state);
        String value = param.getValue();
        boolean bool = "PL/SQL BOOLEAN".equals(argument.type());
        boolean date = "DATE".equals(argument.type());
        boolean timestamp = "TIMESTAMP".equals(argument.type());
        if (param.getTypedValue() != null) {
            if (value != null || !"value".equals(state) || !param.getTypedValue().isJsonObject()) {
                throw new IllegalArgumentException("Typed input must contain one explicit value for parameter " + argument.name());
            }
            var typed = param.getTypedValue().getAsJsonObject();
            String kind = bool ? "boolean" : date ? "date" : timestamp ? "timestamp" : "NUMBER".equals(argument.type()) || integer(argument) ? "number" : "text";
            if (!typed.keySet().equals(Set.of("kind", "value"))
                || !typed.get("kind").isJsonPrimitive() || !typed.getAsJsonPrimitive("kind").isString()
                || !kind.equals(typed.get("kind").getAsString())
                || !typed.get("value").isJsonPrimitive()
                || (bool ? !typed.getAsJsonPrimitive("value").isBoolean() : !typed.getAsJsonPrimitive("value").isString())) {
                throw new IllegalArgumentException("Typed input does not match the declared scalar type for parameter " + argument.name());
            }
            if (bool) return typed.get("value").getAsBoolean() ? BigDecimal.ONE : BigDecimal.ZERO;
            value = typed.get("value").getAsString();
            if (date || timestamp) {
                return temporalInput(value, timestamp, argument.name());
            }
        }
        if (!"value".equals(state)) return null;
        if (bool) throw new IllegalArgumentException("BOOLEAN input requires a typed boolean value for parameter " + argument.name());
        if (date) throw new IllegalArgumentException("DATE input requires a typed date value for parameter " + argument.name());
        if (timestamp) throw new IllegalArgumentException("TIMESTAMP input requires a typed timestamp value for parameter " + argument.name());
        if (value == null) throw new IllegalArgumentException("An explicit input value is required for parameter " + argument.name());
        if ("NUMBER".equals(argument.type()) || integer(argument)) {
            try { return new BigDecimal(value); }
            catch (NumberFormatException error) { throw new IllegalArgumentException("Invalid NUMBER input for parameter " + argument.name()); }
        }
        return value;
    }

    static byte[] rawInput(PlDebugParam param, String state) {
        if (!"value".equals(state)) {
            if (param.getValue() != null || param.getTypedValue() != null) throw new IllegalArgumentException("NULL or omitted RAW input cannot also contain a value");
            return null;
        }
        var payload = param.getTypedValue();
        if (param.getValue() != null || payload == null || !payload.isJsonObject()) throw new IllegalArgumentException("RAW input requires a typed value");
        var typed = payload.getAsJsonObject();
        if (!typed.keySet().equals(Set.of("kind", "value")) || !typed.get("kind").isJsonPrimitive() || !typed.getAsJsonPrimitive("kind").isString() || !"raw".equals(typed.get("kind").getAsString())) throw new IllegalArgumentException("RAW input requires its declared kind");
        var value = typed.get("value");
        if (value.isJsonNull()) return null;
        if (!value.isJsonObject()) throw new IllegalArgumentException("RAW input requires explicit base64 data");
        var binary = value.getAsJsonObject();
        if (!binary.keySet().equals(Set.of("encoding", "data")) || !binary.get("encoding").isJsonPrimitive() || !binary.getAsJsonPrimitive("encoding").isString() || !"base64".equals(binary.get("encoding").getAsString()) || !binary.get("data").isJsonPrimitive() || !binary.getAsJsonPrimitive("data").isString()) throw new IllegalArgumentException("RAW input requires explicit base64 data");
        String data = binary.get("data").getAsString();
        int padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
        if (data.length() % 4 != 0 || (long)data.length() / 4 * 3 - padding > 32767) throw new IllegalArgumentException("RAW input exceeds its capacity or has incomplete base64 groups");
        byte[] decoded;
        try { decoded = java.util.Base64.getDecoder().decode(data); }
        catch (IllegalArgumentException error) { throw new IllegalArgumentException("RAW input contains invalid base64 data"); }
        if (!java.util.Base64.getEncoder().encodeToString(decoded).equals(data)) throw new IllegalArgumentException("RAW input requires canonical base64 data");
        return decoded.length == 0 ? null : decoded;
    }

    static String binaryFloatHex(String value,boolean doublePrecision) {
        if(!value.matches(doublePrecision?"[0-9A-Fa-f]{16}":"[0-9A-Fa-f]{8}"))throw new IllegalArgumentException("Binary floating-point input requires fixed-width big-endian hexadecimal text");
        return value.toUpperCase(Locale.ROOT);
    }

    static String intervalKind(String type) {
        if(type==null)return null;
        if(type.matches("INTERVAL YEAR(\\([0-9]\\))? TO MONTH"))return "INTERVAL YEAR TO MONTH";
        if(type.matches("INTERVAL DAY(\\([0-9]\\))? TO SECOND(\\([0-9]\\))?"))return "INTERVAL DAY TO SECOND";
        return null;
    }

    static String intervalText(String value,boolean daySecond) {
        var pattern=java.util.regex.Pattern.compile(daySecond?"^([+-]?)([0-9]{1,9}) ((?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9])(?:\\.([0-9]{1,9}))?$":"^([+-]?)([0-9]{1,9})-(0[0-9]|1[01])$");
        var match=pattern.matcher(value);
        if(!match.matches())throw new IllegalArgumentException("Interval input requires SQL interval text with at most nine leading and fractional digits");
        String sign=match.group(1).isEmpty()?"+":match.group(1),leading="0".repeat(9-match.group(2).length())+match.group(2);
        if(!daySecond)return sign+leading+"-"+match.group(3);
        String fraction=match.group(4)==null?"":match.group(4);
        return sign+leading+" "+match.group(3)+"."+fraction+"0".repeat(9-fraction.length());
    }

    static BigDecimal temporalInput(String value, boolean timestamp, String name) {
        try {
            if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}" + (timestamp ? "(\\.[0-9]{1,9})?" : ""))) throw new IllegalArgumentException();
            LocalDateTime parsed = LocalDateTime.parse(value, timestamp ? DateTimeFormatter.ISO_LOCAL_DATE_TIME : DATE_TEXT);
            if (parsed.getYear() < 1 || parsed.getYear() > 9999) throw new IllegalArgumentException();
            BigDecimal whole = BigDecimal.valueOf(parsed.toEpochSecond(ZoneOffset.UTC));
            return timestamp ? whole.add(BigDecimal.valueOf(parsed.getNano(), 9)) : whole;
        } catch (RuntimeException error) {
            throw new IllegalArgumentException((timestamp ? "TIMESTAMP" : "DATE") + " input requires YYYY-MM-DDTHH:mm:ss" + (timestamp ? " with up to 9 fractional digits" : "") + " in years 0001 through 9999 for parameter " + name);
        }
    }

    private static boolean zoned(Argument argument) { return TZ.equals(argument.type()) || LTZ.equals(argument.type()); }

    private static Object zonedInput(Argument argument, PlDebugParam param, String state) {
        if (param.getTypedValue() == null) {
            if (!"value".equals(state)) return null;
            throw new IllegalArgumentException("A typed timezone value is required for parameter " + argument.name());
        }
        try {
            var typed = param.getTypedValue().getAsJsonObject();
            String kind = TZ.equals(argument.type()) ? "timestamp_tz" : "timestamp_ltz";
            if (param.getValue() != null || !"value".equals(state) || !typed.keySet().equals(Set.of("kind", "value"))
                || !kind.equals(jsonText(typed, "kind")) || !typed.get("value").isJsonObject()) throw new IllegalArgumentException();
            var value = typed.getAsJsonObject("value");
            if (LTZ.equals(argument.type())) {
                if (!value.keySet().equals(Set.of("instant"))) throw new IllegalArgumentException();
                String instant = jsonText(value, "instant");
                if (!instant.endsWith("Z")) throw new IllegalArgumentException();
                return temporalInput(instant.substring(0, instant.length() - 1), true, argument.name());
            }
            if (!value.keySet().containsAll(Set.of("local", "offset")) || !Set.of("local", "offset", "region").containsAll(value.keySet())) throw new IllegalArgumentException();
            BigDecimal local = temporalInput(jsonText(value, "local"), true, argument.name());
            String rawOffset = jsonText(value, "offset");
            if (!rawOffset.matches("[+-][0-9]{2}:[0-9]{2}")) throw new IllegalArgumentException();
            String offset = offsetText(ZoneOffset.of(rawOffset).getTotalSeconds());
            String region = value.has("region") && !value.get("region").isJsonNull() ? jsonText(value, "region") : null;
            if (region != null && (region.isEmpty() || region.length() > 128)) throw new IllegalArgumentException();
            return new ZonedInput(local, offset, region);
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("Invalid structured timezone input for parameter " + argument.name());
        }
    }

    private static String jsonText(com.google.gson.JsonObject value, String key) {
        var field = value.get(key);
        if (field == null || !field.isJsonPrimitive() || !field.getAsJsonPrimitive().isString()) throw new IllegalArgumentException();
        return field.getAsString();
    }

    private static String offsetText(int seconds) {
        ZoneOffset.ofTotalSeconds(seconds);
        if (seconds % 60 != 0) throw new IllegalArgumentException("Timezone offset has unsupported sub-minute precision");
        int minutes = Math.abs(seconds / 60);
        return String.format(Locale.ROOT, "%s%02d:%02d", seconds < 0 ? "-" : "+", minutes / 60, minutes % 60);
    }

    static String timestampConstruct(String number) {
        return "TIMESTAMP '1970-01-01 00:00:00' + NUMTODSINTERVAL(FLOOR(" + number
            + "), 'SECOND') + NUMTODSINTERVAL(" + number + " - FLOOR(" + number + "), 'SECOND')";
    }

    private static void renderZonedInput(StringBuilder body, String variable, Argument argument) {
        String number = variable + "_N", wall = variable + "_W", offset = variable + "_O", region = variable + "_R";
        body.append("    ").append(number).append(" := ?;\n");
        if (TZ.equals(argument.type())) body.append("    ").append(offset).append(" := ?;\n    ").append(region).append(" := ?;\n");
        renderZonedValue(body,variable,number,wall,offset,region,LTZ.equals(argument.type()));
    }

    static void renderZonedValue(StringBuilder body,String variable,String number,String wall,String offset,String region,boolean localTimeZone) {
        body.append("    IF ").append(number).append(" IS NULL THEN\n      ").append(variable).append(" := NULL;\n    ELSE\n      ")
            .append(wall).append(" := ").append(timestampConstruct(number)).append(";\n      ").append(variable).append(" := ");
        if (localTimeZone) {
            body.append("CAST(FROM_TZ(").append(wall).append(", '+00:00') AS TIMESTAMP(9) WITH LOCAL TIME ZONE);\n")
                .append("      IF ").append(variable).append(" IS NULL THEN RAISE_APPLICATION_ERROR(-20992, 'Timezone input could not be represented'); END IF;\n");
        } else {
            body.append("FROM_TZ(").append(wall).append(", ").append(offset).append(");\n      IF ").append(region)
                .append(" IS NOT NULL THEN SELECT ").append(variable).append(" AT TIME ZONE ").append(region).append(" INTO ").append(variable).append(" FROM DUAL; END IF;\n")
                .append("      IF ").append(variable).append(" IS NULL OR CAST(").append(variable).append(" AS TIMESTAMP(9)) IS NULL OR CAST(").append(variable)
                .append(" AS TIMESTAMP(9)) <> ").append(wall).append(" OR TO_CHAR(").append(variable).append(", 'TZH:TZM') IS NULL OR TO_CHAR(")
                .append(variable).append(", 'TZH:TZM') <> ").append(offset).append(" OR (").append(region).append(" IS NOT NULL AND (EXTRACT(TIMEZONE_REGION FROM ")
                .append(variable).append(") IS NULL OR EXTRACT(TIMEZONE_REGION FROM ").append(variable).append(") = 'UNKNOWN')) THEN\n")
                .append("        RAISE_APPLICATION_ERROR(-20992, 'Timezone region, offset and wall clock do not agree');\n      END IF;\n");
        }
        body.append("    END IF;\n");
    }

    private static void renderZonedOutput(StringBuilder body, String variable, Argument argument) {
        boolean tz = TZ.equals(argument.type());
        String wall = "CAST(" + variable + " AS TIMESTAMP(9))";
        String first = timestampEpoch(tz ? wall : "SYS_EXTRACT_UTC(" + variable + ")");
        String second = tz ? "TO_CHAR(" + variable + ", 'TZH:TZM')" : timestampEpoch(wall);
        String third = tz ? "EXTRACT(TIMEZONE_REGION FROM " + variable + ")" : "SESSIONTIMEZONE";
        body.append("      IF ").append(variable).append(" IS NOT NULL AND ((").append(first).append(") IS NULL OR (")
            .append(second).append(") IS NULL OR (").append(third).append(") IS NULL) THEN\n")
            .append("        RAISE_APPLICATION_ERROR(-20993, 'Timezone result could not be completely exported');\n      END IF;\n")
            .append("      ? := ").append(first).append(";\n      ? := ").append(second).append(";\n      ? := ").append(third).append(";\n");
    }

    private static Map<String, Object> readZoned(CallableStatement call, int index, Argument argument) throws SQLException {
        try {
            BigDecimal first = call.getBigDecimal(index);
            boolean tz = TZ.equals(argument.type());
            String offset = tz ? call.getString(index + 1) : null;
            BigDecimal wall = tz ? first : call.getBigDecimal(index + 1);
            String context = call.getString(index + 2);
            return decodeZoned(argument, first, offset, wall, context);
        } catch (RuntimeException error) { throw new SQLException("The timezone result components could not be decoded", error); }
    }

    static Map<String,Object> decodeZoned(Argument argument,BigDecimal first,String offset,BigDecimal wall,String context) throws SQLException {
        try {
            boolean tz = TZ.equals(argument.type());
            boolean isNull = tz ? first == null && offset == null && context == null : first == null && wall == null;
            if (isNull) {
                if (!tz && (context == null || context.isEmpty())) throw new SQLException("No result session timezone was returned");
                Map<String, Object> result = result(argument, null, "null");
                Map<String, Object> typed = new LinkedHashMap<>();
                typed.put("kind", tz ? "timestamp_tz" : "timestamp_ltz"); typed.put("value", null);
                if (!tz) result.put("sessionTimeZone", context);
                result.put("typedValue", typed);
                return result;
            }
            if (first == null || wall == null || context == null || context.isEmpty() || tz && offset == null) throw new SQLException("Incomplete timezone result components");
            BigDecimal instant;
            if (tz) {
                if (!offset.matches("[+-][0-9]{2}:[0-9]{2}")) throw new SQLException("Invalid timezone result offset");
                offset = offsetText(ZoneOffset.of(offset).getTotalSeconds());
                instant = wall.subtract(BigDecimal.valueOf(ZoneOffset.of(offset).getTotalSeconds()));
            } else {
                instant = first;
                offset = offsetText(wall.subtract(instant).intValueExact());
            }
            String local = temporalText(wall, true);
            BigDecimal whole = instant.setScale(0, RoundingMode.FLOOR);
            String utc = java.time.Instant.ofEpochSecond(whole.longValueExact(), instant.subtract(whole).movePointRight(9).intValueExact()).toString();
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("local", local); value.put("offset", offset); value.put("instant", utc);
            if (tz) { value.put("region", "UNKNOWN".equals(context) ? null : context); value.put("regionState", "UNKNOWN".equals(context) ? "not_returned" : "value"); }
            else value.put("sessionTimeZone", context);
            Map<String, Object> result = result(argument, local + offset + (tz && !"UNKNOWN".equals(context) ? "[" + context + "]" : ""), "value");
            result.put("typedValue", Map.of("kind", tz ? "timestamp_tz" : "timestamp_ltz", "value", value));
            return result;
        } catch (RuntimeException error) { throw new SQLException("The timezone result components could not be decoded", error); }
    }

    static String temporalText(BigDecimal seconds, boolean timestamp) throws SQLException {
        try {
            BigDecimal whole = timestamp ? seconds.setScale(0, RoundingMode.FLOOR) : seconds;
            int nanos = timestamp ? seconds.subtract(whole).movePointRight(9).intValueExact() : 0;
            LocalDateTime value = LocalDateTime.ofEpochSecond(whole.longValueExact(), nanos, ZoneOffset.UTC);
            if (value.getYear() < 1 || value.getYear() > 9999) throw new IllegalArgumentException();
            return (timestamp ? TIMESTAMP_TEXT : DATE_TEXT).format(value);
        } catch (RuntimeException error) {
            throw new SQLException("The returned date/time is outside the verified debugger transport range or precision", error);
        }
    }

    static String timestampEpoch(String value) {
        return "ROUND((CAST(" + value + " AS DATE) - DATE '1970-01-01') * 86400)"
            + " + EXTRACT(SECOND FROM " + value + ") - TRUNC(EXTRACT(SECOND FROM " + value + "))";
    }

    static boolean unchanged(Connection connection, Candidate target) throws SQLException {
        return unchanged(connection, target, 0);
    }

    private static boolean unchanged(Connection connection, Candidate target, long deadlineNanos) throws SQLException {
        PlDebugStartRequest request = new PlDebugStartRequest();
        request.setObjectName(target.name());
        request.setPackageName(target.packageName());
        request.setObjectType(target.objectType());
        return load(connection, target.owner(), request, deadlineNanos).contains(target);
    }

    private static boolean describes(Candidate candidate, Map<String, PlDebugParam> params) {
        return params.size() == candidate.parameters().size() && candidate.parameters().stream().allMatch(argument -> {
            PlDebugParam param = params.get(argument.name());
            return param != null && Objects.equals(argument.mode(), mode(param.getMode()))
                && Objects.equals(argument.type(), token(param.getType()));
        });
    }

    static boolean exactCallMatch(Candidate candidate, List<Input> supplied, boolean carrierFamilies) {
        Map<String, Argument> parameters = candidate.parameters().stream().collect(Collectors.toMap(Argument::name, a -> a));
        for (Input input : supplied) {
            Argument other = parameters.remove(input.argument().name());
            if (other == null) return false;
            if(input.argument().scalar()&&other.scalar()&&intervalKind(input.argument().type())!=null&&intervalKind(other.type())!=null)continue;
            if (carrierFamilies) {
                String actualFamily = carrierFamily(input.argument());
                String otherFamily = carrierFamily(other);
                if (actualFamily != null && otherFamily != null && !actualFamily.equals(otherFamily)) return false;
            } else if (!other.scalar() || !Objects.equals(other.type(), input.argument().type())) return false;
        }
        return parameters.values().stream().allMatch(a -> "IN".equals(a.mode()) && "Y".equals(a.defaulted()));
    }

    private static String carrierFamily(Argument argument) {
        if (!argument.scalar()) return null;
        String type = argument.type();
        if (integer(argument)) return "integer";
        if(binaryFloat(argument)||"RAW".equals(type))return type;
        if(intervalKind(type)!=null)return "interval";
        if (Set.of("CHAR", "CHARACTER", "VARCHAR2", "VARCHAR", "STRING", "LONG", "NCHAR", "NVARCHAR2",
            "NATIONAL CHAR", "NATIONAL CHARACTER", "CHARACTER VARYING", "CHAR VARYING", "RAW", "LONG RAW", "ROWID", "UROWID", "MLSLABEL").contains(type)) return "character";
        if (Set.of("NUMBER", "NUMERIC", "DECIMAL", "DEC", "INTEGER", "INT", "SMALLINT", "REAL", "FLOAT", "DOUBLE PRECISION",
            "BINARY_FLOAT", "BINARY_DOUBLE", "PLS_INTEGER", "BINARY_INTEGER", "SIMPLE_INTEGER", "NATURAL", "NATURALN", "POSITIVE", "POSITIVEN", "SIGNTYPE").contains(type)) return "number";
        if (Set.of("BOOLEAN", "PL/SQL BOOLEAN").contains(type)) return "boolean";
        if ("DATE".equals(type) || type.matches("TIMESTAMP(\\([0-9]+\\))?( WITH( LOCAL)? TIME ZONE)?")
            || type.matches("INTERVAL YEAR(\\([0-9]+\\))? TO MONTH")
            || type.matches("INTERVAL DAY(\\([0-9]+\\))? TO SECOND(\\([0-9]+\\))?")) return "datetime";
        if (Set.of("CLOB", "NCLOB", "BLOB", "BFILE").contains(type)) return "lob";
        return null;
    }

    private static List<Candidate> load(Connection connection, String owner, PlDebugStartRequest request) throws SQLException {
        return load(connection, owner, request, 0);
    }

    private static List<Candidate> load(Connection connection, String owner, PlDebugStartRequest request, long deadlineNanos) throws SQLException {
        String requestedType = token(request.getObjectType());
        if (!Set.of("PROCEDURE", "FUNCTION").contains(requestedType)) throw new IllegalArgumentException("A named procedure or function is required");
        if (request.getObjectName() == null || request.getObjectName().isEmpty()) throw new IllegalArgumentException("An exact routine name is required");
        String packageName = request.getPackageName() == null || request.getPackageName().isEmpty() ? null : request.getPackageName();
        String container = packageName == null ? request.getObjectName() : packageName;
        String containerType = packageName == null ? requestedType : "PACKAGE";
        Map<String, String> objects = new LinkedHashMap<>();
        try (PreparedStatement statement = metadataStatement(connection,
            "SELECT OBJECT_ID, STATUS FROM SYS.ALL_OBJECTS WHERE OWNER = ? AND OBJECT_NAME = ? AND OBJECT_TYPE = ?", deadlineNanos)) {
            statement.setString(1, owner); statement.setString(2, container); statement.setString(3, containerType);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    checkMetadataBudget(deadlineNanos, objects.size());
                    String id = rows.getString(1);
                    if (id == null || objects.containsKey(id)) throw new SQLException("Incomplete or duplicate debug object identity in metadata");
                    objects.put(id, rows.getString(2));
                }
            }
        }
        List<Candidate> result = new ArrayList<>();
        for (Map.Entry<String, String> object : objects.entrySet()) {
            List<Integer> subprograms = new ArrayList<>();
            String memberFilter = packageName == null ? "PROCEDURE_NAME IS NULL" : "PROCEDURE_NAME = ?";
            try (PreparedStatement statement = metadataStatement(connection, "SELECT SUBPROGRAM_ID FROM SYS.ALL_PROCEDURES"
                + " WHERE OWNER = ? AND OBJECT_ID = ? AND OBJECT_NAME = ? AND OBJECT_TYPE = ? AND " + memberFilter + " ORDER BY SUBPROGRAM_ID", deadlineNanos)) {
                statement.setString(1, owner); statement.setString(2, object.getKey()); statement.setString(3, container); statement.setString(4, containerType);
                if (packageName != null) statement.setString(5, request.getObjectName());
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        checkMetadataBudget(deadlineNanos, subprograms.size());
                        int id = requiredInt(rows, 1);
                        if (subprograms.contains(id)) throw new SQLException("Duplicate debug subprogram identity in metadata");
                        subprograms.add(id);
                    }
                }
            }
            for (int subprogram : subprograms) {
                List<Argument> args = new ArrayList<>();
                try (PreparedStatement statement = metadataStatement(connection, "SELECT ARGUMENT_NAME, POSITION, SEQUENCE, DATA_LEVEL, IN_OUT, DATA_TYPE,"
                    + " TYPE_OWNER, TYPE_NAME, TYPE_SUBNAME, DEFAULTED FROM SYS.ALL_ARGUMENTS"
                    + " WHERE OWNER = ? AND OBJECT_ID = ? AND SUBPROGRAM_ID = ? ORDER BY SEQUENCE", deadlineNanos)) {
                    statement.setString(1, owner); statement.setString(2, object.getKey()); statement.setInt(3, subprogram);
                    try (ResultSet rows = statement.executeQuery()) {
                        while (rows.next()) {
                            checkMetadataBudget(deadlineNanos, args.size());
                            Argument argument = new Argument(rows.getString(1), requiredInt(rows, 2), requiredInt(rows, 3), requiredInt(rows, 4),
                                mode(rows.getString(5)), token(rows.getString(6)), rows.getString(7), rows.getString(8), rows.getString(9), rows.getString(10));
                            if (argument.type().isEmpty() || !Set.of("IN", "OUT", "IN OUT").contains(argument.mode()) || argument.position() < 0 || argument.level() < 0
                                || argument.level() == 0 && argument.position() > 0 && argument.name() == null) {
                                throw new SQLException("Incomplete debug parameter signature in metadata");
                            }
                            args.add(argument);
                        }
                    }
                }
                Candidate candidate = new Candidate(owner, request.getObjectName(), packageName, object.getKey(), subprogram, object.getValue(), List.copyOf(args));
                Set<Integer> positions = new HashSet<>();
                Set<String> names = new HashSet<>();
                for (Argument argument : candidate.rows()) {
                    if (argument.level() == 0 && (!positions.add(argument.position()) || argument.position() > 0 && !names.add(argument.name()))) {
                        throw new SQLException("Duplicate debug parameter identity in metadata");
                    }
                }
                if (candidate.objectType().equals(requestedType)) result.add(candidate);
            }
        }
        return List.copyOf(result);
    }

    private static int requiredInt(ResultSet rows, int index) throws SQLException {
        int value = rows.getInt(index);
        if (rows.wasNull()) throw new SQLException("Incomplete numeric identity in debug metadata");
        return value;
    }

    private static PreparedStatement metadataStatement(Connection connection, String sql, long deadlineNanos) throws SQLException {
        if (deadlineNanos != 0) return PlDebugTypeMetadata.prepare(connection, sql, deadlineNanos);
        PreparedStatement statement = connection.prepareStatement(sql);
        try {
            statement.setQueryTimeout(PlDebugNative.CALL_TIMEOUT_SECONDS);
            return statement;
        } catch (SQLException error) {
            try { statement.close(); } catch (SQLException closeError) { error.addSuppressed(closeError); }
            throw error;
        }
    }

    private static void checkMetadataBudget(long deadlineNanos, int rows) throws SQLException {
        if (deadlineNanos == 0) return;
        PlDebugTypeMetadata.remainingSeconds(deadlineNanos);
        if (rows >= 8192) throw new SQLException("Debug signature metadata row budget exceeded");
    }

    private static void declare(StringBuilder sql, Set<String> names, String name, Argument argument) {
        names.add(name);
        String type = intervalKind(argument.type())!=null?("INTERVAL DAY TO SECOND".equals(intervalKind(argument.type()))?"INTERVAL DAY(9) TO SECOND(9)":"INTERVAL YEAR(9) TO MONTH"):switch (argument.type()) {
            case "NUMBER" -> "NUMBER";
            case "INT", "BINARY_INTEGER" -> "PLS_INTEGER";
            case "PL/SQL BOOLEAN" -> "BOOLEAN";
            case "DATE" -> "DATE";
            case "TIMESTAMP" -> "TIMESTAMP(9)";
            case TZ -> "TIMESTAMP(9) WITH TIME ZONE";
            case LTZ -> "TIMESTAMP(9) WITH LOCAL TIME ZONE";
            case "VARCHAR2", "CHAR" -> "VARCHAR2(32767)";
            case "NCHAR", "NVARCHAR2" -> "NVARCHAR2(32767)";
            case "CLOB", "BLOB" -> argument.type();
            case "RAW" -> "RAW(32767)";
            case "BINARY_FLOAT", "BINARY_DOUBLE" -> argument.type();
            default -> throw new IllegalArgumentException("No verified debug local declaration for this type");
        };
        sql.append("  ").append(name).append(' ').append(type).append(";\n");
    }

    private static String local(String prefix, Argument argument) { return prefix + (argument.position() == 0 ? "RETURN_VALUE" : "ARG_" + argument.position()); }
    private static boolean lob(Argument argument) { return Set.of("CLOB", "BLOB").contains(argument.type()); }
    private static boolean national(Argument argument) { return Set.of("NCHAR", "NVARCHAR2").contains(argument.type()); }
    private static boolean integer(Argument argument) { return Set.of("INT", "BINARY_INTEGER").contains(argument.type()); }
    private static boolean binaryFloat(Argument argument) { return Set.of("BINARY_FLOAT", "BINARY_DOUBLE").contains(argument.type()); }
    private static int jdbcType(Argument argument) {
        return switch (argument.type()) {
            case "CLOB" -> Types.CLOB;
            case "BLOB" -> Types.BLOB;
            case "RAW" -> Types.VARBINARY;
            default -> integer(argument) || Set.of("NUMBER", "PL/SQL BOOLEAN", "DATE", "TIMESTAMP", LTZ).contains(argument.type()) ? Types.NUMERIC : Types.VARCHAR;
        };
    }

    private static void renderLobOutput(StringBuilder body, String value, Argument argument, String prefix, int index) {
        String exported = value + "_E", left = prefix + "LOB_LEFT", size = prefix + "LOB_SIZE";
        String position = prefix + "LOB_POS", chunk = prefix + "LOB_CHUNK", done = prefix + "DONE_" + index;
        body.append("      ").append(size).append(" := 0;\n      IF ").append(value).append(" IS NOT NULL THEN\n")
            .append("        SYS.DBMS_LOB.CREATETEMPORARY(").append(exported).append(", TRUE);\n");
        if ("CLOB".equals(argument.type())) {
            body.append("        ").append(position).append(" := 1;\n        WHILE ").append(position).append(" <= SYS.DBMS_LOB.GETLENGTH(").append(value).append(") AND ").append(left).append(" > 0 LOOP\n")
                .append("          ").append(chunk).append(" := SYS.DBMS_LOB.SUBSTR(").append(value).append(", 4096, ").append(position).append(");\n")
                .append("          WHILE LENGTHB(").append(chunk).append(") > ").append(left).append(" LOOP\n")
                .append("            ").append(chunk).append(" := SUBSTR(").append(chunk).append(", 1, LENGTH(").append(chunk).append(") - 1);\n          END LOOP;\n")
                .append("          EXIT WHEN ").append(chunk).append(" IS NULL;\n")
                .append("          SYS.DBMS_LOB.WRITEAPPEND(").append(exported).append(", LENGTH(").append(chunk).append("), ").append(chunk).append(");\n")
                .append("          ").append(position).append(" := ").append(position).append(" + LENGTH(").append(chunk).append(");\n")
                .append("          ").append(left).append(" := ").append(left).append(" - LENGTHB(").append(chunk).append(");\n        END LOOP;\n")
                .append("        ").append(size).append(" := ").append(position).append(" - 1;\n");
        } else {
            body.append("        ").append(size).append(" := LEAST(SYS.DBMS_LOB.GETLENGTH(").append(value).append("), FLOOR(").append(left).append(" / 4) * 3);\n")
                .append("        IF ").append(size).append(" > 0 THEN SYS.DBMS_LOB.COPY(").append(exported).append(", ").append(value).append(", ").append(size).append("); END IF;\n")
                .append("        ").append(left).append(" := ").append(left).append(" - 4 * CEIL(").append(size).append(" / 3);\n");
        }
        body.append("      END IF;\n      ? := ").append(exported).append(";\n")
            .append("      ").append(done).append(" := CASE WHEN ").append(value).append(" IS NOT NULL AND ").append(size).append(" < SYS.DBMS_LOB.GETLENGTH(").append(value).append(") THEN 3 ELSE 1 END;\n")
            .append("      BEGIN\n        IF ").append(exported).append(" IS NOT NULL THEN SYS.DBMS_LOB.FREETEMPORARY(").append(exported).append("); END IF;\n")
            .append("      EXCEPTION WHEN OTHERS THEN ").append(done).append(" := ").append(done).append(" + 1;\n      END;\n")
            .append("    EXCEPTION WHEN OTHERS THEN\n      BEGIN\n")
            .append("        IF ").append(exported).append(" IS NOT NULL AND SYS.DBMS_LOB.ISTEMPORARY(").append(exported).append(") = 1 THEN SYS.DBMS_LOB.FREETEMPORARY(").append(exported).append("); END IF;\n")
            .append("      EXCEPTION WHEN OTHERS THEN ").append(done).append(" := -1;\n      END;\n    END;\n");
    }

    private static Map<String, Object> readLob(CallableStatement call, int index, Argument argument, boolean exported, boolean sourceComplete, PlDebugResultCache cache) throws SQLException {
        Map<String, Object> result = result(argument, null, exported ? "null" : "error");
        java.sql.Clob clob = "CLOB".equals(argument.type()) ? call.getClob(index) : null;
        java.sql.Blob blob = "BLOB".equals(argument.type()) ? call.getBlob(index) : null;
        try {
            if (!exported) {
                result.put("error", "This LOB result field was not completely exported");
            } else if (clob != null || blob != null) {
                Map<String, Object> reference;
                String path = argument.position() == 0 ? "$return" : argument.name();
                if (clob != null) try (var reader = clob.getCharacterStream()) { reference = cache.text(reader, path, sourceComplete); result.put("resultRef", reference); }
                else try (var stream = blob.getBinaryStream()) { reference = cache.binary(stream, path, sourceComplete); result.put("resultRef", reference); }
                result.put("state", Boolean.TRUE.equals(reference.get("complete")) ? ((int) reference.get("length") == 0 ? "empty" : "value") : "partial");
            }
        } catch (java.io.IOException | RuntimeException error) {
            result.put("state", "error");
            result.put("error", "The LOB result could not be retained completely");
        } finally {
            try {
                if (clob != null) clob.free();
                if (blob != null) blob.free();
            } catch (SQLException error) {
                result.put("locatorReleaseState", "unknown");
                result.put("state", "partial");
                result.put("releaseError", "The private result locator release could not be confirmed");
            }
        }
        return result;
    }
    private static String quote(String identifier) { return '"' + identifier.replace("\"", "\"\"") + '"'; }
    private static String token(String value) { return value == null ? "" : value.trim().toUpperCase(Locale.ROOT); }
    private static String mode(String value) { return "INOUT".equals(token(value)) ? "IN OUT" : token(value); }

    private static Map<String, Object> result(Argument argument, String value, String state) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (argument.position() > 0) { result.put("name", argument.name()); result.put("mode", argument.mode()); }
        result.put("type", argument.type()); result.put("value", value); result.put("state", state);
        if(intervalKind(argument.type())!=null&&Set.of("value","null").contains(state)) {
            Map<String,Object> typed=new LinkedHashMap<>();typed.put("kind","INTERVAL DAY TO SECOND".equals(intervalKind(argument.type()))?"interval_day_second":"interval_year_month");typed.put("value",value);result.put("typedValue",typed);
        }
        if(binaryFloat(argument)&&Set.of("value","null").contains(state)) {
            Map<String,Object> typed=new LinkedHashMap<>();typed.put("kind",argument.type().toLowerCase(Locale.ROOT));typed.put("value",value);result.put("typedValue",typed);
        }
        if ("PL/SQL BOOLEAN".equals(argument.type()) && Set.of("value", "null").contains(state)) {
            Map<String, Object> typed = new LinkedHashMap<>();
            typed.put("kind", "boolean"); typed.put("value", value == null ? null : Boolean.valueOf(value));
            result.put("typedValue", typed);
        }
        if (Set.of("DATE", "TIMESTAMP").contains(argument.type()) && Set.of("value", "null").contains(state)) {
            Map<String, Object> typed = new LinkedHashMap<>();
            typed.put("kind", "DATE".equals(argument.type()) ? "date" : "timestamp"); typed.put("value", value);
            result.put("typedValue", typed);
        }
        return result;
    }

    private PlDebugTarget() {}
}
