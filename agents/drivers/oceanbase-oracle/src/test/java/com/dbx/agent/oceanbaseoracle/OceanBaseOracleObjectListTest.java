package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class OceanBaseOracleObjectListTest {
    @Test
    void tableAndViewCommentsSurviveObjectListing() {
        JdbcFixture jdbc = new JdbcFixture();
        jdbc.rows(row("T", "TABLE", "订单备注"), row("V", "VIEW", "Customer view"),
            row("EMPTY", "TABLE", ""), row("NO_COMMENT", "VIEW", null));

        assertEquals(List.of(
            new ObjectInfo("T", "TABLE", "APP", "订单备注"),
            new ObjectInfo("V", "VIEW", "APP", "Customer view"),
            new ObjectInfo("EMPTY", "TABLE", "APP", ""),
            new ObjectInfo("NO_COMMENT", "VIEW", "APP", null)
        ), jdbc.agent.listObjects("APP"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"订单", "Customer", "'", "%", "_", "\\"})
    void commentOnlyMatchesAreBoundBeforePaging(String filter) {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("Z_LATE", "TABLE", "prefix " + filter + " suffix"));
        MetadataListConstraints constraints = constraints(filter, 1, 2, "TABLE");

        assertEquals(List.of(new ObjectInfo("Z_LATE", "TABLE", "Mixed.Owner", "prefix " + filter + " suffix")),
            jdbc.agent.listObjects("Mixed.Owner", constraints));

        assertTrue(call.sql.contains("OR UPPER(c.COMMENTS) LIKE ? ESCAPE '\\'"), call.sql);
        assertTrue(call.sql.indexOf("UPPER(c.COMMENTS)") < call.sql.indexOf("WHERE ROWNUM <= ?"), call.sql);
        String pattern = switch (filter) {
            case "订单" -> "%订%单%";
            case "Customer" -> "%C%U%S%T%O%M%E%R%";
            case "'" -> "%'%";
            case "%" -> "%\\%%";
            case "_" -> "%\\_%";
            default -> "%\\\\%";
        };
        assertEquals(List.of("Mixed.Owner", "TABLE", pattern, pattern, 3L, 2), call.args);
        call.assertClosed();
    }

    @Test
    void defaultListsIncludeBothPackageTypesAndKeepExistingTypeOrder() {
        JdbcFixture jdbc = new JdbcFixture();
        for (int request = 0; request < 4; request++) {
            JdbcCall call = jdbc.rows(
                row("T", "TABLE"), row("V", "VIEW"), row("P", "PROCEDURE"),
                row("F", "FUNCTION"), row("PKG", "PACKAGE"), row("PKG", "PACKAGE BODY"),
                row("SEQ", "SEQUENCE"), row("SYN", "SYNONYM")
            );
            List<ObjectInfo> objects = switch (request) {
                case 0 -> jdbc.agent.listObjects("APP");
                case 1 -> jdbc.agent.listObjects("APP", null);
                case 2 -> jdbc.agent.listObjects("APP", MetadataListConstraints.NONE);
                default -> jdbc.agent.listObjects("APP", new MetadataListConstraints("", 0, -1, List.of()));
            };

            assertEquals(List.of("APP", "TABLE", "VIEW", "PROCEDURE", "FUNCTION", "PACKAGE",
                "PACKAGE BODY", "SEQUENCE", "SYNONYM", "TYPE", "TYPE BODY"), call.args);
            assertEquals(List.of("TABLE", "VIEW", "PROCEDURE", "FUNCTION", "PACKAGE",
                "PACKAGE_BODY", "SEQUENCE", "SYNONYM"), objects.stream().map(ObjectInfo::getObject_type).toList());
            assertEquals(8, objects.size());
            assertTrue(objects.stream().allMatch(object -> "APP".equals(object.getSchema())));
            assertTrue(objects.stream().allMatch(object -> object.getValid() == null));
            assertTrue(call.sql.contains("OBJECT_TYPE IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"), call.sql);
            assertFalse(call.sql.contains("ROWNUM"), call.sql);
            assertObjectOrder(call.sql);
            call.assertClosed();
        }
    }

    @Test
    void packageGroupRetainsSameNameSpecAndBodyWithDistinctProtocolTypes() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("Pkg.With\"Quote", "PACKAGE"), row("Pkg.With\"Quote", "PACKAGE BODY"));

        List<ObjectInfo> objects = jdbc.agent.listObjects("Mixed.Owner\"Name",
            constraints(null, null, null, " package_body ", "package", "PACKAGE BODY"));

        assertEquals(List.of("Mixed.Owner\"Name", "PACKAGE", "PACKAGE BODY"), call.args);
        assertEquals(List.of(
            new ObjectInfo("Pkg.With\"Quote", "PACKAGE", "Mixed.Owner\"Name", null),
            new ObjectInfo("Pkg.With\"Quote", "PACKAGE_BODY", "Mixed.Owner\"Name", null)
        ), objects);
        assertNotEquals(objects.get(0), objects.get(1));
        assertFalse(call.sql.contains("Mixed.Owner"), call.sql);
        assertTrue(call.sql.contains("STATUS"), call.sql);
        call.assertClosed();
    }

    @ParameterizedTest
    @ValueSource(strings = {"PACKAGE_BODY", "package body", " package_body "})
    void bodyOnlyBindsDatabaseSpellingAndReturnsProtocolSpelling(String requestedType) {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("OnlyBody", "PACKAGE BODY"));

        assertEquals(List.of(new ObjectInfo("OnlyBody", "PACKAGE_BODY", "APP", null)),
            jdbc.agent.listObjects("APP", constraints(null, null, null, requestedType)));
        assertEquals(List.of("APP", "PACKAGE BODY"), call.args);
        assertTrue(call.sql.contains("OBJECT_TYPE IN (?)"), call.sql);
        call.assertClosed();
    }

    @Test
    void specOnlyDoesNotRequestBodies() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("OnlySpec", "PACKAGE"));

        assertEquals(List.of(new ObjectInfo("OnlySpec", "PACKAGE", "APP", null)),
            jdbc.agent.listObjects("APP", constraints(null, null, null, "PACKAGE")));
        assertEquals(List.of("APP", "PACKAGE"), call.args);
        call.assertClosed();
    }

    @Test
    void filteredPagesKeepSameNameSpecAndBodyAndDoNotApplyOffsetTwice() {
        JdbcFixture jdbc = new JdbcFixture();
        List<ObjectInfo> pages = new ArrayList<>();
        for (int offset = 0; offset < 2; offset++) {
            JdbcCall call = jdbc.rows(row("Pkg_'%", offset == 0 ? "PACKAGE" : "PACKAGE BODY"));
            pages.addAll(jdbc.agent.listObjects("APP",
                constraints("k_'%", 1, offset, "PACKAGE", "PACKAGE_BODY")));

            assertEquals(List.of("APP", "PACKAGE", "PACKAGE BODY", "%K%\\_%'%\\%%", "%K%\\_%'%\\%%", offset + 1L, offset), call.args);
            assertTrue(call.sql.contains("UPPER(OBJECT_NAME) LIKE ? ESCAPE '\\'"), call.sql);
            assertTrue(call.sql.contains("ROWNUM <= ?"), call.sql);
            assertTrue(call.sql.contains("WHERE DBX_RN > ?"), call.sql);
            assertTrue(call.sql.endsWith("ORDER BY DBX_RN"), call.sql);
            assertTrue(call.sql.indexOf("ORDER BY CASE OBJECT_TYPE") < call.sql.indexOf("WHERE ROWNUM <= ?"), call.sql);
            assertObjectOrder(call.sql);
            call.assertClosed();
        }
        assertEquals(List.of(new ObjectInfo("Pkg_'%", "PACKAGE", "APP", null),
            new ObjectInfo("Pkg_'%", "PACKAGE_BODY", "APP", null)), pages);
    }

    @Test
    void offsetWithoutLimitKeepsTheOrderedRemainingBody() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("PKG", "PACKAGE BODY"));

        assertEquals(List.of(new ObjectInfo("PKG", "PACKAGE_BODY", "APP", null)),
            jdbc.agent.listObjects("APP", constraints(null, null, 1, "PACKAGE", "PACKAGE_BODY")));
        assertEquals(List.of("APP", "PACKAGE", "PACKAGE BODY", 1), call.args);
        assertFalse(call.sql.contains("ROWNUM <= ?"), call.sql);
        assertTrue(call.sql.endsWith("WHERE DBX_RN > ?\nORDER BY DBX_RN"), call.sql);
        call.assertClosed();
    }

    @Test
    void tablePagesKeepTheOuterOrder() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("Z_LATE", "TABLE", "订单"));

        assertEquals("Z_LATE", jdbc.agent.listTables("APP", constraints("订单", 1, 2, "TABLE")).get(0).getName());
        assertTrue(call.sql.endsWith("ORDER BY DBX_RN"), call.sql);
        assertTrue(call.sql.contains("ORDER BY OBJECT_NAME, o.OBJECT_ID"), call.sql);
        call.assertClosed();
    }

    @Test
    void pageUpperBoundDoesNotOverflowTheProtocolIntegerRange() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows();

        assertEquals(List.of(), jdbc.agent.listObjects("APP", constraints(null, 2, Integer.MAX_VALUE, "TABLE")));
        assertEquals(List.of("APP", "TABLE", 2147483649L, Integer.MAX_VALUE), call.args);
        call.assertClosed();
    }

    @ParameterizedTest
    @ValueSource(strings = {"TABLE", "VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE", "SYNONYM"})
    void unrelatedTypeRequestsKeepTheirParametersAndMapping(String type) {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("Existing", type));

        assertEquals(List.of(new ObjectInfo("Existing", type, "APP", null)),
            jdbc.agent.listObjects("APP", constraints(null, null, null, type)));
        assertEquals(List.of("APP", type), call.args);
        call.assertClosed();
    }

    @Test
    void unsupportedTypesDoNotQueryTheDatabase() {
        JdbcFixture jdbc = new JdbcFixture();

        assertEquals(List.of(), jdbc.agent.listObjects("APP", constraints(null, null, null, "TRIGGER", "JOB")));
        assertEquals(0, jdbc.prepared);
    }

    @Test
    void refreshDoesNotRetainPreviousObjectsOrSchema() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall first = jdbc.rows(row("PKG", "PACKAGE BODY"));
        JdbcCall second = jdbc.rows();
        JdbcCall third = jdbc.rows(row("PKG", "PACKAGE BODY"));

        assertEquals(List.of(new ObjectInfo("PKG", "PACKAGE_BODY", "APP", null)),
            jdbc.agent.listObjects("APP", constraints(null, null, null, "PACKAGE_BODY")));
        assertEquals(List.of(), jdbc.agent.listObjects("APP", constraints(null, null, null, "PACKAGE_BODY")));
        assertEquals(List.of(new ObjectInfo("PKG", "PACKAGE_BODY", "OtherOwner", null)),
            jdbc.agent.listObjects("OtherOwner", constraints(null, null, null, "PACKAGE_BODY")));
        assertEquals(List.of("APP", "PACKAGE BODY"), second.args);
        assertEquals(List.of("OtherOwner", "PACKAGE BODY"), third.args);
        first.assertClosed();
        second.assertClosed();
        third.assertClosed();
    }

    @Test
    void permissionFailureRemainsAnErrorAndFollowingRequestCanSucceed() {
        JdbcFixture jdbc = new JdbcFixture();
        SQLException denied = new SQLException("ORA-01031: insufficient privileges", "42000", 1031);
        JdbcCall failed = jdbc.rows();
        failed.executeFailure = denied;
        JdbcCall next = jdbc.rows(row("PKG", "PACKAGE BODY"));

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> jdbc.agent.listObjects("APP", constraints(null, null, null, "PACKAGE_BODY")));
        assertSame(denied, error.getCause());
        assertTrue(failed.statementClosed);
        assertEquals(List.of(new ObjectInfo("PKG", "PACKAGE_BODY", "APP", null)),
            jdbc.agent.listObjects("APP", constraints(null, null, null, "PACKAGE_BODY")));
        next.assertClosed();
    }

    @Test
    void cancelledResultReadClosesResourcesAndDoesNotReturnPartialObjects() {
        JdbcFixture jdbc = new JdbcFixture();
        SQLException cancelled = new SQLException("ORA-01013: user requested cancel of current operation", "72000", 1013);
        JdbcCall call = jdbc.rows(row("PKG", "PACKAGE"));
        call.readFailure = cancelled;

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> jdbc.agent.listObjects("APP", constraints(null, null, null, "PACKAGE", "PACKAGE_BODY")));

        assertSame(cancelled, error.getCause());
        call.assertClosed();
    }

    @Test
    void listedSpecAndBodyOpenTheirSeparateDictionarySources() {
        JdbcFixture jdbc = new JdbcFixture();
        jdbc.rows(row("Mixed.Pkg", "PACKAGE"), row("Mixed.Pkg", "PACKAGE BODY"));
        List<ObjectInfo> objects = jdbc.agent.listObjects("Mixed.Owner", constraints(null, null, null, "PACKAGE", "PACKAGE_BODY"));
        assertEquals(2, objects.size());
        for (ObjectInfo object : objects) {
            String databaseType = object.getObject_type().equals("PACKAGE_BODY") ? "PACKAGE BODY" : "PACKAGE";
            JdbcCall call = jdbc.rows(row(databaseType + " \"Mixed.Pkg\" AS\n"), row("END;\n"));

            ObjectSource source = jdbc.agent.getObjectSource(object.getSchema(), object.getName(), object.getObject_type());

            assertEquals("CREATE OR REPLACE " + databaseType + " \"Mixed.Pkg\" AS\nEND;", source.getSource());
            assertEquals(object.getObject_type(), source.getObject_type());
            assertEquals(List.of("Mixed.Owner", "Mixed.Pkg", databaseType), call.args);
            assertEquals("SELECT TEXT FROM ALL_SOURCE WHERE OWNER = ? AND NAME = ? AND TYPE = ? ORDER BY LINE", call.sql);
            call.assertClosed();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"PACKAGE", "PACKAGE_BODY"})
    void emptyDictionarySourceFallsBackToMetadata(String type) {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall dictionary = jdbc.rows();
        String ddl = "CREATE OR REPLACE " + type.replace('_', ' ') + " PKG AS END;";
        JdbcCall metadata = jdbc.rows(row(ddl));

        assertEquals(ddl, jdbc.agent.getObjectSource("APP", "PKG", type).getSource());
        assertEquals(List.of("APP", "PKG", type.replace('_', ' ')), dictionary.args);
        assertEquals(List.of(type, "PKG", "APP"), metadata.args);
        assertTrue(metadata.sql.contains("DBMS_METADATA.GET_DDL"), metadata.sql);
        dictionary.assertClosed();
        metadata.assertClosed();
    }

    @Test
    void missingBodySourceStaysEmptyWhenBothSourcesAreEmpty() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall dictionary = jdbc.rows();
        JdbcCall metadata = jdbc.rows();

        assertEquals("", jdbc.agent.getObjectSource("APP", "Missing", "PACKAGE_BODY").getSource());
        dictionary.assertClosed();
        metadata.assertClosed();
    }

    @Test
    void bodySourceErrorsPreserveBothDictionaryAndMetadataFailures() {
        JdbcFixture jdbc = new JdbcFixture();
        SQLException denied = new SQLException("ORA-01031: insufficient privileges", "42000", 1031);
        SQLException unavailable = new SQLException("DBMS_METADATA is unavailable", "42000");
        JdbcCall dictionary = jdbc.rows();
        dictionary.executeFailure = denied;
        JdbcCall metadata = jdbc.rows();
        metadata.executeFailure = unavailable;

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> jdbc.agent.getObjectSource("APP", "PKG", "PACKAGE_BODY"));

        assertSame(denied, error.getCause());
        assertArrayEquals(new Throwable[]{unavailable}, denied.getSuppressed());
        assertTrue(dictionary.statementClosed);
        assertTrue(metadata.statementClosed);
    }

    @Test
    void sameNamePrivateAndPublicSynonymsKeepTheirScopeAndPagedDictionaryListing() {
        JdbcFixture jdbc = new JdbcFixture();
        List<ObjectInfo> objects = new ArrayList<>();
        for (String owner : List.of("Mixed.Owner", "PUBLIC")) {
            JdbcCall call = jdbc.rows(row("Mixed.Syn", "SYNONYM"));
            objects.addAll(jdbc.agent.listObjects(owner, constraints("Mixed", 1, 1, "SYNONYM")));
            assertEquals(List.of(owner, "SYNONYM", "%M%I%X%E%D%", "%M%I%X%E%D%", 2L, 1), call.args);
            assertTrue(call.sql.contains("FROM ALL_SYNONYMS"), call.sql);
            assertTrue(call.sql.contains("WHEN s.OWNER = '__public' THEN 'PUBLIC' ELSE s.OWNER END"), call.sql);
            assertTrue(call.sql.contains("FROM ALL_OBJECTS o WHERE o.OBJECT_TYPE <> 'SYNONYM'"), call.sql);
            // Group normalized PUBLIC identities before SQL paging, preserving unknown status.
            assertTrue(call.sql.contains("GROUP BY CASE WHEN s.OWNER = '__public' THEN 'PUBLIC' ELSE s.OWNER END"), call.sql);
            assertTrue(call.sql.contains("COUNT(a.STATUS) = COUNT(*) AND MIN(a.STATUS) = MAX(a.STATUS)"), call.sql);
            assertTrue(call.sql.startsWith("SELECT OBJECT_NAME, OBJECT_TYPE, COMMENTS, STATUS"), call.sql);
            assertTrue(call.sql.contains("OR UPPER(c.COMMENTS) LIKE ?"), call.sql);
            assertTrue(call.sql.contains("UNION\n"), call.sql);
            assertFalse(call.sql.contains("UNION ALL"), call.sql);
            assertTrue(call.sql.contains("WHERE o.OWNER = ? AND o.OBJECT_TYPE IN (?)"), call.sql);
            assertTrue(call.sql.endsWith("ORDER BY DBX_RN"), call.sql);
            call.assertClosed();
        }
        assertEquals(List.of(new ObjectInfo("Mixed.Syn", "SYNONYM", "Mixed.Owner", null),
            new ObjectInfo("Mixed.Syn", "SYNONYM", "PUBLIC", null)), objects);
    }

    @Test
    void publicSynonymSourceAcceptsInternalOwnerAndKeepsPublicDeclarationAndRemoteReference() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("Other.Owner", "Target\"Name", "LINK.DOMAIN"));

        ObjectSource source = jdbc.agent.getObjectSource("PUBLIC", "Mixed.Syn", "SYNONYM");

        assertEquals("CREATE OR REPLACE PUBLIC SYNONYM \"Mixed.Syn\" FOR \"Other.Owner\".\"Target\"\"Name\"@LINK.DOMAIN;", source.getSource());
        assertEquals(List.of("PUBLIC", "Mixed.Syn"), call.args);
        assertTrue(call.sql.contains("(OWNER = ? OR OWNER = '__public')"), call.sql);
        assertTrue(call.sql.endsWith("ORDER BY CASE WHEN OWNER = 'PUBLIC' THEN 0 ELSE 1 END"), call.sql);
        assertEquals(1, jdbc.prepared, "source loading must not access the remote link");
        call.assertClosed();
    }

    @Test
    void publicSynonymSourcePrefersCanonicalRowWhenBothDictionaryOwnersExist() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("Canonical", "First", null), row("Internal", "Second", null));

        assertEquals("CREATE OR REPLACE PUBLIC SYNONYM \"S\" FOR \"Canonical\".\"First\";",
            jdbc.agent.getObjectSource("PUBLIC", "S", "SYNONYM").getSource());
        assertTrue(call.sql.endsWith("ORDER BY CASE WHEN OWNER = 'PUBLIC' THEN 0 ELSE 1 END"));
        call.assertClosed();
    }

    @Test
    void privateSynonymSourceNeverFallsBackToPublicAndPreservesQuotedIdentity() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("Other.Owner", "Target", null));
        assertEquals("CREATE OR REPLACE SYNONYM \"Mixed.Owner\".\"Mixed.Syn\" FOR \"Other.Owner\".\"Target\";",
            jdbc.agent.getObjectSource("Mixed.Owner", "Mixed.Syn", "SYNONYM").getSource());
        assertEquals(List.of("Mixed.Owner", "Mixed.Syn"), call.args);
        assertEquals("SELECT TABLE_OWNER, TABLE_NAME, DB_LINK FROM ALL_SYNONYMS WHERE OWNER = ? AND SYNONYM_NAME = ?", call.sql);
        call.assertClosed();
        JdbcCall missing = jdbc.rows();
        assertEquals("", jdbc.agent.getObjectSource("Mixed.Owner", "Missing", "SYNONYM").getSource());
        assertEquals(2, jdbc.prepared);
        missing.assertClosed();
    }

    @Test
    void publicSynonymDictionaryPermissionFailureDoesNotBecomeMissingOrPrivate() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows();
        SQLException denied = new SQLException("ORA-01031: insufficient privileges", "42000", 1031);
        call.executeFailure = denied;

        RuntimeException error = assertThrows(RuntimeException.class,
            () -> jdbc.agent.getObjectSource("PUBLIC", "S", "SYNONYM"));
        assertSame(denied, error.getCause());
        assertEquals(1, jdbc.prepared);
        assertTrue(call.statementClosed);
    }

    private static MetadataListConstraints constraints(String filter, Integer limit, Integer offset, String... types) {
        return new MetadataListConstraints(filter, limit, offset, Arrays.asList(types));
    }

    private static String[] row(String... columns) {
        return columns.length == 2 ? Arrays.copyOf(columns, 3) : columns;
    }

    @Test
    void userTypesPreserveOwnerPairAndActualValidity() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("Mixed.Type", "TYPE", "spec comment", "VALID"),
            row("Mixed.Type", "TYPE BODY", "body comment", "INVALID"), row("Unknown", "TYPE", null, null));
        List<ObjectInfo> objects = jdbc.agent.listObjects(" Mixed.Owner ", constraints(null, null, null, "TYPE", "TYPE_BODY"));
        assertEquals(List.of(" Mixed.Owner ", "TYPE", "TYPE BODY"), call.args);
        assertEquals(" Mixed.Owner ", objects.get(0).getSchema());
        assertEquals("TYPE_BODY", objects.get(1).getObject_type());
        assertEquals("spec comment", objects.get(0).getComment());
        assertEquals("body comment", objects.get(1).getComment());
        assertEquals(Boolean.TRUE, objects.get(0).getValid());
        assertEquals(Boolean.FALSE, objects.get(1).getValid());
        assertNull(objects.get(2).getValid());
        assertTrue(call.sql.contains("t.PREDEFINED = 'NO'"));
        assertTrue(call.sql.contains("NVL(o.GENERATED, 'N') = 'N'"));
    }

    @Test
    void typeSourcePreservesMethodsAndIsReadOnly() {
        JdbcFixture jdbc = new JdbcFixture();
        JdbcCall call = jdbc.rows(row("TYPE BODY \"Mixed.Type\" AS\n"), row("MEMBER FUNCTION f RETURN VARCHAR2 IS BEGIN RETURN '中文'; END;\n"), row("END;\n"));
        ObjectSource source = jdbc.agent.getObjectSource("Mixed.Owner", "Mixed.Type", "TYPE_BODY");
        assertEquals(List.of("Mixed.Owner", "Mixed.Type", "TYPE BODY"), call.args);
        assertTrue(source.getSource().contains("MEMBER FUNCTION f RETURN VARCHAR2 IS BEGIN RETURN '中文'; END;"));
        assertFalse(source.isEditable());
        call.assertClosed();
    }

    @ParameterizedTest
    @ValueSource(strings = {"TYPE", "TYPE_BODY"})
    void missingTypeSourceNeverReturnsAnEmptyDefinition(String type) {
        JdbcFixture jdbc = new JdbcFixture();
        jdbc.rows();
        jdbc.rows();
        RuntimeException error = assertThrows(RuntimeException.class, () -> jdbc.agent.getObjectSource("APP", "Missing", type));
        assertTrue(error.getMessage().contains("Complete type source"));
    }

    private static void assertObjectOrder(String sql) {
        List<String> types = List.of("TABLE", "VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE BODY", "SEQUENCE");
        for (int rank = 0; rank < types.size(); rank++) {
            assertTrue(sql.contains("WHEN '" + types.get(rank) + "' THEN " + rank), sql);
        }
        assertTrue(sql.contains("ELSE 7\nEND, OBJECT_NAME, o.OBJECT_ID"), sql);
    }

    private static final class JdbcFixture {
        final OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
        final Deque<JdbcCall> replies = new ArrayDeque<>();
        int prepared;

        JdbcFixture() {
            TestSupport.setPrivateConnection(agent, proxy(Connection.class, (connection, method, args) -> {
                if (method.getName().equals("prepareStatement")) {
                    prepared++;
                    JdbcCall call = replies.removeFirst();
                    call.sql = (String) args[0];
                    return call.statement();
                }
                if (method.getName().equals("isClosed")) {
                    return false;
                }
                throw new AssertionError("Unexpected connection method: " + method.getName());
            }));
        }

        JdbcCall rows(String[]... rows) {
            JdbcCall call = new JdbcCall(rows);
            replies.add(call);
            return call;
        }
    }

    private static final class JdbcCall {
        final String[][] rows;
        final List<Object> args = new ArrayList<>();
        String sql;
        SQLException executeFailure;
        SQLException readFailure;
        boolean statementClosed;
        boolean resultClosed;

        JdbcCall(String[][] rows) {
            this.rows = rows;
        }

        PreparedStatement statement() {
            return proxy(PreparedStatement.class, (statement, method, values) -> switch (method.getName()) {
                case "setString", "setInt", "setLong", "setObject" -> {
                    assertEquals(args.size() + 1, values[0]);
                    args.add(values[1]);
                    yield null;
                }
                case "setFetchSize" -> null;
                case "executeQuery" -> {
                    if (executeFailure != null) {
                        throw executeFailure;
                    }
                    yield resultSet();
                }
                case "close" -> {
                    statementClosed = true;
                    yield null;
                }
                default -> throw new AssertionError("Unexpected statement method: " + method.getName());
            });
        }

        ResultSet resultSet() {
            int[] cursor = {-1};
            return proxy(ResultSet.class, (result, method, values) -> switch (method.getName()) {
                case "next" -> {
                    cursor[0]++;
                    if (cursor[0] >= rows.length && readFailure != null) {
                        throw readFailure;
                    }
                    yield cursor[0] < rows.length;
                }
                case "getString" -> {
                    int index = values[0] instanceof Integer position ? position - 1
                        : List.of("TABLE_OWNER", "TABLE_NAME", "DB_LINK").indexOf(values[0]);
                    if (index < 0) throw new AssertionError("Unexpected column: " + values[0]);
                    yield index < rows[cursor[0]].length ? rows[cursor[0]][index] : null;
                }
                case "close" -> {
                    resultClosed = true;
                    yield null;
                }
                default -> throw new AssertionError("Unexpected result method: " + method.getName());
            });
        }

        void assertClosed() {
            assertTrue(statementClosed, "statement must close");
            assertTrue(resultClosed, "result set must close");
        }
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }
}
