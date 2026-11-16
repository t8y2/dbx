# Doris and SelectDB SQL assistance

The function catalogue is derived from the Apache Doris 2.1 and 3.x SQL manuals.
SelectDB connections use the Doris capability family through `jdbcDialect.ts`.

Regenerate the catalogue from an Apache `doris-website` checkout:

```sh
node scripts/generate-doris-functions.mjs /path/to/doris-website
```

The generated file records the source revision and per-function documentation
links. `documentedIn` records documentation coverage, not a minimum server
version: the 3.x manuals also contain functions added after 3.0.

Source: https://github.com/apache/doris-website (Apache License 2.0).
