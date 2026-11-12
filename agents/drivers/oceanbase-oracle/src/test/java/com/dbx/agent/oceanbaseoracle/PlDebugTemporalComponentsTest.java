package com.dbx.agent.oceanbaseoracle;

import java.math.BigDecimal;
import java.sql.SQLException;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugTemporalComponentsTest {
    private static PlDebugTarget.Argument argument(String type) {
        return new PlDebugTarget.Argument("V",1,1,0,"OUT",type,null,null,null,"N");
    }

    @Test void componentDecodingRetainsNegativeNanosecondsAndLtzOutputContext() throws Exception {
        var instant=new BigDecimal("-0.000000001");
        assertEquals("1969-12-31T23:59:59.999999999",PlDebugTarget.temporalText(instant,true));
        var result=PlDebugTarget.decodeZoned(argument("TIMESTAMP WITH LOCAL TIME ZONE"),instant,null,instant.add(new BigDecimal("19800")),"Asia/Kolkata");
        var typed=(Map<?,?>)result.get("typedValue");var value=(Map<?,?>)typed.get("value");
        assertEquals("timestamp_ltz",typed.get("kind"));assertEquals("1969-12-31T23:59:59.999999999Z",value.get("instant"));
        assertEquals("1970-01-01T05:29:59.999999999",value.get("local"));assertEquals("+05:30",value.get("offset"));assertEquals("Asia/Kolkata",value.get("sessionTimeZone"));
    }

    @Test void tzUsesWallAndOffsetWithoutRequiringAnInRangeUtcWallClock() throws Exception {
        var wall=PlDebugTarget.temporalInput("0001-01-01T00:00:00.000000001",true,"test");
        var result=PlDebugTarget.decodeZoned(argument("TIMESTAMP WITH TIME ZONE"),wall,"+14:00",wall,"UNKNOWN");
        var typed=(Map<?,?>)result.get("typedValue");var value=(Map<?,?>)typed.get("value");
        assertEquals("0001-01-01T00:00:00.000000001",value.get("local"));assertEquals("0000-12-31T10:00:00.000000001Z",value.get("instant"));
        assertNull(value.get("region"));assertEquals("not_returned",value.get("regionState"));
    }

    @Test void nullLtzRequiresContextAndInvalidComponentsAreNeverPublishedAsValues() throws Exception {
        var ltz=argument("TIMESTAMP WITH LOCAL TIME ZONE");
        var result=PlDebugTarget.decodeZoned(ltz,null,null,null,"UTC");
        assertEquals("null",result.get("state"));assertEquals("UTC",result.get("sessionTimeZone"));
        assertNull(((Map<?,?>)result.get("typedValue")).get("value"));
        assertThrows(SQLException.class,()->PlDebugTarget.decodeZoned(ltz,null,null,null,null));
        assertThrows(SQLException.class,()->PlDebugTarget.decodeZoned(ltz,BigDecimal.ONE,null,null,"UTC"));
        assertThrows(SQLException.class,()->PlDebugTarget.decodeZoned(ltz,BigDecimal.ONE,null,new BigDecimal("1.1"),"UTC"));
        assertThrows(SQLException.class,()->PlDebugTarget.temporalText(new BigDecimal("0.0000000001"),true));
    }
}
