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

type BitMap struct {
	size int
	bits []byte
}

var BitUtil = []byte{1, 2, 4, 8, 16, 32, 64, 128}
var UnmarkBitUtil = []byte{
	0xFE, // 11111110
	0xFD, // 11111101
	0xFB, // 11111011
	0xF7, // 11110111
	0xEF, // 11101111
	0xDF, // 11011111
	0xBF, // 10111111
	0x7F, // 01111111
}

func NewBitMap(size int) *BitMap {
	// Need to maintain consistency with the calculation method on the IoTDB side.
	bitMap := &BitMap{
		size: size,
		bits: make([]byte, size/8+1),
	}
	return bitMap
}

func (b *BitMap) Mark(position int) {
	b.bits[position/8] |= BitUtil[position%8]
}

func (b *BitMap) UnMark(position int) {
	b.bits[position/8] &= UnmarkBitUtil[position%8]
}

func (b *BitMap) IsMarked(position int) bool {
	return (b.bits[position/8] & BitUtil[position%8]) != 0
}

func (b *BitMap) IsAllUnmarked() bool {
	for i := 0; i < b.size/8; i++ {
		if b.bits[i] != 0 {
			return false
		}
	}
	for i := 0; i < b.size%8; i++ {
		if (b.bits[b.size/8] & BitUtil[i]) != 0 {
			return false
		}
	}
	return true
}

func (b *BitMap) GetBits() []byte {
	return b.bits
}
