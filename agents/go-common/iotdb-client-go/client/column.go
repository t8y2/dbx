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

import "fmt"

type ColumnEncoding uint8

const (
	BYTE_ARRAY_COLUMN_ENCODING = ColumnEncoding(iota)
	INT32_ARRAY_COLUMN_ENCODING
	INT64_ARRAY_COLUMN_ENCODING
	BINARY_ARRAY_COLUMN_ENCODING
	RLE_COLUMN_ENCODING
)

var encodingToDecoder = map[ColumnEncoding]ColumnDecoder{
	INT32_ARRAY_COLUMN_ENCODING:  new(Int32ArrayColumnDecoder),
	INT64_ARRAY_COLUMN_ENCODING:  new(Int64ArrayColumnDecoder),
	BYTE_ARRAY_COLUMN_ENCODING:   new(ByteArrayColumnDecoder),
	BINARY_ARRAY_COLUMN_ENCODING: new(BinaryArrayColumnDecoder),
	RLE_COLUMN_ENCODING:          new(RunLengthColumnDecoder),
}

var byteToEncoding = map[byte]ColumnEncoding{
	0: BYTE_ARRAY_COLUMN_ENCODING,
	1: INT32_ARRAY_COLUMN_ENCODING,
	2: INT64_ARRAY_COLUMN_ENCODING,
	3: BINARY_ARRAY_COLUMN_ENCODING,
	4: RLE_COLUMN_ENCODING,
}

func getColumnDecoder(encoding ColumnEncoding) (ColumnDecoder, error) {
	decoder, exists := encodingToDecoder[encoding]
	if !exists {
		return nil, fmt.Errorf("unsupported column encoding: %v", encoding)
	}
	return decoder, nil
}

func getColumnEncodingByByte(b byte) (ColumnEncoding, error) {
	encoding, exists := byteToEncoding[b]
	if !exists {
		return INT32_ARRAY_COLUMN_ENCODING, fmt.Errorf("invalid value: %v", b)
	}
	return encoding, nil
}

type Column interface {
	GetDataType() TSDataType
	GetEncoding() ColumnEncoding
	GetBoolean(position int32) (bool, error)
	GetInt(position int32) (int32, error)
	GetLong(position int32) (int64, error)
	GetFloat(position int32) (float32, error)
	GetDouble(position int32) (float64, error)
	GetBinary(position int32) (*Binary, error)
	GetObject(position int32) (interface{}, error)

	GetBooleans() ([]bool, error)
	GetInts() ([]int32, error)
	GetLongs() ([]int64, error)
	GetFloats() ([]float32, error)
	GetDoubles() ([]float64, error)
	GetBinaries() ([]*Binary, error)
	GetObjects() ([]interface{}, error)

	MayHaveNull() bool
	IsNull(position int32) bool
	IsNulls() []bool

	GetPositionCount() int32
}

type baseColumn struct {
}

func (c *baseColumn) GetBoolean(_ int32) (bool, error) {
	return false, fmt.Errorf("unsupported operation: GetBoolean")
}

func (c *baseColumn) GetInt(_ int32) (int32, error) {
	return 0, fmt.Errorf("unsupported operation: GetInt")
}

func (c *baseColumn) GetLong(_ int32) (int64, error) {
	return 0, fmt.Errorf("unsupported operation: GetLong")
}

func (c *baseColumn) GetFloat(_ int32) (float32, error) {
	return 0, fmt.Errorf("unsupported operation: GetFloat")
}

func (c *baseColumn) GetDouble(_ int32) (float64, error) {
	return 0, fmt.Errorf("unsupported operation: GetDouble")
}

func (c *baseColumn) GetBinary(_ int32) (*Binary, error) {
	return nil, fmt.Errorf("unsupported operation: GetBinary")
}

func (c *baseColumn) GetObject(_ int32) (interface{}, error) {
	return nil, fmt.Errorf("unsupported operation: GetObject")
}

func (c *baseColumn) GetBooleans() ([]bool, error) {
	return nil, fmt.Errorf("unsupported operation: GetBooleans")
}

func (c *baseColumn) GetInts() ([]int32, error) {
	return nil, fmt.Errorf("unsupported operation: GetInts")
}

func (c *baseColumn) GetLongs() ([]int64, error) {
	return nil, fmt.Errorf("unsupported operation: GetLongs")
}

func (c *baseColumn) GetFloats() ([]float32, error) {
	return nil, fmt.Errorf("unsupported operation: GetFloats")
}

func (c *baseColumn) GetDoubles() ([]float64, error) {
	return nil, fmt.Errorf("unsupported operation: GetDoubles")
}

func (c *baseColumn) GetBinaries() ([]*Binary, error) {
	return nil, fmt.Errorf("unsupported operation: GetBinaries")
}

func (c *baseColumn) GetObjects() ([]interface{}, error) {
	return nil, fmt.Errorf("unsupported operation: GetObjects")
}

type TimeColumn struct {
	baseColumn
	arrayOffset   int32
	positionCount int32
	values        []int64
}

func NewTimeColumn(arrayOffset int32, positionCount int32, values []int64) (*TimeColumn, error) {
	if arrayOffset < 0 {
		return nil, fmt.Errorf("arrayOffset is negative")
	}
	if positionCount < 0 {
		return nil, fmt.Errorf("arrayOffset is negative")
	}
	if int32(len(values))-arrayOffset < positionCount {
		return nil, fmt.Errorf("values length is less than positionCount")
	}
	return &TimeColumn{
		arrayOffset:   arrayOffset,
		positionCount: positionCount,
		values:        values,
	}, nil
}

func (tc *TimeColumn) GetDataType() TSDataType {
	return INT64
}

func (tc *TimeColumn) GetEncoding() ColumnEncoding {
	return INT64_ARRAY_COLUMN_ENCODING
}

func (tc *TimeColumn) GetLong(position int32) (int64, error) {
	return tc.values[position+tc.arrayOffset], nil
}

func (tc *TimeColumn) MayHaveNull() bool {
	return false
}

func (tc *TimeColumn) IsNull(_ int32) bool {
	return false
}

func (tc *TimeColumn) IsNulls() []bool {
	return nil
}

func (tc *TimeColumn) GetPositionCount() int32 {
	return tc.positionCount
}

func (tc *TimeColumn) GetStartTime() int64 {
	return tc.values[tc.arrayOffset]
}

func (tc *TimeColumn) GetEndTime() int64 {
	return tc.values[tc.positionCount+tc.arrayOffset-1]
}

func (tc *TimeColumn) GetTimes() []int64 {
	return tc.values
}

func (tc *TimeColumn) GetLongs() ([]int64, error) {
	return tc.GetTimes(), nil
}

type BinaryColumn struct {
	baseColumn
	arrayOffset   int32
	positionCount int32
	valueIsNull   []bool
	values        []*Binary
}

func NewBinaryColumn(arrayOffset int32, positionCount int32, valueIsNull []bool, values []*Binary) (*BinaryColumn, error) {
	if arrayOffset < 0 {
		return nil, fmt.Errorf("arrayOffset is negative")
	}
	if positionCount < 0 {
		return nil, fmt.Errorf("positionCount is negative")
	}
	if int32(len(values))-arrayOffset < positionCount {
		return nil, fmt.Errorf("values length is less than positionCount")
	}
	if valueIsNull != nil && int32(len(valueIsNull))-arrayOffset < positionCount {
		return nil, fmt.Errorf("isNull length is less than positionCount")
	}
	return &BinaryColumn{
		arrayOffset:   arrayOffset,
		positionCount: positionCount,
		valueIsNull:   valueIsNull,
		values:        values,
	}, nil
}

func (c *BinaryColumn) GetDataType() TSDataType {
	return TEXT
}

func (c *BinaryColumn) GetEncoding() ColumnEncoding {
	return BINARY_ARRAY_COLUMN_ENCODING
}

func (c *BinaryColumn) GetBinary(position int32) (*Binary, error) {
	return c.values[position+c.arrayOffset], nil
}

func (c *BinaryColumn) GetBinaries() ([]*Binary, error) {
	return c.values, nil
}

func (c *BinaryColumn) GetObject(position int32) (interface{}, error) {
	return c.GetBinary(position)
}

func (c *BinaryColumn) MayHaveNull() bool {
	return c.valueIsNull != nil
}

func (c *BinaryColumn) IsNull(position int32) bool {
	return c.valueIsNull != nil && c.valueIsNull[position+c.arrayOffset]
}

func (c *BinaryColumn) IsNulls() []bool {
	if c.valueIsNull != nil {
		return c.valueIsNull
	}
	result := make([]bool, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = false
	}
	return result
}

func (c *BinaryColumn) GetPositionCount() int32 {
	return c.positionCount
}

type IntColumn struct {
	baseColumn
	arrayOffset   int32
	positionCount int32
	valueIsNull   []bool
	values        []int32
}

func NewIntColumn(arrayOffset int32, positionCount int32, valueIsNull []bool, values []int32) (*IntColumn, error) {
	if arrayOffset < 0 {
		return nil, fmt.Errorf("arrayOffset is negative")
	}
	if positionCount < 0 {
		return nil, fmt.Errorf("positionCount is negative")
	}
	if int32(len(values))-arrayOffset < positionCount {
		return nil, fmt.Errorf("values length is less than positionCount")
	}
	if valueIsNull != nil && int32(len(valueIsNull))-arrayOffset < positionCount {
		return nil, fmt.Errorf("isNull length is less than positionCount")
	}
	return &IntColumn{
		arrayOffset:   arrayOffset,
		positionCount: positionCount,
		valueIsNull:   valueIsNull,
		values:        values,
	}, nil
}

func (c *IntColumn) GetDataType() TSDataType {
	return INT32
}

func (c *IntColumn) GetEncoding() ColumnEncoding {
	return INT32_ARRAY_COLUMN_ENCODING
}

func (c *IntColumn) GetInt(position int32) (int32, error) {
	return c.values[position+c.arrayOffset], nil
}

func (c *IntColumn) GetInts() ([]int32, error) {
	return c.values, nil
}

func (c *IntColumn) GetObject(position int32) (interface{}, error) {
	return c.GetInt(position)
}

func (c *IntColumn) MayHaveNull() bool {
	return c.valueIsNull != nil
}

func (c *IntColumn) IsNull(position int32) bool {
	return c.valueIsNull != nil && c.valueIsNull[position+c.arrayOffset]
}

func (c *IntColumn) IsNulls() []bool {
	if c.valueIsNull != nil {
		return c.valueIsNull
	}
	result := make([]bool, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = false
	}
	return result
}

func (c *IntColumn) GetPositionCount() int32 {
	return c.positionCount
}

type FloatColumn struct {
	baseColumn
	arrayOffset   int32
	positionCount int32
	valueIsNull   []bool
	values        []float32
}

func NewFloatColumn(arrayOffset int32, positionCount int32, valueIsNull []bool, values []float32) (*FloatColumn, error) {
	if arrayOffset < 0 {
		return nil, fmt.Errorf("arrayOffset is negative")
	}
	if positionCount < 0 {
		return nil, fmt.Errorf("positionCount is negative")
	}
	if int32(len(values))-arrayOffset < positionCount {
		return nil, fmt.Errorf("values length is less than positionCount")
	}
	if valueIsNull != nil && int32(len(valueIsNull))-arrayOffset < positionCount {
		return nil, fmt.Errorf("isNull length is less than positionCount")
	}
	return &FloatColumn{
		arrayOffset:   arrayOffset,
		positionCount: positionCount,
		valueIsNull:   valueIsNull,
		values:        values,
	}, nil
}

func (c *FloatColumn) GetDataType() TSDataType {
	return FLOAT
}

func (c *FloatColumn) GetEncoding() ColumnEncoding {
	return INT32_ARRAY_COLUMN_ENCODING
}

func (c *FloatColumn) GetFloat(position int32) (float32, error) {
	return c.values[position+c.arrayOffset], nil
}

func (c *FloatColumn) GetFloats() ([]float32, error) {
	return c.values, nil
}

func (c *FloatColumn) GetObject(position int32) (interface{}, error) {
	return c.GetFloat(position)
}

func (c *FloatColumn) MayHaveNull() bool {
	return c.valueIsNull != nil
}

func (c *FloatColumn) IsNull(position int32) bool {
	return c.valueIsNull != nil && c.valueIsNull[position+c.arrayOffset]
}

func (c *FloatColumn) IsNulls() []bool {
	if c.valueIsNull != nil {
		return c.valueIsNull
	}
	result := make([]bool, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = false
	}
	return result
}

func (c *FloatColumn) GetPositionCount() int32 {
	return c.positionCount
}

type LongColumn struct {
	baseColumn
	arrayOffset   int32
	positionCount int32
	valueIsNull   []bool
	values        []int64
}

func NewLongColumn(arrayOffset int32, positionCount int32, valueIsNull []bool, values []int64) (*LongColumn, error) {
	if arrayOffset < 0 {
		return nil, fmt.Errorf("arrayOffset is negative")
	}
	if positionCount < 0 {
		return nil, fmt.Errorf("positionCount is negative")
	}
	if int32(len(values))-arrayOffset < positionCount {
		return nil, fmt.Errorf("values length is less than positionCount")
	}
	if valueIsNull != nil && int32(len(valueIsNull))-arrayOffset < positionCount {
		return nil, fmt.Errorf("isNull length is less than positionCount")
	}
	return &LongColumn{
		arrayOffset:   arrayOffset,
		positionCount: positionCount,
		valueIsNull:   valueIsNull,
		values:        values,
	}, nil
}

func (c *LongColumn) GetDataType() TSDataType {
	return INT64
}

func (c *LongColumn) GetEncoding() ColumnEncoding {
	return INT64_ARRAY_COLUMN_ENCODING
}

func (c *LongColumn) GetLong(position int32) (int64, error) {
	return c.values[position+c.arrayOffset], nil
}

func (c *LongColumn) GetLongs() ([]int64, error) {
	return c.values, nil
}

func (c *LongColumn) GetObject(position int32) (interface{}, error) {
	return c.GetLong(position)
}

func (c *LongColumn) MayHaveNull() bool {
	return c.valueIsNull != nil
}

func (c *LongColumn) IsNull(position int32) bool {
	return c.valueIsNull != nil && c.valueIsNull[position+c.arrayOffset]
}

func (c *LongColumn) IsNulls() []bool {
	if c.valueIsNull != nil {
		return c.valueIsNull
	}
	result := make([]bool, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = false
	}
	return result
}

func (c *LongColumn) GetPositionCount() int32 {
	return c.positionCount
}

type DoubleColumn struct {
	baseColumn
	arrayOffset   int32
	positionCount int32
	valueIsNull   []bool
	values        []float64
}

func NewDoubleColumn(arrayOffset int32, positionCount int32, valueIsNull []bool, values []float64) (*DoubleColumn, error) {
	if arrayOffset < 0 {
		return nil, fmt.Errorf("arrayOffset is negative")
	}
	if positionCount < 0 {
		return nil, fmt.Errorf("positionCount is negative")
	}
	if int32(len(values))-arrayOffset < positionCount {
		return nil, fmt.Errorf("values length is less than positionCount")
	}
	if valueIsNull != nil && int32(len(valueIsNull))-arrayOffset < positionCount {
		return nil, fmt.Errorf("isNull length is less than positionCount")
	}
	return &DoubleColumn{
		arrayOffset:   arrayOffset,
		positionCount: positionCount,
		valueIsNull:   valueIsNull,
		values:        values,
	}, nil
}

func (c *DoubleColumn) GetDataType() TSDataType {
	return DOUBLE
}

func (c *DoubleColumn) GetEncoding() ColumnEncoding {
	return INT64_ARRAY_COLUMN_ENCODING
}

func (c *DoubleColumn) GetDouble(position int32) (float64, error) {
	return c.values[position+c.arrayOffset], nil
}

func (c *DoubleColumn) GetDoubles() ([]float64, error) {
	return c.values, nil
}

func (c *DoubleColumn) GetObject(position int32) (interface{}, error) {
	return c.GetDouble(position)
}

func (c *DoubleColumn) MayHaveNull() bool {
	return c.valueIsNull != nil
}

func (c *DoubleColumn) IsNull(position int32) bool {
	return c.valueIsNull != nil && c.valueIsNull[position+c.arrayOffset]
}

func (c *DoubleColumn) IsNulls() []bool {
	if c.valueIsNull != nil {
		return c.valueIsNull
	}
	result := make([]bool, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = false
	}
	return result
}

func (c *DoubleColumn) GetPositionCount() int32 {
	return c.positionCount
}

type BooleanColumn struct {
	baseColumn
	arrayOffset   int32
	positionCount int32
	valueIsNull   []bool
	values        []bool
}

func NewBooleanColumn(arrayOffset int32, positionCount int32, valueIsNull []bool, values []bool) (*BooleanColumn, error) {
	if arrayOffset < 0 {
		return nil, fmt.Errorf("arrayOffset is negative")
	}
	if positionCount < 0 {
		return nil, fmt.Errorf("positionCount is negative")
	}
	if int32(len(values))-arrayOffset < positionCount {
		return nil, fmt.Errorf("values length is less than positionCount")
	}
	if valueIsNull != nil && int32(len(valueIsNull))-arrayOffset < positionCount {
		return nil, fmt.Errorf("isNull length is less than positionCount")
	}
	return &BooleanColumn{
		arrayOffset:   arrayOffset,
		positionCount: positionCount,
		valueIsNull:   valueIsNull,
		values:        values,
	}, nil
}

func (c *BooleanColumn) GetDataType() TSDataType {
	return BOOLEAN
}

func (c *BooleanColumn) GetEncoding() ColumnEncoding {
	return BYTE_ARRAY_COLUMN_ENCODING
}

func (c *BooleanColumn) GetBoolean(position int32) (bool, error) {
	return c.values[position+c.arrayOffset], nil
}

func (c *BooleanColumn) GetBooleans() ([]bool, error) {
	return c.values, nil
}

func (c *BooleanColumn) GetObject(position int32) (interface{}, error) {
	return c.GetBoolean(position)
}

func (c *BooleanColumn) MayHaveNull() bool {
	return c.valueIsNull != nil
}

func (c *BooleanColumn) IsNull(position int32) bool {
	return c.valueIsNull != nil && c.valueIsNull[position+c.arrayOffset]
}

func (c *BooleanColumn) IsNulls() []bool {
	if c.valueIsNull != nil {
		return c.valueIsNull
	}
	result := make([]bool, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = false
	}
	return result
}

func (c *BooleanColumn) GetPositionCount() int32 {
	return c.positionCount
}

type RunLengthEncodedColumn struct {
	baseColumn
	value         Column
	positionCount int32
}

func NewRunLengthEncodedColumn(value Column, positionCount int32) (*RunLengthEncodedColumn, error) {
	if value == nil {
		return nil, fmt.Errorf("value is null")
	}
	if value.GetPositionCount() != 1 {
		return nil, fmt.Errorf("expected value to contain a single position but has %v positions", value.GetPositionCount())
	}
	if positionCount < 0 {
		return nil, fmt.Errorf("positionCount is negative")
	}
	column := new(RunLengthEncodedColumn)
	switch (value).(type) {
	case *RunLengthEncodedColumn:
		column.value = (value.(*RunLengthEncodedColumn)).GetValue()
	default:
		column.value = value
	}
	column.positionCount = positionCount
	return column, nil
}

func (c *RunLengthEncodedColumn) GetValue() Column {
	return c.value
}

func (c *RunLengthEncodedColumn) GetDataType() TSDataType {
	return c.value.GetDataType()
}

func (c *RunLengthEncodedColumn) GetEncoding() ColumnEncoding {
	return RLE_COLUMN_ENCODING
}

func (c *RunLengthEncodedColumn) GetBoolean(_ int32) (bool, error) {
	return c.value.GetBoolean(0)
}

func (c *RunLengthEncodedColumn) GetInt(_ int32) (int32, error) {
	return c.value.GetInt(0)
}

func (c *RunLengthEncodedColumn) GetLong(_ int32) (int64, error) {
	return c.value.GetLong(0)
}

func (c *RunLengthEncodedColumn) GetFloat(_ int32) (float32, error) {
	return c.value.GetFloat(0)
}

func (c *RunLengthEncodedColumn) GetDouble(_ int32) (float64, error) {
	return c.value.GetDouble(0)
}

func (c *RunLengthEncodedColumn) GetBinary(_ int32) (*Binary, error) {
	return c.value.GetBinary(0)
}

func (c *RunLengthEncodedColumn) GetObject(_ int32) (interface{}, error) {
	return c.value.GetObject(0)
}

func (c *RunLengthEncodedColumn) GetBooleans() ([]bool, error) {
	v, err := c.value.GetBoolean(0)
	if err != nil {
		return nil, err
	}
	result := make([]bool, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = v
	}
	return result, err
}

func (c *RunLengthEncodedColumn) GetInts() ([]int32, error) {
	v, err := c.value.GetInt(0)
	if err != nil {
		return nil, err
	}
	result := make([]int32, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = v
	}
	return result, err
}

func (c *RunLengthEncodedColumn) GetLongs() ([]int64, error) {
	v, err := c.value.GetLong(0)
	if err != nil {
		return nil, err
	}
	result := make([]int64, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = v
	}
	return result, err
}

func (c *RunLengthEncodedColumn) GetFloats() ([]float32, error) {
	v, err := c.value.GetFloat(0)
	if err != nil {
		return nil, err
	}
	result := make([]float32, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = v
	}
	return result, err
}

func (c *RunLengthEncodedColumn) GetDoubles() ([]float64, error) {
	v, err := c.value.GetDouble(0)
	if err != nil {
		return nil, err
	}
	result := make([]float64, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = v
	}
	return result, err
}

func (c *RunLengthEncodedColumn) GetBinaries() ([]*Binary, error) {
	v, err := c.value.GetBinary(0)
	if err != nil {
		return nil, err
	}
	result := make([]*Binary, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = v
	}
	return result, err
}

func (c *RunLengthEncodedColumn) GetObjects() ([]interface{}, error) {
	v, err := c.value.GetObject(0)
	if err != nil {
		return nil, err
	}
	result := make([]interface{}, c.positionCount)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = v
	}
	return result, err
}

func (c *RunLengthEncodedColumn) MayHaveNull() bool {
	return c.value.MayHaveNull()
}

func (c *RunLengthEncodedColumn) IsNull(_ int32) bool {
	return c.value.IsNull(0)
}

func (c *RunLengthEncodedColumn) IsNulls() []bool {
	result := make([]bool, c.positionCount)
	v := c.value.IsNull(0)
	for i := int32(0); i < c.positionCount; i++ {
		result[i] = v
	}
	return result
}

func (c *RunLengthEncodedColumn) GetPositionCount() int32 {
	return c.positionCount
}
