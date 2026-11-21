package com.dbx.agent.oceanbaseoracle;

import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugObjectConstructorsTest {
    @Test void intervalConstructorsPreserveSignatureButShareNativeCompetitionFamily() {
        var target=node("TYPE T AS OBJECT(LABEL VARCHAR2(20),CONSTRUCTOR FUNCTION T(V INTERVAL YEAR TO MONTH DEFAULT NULL) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(V INTERVAL DAY TO SECOND DEFAULT NULL) RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","LABEL","ATTR_TYPE_NAME","VARCHAR2")));
        var graph=new PlDebugTypeGraph.Graph(List.of(target),List.of());var calls=PlDebugObjectConstructors.callables(graph,target);
        assertEquals("resolved",calls.state());assertEquals("INTERVAL YEAR TO MONTH",calls.constructors().get(1).parameters().getFirst().type().get("ATTR_TYPE_NAME"));assertEquals("INTERVAL DAY TO SECOND",calls.constructors().get(2).parameters().getFirst().type().get("ATTR_TYPE_NAME"));
        assertThrows(IllegalArgumentException.class,()->PlDebugObjectConstructors.select(graph,target,"user-1",Set.of("V")));
        var named=node("TYPE T AS OBJECT(LABEL VARCHAR2(20),CONSTRUCTOR FUNCTION T(V INTERVAL YEAR TO MONTH DEFAULT NULL) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(W INTERVAL DAY TO SECOND DEFAULT NULL) RETURN SELF AS RESULT)",target.attributes());
        var namedGraph=new PlDebugTypeGraph.Graph(List.of(named),List.of());
        assertEquals("user-1",PlDebugObjectConstructors.select(namedGraph,named,"user-1",Set.of("V")).id());assertEquals("user-2",PlDebugObjectConstructors.select(namedGraph,named,"user-2",Set.of("W")).id());
        assertThrows(IllegalArgumentException.class,()->PlDebugObjectConstructors.select(namedGraph,named,"user-1",Set.of()));
        for(String type:List.of("INTERVAL YEAR TO MONTH","INTERVAL DAY TO SECOND"))assertTrue(PlDebugObjectConstructors.builtin(read("TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(X "+type+") RETURN SELF AS RESULT)").constructors().getFirst().parameters().getFirst()));
        for(String type:List.of("INTERVAL DAY TO MONTH","INTERVAL YEAR(9) TO MONTH","INTERVAL DAY TO \"SECOND\""))assertEquals("constructor_metadata_unresolved",read("TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(X "+type+") RETURN SELF AS RESULT)").state());
    }

    private static final PlDebugTypeGraph.Ref REF=new PlDebugTypeGraph.Ref("S",null,"T");
    private static PlDebugObjectConstructors.Description read(String text){return PlDebugObjectConstructors.read(REF,text);}

    @Test void integerConstructorFamiliesPreserveDeclarationsAndSystemHiding() {
        var hidden=node("TYPE T AS OBJECT(V NUMBER,CONSTRUCTOR FUNCTION T(V INTEGER) RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","V","ATTR_TYPE_NAME","NUMBER")));
        var graph=new PlDebugTypeGraph.Graph(List.of(hidden),List.of());
        var calls=PlDebugObjectConstructors.callables(graph,hidden);
        assertEquals("resolved",calls.state());
        assertEquals(List.of("user-1"),calls.constructors().stream().map(PlDebugObjectConstructors.Callable::id).toList());
        assertEquals("INTEGER",calls.constructors().getFirst().parameters().getFirst().type().get("ATTR_TYPE_NAME"));
        var overloaded=node("TYPE T AS OBJECT(LABEL VARCHAR2(20),CONSTRUCTOR FUNCTION T(V INTEGER) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(V PLS_INTEGER) RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","LABEL","ATTR_TYPE_NAME","VARCHAR2")));
        var overloadGraph=new PlDebugTypeGraph.Graph(List.of(overloaded),List.of());
        assertEquals("user-1",PlDebugObjectConstructors.select(overloadGraph,overloaded,"user-1",Set.of("V")).id());
        assertEquals("user-2",PlDebugObjectConstructors.select(overloadGraph,overloaded,"user-2",Set.of("V")).id());
        for(String spelling:List.of("INTEGER","PLS_INTEGER","BINARY_INTEGER","SIMPLE_INTEGER")) {
            var source=read("TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(V "+spelling+") RETURN SELF AS RESULT)");
            assertTrue(PlDebugObjectConstructors.builtin(source.constructors().getFirst().parameters().getFirst()));
            var quoted=read("TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(V \""+spelling+"\") RETURN SELF AS RESULT)");
            assertFalse(PlDebugObjectConstructors.builtin(quoted.constructors().getFirst().parameters().getFirst()));
        }
    }

    @Test void integerDefaultAmbiguityUsesCarrierFamilyAndNamedDisambiguation() {
        for(var pair:List.of(List.of("INTEGER","NUMBER"),List.of("PLS_INTEGER","BINARY_INTEGER"),List.of("PLS_INTEGER","SIMPLE_INTEGER"))) {
            var target=node("TYPE T AS OBJECT(LABEL VARCHAR2(20),CONSTRUCTOR FUNCTION T(V "+pair.getFirst()+",D NUMBER DEFAULT 1) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(V "+pair.getLast()+",K VARCHAR2 DEFAULT 'x') RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","LABEL","ATTR_TYPE_NAME","VARCHAR2")));
            var graph=new PlDebugTypeGraph.Graph(List.of(target),List.of());
            assertThrows(IllegalArgumentException.class,()->PlDebugObjectConstructors.select(graph,target,"user-1",Set.of("V")));
            assertEquals("user-1",PlDebugObjectConstructors.select(graph,target,"user-1",Set.of("V","D")).id());
            assertEquals("user-2",PlDebugObjectConstructors.select(graph,target,"user-2",Set.of("V","K")).id());
        }
    }

    @Test void readsCompleteOverloadedConstructorListWithoutInterpretingDefaults() {
        var value=read("CREATE OR REPLACE EDITIONABLE TYPE S.T AS OBJECT(N NUMBER,T VARCHAR2(40), CONSTRUCTOR FUNCTION T(N NUMBER,T VARCHAR2) RETURN SELF AS RESULT, CONSTRUCTOR FUNCTION T(LABEL VARCHAR2 DEFAULT f(1, 'CONSTRUCTOR FUNCTION fake(')) RETURN SELF AS RESULT, MEMBER FUNCTION F RETURN NUMBER) FINAL;");
        assertEquals("syntax_parsed",value.state());assertEquals(2,value.constructors().size());
        assertEquals(List.of("N","T"),value.constructors().getFirst().parameters().stream().map(PlDebugObjectConstructors.Parameter::name).toList());
        assertFalse(value.constructors().getFirst().parameters().getFirst().defaulted());
        assertTrue(value.constructors().getLast().parameters().getFirst().defaulted());
        assertEquals(List.of("VARCHAR2"),value.constructors().getLast().parameters().getFirst().type());
        assertEquals("user-2",value.constructors().getLast().id());
    }

    @Test void commentsQuotesAndAlternativeQuotedDefaultsCannotCreateFakeMembers() {
        var value=read("TYPE \"S\".\"T\" IS OBJECT(\"Quoted. Field\" NUMBER, /* CONSTRUCTOR FUNCTION BAD */ CONSTRUCTOR FUNCTION \"T\"(\"x\" VARCHAR2 := q'[),CONSTRUCTOR FUNCTION fake()]', \"Y\" VARCHAR2 DEFAULT nq'{a,b(''c'')}', Z NUMBER DEFAULT f((1+2),3)) RETURN SELF AS RESULT) NOT FINAL; / -- tail");
        assertEquals("syntax_parsed",value.state());assertEquals(1,value.constructors().size());
        var params=value.constructors().getFirst().parameters();assertEquals(List.of("x","Y","Z"),params.stream().map(PlDebugObjectConstructors.Parameter::name).toList());
        assertTrue(params.stream().allMatch(PlDebugObjectConstructors.Parameter::defaulted));
    }

    @Test void explicitSelfIsExcludedOnlyWithVerifiedIdentityAndMode() {
        var value=read("TYPE T UNDER S.BASE(CONSTRUCTOR FUNCTION T(SELF IN OUT NOCOPY S.T,N IN NUMBER) RETURN SELF AS RESULT) FINAL");
        assertEquals("syntax_parsed",value.state());assertEquals(List.of("N"),value.constructors().getFirst().parameters().stream().map(PlDebugObjectConstructors.Parameter::name).toList());
        for(String declaration:List.of("SELF IN T","SELF IN OUT OTHER","N NUMBER,SELF IN OUT T","SELF IN OUT T DEFAULT NULL","N OUT NUMBER"))assertEquals("constructor_metadata_unresolved",read("TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T("+declaration+") RETURN SELF AS RESULT)").state());
    }

    @Test void unresolvedSourceDoesNotPublishAPartialConstructorList() {
        String prefix="TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(N NUMBER) RETURN SELF AS RESULT";
        for(String source:List.of(prefix,prefix+", CONSTRUCTOR FUNCTION T(X VARCHAR2) RETURN SELF AS RESULT",prefix+") GARBAGE",prefix+",N NUMBER CONSTRUCTOR FUNCTION BAD())",prefix+", CONSTRUCTOR FUNCTION T(N NUMBER DEFAULT) RETURN SELF AS RESULT)","TYPE T WRAPPED xyz","TYPE OTHER AS OBJECT(N NUMBER)","TYPE T AS OBJECT(N NUMBER /*", "TYPE T AS OBJECT(N VARCHAR2 DEFAULT q'[unterminated)")) {
            var value=read(source);assertEquals("constructor_metadata_unresolved",value.state(),source);assertTrue(value.constructors().isEmpty());
        }
        assertEquals("syntax_parsed",read("TYPE T AS OBJECT(N NUMBER)").state());
        assertTrue(read("TYPE T AS OBJECT(N NUMBER)").constructors().isEmpty());
    }

    @Test void typeReferencesAreExactAndNeverTurnIntoExecutableDefaultText() {
        var value=read("TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(X \"Other Owner\".\"Pack\".\"Child\", Y MY_ALIAS DEFAULT evil()) RETURN SELF AS RESULT)");
        assertEquals("syntax_parsed",value.state());
        assertEquals(List.of("Other Owner","Pack","Child"),value.constructors().getFirst().parameters().getFirst().type());
        assertEquals(List.of("MY_ALIAS"),value.constructors().getFirst().parameters().getLast().type());
        var temporal=read("TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(X TIMESTAMP WITH TIME ZONE) RETURN SELF AS RESULT)");
        assertEquals("syntax_parsed",temporal.state());assertEquals(List.of("TIMESTAMP","WITH","TIME","ZONE"),temporal.constructors().getFirst().parameters().getFirst().type());
    }

    @Test void zeroArgumentDeclarationsAndQuotedTypeNamesKeepTheirIdentity() {
        for(String parameters:List.of("()","")) {
            var value=read("TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T"+parameters+" RETURN SELF AS RESULT)");
            assertEquals("syntax_parsed",value.state());assertEquals(1,value.constructors().size());assertTrue(value.constructors().getFirst().parameters().isEmpty());
        }
        var quoted=new PlDebugTypeGraph.Ref("Owner Name",null,"Mixed.Type");
        var value=PlDebugObjectConstructors.read(quoted,"CREATE TYPE \"Owner Name\".\"Mixed.Type\" AS OBJECT(\"constructor\" NUMBER,CONSTRUCTOR FUNCTION \"Mixed.Type\"(\"Quoted Arg\" NUMBER) RETURN SELF AS RESULT)");
        assertEquals("syntax_parsed",value.state());assertEquals("Quoted Arg",value.constructors().getFirst().parameters().getFirst().name());
    }

    static PlDebugTypeGraph.Node node(String declaration,List<Map<String,String>> attributes) {
        return new PlDebugTypeGraph.Node(REF,Map.of("TYPECODE","OBJECT","FINAL","YES","INSTANTIABLE","YES"),attributes,List.of(),read(declaration),null);
    }

    @Test void temporalConstructorsUseCompleteSourceGrammarAndDistinctStrongTypeFamilies() {
        String source="TYPE T AS OBJECT(LABEL VARCHAR2(8),CONSTRUCTOR FUNCTION T(V DATE) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(V TIMESTAMP) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(V TIMESTAMP WITH TIME ZONE) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(V TIMESTAMP WITH LOCAL TIME ZONE) RETURN SELF AS RESULT)";
        var node=node(source,List.of(Map.of("ATTR_NAME","LABEL","ATTR_TYPE_NAME","VARCHAR2")));var graph=new PlDebugTypeGraph.Graph(List.of(node),List.of());
        var calls=PlDebugObjectConstructors.callables(graph,node);assertEquals("resolved",calls.state());
        assertEquals(5,calls.constructors().size());
        for(int index=1;index<=4;index++)assertEquals("user-"+index,PlDebugObjectConstructors.select(graph,node,"user-"+index,Set.of("V")).id());
        for(String spelling:List.of("TIMESTAMP WITH TZ","TIMESTAMP WITH LOCAL TZ","TIMESTAMP WITH \"TIME\" ZONE"))assertEquals("constructor_metadata_unresolved",read("TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(V "+spelling+") RETURN SELF AS RESULT)").state());
        var quoted=read("TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(V TIMESTAMP.\"WITH\".\"TIME ZONE\") RETURN SELF AS RESULT)");
        assertEquals("syntax_parsed",quoted.state());assertFalse(PlDebugObjectConstructors.builtin(quoted.constructors().getFirst().parameters().getFirst()));
    }

    @Test void dictionaryPrecisionDoesNotInventAnExtraSystemConstructorOrLoseDefaultsAmbiguity() {
        var attribute=Map.of("ATTR_NAME","V","ATTR_TYPE_NAME","TIMESTAMP(9) WITH TIME ZONE");
        var hidden=node("TYPE T AS OBJECT(V TIMESTAMP(9) WITH TIME ZONE,CONSTRUCTOR FUNCTION T(V TIMESTAMP WITH TIME ZONE) RETURN SELF AS RESULT)",List.of(attribute));
        var hiddenGraph=new PlDebugTypeGraph.Graph(List.of(hidden),List.of());
        assertEquals(List.of("user-1"),PlDebugObjectConstructors.callables(hiddenGraph,hidden).constructors().stream().map(PlDebugObjectConstructors.Callable::id).toList());
        assertEquals("TIMESTAMP(9) WITH TIME ZONE",attribute.get("ATTR_TYPE_NAME"));
        var ambiguous=node("TYPE T AS OBJECT(LABEL VARCHAR2(8),CONSTRUCTOR FUNCTION T(V DATE,D NUMBER DEFAULT 1) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(V DATE,K VARCHAR2 DEFAULT 'x') RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","LABEL","ATTR_TYPE_NAME","VARCHAR2")));
        var graph=new PlDebugTypeGraph.Graph(List.of(ambiguous),List.of());
        assertThrows(IllegalArgumentException.class,()->PlDebugObjectConstructors.select(graph,ambiguous,"user-1",Set.of("V")));
        assertEquals("user-1",PlDebugObjectConstructors.select(graph,ambiguous,"user-1",Set.of("V","D")).id());
        assertEquals("user-2",PlDebugObjectConstructors.select(graph,ambiguous,"user-2",Set.of("V","K")).id());
    }

    @Test void hiddenSystemConstructorUsesFullExactSignatureAndDoesNotDiscardUserBehavior() {
        var node=node("TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(N NUMBER) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(LABEL VARCHAR2) RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER")));
        var graph=new PlDebugTypeGraph.Graph(List.of(node),List.of());var calls=PlDebugObjectConstructors.callables(graph,node);
        assertEquals("resolved",calls.state());assertEquals(List.of("user-1","user-2"),calls.constructors().stream().map(PlDebugObjectConstructors.Callable::id).toList());
        assertEquals("user-1",PlDebugObjectConstructors.select(graph,node,"user-1",Set.of("N")).id());
        assertEquals("user-2",PlDebugObjectConstructors.select(graph,node,"user-2",Set.of("LABEL")).id());
        assertThrows(IllegalArgumentException.class,()->PlDebugObjectConstructors.select(graph,node,"attribute-value",Set.of("N")));
        var renamed=node("TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(V NUMBER) RETURN SELF AS RESULT)",node.attributes());
        assertEquals(2,PlDebugObjectConstructors.callables(new PlDebugTypeGraph.Graph(List.of(renamed),List.of()),renamed).constructors().size());
    }

    @Test void objectOverloadsUseGeneratedLocalStaticTypesRatherThanRuntimeSubtypeOrCompositeFamily() {
        var baseRef=new PlDebugTypeGraph.Ref("S",null,"BASE");
        var subRef=new PlDebugTypeGraph.Ref("S",null,"SUB");
        var otherRef=new PlDebugTypeGraph.Ref("S",null,"OTHER");
        var base=new PlDebugTypeGraph.Node(baseRef,Map.of("TYPECODE","OBJECT"),List.of(),List.of());
        var sub=new PlDebugTypeGraph.Node(subRef,Map.of("TYPECODE","OBJECT","SUPERTYPE_OWNER","S","SUPERTYPE_NAME","BASE"),List.of(),List.of());
        var other=new PlDebugTypeGraph.Node(otherRef,Map.of("TYPECODE","OBJECT"),List.of(),List.of());
        var target=node("TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(X S.BASE) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(X S.SUB) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(X S.OTHER) RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER")));
        var graph=new PlDebugTypeGraph.Graph(List.of(base,sub,other,target),List.of());
        for(String id:List.of("user-1","user-2","user-3"))assertEquals(id,PlDebugObjectConstructors.select(graph,target,id,Set.of("X")).id());
        var defaults=node("TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(X S.BASE) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(X S.BASE,Y NUMBER DEFAULT 7) RETURN SELF AS RESULT)",target.attributes());
        var defaultGraph=new PlDebugTypeGraph.Graph(List.of(base,sub,other,defaults),List.of());
        assertThrows(IllegalArgumentException.class,()->PlDebugObjectConstructors.select(defaultGraph,defaults,"user-1",Set.of("X")));
        var mixed=node("TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(X S.SUB,L CHAR) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(X S.BASE,L VARCHAR2) RETURN SELF AS RESULT)",target.attributes());
        var mixedGraph=new PlDebugTypeGraph.Graph(List.of(base,sub,other,mixed),List.of());
        assertThrows(IllegalArgumentException.class,()->PlDebugObjectConstructors.select(mixedGraph,mixed,"user-1",Set.of("X","L")));
    }

    @Test void defaultOmissionChecksEveryCompetingConstructorAndUnresolvedAliasesAreNotScalarGuesses() {
        var node=node("TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(N NUMBER,M NUMBER DEFAULT 7) RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER")));
        var graph=new PlDebugTypeGraph.Graph(List.of(node),List.of());
        assertThrows(IllegalArgumentException.class,()->PlDebugObjectConstructors.select(graph,node,"user-1",Set.of("N")));
        assertDoesNotThrow(()->PlDebugObjectConstructors.select(graph,node,"user-1",Set.of("N","M")));
        for(String type:List.of("MY_ALIAS","\"NUMBER\"","OTHER.T")) {
            var unknown=node("TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(N "+type+") RETURN SELF AS RESULT)",node.attributes());
            assertEquals("constructor_metadata_unresolved",PlDebugObjectConstructors.callables(new PlDebugTypeGraph.Graph(List.of(unknown),List.of()),unknown).state());
        }
    }
}
