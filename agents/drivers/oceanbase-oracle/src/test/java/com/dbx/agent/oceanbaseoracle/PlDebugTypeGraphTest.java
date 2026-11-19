package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugTypeGraphTest {
    private static final PlDebugTypeGraph.Ref ROOT = new PlDebugTypeGraph.Ref("Owner.\"", " P.kg ", "R");
    private static long deadline() { return System.nanoTime() + TimeUnit.SECONDS.toNanos(30); }

    @Test
    void sqlObjectGraphRetainsConstructorSourceEvenWhenMethodViewsAreEmpty() throws Exception {
        Jdbc jdbc = new Jdbc();
        jdbc.sqlObject = true;
        var reference = new PlDebugTypeGraph.Ref(ROOT.owner(),null,"O");
        var graph = PlDebugTypeGraph.load(jdbc.connection(),List.of(reference),false,deadline());
        assertEquals(1,graph.versions().size());
        assertEquals("O",graph.versions().getFirst().reference().name());
        assertEquals("TYPE",graph.versions().getFirst().objects().getFirst().get("OBJECT_TYPE"));
        assertTrue(graph.versions().getFirst().source().stream().anyMatch(row -> "TYPE BODY".equals(row.get("TYPE")) && "original source".equals(row.get("TEXT"))));
        assertEquals("syntax_parsed",graph.nodes().getFirst().constructorSource().state());
        assertEquals("N",graph.nodes().getFirst().constructorSource().constructors().getFirst().parameters().getFirst().name());
        assertEquals(0,jdbc.preparations);
    }

    @Test void constructorOnlyTypeReferencesAndTheirSourcesJoinTheSameFrozenGraph() throws Exception {
        Jdbc jdbc=new Jdbc();jdbc.sqlObject=true;jdbc.constructorChild=true;
        var graph=PlDebugTypeGraph.load(jdbc.connection(),List.of(new PlDebugTypeGraph.Ref(ROOT.owner(),null,"O")),false,deadline());
        assertEquals(List.of("O","C"),graph.nodes().stream().map(node->node.reference().typeName()).toList());
        assertEquals(2,graph.versions().size());
        var calls=graph.nodes().getFirst().constructorCalls();
        assertEquals("resolved",calls.state());
        assertEquals("C",calls.constructors().stream().filter(item->"user-1".equals(item.id())).findFirst().orElseThrow().parameters().getFirst().type().get("ATTR_TYPE_NAME"));
    }

    @Test void constructorReferenceVisibilityChangesAndContradictoryIdentitiesAreNotPublished() {
        Jdbc changed=new Jdbc();changed.sqlObject=true;changed.constructorChild=true;changed.constructorChildDisappears=true;
        var error=assertThrows(SQLException.class,()->PlDebugTypeGraph.load(changed.connection(),List.of(new PlDebugTypeGraph.Ref(ROOT.owner(),null,"O")),false,deadline()));
        assertTrue(error.getMessage().contains("constructor type reference changed"));
        Jdbc contradictory=new Jdbc();contradictory.sqlObject=true;contradictory.constructorChild=true;contradictory.constructorChildContradictory=true;
        var identity=assertThrows(SQLException.class,()->PlDebugTypeGraph.load(contradictory.connection(),List.of(new PlDebugTypeGraph.Ref(ROOT.owner(),null,"O")),false,deadline()));
        assertTrue(identity.getMessage().contains("contradictory identities"));
    }

    @Test void nonFinalObjectsFreezeSubtypeMembershipAndVerifyReferenceAccessWithoutInstances() throws Exception {
        Jdbc jdbc=new Jdbc();jdbc.inheritance=true;
        var root=new PlDebugTypeGraph.Ref(ROOT.owner(),null,"O");
        var graph=PlDebugTypeGraph.load(jdbc.connection(),List.of(root),true,deadline());
        assertEquals(List.of("O","C"),graph.nodes().stream().map(node->node.reference().typeName()).toList());
        assertEquals(2,graph.versions().size());assertEquals(2,jdbc.preparations);
        assertTrue(graph.nodes().stream().allMatch(node->"type_only_verified".equals(node.objectAccess().state())));
        assertDoesNotThrow(()->new PlDebugCompositeOutput(graph,"DBX_J_","DBX_LEFT",List.of(root)).declarations());
        Jdbc changed=new Jdbc();changed.inheritance=true;changed.subtypesDisappear=true;
        var error=assertThrows(SQLException.class,()->PlDebugTypeGraph.load(changed.connection(),List.of(root),true,deadline()));
        assertTrue(error.getMessage().contains("subtype membership changed"));
    }

    @Test void anUnverifiedSubtypeCannotGenerateATreatBranchAndTimeoutIsNotAnAccessDenial() throws Exception {
        Jdbc denied=new Jdbc();denied.inheritance=true;denied.denySubtype=true;
        var root=new PlDebugTypeGraph.Ref(ROOT.owner(),null,"O");
        var graph=PlDebugTypeGraph.load(denied.connection(),List.of(root),true,deadline());
        var child=graph.nodes().getLast();assertEquals("type_only_check_failed",child.objectAccess().state());assertEquals(1031,child.objectAccess().vendorCode());
        var encoder=new PlDebugCompositeOutput(graph,"DBX_J_","DBX_LEFT",List.of(root));
        assertDoesNotThrow(encoder::declarations);assertThrows(IllegalArgumentException.class,()->encoder.encode(child.reference(),"DBX_VALUE"));
        assertThrows(IllegalArgumentException.class,()->new PlDebugCompositeOutput(graph,"DBX_J_","DBX_LEFT",List.of(child.reference())));
        Jdbc timeout=new Jdbc();timeout.inheritance=true;timeout.timeoutSubtype=true;
        assertThrows(java.sql.SQLTimeoutException.class,()->PlDebugTypeGraph.load(timeout.connection(),List.of(root),true,deadline()));
        Jdbc cancel=new Jdbc();cancel.inheritance=true;cancel.cancelSubtype=true;
        var cancelled=assertThrows(SQLException.class,()->PlDebugTypeGraph.load(cancel.connection(),List.of(root),true,deadline()));assertEquals(1013,cancelled.getErrorCode());
    }

    @Test
    void sqlCollectionUsesBoundedActualDdlWhenAllSourceOmitsTheDefinition() throws Exception {
        Jdbc jdbc = new Jdbc(); jdbc.sqlCollection = true;
        var graph = PlDebugTypeGraph.load(jdbc.connection(),List.of(new PlDebugTypeGraph.Ref(ROOT.owner(),null,"NT")),false,deadline());
        assertEquals("DBMS_METADATA.GET_DDL",graph.versions().getFirst().source().getFirst().get("SOURCE_METHOD"));
        assertEquals("CREATE TYPE NT AS TABLE OF NUMBER",graph.versions().getFirst().source().getFirst().get("TEXT"));
        assertEquals(2,jdbc.ddlReads);assertEquals(2,jdbc.ddlFrees);
    }

    @Test
    void ddlReaderPreservesSurrogatePairsAcrossChunksAndDoesNotHidePermissionFailures() throws Exception {
        Jdbc unicode = new Jdbc(); unicode.sqlCollection = true; unicode.ddlText = "x".repeat(4095) + "😀中";
        var graph=PlDebugTypeGraph.load(unicode.connection(),List.of(new PlDebugTypeGraph.Ref(ROOT.owner(),null,"NT")),false,deadline());
        assertEquals(unicode.ddlText,graph.versions().getFirst().source().getFirst().get("TEXT"));
        assertEquals(2,unicode.ddlFrees);
        Jdbc denied = new Jdbc(); denied.sqlCollection = true; denied.ddlDenied = true;
        var error=assertThrows(SQLException.class,()->PlDebugTypeGraph.load(denied.connection(),List.of(new PlDebugTypeGraph.Ref(ROOT.owner(),null,"NT")),false,deadline()));
        assertEquals("42000",error.getSQLState());assertEquals(0,denied.ddlFrees);
    }

    @Test
    void ddlChangesAndOverflowDoNotPublishAnUnverifiedTypeAndAlwaysFreeTheLocator() {
        Jdbc changed = new Jdbc(); changed.sqlCollection = true; changed.changeSource = true;
        assertThrows(SQLException.class,()->PlDebugTypeGraph.load(changed.connection(),List.of(new PlDebugTypeGraph.Ref(ROOT.owner(),null,"NT")),false,deadline()));
        assertEquals(2,changed.ddlFrees);
        Jdbc oversized = new Jdbc(); oversized.sqlCollection = true; oversized.oversizedDdl = true;
        assertThrows(SQLException.class,()->PlDebugTypeGraph.load(oversized.connection(),List.of(new PlDebugTypeGraph.Ref(ROOT.owner(),null,"NT")),false,deadline()));
        assertEquals(1,oversized.ddlFrees);
    }

    @Test
    void sqlConstructorBodyChangesInvalidateThePreparedGraph() {
        Jdbc jdbc = new Jdbc();
        jdbc.sqlObject = true;
        jdbc.changeSource = true;
        assertThrows(SQLException.class,()->PlDebugTypeGraph.load(jdbc.connection(),
            List.of(new PlDebugTypeGraph.Ref(ROOT.owner(),null,"O")),false,deadline()));
        assertEquals(0,jdbc.preparations);
    }

    @Test
    void preparesOnlyTypesAndLoadsTheCompleteReachableRecordCollectionGraph() throws Exception {
        Jdbc jdbc = new Jdbc();
        var graph = PlDebugTypeGraph.load(jdbc.connection(), List.of(ROOT), true, deadline());
        assertEquals(List.of("R", "IA"), graph.nodes().stream().map(node -> node.reference().typeName()).toList());
        assertEquals(1, graph.versions().size());
        assertEquals(1, jdbc.preparations);
        assertEquals("DECLARE TYPE DBX_METADATA_ONLY IS RECORD(F0 \"Owner.\"\"\".\" P.kg \".\"R\"); BEGIN NULL; END;", jdbc.executed.getFirst());
        assertFalse(jdbc.executed.getFirst().contains(":="));
        assertEquals(2, graph.nodes().getFirst().attributes().size());
        assertEquals("BINARY_INTEGER", graph.nodes().get(1).collections().getFirst().get("INDEX_BY"));
    }

    @Test
    void doesNotPrepareAnAlreadyCompleteGraph() throws Exception {
        Jdbc jdbc = new Jdbc();
        jdbc.ready = true;
        assertEquals(2, PlDebugTypeGraph.load(jdbc.connection(), List.of(ROOT), true, deadline()).nodes().size());
        assertEquals(0, jdbc.preparations);
    }

    @Test
    void requiresExplicitPreparationWhenTheDictionaryIsIncomplete() {
        Jdbc jdbc = new Jdbc();
        assertThrows(SQLException.class, () -> PlDebugTypeGraph.load(jdbc.connection(), List.of(ROOT), false, deadline()));
        assertEquals(0, jdbc.preparations);
    }

    @Test
    void refusesInvalidPackagesBeforeAnyTypeOnlyStatement() {
        Jdbc jdbc = new Jdbc();
        jdbc.invalid = true;
        assertThrows(SQLException.class, () -> PlDebugTypeGraph.load(jdbc.connection(), List.of(ROOT), true, deadline()));
        assertEquals(0, jdbc.preparations);
    }

    @Test
    void rejectsAChangedPackageVersionAfterPreparation() {
        Jdbc jdbc = new Jdbc();
        jdbc.changeSource = true;
        assertThrows(SQLException.class, () -> PlDebugTypeGraph.load(jdbc.connection(), List.of(ROOT), true, deadline()));
        assertEquals(1, jdbc.preparations);
    }

    @Test
    void doesNotPublishARecordWithMissingAttributes() {
        Jdbc jdbc = new Jdbc();
        jdbc.ready = true;
        jdbc.missingAttribute = true;
        assertThrows(SQLException.class, () -> PlDebugTypeGraph.load(jdbc.connection(), List.of(ROOT), true, deadline()));
    }

    private static final class Jdbc {
        boolean ready;
        boolean invalid;
        boolean changeSource;
        boolean missingAttribute;
        boolean sqlObject;
        boolean inheritance;
        boolean subtypesDisappear;
        boolean denySubtype;
        boolean timeoutSubtype;
        boolean cancelSubtype;
        int subtypeReads;
        boolean constructorChild;
        boolean constructorChildDisappears;
        boolean constructorChildContradictory;
        int constructorChildReads;
        boolean sqlCollection;
        boolean oversizedDdl;
        boolean ddlDenied;
        String ddlText;
        int ddlReads;
        int ddlFrees;
        int sourceReads;
        int preparations;
        final List<String> executed = new ArrayList<>();

        Connection connection() {
            return proxy(Connection.class, (method, args) -> {
                if (!method.getName().equals("prepareStatement")) return empty(method.getReturnType());
                String sql = (String) args[0];
                Map<Integer, String> bindings = new LinkedHashMap<>();
                return proxy(PreparedStatement.class, (operation, values) -> {
                    if (operation.getName().equals("setString")) bindings.put((int) values[0], (String) values[1]);
                    if (operation.getName().equals("execute")) {
                        if(inheritance&&sql.contains(".\"C\")")) {
                            if(timeoutSubtype)throw new java.sql.SQLTimeoutException("fixture timeout","HYT00");
                            if(cancelSubtype)throw new SQLException("fixture cancelled","72000",1013);
                            if(denySubtype)throw new SQLException("fixture access denied","42000",1031);
                        }
                        executed.add(sql); preparations++; ready = true; return true;
                    }
                    if (operation.getName().equals("executeQuery") && sql.contains("DBMS_METADATA.GET_DDL")) {
                        if(ddlDenied)throw new SQLException("metadata denied","42000");
                        assertEquals("TYPE",bindings.get(1));assertEquals("NT",bindings.get(2));assertEquals(ROOT.owner(),bindings.get(3));
                        ddlReads++;
                        String ddl = ddlText != null ? ddlText : oversizedDdl ? "x".repeat(1_048_577) : changeSource && ddlReads > 1 ? "changed DDL" : "CREATE TYPE NT AS TABLE OF NUMBER";
                        var clob=proxy(java.sql.Clob.class,(call,args2)->switch(call.getName()) {
                            case "getCharacterStream" -> new java.io.StringReader(ddl);
                            case "free" -> { ddlFrees++; yield null; }
                            default -> empty(call.getReturnType());
                        });
                        AtomicInteger row=new AtomicInteger();
                        return proxy(ResultSet.class,(call,args2)->switch(call.getName()) {
                            case "next" -> row.getAndIncrement()==0;
                            case "getClob" -> clob;
                            default -> empty(call.getReturnType());
                        });
                    }
                    if (operation.getName().equals("executeQuery")) return rows(query(sql, bindings));
                    return empty(operation.getReturnType());
                });
            });
        }

        List<Map<String, String>> query(String sql, Map<Integer, String> bindings) {
            if(inheritance) {
                String type=bindings.get(2);
                if(sql.contains("WHERE SUPERTYPE_OWNER")){subtypeReads++;return subtypesDisappear&&subtypeReads>1?List.of():List.of(row("OWNER",ROOT.owner(),"TYPE_NAME","C"));}
                if(sql.contains("ALL_OBJECTS"))return List.of(row("OBJECT_TYPE","TYPE","OBJECT_ID","O".equals(type)?"123":"125","STATUS","VALID"));
                if(sql.contains("ALL_SOURCE"))return List.of(row("TYPE","TYPE","LINE","1","TEXT","O".equals(type)?"TYPE O AS OBJECT(N NUMBER) NOT FINAL":"TYPE C UNDER O(T VARCHAR2(20))"));
                if(sql.contains("ALL_TYPES"))return List.of("O".equals(type)?row("OWNER",ROOT.owner(),"TYPE_NAME",type,"TYPECODE","OBJECT","ATTRIBUTES","1","FINAL","NO","INSTANTIABLE","YES"):row("OWNER",ROOT.owner(),"TYPE_NAME",type,"TYPECODE","OBJECT","ATTRIBUTES","2","FINAL","YES","INSTANTIABLE","YES","SUPERTYPE_OWNER",ROOT.owner(),"SUPERTYPE_NAME","O"));
                if(sql.contains("ALL_TYPE_ATTRS")) {
                    var number=row("OWNER",ROOT.owner(),"TYPE_NAME",type,"ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER","ATTR_NO","1");
                    return "O".equals(type)?List.of(number):List.of(number,row("OWNER",ROOT.owner(),"TYPE_NAME",type,"ATTR_NAME","T","ATTR_TYPE_NAME","VARCHAR2","ATTR_NO","2"));
                }
                if(sql.contains("ALL_COLL_TYPES"))return List.of();
                throw new AssertionError("Unexpected subtype query");
            }
            if (sql.contains("ALL_OBJECTS")) return sqlObject ? constructorChild&&"C".equals(bindings.get(2))?List.of(row("OBJECT_TYPE","TYPE","OBJECT_ID","125","STATUS","VALID")):List.of(row("OBJECT_TYPE","TYPE","OBJECT_ID","123","STATUS","VALID"),row("OBJECT_TYPE","TYPE BODY","OBJECT_ID","124","STATUS","VALID")) : List.of(row("OBJECT_TYPE", sqlCollection?"TYPE":"PACKAGE", "OBJECT_ID", "123", "STATUS", invalid ? "INVALID" : "VALID"));
            if (sql.contains("ALL_SOURCE")) { sourceReads++; if(sqlCollection)return List.of(); if(sqlObject){if(constructorChild&&"C".equals(bindings.get(2)))return List.of(row("TYPE","TYPE","LINE","1","TEXT","TYPE C AS OBJECT(N NUMBER)"));return List.of(row("TYPE","TYPE","LINE","1","TEXT",constructorChild?"TYPE O AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION O(X C) RETURN SELF AS RESULT)":"TYPE O AS OBJECT(N NUMBER, CONSTRUCTOR FUNCTION O(N NUMBER) RETURN SELF AS RESULT)"),row("TYPE","TYPE BODY","LINE","1","TEXT",changeSource&&sourceReads>1?"changed source":"original source"));}return List.of(row("TYPE","PACKAGE","LINE","1","TEXT",changeSource&&preparations>0?"changed source":"original source")); }
            String type = bindings.get(2);
            if(sqlCollection){
                if(sql.contains("ALL_TYPES"))return List.of(row("OWNER",ROOT.owner(),"TYPE_NAME",type,"TYPECODE","COLLECTION","ATTRIBUTES","0"));
                if(sql.contains("ALL_TYPE_ATTRS"))return List.of();
                if(sql.contains("ALL_COLL_TYPES"))return List.of(row("OWNER",ROOT.owner(),"TYPE_NAME",type,"COLL_TYPE","TABLE","ELEM_TYPE_NAME","NUMBER"));
            }
            if (sqlObject) {
                if (sql.contains("ALL_TYPES")) {
                    var header=row("OWNER",ROOT.owner(),"TYPE_NAME",type,"TYPECODE","OBJECT","ATTRIBUTES","1","METHODS","1","FINAL","YES","INSTANTIABLE","YES");
                    if(constructorChild&&"C".equals(type)) {
                        constructorChildReads++;
                        if(constructorChildDisappears&&constructorChildReads>=3)return List.of();
                        if(constructorChildContradictory)return List.of(header,header);
                    }
                    return List.of(header);
                }
                if (sql.contains("ALL_TYPE_ATTRS")) return List.of(row("OWNER",ROOT.owner(),"TYPE_NAME",type,"ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER","ATTR_NO","1"));
                if (sql.contains("ALL_COLL_TYPES")) return List.of();
            }
            if (sql.contains("ALL_PLSQL_TYPES")) return !ready ? List.of() : List.of(identity(type, "TYPECODE", type.equals("R") ? "PL/SQL RECORD" : "COLLECTION", "ATTRIBUTES", type.equals("R") ? "2" : "0"));
            if (sql.contains("ALL_PLSQL_TYPE_ATTRS")) {
                if (!type.equals("R")) return List.of();
                Map<String, String> number = identity(type, "ATTR_NAME", "N", "ATTR_TYPE_NAME", "NUMBER");
                Map<String, String> collection = identity(type, "ATTR_NAME", "ITEMS", "ATTR_TYPE_NAME", "IA", "ATTR_TYPE_OWNER", ROOT.owner(), "ATTR_TYPE_PACKAGE", ROOT.packageName());
                return missingAttribute ? List.of(number) : List.of(number, collection);
            }
            if (sql.contains("ALL_PLSQL_COLL_TYPES")) return type.equals("IA") ? List.of(identity(type, "ELEM_TYPE_NAME", "NUMBER", "INDEX_BY", "BINARY_INTEGER")) : List.of();
            throw new AssertionError("Unexpected metadata query");
        }

        Map<String, String> identity(String type, String... fields) {
            Map<String, String> result = row("OWNER", ROOT.owner(), "PACKAGE_NAME", ROOT.packageName(), "TYPE_NAME", type);
            result.putAll(row(fields));
            return result;
        }

        ResultSet rows(List<Map<String, String>> data) {
            List<String> columns = data.isEmpty() ? List.of() : data.stream().flatMap(row -> row.keySet().stream()).distinct().toList();
            ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (method, args) -> switch (method.getName()) {
                case "getColumnCount" -> columns.size();
                case "getColumnLabel" -> columns.get((int) args[0] - 1);
                default -> empty(method.getReturnType());
            });
            AtomicInteger index = new AtomicInteger(-1);
            return proxy(ResultSet.class, (method, args) -> switch (method.getName()) {
                case "next" -> index.incrementAndGet() < data.size();
                case "getMetaData" -> metadata;
                case "getString" -> data.get(index.get()).get(columns.get((int) args[0] - 1));
                default -> empty(method.getReturnType());
            });
        }
    }

    private static Map<String, String> row(String... entries) {
        Map<String, String> result = new LinkedHashMap<>();
        for (int index = 0; index < entries.length; index += 2) result.put(entries[index], entries[index + 1]);
        return result;
    }
}
