# CHANGELOG

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

---

## [rumqttc 0.24.0] - 27-02-2024

### Added
- Expose `EventLoop::clean` to allow triggering shutdown and subsequent storage of pending requests
- Support for all variants of TLS key formats currently supported by Rustls: `PKCS#1`, `PKCS#8`, `RFC5915`. In practice we should now support all RSA keys and ECC keys in `DER` and `SEC1` encoding. Previously only `PKCS#1` and `PKCS#8` where supported.
- TLS Error variants: `NoValidClientCertInChain`, `NoValidKeyInChain`.
- Drain `Request`s, which weren't received by eventloop, from channel and put them in pending while doing cleanup to prevent data loss.
- websocket request modifier for v4 client
- Surfaced `AsyncClient`'s `from_senders` method to the `Client` as `from_sender`

### Changed
- `MqttOptions::new` now accepts empty client id.
- `MqttOptions::set_clean_session` now panics if client ID is empty and `clean_session` flag is set to false.
- Synchronous client methods take `&self` instead of `&mut self` (#646)
- Removed the `Key` enum: users do not need to specify the TLS key variant in the `TlsConfiguration` anymore, this is inferred automatically.
To update your code simply remove `Key::ECC()` or `Key::RSA()` from the initialization.
- certificate for client authentication is now optional while using native-tls. `der` & `password` fields are replaced by `client_auth`.
- Make v5 `RetainForwardRule` public, in order to allow setting it when constructing `Filter` values.
- Use `VecDeque` instead of `IntoIter` to fix unintentional drop of pending requests on `EventLoop::clean` (#780)
- `StateError::IncommingPacketTooLarge` is now `StateError::IncomingPacketTooLarge`.
- Update `tokio-rustls` to `0.25.0`, `rustls-native-certs` to `0.7.0`, `rustls-webpki` to `0.102.1`,
  `rusttls-pemfile` to `2.0.0`, `async-tungstenite` to `0.24.0`, `ws_stream_tungstenite` to `0.12.0`
  and `http` to `1.0.0`. This is a breaking change as types from some of these crates are part of
  the public API.

### Deprecated

### Removed

### Fixed
- Lowered the MSRV to 1.64.0
- Request modifier function should be Send and Sync and removed unnecessary Box

### Security

---

## [rumqttc 0.23.0] - 10-10-2023

### Added
- Added `bind_device` to `NetworkOptions` to enable `TCPSocket.bind_device()`
- Added `MqttOptions::set_request_modifier` for setting a handler for modifying a websocket request before sending it.

### Changed

### Deprecated

### Removed

### Fixed
- Allow keep alive values <= 5 seconds (#643)
- Verify "mqtt" is present in websocket subprotocol header.

### Security
- Remove dependency on webpki. [CVE](https://rustsec.org/advisories/RUSTSEC-2023-0052)
- Removed dependency vulnerability, see [rustsec](https://rustsec.org/advisories/RUSTSEC-2023-0065). Update of `tungstenite` dependency.

---

## [rumqttc 0.22.0] - 07-06-2023

### Added
- Added `outgoing_inflight_upper_limit` to MQTT5 `MqttOptions`. This sets the upper bound for the number of outgoing publish messages (#615)
- Added support for HTTP(s) proxy (#608)
    - Added `proxy` feature gate
    - Refactored `eventloop::network_connect` to allow setting proxy
    - Added proxy options to `MqttOptions`
- Update `rustls` to `0.21` and `tokio-rustls` to `0.24` (#606)
    - Adds support for TLS certificates containing IP addresses
    - Adds support for RFC8446 C.4 client tracking prevention

### Changed
- `MqttState::new` takes `max_outgoing_packet_size` which was set in `MqttOptions` but not used (#622)

### Deprecated

### Removed

### Fixed
- Enforce `max_outgoing_packet_size` on v4 client (#622)

### Security

## [rumqttc 0.21.0] - 01-05-2023

### Added
- Added support for MQTT5 features to v5 client
    - Refactored v5::mqttbytes to use associated functions & include properties
    - Added new API's on v5 client for properties, eg `publish_with_props` etc
    - Refactored `MqttOptions` to use `ConnectProperties` for some fields
    - Other minor changes for MQTT5

### Changed
- Remove `Box` on `Event::Incoming`

### Deprecated

### Removed
- Removed dependency on pollster

### Fixed
- Fixed v5::mqttbytes `Connect` packet returning wrong size on `write()`
    - Added tests for packet length for all v5 packets

### Security


## [rumqttc 0.20.0] - 17-01-2023

### Added
- `NetworkOptions` added to provide a way to configure low level network configurations (#545)

### Changed
- `options` in `Eventloop` now is called `mqtt_options` (#545)
- `ConnectionError` now has specific variant for type of `Timeout`, `FlushTimeout` and `NetworkTimeout` instead of generic `Timeout` for both (#545)
- `conn_timeout` is moved into `NetworkOptions` (#545)

---

Old changelog entries can be found at [CHANGELOG.md](../CHANGELOG.md)
