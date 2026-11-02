package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// status assembles a reduced kv_status document from the v2 endpoints:
// /v2/members, /v2/stats/self, /v2/stats/leader, and /v2/stats/store. Fields
// without a v2 analog (alarms, dbSize, raft detail) stay null.
func (s *etcd2Session) status(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)

	type member struct {
		ID         string   `json:"id"`
		Name       string   `json:"name"`
		PeerURLs   []string `json:"peerURLs"`
		ClientURLs []string `json:"clientURLs"`
	}
	membersByID := map[string]*member{}
	var memberList []member
	var clusterID *string
	if body, response, err := client.do(ctx, http.MethodGet, "/v2/members", "", nil); err == nil {
		var parsed struct {
			Members []member `json:"members"`
		}
		if json.Unmarshal(body, &parsed) == nil {
			memberList = parsed.Members
			for index := range memberList {
				membersByID[memberList[index].ID] = &memberList[index]
			}
		}
		if header := response.Header.Get("X-Etcd-Cluster-Id"); header != "" {
			clusterID = &header
		}
	}
	// The v2 API exposes the current index only as a response header on the
	// keys endpoints, not in any stats document.
	var revision *string
	if _, response, err := client.do(ctx, http.MethodGet, "/v2/keys/", "", nil); err == nil {
		if header := response.Header.Get("X-Etcd-Index"); header != "" {
			revision = &header
		}
	}

	type selfStats struct {
		Name       string `json:"name"`
		ID         string `json:"id"`
		State      string `json:"state"`
		LeaderInfo struct {
			Leader string `json:"leader"`
		} `json:"leaderInfo"`
		RecvAppendRequestCnt int64 `json:"recvAppendRequestCnt"`
		SendAppendRequestCnt int64 `json:"sendAppendRequestCnt"`
	}
	var leaderID *string
	selfByEndpoint := map[string]*selfStats{}
	endpoints := s.connectedEndpointList()
	for _, endpoint := range endpoints {
		self := &selfStats{}
		body, _, err := client.doAt(ctx, http.MethodGet, endpoint, "/v2/stats/self", "")
		if err != nil {
			continue
		}
		if json.Unmarshal(body, self) != nil {
			continue
		}
		selfByEndpoint[endpoint] = self
		if self.LeaderInfo.Leader != "" {
			value := self.LeaderInfo.Leader
			leaderID = &value
		}
	}

	storeStats := map[string]any{}
	if body, _, err := client.do(ctx, http.MethodGet, "/v2/stats/store", "", nil); err == nil {
		var parsed map[string]any
		if json.Unmarshal(body, &parsed) == nil {
			storeStats = parsed
		}
	}

	statusMembers := []map[string]any{}
	observedIDs := map[string]struct{}{}
	for _, endpoint := range endpoints {
		row := map[string]any{"endpoint": endpoint}
		started := time.Now()
		self := selfByEndpoint[endpoint]
		if self == nil {
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
			row["errors"] = []string{"stats request failed"}
			statusMembers = append(statusMembers, row)
			continue
		}
		member := membersByID[self.ID]
		row["memberId"] = memberHexToUnsigned(self.ID)
		if member == nil {
			row["name"] = self.Name
		} else {
			row["name"] = member.Name
		}
		row["version"] = client.serverVersion
		row["leaderId"] = memberHexToUnsigned(self.LeaderInfo.Leader)
		row["revision"] = nil
		row["raftTerm"] = nil
		row["raftIndex"] = nil
		row["raftAppliedIndex"] = nil
		row["dbSize"] = nil
		row["dbSizeInUse"] = nil
		row["learner"] = false
		row["reachable"] = true
		row["latencyMs"] = time.Since(started).Milliseconds()
		row["errors"] = []string{}
		row["state"] = strings.TrimPrefix(self.State, "State")
		if _, seen := observedIDs[self.ID]; seen {
			continue
		}
		observedIDs[self.ID] = struct{}{}
		statusMembers = append(statusMembers, row)
	}

	var clusterIDValue any
	if clusterID != nil {
		clusterIDValue = memberHexToUnsigned(*clusterID)
	}
	var leaderIDValue any
	if leaderID != nil {
		leaderIDValue = memberHexToUnsigned(*leaderID)
	}
	var revisionValue any
	if revision != nil {
		revisionValue = *revision
	}
	// The v2 API has no key-count equivalent of the v3 count-only range;
	// the raw store counters are exposed separately below.
	var keyCountValue any
	return map[string]any{
		"clusterId": clusterIDValue,
		"revision":  revisionValue,
		"leaderId":  leaderIDValue,
		"keyCount":  keyCountValue,
		"alarms":    []string{},
		"members":   statusMembers,
		"store":     storeStats,
	}, nil
}

// memberHexToUnsigned converts v2 hex member/cluster IDs (e.g. "272e204152")
// to the unsigned decimal strings the v3 agent emits.
func memberHexToUnsigned(hex string) any {
	if hex == "" {
		return nil
	}
	parsed, err := strconv.ParseUint(strings.TrimPrefix(hex, "0x"), 16, 64)
	if err != nil {
		return nil
	}
	return unsignedLongString(int64(parsed))
}
