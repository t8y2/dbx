package main

import (
	"strings"
	"testing"

	"gitea.com/kingbase/gokb"
)

func TestQueryMessagesPreserveNoticeFieldsAndRepeatedOutput(t *testing.T) {
	buffer := &queryMessageBuffer{}
	notice := &gokb.Error{Severity: "NOTICE", Message: "当前用户", Code: "00000", Detail: "detail", Hint: "hint"}
	buffer.add(notice)
	buffer.add(notice)
	messages := buffer.drain()
	if len(messages) != 2 || messages[0].Message != notice.Message || messages[0].Code != "00000" || messages[0].Detail != "detail" || messages[0].Hint != "hint" {
		t.Fatalf("missing notice fields: %+v", messages)
	}
	if len(buffer.drain()) != 0 {
		t.Fatal("page messages were delivered twice")
	}
}

func TestQueryMessagesBoundCountAndBytesAcrossPages(t *testing.T) {
	buffer := &queryMessageBuffer{}
	for index := 0; index < maxQueryMessages; index++ {
		buffer.add(&gokb.Error{Severity: "NOTICE", Message: "same"})
		buffer.drain()
	}
	buffer.add(&gokb.Error{Message: "overflow"})
	buffer.add(&gokb.Error{Message: "overflow again"})
	if messages := buffer.drain(); len(messages) != 1 || messages[0].Severity != "WARNING" {
		t.Fatalf("missing output cap: %+v", messages)
	}
	buffer = &queryMessageBuffer{}
	buffer.add(&gokb.Error{Message: strings.Repeat("x", maxQueryMessageBytes+1)})
	if messages := buffer.drain(); len(messages) != 1 || messages[0].Severity != "WARNING" {
		t.Fatal("oversized notice was retained")
	}
}
