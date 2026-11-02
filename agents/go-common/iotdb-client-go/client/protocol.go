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

type TSDataType int8

type TSEncoding uint8

type TSCompressionType uint8

const (
	UNKNOWN   TSDataType = -1
	BOOLEAN   TSDataType = 0
	INT32     TSDataType = 1
	INT64     TSDataType = 2
	FLOAT     TSDataType = 3
	DOUBLE    TSDataType = 4
	TEXT      TSDataType = 5
	TIMESTAMP TSDataType = 8
	DATE      TSDataType = 9
	BLOB      TSDataType = 10
	STRING    TSDataType = 11
)

var tsTypeMap = map[string]TSDataType{
	"BOOLEAN":   BOOLEAN,
	"INT32":     INT32,
	"INT64":     INT64,
	"FLOAT":     FLOAT,
	"DOUBLE":    DOUBLE,
	"TEXT":      TEXT,
	"TIMESTAMP": TIMESTAMP,
	"DATE":      DATE,
	"BLOB":      BLOB,
	"STRING":    STRING,
}

var byteToTsDataType = map[byte]TSDataType{
	0:  BOOLEAN,
	1:  INT32,
	2:  INT64,
	3:  FLOAT,
	4:  DOUBLE,
	5:  TEXT,
	8:  TIMESTAMP,
	9:  DATE,
	10: BLOB,
	11: STRING,
}

func GetDataTypeByStr(name string) (TSDataType, error) {
	dataType, exists := tsTypeMap[name]
	if !exists {
		return UNKNOWN, fmt.Errorf("invalid input: %v", name)
	}
	return dataType, nil
}

func getDataTypeByByte(b byte) (TSDataType, error) {
	dataType, exists := byteToTsDataType[b]
	if !exists {
		return UNKNOWN, fmt.Errorf("invalid input: %v", b)
	}
	return dataType, nil
}

const (
	PLAIN      TSEncoding = 0
	DICTIONARY TSEncoding = 1
	RLE        TSEncoding = 2
	DIFF       TSEncoding = 3
	TS_2DIFF   TSEncoding = 4
	BITMAP     TSEncoding = 5
	GORILLA_V1 TSEncoding = 6
	REGULAR    TSEncoding = 7
	GORILLA    TSEncoding = 8
	ZIGZAG     TSEncoding = 9
	FREQ       TSEncoding = 10
	CHIMP      TSEncoding = 11
	SPRINTZ    TSEncoding = 12
	RLBE       TSEncoding = 13
)

const (
	UNCOMPRESSED TSCompressionType = 0
	SNAPPY       TSCompressionType = 1
	GZIP         TSCompressionType = 2
	LZ4          TSCompressionType = 7
	ZSTD         TSCompressionType = 8
	LZMA2        TSCompressionType = 9
)

// TSStatusCode
const (
	SuccessStatus       int32 = 200
	IncompatibleVersion int32 = 201
	ConfigurationError  int32 = 202
	StartUpError        int32 = 203
	ShutDownError       int32 = 204

	UnsupportedOperation    int32 = 300
	ExecuteStatementError   int32 = 301
	MultipleError           int32 = 302
	IllegalParameter        int32 = 303
	OverlapWithExistingTask int32 = 304
	InternalServerError     int32 = 305

	RedirectionRecommend int32 = 400

	DatabaseNotExist        int32 = 500
	DatabaseAlreadyExists   int32 = 501
	SeriesOverflow          int32 = 502
	TimeseriesAlreadyExist  int32 = 503
	TimeseriesInBlackList   int32 = 504
	AliasAlreadyExist       int32 = 505
	PathAlreadyExist        int32 = 506
	MetadataError           int32 = 507
	PathNotExist            int32 = 508
	IllegalPath             int32 = 509
	CreateTemplateError     int32 = 510
	DuplicatedTemplate      int32 = 511
	UndefinedTemplate       int32 = 512
	TemplateNotSet          int32 = 513
	DifferentTemplate       int32 = 514
	TemplateIsInUse         int32 = 515
	TemplateIncompatible    int32 = 516
	SegmentNotFound         int32 = 517
	PageOutOfSpace          int32 = 518
	RecordDuplicated        int32 = 519
	SegmentOutOfSpace       int32 = 520
	SchemaFileNotExists     int32 = 521
	OversizeRecord          int32 = 522
	SchemaFileRedoLogBroken int32 = 523
	TemplateNotActivated    int32 = 524

	SystemReadOnly         int32 = 600
	StorageEngineError     int32 = 601
	StorageEngineNotReady  int32 = 602
	DataregionProcessError int32 = 603
	TsfileProcessorError   int32 = 604
	WriteProcessError      int32 = 605
	WriteProcessReject     int32 = 606
	OutOfTtl               int32 = 607
	CompactionError        int32 = 608
	AlignedTimeseriesError int32 = 609
	WalError               int32 = 610
	DiskSpaceInsufficient  int32 = 611

	SqlParseError             int32 = 700
	SemanticError             int32 = 701
	GenerateTimeZoneError     int32 = 702
	SetTimeZoneError          int32 = 703
	QueryNotAllowed           int32 = 704
	LogicalOperatorError      int32 = 705
	LogicalOptimizeError      int32 = 706
	UnsupportedFillType       int32 = 707
	QueryProcessError         int32 = 708
	MppMemoryNotEnough        int32 = 709
	CloseOperationError       int32 = 710
	TsblockSerializeError     int32 = 711
	InternalRequestTimeOut    int32 = 712
	InternalRequestRetryError int32 = 713

	InitAuthError             int32 = 800
	WrongLoginPassword        int32 = 801
	NotLogin                  int32 = 802
	NoPermission              int32 = 803
	UserNotExist              int32 = 804
	UserAlreadyExist          int32 = 805
	UserAlreadyHasRole        int32 = 806
	UserNotHasRole            int32 = 807
	RoleNotExist              int32 = 808
	RoleAlreadyExist          int32 = 809
	AlreadyHasPrivilege       int32 = 810
	NotHasPrivilege           int32 = 811
	ClearPermissionCacheError int32 = 812
	UnknownAuthPrivilege      int32 = 813
	UnsupportedAuthOperation  int32 = 814
	AuthIoException           int32 = 815

	MigrateRegionError        int32 = 900
	CreateRegionError         int32 = 901
	DeleteRegionError         int32 = 902
	PartitionCacheUpdateError int32 = 903
	ConsensusNotInitialized   int32 = 904
	RegionLeaderChangeError   int32 = 905
	NoAvailableRegionGroup    int32 = 906

	DatanodeAlreadyRegistered int32 = 1000
	NoEnoughDatanode          int32 = 1001
	AddConfignodeError        int32 = 1002
	RemoveConfignodeError     int32 = 1003
	DatanodeNotExist          int32 = 1004
	DatanodeStopError         int32 = 1005
	RemoveDatanodeError       int32 = 1006
	RegisterRemovedDatanode   int32 = 1007
	CanNotConnectDatanode     int32 = 1008

	LoadFileError                 int32 = 1100
	LoadPieceOfTsfileError        int32 = 1101
	DeserializePieceOfTsfileError int32 = 1102
	SyncConnectionError           int32 = 1103
	SyncFileRedirectionError      int32 = 1104
	SyncFileError                 int32 = 1105
	CreatePipeSinkError           int32 = 1106
	PipeError                     int32 = 1107
	PipeserverError               int32 = 1108
	VerifyMetadataError           int32 = 1109

	UdfLoadClassError        int32 = 1200
	UdfDownloadError         int32 = 1201
	CreateUdfOnDatanodeError int32 = 1202
	DropUdfOnDatanodeError   int32 = 1203

	CreateTriggerError         int32 = 1300
	DropTriggerError           int32 = 1301
	TriggerFireError           int32 = 1302
	TriggerLoadClassError      int32 = 1303
	TriggerDownloadError       int32 = 1304
	CreateTriggerInstanceError int32 = 1305
	ActiveTriggerInstanceError int32 = 1306
	DropTriggerInstanceError   int32 = 1307
	UpdateTriggerLocationError int32 = 1308

	NoSuchCq                  int32 = 1400
	CqAlreadyActive           int32 = 1401
	CqAlreadyExist            int32 = 1402
	CqUpdateLastExecTimeError int32 = 1403
)

const (
	TimestampColumnName = "Time"
)
