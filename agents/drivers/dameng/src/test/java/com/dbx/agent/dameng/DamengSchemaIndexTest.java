package com.dbx.agent.dameng;

import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class DamengSchemaIndexTest {
    @Test
    void indexListingPreservesRawParentIdentity() {
        DamengAgent agent = new DamengAgent();
        List<String> owners = new ArrayList<>();
        TestSupport.setPrivateConnection(agent, connection(owners, false));

        List<ObjectInfo> objects = agent.listObjects(" Index Owner ",
            new MetadataListConstraints(null, 2, 0, List.of("INDEX")));

        assertEquals(1, objects.size());
        ObjectInfo index = objects.get(0);
        assertEquals(" Ix (a) ", index.getName());
        assertEquals(" Index Owner ", index.getSchema());
        assertEquals("INDEX", index.getObject_type());
        assertEquals("Table Owner", index.getParent_schema());
        assertEquals(" T(a) ", index.getParent_name());
        assertEquals(List.of(" Index Owner "), owners);
    }

    @Test
    void indexDictionaryPermissionFailureDoesNotUseTableOnlyFallback() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, connection(new ArrayList<>(), true));

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> agent.listObjects("APP", new MetadataListConstraints(null, 2, 0, List.of("INDEX"))));

        assertEquals(-5669, ((SQLException) error.getCause()).getErrorCode());
    }

    private static Connection connection(List<String> owners, boolean denied) {
        return proxy(Connection.class, (target, method, args) -> {
            if (method.getName().equals("prepareStatement")) {
                assertTrue(((String) args[0]).contains("ALL_INDEXES"), (String) args[0]);
                return proxy(PreparedStatement.class, (statement, operation, values) -> {
                    if (operation.getName().equals("setString") && values[0].equals(1)) owners.add((String) values[1]);
                    if (operation.getName().equals("executeQuery")) {
                        if (denied) throw new SQLException("权限不足", "42000", -5669);
                        int[] row = {0};
                        String[] data = {" Index Owner ", " Ix (a) ", "Table Owner", " T(a) "};
                        return proxy(ResultSet.class, (result, read, arguments) -> switch (read.getName()) {
                            case "next" -> row[0]++ == 0;
                            case "getString" -> data[(Integer) arguments[0] - 1];
                            default -> null;
                        });
                    }
                    return null;
                });
            }
            if (method.getName().equals("isClosed")) return false;
            return null;
        });
    }

    private static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }
}
