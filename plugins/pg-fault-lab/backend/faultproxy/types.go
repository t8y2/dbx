// Package faultproxy implements a bounded, loopback-only PostgreSQL fault lab.
package faultproxy

import "time"

type Config struct {
	DisposableLab  bool          `json:"disposableLab"`
	Upstream       string        `json:"upstream"`
	Listen         string        `json:"listen"`
	AllowInjection bool          `json:"allowInjection"`
	PauseTimeout   time.Duration `json:"-"`
	IOTimeout      time.Duration `json:"-"`
	MaxConnections int           `json:"maxConnections"`
}

type Selector struct {
	Application  string `json:"application,omitempty"`
	Database     string `json:"database,omitempty"`
	User         string `json:"user,omitempty"`
	ConnectionID string `json:"connectionId,omitempty"`
	SQLHash      string `json:"sqlHash,omitempty"`
	Command      string `json:"command,omitempty"`
}

type Rule struct {
	ID        string    `json:"id"`
	Selector  Selector  `json:"selector"`
	Phase     string    `json:"phase"`  // connect, execute, commit
	Action    string    `json:"action"` // pause, abort, drop
	Hits      int       `json:"hits"`   // bounded maximum matching executions
	TTLMS     int       `json:"ttlMs"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type Event struct {
	Sequence     uint64    `json:"sequence"`
	Time         time.Time `json:"time"`
	ConnectionID string    `json:"connectionId,omitempty"`
	Kind         string    `json:"kind"`
	Command      string    `json:"command,omitempty"`
	SQLHash      string    `json:"sqlHash,omitempty"`
	RuleID       string    `json:"ruleId,omitempty"`
	PauseID      string    `json:"pauseId,omitempty"`
	Outcome      string    `json:"outcome,omitempty"`
	SQLState     string    `json:"sqlState,omitempty"`
	// No raw SQL, bind values, rows, passwords, backend cancel keys, or error text.
}

type Pause struct {
	ID           string    `json:"id"`
	ConnectionID string    `json:"connectionId"`
	RuleID       string    `json:"ruleId"`
	Deadline     time.Time `json:"deadline"`
}

type Session struct {
	ID          string `json:"id"`
	Application string `json:"application"`
	Database    string `json:"database"`
	User        string `json:"user"`
	Transaction string `json:"transaction"`
}

type Snapshot struct {
	Address        string    `json:"address"`
	AllowInjection bool      `json:"allowInjection"`
	Sessions       []Session `json:"sessions"`
	Rules          []Rule    `json:"rules"`
	Pauses         []Pause   `json:"pauses"`
	Events         []Event   `json:"events"`
}
