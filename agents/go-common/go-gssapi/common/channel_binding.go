package common

import "net"

type AddressFamily uint32

const (
	GssAddrFamilyUnspecified AddressFamily = 0
	GssAddrFamilyLOCAL       AddressFamily = 1
	GssAddrFamilyINET        AddressFamily = 2
)

type ChannelBinding struct {
	InitiatorAddr net.Addr
	AcceptorAddr  net.Addr
	Data          []byte
}
