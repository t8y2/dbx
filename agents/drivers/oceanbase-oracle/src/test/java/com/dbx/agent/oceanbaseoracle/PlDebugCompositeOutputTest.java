package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugCompositeOutputTest {
    @Test void temporalLeavesProjectAtTheRealFieldAndUseOnlyScalarComponentFormals() {
        var value=encoder(record(List.of(Map.of("ATTR_NAME","D","ATTR_TYPE_NAME","DATE"),Map.of("ATTR_NAME","T","ATTR_TYPE_NAME","TIMESTAMP(9)"),Map.of("ATTR_NAME","Z","ATTR_TYPE_NAME","TIMESTAMP(9) WITH TIME ZONE"),Map.of("ATTR_NAME","L","ATTR_TYPE_NAME","TIMESTAMP(9) WITH LOCAL TIME ZONE"))));
        assertTrue(value.temporal());var sql=value.declarations();
        assertTrue(sql.contains("TC(K VARCHAR2,NN NUMBER,A NUMBER,B NUMBER,O VARCHAR2,C VARCHAR2)"));
        assertTrue(sql.contains("EXTRACT(SECOND FROM V.\"T\")"));assertTrue(sql.contains("SYS_EXTRACT_UTC(V.\"L\")"));
        assertTrue(sql.contains("CAST(V.\"Z\" AS TIMESTAMP(9))"));assertTrue(sql.contains("CASE WHEN V.\"L\" IS NULL THEN 1 ELSE 0 END"));
        assertFalse(sql.contains("(V TIMESTAMP"));assertFalse(sql.contains("(V DATE"));
        assertTrue(value.privateNames().contains("DBX_J_TC"));
    }
    private static final PlDebugTypeGraph.Ref R = new PlDebugTypeGraph.Ref("S","P","R");
    private static PlDebugTypeGraph.Node record(List<Map<String,String>> fields) {
        return new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),fields,List.of());
    }
    private static PlDebugCompositeOutput encoder(PlDebugTypeGraph.Node... nodes) {
        return new PlDebugCompositeOutput(new PlDebugTypeGraph.Graph(List.of(nodes),List.of()),"DBX_J_","DBX_LEFT");
    }

    @Test
    void requiresExactRootAndPrivateVariableIdentity() {
        var value=encoder(record(List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER"))));
        assertDoesNotThrow(()->value.encode(R,"DBX_VALUE"));
        assertThrows(IllegalArgumentException.class,()->value.encode(new PlDebugTypeGraph.Ref("OTHER","P","R"),"DBX_VALUE"));
        assertThrows(IllegalArgumentException.class,()->value.encode(R,"DBX_VALUE); NULL;"));
    }

    @Test
    void rejectsIncompleteDuplicateAndUnadaptedShapesBeforeGeneratingAnInvocation() {
        var number=Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER");
        assertThrows(IllegalArgumentException.class,()->encoder(record(List.of(number,number))));
        var node=record(List.of(number));
        assertThrows(IllegalArgumentException.class,()->encoder(node,node));
        assertThrows(IllegalArgumentException.class,()->encoder(record(List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_OWNER","S","ATTR_TYPE_PACKAGE","P","ATTR_TYPE_NAME","MISSING")))));
        assertThrows(IllegalArgumentException.class,()->encoder(record(List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","ROWID")))));
    }

    @Test
    void doesNotAssumeEveryCollectionUsesAnIntegerIndexOrEveryObjectIsARecord() {
        var collection=new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","COLLECTION"),List.of(),List.of(Map.of("INDEX_BY","FLOAT","ELEM_TYPE_NAME","NUMBER")));
        assertThrows(IllegalArgumentException.class,()->encoder(collection));
        assertThrows(IllegalArgumentException.class,()->encoder(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","OBJECT"),List.of(),List.of())));
    }

    @Test
    void finalSqlObjectsUseTheirVerifiedIdentityWithoutConstructingOrCollapsingAtomicNull() {
        var ref=new PlDebugTypeGraph.Ref("S",null,"T");
        var node=new PlDebugTypeGraph.Node(ref,Map.of("TYPECODE","OBJECT","FINAL","YES"),List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER")),List.of());
        var value=encoder(node);
        assertDoesNotThrow(value::declarations);
        assertDoesNotThrow(()->value.encode(ref,"DBX_VALUE"));
        assertThrows(IllegalArgumentException.class,()->encoder(new PlDebugTypeGraph.Node(ref,Map.of("TYPECODE","OBJECT","FINAL","NO"),node.attributes(),List.of())));
    }

    @Test void constructorOnlyTypesDoNotBecomeResultEncodersOrDisableAnIndependentOutput() {
        var ref=new PlDebugTypeGraph.Ref("S",null,"T");
        var bad=new PlDebugTypeGraph.Ref("S",null,"CTOR_ONLY");
        var root=new PlDebugTypeGraph.Node(ref,Map.of("TYPECODE","OBJECT","FINAL","YES"),List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER")),List.of());
        var opaque=new PlDebugTypeGraph.Node(bad,Map.of("TYPECODE","OBJECT","FINAL","YES"),List.of(Map.of("ATTR_NAME","R","ATTR_TYPE_NAME","ROWID")),List.of());
        var graph=new PlDebugTypeGraph.Graph(List.of(root,opaque),List.of());
        assertThrows(IllegalArgumentException.class,()->new PlDebugCompositeOutput(graph,"DBX_J_","DBX_LEFT"));
        var output=new PlDebugCompositeOutput(graph,"DBX_J_","DBX_LEFT",List.of(ref));
        assertDoesNotThrow(output::declarations);
        assertThrows(IllegalArgumentException.class,()->output.encode(bad,"DBX_VALUE"));
        assertDoesNotThrow(()->new PlDebugCompositeOutput(graph,"DBX_J_","DBX_LEFT",List.of()).declarations());
    }
}
