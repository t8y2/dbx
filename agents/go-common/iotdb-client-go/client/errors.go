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
	"fmt"

	"github.com/apache/iotdb-client-go/v2/common"
)

// ExecutionError represents an error returned by the server via TSStatus.
// It is NOT a connection error and should not cause session drops.
type ExecutionError struct {
	Code    int32
	Message string
}

func (e *ExecutionError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("error code: %d, message: %v", e.Code, e.Message)
	}
	return fmt.Sprintf("error code: %d", e.Code)
}

type BatchError struct {
	statuses []*common.TSStatus
	Message  string
}

func (e *BatchError) Error() string {
	return e.Message
}

func (e *BatchError) GetStatuses() []*common.TSStatus {
	return e.statuses
}
