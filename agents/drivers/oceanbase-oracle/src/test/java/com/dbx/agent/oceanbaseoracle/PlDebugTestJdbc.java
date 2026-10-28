package com.dbx.agent.oceanbaseoracle;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/** JDBC boundary fake shared by debugger tests; no debugger behavior is mocked. */
final class PlDebugTestJdbc {
    interface Handler { Object call(Method method, Object[] args) throws Throwable; }

    static <T> T proxy(Class<T> type, Handler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type},
            (proxy, method, args) -> handler.call(method, args == null ? new Object[0] : args)));
    }

    static Object empty(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        if (type == double.class) return 0d;
        if (type == float.class) return 0f;
        if (type == short.class) return (short) 0;
        if (type == byte.class) return (byte) 0;
        if (type == char.class) return (char) 0;
        return null;
    }
}
