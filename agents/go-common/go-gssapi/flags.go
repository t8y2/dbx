package gssapi

import "strings"

type ContextFlag uint32

// GSS-API context flags assigned numbers.
const (
	ContextFlagDeleg    ContextFlag = 1 << iota // delegate credentials, not currently supported
	ContextFlagMutual                           // request remote peer authenticates itself
	ContextFlagReplay                           // enable replay detection for signed/sealed messages
	ContextFlagSequence                         // enable detection of out of sequence signed/sealed messages
	ContextFlagConf                             // confidentiality available
	ContextFlagInteg                            // integrity available
)

// FlagList returns a slice of individual flags derived from the
// composite value f
func FlagList(f ContextFlag) (fl []ContextFlag) {
	t := ContextFlag(1)
	for i := 0; i < 32; i++ {
		if f&t != 0 {
			fl = append(fl, t)
		}

		t <<= 1
	}

	return
}

// FlagName returns a human-readable description of a context flag value
func FlagName(f ContextFlag) string {
	switch f {
	case ContextFlagDeleg:
		return "Delegation"
	case ContextFlagMutual:
		return "Mutual authentication"
	case ContextFlagReplay:
		return "Message replay detection"
	case ContextFlagSequence:
		return "Out of sequence message detection"
	case ContextFlagConf:
		return "Confidentiality"
	case ContextFlagInteg:
		return "Integrity"
	}

	return "Unknown"
}

func (f ContextFlag) String() string {
	var names []string
	for _, flag := range FlagList(f) {
		names = append(names, FlagName(flag))
	}

	return strings.Join(names, ", ")
}
