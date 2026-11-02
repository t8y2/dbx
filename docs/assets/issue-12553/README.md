# Time-range generator regression preview

`time-range-preview.png` shows the production `TimeParams.vue` and
`DateTimeParams.vue` components mounted in an isolated local Vite harness, with
sample rows produced by the production `generateValue` function alongside them.
It is a component preview, not a screenshot of a live database operation.

The three examples cover midnight (`00:00` to `00:00`), a minute-level time
window (`09:15` to `09:20`), and the same daily window for datetime generation.
The automated generation and mounted-component tests cover input changes,
refresh, endpoint selection, legacy hour-only configurations, and all-day mode.
