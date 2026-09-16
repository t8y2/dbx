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

import "context"

// Options holds the configuration for a client call.
type Options struct {
	ctx context.Context
}

// Option is a functional option for configuring [Options].
type Option func(*Options)

// ApplyOptions applies the given options and returns the resulting Options.
func ApplyOptions(opts ...Option) Options {
	var result Options
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		opt(&result)
	}
	return result
}

// WithCtx returns an Option that sets the context for a client call.
func WithCtx(ctx context.Context) Option {
	return func(opts *Options) {
		opts.ctx = ctx
	}
}
