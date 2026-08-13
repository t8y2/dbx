package gohive

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"

	"github.com/apache/thrift/lib/go/thrift"
	"github.com/beltran/gosasl"
	"github.com/pkg/errors"
)

const (
	START    = 1
	OK       = 2
	BAD      = 3
	ERROR    = 4
	COMPLETE = 5
)

// TSaslTransport is a tranport thrift struct that uses SASL
type TSaslTransport struct {
	service        string
	saslClient     *gosasl.Client
	tp             thrift.TTransport
	tpFramed       thrift.TFramedTransport
	mechanism      string
	writeBuf       bytes.Buffer
	readBuf        bytes.Buffer
	buffer         [4]byte
	rawFrameSize   uint32 //Current remaining size of the frame. if ==0 read next frame header
	frameSize      int    //Current remaining size of the frame. if ==0 read next frame header
	maxLength      uint32
	principal      string
	OpeningContext context.Context
}

// NewTSaslTransport return a TSaslTransport
func NewTSaslTransport(trans thrift.TTransport, host string, mechanismName string, configuration map[string]string, maxLength uint32) (*TSaslTransport, error) {
	return newTSaslTransport(trans, host, mechanismName, configuration, maxLength, nil)
}

// NewTSaslTransportWithGSSAPIOptions creates a SASL transport with
// connection-scoped Kerberos configuration.
func NewTSaslTransportWithGSSAPIOptions(
	trans thrift.TTransport,
	host string,
	mechanismName string,
	configuration map[string]string,
	maxLength uint32,
	options gosasl.GSSAPIOptions,
) (*TSaslTransport, error) {
	return newTSaslTransport(trans, host, mechanismName, configuration, maxLength, &options)
}

func newTSaslTransport(
	trans thrift.TTransport,
	host string,
	mechanismName string,
	configuration map[string]string,
	maxLength uint32,
	gssapiOptions *gosasl.GSSAPIOptions,
) (*TSaslTransport, error) {
	var mechanism gosasl.Mechanism
	switch mechanismName {
	case "PLAIN":
		mechanism = gosasl.NewPlainMechanism(configuration["username"], configuration["password"])
	case "GSSAPI":
		var err error
		if gssapiOptions == nil {
			mechanism, err = gosasl.NewGSSAPIMechanism(configuration["service"])
		} else {
			mechanism, err = gosasl.NewGSSAPIMechanismWithOptions(configuration["service"], *gssapiOptions)
		}
		if err != nil {
			return nil, err
		}
	case "DIGEST-MD5":
		mechanism = gosasl.NewDigestMD5Mechanism(configuration["service"], configuration["username"], configuration["password"])
	default:
		return nil, fmt.Errorf("unsupported SASL mechanism %q", mechanismName)
	}
	if trans == nil {
		return nil, errors.New("SASL transport requires an underlying transport")
	}
	if maxLength == 0 {
		return nil, errors.New("SASL maximum frame length must be positive")
	}
	client := gosasl.NewSaslClient(host, mechanism)
	return &TSaslTransport{
		saslClient:     client,
		tp:             trans,
		mechanism:      mechanismName,
		maxLength:      maxLength,
		principal:      configuration["principal"],
		OpeningContext: context.Background(),
	}, nil
}

// IsOpen opens a SASL connection
func (p *TSaslTransport) IsOpen() bool {
	return p.tp.IsOpen() && p.saslClient.Complete()
}

// Open check if a SASL transport connection is opened
func (p *TSaslTransport) Open() (err error) {
	if !p.tp.IsOpen() {
		err = p.tp.Open()
		if err != nil {
			return err
		}
	}
	if err = p.sendSaslMsg(p.OpeningContext, START, []byte(p.mechanism)); err != nil {
		return err
	}

	proccessed, err := p.saslClient.Start()
	if err != nil {
		return err
	}

	if err = p.sendSaslMsg(p.OpeningContext, OK, proccessed); err != nil {
		return err
	}

	for true {
		status, challenge, recvErr := p.recvSaslMsg(p.OpeningContext)
		if recvErr != nil {
			return recvErr
		}
		if status == OK {
			proccessed, err = p.saslClient.Step(challenge)
			if err != nil {
				return
			}
			if err = p.sendSaslMsg(p.OpeningContext, OK, proccessed); err != nil {
				return err
			}
		} else if status == COMPLETE {
			if !p.saslClient.Complete() {
				return thrift.NewTTransportException(thrift.NOT_OPEN, "The server erroneously indicated that SASL negotiation was complete")
			}
			break
		} else {
			return thrift.NewTTransportExceptionFromError(errors.Errorf("Bad SASL negotiation status: %d (%s)", status, challenge))
		}
	}
	return nil
}

// Close close a SASL transport connection
func (p *TSaslTransport) Close() (err error) {
	p.saslClient.Dispose()
	return p.tp.Close()
}

func (p *TSaslTransport) sendSaslMsg(ctx context.Context, status uint8, body []byte) error {
	header := make([]byte, 5)
	header[0] = status
	length := uint32(len(body))
	binary.BigEndian.PutUint32(header[1:], length)

	_, err := p.tp.Write(append(header[:], body[:]...))
	if err != nil {
		return err
	}

	err = p.tp.Flush(ctx)
	if err != nil {
		return err
	}
	return nil
}

func (p *TSaslTransport) recvSaslMsg(ctx context.Context) (int8, []byte, error) {
	header := make([]byte, 5)
	_, err := io.ReadFull(p.tp, header)
	if err != nil {
		return ERROR, nil, thrift.NewTTransportExceptionFromError(fmt.Errorf("reading SASL negotiation header: %w", err))
	}

	status := int8(header[0])
	length := binary.BigEndian.Uint32(header[1:])
	if length > p.maxLength {
		return ERROR, nil, thrift.NewTTransportException(
			thrift.UNKNOWN_TRANSPORT_EXCEPTION,
			fmt.Sprintf("SASL negotiation frame size %d exceeds maximum %d", length, p.maxLength),
		)
	}

	if length > 0 {
		payload := make([]byte, length)
		_, err = io.ReadFull(p.tp, payload)
		if err != nil {
			return ERROR, nil, thrift.NewTTransportExceptionFromError(fmt.Errorf("reading SASL negotiation payload: %w", err))
		}
		return status, payload, nil
	}
	return status, nil, nil
}

func (p *TSaslTransport) Read(buf []byte) (l int, err error) {
	if p.rawFrameSize == 0 && p.frameSize == 0 {
		p.rawFrameSize, err = p.readFrameHeader()
		if err != nil {
			return
		}
	}

	var got int
	if p.rawFrameSize > 0 {
		rawBuf := make([]byte, p.rawFrameSize)
		got, err = io.ReadFull(p.tp, rawBuf)
		if err != nil {
			return
		}
		p.rawFrameSize = p.rawFrameSize - uint32(got)

		var unwrappedBuf []byte
		unwrappedBuf, err = p.saslClient.Decode(rawBuf)
		if err != nil {
			return
		}
		p.frameSize += len(unwrappedBuf)
		p.readBuf.Write(unwrappedBuf)
	}

	// totalBytes := p.readBuf.Len()
	got, err = p.readBuf.Read(buf)
	p.frameSize = p.frameSize - got

	/*
		if p.readBuf.Len() > 0 {
			err = thrift.NewTTransportExceptionFromError(fmt.Errorf("Not enough frame size %d to read %d bytes", p.frameSize, totalBytes))
			return
		}
	*/
	if p.frameSize < 0 {
		return 0, thrift.NewTTransportException(thrift.UNKNOWN_TRANSPORT_EXCEPTION, "Negative frame size")
	}
	return got, thrift.NewTTransportExceptionFromError(err)
}

func (p *TSaslTransport) readFrameHeader() (uint32, error) {
	buf := p.buffer[:4]
	if _, err := io.ReadFull(p.tp, buf); err != nil {
		return 0, err
	}
	size := binary.BigEndian.Uint32(buf)
	if size > p.maxLength {
		return 0, thrift.NewTTransportException(thrift.UNKNOWN_TRANSPORT_EXCEPTION, fmt.Sprintf("Frame size is bigger than allowed, set configuration.MaxLength (%d)", size))
	}
	return size, nil
}

func (p *TSaslTransport) Write(buf []byte) (int, error) {
	n, err := p.writeBuf.Write(buf)
	return n, thrift.NewTTransportExceptionFromError(err)
}

// Flush the bytes in the buffer
func (p *TSaslTransport) Flush(ctx context.Context) (err error) {
	wrappedBuf, err := p.saslClient.Encode(p.writeBuf.Bytes())
	if err != nil {
		return thrift.NewTTransportExceptionFromError(err)
	}

	p.writeBuf.Reset()

	size := len(wrappedBuf)
	if uint64(size) > uint64(p.maxLength) {
		return thrift.NewTTransportException(
			thrift.UNKNOWN_TRANSPORT_EXCEPTION,
			fmt.Sprintf("Frame size is bigger than allowed, set configuration.MaxLength (%d)", size),
		)
	}
	buf := p.buffer[:4]
	binary.BigEndian.PutUint32(buf, uint32(size))
	_, err = p.tp.Write(buf)

	if err != nil {
		return thrift.NewTTransportExceptionFromError(err)
	}

	if size > 0 {
		if _, err := p.tp.Write(wrappedBuf); err != nil {
			return thrift.NewTTransportExceptionFromError(err)
		}
	}
	err = p.tp.Flush(ctx)
	return thrift.NewTTransportExceptionFromError(err)
}

// RemainingBytes return the size of the unwrapped bytes
func (p *TSaslTransport) RemainingBytes() uint64 {
	return uint64(p.frameSize)
}

// SetMaxLength set the maxLength
func (p *TSaslTransport) SetMaxLength(maxLength uint32) {
	p.maxLength = maxLength
}
