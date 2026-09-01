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
	"errors"
	"log"
	"runtime"
	"time"
)

var errTimeout = errors.New("get session timeout")
var errPoolClosed = errors.New("sessionPool has closed")
var defaultMultiple = 5

type SessionPool struct {
	config                      *PoolConfig
	maxSize                     int
	waitToGetSessionTimeoutInMs int
	enableCompression           bool
	connectionTimeoutInMs       int
	ch                          chan Session
	sem                         chan int8
}

type PoolConfig struct {
	Host            string
	Port            string
	NodeUrls        []string
	UserName        string
	Password        string
	FetchSize       int32
	TimeZone        string
	ConnectRetryMax int
	Database        string
	TLSConfig       *TLSConfig
	sqlDialect      string
}

func NewSessionPool(conf *PoolConfig, maxSize, connectionTimeoutInMs, waitToGetSessionTimeoutInMs int,
	enableCompression bool) SessionPool {
	return newSessionPoolWithSqlDialect(conf, maxSize, connectionTimeoutInMs, waitToGetSessionTimeoutInMs, enableCompression, TreeSqlDialect)
}

func newSessionPoolWithSqlDialect(conf *PoolConfig, maxSize, connectionTimeoutInMs, waitToGetSessionTimeoutInMs int,
	enableCompression bool, sqlDialect string) SessionPool {
	conf.sqlDialect = sqlDialect
	if maxSize <= 0 {
		maxSize = runtime.NumCPU() * defaultMultiple
	}
	var ch = make(chan Session, maxSize)
	var sem = make(chan int8, maxSize)
	return SessionPool{
		config:                      conf,
		maxSize:                     maxSize,
		waitToGetSessionTimeoutInMs: waitToGetSessionTimeoutInMs,
		connectionTimeoutInMs:       connectionTimeoutInMs,
		enableCompression:           enableCompression,
		ch:                          ch,
		sem:                         sem,
	}
}

func (spool *SessionPool) GetSession() (session Session, err error) {
	for {
		select {
		case spool.sem <- 1:
			select {
			case session, ok := <-spool.ch:
				if ok {
					return session, nil
				} else {
					log.Println("sessionPool has closed")
					return session, errPoolClosed
				}
			default:
				config := spool.config
				session, err = spool.ConstructSession(config)
				if err != nil {
					<-spool.sem
				}
				return session, err
			}
		case <-time.After(time.Millisecond * time.Duration(spool.waitToGetSessionTimeoutInMs)):
			log.Println("get session timeout")
			return session, errTimeout
		}
	}
}

func (spool *SessionPool) getTableSession() (ITableSession, error) {
	tableSession := PooledTableSession{}
	session, err := spool.GetSession()
	if err != nil {
		return nil, err
	}
	tableSession.session = session
	tableSession.sessionPool = spool
	return &tableSession, nil
}

func (spool *SessionPool) ConstructSession(config *PoolConfig) (session Session, err error) {
	if len(config.NodeUrls) > 0 {
		session, err = newClusterSessionWithSqlDialect(getClusterSessionConfig(config))
		if err != nil {
			return session, err
		}
		if err = session.OpenCluster(spool.enableCompression); err != nil {
			log.Print(err)
			return session, err
		}
	} else {
		session = newSessionWithSpecifiedSqlDialect(getSessionConfig(config))
		if err := session.Open(spool.enableCompression, spool.connectionTimeoutInMs); err != nil {
			log.Print(err)
			return session, err
		}
	}
	return session, nil
}

func getSessionConfig(config *PoolConfig) *Config {
	return &Config{
		Host:            config.Host,
		Port:            config.Port,
		UserName:        config.UserName,
		Password:        config.Password,
		FetchSize:       config.FetchSize,
		TimeZone:        config.TimeZone,
		ConnectRetryMax: config.ConnectRetryMax,
		sqlDialect:      config.sqlDialect,
		Database:        config.Database,
		TLSConfig:       config.TLSConfig,
	}
}

func getClusterSessionConfig(config *PoolConfig) *ClusterConfig {
	return &ClusterConfig{
		NodeUrls:        config.NodeUrls,
		UserName:        config.UserName,
		Password:        config.Password,
		FetchSize:       config.FetchSize,
		TimeZone:        config.TimeZone,
		ConnectRetryMax: config.ConnectRetryMax,
		sqlDialect:      config.sqlDialect,
		Database:        config.Database,
		TLSConfig:       config.TLSConfig,
	}
}

func (spool *SessionPool) PutBack(session Session) {
	defer func() {
		if r := recover(); r != nil {
			session.Close()
		}
	}()
	if session.trans != nil && session.trans.IsOpen() {
		spool.ch <- session
	}
	<-spool.sem
}

func (spool *SessionPool) dropSession(session Session) {
	defer func() {
		if e := recover(); e != nil {
			if session.trans != nil && session.trans.IsOpen() {
				session.Close()
			}
		}
	}()
	err := session.Close()
	if err != nil {
		log.Println("Failed to close session ", session)
	}
	<-spool.sem
}

func (spool *SessionPool) Close() {
	close(spool.ch)
	for s := range spool.ch {
		s.Close()
	}
	close(spool.sem)
}
