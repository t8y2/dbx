package com.dbx.agent.test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

public final class JdbcMetadataSqlFake {
    public static final JdbcMetadataSqlFake INSTANCE = new JdbcMetadataSqlFake();
    public static final List<String> statements = new ArrayList<String>();

    private JdbcMetadataSqlFake() {
    }

    public static Connection connection() {
        statements.clear();
        return proxy(Connection.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("createStatement".equals(name)) {
                    return statement();
                }
                if ("prepareStatement".equals(name)) {
                    statements.add((String) args[0]);
                    return preparedStatement();
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

    public List<String> getStatements() {
        return statements;
    }

    private static Statement statement() {
        ResultSet resultSet = emptyResultSet();
        return proxy(Statement.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("execute".equals(name) || "executeQuery".equals(name)) {
                    statements.add((String) args[0]);
                    return "execute".equals(name) ? false : resultSet;
                }
                if ("getResultSet".equals(name)) {
                    return resultSet;
                }
                if ("getUpdateCount".equals(name)) {
                    return 0;
                }
                if ("setMaxRows".equals(name) || "close".equals(name)) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static PreparedStatement preparedStatement() {
        ResultSet resultSet = emptyResultSet();
        return proxy(PreparedStatement.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("execute".equals(name) || "executeQuery".equals(name)) {
                    return "execute".equals(name) ? false : resultSet;
                }
                if ("getResultSet".equals(name)) {
                    return resultSet;
                }
                if ("getUpdateCount".equals(name)) {
                    return 0;
                }
                if ("setString".equals(name) || "setInt".equals(name) || "setObject".equals(name)) {
                    statements.add("param:" + args[0] + "=" + args[1]);
                    return null;
                }
                if ("setMaxRows".equals(name) || "close".equals(name)) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet emptyResultSet() {
        ResultSetMetaData metadata = proxy(ResultSetMetaData.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                if ("getColumnCount".equals(method.getName())) {
                    return 0;
                }
                return defaultValue(method.getReturnType());
            }
        });
        return proxy(ResultSet.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("next".equals(name)) {
                    return false;
                }
                if ("getMetaData".equals(name)) {
                    return metadata;
                }
                if ("close".equals(name)) {
                    return null;
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
