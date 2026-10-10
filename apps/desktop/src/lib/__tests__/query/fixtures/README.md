# DB2 estimated-plan fixture

`db2-shared-temp-plan.json` was captured from the production DB2 Java Agent against DB2 LUW 11.5.9 / JCC 4.33.31. It preserves native operator, stream and cost metadata, including a TEMP operator with two consumers. It contains no connection credentials.

The parser test verifies the full subtree appears once and the second consumer is represented by a reference leaf. Generated request tags and timestamps are incidental to the assertions.
