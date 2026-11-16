package com.dbx.agent.oceanbaseoracle;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.Set;

/** Reads constructor declarations only; default expressions remain database-owned. */
final class PlDebugObjectConstructors {
    record Parameter(String name, List<String> type, boolean defaulted, boolean quotedType) {}
    record Constructor(String id, List<Parameter> parameters) {}
    record Description(String state, List<Constructor> constructors) {}
    record Formal(String name, Map<String,String> type, boolean defaulted) {}
    record Callable(String id, String origin, List<Formal> parameters) {}
    record Callables(String state, List<Callable> constructors) {}
    private record Token(String text, boolean identifier, boolean quoted) {
        boolean keyword(String word) { return identifier && !quoted && text.equals(word); }
    }

    static Description read(PlDebugTypeGraph.Ref reference, String source) {
        try { return new Description("syntax_parsed", parse(reference, tokens(source))); }
        catch (IllegalArgumentException error) { return new Description("constructor_metadata_unresolved", List.of()); }
    }

    static Callables callables(PlDebugTypeGraph.Graph graph, PlDebugTypeGraph.Node node) {
        if(node.reference().packageName()!=null||!"OBJECT".equals(node.definition().get("TYPECODE"))||!("YES".equals(node.definition().get("FINAL"))||"NO".equals(node.definition().get("FINAL")))
            ||node.constructorSource()==null||!"syntax_parsed".equals(node.constructorSource().state()))return unresolved();
        if("NO".equals(node.definition().get("FINAL"))&&(node.objectAccess()==null||!"type_only_verified".equals(node.objectAccess().state())))return unresolved();
        if(node.objectAccess()!=null&&!"type_only_verified".equals(node.objectAccess().state()))return unresolved();
        if("NO".equals(node.definition().get("INSTANTIABLE")))return new Callables("not_instantiable",List.of());
        if(!"YES".equals(node.definition().get("INSTANTIABLE")))return unresolved();
        List<Callable> users=new ArrayList<>();
        for(var constructor:node.constructorSource().constructors()) {
            List<Formal> parameters=new ArrayList<>();
            for(var parameter:constructor.parameters()) {
                Map<String,String> type=parameterType(graph,node.reference(),parameter);
                if(type==null)return unresolved();
                parameters.add(new Formal(parameter.name(),type,parameter.defaulted()));
            }
            users.add(new Callable(constructor.id(),"user",List.copyOf(parameters)));
        }
        List<Formal> attributes=new ArrayList<>();
        for(var attribute:node.attributes()) {
            if(attribute.get("ATTR_NAME")==null||!knownType(graph,attribute))return unresolved();
            attributes.add(new Formal(attribute.get("ATTR_NAME"),attribute,false));
        }
        var system=new Callable("attribute-value","attribute_value",List.copyOf(attributes));
        boolean hidden=users.stream().anyMatch(user->sameSignature(user,system));
        List<Callable> candidates=new ArrayList<>();
        if(!hidden)candidates.add(system);
        candidates.addAll(users);
        return new Callables("resolved",List.copyOf(candidates));
    }

    private static boolean sameSignature(Callable left,Callable right) {
        if(left.parameters().size()!=right.parameters().size())return false;
        for(int i=0;i<left.parameters().size();i++) {
            var a=left.parameters().get(i);var b=right.parameters().get(i);
            if(!a.name().equals(b.name())||!sameType(a.type(),b.type()))return false;
        }
        return true;
    }

    private static boolean sameType(Map<String,String> left,Map<String,String> right) {
        for(String key:List.of("ATTR_TYPE_OWNER","ATTR_TYPE_PACKAGE"))if(!java.util.Objects.equals(left.get(key),right.get(key)))return false;
        String carrier=numericCarrier(left);
        if(carrier!=null)return carrier.equals(numericCarrier(right));
        return java.util.Objects.equals(PlDebugTarget.builtinType(left,"ATTR_TYPE_"),PlDebugTarget.builtinType(right,"ATTR_TYPE_"));
    }

    static String numericCarrier(Map<String,String> type) {
        if(type.get("ATTR_TYPE_OWNER")!=null||type.get("ATTR_TYPE_PACKAGE")!=null)return null;
        String name=PlDebugTarget.builtinType(type,"ATTR_TYPE_");
        if(name==null)return null;
        return switch(name) {
            case "NUMBER","INTEGER" -> "NUMBER";
            case "PLS_INTEGER","BINARY_INTEGER","SIMPLE_INTEGER" -> "PLS_INTEGER";
            default -> null;
        };
    }

    static boolean assignable(PlDebugTypeGraph.Graph graph,PlDebugTypeGraph.Ref actual,PlDebugTypeGraph.Ref declared) {
        if(actual.packageName()!=null||declared.packageName()!=null)return false;
        Map<PlDebugTypeGraph.Ref,PlDebugTypeGraph.Node> nodes=new LinkedHashMap<>();for(var node:graph.nodes())nodes.put(node.reference(),node);
        var current=nodes.get(actual);Set<PlDebugTypeGraph.Ref> seen=new java.util.HashSet<>();
        while(current!=null&&"OBJECT".equals(current.definition().get("TYPECODE"))) {
            if(!seen.add(current.reference()))throw new IllegalArgumentException("Cyclic object supertype identities");
            if(current.reference().equals(declared))return true;
            String owner=current.definition().get("SUPERTYPE_OWNER"),name=current.definition().get("SUPERTYPE_NAME");
            if(owner==null||name==null)return false;
            current=nodes.get(new PlDebugTypeGraph.Ref(owner,null,name));
        }
        return false;
    }

    static Callable select(PlDebugTypeGraph.Graph graph,PlDebugTypeGraph.Node node,String id,Set<String> supplied) {
        var metadata=callables(graph,node);
        if(!"resolved".equals(metadata.state()))throw new IllegalArgumentException("Object constructor metadata is unresolved; refresh its preview");
        var selected=metadata.constructors().stream().filter(item->item.id().equals(id)).findFirst().orElseThrow(()->new IllegalArgumentException("Unknown or hidden object constructor; refresh its preview"));
        if(!matchesShape(selected,supplied))throw new IllegalArgumentException("Object constructor arguments do not match its required or defaulted parameters");
        Map<String,Formal> actual=new LinkedHashMap<>();
        for(var parameter:selected.parameters())if(supplied.contains(parameter.name()))actual.put(parameter.name(),parameter);
        int matches=0;
        for(var candidate:metadata.constructors()) {
            if(!matchesShape(candidate,supplied))continue;
            boolean compatible=true;
            boolean objectUpcast=false,scalarConversion=false;
            for(var formal:candidate.parameters())if(supplied.contains(formal.name())) {
                var type=actual.get(formal.name()).type();
                if(sameType(type,formal.type()))continue;
                if(type.get("ATTR_TYPE_OWNER")!=null||formal.type().get("ATTR_TYPE_OWNER")!=null) {
                    if(type.get("ATTR_TYPE_OWNER")==null||formal.type().get("ATTR_TYPE_OWNER")==null
                        ||!assignable(graph,new PlDebugTypeGraph.Ref(type.get("ATTR_TYPE_OWNER"),type.get("ATTR_TYPE_PACKAGE"),type.get("ATTR_TYPE_NAME")),new PlDebugTypeGraph.Ref(formal.type().get("ATTR_TYPE_OWNER"),formal.type().get("ATTR_TYPE_PACKAGE"),formal.type().get("ATTR_TYPE_NAME")))) {compatible=false;break;}
                    objectUpcast=true;
                } else {
                    if(!family(type).equals(family(formal.type()))) {compatible=false;break;}
                    scalarConversion=true;
                }
            }
            if(compatible&&!(objectUpcast&&!scalarConversion))matches++;
        }
        if(matches!=1)throw new IllegalArgumentException("The selected constructor and omitted defaults leave an ambiguous object construction");
        return selected;
    }

    private static boolean matchesShape(Callable callable,Set<String> supplied) {
        Set<String> names=new java.util.HashSet<>();
        for(var parameter:callable.parameters()){names.add(parameter.name());if(!parameter.defaulted()&&!supplied.contains(parameter.name()))return false;}
        return names.containsAll(supplied);
    }

    private static String family(Map<String,String> type) {
        if(type.get("ATTR_TYPE_OWNER")!=null||type.get("ATTR_TYPE_PACKAGE")!=null)return "composite";
        String carrier=numericCarrier(type);if(carrier!=null)return carrier;
        String name=PlDebugTarget.builtinType(type,"ATTR_TYPE_");
        if(PlDebugTarget.intervalKind(name)!=null)return "interval";
        return switch(name){case "CHAR","VARCHAR2","NCHAR","NVARCHAR2"->"text";default->name;};
    }

    private static Map<String,String> parameterType(PlDebugTypeGraph.Graph graph,PlDebugTypeGraph.Ref declaring,Parameter parameter) {
        var parts=parameter.type();
        if(builtin(parameter))return Map.of("ATTR_TYPE_NAME",String.join(" ",parts));
        var candidates=referenceCandidates(declaring,parameter);
        var found=graph.nodes().stream().map(PlDebugTypeGraph.Node::reference).filter(candidates::contains).distinct().toList();
        if(found.size()!=1)return null;
        var ref=found.getFirst();Map<String,String> type=new LinkedHashMap<>();type.put("ATTR_TYPE_OWNER",ref.owner());type.put("ATTR_TYPE_PACKAGE",ref.packageName());type.put("ATTR_TYPE_NAME",ref.typeName());
        return java.util.Collections.unmodifiableMap(type);
    }

    static boolean builtin(Parameter parameter) {
        return !parameter.quotedType()&&Set.of("NUMBER","INTEGER","PLS_INTEGER","BINARY_INTEGER","SIMPLE_INTEGER","VARCHAR2","CHAR","NCHAR","NVARCHAR2","BOOLEAN","DATE","TIMESTAMP","TIMESTAMP WITH TIME ZONE","TIMESTAMP WITH LOCAL TIME ZONE","RAW","BINARY_FLOAT","BINARY_DOUBLE","INTERVAL YEAR TO MONTH","INTERVAL DAY TO SECOND","CLOB","BLOB").contains(String.join(" ",parameter.type()));
    }

    static List<PlDebugTypeGraph.Ref> referenceCandidates(PlDebugTypeGraph.Ref declaring,Parameter parameter) {
        var parts=parameter.type();
        List<PlDebugTypeGraph.Ref> candidates=new ArrayList<>();
        if(parts.size()==1)candidates.add(new PlDebugTypeGraph.Ref(declaring.owner(),null,parts.getFirst()));
        else if(parts.size()==2) {
            candidates.add(new PlDebugTypeGraph.Ref(parts.getFirst(),null,parts.getLast()));
            candidates.add(new PlDebugTypeGraph.Ref(declaring.owner(),parts.getFirst(),parts.getLast()));
        } else if(parts.size()==3)candidates.add(new PlDebugTypeGraph.Ref(parts.getFirst(),parts.get(1),parts.getLast()));
        return List.copyOf(candidates);
    }

    private static boolean knownType(PlDebugTypeGraph.Graph graph,Map<String,String> type) {
        if(type.get("ATTR_TYPE_MOD")!=null)return false;
        if(numericCarrier(type)!=null)return true;
        if(type.get("ATTR_TYPE_OWNER")!=null||type.get("ATTR_TYPE_PACKAGE")!=null)return type.get("ATTR_TYPE_OWNER")!=null&&graph.nodes().stream().anyMatch(node->node.reference().equals(new PlDebugTypeGraph.Ref(type.get("ATTR_TYPE_OWNER"),type.get("ATTR_TYPE_PACKAGE"),type.get("ATTR_TYPE_NAME"))));
        return Set.of("NUMBER","VARCHAR2","CHAR","NCHAR","NVARCHAR2","BOOLEAN","PL/SQL BOOLEAN","DATE","TIMESTAMP","TIMESTAMP WITH TIME ZONE","TIMESTAMP WITH LOCAL TIME ZONE","RAW","BINARY_FLOAT","BINARY_DOUBLE","INTERVAL YEAR TO MONTH","INTERVAL DAY TO SECOND","CLOB","BLOB").contains(PlDebugTarget.builtinType(type,"ATTR_TYPE_")==null?"":PlDebugTarget.builtinType(type,"ATTR_TYPE_"));
    }
    private static Callables unresolved(){return new Callables("constructor_metadata_unresolved",List.of());}

    private static List<Constructor> parse(PlDebugTypeGraph.Ref reference, List<Token> tokens) {
        int cursor=0;
        while(cursor<tokens.size()&&!tokens.get(cursor).keyword("TYPE")) {
            if(!Set.of("CREATE","OR","REPLACE","EDITIONABLE","NONEDITIONABLE").contains(tokens.get(cursor).text()) || tokens.get(cursor).quoted()) throw invalid();
            cursor++;
        }
        if(cursor>=tokens.size())throw invalid();
        cursor++;
        List<String> name=new ArrayList<>();
        cursor=reference(tokens,cursor,name);
        if(!matches(reference,name))throw invalid();
        if(at(tokens,cursor,"IS")||at(tokens,cursor,"AS")) {
            cursor++;
            if(!at(tokens,cursor,"OBJECT"))throw invalid();
            cursor++;
        } else if(at(tokens,cursor,"UNDER")) {
            cursor++;
            cursor=reference(tokens,cursor,new ArrayList<>());
        } else throw invalid();
        if(!symbol(tokens,cursor,"("))throw invalid();
        int close=closing(tokens,cursor);
        List<Constructor> constructors=new ArrayList<>();
        for(List<Token> member:split(tokens.subList(cursor+1,close))) {
            int index=0;
            while(index<member.size()&&(at(member,index,"FINAL")||at(member,index,"INSTANTIABLE")||at(member,index,"NOT")||at(member,index,"OVERRIDING")))index++;
            if(!at(member,index,"CONSTRUCTOR")) {
                // A constructor keyword anywhere else makes this declaration ambiguous.
                for(Token token:member)if(token.keyword("CONSTRUCTOR"))throw invalid();
                if(member.isEmpty()||!member.getFirst().identifier())throw invalid();
                continue;
            }
            index++;
            if(!at(member,index,"FUNCTION"))throw invalid();
            index++;
            if(index>=member.size()||!member.get(index).identifier()||!reference.typeName().equals(member.get(index).text()))throw invalid();
            index++;
            boolean parameterList=symbol(member,index,"(");
            if(!parameterList&&!at(member,index,"RETURN"))throw invalid();
            int end=parameterList?closing(member,index):index-1;
            List<Parameter> parameters=new ArrayList<>();
            Set<String> names=new java.util.HashSet<>();
            List<List<Token>> declarations=parameterList?split(member.subList(index+1,end)):List.of();
            for(int parameterIndex=0;parameterIndex<declarations.size();parameterIndex++) {
                var parameter=declarations.get(parameterIndex);
                if(parameter.isEmpty()||!parameter.getFirst().identifier())throw invalid();
                String parameterName=parameter.getFirst().text();
                if(!names.add(parameterName))throw invalid();
                int start=1;
                boolean inputOutput=false;
                if(at(parameter,start,"IN")) { start++; if(at(parameter,start,"OUT")){inputOutput=true;start++;} }
                else if(at(parameter,start,"OUT")) { inputOutput=true;start++; }
                if(at(parameter,start,"NOCOPY")) { if(!inputOutput)throw invalid();start++; }
                int defaultAt=parameter.size();
                for(int i=start;i<parameter.size();i++)if(at(parameter,i,"DEFAULT")||symbol(parameter,i,":=")){defaultAt=i;break;}
                if(defaultAt==start||defaultAt==parameter.size()-1)throw invalid();
                List<String> type=new ArrayList<>();
                int typeEnd;
                if(at(parameter,start,"TIMESTAMP")&&!symbol(parameter,start+1,".")) {
                    type.add("TIMESTAMP");typeEnd=start+1;
                    if(at(parameter,typeEnd,"WITH")) {
                        type.add("WITH");typeEnd++;
                        if(at(parameter,typeEnd,"LOCAL")){type.add("LOCAL");typeEnd++;}
                        if(!at(parameter,typeEnd,"TIME")||!at(parameter,typeEnd+1,"ZONE"))throw invalid();
                        type.add("TIME");type.add("ZONE");typeEnd+=2;
                    }
                }else if(at(parameter,start,"INTERVAL")&&!symbol(parameter,start+1,".")) {
                    if(at(parameter,start+1,"YEAR")&&at(parameter,start+2,"TO")&&at(parameter,start+3,"MONTH"))type.addAll(List.of("INTERVAL","YEAR","TO","MONTH"));
                    else if(at(parameter,start+1,"DAY")&&at(parameter,start+2,"TO")&&at(parameter,start+3,"SECOND"))type.addAll(List.of("INTERVAL","DAY","TO","SECOND"));
                    else throw invalid();
                    typeEnd=start+4;
                }else typeEnd=reference(parameter,start,type);
                if(typeEnd!=defaultAt)throw invalid();
                if("SELF".equals(parameterName)) {
                    if(parameterIndex!=0||!inputOutput||defaultAt!=parameter.size()||!matches(reference,type))throw invalid();
                } else {
                    if(inputOutput)throw invalid();
                    parameters.add(new Parameter(parameterName,List.copyOf(type),defaultAt<parameter.size(),parameter.subList(start,typeEnd).stream().anyMatch(Token::quoted)));
                }
            }
            if(end+5!=member.size()||!at(member,end+1,"RETURN")||!at(member,end+2,"SELF")||!at(member,end+3,"AS")||!at(member,end+4,"RESULT"))throw invalid();
            constructors.add(new Constructor("user-"+(constructors.size()+1),List.copyOf(parameters)));
        }
        cursor=close+1;
        while(cursor<tokens.size()) {
            if(at(tokens,cursor,"NOT")) { cursor++; if(!at(tokens,cursor,"FINAL")&&!at(tokens,cursor,"INSTANTIABLE"))throw invalid();cursor++; }
            else if(at(tokens,cursor,"FINAL")||at(tokens,cursor,"INSTANTIABLE")||symbol(tokens,cursor,";")||symbol(tokens,cursor,"/"))cursor++;
            else throw invalid();
        }
        return List.copyOf(constructors);
    }

    private static boolean matches(PlDebugTypeGraph.Ref ref,List<String> name) {
        return name.size()==1&&ref.typeName().equals(name.getFirst()) || name.size()==2&&ref.owner().equals(name.getFirst())&&ref.typeName().equals(name.getLast());
    }
    private static int reference(List<Token> tokens,int index,List<String> name) {
        if(index>=tokens.size()||!tokens.get(index).identifier())throw invalid();
        name.add(tokens.get(index++).text());
        while(symbol(tokens,index,".")) {
            if(name.size()>=3||index+1>=tokens.size()||!tokens.get(index+1).identifier())throw invalid();
            name.add(tokens.get(index+1).text());index+=2;
        }
        return index;
    }
    private static List<List<Token>> split(List<Token> tokens) {
        if(tokens.isEmpty())return List.of();
        List<List<Token>> parts=new ArrayList<>();int depth=0,start=0;
        for(int i=0;i<tokens.size();i++) {
            if(symbol(tokens,i,"("))depth++;
            if(symbol(tokens,i,")")&&--depth<0)throw invalid();
            if(symbol(tokens,i,",")&&depth==0){if(i==start)throw invalid();parts.add(tokens.subList(start,i));start=i+1;}
        }
        if(depth!=0||start==tokens.size())throw invalid();
        parts.add(tokens.subList(start,tokens.size()));return parts;
    }
    private static int closing(List<Token> tokens,int open) {
        int depth=0;
        for(int i=open;i<tokens.size();i++){if(symbol(tokens,i,"("))depth++;if(symbol(tokens,i,")")&&--depth==0)return i;}
        throw invalid();
    }
    private static boolean at(List<Token> tokens,int index,String word){return index<tokens.size()&&tokens.get(index).keyword(word);}
    private static boolean symbol(List<Token> tokens,int index,String text){return index<tokens.size()&&!tokens.get(index).identifier()&&!tokens.get(index).quoted()&&tokens.get(index).text().equals(text);}
    private static IllegalArgumentException invalid(){return new IllegalArgumentException("Unresolved constructor declaration");}

    private static List<Token> tokens(String source) {
        if(source==null||source.length()>1_048_576)throw invalid();
        List<Token> tokens=new ArrayList<>();
        for(int i=0;i<source.length();) {
            char ch=source.charAt(i);
            if(Character.isWhitespace(ch)){i++;continue;}
            if(ch=='-'&&i+1<source.length()&&source.charAt(i+1)=='-'){int end=source.indexOf('\n',i+2);i=end<0?source.length():end+1;continue;}
            if(ch=='/'&&i+1<source.length()&&source.charAt(i+1)=='*'){int end=source.indexOf("*/",i+2);if(end<0)throw invalid();i=end+2;continue;}
            int quote=i;
            if((ch=='q'||ch=='Q')&&i+1<source.length()&&source.charAt(i+1)=='\'')quote=i+1;
            else if((ch=='n'||ch=='N')&&i+2<source.length()&&(source.charAt(i+1)=='q'||source.charAt(i+1)=='Q')&&source.charAt(i+2)=='\'')quote=i+2;
            if(quote!=i) {
                if(quote+1>=source.length())throw invalid();char open=source.charAt(quote+1);if(Character.isWhitespace(open)||open=='\'')throw invalid();
                char close=switch(open){case '['->']';case '('->')';case '{'->'}';case '<'->'>';default->open;};
                int end=source.indexOf(""+close+'\'',quote+2);if(end<0)throw invalid();tokens.add(new Token("literal",false,true));i=end+2;
            } else if(ch=='\''||ch=='"') {
                char delimiter=ch;StringBuilder value=new StringBuilder();boolean ended=false;i++;
                while(i<source.length()){char next=source.charAt(i++);if(next==delimiter){if(i<source.length()&&source.charAt(i)==delimiter){value.append(delimiter);i++;}else{ended=true;break;}}else value.append(next);}
                if(!ended||delimiter=='"'&&value.isEmpty())throw invalid();tokens.add(new Token(value.toString(),delimiter=='"',true));
            } else if(Character.isLetter(ch)||ch=='_'||ch=='$'||ch=='#') {
                int start=i++;
                while(i<source.length()){char next=source.charAt(i);if(!Character.isLetterOrDigit(next)&&next!='_'&&next!='$'&&next!='#')break;i++;}
                tokens.add(new Token(source.substring(start,i).toUpperCase(Locale.ROOT),true,false));
            } else {
                if(ch==':'&&i+1<source.length()&&source.charAt(i+1)=='='){tokens.add(new Token(":=",false,false));i+=2;}
                else {tokens.add(new Token(String.valueOf(ch),false,false));i++;}
            }
            if(tokens.size()>65536)throw invalid();
        }
        return tokens;
    }
    private PlDebugObjectConstructors() {}
}
