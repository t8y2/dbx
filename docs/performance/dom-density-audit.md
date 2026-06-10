# DOM density and memory audit

Date: 2026-05-22

Baseline: `upstream/main` at `6c83b10`
Candidate: `perf/dom-density-audit`

## Method

- Built both baseline and candidate as production Vite bundles.
- Ran each measurement in a fresh headless Google Chrome process with a fresh profile.
- Rendered the same synthetic large-result scenarios by driving the app stores and mocked desktop APIs.
- Ran 3 isolated samples per scenario and reported the median.
- Collected RSS from the full Chrome process tree after forced garbage collection. RSS includes browser process overhead, so the comparable signal is the delta.
- Collected JS heap with `Runtime.getHeapUsage` after `HeapProfiler.collectGarbage` and `globalThis.gc()`.

## Memory Results

| Scenario              | Before RSS MiB | After RSS MiB | RSS Delta MiB | Before JS Heap MiB | After JS Heap MiB | JS Heap Delta MiB |
| --------------------- | -------------: | ------------: | ------------: | -----------------: | ----------------: | ----------------: |
| Grid 1000 x 20        |         1226.3 |        1214.2 |         -12.1 |               19.6 |              16.6 |              -3.0 |
| Grid 1000 x 200       |         1462.5 |        1399.7 |         -62.8 |               96.7 |              67.5 |             -29.2 |
| Redis list value 3000 |         1396.6 |        1185.4 |        -211.2 |               82.7 |              11.3 |             -71.4 |
| Redis hash value 3000 |         1402.3 |        1183.8 |        -218.5 |               83.7 |              11.5 |             -72.2 |
| Redis stream 1000 x 5 |         1444.3 |        1182.1 |        -262.2 |               92.5 |              13.3 |             -79.2 |

## DOM Results

| Scenario              | Before DOM Elements | After DOM Elements | Element Delta | Before DOM Nodes | After DOM Nodes | Node Delta | Listener Delta |
| --------------------- | ------------------: | -----------------: | ------------: | ---------------: | --------------: | ---------: | -------------: |
| Grid 1000 x 20        |                6937 |               1837 |         -5100 |            12644 |            8564 |      -4080 |          -1020 |
| Grid 1000 x 200       |               65257 |              14257 |        -51000 |           106784 |           65984 |     -40800 |         -10200 |
| Redis list value 3000 |               57293 |               1096 |        -56197 |            82472 |            2760 |     -79712 |         -11839 |
| Redis hash value 3000 |               57295 |               1098 |        -56197 |            82478 |            2766 |     -79712 |         -11839 |
| Redis stream 1000 x 5 |               62281 |               1180 |        -61101 |            96450 |            2928 |     -93522 |         -14759 |

## Notes

- The grid reduction comes from mounting the cell detail action only for the hovered or currently open detail cell.
- The Redis reduction comes from virtualizing large list, set, hash, sorted set, and stream value rows.
- Existing user operations remain available: the cell detail action appears on hover or while its detail panel is open, and Redis row actions still operate on the visible virtualized rows.
