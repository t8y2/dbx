module github.com/t8y2/dbx/agents/drivers/iotdb

go 1.25

require github.com/apache/iotdb-client-go/v2 v2.0.9-0.20260807074554-e59fc7f55df1

require github.com/apache/thrift v0.24.0 // indirect

// Upstream ignores the 1.3.x ColumnNameIndexMap fallback, which misaligns
// aggregate result columns against the SELECT list on 1.3.x servers.
replace github.com/apache/iotdb-client-go/v2 => ../../go-common/iotdb-client-go
