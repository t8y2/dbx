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

type ColumnDecoder interface {
	ReadColumn(reader *bytes.Reader, dataType TSDataType, positionCount int32) (Column, error)
}

func deserializeNullIndicators(reader *bytes.Reader, positionCount int32) ([]bool, error) {
	b, err := reader.ReadByte()
	if err != nil {
		return nil, err
	}
	mayHaveNull := b != 0
	if !mayHaveNull {
		return nil, nil
	}
	return deserializeBooleanArray(reader, positionCount)
}

func deserializeBooleanArray(reader *bytes.Reader, size int32) ([]bool, error) {
	packedSize := (size + 7) / 8
	packedBytes := make([]byte, packedSize)

	_, err := reader.Read(packedBytes)
	if err != nil {
		return nil, err
	}

	// read null bits 8 at a time
	output := make([]bool, size)
	currentByte := 0
	fullGroups := int(size) & ^0b111
	for pos := 0; pos < fullGroups; pos += 8 {
		b := packedBytes[currentByte]
		currentByte++

		output[pos+0] = (b & 0b10000000) != 0
		output[pos+1] = (b & 0b01000000) != 0
		output[pos+2] = (b & 0b00100000) != 0
		output[pos+3] = (b & 0b00010000) != 0
		output[pos+4] = (b & 0b00001000) != 0
		output[pos+5] = (b & 0b00000100) != 0
		output[pos+6] = (b & 0b00000010) != 0
		output[pos+7] = (b & 0b00000001) != 0
	}

	// read last null bits
	if remaining := int(size) % 8; remaining > 0 {
		b := packedBytes[len(packedBytes)-1]
		mask := uint8(0b10000000)

		for pos := fullGroups; pos < int(size); pos++ {
			output[pos] = (b & mask) != 0
			mask >>= 1
		}
	}

	return output, nil
}

type baseColumnDecoder struct{}

type Int32ArrayColumnDecoder struct {
	baseColumnDecoder
}

func (decoder *Int32ArrayColumnDecoder) ReadColumn(reader *bytes.Reader, dataType TSDataType, positionCount int32) (Column, error) {
	// Serialized data layout:
	//    +---------------+-----------------+-------------+
	//    | may have null | null indicators |   values    |
	//    +---------------+-----------------+-------------+
	//    | byte          | list[byte]      | list[int32] |
	//    +---------------+-----------------+-------------+

	if positionCount == 0 {
		switch dataType {
		case INT32, DATE:
			return NewIntColumn(0, 0, nil, []int32{})
		case FLOAT:
			return NewFloatColumn(0, 0, nil, []float32{})
		default:
			return nil, fmt.Errorf("invalid data type: %v", dataType)
		}
	}

	nullIndicators, err := deserializeNullIndicators(reader, positionCount)
	if err != nil {
		return nil, err
	}
	switch dataType {
	case INT32, DATE:
		intValues := make([]int32, positionCount)
		for i := int32(0); i < positionCount; i++ {
			if nullIndicators != nil && nullIndicators[i] {
				continue
			}
			err := binary.Read(reader, binary.BigEndian, &intValues[i])
			if err != nil {
				return nil, err
			}
		}
		return NewIntColumn(0, positionCount, nullIndicators, intValues)
	case FLOAT:
		floatValues := make([]float32, positionCount)
		for i := int32(0); i < positionCount; i++ {
			if nullIndicators != nil && nullIndicators[i] {
				continue
			}
			err := binary.Read(reader, binary.BigEndian, &floatValues[i])
			if err != nil {
				return nil, err
			}
		}
		return NewFloatColumn(0, positionCount, nullIndicators, floatValues)
	}
	return nil, fmt.Errorf("invalid data type: %v", dataType)
}

type Int64ArrayColumnDecoder struct {
	baseColumnDecoder
}

func (decoder *Int64ArrayColumnDecoder) ReadColumn(reader *bytes.Reader, dataType TSDataType, positionCount int32) (Column, error) {
	// Serialized data layout:
	//    +---------------+-----------------+-------------+
	//    | may have null | null indicators |   values    |
	//    +---------------+-----------------+-------------+
	//    | byte          | list[byte]      | list[int64] |
	//    +---------------+-----------------+-------------+

	if positionCount == 0 {
		switch dataType {
		case INT64, TIMESTAMP:
			return NewLongColumn(0, 0, nil, []int64{})
		case DOUBLE:
			return NewDoubleColumn(0, 0, nil, []float64{})
		default:
			return nil, fmt.Errorf("invalid data type: %v", dataType)
		}
	}

	nullIndicators, err := deserializeNullIndicators(reader, positionCount)
	if err != nil {
		return nil, err
	}
	switch dataType {
	case INT64, TIMESTAMP:
		values := make([]int64, positionCount)
		for i := int32(0); i < positionCount; i++ {
			if nullIndicators != nil && nullIndicators[i] {
				continue
			}
			if err = binary.Read(reader, binary.BigEndian, &values[i]); err != nil {
				return nil, err
			}
		}
		return NewLongColumn(0, positionCount, nullIndicators, values)
	case DOUBLE:
		values := make([]float64, positionCount)
		for i := int32(0); i < positionCount; i++ {
			if nullIndicators != nil && nullIndicators[i] {
				continue
			}
			if err = binary.Read(reader, binary.BigEndian, &values[i]); err != nil {
				return nil, err
			}
		}
		return NewDoubleColumn(0, positionCount, nullIndicators, values)
	}
	return nil, fmt.Errorf("invalid data type: %v", dataType)
}

type ByteArrayColumnDecoder struct {
	baseColumnDecoder
}

func (decoder *ByteArrayColumnDecoder) ReadColumn(reader *bytes.Reader, dataType TSDataType, positionCount int32) (Column, error) {
	// Serialized data layout:
	//    +---------------+-----------------+-------------+
	//    | may have null | null indicators |   values    |
	//    +---------------+-----------------+-------------+
	//    | byte          | list[byte]      | list[byte]  |
	//    +---------------+-----------------+-------------+

	if dataType != BOOLEAN {
		return nil, fmt.Errorf("invalid data type: %v", dataType)
	}

	if positionCount == 0 {
		return NewBooleanColumn(0, 0, nil, []bool{})
	}

	nullIndicators, err := deserializeNullIndicators(reader, positionCount)
	if err != nil {
		return nil, err
	}
	values, err := deserializeBooleanArray(reader, positionCount)
	if err != nil {
		return nil, err
	}
	return NewBooleanColumn(0, positionCount, nullIndicators, values)
}

type BinaryArrayColumnDecoder struct {
	baseColumnDecoder
}

func (decoder *BinaryArrayColumnDecoder) ReadColumn(reader *bytes.Reader, dataType TSDataType, positionCount int32) (Column, error) {
	// Serialized data layout:
	//    +---------------+-----------------+-------------+
	//    | may have null | null indicators |   values    |
	//    +---------------+-----------------+-------------+
	//    | byte          | list[byte]      | list[entry] |
	//    +---------------+-----------------+-------------+
	//
	// Each entry is represented as:
	//    +---------------+-------+
	//    | value length  | value |
	//    +---------------+-------+
	//    | int32         | bytes |
	//    +---------------+-------+

	if TEXT != dataType {
		return nil, fmt.Errorf("invalid data type: %v", dataType)
	}

	if positionCount == 0 {
		return NewBinaryColumn(0, 0, nil, []*Binary{})
	}

	nullIndicators, err := deserializeNullIndicators(reader, positionCount)
	if err != nil {
		return nil, err
	}
	values := make([]*Binary, positionCount)
	for i := int32(0); i < positionCount; i++ {
		if nullIndicators != nil && nullIndicators[i] {
			continue
		}
		var length int32
		err := binary.Read(reader, binary.BigEndian, &length)
		if err != nil {
			return nil, err
		}

		if length == 0 {
			values[i] = NewBinary([]byte{})
		} else {
			value := make([]byte, length)
			_, err = reader.Read(value)
			if err != nil {
				return nil, err
			}
			values[i] = NewBinary(value)
		}
	}
	return NewBinaryColumn(0, positionCount, nullIndicators, values)
}

type RunLengthColumnDecoder struct {
	baseColumnDecoder
}

func (decoder *RunLengthColumnDecoder) ReadColumn(reader *bytes.Reader, dataType TSDataType, positionCount int32) (Column, error) {
	// Serialized data layout:
	//    +-----------+-------------------------+
	//    | encoding  | serialized inner column |
	//    +-----------+-------------------------+
	//    | byte      | list[byte]              |
	//    +-----------+-------------------------+
	columnEncoding, err := deserializeColumnEncoding(reader)
	if err != nil {
		return nil, err
	}
	columnDecoder, err := getColumnDecoder(columnEncoding)
	if err != nil {
		return nil, err
	}
	column, err := columnDecoder.ReadColumn(reader, dataType, 1)
	if err != nil {
		return nil, err
	}
	return NewRunLengthEncodedColumn(column, positionCount)
}
