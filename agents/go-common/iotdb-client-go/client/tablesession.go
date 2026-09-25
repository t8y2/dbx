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

// ITableSession defines an interface for interacting with IoTDB tables.
// It supports operations such as data insertion, executing queries, and closing the session.
// Implementations of this interface are expected to manage connections and ensure
// proper resource cleanup.
//
// Each method may return an error to indicate issues such as connection errors
// or execution failures.
//
// Since this interface includes a Close method, it is recommended to use
// defer to ensure the session is properly closed.
type ITableSession interface {

	// Insert inserts a Tablet into the database.
	//
	// Parameters:
	//   - tablet: A pointer to a Tablet containing time-series data to be inserted.
	//
	// Returns:
	//   - err: An error if an issue occurs during the operation, such as a connection error or execution failure.
	Insert(tablet *Tablet) error

	// ExecuteNonQueryStatement executes a non-query SQL statement, such as a DDL or DML command.
	//
	// Parameters:
	//   - sql: The SQL statement to execute.
	//
	// Returns:
	//   - err: An error if an issue occurs during the operation, such as a connection error or execution failure.
	ExecuteNonQueryStatement(sql string) error

	// ExecuteQueryStatement executes a query SQL statement and returns the result set.
	//
	// Parameters:
	//   - sql: The SQL query statement to execute.
	//   - timeoutInMs: A pointer to the timeout duration in milliseconds for the query execution.
	//
	// Returns:
	//   - result: A pointer to SessionDataSet containing the query results.
	//   - err: An error if an issue occurs during the operation, such as a connection error or execution failure.
	ExecuteQueryStatement(sql string, timeoutInMs *int64) (*SessionDataSet, error)

	// Close closes the session, releasing any held resources.
	//
	// Returns:
	//   - err: An error if there is an issue with closing the IoTDB connection.
	Close() (err error)
}

// TableSession represents a session for interacting with IoTDB in relational mode.
// It wraps a Session instance, providing methods for executing SQL statements
// and managing the lifecycle of the session.
type TableSession struct {
	session Session
}

// NewTableSession creates a new TableSession instance using the provided configuration.
//
// Parameters:
//   - config: The configuration for the session.
//   - enableRPCCompression: A boolean indicating whether RPC compression is enabled.
//   - connectionTimeoutInMs: The timeout in milliseconds for establishing a connection.
//
// Returns:
//   - An ITableSession instance if the session is successfully created.
//   - An error if there is an issue during session initialization.
func NewTableSession(config *Config, enableRPCCompression bool, connectionTimeoutInMs int) (ITableSession, error) {
	config.sqlDialect = TableSqlDialect
	session := newSessionWithSpecifiedSqlDialect(config)

	if err := session.Open(enableRPCCompression, connectionTimeoutInMs); err != nil {
		return nil, err
	}
	return &TableSession{session: session}, nil
}

// NewClusterTableSession creates a new TableSession instance for a cluster setup.
//
// Parameters:
//   - clusterConfig: The configuration for the cluster session.
//   - enableRPCCompression: A boolean indicating whether RPC compression is enabled.
//
// Returns:
//   - An ITableSession instance if the session is successfully created.
//   - An error if there is an issue during session initialization.
func NewClusterTableSession(clusterConfig *ClusterConfig, enableRPCCompression bool) (ITableSession, error) {
	clusterConfig.sqlDialect = TableSqlDialect
	session, err := newClusterSessionWithSqlDialect(clusterConfig)
	if err != nil {
		return nil, err
	}
	if err = session.OpenCluster(enableRPCCompression); err != nil {
		return nil, err
	}
	return &TableSession{session: session}, nil
}

// Insert inserts a Tablet into the IoTDB.
//
// Parameters:
//   - tablet: A pointer to a Tablet containing the data to be inserted.
//
// Returns:
//   - err: An error if the operation fails.
func (s *TableSession) Insert(tablet *Tablet) error {
	return s.session.insertRelationalTablet(tablet)
}

// ExecuteNonQueryStatement executes a non-query SQL statement, such as a DDL or DML command.
//
// Parameters:
//   - sql: The SQL statement to be executed.
//
// Returns:
//   - err: An error if the operation fails.
func (s *TableSession) ExecuteNonQueryStatement(sql string) error {
	return s.session.ExecuteNonQueryStatement(sql)
}

// ExecuteQueryStatement executes a query SQL statement and retrieves the result set.
//
// Parameters:
//   - sql: The SQL query to be executed.
//   - timeoutInMs: (Optional) A pointer to the timeout duration in milliseconds for the query.
//
// Returns:
//   - result: A pointer to SessionDataSet containing the query results.
//   - err: An error if the operation fails.
func (s *TableSession) ExecuteQueryStatement(sql string, timeoutInMs *int64) (*SessionDataSet, error) {
	return s.session.ExecuteQueryStatement(sql, timeoutInMs)
}

// Close closes the TableSession, releasing any associated resources.
//
// Returns:
//   - err: An error if the session fails to close properly.
func (s *TableSession) Close() error {
	return s.session.Close()
}
