/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package client

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

type TsBlock struct {
	timeColumn    Column
	valueColumns  []Column
	positionCount int32
}

func NewTsBlock(positionCount int32, timeColumn Column, valueColumns ...Column) (*TsBlock, error) {
	if valueColumns == nil {
		return nil, fmt.Errorf("blocks is null")
	}
	return &TsBlock{
		timeColumn:    timeColumn,
		valueColumns:  valueColumns,
		positionCount: positionCount,
	}, nil
}

func DeserializeTsBlock(data []byte) (*TsBlock, error) {
	// Serialized tsblock:
	//    +-------------+---------------+---------+------------+-----------+----------+
	//    | val col cnt | val col types | pos cnt | encodings  | time col  | val col  |
	//    +-------------+---------------+---------+------------+-----------+----------+
	//    | int32       | list[byte]    | int32   | list[byte] |  bytes    | bytes    |
	//    +-------------+---------------+---------+------------+-----------+----------+

	reader := bytes.NewReader(data)
	// value column count
	var valueColumnCount int32
	if err := binary.Read(reader, binary.BigEndian, &valueColumnCount); err != nil {
		return nil, err
	}

	// value column data types
	valueColumnDataTypes := make([]TSDataType, valueColumnCount)
	for i := int32(0); i < valueColumnCount; i++ {
		dataType, err := deserializeDataType(reader)
		if err != nil {
			return nil, err
		}
		valueColumnDataTypes[i] = dataType
	}

	// position count
	var positionCount int32
	if err := binary.Read(reader, binary.BigEndian, &positionCount); err != nil {
		return nil, err
	}

	// column encodings
	columnEncodings := make([]ColumnEncoding, valueColumnCount+1)
	for i := int32(0); i < valueColumnCount+1; i++ {
		columnEncoding, err := deserializeColumnEncoding(reader)
		if err != nil {
			return nil, err
		}
		columnEncodings[i] = columnEncoding
	}

	// time column
	timeColumnDecoder, err := getColumnDecoder(columnEncodings[0])
	if err != nil {
		return nil, err
	}
	timeColumn, err := timeColumnDecoder.ReadColumn(reader, INT64, positionCount)
	if err != nil {
		return nil, err
	}

	// value columns
	valueColumns := make([]Column, valueColumnCount)
	for i := int32(0); i < valueColumnCount; i++ {
		valueColumnDecoder, err := getColumnDecoder(columnEncodings[i+1])
		if err != nil {
			return nil, err
		}
		valueColumn, err := valueColumnDecoder.ReadColumn(reader, valueColumnDataTypes[i], positionCount)
		if err != nil {
			return nil, err
		}
		valueColumns[i] = valueColumn
	}
	return NewTsBlock(positionCount, timeColumn, valueColumns...)
}

func deserializeDataType(reader *bytes.Reader) (TSDataType, error) {
	b, err := reader.ReadByte()
	if err != nil {
		return UNKNOWN, err
	}
	return getDataTypeByByte(b)
}

func deserializeColumnEncoding(reader *bytes.Reader) (ColumnEncoding, error) {
	b, err := reader.ReadByte()
	if err != nil {
		return RLE_COLUMN_ENCODING, err
	}
	return getColumnEncodingByByte(b)
}

func (t *TsBlock) GetPositionCount() int32 {
	return t.positionCount
}

func (t *TsBlock) GetStartTime() (int64, error) {
	return t.timeColumn.GetLong(0)
}

func (t *TsBlock) GetEndTime() (int64, error) {
	return t.timeColumn.GetLong(t.positionCount - 1)
}

func (t *TsBlock) IsEmpty() bool {
	return t.positionCount == 0
}

func (t *TsBlock) GetTimeByIndex(index int32) (int64, error) {
	return t.timeColumn.GetLong(index)
}

func (t *TsBlock) GetValueColumnCount() int32 {
	return int32(len(t.valueColumns))
}

func (t *TsBlock) GetTimeColumn() Column {
	return t.timeColumn
}

func (t *TsBlock) GetValueColumns() *[]Column {
	return &t.valueColumns
}

func (t *TsBlock) GetColumn(columnIndex int32) Column {
	return t.valueColumns[columnIndex]
}
