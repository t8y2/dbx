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

import "time"

type Field struct {
	dataType TSDataType
	name     string
	value    interface{}
}

func (f *Field) IsNull() bool {
	return f.value == nil
}

func (f *Field) GetDataType() TSDataType {
	return f.dataType
}

func (f *Field) GetValue() interface{} {
	return f.value
}

func (f *Field) GetInt32() int32 {
	if f.value == nil {
		return 0
	}
	return f.value.(int32)
}

func (f *Field) GetInt64() int64 {
	if f.value == nil {
		return 0
	}
	return f.value.(int64)
}

func (f *Field) GetFloat32() float32 {
	if f.value == nil {
		return 0
	}
	return f.value.(float32)
}

func (f *Field) GetFloat64() float64 {
	if f.value == nil {
		return 0
	}
	return f.value.(float64)
}

func (f *Field) GetName() string {
	return f.name
}

func (f *Field) GetText() string {
	if f.value == nil {
		return ""
	}
	switch f.value.(type) {
	case bool:
		if f.value.(bool) {
			return "true"
		}
		return "false"
	case int32:
		return int32ToString(f.value.(int32))
	case int64:
		return int64ToString(f.value.(int64))
	case float32:
		return float32ToString(f.value.(float32))
	case float64:
		return float64ToString(f.value.(float64))
	case string:
		return f.value.(string)
	case []byte:
		return bytesToHexString(f.value.([]byte))
	case time.Time:
		return f.value.(time.Time).Format("2006-01-02")
	}
	return ""
}
