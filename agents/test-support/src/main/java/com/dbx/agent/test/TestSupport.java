package com.dbx.agent.test;

import java.lang.reflect.Field;
import java.sql.Connection;

public final class TestSupport {
    private TestSupport() {
    }

    public static void setPrivateConnection(Object target, Connection connection) {
        Field field = findConnectionField(target.getClass());
        field.setAccessible(true);
        try {
            field.set(target, connection);
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("Unable to set connection", e);
        }
    }

    private static Field findConnectionField(Class<?> type) {
        Class<?> current = type;
        while (current != null) {
            try {
                return current.getDeclaredField("connection");
            } catch (NoSuchFieldException ignored) {
                current = current.getSuperclass();
            }
        }
        throw new IllegalStateException(new NoSuchFieldException("connection"));
    }
}
