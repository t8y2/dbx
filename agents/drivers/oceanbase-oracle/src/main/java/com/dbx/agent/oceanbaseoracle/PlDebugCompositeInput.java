package com.dbx.agent.oceanbaseoracle;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class PlDebugCompositeInput {
    static final int MAX_NODES = 8192;
    record Value(String kind, Object value) {}
    record Field(String name, Value value) {}
    record Entry(String index, Value value) {}
    record ObjectArgument(String name, String state, Value value) {}
    record ObjectValue(PlDebugTypeGraph.Ref type, String constructorId, List<ObjectArgument> arguments) {}
    record Prepared(Value value, int nodes, int physicalElements, int inputBytes) {}
    record Binding(String kind, Object value) {}
    record Code(String declarations, String preflight, String assignments, List<Binding> keys, List<Binding> values, Set<String> privateNames, List<String> ownedInputLobs) {
        int slots() { return keys.size() + values.size(); }
    }
    private final Map<PlDebugTypeGraph.Ref, PlDebugTypeGraph.Node> types = new LinkedHashMap<>();
    private final PlDebugTypeGraph.Graph graph;
    private final Set<PlDebugTypeGraph.Ref> validated=new HashSet<>();
    private int nodes;
    private int physicalElements;

    private PlDebugCompositeInput(PlDebugTypeGraph.Graph graph) {
        this.graph=graph;
        for (var node : graph.nodes())if(types.putIfAbsent(node.reference(), node)!=null)throw new IllegalArgumentException("Duplicate composite input type identity");
    }

    static Prepared prepare(PlDebugTypeGraph.Graph graph, PlDebugTypeGraph.Ref root, JsonElement payload) {
        return prepare(graph,root,payload,PlDebugTarget.MAX_INPUT_BYTES);
    }

    static Prepared prepare(PlDebugTypeGraph.Graph graph, PlDebugTypeGraph.Ref root, JsonElement payload,int remaining) {
        var parser = new PlDebugCompositeInput(graph);
        int bytes=payloadBytes(payload,PlDebugTarget.MAX_INPUT_BYTES,0);
        bytes-=text(object(payload,Set.of("kind","value")).get("kind")).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        if(bytes>remaining)throw new IllegalArgumentException("Typed debug input byte budget exceeded");
        Value value = parser.composite(root, payload, 0);
        return new Prepared(value, parser.nodes, parser.physicalElements,bytes);
    }

    static int payloadBytes(JsonElement value,int remaining,int depth) {
        if(depth>32)throw new IllegalArgumentException("Typed debug input nesting budget exceeded");
        if(value==null||value.isJsonNull())return 0;
        if(value.isJsonPrimitive())return PlDebugTarget.inputPayloadBytes(value,remaining,depth);
        if(value.isJsonObject()) {
            var object=value.getAsJsonObject();var kind=object.get("kind");var data=object.get("value");
            if(object.keySet().equals(Set.of("kind","value"))&&kind!=null&&kind.isJsonPrimitive()&&kind.getAsJsonPrimitive().isString()&&"blob".equals(kind.getAsString())&&data!=null&&data.isJsonObject()) {
                var binary=data.getAsJsonObject();var encoding=binary.get("encoding");var raw=binary.get("data");
                if(binary.keySet().equals(Set.of("encoding","data"))&&encoding!=null&&encoding.isJsonPrimitive()&&encoding.getAsJsonPrimitive().isString()&&"base64".equals(encoding.getAsString())&&raw!=null&&raw.isJsonPrimitive()&&raw.getAsJsonPrimitive().isString()) {
                    String text=raw.getAsString();int padding=text.endsWith("==")?2:text.endsWith("=")?1:0;long bytes=10L+(long)text.length()/4*3-padding;
                    if(text.length()%4!=0||bytes>remaining)throw new IllegalArgumentException("Typed LOB input byte budget exceeded");
                    return (int)bytes;
                }
            }
        }
        int bytes=0;
        if(value.isJsonArray())for(var child:value.getAsJsonArray())bytes+=payloadBytes(child,remaining-bytes,depth+1);
        else for(var child:value.getAsJsonObject().asMap().values())bytes+=payloadBytes(child,remaining-bytes,depth+1);
        return bytes;
    }

    static void requireInputAdapter(PlDebugTypeGraph.Graph graph, PlDebugTypeGraph.Ref root) {
        var pending=new java.util.ArrayDeque<PlDebugTypeGraph.Ref>();
        var seen=new HashSet<PlDebugTypeGraph.Ref>();
        pending.add(root);
        while(!pending.isEmpty()) {
            var ref=pending.removeFirst();
            if(!seen.add(ref))continue;
            var node=graph.nodes().stream().filter(item->item.reference().equals(ref)).findFirst().orElseThrow();
            if(!Set.of("OBJECT","PL/SQL RECORD","COLLECTION").contains(node.definition().get("TYPECODE")))throw new IllegalArgumentException("No verified composite input type adapter");
            Set<String> fields=new HashSet<>();
            for(var attribute:node.attributes())if(attribute.get("ATTR_NAME")==null||!fields.add(attribute.get("ATTR_NAME")))throw new IllegalArgumentException("Incomplete or duplicate composite input field identity");
            if("COLLECTION".equals(node.definition().get("TYPECODE"))) {
                if(node.collections().size()!=1)throw new IllegalArgumentException("Incomplete collection input identity");
                String index=node.collections().getFirst().get("INDEX_BY");
                if(index!=null&&!Set.of("VARCHAR2","BINARY_INTEGER","PLS_INTEGER").contains(index))throw new IllegalArgumentException("No verified collection index adapter");
            }
            if("OBJECT".equals(node.definition().get("TYPECODE"))) {
                if(node.reference().packageName()!=null||node.objectAccess()!=null&&!"type_only_verified".equals(node.objectAccess().state()))throw new IllegalArgumentException("Object type access has not been verified; inspect its type-only preparation result");
                if("NO".equals(node.definition().get("FINAL"))&&node.objectAccess()==null)throw new IllegalArgumentException("Dynamic object type access has not been verified");
                // Atomic NULL does not execute a constructor or touch any attributes.
                continue;
            }
            for(var row:node.attributes())addChild(pending,row,"ATTR_TYPE_");
            for(var row:node.collections())addChild(pending,row,"ELEM_TYPE_");
        }
    }

    private static void addChild(java.util.ArrayDeque<PlDebugTypeGraph.Ref> pending, Map<String,String> row, String prefix) {
        if(row.get(prefix+"MOD")!=null)throw new IllegalArgumentException("No verified composite reference input adapter");
        if(row.get(prefix+"OWNER")!=null||row.get(prefix+"PACKAGE")!=null)pending.add(new PlDebugTypeGraph.Ref(row.get(prefix+"OWNER"),row.get(prefix+"PACKAGE"),row.get(prefix+"NAME")));
        else if(row.get(prefix+"NAME")==null||!Set.of("NUMBER","VARCHAR2","CHAR","NCHAR","NVARCHAR2","BOOLEAN","PL/SQL BOOLEAN","DATE","TIMESTAMP","TIMESTAMP WITH TIME ZONE","TIMESTAMP WITH LOCAL TIME ZONE","RAW","BINARY_FLOAT","BINARY_DOUBLE","INTERVAL YEAR TO MONTH","INTERVAL DAY TO SECOND","CLOB","BLOB").contains(PlDebugTarget.builtinType(row,prefix)))throw new IllegalArgumentException("No verified composite leaf input adapter");
    }

    static boolean localTimeZone(Prepared input) {return localTimeZone(input.value());}
    private static boolean localTimeZone(Value value) {
        if("timestamp_ltz".equals(value.kind()))return true;
        if(value.value()==null)return false;
        if("record".equals(value.kind()))return ((List<?>)value.value()).stream().map(Field.class::cast).anyMatch(field->localTimeZone(field.value()));
        if("collection".equals(value.kind()))return ((List<?>)value.value()).stream().map(Entry.class::cast).anyMatch(entry->localTimeZone(entry.value()));
        if("object".equals(value.kind()))return ((ObjectValue)value.value()).arguments().stream().anyMatch(argument->argument.value()!=null&&localTimeZone(argument.value()));
        return false;
    }

    private Value composite(PlDebugTypeGraph.Ref reference, JsonElement payload, int depth) {
        guard(depth);
        if(validated.add(reference))requireInputAdapter(graph,reference);
        var type = types.get(reference);
        if (type == null) throw new IllegalArgumentException("Incomplete composite input type identity");
        boolean record = "PL/SQL RECORD".equals(type.definition().get("TYPECODE"));
        boolean sqlObject="OBJECT".equals(type.definition().get("TYPECODE"));
        String kind = sqlObject ? "object" : record ? "record" : "collection";
        var object = object(payload, Set.of("kind", "value"));
        if (!kind.equals(text(object.get("kind")))) throw new IllegalArgumentException("Composite input kind does not match its declared type");
        JsonElement value = object.get("value");
        if (value.isJsonNull()) {
            if (record || !sqlObject && type.collections().getFirst().get("INDEX_BY") != null) throw new IllegalArgumentException("Records and associative arrays have no atomic NULL input");
            return new Value(kind, null);
        }
        if(sqlObject)return objectValue(reference,type,value,depth);
        if (!value.isJsonArray()) throw new IllegalArgumentException("Composite input requires an explicit field or entry array");
        if (value.getAsJsonArray().size() > MAX_NODES - nodes) throw new IllegalArgumentException("Composite input node budget exceeded");
        if (record) {
            Map<String, Map<String, String>> attributes = new LinkedHashMap<>();
            for (var attribute : type.attributes()) attributes.put(attribute.get("ATTR_NAME"), attribute);
            List<Field> fields = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            for (JsonElement element : value.getAsJsonArray()) {
                var field = object(element, Set.of("name", "value"));
                String name = text(field.get("name"));
                var attribute = attributes.get(name);
                if (attribute == null || !seen.add(name)) throw new IllegalArgumentException("Unknown or duplicate exact record field name");
                fields.add(new Field(name, child(attribute, "ATTR_TYPE_", field.get("value"), depth + 1)));
            }
            return new Value(kind, List.copyOf(fields));
        }
        var definition = type.collections().getFirst();
        String indexType = definition.get("INDEX_BY");
        boolean stringIndex = "VARCHAR2".equals(indexType);
        List<Entry> entries = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int maximum = 0;
        for (JsonElement element : value.getAsJsonArray()) {
            var entry = object(element, Set.of("index", "value"));
            String index = text(entry.get("index"));
            if (stringIndex) {
                if (index.isEmpty()) throw new IllegalArgumentException("An associative array key cannot be an Oracle empty string");
            } else {
                int numeric;
                try { numeric = Integer.parseInt(index); }
                catch (NumberFormatException error) { throw new IllegalArgumentException("Collection index must be a signed 32-bit decimal string"); }
                if (!Integer.toString(numeric).equals(index)) throw new IllegalArgumentException("Collection index must be a canonical decimal string");
                if (indexType == null) {
                    if (numeric < 1 || numeric > MAX_NODES) throw new IllegalArgumentException("Collection physical extension budget exceeded");
                    maximum = Math.max(maximum, numeric);
                }
            }
            if (!seen.add(index)) throw new IllegalArgumentException("Duplicate exact collection index");
            entries.add(new Entry(index, child(definition, "ELEM_TYPE_", entry.get("value"), depth + 1)));
        }
        if (indexType == null) {
            if (maximum > MAX_NODES - physicalElements) throw new IllegalArgumentException("Cumulative collection physical extension budget exceeded");
            physicalElements += maximum;
            entries.sort(java.util.Comparator.comparingInt(entry -> Integer.parseInt(entry.index())));
            String upperBound = definition.get("UPPER_BOUND");
            if ("VARYING ARRAY".equals(definition.get("COLL_TYPE")) && upperBound != null && maximum > new BigDecimal(upperBound).intValueExact()) throw new IllegalArgumentException("VARRAY upper bound exceeded");
            if ("VARYING ARRAY".equals(definition.get("COLL_TYPE")) && maximum != entries.size()) throw new IllegalArgumentException("VARRAY input cannot contain holes");
        }
        return new Value(kind, List.copyOf(entries));
    }

    private Value objectValue(PlDebugTypeGraph.Ref reference,PlDebugTypeGraph.Node type,JsonElement value,int depth) {
        var payload=object(value,Set.of("type","constructorId","arguments"));
        var rawIdentity=payload.get("type");
        var identity=object(rawIdentity,rawIdentity!=null&&rawIdentity.isJsonObject()&&rawIdentity.getAsJsonObject().has("packageName")?Set.of("owner","packageName","typeName"):Set.of("owner","typeName"));
        if(identity.has("packageName")&&!identity.get("packageName").isJsonNull())throw new IllegalArgumentException("Object construction requires a verified SQL type");
        var actual=new PlDebugTypeGraph.Ref(text(identity.get("owner")),null,text(identity.get("typeName")));
        if(!PlDebugObjectConstructors.assignable(graph,actual,reference))throw new IllegalArgumentException("Object construction type cannot be assigned to the verified declared type");
        type=types.get(actual);
        if(validated.add(actual))requireInputAdapter(graph,actual);
        String id=text(payload.get("constructorId"));
        var metadata=PlDebugObjectConstructors.callables(new PlDebugTypeGraph.Graph(List.copyOf(types.values()),List.of()),type);
        if("not_instantiable".equals(metadata.state()))throw new IllegalArgumentException("The selected object type is not instantiable; choose a verified subtype or SQL NULL");
        if(!"resolved".equals(metadata.state()))throw new IllegalArgumentException("Object constructor metadata is unresolved; refresh its preview");
        var constructor=metadata.constructors().stream().filter(item->item.id().equals(id)).findFirst().orElseThrow(()->new IllegalArgumentException("Unknown or hidden object constructor; refresh its preview"));
        var arguments=payload.get("arguments");
        if(!arguments.isJsonArray()||arguments.getAsJsonArray().size()!=constructor.parameters().size())throw new IllegalArgumentException("Object construction requires explicit values or defaults for its exact parameters");
        List<ObjectArgument> parsed=new ArrayList<>();Set<String> seen=new HashSet<>(),supplied=new HashSet<>();
        for(var element:arguments.getAsJsonArray()) {
            if(!element.isJsonObject())throw new IllegalArgumentException("Invalid object constructor argument");
            var argument=element.getAsJsonObject();String state=text(argument.get("state"));
            object(element,"value".equals(state)?Set.of("name","state","value"):Set.of("name","state"));
            String name=text(argument.get("name"));
            var formal=constructor.parameters().stream().filter(item->item.name().equals(name)).findFirst().orElseThrow(()->new IllegalArgumentException("Unknown exact object constructor parameter"));
            if(!seen.add(name))throw new IllegalArgumentException("Duplicate object constructor parameter");
            if("default".equals(state)&&formal.defaulted())parsed.add(new ObjectArgument(name,state,null));
            else if("value".equals(state)){
                supplied.add(name);
                var decodingType=formal.type();
                if(PlDebugObjectConstructors.numericCarrier(decodingType)!=null){decodingType=new LinkedHashMap<>(decodingType);decodingType.put("ATTR_TYPE_NAME","NUMBER");}
                parsed.add(new ObjectArgument(name,state,child(decodingType,"ATTR_TYPE_",argument.get("value"),depth+1)));
            }
            else throw new IllegalArgumentException("Object constructor parameter has no verified default");
        }
        PlDebugObjectConstructors.select(new PlDebugTypeGraph.Graph(List.copyOf(types.values()),List.of()),type,id,supplied);
        return new Value("object",new ObjectValue(actual,id,List.copyOf(parsed)));
    }

    private Value child(Map<String, String> row, String key, JsonElement payload, int depth) {
        if (row.get(key + "OWNER") != null || row.get(key + "PACKAGE") != null) {
            return composite(new PlDebugTypeGraph.Ref(row.get(key + "OWNER"), row.get(key + "PACKAGE"), row.get(key + "NAME")), payload, depth);
        }
        guard(depth);
        var object = object(payload, Set.of("kind", "value"));
        String kind = text(object.get("kind"));
        String type = PlDebugTarget.builtinType(row,key);
        boolean allowed = switch (type) {
            case "NUMBER" -> "number".equals(kind) || "boolean".equals(kind) && "1".equals(row.get("PRECISION")) && "0".equals(row.get("SCALE"));
            case "BOOLEAN", "PL/SQL BOOLEAN" -> "boolean".equals(kind);
            case "VARCHAR2", "CHAR", "NCHAR", "NVARCHAR2" -> "text".equals(kind);
            case "DATE" -> "date".equals(kind);
            case "TIMESTAMP" -> "timestamp".equals(kind);
            case "TIMESTAMP WITH TIME ZONE" -> "timestamp_tz".equals(kind);
            case "TIMESTAMP WITH LOCAL TIME ZONE" -> "timestamp_ltz".equals(kind);
            case "RAW" -> "raw".equals(kind);
            case "CLOB" -> "clob".equals(kind);
            case "BLOB" -> "blob".equals(kind);
            case "BINARY_FLOAT", "BINARY_DOUBLE" -> type.toLowerCase(java.util.Locale.ROOT).equals(kind);
            case "INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND" -> "text".equals(kind);
            default -> false;
        };
        if (!allowed) throw new IllegalArgumentException("Composite leaf input kind does not match its declared type");
        JsonElement value = object.get("value");
        if (value.isJsonNull()) return new Value(kind, null);
        if("clob".equals(kind)||"blob".equals(kind)) {
            var parameter=new com.dbx.agent.PlDebugParam();parameter.setTypedValue(payload);
            var argument=new PlDebugTarget.Argument("composite field",1,1,0,"IN",type,null,null,null,"N");
            return new Value(kind,PlDebugTarget.lobInput(argument,parameter,"value",PlDebugTarget.MAX_INPUT_BYTES));
        }
        if(PlDebugTarget.intervalKind(type)!=null)return new Value(kind,PlDebugTarget.intervalText(text(value),"INTERVAL DAY TO SECOND".equals(type)));
        if ("binary_float".equals(kind)||"binary_double".equals(kind)) return new Value(kind,PlDebugTarget.binaryFloatHex(text(value),"binary_double".equals(kind)));
        if ("raw".equals(kind)) {
            var parameter=new com.dbx.agent.PlDebugParam();parameter.setTypedValue(payload);
            return new Value(kind,PlDebugTarget.rawInput(parameter,"value"));
        }
        if("timestamp_tz".equals(kind)||"timestamp_ltz".equals(kind)) {
            var parameter=new com.dbx.agent.PlDebugParam();parameter.setTypedValue(payload);
            var argument=new PlDebugTarget.Argument("composite field",1,1,0,"IN",type,null,null,null,"N");
            return new Value(kind,PlDebugTarget.scalarInput(argument,parameter,"value"));
        }
        if ("boolean".equals(kind)) {
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) throw new IllegalArgumentException("BOOLEAN input must be a JSON boolean");
            return new Value(kind, value.getAsBoolean());
        }
        String text = text(value);
        if("date".equals(kind)||"timestamp".equals(kind))return new Value(kind,PlDebugTarget.temporalInput(text,"timestamp".equals(kind),"composite field"));
        if ("number".equals(kind)) {
            if (!text.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) throw new IllegalArgumentException("NUMBER input requires an explicit decimal string");
            BigDecimal number;
            try { number = new BigDecimal(text); }
            catch (NumberFormatException error) { throw new IllegalArgumentException("Invalid NUMBER input"); }
            long exponent = (long) number.precision() - number.scale() - 1;
            if (number.signum() != 0 && (exponent < -130 || exponent >= 126) || number.stripTrailingZeros().precision() > 40) throw new IllegalArgumentException("NUMBER input exceeds exact decimal precision or range");
            return new Value(kind, number);
        }
        return new Value(kind, text);
    }

    private void guard(int depth) {
        if (depth > 16 || ++nodes > MAX_NODES) throw new IllegalArgumentException("Composite input node or depth budget exceeded");
    }

    private static JsonObject object(JsonElement value, Set<String> keys) {
        if (value == null || !value.isJsonObject() || !value.getAsJsonObject().keySet().equals(keys)) throw new IllegalArgumentException("Incomplete or unexpected composite input fields");
        return value.getAsJsonObject();
    }

    private static String text(JsonElement value) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw new IllegalArgumentException("Composite text and indexes must be JSON strings");
        return value.getAsString();
    }

    static Code render(PlDebugTypeGraph.Graph graph, PlDebugTypeGraph.Ref root, Prepared input, String prefix, String variable, String checkContext) {
        if (!prefix.matches("[A-Z][A-Z0-9_]{0,24}") || !variable.matches("[A-Z][A-Z0-9_]*") || !checkContext.matches("[A-Z][A-Z0-9_]*")) throw new IllegalArgumentException("Invalid private input identity");
        var writer = new Writer(graph, prefix, checkContext);
        String assignments = writer.composite(root, input.value(), variable);
        if ((long) writer.declarations.length() + writer.preflight.length() + assignments.length() > 1_048_576
            || (writer.declarations.toString() + writer.preflight + assignments).getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 1_048_576
            || writer.keys.size() + writer.values.size() > 16384) throw new IllegalArgumentException("Composite input SQL or bind budget exceeded");
        return new Code(writer.declarations.toString(), writer.preflight.toString(), assignments, List.copyOf(writer.keys), List.copyOf(writer.values), Set.copyOf(writer.names),List.copyOf(writer.ownedInputLobs));
    }

    private static final class Writer {
        final Map<PlDebugTypeGraph.Ref, PlDebugTypeGraph.Node> types = new LinkedHashMap<>();
        final String prefix;
        final String checkContext;
        final Sql declarations = new Sql();
        final Sql preflight = new Sql();
        final List<Binding> keys = new ArrayList<>();
        final List<Binding> values = new ArrayList<>();
        final Set<String> names = new HashSet<>();
        final List<String> ownedInputLobs=new ArrayList<>();
        int identity;
        Writer(PlDebugTypeGraph.Graph graph, String prefix, String checkContext) {
            this.prefix=prefix; this.checkContext=checkContext;
            for(var type:graph.nodes())types.put(type.reference(),type);
        }
        String name() {
            String name=prefix+(identity++);
            if(name.length()>30)throw new IllegalArgumentException("Private input identifier budget exceeded");
            names.add(name);return name;
        }
        String composite(PlDebugTypeGraph.Ref reference, Value value, String variable) {
            var type=types.get(reference);
            if("object".equals(value.kind()))return object(type,value,variable);
            if("record".equals(value.kind())) {
                Sql sql=new Sql();
                for(Object item:(List<?>)value.value()) {
                    var field=(Field)item;
                    var attribute=type.attributes().stream().filter(row->field.name().equals(row.get("ATTR_NAME"))).findFirst().orElseThrow();
                    sql.append(child(attribute,"ATTR_TYPE_",field.value(),variable+".\""+field.name().replace("\"","\"\"")+"\""));
                }
                return sql.toString();
            }
            if(value.value()==null)return variable+" := NULL;\n";
            var definition=type.collections().getFirst();
            String indexType=definition.get("INDEX_BY");boolean stringIndex="VARCHAR2".equals(indexType);
            List<?> entries=(List<?>)value.value();List<String> keyNames=new ArrayList<>();
            String seen=null;
            if(stringIndex) {
                String seenType=name();seen=name();
                declarations.append("TYPE ").append(seenType).append(" IS TABLE OF PLS_INTEGER INDEX BY VARCHAR2(32767);\n").append(seen).append(' ').append(seenType).append(";\n");
                preflight.append(checkContext).append(";\n");
            }
            for(Object item:entries) {
                var entry=(Entry)item;String key=name();keyNames.add(key);
                declarations.append(key).append(stringIndex?" VARCHAR2(32767);\n":" BINARY_INTEGER;\n");
                preflight.append(key).append(" := ?;\n");keys.add(new Binding(stringIndex?"text":"number",stringIndex?entry.index():new BigDecimal(entry.index())));
                if(stringIndex)preflight.append("IF ").append(seen).append(".EXISTS(").append(key).append(") THEN RAISE_APPLICATION_ERROR(-20994,'Collection keys merge in session NLS context'); END IF;\n")
                    .append(seen).append('(').append(key).append(") := 1;\nIF ").append(seen).append(".COUNT <> ").append(keyNames.size()).append(" THEN RAISE_APPLICATION_ERROR(-20994,'Collection key count did not grow'); END IF;\n");
            }
            Sql sql=new Sql();
            if(stringIndex)sql.append(checkContext).append(";\n");
            if(indexType!=null)sql.append(variable).append(".DELETE;\n");
            else if(entries.isEmpty())sql.append(variable).append(" := ").append(reference.declaration()).append("();\n");
            for(int i=0;i<entries.size();i++) {
                var entry=(Entry)entries.get(i);String element=name();
                sql.append("DECLARE ").append(element).append(' ').append(childDeclaration(definition,"ELEM_TYPE_",entry.value())).append(";\nBEGIN\n");
                if(stringIndex)sql.append(checkContext).append(";\n");
                sql.append(child(definition,"ELEM_TYPE_",entry.value(),element));
                if(stringIndex)sql.append(checkContext).append(";\nIF ").append(variable).append(".EXISTS(").append(keyNames.get(i)).append(") THEN RAISE_APPLICATION_ERROR(-20994,'Collection key already exists'); END IF;\n");
                if(indexType==null&&i==0)sql.append(variable).append(" := ").append(reference.declaration()).append('(').append(element).append(");\nIF ").append(keyNames.getLast()).append(">1 THEN ").append(variable).append(".EXTEND(").append(keyNames.getLast()).append("-1,1); END IF;\n");
                sql.append(variable).append('(').append(keyNames.get(i)).append(") := ").append(element).append(";\nEND;\n");
            }
            if(indexType==null&&!entries.isEmpty()&&!"VARYING ARRAY".equals(definition.get("COLL_TYPE"))) {
                String previous="0";String hole=name();
                for(String key:keyNames) {
                    sql.append("IF ").append(key).append('>').append(previous).append("+1 THEN FOR ").append(hole).append(" IN ").append(previous).append("+1..").append(key).append("-1 LOOP ").append(variable).append(".DELETE(").append(hole).append("); END LOOP; END IF;\n");previous=key;
                }
            }
            return sql.toString();
        }
        String object(PlDebugTypeGraph.Node type,Value value,String variable) {
            if(value.value()==null)return variable+" := NULL;\n";
            var input=(ObjectValue)value.value();
            var graph=new PlDebugTypeGraph.Graph(List.copyOf(types.values()),List.of());
            type=types.get(input.type());
            Set<String> supplied=new HashSet<>();for(var argument:input.arguments())if("value".equals(argument.state()))supplied.add(argument.name());
            var constructor=PlDebugObjectConstructors.select(graph,type,input.constructorId(),supplied);
            Sql sql=new Sql("DECLARE\n"),assignments=new Sql();List<String> call=new ArrayList<>();
            for(var formal:constructor.parameters()) {
                var argument=input.arguments().stream().filter(item->item.name().equals(formal.name())).findFirst().orElseThrow();
                if("default".equals(argument.state()))continue;
                String local=name();
                String carrier=PlDebugObjectConstructors.numericCarrier(formal.type());
                sql.append(local).append(' ').append(carrier!=null?carrier:childDeclaration(formal.type(),"ATTR_TYPE_",argument.value())).append(";\n");
                assignments.append(child(formal.type(),"ATTR_TYPE_",argument.value(),local));
                call.add('"'+formal.name().replace("\"","\"\"")+"\" => "+local);
            }
            // A no-argument constructor needs no empty DECLARE section.
            if(call.isEmpty())return variable+" := "+input.type().declaration()+"();\n";
            return sql.append("BEGIN\n").append(assignments).append(variable).append(" := ").append(input.type().declaration()).append('(').append(String.join(",",call)).append(");\nEND;\n").toString();
        }
        String child(Map<String,String> row,String key,Value value,String variable) {
            if(row.get(key+"OWNER")!=null||row.get(key+"PACKAGE")!=null)return composite(new PlDebugTypeGraph.Ref(row.get(key+"OWNER"),row.get(key+"PACKAGE"),row.get(key+"NAME")),value,variable);
            if(Set.of("NCHAR","NVARCHAR2").contains(row.get(key+"NAME")))return national((String)value.value(),variable);
            if("clob".equals(value.kind())||"blob".equals(value.kind())) {
                String type="clob".equals(value.kind())?"CLOB":"BLOB",owned=name(),flag=name(),scratch=name();
                declarations.append(owned).append(' ').append(type).append(";\n").append(scratch).append(' ').append(type).append(";\n").append(flag).append(" PLS_INTEGER;\n");ownedInputLobs.add(owned);
                var input=(PlDebugTarget.LobInput)value.value();values.add(new Binding("lob-state",input==null?0:input.empty()?1:2));values.add(new Binding(value.kind(),input));
                return flag+" := ?;\n"+scratch+" := ?;\nIF "+flag+"=0 THEN "+scratch+" := NULL;\nELSIF "+flag+"=1 THEN SYS.DBMS_LOB.CREATETEMPORARY("+owned+",TRUE);"+scratch+" := "+owned+";\nELSIF "+scratch+" IS NULL THEN RAISE_APPLICATION_ERROR(-20995,'LOB input was not transferred');END IF;\n"+variable+" := "+scratch+";\n";
            }
            String interval=PlDebugTarget.intervalKind(PlDebugTarget.builtinType(row,key));
            if(interval!=null) {
                values.add(new Binding("text",value.value()));
                return variable+" := "+("INTERVAL DAY TO SECOND".equals(interval)?"TO_DSINTERVAL(?)":"TO_YMINTERVAL(?)")+";\n";
            }
            if("timestamp_tz".equals(value.kind())||"timestamp_ltz".equals(value.kind()))return zoned(value,variable);
            if("binary_float".equals(value.kind())||"binary_double".equals(value.kind())) {
                values.add(new Binding("text",value.value()));
                return variable+" := SYS.UTL_RAW.CAST_TO_"+value.kind().toUpperCase(java.util.Locale.ROOT)+"(HEXTORAW(?),1);\n";
            }
            if("date".equals(value.kind())||"timestamp".equals(value.kind())) {
                String number=name();declarations.append(number).append(" NUMBER;\n");
                values.add(new Binding("number",value.value()));
                return number+" := ?;\n"+variable+" := "+("date".equals(value.kind())?"DATE '1970-01-01' + "+number+" / 86400":PlDebugTarget.timestampConstruct(number))+";\n";
            }
            values.add(new Binding(value.kind(),value.value()));
            return variable+("boolean".equals(value.kind())?" := (? = 1);\n":" := ?;\n");
        }
        String childDeclaration(Map<String,String> row,String prefix,Value value) {
            if(row.get(prefix+"OWNER")!=null||row.get(prefix+"PACKAGE")!=null)return new PlDebugTypeGraph.Ref(row.get(prefix+"OWNER"),row.get(prefix+"PACKAGE"),row.get(prefix+"NAME")).declaration();
            if(Set.of("NCHAR","NVARCHAR2").contains(row.get(prefix+"NAME")))return "NVARCHAR2(32767)";
            String interval=PlDebugTarget.intervalKind(PlDebugTarget.builtinType(row,prefix));
            if(interval!=null)return "INTERVAL DAY TO SECOND".equals(interval)?"INTERVAL DAY(9) TO SECOND(9)":"INTERVAL YEAR(9) TO MONTH";
            if("clob".equals(value.kind()))return "CLOB";
            if("blob".equals(value.kind()))return "BLOB";
            return switch(value.kind()) { case "number" -> "NUMBER";case "boolean" -> "BOOLEAN";case "text" -> "VARCHAR2(32767)";case "date" -> "DATE";case "timestamp" -> "TIMESTAMP(9)";case "timestamp_tz" -> "TIMESTAMP(9) WITH TIME ZONE";case "timestamp_ltz" -> "TIMESTAMP(9) WITH LOCAL TIME ZONE";case "raw" -> "RAW(32767)";case "binary_float" -> "BINARY_FLOAT";case "binary_double" -> "BINARY_DOUBLE";default -> throw new IllegalArgumentException("Unknown composite element input kind");};
        }
        String zoned(Value value,String variable) {
            boolean ltz="timestamp_ltz".equals(value.kind());
            String scratch=name(),number=name(),wall=name(),offset=ltz?null:name(),region=ltz?null:name();
            declarations.append(scratch).append(ltz?" TIMESTAMP(9) WITH LOCAL TIME ZONE;\n":" TIMESTAMP(9) WITH TIME ZONE;\n").append(number).append(" NUMBER;\n").append(wall).append(" TIMESTAMP(9);\n");
            var tz=ltz?null:(PlDebugTarget.ZonedInput)value.value();
            values.add(new Binding("number",ltz?value.value():tz==null?null:tz.localSeconds()));
            StringBuilder sql=new StringBuilder(number+" := ?;\n");
            if(!ltz) {
                declarations.append(offset).append(" VARCHAR2(6);\n").append(region).append(" VARCHAR2(128);\n");
                values.add(new Binding("text",tz==null?null:tz.offset()));values.add(new Binding("text",tz==null?null:tz.region()));
                sql.append(offset).append(" := ?;\n").append(region).append(" := ?;\n");
            }
            PlDebugTarget.renderZonedValue(sql,scratch,number,wall,offset,region,ltz);
            return sql.append(variable).append(" := ").append(scratch).append(";\n").toString();
        }
        String national(String text,String variable) {
            if(text==null||text.isEmpty())return variable+" := NULL;\n";
            String scratch=name();
            declarations.append(scratch).append(" NVARCHAR2(32767);\n");
            Sql sql=new Sql(scratch+" := NULL;\n");
            for(String chunk:nationalChunks(text)) {
                values.add(new Binding("text",chunk));
                sql.append(scratch).append(" := ").append(scratch).append(" || UNISTR(?);\n");
            }
            return sql.append(variable).append(" := ").append(scratch).append(";\n").toString();
        }
    }

    static List<String> nationalChunks(String text) {
        List<String> chunks=new ArrayList<>();StringBuilder chunk=new StringBuilder();
        for(int offset=0;offset<text.length();) {
            char first=text.charAt(offset);int units=1;
            if(Character.isHighSurrogate(first)) {
                if(offset+1>=text.length()||!Character.isLowSurrogate(text.charAt(offset+1)))throw new IllegalArgumentException("Invalid national input surrogate");
                units=2;
            } else if(Character.isLowSurrogate(first))throw new IllegalArgumentException("Invalid national input surrogate");
            if(chunk.length()+units*5>30000){chunks.add(chunk.toString());chunk.setLength(0);}
            for(int index=0;index<units;index++) {
                char unit=text.charAt(offset+index);chunk.append('\\');
                for(int shift=12;shift>=0;shift-=4)chunk.append("0123456789ABCDEF".charAt((unit>>shift)&15));
            }
            offset+=units;
        }
        if(!chunk.isEmpty())chunks.add(chunk.toString());
        return List.copyOf(chunks);
    }

    static Code nationalCode(String text,String prefix,String variable) {
        var writer=new Writer(new PlDebugTypeGraph.Graph(List.of(),List.of()),prefix, prefix+"CHECK_NLS");
        String assignments=writer.national(text,variable);
        return new Code(writer.declarations.toString(),"",assignments,List.of(),List.copyOf(writer.values),Set.copyOf(writer.names),List.of());
    }

    private static final class Sql {
        private final StringBuilder text = new StringBuilder();
        private int bytes;
        Sql() {}
        Sql(String value) { append(value); }
        Sql append(Object value) {
            String next = String.valueOf(value);
            int cost = next.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            if (cost > 1_048_576 - bytes) throw new IllegalArgumentException("Composite input SQL generation budget exceeded");
            text.append(next); bytes += cost; return this;
        }
        int length() { return text.length(); }
        @Override public String toString() { return text.toString(); }
    }
}
