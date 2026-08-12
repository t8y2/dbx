package gssapi

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFlagList(t *testing.T) {
	flags := ContextFlagConf | ContextFlagMutual | ContextFlagDeleg
	flaglist := FlagList(flags)

	assert.ElementsMatch(t, []ContextFlag{ContextFlagConf, ContextFlagMutual, ContextFlagDeleg}, flaglist)
}

func TestFlagName(t *testing.T) {
	assert.Equal(t, "Delegation", FlagName(ContextFlagDeleg))
	assert.Equal(t, "Integrity", FlagName(ContextFlagInteg))
}

func TestFlagString(t *testing.T) {
	flags := ContextFlagConf | ContextFlagMutual | ContextFlagDeleg
	str := flags.String()

	assert.Contains(t, str, "Delegation")
	assert.Contains(t, str, "Mutual")
	assert.Contains(t, str, "Confidentiality")
	assert.NotContains(t, str, "sequence")
}
