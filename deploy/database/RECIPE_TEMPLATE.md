# Database Recipe Template

Create `deploy/database/<product>/<version>/` with `recipe.json`, `compose.yaml`, and an `init/` directory. Set `defaultPort` to the native service port, then declare every default host mapping in `hostPorts`. `connection.port` and the Compose `DB_PORT` fallback must both match `hostPorts.DB_PORT`.

Every recipe must use a pinned image, default its host binding to `${DB_BIND_ADDRESS:-127.0.0.1}`, allocate unique host ports from its product's `101xx`-`115xx` range, set `container_name` to `dbx-<product>-<version>`, use password `123456`, and initialize database `dbx`. Redis-like services without named databases use DB 0 and the `dbx:` key prefix.

Add both a non-interactive `smoke.steps` command and an interactive `shell` command to `recipe.json`, then run:

```bash
pnpm test:db-env
make db-check
make db-verify DB=<product>@<version>
make db-reset DB=<product>@<version> CONFIRM=1
```
