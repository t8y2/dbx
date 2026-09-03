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
	"reflect"
	"sort"
	"time"
)

type MeasurementSchema struct {
	Measurement string
	DataType    TSDataType
}

type ColumnCategory int8

const (
	TAG = iota
	FIELD
	ATTRIBUTE
)

type Tablet struct {
	insertTargetName   string
	measurementSchemas []*MeasurementSchema
	columnCategories   []ColumnCategory
	timestamps         []int64
	values             []interface{}
	bitMaps            []*BitMap
	maxRowNumber       int
	RowSize            int
}

func (t *Tablet) Len() int {
	return t.RowSize
}

func (t *Tablet) Swap(i, j int) {
	for index, schema := range t.measurementSchemas {
		switch schema.DataType {
		case BOOLEAN:
			sortedSlice := t.values[index].([]bool)
			sortedSlice[i], sortedSlice[j] = sortedSlice[j], sortedSlice[i]
		case INT32, DATE:
			sortedSlice := t.values[index].([]int32)
			sortedSlice[i], sortedSlice[j] = sortedSlice[j], sortedSlice[i]
		case INT64, TIMESTAMP:
			sortedSlice := t.values[index].([]int64)
			sortedSlice[i], sortedSlice[j] = sortedSlice[j], sortedSlice[i]
		case FLOAT:
			sortedSlice := t.values[index].([]float32)
			sortedSlice[i], sortedSlice[j] = sortedSlice[j], sortedSlice[i]
		case DOUBLE:
			sortedSlice := t.values[index].([]float64)
			sortedSlice[i], sortedSlice[j] = sortedSlice[j], sortedSlice[i]
		case TEXT, BLOB, STRING:
			sortedSlice := t.values[index].([][]byte)
			sortedSlice[i], sortedSlice[j] = sortedSlice[j], sortedSlice[i]
		}
	}
	if t.bitMaps != nil {
		for _, bitMap := range t.bitMaps {
			if bitMap != nil {
				isNilI := bitMap.IsMarked(i)
				isNilJ := bitMap.IsMarked(j)
				if isNilI {
					bitMap.Mark(j)
				} else {
					bitMap.UnMark(j)
				}
				if isNilJ {
					bitMap.Mark(i)
				} else {
					bitMap.UnMark(i)
				}
			}
		}
	}
	t.timestamps[i], t.timestamps[j] = t.timestamps[j], t.timestamps[i]
}

func (t *Tablet) Less(i, j int) bool {
	return t.timestamps[i] < t.timestamps[j]
}

func (t *Tablet) SetTimestamp(timestamp int64, rowIndex int) {
	t.timestamps[rowIndex] = timestamp
}

// SetTimestampAt is a bounds-checked alternative to SetTimestamp. It validates
// rowIndex and returns an "illegal argument rowIndex" error instead of
// panicking with an index-out-of-range when rowIndex is negative or beyond the
// tablet's capacity, consistent with SetValueAt and GetValueAt. The existing
// SetTimestamp is preserved unchanged for source compatibility.
func (t *Tablet) SetTimestampAt(timestamp int64, rowIndex int) error {
	if rowIndex < 0 || rowIndex >= t.maxRowNumber {
		return fmt.Errorf("illegal argument rowIndex %d", rowIndex)
	}
	t.timestamps[rowIndex] = timestamp
	return nil
}

func (t *Tablet) SetValueAt(value interface{}, columnIndex, rowIndex int) error {

	if columnIndex < 0 || columnIndex >= len(t.measurementSchemas) {
		return fmt.Errorf("illegal argument columnIndex %d", columnIndex)
	}

	if rowIndex < 0 || rowIndex >= t.maxRowNumber {
		return fmt.Errorf("illegal argument rowIndex %d", rowIndex)
	}

	if value == nil {
		// Init the bitMap to mark nil value
		if t.bitMaps == nil {
			t.bitMaps = make([]*BitMap, len(t.values))
		}
		if t.bitMaps[columnIndex] == nil {
			t.bitMaps[columnIndex] = NewBitMap(t.maxRowNumber)
		}
		// Mark the nil value position
		t.bitMaps[columnIndex].Mark(rowIndex)
		return nil
	}

	switch t.measurementSchemas[columnIndex].DataType {
	case BOOLEAN:
		values := t.values[columnIndex].([]bool)
		switch v := value.(type) {
		case bool:
			values[rowIndex] = v
		case *bool:
			values[rowIndex] = *v
		default:
			return fmt.Errorf("illegal argument value %v %v", value, reflect.TypeOf(value))
		}
	case INT32:
		values := t.values[columnIndex].([]int32)
		switch v := value.(type) {
		case int32:
			values[rowIndex] = v
		case *int32:
			values[rowIndex] = *v
		default:
			return fmt.Errorf("illegal argument value %v %v", value, reflect.TypeOf(value))
		}
	case INT64, TIMESTAMP:
		values := t.values[columnIndex].([]int64)
		switch v := value.(type) {
		case int64:
			values[rowIndex] = v
		case *int64:
			values[rowIndex] = *v
		default:
			return fmt.Errorf("illegal argument value %v %v", value, reflect.TypeOf(value))
		}
	case FLOAT:
		values := t.values[columnIndex].([]float32)
		switch v := value.(type) {
		case float32:
			values[rowIndex] = v
		case *float32:
			values[rowIndex] = *v
		default:
			return fmt.Errorf("illegal argument value %v %v", value, reflect.TypeOf(value))
		}
	case DOUBLE:
		values := t.values[columnIndex].([]float64)
		switch v := value.(type) {
		case float64:
			values[rowIndex] = v
		case *float64:
			values[rowIndex] = *v
		default:
			return fmt.Errorf("illegal argument value %v %v", value, reflect.TypeOf(value))
		}
	case TEXT, STRING:
		values := t.values[columnIndex].([][]byte)
		switch v := value.(type) {
		case string:
			values[rowIndex] = []byte(v)
		case []byte:
			values[rowIndex] = v
		default:
			return fmt.Errorf("illegal argument value %v %v", value, reflect.TypeOf(value))
		}
	case BLOB:
		values := t.values[columnIndex].([][]byte)
		switch v := value.(type) {
		case []byte:
			values[rowIndex] = v
		default:
			return fmt.Errorf("illegal argument value %v %v", value, reflect.TypeOf(value))
		}
	case DATE:
		values := t.values[columnIndex].([]int32)
		switch v := value.(type) {
		case time.Time:
			val, err := DateToInt32(v)
			if err != nil {
				return err
			}
			values[rowIndex] = val
		default:
			return fmt.Errorf("illegal argument value %v %v", value, reflect.TypeOf(value))
		}
	}
	return nil
}

func (t *Tablet) GetMaxRowNumber() int {
	return t.maxRowNumber
}

func (t *Tablet) GetValueAt(columnIndex, rowIndex int) (interface{}, error) {
	if columnIndex < 0 || columnIndex >= len(t.measurementSchemas) {
		return nil, fmt.Errorf("illegal argument columnIndex %d", columnIndex)
	}

	if rowIndex < 0 || rowIndex >= t.maxRowNumber {
		return nil, fmt.Errorf("illegal argument rowIndex %d", rowIndex)
	}

	schema := t.measurementSchemas[columnIndex]

	if t.bitMaps != nil && t.bitMaps[columnIndex] != nil && t.bitMaps[columnIndex].IsMarked(rowIndex) {
		return nil, nil
	}
	switch schema.DataType {
	case BOOLEAN:
		return t.values[columnIndex].([]bool)[rowIndex], nil
	case INT32:
		return t.values[columnIndex].([]int32)[rowIndex], nil
	case INT64, TIMESTAMP:
		return t.values[columnIndex].([]int64)[rowIndex], nil
	case FLOAT:
		return t.values[columnIndex].([]float32)[rowIndex], nil
	case DOUBLE:
		return t.values[columnIndex].([]float64)[rowIndex], nil
	case TEXT, STRING:
		return string(t.values[columnIndex].([][]byte)[rowIndex]), nil
	case BLOB:
		return t.values[columnIndex].([][]byte)[rowIndex], nil
	case DATE:
		return Int32ToDate(t.values[columnIndex].([]int32)[rowIndex])
	default:
		return nil, fmt.Errorf("illegal datatype %v", schema.DataType)
	}
}

func (t *Tablet) GetTimestampBytes() []byte {
	buff := &bytes.Buffer{}
	binary.Write(buff, binary.BigEndian, t.timestamps[0:t.RowSize])
	return buff.Bytes()
}

func (t *Tablet) GetMeasurements() []string {
	measurements := make([]string, len(t.measurementSchemas))
	for i, s := range t.measurementSchemas {
		measurements[i] = s.Measurement
	}
	return measurements
}

func (t *Tablet) getDataTypes() []int32 {
	types := make([]int32, len(t.measurementSchemas))
	for i, s := range t.measurementSchemas {
		types[i] = int32(s.DataType)
	}
	return types
}

func (t *Tablet) getColumnCategories() []int8 {
	columnCategories := make([]int8, len(t.columnCategories))
	for i := range t.columnCategories {
		columnCategories[i] = int8(t.columnCategories[i])
	}
	return columnCategories
}

func (t *Tablet) getValuesBytes() ([]byte, error) {
	buff := &bytes.Buffer{}
	for i, schema := range t.measurementSchemas {
		switch schema.DataType {
		case BOOLEAN:
			binary.Write(buff, binary.BigEndian, t.values[i].([]bool)[0:t.RowSize])
		case INT32, DATE:
			binary.Write(buff, binary.BigEndian, t.values[i].([]int32)[0:t.RowSize])
		case INT64, TIMESTAMP:
			binary.Write(buff, binary.BigEndian, t.values[i].([]int64)[0:t.RowSize])
		case FLOAT:
			binary.Write(buff, binary.BigEndian, t.values[i].([]float32)[0:t.RowSize])
		case DOUBLE:
			binary.Write(buff, binary.BigEndian, t.values[i].([]float64)[0:t.RowSize])
		case TEXT, STRING, BLOB:
			for _, s := range t.values[i].([][]byte)[0:t.RowSize] {
				binary.Write(buff, binary.BigEndian, int32(len(s)))
				binary.Write(buff, binary.BigEndian, s)
			}
		default:
			return nil, fmt.Errorf("illegal datatype %v", schema.DataType)
		}
	}
	if t.bitMaps != nil {
		for _, bitMap := range t.bitMaps {
			columnHasNil := bitMap != nil && !bitMap.IsAllUnmarked()
			binary.Write(buff, binary.BigEndian, columnHasNil)
			if columnHasNil {
				// Need to maintain consistency with the calculation method on the IoTDB side.
				binary.Write(buff, binary.BigEndian, bitMap.GetBits()[0:t.RowSize/8+1])
			}
		}
	}
	return buff.Bytes(), nil
}

func (t *Tablet) Sort() error {
	sort.Sort(t)
	return nil
}

func (t *Tablet) Reset() {
	t.RowSize = 0
	t.bitMaps = nil
}

func NewTablet(insertTargetName string, measurementSchemas []*MeasurementSchema, maxRowNumber int) (*Tablet, error) {
	tablet := &Tablet{
		insertTargetName:   insertTargetName,
		measurementSchemas: measurementSchemas,
		maxRowNumber:       maxRowNumber,
	}
	tablet.timestamps = make([]int64, maxRowNumber)
	tablet.values = make([]interface{}, len(measurementSchemas))
	for i, schema := range tablet.measurementSchemas {
		switch schema.DataType {
		case BOOLEAN:
			tablet.values[i] = make([]bool, maxRowNumber)
		case INT32, DATE:
			tablet.values[i] = make([]int32, maxRowNumber)
		case INT64, TIMESTAMP:
			tablet.values[i] = make([]int64, maxRowNumber)
		case FLOAT:
			tablet.values[i] = make([]float32, maxRowNumber)
		case DOUBLE:
			tablet.values[i] = make([]float64, maxRowNumber)
		case TEXT, STRING, BLOB:
			tablet.values[i] = make([][]byte, maxRowNumber)
		default:
			return nil, fmt.Errorf("illegal datatype %v", schema.DataType)
		}
	}
	return tablet, nil
}

func NewRelationalTablet(tableName string, measurementSchemas []*MeasurementSchema, columnCategories []ColumnCategory, maxRowNumber int) (*Tablet, error) {
	tablet, err := NewTablet(tableName, measurementSchemas, maxRowNumber)
	if err != nil {
		return nil, err
	}
	tablet.columnCategories = columnCategories
	return tablet, nil
}
