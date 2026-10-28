package com.dbx.agent.oceanbaseoracle;

import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugInitializationFrameTest {
    private static void field(PlDebugSession session,String name,Object value) throws Exception {
        var field=PlDebugSession.class.getDeclaredField(name);field.setAccessible(true);field.set(session,value);
    }

    @Test void readsOriginalRootPhaseWhileStoppedInNestedInitializerAndRejectsWrongToken() throws Exception {
        var reads=new ArrayList<Integer>();var name=new AtomicReference<String>();var token=new AtomicReference<>("original-token");
        Connection controller=PlDebugTestJdbc.proxy(Connection.class,(method,args)-> {
            if(!method.getName().equals("prepareCall"))return PlDebugTestJdbc.empty(method.getReturnType());
            assertTrue(((String)args[0]).contains("DBMS_DEBUG.get_value"));
            return PlDebugTestJdbc.proxy(CallableStatement.class,(call,values)-> {
                if(call.getName().equals("setString"))name.set((String)values[1]);
                if(call.getName().equals("setInt"))reads.add((Integer)values[1]);
                if(call.getName().equals("getString"))return name.get().endsWith("ROOT_TOKEN")?"\"'"+token.get()+"'\"":"\"-1\"";
                return PlDebugTestJdbc.empty(call.getReturnType());
            });
        });
        var session=PlDebugSession.withConnections("initialization","S",controller,controller,false);
        Statement statement=PlDebugTestJdbc.proxy(Statement.class,(method,args)->PlDebugTestJdbc.empty(method.getReturnType()));
        field(session,"targetStatement",statement);field(session,"wrapperRootStatement",statement);field(session,"targetDispatched",true);
        field(session,"targetPlan",new PlDebugTarget.Plan(new PlDebugTarget.Candidate("S","RUN",null,"1",1,"VALID",List.of()),List.of()));
        field(session,"targetBlock",new PlDebugOutput.Block("",0,0,Set.of("P_ROOT_TOKEN","P_PHASE"),0,"P_ROOT_TOKEN","original-token",""));
        field(session,"currentStack",new PlDebugNative.Stack(List.of(
            new PlDebugNative.Frame(0,3,"PKG.MARK","S",2,4,"PKG.MARK","native","unknown"),
            new PlDebugNative.Frame(1,2,"PKG.__init__","S",2,12,"PKG.__init__","native","unknown"),
            new PlDebugNative.Frame(2,1,"__anonymous_block__","S",1,24,"__anonymous_block__","native","unknown")
        ),"",3,"verified",true,null,null,null));
        var phase=PlDebugSession.class.getDeclaredMethod("wrapperExecutionPhase");phase.setAccessible(true);
        assertEquals("-1",phase.invoke(session));assertEquals(List.of(1,1),reads);
        reads.clear();token.set("other-execution");assertNull(phase.invoke(session));assertEquals(List.of(1),reads);
        reads.clear();field(session,"wrapperRootStatement",null);assertNull(phase.invoke(session));assertTrue(reads.isEmpty());
    }
}
