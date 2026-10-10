# OceanBase Oracle metadata search and paging

Tracks #11417 and #11418. This concerns object metadata, not SQL result-set paging.

The OceanBase Oracle Agent matches an object name or a table/view comment before applying `ROWNUM` bounds. Owner and object-type constraints apply to both matches. Search is case-insensitive text/subsequence matching; `%`, `_`, backslash and quotes are literal input, bound as parameters. Other object kinds retain name matching without borrowing a same-name table's comment.

The object browser and sidebar request a bounded page with one extra row to decide whether another page exists. Displayed counts describe the loaded rows, not a server-side total. The object browser uses the existing sidebar page-size setting. It retains the Agent order instead of sorting each page independently. Slash-delimited regular expressions are not supported by this server search; the browser reports that limitation without downloading the full schema.

Core enables Agent paging for the supported name/comment/type request shape. The existing include/exclude `TableNameFilter` is not part of the Agent protocol: when supplied, Core preserves its local filtering fallback and does not push down page bounds. That request shape is not server-paged and is excluded from bounded-fetch claims.

## Refresh and concurrent DDL

Each page reflects metadata visible when that request executes. Pages do not share a database snapshot. An intervening create, drop or rename can change offsets, so use Refresh after DDL to discard loaded pages and restart from the first page. A static schema must have no duplicate or missing `(schema, object_type, name)` keys across successive pages. Object IDs break name-order ties, including quoted names under a case-insensitive session sort.

Changing search, object type or schema restarts the list. Cancelling a load or refreshing invalidates earlier responses; a late response must not append objects to the new list.

## Verification

Use a disposable OceanBase Oracle tenant or isolated test users. Never run the fixture setup in a business schema. Give ordinary fixture accounts only the privileges needed to create their own objects, and grant/revoke access to a second fixture schema explicitly.

1. Create more objects than the configured page size, including a comment-only matching table near the end, a commented view, null/empty comments, quoted mixed-case names and a same-name package specification/body pair.
2. Search Chinese/English comments and literal special characters. Verify schema and type restrictions, comment display and an empty result. Inspect each backend request for bounded `limit` and increasing `offset`.
3. Load every page and compare the returned keys with the known fixture set. Repeat with a comment-only filter and with a type filter. Verify the short final page, the following empty page and offset-only API requests.
4. Delay a request, change search/schema or refresh/cancel, then release it. Verify that it cannot replace or extend the current rows. UI component/store regressions cover this through the production consumers.
5. Verify cross-schema visibility before grants, after individual grants and after revocation. Remove only the exact fixture accounts and read back their absence.

Agent regression suite: `./gradlew :oceanbase-oracle:test`. Core protocol integration: `cargo test -p dbx-core --test oceanbase_metadata_paging`. Frontend regressions live beside `ObjectBrowser` and `connectionStore`.

Real database, browser, test and CI results belong to the PR evidence with the tested commit and Agent artifact hash. A protocol fixture or component test alone does not establish real database or GUI acceptance.
