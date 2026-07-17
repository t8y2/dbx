package com.dbx.agent.test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

public final class JdbcAgentFake {
    public static final JdbcAgentFake INSTANCE = new JdbcAgentFake();
    public static final List<String> calls = new ArrayList<String>();

    private JdbcAgentFake() {
    }

    public static Connection connection() {
        calls.clear();
        Statement statement = statement();
        return proxy(Connection.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("createStatement".equals(name)) {
                    return statement;
                }
                if ("getAutoCommit".equals(name)) {
                    return true;
                }
                if ("setAutoCommit".equals(name) || "commit".equals(name) || "rollback".equals(name) || "close".equals(name)) {
                    return null;
                }
                if ("isClosed".equals(name)) {
                    return false;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    public List<String> getCalls() {
        return calls;
    }

    private static Statement statement() {
        ResultSet resultSet = resultSet();
        return proxy(Statement.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("execute".equals(name)) {
                    calls.add("execute");
                    return true;
                }
                if ("executeQuery".equals(name)) {
                    calls.add("executeQuery");
                    return resultSet;
                }
                if ("executeUpdate".equals(name)) {
                    calls.add("executeUpdate");
                    return 0;
                }
                if ("getResultSet".equals(name)) {
                    return resultSet;
                }
                if ("getUpdateCount".equals(name)) {
                    return 0;
                }
                if ("setMaxRows".equals(name)) {
                    calls.add("setMaxRows:" + args[0]);
                    return null;
                }
                if ("setFetchSize".equals(name)) {
                    calls.add("setFetchSize:" + args[0]);
                    return null;
                }
                if ("close".equals(name)) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet resultSet() {
        final int[] index = {-1};
        ResultSetMetaData metadata = metadata();
        return proxy(ResultSet.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("next".equals(name)) {
                    index[0] += 1;
                    return index[0] == 0;
                }
                if ("getMetaData".equals(name)) {
                    return metadata;
                }
                if ("getObject".equals(name) || "getString".equals(name)) {
                    return "row-value";
                }
                if ("wasNull".equals(name)) {
                    return false;
                }
                if ("close".equals(name)) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSetMetaData metadata() {
        return proxy(ResultSetMetaData.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("getColumnCount".equals(name)) {
                    return 1;
                }
                if ("getColumnLabel".equals(name)) {
                    return "VALUE";
                }
                if ("getColumnType".equals(name)) {
                    return Types.VARCHAR;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static <T> T proxy(Class<T> type, final MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) {
                return handler.handle(method, args);
            }
        };
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) {
            return false;
        }
        if (Byte.TYPE.equals(type)) {
            return (byte) 0;
        }
        if (Short.TYPE.equals(type)) {
            return (short) 0;
        }
        if (Integer.TYPE.equals(type)) {
            return 0;
        }
        if (Long.TYPE.equals(type)) {
            return 0L;
        }
        if (Float.TYPE.equals(type)) {
            return 0f;
        }
        if (Double.TYPE.equals(type)) {
            return 0.0d;
        }
        if (Character.TYPE.equals(type)) {
            return '\0';
        }
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args);
    }
}
