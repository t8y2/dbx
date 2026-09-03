package main

import (
	"context"
	"encoding/json"
	"time"

	"go.etcd.io/etcd/api/v3/etcdserverpb"
	clientv3 "go.etcd.io/etcd/client/v3"
)

func (s *etcdSession) status(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	maintenance := client.Maintenance
	membersByID := map[uint64]*etcdserverpb.Member{}
	endpoints := s.connectedEndpointList()
	memberCtx, memberCancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
	memberList, err := client.Cluster.MemberList(memberCtx)
	memberCancel()
	if err == nil {
		for _, member := range memberList.Members {
			membersByID[member.ID] = member
			for _, clientURL := range member.ClientURLs {
				host := endpointHost(clientURL)
				if host == "" || host == "0.0.0.0" || host == "::" {
					continue
				}
				known := false
				for _, existing := range endpoints {
					if existing == clientURL {
						known = true
						break
					}
				}
				if !known {
					endpoints = append(endpoints, clientURL)
				}
			}
		}
	}

	alarms := []string{}
	alarmCtx, alarmCancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
	alarmResponse, err := maintenance.AlarmList(alarmCtx)
	alarmCancel()
	if err != nil {
		alarms = append(alarms, "UNAVAILABLE: "+err.Error())
	} else {
		for _, alarm := range alarmResponse.Alarms {
			alarms = append(alarms, alarm.Alarm.String()+"@"+unsignedLongString(int64(alarm.MemberID)))
		}
	}

	countCtx, countCancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
	countResponse, err := client.Get(countCtx, "\x00", clientv3.WithRange("\x00"), clientv3.WithCountOnly())
	countCancel()
	if err != nil {
		return nil, err
	}

	type statusResult struct {
		response *clientv3.StatusResponse
		err      error
		started  time.Time
	}
	statusRequests := make([]chan *statusResult, len(endpoints))
	for index, endpoint := range endpoints {
		channel := make(chan *statusResult, 1)
		statusRequests[index] = channel
		go func(endpoint string, channel chan *statusResult) {
			started := time.Now()
			ctx, cancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
			response, err := client.Maintenance.Status(ctx, endpoint)
			cancel()
			channel <- &statusResult{response: response, err: err, started: started}
		}(endpoint, channel)
	}

	statusMembers := []map[string]any{}
	observedMemberIDs := map[string]struct{}{}
	var clusterID *string
	var leaderID *string
	for index, channel := range statusRequests {
		result := <-channel
		row := map[string]any{"endpoint": endpoints[index]}
		if result.err != nil {
			row["memberId"] = nil
			row["name"] = nil
			row["version"] = nil
			row["leaderId"] = nil
			row["revision"] = nil
			row["raftTerm"] = nil
			row["raftIndex"] = nil
			row["raftAppliedIndex"] = nil
			row["dbSize"] = nil
			row["dbSizeInUse"] = nil
			row["learner"] = false
			row["reachable"] = false
			row["latencyMs"] = nil
			row["errors"] = []string{result.err.Error()}
			statusMembers = append(statusMembers, row)
			continue
		}
		memberStatus := result.response
		memberID := memberStatus.Header.MemberId
		member := membersByID[memberID]
		clusterIDValue := unsignedLongString(int64(memberStatus.Header.ClusterId))
		leaderIDValue := unsignedLongString(int64(memberStatus.Leader))
		clusterID = &clusterIDValue
		leaderID = &leaderIDValue
		row["memberId"] = unsignedLongString(int64(memberID))
		if member == nil {
			row["name"] = nil
		} else {
			row["name"] = member.Name
		}
		row["version"] = memberStatus.Version
		row["leaderId"] = unsignedLongString(int64(memberStatus.Leader))
		row["revision"] = longString(memberStatus.Header.Revision)
		row["raftTerm"] = longString(int64(memberStatus.RaftTerm))
		row["raftIndex"] = longString(int64(memberStatus.RaftIndex))
		row["raftAppliedIndex"] = longString(int64(memberStatus.RaftAppliedIndex))
		row["dbSize"] = longString(memberStatus.DbSize)
		row["dbSizeInUse"] = longString(memberStatus.DbSizeInUse)
		row["learner"] = memberStatus.IsLearner
		row["reachable"] = true
		row["latencyMs"] = time.Since(result.started).Milliseconds()
		memberIDKey := unsignedLongString(int64(memberID))
		if _, seen := observedMemberIDs[memberIDKey]; seen {
			continue
		}
		observedMemberIDs[memberIDKey] = struct{}{}
		statusMembers = append(statusMembers, row)
	}

	result := map[string]any{
		"clusterId": clusterID,
		"revision":  longString(countResponse.Header.Revision),
		"leaderId":  leaderID,
		"keyCount":  longString(countResponse.Count),
		"alarms":    alarms,
		"members":   statusMembers,
	}
	return result, nil
}
