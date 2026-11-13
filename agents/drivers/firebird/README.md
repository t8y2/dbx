# Firebird Legacy Text

For ISO8859_1 columns containing GBK, GB18030, or Big5 bytes, configure
`charSet=ISO8859_1&dataCharset=GBK` (or the actual data encoding).
The agent keeps the Firebird attachment in ISO8859_1 and uses the data encoding
for SQL text sent to Jaybird. The existing decoder recovers returned text and
comments from their Latin-1 byte representation. UTF8 and other attachment
character sets retain their normal behavior.

This compatibility mode covers SQL execution, including grid transactions and
batch updates. It does not change Jaybird's encoding of bound JDBC parameters.

Run the opt-in tests against an isolated Firebird 5 database:

```sh
DBX_FIREBIRD_JDBC_URL='jdbc:firebirdsql://localhost:3050/path/to/test.fdb' \
DBX_FIREBIRD_USER=SYSDBA DBX_FIREBIRD_PASSWORD='test-password' \
./gradlew :firebird:test
```

The tests create and remove temporary tables and verify stored bytes independently
of the agent's display decoder. To check the issue #13084 attachment, also set
`DBX_FIREBIRD_BARCODE_JDBC_URL` to a disposable copy of `BarCode.FDB`. That test
updates `SYS_Color.Name`, reconnects, checks its GBK bytes, and restores the value.
