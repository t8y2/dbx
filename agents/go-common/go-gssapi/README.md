# go-gssapi: pure Go GSS-API implementation


![GitHub tag (latest SemVer)](https://img.shields.io/github/v/tag/golang-auth/go-gssapi)
[![Git Workflow](https://img.shields.io/github/workflow/status/golang-auth/go-gssapi/unit-tests/v2)](https://img.shields.io/github/workflow/status/golang-auth/go-gssapi/unit-tests/v2)
[![Go Version](https://img.shields.io/badge/go%20version-%3E=1.13-61CFDD.svg?style=flat-square)](https://golang.org/)
[![PkgGoDev](https://pkg.go.dev/badge/mod/github.com/golang-auth/go-gssapi/v2)](https://pkg.go.dev/mod/github.com/golang-auth/go-gssapi/v2)


go-gssapi is a pure Golang implementation of the GSS-API version 2 specification ([RFC 2743](https://tools.ietf.org/html/rfc2743)).  It uses the pure [Golang Kerberos implementation](https://github.com/jcmturner/gokrb5/tree/master/v8) to obtain Kerberos tickets and perform cryptographic operations.

Documentation at https://pkg.go.dev/github.com/golang-auth/go-gssapi/v2

## Implemented functionality

The current version implements the Kerberos V5 authentication mechanism ([RFC 4121](https://tools.ietf.org/html/rfc4121))  We plan
to support SPNEGO in a future release.

The following features are currently available:

 * Initiator (client) and Acceptor (server)
 * Mutual authentication
 * Message Integrity and Confidentiality
 * GSS MIC and Wrap tokens
 * Basic support for detecting out-of-sequence and duplicate messages


The following functionality is currently not available:

  * GSS-API v1 message tokens ([RFC1964](https://tools.ietf.org/html/rfc1964))
  * Delegation
  * Channel binding


## Platforms

Currently Unix platforms.  Support for the Windows SSPI will be added in future.

## Project status

go-gssapi is not yet considered to be production ready, and the interface is not yet considered stable.  We started
at v2 to support the new Go versioning standrd.  A v2.0.0 tag will be created after which we will follow normal [semantic versioning conventions](https://golang.org/ref/mod#versions).

## Configuration

The Kerberos implementiaton behing the GSS-API functionality is hidden form the caller.  The name of the krb5.conf file, credential cache (by an Initiator) and keytab file (by an Acceptor) are identified from the environment or using default paths if not specified in the environment :

| Configuration item | Environment variable | Default |
| ------------------ | -------------------- | ------- |
| Kerberos client configuartion file | `KRB5_CONFIG` | `/etc/krb5.conf` |
| Credential cache file | `KRB5CCNAME` | `/etc/krb5cc_%{UID}` |
| Keytab file | `KRB5_KTNAME` | `/var/kerberos/krb5/user/%{UID}/client.keytab` |

.. where `%{UID}` is the current username as returned by `id -u`

> :droplet: A future releaes will choose defaults based on the platform we're running on, and may provide more complete control of the gokrb client.  Please file a new Github issue if you have a use-case.

## Import paths and versions

Import the base `go-gssapi` package where you will use GSS-API, and  the mechanism specific package somewhere (usually the main package) to register the mechanism :

```go
  package myclient

  import "github.com/golang-auth/go-gssapi/v2"
```

```go
  package main

  //  register the Kerberos GSS-API mechsnism
  import _ "github.com/golang-auth/go-gssapi/v2/krb5"
```

We will maintain major versions of the library in separate Git branches.  To use the latest version in a branch, use `go get` with the branch name, eg :

     go get github.com/golang-auth/go-gssapi/v2@v2.0.0-alpha

This will result in a concrete version being added to `go.mod`:

```
module test

go 1.15

require github.com/golang-auth/go-gssapi/v2 v2.0.0-alpha //indirect
```

## Initialization

Obtain an instance (_context_) of a mechanism-specif implementation:
```go
  ctx := gssapi.NewMech("kerberos_v5)
```

then configure the context as an Initiator (client):

```go
  service := "ldap/ldap.example.com"
  var flags gssapi.ContextFlag = gssapi.ContextFlagInteg |
                                 gssapi.ContextFlagConf |
                                 gssapi.ContextFlagReplay |
                                 gssapi.ContextFlagSequence |
                                 gssapi.ContextFlagMutual
  err := ctx.Initiate(service, flags)
```


 or Acceptor (server):
 ```go
   err := ctx.Accept("")
 ```

 > Note: go-gssapi uses the Kebreros V5 principal name format (primary/instance), not the NT_HOSTBASED_SERVICE format (service@host) used by other GSS-API implementations

 ## Negotiation loop

 Once the context is initialized as an Initiator or Acceptor, the client and server enter a loop until `IsEstablished` returns true.  Each pass through the loop, the `Continue` method is called on the context.  `Continue` may return an opaque token that should be sent to the peer.  The peer passes the token to the `Continue` method and the process is repeated.

 ### Initiator loop
 ```go
var inToken, outToken []byte

for !ctx.IsEstablished() {
    outToken, err = ctx.Continue(inToken)
    if err != nil {
        break
    }

    if len(outToken) > 0 {
        if sendErr := sendToken(conn, outToken); sendErr != nil {
                err = sendErr
                break
        }
    }

    if !ctx.IsEstablished() {
        inToken, err = recvToken(conn)
        if err != nil {
            break
        }
    }
}

if err != nil {
    fmt.Fprintln(os.Stderr, err)
    os.Exit(1)
}
 ```

### Acceptor loop
```go
var inToken, outToken []byte

for !ctx.IsEstablished() {
    inToken, err = recvToken(conn)
    if err != nil {
        fmt.Fprintln(os.Stderr, err)
        break
    }

    outToken, err = ctx.Continue(inToken)
    if len(outToken) > 0 {
        if sendErr := sendToken(conn, outToken); sendErr != nil {
            err = sendErr
            break
        }
    }
}

if err != nil {
    fmt.Fprintln(os.Stderr, err)
    return
}
```

## Exchanging messages

GSS-API defines two message types :
  * Wrap messages encapsulate a message payload plus either a signature, or with the payload encrypted (if confidentially is requested)
  * Message Integrity Code (MIC) messages convey a signature of a payload but do not encapsulate the actual payload

The context `Wrap` and `MakeSignature` methods are used to generate serialized GSS-API message tokens for a given payload.  MIC tokens can be communicated separately from the payload, for example as a part of an acknowledgement or via a separate channel from the data.

The receiver of a message passes the token to the context `Unwrap` and `VerifySignature` methods.  Unwrap verifies the message payload signature or decrypts the message payload (if confidentially is in use).  VerifySignature verifies the signature of a payload passed to the method.

### sender
```go

msg := "Hello go-gssapi!"
seal := true  // ask for confidentiality

// Wrap the message
outToken, err = ctx.Wrap([]byte(msg), seal)
if err != nil {
  return err
}

// send it to the GSS-API peer
if err = sendToken(conn, outToken); err != nil {
  retirm err
}

```


### receiver
```go
inToken, err := recvToken(conn)
if err != nil {
  return err
}

msg, isSealed, err := ctx.Unwrap(inToken)
if err != nil {
    return err
}

protStr := "signed"
if isSealed {
        protStr = "sealed"
}
fmt.Printf(`Received %s message: "%s"`+"\n", protStr, msg)
```

## Sample code

Examples implemented in C (for use with the MIT or Heimdal GSS-API library) and Go are included in the `examples` directory.  The C samples are provided to demonstrate go-gssapi interoperatbility.
