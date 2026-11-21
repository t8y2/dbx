package com.dbx.agent.testing;

import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import java.util.logging.Logger;

/** Live-test-only wrapper. All SQL goes through the real bundled JDBC driver. */
public final class SqlServerFaultDriver implements Driver {
    private static final String PREFIX = "jdbc:dbx-fault:";
    static {
        try { DriverManager.registerDriver(new SqlServerFaultDriver()); }
        catch (SQLException error) { throw new ExceptionInInitializerError(error); }
    }
    public Connection connect(String url, Properties info) throws SQLException {
        if (!acceptsURL(url)) return null;
        String delegateClass = null, mode = null;
        int controlPort = 0;
        StringBuilder delegateUrl = new StringBuilder();
        for (String part : url.substring(PREFIX.length()).split(";")) {
            if (part.startsWith("dbxFaultDriver=")) delegateClass = part.substring(15);
            else if (part.startsWith("dbxFaultControlPort=")) controlPort = Integer.parseInt(part.substring(20));
            else if (part.startsWith("dbxFaultMode=")) mode = part.substring(13);
            else { if (delegateUrl.length() > 0) delegateUrl.append(';'); delegateUrl.append(part); }
        }
        try {
            Driver delegate = (Driver) Class.forName(delegateClass).getDeclaredConstructor().newInstance();
            Connection connection = delegate.connect(delegateUrl.toString(), info);
            if (connection == null) throw new SQLException("Fault fixture delegate rejected URL");
            final int port = controlPort;
            final String fault = mode;
            return (Connection) java.lang.reflect.Proxy.newProxyInstance(SqlServerFaultDriver.class.getClassLoader(),
                new Class<?>[] {Connection.class}, (proxy, method, args) -> {
                    String name = method.getName();
                    if ((name.equals("commit") && "commit_response_loss".equals(fault))
                        || (name.equals("rollback") && "rollback_response_loss".equals(fault))) signal(port, "ARM");
                    if (name.equals("close") && "cleanup_failure".equals(fault)) signal(port, "CLOSE_ENTERED");
                    Object result;
                    try { result = method.invoke(connection, args); }
                    catch (InvocationTargetException error) { throw error.getCause(); }
                    if (name.equals("close") && "cleanup_failure".equals(fault)) {
                        signal(port, "CLOSE_FAILED");
                        throw new SQLException("Injected close failure after actual JDBC close", "HY000");
                    }
                    return result;
                });
        } catch (SQLException error) { throw error; }
        catch (ReflectiveOperationException error) { throw new SQLException("Cannot load real fault fixture delegate", error); }
    }
    private static void signal(int port, String command) throws SQLException {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 3000);
            socket.setSoTimeout(3000);
            socket.getOutputStream().write((command + "\n").getBytes(StandardCharsets.US_ASCII));
            if (socket.getInputStream().read() != 'K') throw new IOException("Fault controller did not acknowledge");
        } catch (IOException error) { throw new SQLException("Fault controller failed", error); }
    }
    public boolean acceptsURL(String url) { return url != null && url.startsWith(PREFIX); }
    public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) { return new DriverPropertyInfo[0]; }
    public int getMajorVersion() { return 1; }
    public int getMinorVersion() { return 0; }
    public boolean jdbcCompliant() { return false; }
    public Logger getParentLogger() { return Logger.getLogger("com.dbx.agent.testing"); }
}