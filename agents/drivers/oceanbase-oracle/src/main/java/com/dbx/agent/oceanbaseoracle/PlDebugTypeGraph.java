package com.dbx.agent.oceanbaseoracle;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

final class PlDebugTypeGraph {
    record Ref(String owner, String packageName, String typeName) {
        Ref {
            if (owner == null || owner.isEmpty() || typeName == null || typeName.isEmpty()
                || packageName != null && packageName.isEmpty()) throw new IllegalArgumentException("Incomplete declared type identity");
        }
        String declaration() {
            return quote(owner) + "." + (packageName == null ? "" : quote(packageName) + ".") + quote(typeName);
        }
    }
    record Node(Ref reference, Map<String, String> definition, List<Map<String, String>> attributes,
                List<Map<String, String>> collections, PlDebugObjectConstructors.Description constructorSource, PlDebugObjectConstructors.Callables constructorCalls, TypeAccess objectAccess) {
        Node(Ref reference, Map<String,String> definition, List<Map<String,String>> attributes, List<Map<String,String>> collections) {
            this(reference,definition,attributes,collections,null,null,null);
        }
        Node(Ref reference, Map<String,String> definition, List<Map<String,String>> attributes, List<Map<String,String>> collections, PlDebugObjectConstructors.Description source, PlDebugObjectConstructors.Callables calls) {
            this(reference,definition,attributes,collections,source,calls,null);
        }
    }
    record TypeAccess(String state, String sqlState, Integer vendorCode) {}
    record SourceRef(String owner, String name) {}
    record Version(SourceRef reference, List<Map<String, String>> objects, List<Map<String, String>> source) {}
    record Graph(List<Node> nodes, List<Version> versions) {}
    private record Pending(Ref reference, int depth) {}

    static Graph load(Connection connection, List<Ref> roots, boolean allowTypeOnly, long deadlineNanos) throws SQLException {
        return new Loader(connection, roots, allowTypeOnly, deadlineNanos).load();
    }

    private static final class Loader {
        private final Connection connection;
        private final List<Ref> roots;
        private final boolean allowTypeOnly;
        private final long deadline;
        private final Map<Ref, Node> nodes = new LinkedHashMap<>();
        private final Map<SourceRef, Version> versions = new LinkedHashMap<>();
        private final Set<SourceRef> prepared = new LinkedHashSet<>();
        private final Map<Ref,Boolean> constructorTypeVisibility=new LinkedHashMap<>();
        private final Map<Ref,List<Ref>> subtypeMembers=new LinkedHashMap<>();
        private int bytes;
        private int rowsRead;

        Loader(Connection connection, List<Ref> roots, boolean allowTypeOnly, long deadline) {
            this.connection = connection;
            this.roots = List.copyOf(roots);
            this.allowTypeOnly = allowTypeOnly;
            this.deadline = deadline;
        }

        Graph load() throws SQLException {
            ArrayDeque<Pending> pending = new ArrayDeque<>();
            for (Ref root : roots) pending.add(new Pending(root, 0));
            while (!pending.isEmpty()) {
                PlDebugTypeMetadata.remainingSeconds(deadline);
                Pending next = pending.removeFirst();
                Ref ref = next.reference();
                if (nodes.containsKey(ref)) continue;
                if (next.depth() > 16 || nodes.size() >= 256) throw new SQLException("Declared type graph budget exceeded");
                if (ref.packageName() != null) captureVersion(new SourceRef(ref.owner(), ref.packageName()), "PACKAGE");
                else captureVersion(new SourceRef(ref.owner(), ref.typeName()), "TYPE");
                List<Map<String, String>> headers = typeRows(ref, "TYPES", "");
                if (headers.isEmpty() && allowTypeOnly && ref.packageName() != null) {
                    prepareTypes(ref);
                    headers = typeRows(ref, "TYPES", "");
                }
                if (headers.size() != 1) throw new SQLException(headers.isEmpty()
                    ? "Declared type metadata is incomplete; refresh its prepared preview"
                    : "Declared type metadata has contradictory identities");
                Map<String, String> header = headers.getFirst();
                List<Map<String, String>> attributes = typeRows(ref, "TYPE_ATTRS", " ORDER BY ATTR_NO");
                List<Map<String, String>> collections = typeRows(ref, "COLL_TYPES", "");
                String kind = header.get("TYPECODE");
                if (kind == null || "COLLECTION".equals(kind) && collections.size() != 1
                    || !"COLLECTION".equals(kind) && !collections.isEmpty()) {
                    throw new SQLException("Declared type metadata shape is incomplete");
                }
                String count = header.get("ATTRIBUTES");
                if (count != null && !count.equals(Integer.toString(attributes.size()))) {
                    throw new SQLException("Declared type attribute metadata is incomplete");
                }
                PlDebugObjectConstructors.Description constructorSource=null;
                if("OBJECT".equals(kind)&&ref.packageName()==null) {
                    StringBuilder specification=new StringBuilder();
                    for(var row:versions.get(new SourceRef(ref.owner(),ref.typeName())).source())if("TYPE".equals(row.get("TYPE")))specification.append(row.get("TEXT")).append('\n');
                    constructorSource=PlDebugObjectConstructors.read(ref,specification.toString());
                }
                TypeAccess objectAccess=null;
                if("OBJECT".equals(kind)&&ref.packageName()==null&&("NO".equals(header.get("FINAL"))||header.get("SUPERTYPE_OWNER")!=null))objectAccess=verifyTypeAccess(ref);
                nodes.put(ref, new Node(ref, header, attributes, collections, constructorSource,null,objectAccess));
                for (Map<String, String> attribute : attributes) {
                    addReference(pending, attribute, "ATTR_TYPE_", next.depth() + 1);
                }
                for (Map<String, String> collection : collections) {
                    addReference(pending, collection, "ELEM_TYPE_", next.depth() + 1);
                }
                if("OBJECT".equals(kind)&&ref.packageName()==null) {
                    String parentOwner=header.get("SUPERTYPE_OWNER"),parentName=header.get("SUPERTYPE_NAME");
                    if((parentOwner==null)!=(parentName==null))throw new SQLException("Incomplete object supertype identity");
                    if(parentOwner!=null)addPending(pending,new Ref(parentOwner,null,parentName),next.depth()+1);
                    if("NO".equals(header.get("FINAL"))) {
                        var children=subtypes(ref);subtypeMembers.put(ref,children);
                        for(var child:children)addPending(pending,child,next.depth()+1);
                    }
                }
                if(constructorSource!=null&&"syntax_parsed".equals(constructorSource.state()))for(var constructor:constructorSource.constructors())for(var parameter:constructor.parameters()) {
                    if(PlDebugObjectConstructors.builtin(parameter))continue;
                    for(var candidate:PlDebugObjectConstructors.referenceCandidates(ref,parameter)) {
                        Boolean visible=constructorTypeVisibility.get(candidate);
                        if(visible==null) {
                            visible=nodes.containsKey(candidate)||constructorTypeVisible(candidate);
                            constructorTypeVisibility.put(candidate,visible);
                        }
                        if(visible) {
                            if(pending.size()+nodes.size()>=1024)throw new SQLException("Declared type graph edge budget exceeded");
                            pending.add(new Pending(candidate,next.depth()+1));
                        }
                    }
                }
            }
            Graph shape=new Graph(List.copyOf(nodes.values()),List.copyOf(versions.values()));
            for(var node:List.copyOf(nodes.values()))if(node.constructorSource()!=null)nodes.put(node.reference(),new Node(node.reference(),node.definition(),node.attributes(),node.collections(),node.constructorSource(),PlDebugObjectConstructors.callables(shape,node),node.objectAccess()));
            for(var entry:constructorTypeVisibility.entrySet())if(entry.getValue()!=constructorTypeVisible(entry.getKey()))throw new SQLException("A constructor type reference changed during metadata preparation");
            for(var entry:subtypeMembers.entrySet())if(!entry.getValue().equals(subtypes(entry.getKey())))throw new SQLException("Object subtype membership changed during metadata preparation");
            for (Version version : List.copyOf(versions.values())) {
                String kind = version.objects().stream().anyMatch(row -> "TYPE".equals(row.get("OBJECT_TYPE"))) ? "TYPE" : "PACKAGE";
                if (!version.equals(version(version.reference(), kind))) throw new SQLException("A declared type source changed during metadata preparation");
            }
            return new Graph(List.copyOf(nodes.values()), List.copyOf(versions.values()));
        }

        private void addPending(ArrayDeque<Pending> pending,Ref ref,int depth) throws SQLException {
            if(pending.size()+nodes.size()>=1024)throw new SQLException("Declared type graph edge budget exceeded");
            pending.add(new Pending(ref,depth));
        }

        private List<Ref> subtypes(Ref parent) throws SQLException {
            List<Ref> result=new ArrayList<>();Set<Ref> seen=new LinkedHashSet<>();
            for(var row:read("SELECT OWNER,TYPE_NAME FROM SYS.ALL_TYPES WHERE SUPERTYPE_OWNER=? AND SUPERTYPE_NAME=? ORDER BY OWNER,TYPE_NAME",parent.owner(),parent.typeName())) {
                String owner=row.get("OWNER"),name=row.get("TYPE_NAME");
                if(owner==null||owner.isEmpty()||name==null||name.isEmpty())throw new SQLException("Incomplete object subtype identity");
                Ref ref=new Ref(owner,null,name);
                if(!seen.add(ref)||ref.equals(parent))throw new SQLException("Contradictory object subtype identities");
                result.add(ref);
            }
            return List.copyOf(result);
        }

        private TypeAccess verifyTypeAccess(Ref ref) throws SQLException {
            if(!allowTypeOnly)return new TypeAccess("type_access_unverified",null,null);
            String sql="DECLARE TYPE DBX_METADATA_ACCESS IS RECORD(X "+ref.declaration()+"); BEGIN NULL; END;";
            consume(sql);
            try(var statement=PlDebugTypeMetadata.prepare(connection,sql,deadline)) {
                statement.execute();return new TypeAccess("type_only_verified",null,null);
            } catch(SQLException error) {
                String state=error.getSQLState();
                if(error instanceof java.sql.SQLTimeoutException||error.getErrorCode()==1013||"57014".equals(state)||state!=null&&(state.startsWith("08")||state.startsWith("HYT")))throw error;
                return new TypeAccess("type_only_check_failed",state,error.getErrorCode());
            }
        }

        private boolean constructorTypeVisible(Ref ref) throws SQLException {
            var headers=typeRows(ref,"TYPES","");
            if(headers.size()>1)throw new SQLException("Declared type metadata has contradictory identities");
            return headers.size()==1;
        }

        private void addReference(ArrayDeque<Pending> pending, Map<String, String> row, String prefix, int depth) throws SQLException {
            String owner = row.get(prefix + "OWNER");
            String pack = row.get(prefix + "PACKAGE");
            String type = row.get(prefix + "NAME");
            if (owner == null && pack == null) return;
            if (owner == null || type == null) throw new SQLException("Incomplete nested declared type identity");
            if (pending.size() + nodes.size() >= 1024) throw new SQLException("Declared type graph edge budget exceeded");
            pending.add(new Pending(new Ref(owner, pack, type), depth));
        }

        private void captureVersion(SourceRef reference, String kind) throws SQLException {
            if (!versions.containsKey(reference)) versions.put(reference, version(reference, kind));
        }

        private Version version(SourceRef ref) throws SQLException {
            return version(ref, "PACKAGE");
        }

        private Version version(SourceRef ref, String kind) throws SQLException {
            List<Map<String, String>> objects = read("SELECT OBJECT_TYPE,OBJECT_ID,STATUS FROM SYS.ALL_OBJECTS"
                + " WHERE OWNER=? AND OBJECT_NAME=? AND OBJECT_TYPE IN (?,?) ORDER BY OBJECT_TYPE", ref.owner(), ref.name(), kind, kind + " BODY");
            if (objects.isEmpty() || objects.stream().anyMatch(row -> !"VALID".equals(row.get("STATUS")))
                || objects.stream().filter(row -> kind.equals(row.get("OBJECT_TYPE"))).count() != 1) {
                throw new SQLException("The declared type owner object is not confirmed VALID; inspect its compilation errors");
            }
            List<Map<String, String>> source = read("SELECT TYPE,LINE,TEXT FROM SYS.ALL_SOURCE"
                + " WHERE OWNER=? AND NAME=? AND TYPE IN (?,?) ORDER BY TYPE,LINE", ref.owner(), ref.name(), kind, kind + " BODY");
            if ("TYPE".equals(kind)) {
                List<Map<String, String>> completeSource = new ArrayList<>(source);
                for (Map<String, String> object : objects) {
                    String objectKind = object.get("OBJECT_TYPE");
                    if (source.stream().noneMatch(row -> objectKind.equals(row.get("TYPE")))) completeSource.add(ddlSource(ref, objectKind));
                }
                completeSource.sort(java.util.Comparator.comparing(row -> row.get("TYPE")));
                source = List.copyOf(completeSource);
            }
            if (source.isEmpty()) throw new SQLException("The declared type source version could not be verified");
            return new Version(ref, objects, source);
        }

        private Map<String, String> ddlSource(SourceRef ref, String kind) throws SQLException {
            try (var statement = PlDebugTypeMetadata.prepare(connection, "SELECT SYS.DBMS_METADATA.GET_DDL(?,?,?) FROM DUAL", deadline)) {
                statement.setString(1, "TYPE BODY".equals(kind) ? "TYPE_BODY" : "TYPE");
                statement.setString(2, ref.name()); statement.setString(3, ref.owner());
                try (ResultSet result = statement.executeQuery()) {
                    if (!result.next() || ++rowsRead > 8192) throw new SQLException("No bounded declared type DDL was returned");
                    var clob = result.getClob(1);
                    if (clob == null) throw new SQLException("Declared type DDL was not returned");
                    SQLException failure = null;
                    StringBuilder text = new StringBuilder();
                    try (var reader = clob.getCharacterStream()) {
                        char[] buffer = new char[4096]; int count; boolean high = false;
                        while ((count = reader.read(buffer)) != -1) {
                            PlDebugTypeMetadata.remainingSeconds(deadline);
                            for (int index = 0; index < count; index++) {
                                char next = buffer[index]; int cost;
                                if (high) {
                                    if (!Character.isLowSurrogate(next)) throw new SQLException("Invalid UTF-16 in declared type DDL");
                                    cost = 4; high = false;
                                } else if (Character.isHighSurrogate(next)) { high = true; cost = 0; }
                                else {
                                    if (Character.isLowSurrogate(next)) throw new SQLException("Invalid UTF-16 in declared type DDL");
                                    cost = next < 128 ? 1 : next < 2048 ? 2 : 3;
                                }
                                if (cost > 1_048_576 - bytes) throw new SQLException("Declared type metadata byte budget exceeded");
                                bytes += cost;
                            }
                            text.append(buffer, 0, count);
                        }
                        if (high || text.isEmpty() || result.next()) throw new SQLException("Incomplete or contradictory declared type DDL");
                    } catch (java.io.IOException error) { failure = new SQLException("Declared type DDL transfer failed", error); throw failure; }
                    catch (SQLException error) { failure = error; throw error; }
                    finally {
                        try { clob.free(); }
                        catch (SQLException error) { if (failure != null) failure.addSuppressed(error); else throw error; }
                    }
                    Map<String, String> row = Map.of("TYPE", kind, "LINE", "1", "TEXT", text.toString(), "SOURCE_METHOD", "DBMS_METADATA.GET_DDL");
                    for (var field : row.entrySet()) { consume(field.getKey()); if (!"TEXT".equals(field.getKey())) consume(field.getValue()); }
                    return row;
                }
            }
        }

        private void prepareTypes(Ref ref) throws SQLException {
            SourceRef pack = new SourceRef(ref.owner(), ref.packageName());
            if (!prepared.add(pack)) throw new SQLException("Declared type metadata remains incomplete after type-only preparation");
            Version original = versions.get(pack);
            if (!original.equals(version(pack))) throw new SQLException("The declared type package changed before type-only preparation");
            Set<Ref> declarations = new LinkedHashSet<>();
            declarations.add(ref);
            for (Ref root : roots) {
                if (root.owner().equals(ref.owner()) && Objects.equals(root.packageName(), ref.packageName())) declarations.add(root);
            }
            if (declarations.size() > 256) throw new SQLException("Type-only declaration budget exceeded");
            StringBuilder sql = new StringBuilder("DECLARE TYPE DBX_METADATA_ONLY IS RECORD(");
            int index = 0;
            for (Ref declaration : declarations) {
                if (index > 0) sql.append(',');
                sql.append("F").append(index++).append(' ').append(declaration.declaration());
            }
            sql.append("); BEGIN NULL; END;");
            consume(sql.toString());
            try (var statement = PlDebugTypeMetadata.prepare(connection, sql.toString(), deadline)) { statement.execute(); }
            if (!original.equals(version(pack))) throw new SQLException("The declared type package changed after type-only preparation");
        }

        private List<Map<String, String>> typeRows(Ref ref, String suffix, String order) throws SQLException {
            String view = ref.packageName() == null ? "ALL_" + suffix : "ALL_PLSQL_" + suffix;
            String sql = "SELECT * FROM SYS." + view + " WHERE OWNER=? AND TYPE_NAME=?";
            List<Map<String, String>> rows = ref.packageName() == null
                ? read(sql + order, ref.owner(), ref.typeName())
                : read(sql + " AND PACKAGE_NAME=?" + order, ref.owner(), ref.typeName(), ref.packageName());
            for (Map<String, String> row : rows) {
                if (!ref.owner().equals(row.get("OWNER")) || !ref.typeName().equals(row.get("TYPE_NAME"))
                    || ref.packageName() != null && !ref.packageName().equals(row.get("PACKAGE_NAME"))) {
                    throw new SQLException("Declared type metadata did not match its exact identity");
                }
            }
            return rows;
        }

        private List<Map<String, String>> read(String sql, String... bindings) throws SQLException {
            try (var statement = PlDebugTypeMetadata.prepare(connection, sql, deadline)) {
                for (int index = 0; index < bindings.length; index++) statement.setString(index + 1, bindings[index]);
                try (ResultSet result = statement.executeQuery()) {
                    List<Map<String, String>> rows = new ArrayList<>();
                    var metadata = result.getMetaData();
                    while (result.next()) {
                        PlDebugTypeMetadata.remainingSeconds(deadline);
                        if (++rowsRead > 8192) throw new SQLException("Declared type metadata row budget exceeded");
                        Map<String, String> row = new LinkedHashMap<>();
                        for (int index = 1; index <= metadata.getColumnCount(); index++) {
                            String key = metadata.getColumnLabel(index);
                            String value = result.getString(index);
                            consume(key);
                            if (value != null) consume(value);
                            if (row.containsKey(key)) throw new SQLException("Duplicate declared type metadata column");
                            row.put(key, value);
                        }
                        rows.add(Collections.unmodifiableMap(row));
                    }
                    return List.copyOf(rows);
                }
            }
        }

        private void consume(String value) throws SQLException {
            int size = value.getBytes(StandardCharsets.UTF_8).length;
            if (size > 1_048_576 - bytes) throw new SQLException("Declared type metadata byte budget exceeded");
            bytes += size;
        }
    }

    private static String quote(String identifier) { return '"' + identifier.replace("\"", "\"\"") + '"'; }
    private PlDebugTypeGraph() {}
}
