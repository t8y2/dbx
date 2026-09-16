package gohive

import (
	"context"
	"database/sql/driver"
	"fmt"
	"io"
	"strings"

	"github.com/beltran/gohive/v2/hiveserver"
	"github.com/pkg/errors"
)

// MetadataResult contains the tabular result returned by a HiveServer2
// metadata operation.
type MetadataResult struct {
	Columns []string
	Rows    [][]driver.Value
}

// MetadataProvider exposes HiveServer2 metadata RPCs through database/sql's
// Conn.Raw API.
type MetadataProvider interface {
	GetHiveSchemas(context.Context, string) (MetadataResult, error)
	GetHiveTables(context.Context, string, string, []string) (MetadataResult, error)
	GetHiveColumns(context.Context, string, string, string) (MetadataResult, error)
	GetHiveTypeInfo(context.Context) (MetadataResult, error)
}

var _ MetadataProvider = (*sqlConnection)(nil)

func (connection *sqlConnection) GetHiveSchemas(ctx context.Context, schemaPattern string) (MetadataResult, error) {
	request := hiveserver.NewTGetSchemasReq()
	request.SessionHandle = connection.conn.sessionHandle
	request.SchemaName = hivePattern(schemaPattern)
	connection.conn.clientMu.Lock()
	response, err := connection.conn.client.GetSchemas(ctx, request)
	connection.conn.clientMu.Unlock()
	if err != nil {
		return MetadataResult{}, err
	}
	if response == nil {
		return MetadataResult{}, errors.New("HiveServer2 GetSchemas returned no response")
	}
	return connection.readHiveMetadata(ctx, "GetSchemas", response.GetStatus(), response.GetOperationHandle())
}

func (connection *sqlConnection) GetHiveTables(
	ctx context.Context,
	schemaPattern string,
	tablePattern string,
	tableTypes []string,
) (MetadataResult, error) {
	request := hiveserver.NewTGetTablesReq()
	request.SessionHandle = connection.conn.sessionHandle
	request.SchemaName = hivePattern(schemaPattern)
	request.TableName = hivePattern(tablePattern)
	request.TableTypes = append([]string(nil), tableTypes...)
	connection.conn.clientMu.Lock()
	response, err := connection.conn.client.GetTables(ctx, request)
	connection.conn.clientMu.Unlock()
	if err != nil {
		return MetadataResult{}, err
	}
	if response == nil {
		return MetadataResult{}, errors.New("HiveServer2 GetTables returned no response")
	}
	return connection.readHiveMetadata(ctx, "GetTables", response.GetStatus(), response.GetOperationHandle())
}

func (connection *sqlConnection) GetHiveColumns(
	ctx context.Context,
	schemaPattern string,
	tablePattern string,
	columnPattern string,
) (MetadataResult, error) {
	request := hiveserver.NewTGetColumnsReq()
	request.SessionHandle = connection.conn.sessionHandle
	request.SchemaName = hivePattern(schemaPattern)
	request.TableName = hivePattern(tablePattern)
	request.ColumnName = hivePattern(columnPattern)
	connection.conn.clientMu.Lock()
	response, err := connection.conn.client.GetColumns(ctx, request)
	connection.conn.clientMu.Unlock()
	if err != nil {
		return MetadataResult{}, err
	}
	if response == nil {
		return MetadataResult{}, errors.New("HiveServer2 GetColumns returned no response")
	}
	return connection.readHiveMetadata(ctx, "GetColumns", response.GetStatus(), response.GetOperationHandle())
}

func (connection *sqlConnection) GetHiveTypeInfo(ctx context.Context) (MetadataResult, error) {
	request := hiveserver.NewTGetTypeInfoReq()
	request.SessionHandle = connection.conn.sessionHandle
	connection.conn.clientMu.Lock()
	response, err := connection.conn.client.GetTypeInfo(ctx, request)
	connection.conn.clientMu.Unlock()
	if err != nil {
		return MetadataResult{}, err
	}
	if response == nil {
		return MetadataResult{}, errors.New("HiveServer2 GetTypeInfo returned no response")
	}
	return connection.readHiveMetadata(ctx, "GetTypeInfo", response.GetStatus(), response.GetOperationHandle())
}

func (connection *sqlConnection) readHiveMetadata(
	ctx context.Context,
	action string,
	status *hiveserver.TStatus,
	operationHandle *hiveserver.TOperationHandle,
) (MetadataResult, error) {
	status = safeStatus(status)
	if !success(status) {
		return MetadataResult{}, &Error{
			Err:       fmt.Errorf("HiveServer2 %s failed: %s", action, status.String()),
			Message:   status.GetErrorMessage(),
			ErrorCode: int(status.GetErrorCode()),
			SQLState:  status.GetSqlState(),
		}
	}
	if operationHandle == nil {
		return MetadataResult{}, fmt.Errorf("HiveServer2 %s returned no operation handle", action)
	}
	metadataRows := &rows{
		cursor: &cursor{
			conn:            connection.conn,
			operationHandle: operationHandle,
		},
		ctx: ctx,
	}
	defer metadataRows.Close()
	columns := metadataRows.Columns()
	if err := metadataRows.cursor.error(); err != nil {
		return MetadataResult{}, err
	}
	result := MetadataResult{Columns: columns, Rows: make([][]driver.Value, 0)}
	for {
		values := make([]driver.Value, len(columns))
		err := metadataRows.Next(values)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return MetadataResult{}, err
		}
		result.Rows = append(result.Rows, values)
	}
	return result, nil
}

func hivePattern(value string) *hiveserver.TPatternOrIdentifier {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "%"
	}
	pattern := hiveserver.TPatternOrIdentifier(value)
	return &pattern
}
