package client

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/apache/iotdb-client-go/v2/common"
	"github.com/apache/iotdb-client-go/v2/rpc"
)

const startIndex = int32(2)

type IoTDBRpcDataSet struct {
	sql                              string
	isClosed                         bool
	client                           *rpc.IClientRPCServiceClient
	columnNameList                   []string         // no deduplication
	columnTypeList                   []string         // no deduplication
	columnOrdinalMap                 map[string]int32 // used because the server returns deduplicated columns
	columnName2TsBlockColumnIndexMap map[string]int32

	// column index -> TsBlock column index
	columnIndex2TsBlockColumnIndexList []int32

	dataTypeForTsBlockColumn []TSDataType
	fetchSize                int32
	timeout                  *int64
	hasCachedRecord          bool
	lastReadWasNull          bool

	columnSize int32

	sessionId       int64
	queryId         int64
	statementId     int64
	time            int64
	ignoreTimestamp bool
	// indicates that there is still more data in server side and we can call fetchResult to get more
	moreData bool

	queryResult      [][]byte
	curTsBlock       *TsBlock
	queryResultSize  int32 // the length of queryResult
	queryResultIndex int32 // the index of bytebuffer in queryResult
	tsBlockSize      int32 // the size of current tsBlock
	tsBlockIndex     int32 // the row index in current tsBlock

	zoneId        *time.Location
	timeFormat    string
	timeFactor    int32
	timePrecision string
}

func NewIoTDBRpcDataSet(sql string, columnNameList []string, columnTypeList []string, columnNameIndex map[string]int32, ignoreTimestamp bool, moreData bool, queryId int64, statementId int64, client *rpc.IClientRPCServiceClient, sessionId int64, queryResult [][]byte, fetchSize int32, timeout *int64, zoneId string, timeFormat string, timeFactor int32, columnIndex2TsBlockColumnIndexList []int32) (rpcDataSet *IoTDBRpcDataSet, err error) {
	ds := &IoTDBRpcDataSet{
		sessionId:                        sessionId,
		statementId:                      statementId,
		ignoreTimestamp:                  ignoreTimestamp,
		sql:                              sql,
		queryId:                          queryId,
		client:                           client,
		fetchSize:                        fetchSize,
		timeout:                          timeout,
		moreData:                         moreData,
		columnSize:                       int32(len(columnNameList)),
		columnNameList:                   make([]string, 0, len(columnNameList)+1),
		columnTypeList:                   make([]string, 0, len(columnTypeList)+1),
		columnOrdinalMap:                 make(map[string]int32),
		columnName2TsBlockColumnIndexMap: make(map[string]int32),
	}
	columnStartIndex := int32(1)
	resultSetColumnSize := int32(len(columnNameList))
	// newly generated or updated columnIndex2TsBlockColumnIndexList.size() may not be equal to
	// columnNameList.size()
	// so we need startIndexForColumnIndex2TsBlockColumnIndexList to adjust the mapping relation
	startIndexForColumnIndex2TsBlockColumnIndexList := int32(0)

	// for Time Column in tree model which should always be the first column and its index for
	// TsBlockColumn is -1
	if !ignoreTimestamp {
		ds.columnNameList = append(ds.columnNameList, TimestampColumnName)
		ds.columnTypeList = append(ds.columnTypeList, "INT64")
		ds.columnName2TsBlockColumnIndexMap[TimestampColumnName] = -1
		ds.columnOrdinalMap[TimestampColumnName] = 1
		if columnIndex2TsBlockColumnIndexList != nil {
			newColumnIndex2TsBlockColumnIndexList := make([]int32, 0, len(columnIndex2TsBlockColumnIndexList)+1)
			newColumnIndex2TsBlockColumnIndexList = append(newColumnIndex2TsBlockColumnIndexList, -1)
			newColumnIndex2TsBlockColumnIndexList = append(newColumnIndex2TsBlockColumnIndexList, columnIndex2TsBlockColumnIndexList...)
			columnIndex2TsBlockColumnIndexList = newColumnIndex2TsBlockColumnIndexList
			startIndexForColumnIndex2TsBlockColumnIndexList = 1
		}
		columnStartIndex += 1
		resultSetColumnSize += 1
	}

	ds.columnNameList = append(ds.columnNameList, columnNameList...)
	ds.columnTypeList = append(ds.columnTypeList, columnTypeList...)

	if columnIndex2TsBlockColumnIndexList == nil {
		columnIndex2TsBlockColumnIndexList = make([]int32, 0, resultSetColumnSize)
		if !ignoreTimestamp {
			startIndexForColumnIndex2TsBlockColumnIndexList = 1
			columnIndex2TsBlockColumnIndexList = append(columnIndex2TsBlockColumnIndexList, -1)
		}
		// IoTDB 1.3.x servers send columnNameIndex (column name -> deduplicated
		// value column index) instead of the ordered index list, because their
		// aggregate TsBlock column order may differ from the SELECT list. Prefer
		// that mapping so values stay aligned with column names.
		for i, columnName := range columnNameList {
			if index, ok := columnNameIndex[columnName]; ok {
				columnIndex2TsBlockColumnIndexList = append(columnIndex2TsBlockColumnIndexList, index)
			} else {
				columnIndex2TsBlockColumnIndexList = append(columnIndex2TsBlockColumnIndexList, int32(i))
			}
		}
	}

	tsBlockColumnSize := int32(0)
	for _, value := range columnIndex2TsBlockColumnIndexList {
		if value > tsBlockColumnSize {
			tsBlockColumnSize = value
		}
	}
	tsBlockColumnSize += 1
	ds.dataTypeForTsBlockColumn = make([]TSDataType, tsBlockColumnSize)

	for i, columnName := range columnNameList {
		tsBlockColumnIndex := columnIndex2TsBlockColumnIndexList[startIndexForColumnIndex2TsBlockColumnIndexList+int32(i)]
		if tsBlockColumnIndex != -1 {
			columnType, err := GetDataTypeByStr(columnTypeList[i])
			if err != nil {
				return nil, err
			}
			ds.dataTypeForTsBlockColumn[tsBlockColumnIndex] = columnType
		}
		if _, exists := ds.columnName2TsBlockColumnIndexMap[columnName]; !exists {
			ds.columnOrdinalMap[columnName] = int32(i) + columnStartIndex
			ds.columnName2TsBlockColumnIndexMap[columnName] = tsBlockColumnIndex
		}
	}

	ds.queryResult = queryResult
	if queryResult != nil {
		ds.queryResultSize = int32(len(queryResult))
	} else {
		ds.queryResultSize = 0
	}
	ds.queryResultIndex = 0
	ds.tsBlockSize = 0
	ds.tsBlockIndex = -1
	if ds.zoneId, err = time.LoadLocation(zoneId); err != nil {
		return nil, err
	}
	ds.timeFormat = timeFormat
	ds.timeFactor = timeFactor
	if ds.timePrecision, err = getTimePrecision(timeFactor); err != nil {
		return nil, err
	}
	if len(columnIndex2TsBlockColumnIndexList) != len(ds.columnNameList) {
		return nil, fmt.Errorf("size of columnIndex2TsBlockColumnIndexList %v doesn't equal to size of columnNameList %v", len(columnIndex2TsBlockColumnIndexList), len(ds.columnNameList))
	}
	ds.columnIndex2TsBlockColumnIndexList = columnIndex2TsBlockColumnIndexList
	return ds, nil
}

func (s *IoTDBRpcDataSet) Close() (err error) {
	if s.isClosed {
		return nil
	}
	closeRequest := &rpc.TSCloseOperationReq{
		SessionId:   s.sessionId,
		StatementId: &s.statementId,
		QueryId:     &s.queryId,
	}

	var status *common.TSStatus
	status, err = s.client.CloseOperation(context.Background(), closeRequest)
	if err == nil {
		err = VerifySuccess(status)
	}
	s.client = nil
	s.isClosed = true
	return err
}

func (s *IoTDBRpcDataSet) Next() (result bool, err error) {
	if s.hasCachedBlock() {
		s.lastReadWasNull = false
		err = s.constructOneRow()
		return true, err
	}
	if s.hasCachedByteBuffer() {
		if err = s.constructOneTsBlock(); err != nil {
			return false, err
		}
		err = s.constructOneRow()
		return true, err
	}

	if s.moreData {
		hasResultSet, err := s.fetchResults()
		if err != nil {
			return false, err
		}
		if hasResultSet && s.hasCachedByteBuffer() {
			if err = s.constructOneTsBlock(); err != nil {
				return false, err
			}
			err = s.constructOneRow()
			return true, err
		}
	}
	err = s.Close()
	if err != nil {
		return false, err
	}
	return false, nil
}

func (s *IoTDBRpcDataSet) fetchResults() (bool, error) {
	if s.isClosed {
		return false, fmt.Errorf("this data set is already closed")
	}
	req := rpc.TSFetchResultsReq{
		SessionId: s.sessionId,
		Statement: s.sql,
		FetchSize: s.fetchSize,
		QueryId:   s.queryId,
		IsAlign:   true,
	}
	req.Timeout = s.timeout

	resp, err := s.client.FetchResultsV2(context.Background(), &req)

	if err != nil {
		return false, err
	}

	if err = VerifySuccess(resp.Status); err != nil {
		return false, err
	}

	s.moreData = resp.GetMoreData()

	if !resp.HasResultSet {
		err = s.Close()
	} else {
		s.queryResult = resp.GetQueryResult_()
		s.queryResultIndex = 0
		if s.queryResult != nil {
			s.queryResultSize = int32(len(s.queryResult))
		} else {
			s.queryResultSize = 0
		}
		s.tsBlockSize = 0
		s.tsBlockIndex = -1
	}
	return resp.HasResultSet, err
}

func (s *IoTDBRpcDataSet) hasCachedBlock() bool {
	return s.curTsBlock != nil && s.tsBlockIndex < s.tsBlockSize-1
}

func (s *IoTDBRpcDataSet) hasCachedByteBuffer() bool {
	return s.queryResult != nil && s.queryResultIndex < s.queryResultSize
}

func (s *IoTDBRpcDataSet) constructOneRow() (err error) {
	s.tsBlockIndex++
	s.hasCachedRecord = true
	s.time, err = s.curTsBlock.GetTimeColumn().GetLong(s.tsBlockIndex)
	return err
}

func (s *IoTDBRpcDataSet) constructOneTsBlock() (err error) {
	s.lastReadWasNull = false
	curTsBlockBytes := s.queryResult[s.queryResultIndex]
	s.queryResultIndex = s.queryResultIndex + 1
	s.curTsBlock, err = DeserializeTsBlock(curTsBlockBytes)
	if err != nil {
		return err
	}
	s.tsBlockIndex = -1
	s.tsBlockSize = s.curTsBlock.GetPositionCount()
	return nil
}

func (s *IoTDBRpcDataSet) isNullByIndex(columnIndex int32) (bool, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return false, err
	} else {
		return s.isNull(index, s.tsBlockIndex), nil
	}
}

func (s *IoTDBRpcDataSet) isNullByColumnName(columnName string) (bool, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return false, err
	} else {
		return s.isNull(index, s.tsBlockIndex), nil
	}
}

func (s *IoTDBRpcDataSet) isNull(index int32, rowNum int32) bool {
	// -1 for time column which will never be null
	return index >= 0 && s.curTsBlock.GetColumn(index).IsNull(rowNum)
}

func (s *IoTDBRpcDataSet) getBooleanByIndex(columnIndex int32) (bool, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return false, err
	} else {
		return s.getBooleanByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getBoolean(columnName string) (bool, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return false, err
	} else {
		return s.getBooleanByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getBooleanByTsBlockColumnIndex(tsBlockColumnIndex int32) (bool, error) {
	if err := s.checkRecord(); err != nil {
		return false, err
	}
	if !s.isNull(tsBlockColumnIndex, s.tsBlockIndex) {
		s.lastReadWasNull = false
		return s.curTsBlock.GetColumn(tsBlockColumnIndex).GetBoolean(s.tsBlockIndex)
	} else {
		s.lastReadWasNull = true
		return false, nil
	}
}

func (s *IoTDBRpcDataSet) getDoubleByIndex(columnIndex int32) (float64, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return 0, err
	} else {
		return s.getDoubleByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getDouble(columnName string) (float64, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return 0, err
	} else {
		return s.getDoubleByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getDoubleByTsBlockColumnIndex(tsBlockColumnIndex int32) (float64, error) {
	if err := s.checkRecord(); err != nil {
		return 0, err
	}
	if !s.isNull(tsBlockColumnIndex, s.tsBlockIndex) {
		s.lastReadWasNull = false
		return s.curTsBlock.GetColumn(tsBlockColumnIndex).GetDouble(s.tsBlockIndex)
	} else {
		s.lastReadWasNull = true
		return 0, nil
	}
}

func (s *IoTDBRpcDataSet) getFloatByIndex(columnIndex int32) (float32, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return 0, err
	} else {
		return s.getFloatByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getFloat(columnName string) (float32, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return 0, err
	} else {
		return s.getFloatByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getFloatByTsBlockColumnIndex(tsBlockColumnIndex int32) (float32, error) {
	if err := s.checkRecord(); err != nil {
		return 0, err
	}
	if !s.isNull(tsBlockColumnIndex, s.tsBlockIndex) {
		s.lastReadWasNull = false
		return s.curTsBlock.GetColumn(tsBlockColumnIndex).GetFloat(s.tsBlockIndex)
	} else {
		s.lastReadWasNull = true
		return 0, nil
	}
}

func (s *IoTDBRpcDataSet) getIntByIndex(columnIndex int32) (int32, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return 0, err
	} else {
		return s.getIntByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getInt(columnName string) (int32, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return 0, err
	} else {
		return s.getIntByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getIntByTsBlockColumnIndex(tsBlockColumnIndex int32) (int32, error) {
	if err := s.checkRecord(); err != nil {
		return 0, err
	}
	if !s.isNull(tsBlockColumnIndex, s.tsBlockIndex) {
		s.lastReadWasNull = false
		dataType := s.curTsBlock.GetColumn(tsBlockColumnIndex).GetDataType()
		if dataType == INT64 {
			if v, err := s.curTsBlock.GetColumn(tsBlockColumnIndex).GetLong(s.tsBlockIndex); err != nil {
				return 0, err
			} else {
				return int32(v), nil
			}
		}
		return s.curTsBlock.GetColumn(tsBlockColumnIndex).GetInt(s.tsBlockIndex)
	} else {
		s.lastReadWasNull = true
		return 0, nil
	}
}

func (s *IoTDBRpcDataSet) getLongByIndex(columnIndex int32) (int64, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return 0, err
	} else {
		return s.getLongByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getLong(columnName string) (int64, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return 0, err
	} else {
		return s.getLongByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getLongByTsBlockColumnIndex(tsBlockColumnIndex int32) (int64, error) {
	if err := s.checkRecord(); err != nil {
		return 0, err
	}
	if tsBlockColumnIndex < 0 {
		s.lastReadWasNull = false
		return s.curTsBlock.GetTimeByIndex(s.tsBlockIndex)
	}
	if !s.isNull(tsBlockColumnIndex, s.tsBlockIndex) {
		s.lastReadWasNull = false
		dataType := s.curTsBlock.GetColumn(tsBlockColumnIndex).GetDataType()
		if dataType == INT32 {
			if v, err := s.curTsBlock.GetColumn(tsBlockColumnIndex).GetInt(s.tsBlockIndex); err != nil {
				return 0, err
			} else {
				return int64(v), nil
			}
		}
		return s.curTsBlock.GetColumn(tsBlockColumnIndex).GetLong(s.tsBlockIndex)
	} else {
		s.lastReadWasNull = true
		return 0, nil
	}
}

func (s *IoTDBRpcDataSet) getBinaryByIndex(columnIndex int32) (*Binary, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return nil, err
	} else {
		return s.getBinaryByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getBinary(columnName string) (*Binary, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return nil, err
	} else {
		return s.getBinaryByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getBinaryByTsBlockColumnIndex(tsBlockColumnIndex int32) (*Binary, error) {
	if err := s.checkRecord(); err != nil {
		return nil, err
	}
	if !s.isNull(tsBlockColumnIndex, s.tsBlockIndex) {
		s.lastReadWasNull = false
		return s.curTsBlock.GetColumn(tsBlockColumnIndex).GetBinary(s.tsBlockIndex)
	} else {
		s.lastReadWasNull = true
		return nil, nil
	}
}

func (s *IoTDBRpcDataSet) getObjectByIndex(columnIndex int32) (interface{}, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return nil, err
	} else {
		return s.getObjectByTsBlockIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getObject(columnName string) (interface{}, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return nil, err
	} else {
		return s.getObjectByTsBlockIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getObjectByTsBlockIndex(tsBlockColumnIndex int32) (interface{}, error) {
	if err := s.checkRecord(); err != nil {
		return nil, err
	}
	if s.isNull(tsBlockColumnIndex, s.tsBlockIndex) {
		s.lastReadWasNull = true
		return nil, nil
	}
	s.lastReadWasNull = false
	dataType := s.getDataTypeByTsBlockColumnIndex(tsBlockColumnIndex)
	switch dataType {
	case BOOLEAN, INT32, INT64, FLOAT, DOUBLE:
		return s.curTsBlock.GetColumn(tsBlockColumnIndex).GetObject(s.tsBlockIndex)
	case TIMESTAMP:
		var timestamp int64
		var err error
		if tsBlockColumnIndex == -1 {
			timestamp, err = s.curTsBlock.GetTimeByIndex(s.tsBlockIndex)
		} else {
			timestamp, err = s.curTsBlock.GetColumn(tsBlockColumnIndex).GetLong(s.tsBlockIndex)
		}
		if err != nil {
			return nil, err
		}
		return convertToTimestamp(timestamp, s.timeFactor), nil
	case TEXT, STRING:
		if binary, err := s.curTsBlock.GetColumn(tsBlockColumnIndex).GetBinary(s.tsBlockIndex); err != nil {
			return nil, err
		} else {
			return binary.GetStringValue(), nil
		}
	case BLOB:
		if binary, err := s.curTsBlock.GetColumn(tsBlockColumnIndex).GetBinary(s.tsBlockIndex); err != nil {
			return nil, err
		} else {
			return binary.GetValues(), nil
		}
	case DATE:
		if value, err := s.curTsBlock.GetColumn(tsBlockColumnIndex).GetInt(s.tsBlockIndex); err != nil {
			return nil, err
		} else {
			return Int32ToDate(value)
		}
	default:
		return nil, nil
	}
}

func (s *IoTDBRpcDataSet) getStringByIndex(columnIndex int32) (string, error) {
	columnIndex, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex)
	if err != nil {
		return "", err
	}
	return s.getStringByTsBlockColumnIndex(columnIndex)
}

func (s *IoTDBRpcDataSet) getString(columnName string) (string, error) {
	columnIndex, err := s.getTsBlockColumnIndexForColumnName(columnName)
	if err != nil {
		return "", err
	}
	return s.getStringByTsBlockColumnIndex(columnIndex)
}

func (s *IoTDBRpcDataSet) getStringByTsBlockColumnIndex(tsBlockColumnIndex int32) (string, error) {
	if err := s.checkRecord(); err != nil {
		return "", err
	}
	// to keep compatibility, tree model should return a long value for time column
	if tsBlockColumnIndex == -1 {
		timestamp, err := s.curTsBlock.GetTimeByIndex(s.tsBlockIndex)
		if err != nil {
			return "", err
		}
		return int64ToString(timestamp), nil
	}
	if s.isNull(tsBlockColumnIndex, s.tsBlockIndex) {
		s.lastReadWasNull = true
		return "", nil
	}
	s.lastReadWasNull = false
	return s.getStringByTsBlockColumnIndexAndDataType(tsBlockColumnIndex, s.getDataTypeByTsBlockColumnIndex(tsBlockColumnIndex))
}

func (s *IoTDBRpcDataSet) getStringByTsBlockColumnIndexAndDataType(index int32, tsDataType TSDataType) (string, error) {
	switch tsDataType {
	case BOOLEAN:
		if v, err := s.curTsBlock.GetColumn(index).GetBoolean(s.tsBlockIndex); err != nil {
			return "", nil
		} else {
			return strconv.FormatBool(v), nil
		}
	case INT32:
		if v, err := s.curTsBlock.GetColumn(index).GetInt(s.tsBlockIndex); err != nil {
			return "", err
		} else {
			return int32ToString(v), nil
		}
	case INT64:
		if v, err := s.curTsBlock.GetColumn(index).GetLong(s.tsBlockIndex); err != nil {
			return "", err
		} else {
			return int64ToString(v), nil
		}
	case TIMESTAMP:
		if v, err := s.curTsBlock.GetColumn(index).GetLong(s.tsBlockIndex); err != nil {
			return "", err
		} else {
			return formatDatetime(DEFAULT_TIME_FORMAT, s.timePrecision, v, s.zoneId), nil
		}
	case FLOAT:
		if v, err := s.curTsBlock.GetColumn(index).GetFloat(s.tsBlockIndex); err != nil {
			return "", err
		} else {
			return float32ToString(v), nil
		}
	case DOUBLE:
		if v, err := s.curTsBlock.GetColumn(index).GetDouble(s.tsBlockIndex); err != nil {
			return "", err
		} else {
			return float64ToString(v), nil
		}
	case TEXT, STRING:
		if v, err := s.curTsBlock.GetColumn(index).GetBinary(s.tsBlockIndex); err != nil {
			return "", err
		} else {
			return v.GetStringValue(), nil
		}
	case BLOB:
		if v, err := s.curTsBlock.GetColumn(index).GetBinary(s.tsBlockIndex); err != nil {
			return "", err
		} else {
			return bytesToHexString(v.values), nil
		}
	case DATE:
		v, err := s.curTsBlock.GetColumn(index).GetInt(s.tsBlockIndex)
		if err != nil {
			return "", err
		}
		t, err := Int32ToDate(v)
		if err != nil {
			return "", err
		}
		return t.Format("2006-01-02"), nil
	}
	return "", nil
}

func (s *IoTDBRpcDataSet) getTimestampByIndex(columnIndex int32) (time.Time, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return time.Time{}, err
	} else {
		return s.getTimestampByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getTimestamp(columnName string) (time.Time, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return time.Time{}, err
	} else {
		return s.getTimestampByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) getTimestampByTsBlockColumnIndex(tsBlockColumnIndex int32) (time.Time, error) {
	if value, err := s.getLongByTsBlockColumnIndex(tsBlockColumnIndex); err != nil {
		return time.Time{}, err
	} else {
		return convertToTimestamp(value, s.timeFactor), nil
	}
}

func (s *IoTDBRpcDataSet) GetDateByIndex(columnIndex int32) (time.Time, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return time.Time{}, err
	} else {
		return s.GetDateByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) GetDate(columnName string) (time.Time, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return time.Time{}, err
	} else {
		return s.GetDateByTsBlockColumnIndex(index)
	}
}

func (s *IoTDBRpcDataSet) GetDateByTsBlockColumnIndex(tsBlockColumnIndex int32) (time.Time, error) {
	if value, err := s.getIntByTsBlockColumnIndex(tsBlockColumnIndex); err != nil {
		return time.Time{}, err
	} else {
		return Int32ToDate(value)
	}
}

func (s *IoTDBRpcDataSet) getDataTypeByIndex(columnIndex int32) (TSDataType, error) {
	if index, err := s.getTsBlockColumnIndexForColumnIndex(columnIndex); err != nil {
		return UNKNOWN, err
	} else {
		return s.getDataTypeByTsBlockColumnIndex(index), nil
	}
}

func (s *IoTDBRpcDataSet) getDataType(columnName string) (TSDataType, error) {
	if index, err := s.getTsBlockColumnIndexForColumnName(columnName); err != nil {
		return UNKNOWN, err
	} else {
		return s.getDataTypeByTsBlockColumnIndex(index), nil
	}
}

func (s *IoTDBRpcDataSet) getDataTypeByTsBlockColumnIndex(tsBlockColumnIndex int32) TSDataType {
	if tsBlockColumnIndex < 0 {
		return TIMESTAMP
	} else {
		return s.dataTypeForTsBlockColumn[tsBlockColumnIndex]
	}
}

func (s *IoTDBRpcDataSet) findColumn(columnName string) int32 {
	return s.columnOrdinalMap[columnName]
}

func (s *IoTDBRpcDataSet) findColumnNameByIndex(columnIndex int32) (string, error) {
	if columnIndex <= 0 {
		return "", fmt.Errorf("column index should start from 1")
	}
	if columnIndex > int32(len(s.columnNameList)) {
		return "", fmt.Errorf("column index %d out of range %d", columnIndex, len(s.columnNameList))
	}
	return s.columnNameList[columnIndex-1], nil
}

// return -1 for time column of tree model
func (s *IoTDBRpcDataSet) getTsBlockColumnIndexForColumnName(columnName string) (int32, error) {
	if index, exists := s.columnName2TsBlockColumnIndexMap[columnName]; !exists {
		return 0, fmt.Errorf("unknown column name: %v", columnName)
	} else {
		return index, nil
	}
}

func (s *IoTDBRpcDataSet) getTsBlockColumnIndexForColumnIndex(columnIndex int32) (int32, error) {
	if columnIndex-1 >= int32(len(s.columnIndex2TsBlockColumnIndexList)) || int32(columnIndex-1) < 0 {
		return 0, fmt.Errorf("index %v out of range %v", columnIndex-1, len(s.columnIndex2TsBlockColumnIndexList))
	}
	return s.columnIndex2TsBlockColumnIndexList[columnIndex-1], nil
}

func (s *IoTDBRpcDataSet) checkRecord() (err error) {
	if s.queryResultIndex > s.queryResultSize || s.tsBlockIndex >= s.tsBlockSize || s.queryResult == nil || s.curTsBlock == nil {
		err = fmt.Errorf("no record remains")
	}
	return err
}

func (s *IoTDBRpcDataSet) GetValueColumnStartIndex() int32 {
	if s.ignoreTimestamp {
		return 0
	} else {
		return 1
	}
}

func (s *IoTDBRpcDataSet) GetColumnSize() int32 {
	return int32(len(s.columnNameList))
}

func (s *IoTDBRpcDataSet) GetColumnTypeList() []string {
	return s.columnTypeList
}

func (s *IoTDBRpcDataSet) GetColumnNameTypeList() []string {
	return s.columnTypeList
}

func (s *IoTDBRpcDataSet) IsClosed() bool {
	return s.isClosed
}

func (s *IoTDBRpcDataSet) GetFetchSize() int32 {
	return s.fetchSize
}

func (s *IoTDBRpcDataSet) SetFetchSize(fetchSize int32) {
	s.fetchSize = fetchSize
}

func (s *IoTDBRpcDataSet) HasCachedRecord() bool {
	return s.hasCachedRecord
}

func (s *IoTDBRpcDataSet) SetHasCachedRecord(hasCachedRecord bool) {
	s.hasCachedRecord = hasCachedRecord
}

func (s *IoTDBRpcDataSet) IsLastReadWasNull() bool {
	return s.lastReadWasNull
}

func (s *IoTDBRpcDataSet) GetCurrentRowTime() int64 {
	return s.time
}

func (s *IoTDBRpcDataSet) IsIgnoreTimestamp() bool {
	return s.ignoreTimestamp
}
