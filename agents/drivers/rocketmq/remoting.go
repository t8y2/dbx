package main

import (
	"context"
	"fmt"
	"time"

	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
)

func invokeRemotingWithClient(ctx context.Context, address string, command *remoting.RemotingCommand) (*remoting.RemotingCommand, error) {
	return invokeRemotingAllowCodes(ctx, address, defaultRequestTimeout, command, remoting.Success)
}

func invokeRemotingAllowCodes(
	ctx context.Context,
	address string,
	connectTimeout time.Duration,
	command *remoting.RemotingCommand,
	allowedCodes ...int,
) (*remoting.RemotingCommand, error) {
	client := remoting.NewClient(address, connectTimeout)
	if err := client.Connect(); err != nil {
		return nil, err
	}
	defer client.Close()
	response, err := client.InvokeSync(ctx, command)
	if err != nil {
		return nil, err
	}
	allowed := false
	for _, code := range allowedCodes {
		if response.Code == code {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, fmt.Errorf("RocketMQ error %d: %s", response.Code, response.Remark)
	}
	return response, nil
}
