# DBX tiberius patch

This directory vendors `tiberius` 0.12.3 from crates.io. The source package is
identified by the checksum
`a1446cb4198848d1562301a3340424b4f425ef79f35ef9ee034769a9dd92c10d` and the
upstream release tag points to commit
`0e2897a276166503ba78fe3e1cee501e9a034021`.

DBX changes only SQL Server Unicode column-data decoding:

- NCHAR, NVARCHAR, and NTEXT row values replace unpaired UTF-16 surrogates with
  U+FFFD, matching the Microsoft JDBC driver's observable behavior.
- Odd byte lengths remain protocol errors, including an explicit NTEXT guard
  that prevents truncating a trailing byte and desynchronizing the TDS stream.
- Metadata, environment tokens, other protocol strings, and non-Unicode
  codepage decoding retain upstream's strict behavior.

The regression tests in `src/tds/codec/column_data.rs` exercise the decoder
with raw TDS value frames. The upstream integration fixtures are omitted from
this minimal vendor copy because the crates.io manifest does not include their
repository-only `runtimes-macro` dependency; library unit tests remain enabled.
Upstream tracks the same failure in
<https://github.com/prisma/tiberius/issues/325>. Remove this patch after an
equivalent fix is released upstream.
