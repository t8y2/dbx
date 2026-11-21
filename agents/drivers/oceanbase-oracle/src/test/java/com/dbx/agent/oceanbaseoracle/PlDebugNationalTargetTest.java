package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugStartRequest;
import java.sql.Types;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugNationalTargetTest {
    @Test void rootOnlyNationalPlanKeepsInitializationPhaseAndClobReceiptWithoutEmptyDeclare() throws Exception {
        var argument=new PlDebugTarget.Argument("X",1,1,0,"IN OUT","NCHAR",null,null,null,"N");
        var target=new PlDebugTarget.Candidate("S","P",null,"1",1,"VALID",List.of(argument));
        var plan=new PlDebugTarget.Plan(target,List.of(new PlDebugTarget.Input(argument,"value","中".repeat(6001)+"🙂  ")));
        var bindings=new java.util.LinkedHashMap<Integer,Object>();var outputs=new java.util.LinkedHashMap<Integer,Integer>();
        int capture=plan.bind(PlDebugTestJdbc.proxy(java.sql.CallableStatement.class,(method,args)->{
            if(method.getName().equals("setString"))bindings.put((Integer)args[0],args[1]);
            if(method.getName().equals("registerOutParameter"))outputs.put((Integer)args[0],(Integer)args[1]);
            return PlDebugTestJdbc.empty(method.getReturnType());
        }));
        assertEquals(2,bindings.size());assertEquals(Types.CLOB,outputs.get(3));assertEquals(plan.captureIndex(),capture);
        var block=plan.block();assertTrue(block.sql().contains("NVARCHAR2(32767)"));
        assertFalse(block.sql().contains("    DECLARE\n    BEGIN"));
        assertEquals(-1,plan.phase(PlDebugTestJdbc.proxy(java.sql.CallableStatement.class,(method,args)->method.getName().equals("getInt")?-1:PlDebugTestJdbc.empty(method.getReturnType()))));
    }
    @Test void onlyNationalOutputsNeedTheDedicatedPieceDataConnection() {
        for(String mode:List.of("IN","OUT","IN OUT")) {
            var request=new PlDebugStartRequest();request.setTargetSignature(Map.of("signatureVersion",2,"arguments",List.of(Map.of("type","NVARCHAR2","mode",mode))));
            assertEquals(!"IN".equals(mode),PlDebugTarget.requiresTypedLobConnection(request));
        }
    }
}
