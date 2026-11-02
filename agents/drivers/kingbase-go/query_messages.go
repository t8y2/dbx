package main

import (
	"database/sql"
	"database/sql/driver"
	"reflect"
	"sync"

	"gitea.com/kingbase/gokb"
)

const maxQueryMessages = 1000
const maxQueryMessageBytes = 1024 * 1024

type queryMessage struct {
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Code     string `json:"code,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Hint     string `json:"hint,omitempty"`
}

type queryMessageBuffer struct {
	mu        sync.Mutex
	messages  []queryMessage
	count     int
	bytes     int
	truncated bool
}

func (buffer *queryMessageBuffer) add(notice *gokb.Error) {
	buffer.addMessage(queryMessage{Severity: notice.Severity, Message: notice.Message, Code: string(notice.Code), Detail: notice.Detail, Hint: notice.Hint})
}

func (buffer *queryMessageBuffer) addMessage(message queryMessage) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if buffer.truncated {
		return
	}
	size := len(message.Severity) + len(message.Message) + len(message.Code) + len(message.Detail) + len(message.Hint)
	if buffer.count >= maxQueryMessages || size > maxQueryMessageBytes-buffer.bytes {
		buffer.truncated = true
		buffer.messages = append(buffer.messages, queryMessage{Severity: "WARNING", Message: "Server output limit reached; further messages are not retained."})
		return
	}
	buffer.messages = append(buffer.messages, message)
	buffer.count++
	buffer.bytes += size
}

func (buffer *queryMessageBuffer) drain() []queryMessage {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	messages := buffer.messages
	buffer.messages = nil
	return messages
}

func captureQueryMessages(conn *sql.Conn) (*queryMessageBuffer, func(), error) {
	buffer := &queryMessageBuffer{}
	var restore func(driver.Conn)
	err := conn.Raw(func(raw any) error {
		driverConn := raw.(driver.Conn)
		connectionType := reflect.TypeOf(driverConn)
		if connectionType.Kind() != reflect.Pointer || connectionType.Elem().PkgPath() != "gitea.com/kingbase/gokb" {
			return nil
		}
		previous := gokb.NoticeHandler(driverConn)
		gokb.SetNoticeHandler(driverConn, buffer.add)
		restore = func(driverConn driver.Conn) { gokb.SetNoticeHandler(driverConn, previous) }
		return nil
	})
	return buffer, func() {
		if restore != nil {
			_ = conn.Raw(func(raw any) error { restore(raw.(driver.Conn)); return nil })
		}
	}, err
}
