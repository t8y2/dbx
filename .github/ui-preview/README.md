# UI preview

`.github/workflows/ui-preview.yml` shows reviewers what a pull request does to the UI, the way
[yetone/magpie](https://github.com/yetone/magpie) does for its own — this is a port of that
pipeline, adapted to dbx's Tauri/frontend split. When a PR touches `apps/desktop/src/` (or
carries the `ui-preview` label), the workflow does this:

1. **publish.mjs detect** decides whether the PR is a UI change, and which lane it is:
   a diff that reaches `crates/`, `plugins/` or `src-tauri/` is a *rust* lane, anything else
   is a *web* lane. It puts a "recording…" note in a fixed block at the foot of the PR
   description, between `<!-- dbx-ui-preview:begin -->` and `<!-- dbx-ui-preview:end -->`.
2. **The record job** builds the PR's frontend (`pnpm build`) and runs it against a backend:
   the released dbx-web static binary (web lane — no Rust is built; the PR's `dist/` replaces
   the embedded frontend via `DBX_STATIC_DIR`), or dbx-web built from the PR (rust lane).
   **run.sh** starts it headless (`DBX_DISABLE_PASSWORD=1`, an isolated home), then
   **seed.mjs** fills it with made-up data, so a change that only shows with data can be seen:
   - two SQLite databases with fixed, deterministic content (orders/products/customers with
     a view, a trigger and foreign keys; an events table that pages), saved as two
     connections and really connected and queried through the app;
   - a saved-SQL folder with three files, and three days of query history (real executions
     plus seeded entries, a few failures among them).
3. **record.mjs**, which:
   - gives DeepSeek the diff, an outline of the running app, and the changed frontend files;
   - has it plan scenes: what to click, double-click, hover, type and capture;
   - walks the plan in Chromium with `cursor.js` drawing the pointer, its trail and each
     click. It always takes screenshots. When the plan interacts, it also records an mp4,
     never a GIF — each scene on a page of its own, its load trimmed off and the takes
     joined, so scene changes read as cuts rather than the app reloading. A failed step
     is re-planned from the page as it is (up to three times),
     after an Escape clears anything the failure left open (a menu, a dialog); what still
     fails is listed honestly in the PR block, and shots taken after a failure in their
     scene are marked ⚠️ both there and on the Pages player.
4. **publish.mjs publish** puts the files under `pr-<n>/<sha>/` on the `ui-previews` branch,
   which GitHub Pages serves, and rewrites the block in the description: the video's poster
   links to the player page (GitHub won't embed a video it didn't host), the screenshots are
   shown inline, and the plan's summary / mismatch (what the description claims but the diff
   doesn't do) / unseen (what this sandbox can't show) notes go on top.

Security: the recording job runs the PR's code without asking anyone — its frontend build
scripts, and in the rust lane the PR's backend itself. Any PR's code can therefore read
the planner's API key (`PLAN_API_KEY`, environment `ui-preview`), so the key there should
have a low spending limit. That job has no write access, and the job that writes never
runs the PR's code. The planner talks to any OpenAI-compatible endpoint
(`PLAN_API_URL`, default AtlasCloud; `PLAN_MODEL`, overridable via the
`UI_PREVIEW_PLAN_MODEL` repo variable).

Known limits: the recording is of the web build, so desktop-shell behaviour (detached tabs,
OS dialogs) is not covered; in the web lane the backend is the released dbx-web, so a PR
whose frontend calls an endpoint newer than the release records that call failing — the
honest-notes fields are the place that shows up.

To run it locally against a dbx-web that already runs somewhere (all of record.mjs, none of
the starting):

```sh
cd .github/ui-preview && npm install && npx playwright install chromium
DBX_URL=http://127.0.0.1:4280 PLAN_API_KEY=… DIFF_FILE=pr.diff PR_TITLE=… \
  OUT_DIR=/tmp/out SRC_DIR=../.. node record.mjs          # a plan from DeepSeek
PLAN_FILE=plan.json DBX_URL=… … node record.mjs           # or a hand-written plan
```

`seed.mjs dbs <dir>` writes the databases; `seed.mjs api <url> <dir> [--as <server path>]`
seeds a running instance (pass `--as` when the databases live where dbx-web runs, not where
you run the script — testing over an SSH tunnel).

To re-run it for a PR, use `gh workflow run ui-preview.yml -f pr=<n>`.
