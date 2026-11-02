# Changelog

## \[2.10.1]

- [`31ab6f8d`](https://github.com/tauri-apps/plugins-workspace/commit/31ab6f8d2466d86c80b1d70510c0400ce2cdcb0a) ([#3285](https://github.com/tauri-apps/plugins-workspace/pull/3285) by [@hrzlgnm](https://github.com/tauri-apps/plugins-workspace/../../hrzlgnm)) fix: preserve file extension of updater package, otherwise users may get confused when presented with a sudo dialog suggesting to install a file with the extension `.rpm` using `dpkg -i`

## \[2.10.0]

- [`4375c98b`](https://github.com/tauri-apps/plugins-workspace/commit/4375c98bed1769a1fc1be26eded4db9f7c095d95) ([#3073](https://github.com/tauri-apps/plugins-workspace/pull/3073)) Add no_proxy config to disable system proxy for updater plugin.
- [`f122ee98`](https://github.com/tauri-apps/plugins-workspace/commit/f122ee98c6954075891ac3cd530f5e29da117b39) Allow configuring the updater client to accept invalid TLS certificates and hostnames for internal/self-signed update servers. These options are available via the plugin config (`dangerousAcceptInvalidCerts`, `dangerousAcceptInvalidHostnames`) and via the `UpdaterBuilder` (`dangerous_accept_invalid_certs`, `dangerous_accept_invalid_hostnames`).
- [`f122ee98`](https://github.com/tauri-apps/plugins-workspace/commit/f122ee98c6954075891ac3cd530f5e29da117b39) Updater plugin now supports all bundle types: Deb, Rpm and AppImage for Linux; NSiS, MSI for Windows. This was added in https://github.com/tauri-apps/plugins-workspace/pull/2624
- [`05c5da07`](https://github.com/tauri-apps/plugins-workspace/commit/05c5da072b6e3254c19ee69024f80f4dfe1b779b) ([#3213](https://github.com/tauri-apps/plugins-workspace/pull/3213)) Updated `reqwest` to 0.13, make sure to update your `reqwest` dependency if you're using `UpdaterBuilder::configure_client`

## \[2.9.0]

- [`f209b2f2`](https://github.com/tauri-apps/plugins-workspace/commit/f209b2f23cb29133c97ad5961fb46ef794dbe063) ([#2804](https://github.com/tauri-apps/plugins-workspace/pull/2804) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Updated tauri to 2.6

## \[2.8.1]

- [`735d209d`](https://github.com/tauri-apps/plugins-workspace/commit/735d209d5d1d92dcac70c6083bcfcd34ec7d84be) ([#2761](https://github.com/tauri-apps/plugins-workspace/pull/2761) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Fixed an issue preventing updates via the NSIS installer from succeeding when the app was launched with command line arguments containing spaces.

## \[2.8.0]

- [`87afa23c`](https://github.com/tauri-apps/plugins-workspace/commit/87afa23cad077c09bc1eb743800ae3396b531146) ([#2726](https://github.com/tauri-apps/plugins-workspace/pull/2726)) Add allowDowngrades parameter to check command

  Added a new optional `allowDowngrades` parameter to the JavaScript check command that allows the updater to consider versions that are lower than the current version as valid updates. When enabled, the version comparator will accept any version that is different from the current version, effectively allowing downgrades.
- [`73ff15de`](https://github.com/tauri-apps/plugins-workspace/commit/73ff15de5d07d476693e40e8e5d138c16da5211e) ([#2757](https://github.com/tauri-apps/plugins-workspace/pull/2757)) Fix headers option in `Update.download` and `Update.downloadAndInstall` doesn't work with `Record<string, string> | Headers` types

## \[2.7.1]

- [`c5b0f51c`](https://github.com/tauri-apps/plugins-workspace/commit/c5b0f51cfd911cca9317b59efc718b570980129b) ([#2621](https://github.com/tauri-apps/plugins-workspace/pull/2621) by [@Legend-Master](https://github.com/tauri-apps/plugins-workspace/../../Legend-Master)) Fix `check` and `download` overrides the `accept` header

## \[2.7.0]

### bug

- [`2d731f80`](https://github.com/tauri-apps/plugins-workspace/commit/2d731f80224f74faf1b7170b25e04f5da1da49c8) ([#2573](https://github.com/tauri-apps/plugins-workspace/pull/2573)) Fix JS API `Update.date` not formatted to RFC 3339
- [`0bc5d588`](https://github.com/tauri-apps/plugins-workspace/commit/0bc5d5887420ba1eb718254490b7995c771c0447) ([#2572](https://github.com/tauri-apps/plugins-workspace/pull/2572)) Fix `timeout` passed to `check` gets re-used by `download` and `downloadAndinstall`

## \[2.6.1]

- [`12c4537b`](https://github.com/tauri-apps/plugins-workspace/commit/12c4537b8e4fed29b415ff817434b664c0596dac) ([#2541](https://github.com/tauri-apps/plugins-workspace/pull/2541) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Add support to the `riscv64` architecture.

## \[2.6.0]

- [`faefcc9f`](https://github.com/tauri-apps/plugins-workspace/commit/faefcc9fd8c61f709d491649e255a7fcac82c09a) ([#2430](https://github.com/tauri-apps/plugins-workspace/pull/2430) by [@goenning](https://github.com/tauri-apps/plugins-workspace/../../goenning)) Add `UpdaterBuilder::configure_client` method on Rust side, to configure the `reqwest` client used to check and download the update.
- [`ac60d589`](https://github.com/tauri-apps/plugins-workspace/commit/ac60d589eca2bbc4aed040feb18da148e66ec171) ([#2513](https://github.com/tauri-apps/plugins-workspace/pull/2513) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Enhance error logging.

## \[2.5.1]

- [`6f881293`](https://github.com/tauri-apps/plugins-workspace/commit/6f881293fcd67838f6f3f8063f536292431dd1f7) ([#2439](https://github.com/tauri-apps/plugins-workspace/pull/2439) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Fixed an issue that caused the plugin to emit a `ReleaseNotFound` error instead of a `Reqwest` error when the http request in `check()` failed.

## \[2.5.0]

- [`5369898d`](https://github.com/tauri-apps/plugins-workspace/commit/5369898db7a6098e3e2f43436100ea556d405628) ([#2067](https://github.com/tauri-apps/plugins-workspace/pull/2067) by [@jLynx](https://github.com/tauri-apps/plugins-workspace/../../jLynx)) Fix update installation on macOS when using an user without admin privileges.
- [`5369898d`](https://github.com/tauri-apps/plugins-workspace/commit/5369898db7a6098e3e2f43436100ea556d405628) ([#2067](https://github.com/tauri-apps/plugins-workspace/pull/2067) by [@jLynx](https://github.com/tauri-apps/plugins-workspace/../../jLynx)) Remove the `UpdaterBuilder::new` function, use `UpdaterExt::updater_builder` instead.

## \[2.4.0]

- [`0afc9b6b`](https://github.com/tauri-apps/plugins-workspace/commit/0afc9b6be07bee1077f05a86285d977e57810ed9) ([#2325](https://github.com/tauri-apps/plugins-workspace/pull/2325) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) The `Update` struct/object will now contain a `raw_json`/`rawJson` property to be able to read parts of server's json response that are not handled by the plugin.

## \[2.3.1]

- [`57efb47c`](https://github.com/tauri-apps/plugins-workspace/commit/57efb47c116f880477f72f02a8e4239e88007d44) ([#2235](https://github.com/tauri-apps/plugins-workspace/pull/2235) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Add `Builder::header` and `Builder::headers` method to configure default headers for updater.

## \[2.3.0]

- [`829b6326`](https://github.com/tauri-apps/plugins-workspace/commit/829b63265030bc9c61d1738c4eaca0ffb3178677) ([#1919](https://github.com/tauri-apps/plugins-workspace/pull/1919) by [@n1ght-hunter](https://github.com/tauri-apps/plugins-workspace/../../n1ght-hunter)) Add `tauri_plugin_updater::Builder::default_version_comparator` method to set the default version comparator for the updater.

## \[2.2.0]

- [`3a79266b`](https://github.com/tauri-apps/plugins-workspace/commit/3a79266b8cf96a55b1ae6339d725567d45a44b1d) ([#2173](https://github.com/tauri-apps/plugins-workspace/pull/2173) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Bumped all plugins to `v2.2.0`. From now, the versions for the Rust and JavaScript packages of each plugin will be in sync with each other.

## \[2.1.0]

- [`f8f2eefe`](https://github.com/tauri-apps/plugins-workspace/commit/f8f2eefe03ab231beafbd6a88d61b53d77f0400d) ([#1991](https://github.com/tauri-apps/plugins-workspace/pull/1991) by [@jLynx](https://github.com/tauri-apps/plugins-workspace/../../jLynx)) Added support for `.deb` package updates on Linux systems.

## \[2.0.2]

- [`a1a82208`](https://github.com/tauri-apps/plugins-workspace/commit/a1a82208ed4ab87f83310be0dc95428aec9ab241) ([#1873](https://github.com/tauri-apps/plugins-workspace/pull/1873) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Downgrade MSRV to 1.77.2 to support Windows 7.

## \[2.0.1]

- [`9501cfa5`](https://github.com/tauri-apps/plugins-workspace/commit/9501cfa5f5385b2d7eb43a8378b322ee97cba06f) ([#1868](https://github.com/tauri-apps/plugins-workspace/pull/1868) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Fix configuration parser incorrectly warning about the endpoint scheme.

## \[2.0.0]

- [`e2c4dfb6`](https://github.com/tauri-apps/plugins-workspace/commit/e2c4dfb6af43e5dd8d9ceba232c315f5febd55c1) Update to tauri v2 stable release.

## \[2.0.0-rc.4]

- [`221f50f5`](https://github.com/tauri-apps/plugins-workspace/commit/221f50f53bd7a87dbd404e4cb1aaf502a5047785) ([#1816](https://github.com/tauri-apps/plugins-workspace/pull/1816) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Encode `+` when making updater requests which can be cause incorrectly interpolating the endpoint when using `{{current_version}}` in the endpoint where the current version contains a build number, for example `1.8.0+1`.
- [`04a0aea0`](https://github.com/tauri-apps/plugins-workspace/commit/04a0aea0ab9f8750200bc2fe5aff99c1c488082d) ([#1814](https://github.com/tauri-apps/plugins-workspace/pull/1814) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) **Breaking change**, Changed `UpdaterBuilder::endpoints` method to return a `Result`.
- [`04a0aea0`](https://github.com/tauri-apps/plugins-workspace/commit/04a0aea0ab9f8750200bc2fe5aff99c1c488082d) ([#1814](https://github.com/tauri-apps/plugins-workspace/pull/1814) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Add `dangerousInsecureTransportProtocol` config option to allow using insecure transport protocols, like `http`

## \[2.0.0-rc.3]

- [`d00519e3`](https://github.com/tauri-apps/plugins-workspace/commit/d00519e3e3a3234f9eb6c2ba82c92d4199f03e53) ([#1735](https://github.com/tauri-apps/plugins-workspace/pull/1735) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) This releases the changes from 2.0.0-rc.2 to crates.io. Please see the links below for the actual changes.

## \[2.0.0-rc.2]

- [`f8255e1d`](https://github.com/tauri-apps/plugins-workspace/commit/f8255e1db5df6cf562b9334fbefe5e62f4a28e0a) ([#1661](https://github.com/tauri-apps/plugins-workspace/pull/1661) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Add a second argument in `Update.download` and `Update.donloadAndInstall` JS APIs to modify headers and timeout when downloading the update.

## \[2.0.0-rc.1]

- [`e2e97db5`](https://github.com/tauri-apps/plugins-workspace/commit/e2e97db51983267f5be84d4f6f0278d58834d1f5) ([#1701](https://github.com/tauri-apps/plugins-workspace/pull/1701) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Update to tauri 2.0.0-rc.8

## \[2.0.0-rc.1]

- [`77013925`](https://github.com/tauri-apps/plugins-workspace/commit/7701392500f375340045880fce5fb8f867bfe670) ([#1636](https://github.com/tauri-apps/plugins-workspace/pull/1636) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Fixes the updater not preserving AppImage file permissions.
- [`5d170a54`](https://github.com/tauri-apps/plugins-workspace/commit/5d170a5444982dcc14135f6f1fc3e5da359f0eb0) ([#1671](https://github.com/tauri-apps/plugins-workspace/pull/1671) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Update to tauri 2.0.0-rc.3.

## \[2.0.0-rc.0]

- [`9887d1`](https://github.com/tauri-apps/plugins-workspace/commit/9887d14bd0e971c4c0f5c1188fc4005d3fc2e29e) Update to tauri RC.

## \[2.0.0-beta.8]

- [`99d6ac0f`](https://github.com/tauri-apps/plugins-workspace/commit/99d6ac0f9506a6a4a1aa59c728157190a7441af6) ([#1606](https://github.com/tauri-apps/plugins-workspace/pull/1606) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) The JS packages now specify the *minimum* `@tauri-apps/api` version instead of a single exact version.
- [`6de87966`](https://github.com/tauri-apps/plugins-workspace/commit/6de87966ecc00ad9d91c25be452f1f46bd2b7e1f) ([#1597](https://github.com/tauri-apps/plugins-workspace/pull/1597) by [@Legend-Master](https://github.com/tauri-apps/plugins-workspace/../../Legend-Master)) Update to tauri beta.25.

## \[2.0.0-beta.11]

- [`f83b9e98`](https://github.com/tauri-apps/plugins-workspace/commit/f83b9e9813843df19b03b6af1018d848111b2a62) ([#1544](https://github.com/tauri-apps/plugins-workspace/pull/1544) by [@Legend-Master](https://github.com/tauri-apps/plugins-workspace/../../Legend-Master)) On Windows, use a named tempfile with `<app name>-<version>-installer.exe` (or `.msi`) for v2 updater

  **Breaking Change**: `UpdaterBuilder::new` now takes one more argument `app_name: String`

## \[2.0.0-beta.7]

- [`22a17980`](https://github.com/tauri-apps/plugins-workspace/commit/22a17980ff4f6f8c40adb1b8f4ffc6dae2fe7e30) ([#1537](https://github.com/tauri-apps/plugins-workspace/pull/1537) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Update to tauri beta.24.

## \[2.0.0-beta.6]

- [`76daee7a`](https://github.com/tauri-apps/plugins-workspace/commit/76daee7aafece34de3092c86e531cf9eb1138989) ([#1512](https://github.com/tauri-apps/plugins-workspace/pull/1512) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Update to tauri beta.23.

## \[2.0.0-beta.8]

- [`bf29a72b`](https://github.com/tauri-apps/plugins-workspace/commit/bf29a72baaff15214a21989df23081eee84e3b8b) ([#1454](https://github.com/tauri-apps/plugins-workspace/pull/1454) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Fix regression in updater plugin failing to update using `.msi` installer.

## \[2.0.0-beta.5]

- [`9013854f`](https://github.com/tauri-apps/plugins-workspace/commit/9013854f42a49a230b9dbb9d02774765528a923f)([#1382](https://github.com/tauri-apps/plugins-workspace/pull/1382)) Update to tauri beta.22.

## \[2.0.0-beta.4]

- [`430bd6f4`](https://github.com/tauri-apps/plugins-workspace/commit/430bd6f4f379bee5d232ae6b098ae131db7f178a)([#1363](https://github.com/tauri-apps/plugins-workspace/pull/1363)) Update to tauri beta.20.
- [`43224c5d`](https://github.com/tauri-apps/plugins-workspace/commit/43224c5d5cfe2dd676e79ebafe424027c62c51c3)([#1330](https://github.com/tauri-apps/plugins-workspace/pull/1330)) Add `Update.download` and `Update.install` functions to the JavaScript API

## \[2.0.0-beta.3]

- [`bd1ed590`](https://github.com/tauri-apps/plugins-workspace/commit/bd1ed5903ffcce5500310dac1e59e8c67674ef1e)([#1237](https://github.com/tauri-apps/plugins-workspace/pull/1237)) Update to tauri beta.17.

## \[2.0.0-beta.4]

- [`293f363`](https://github.com/tauri-apps/plugins-workspace/commit/293f363c0dccc43e8403729fdc8cc2b4311c2d5b)([#1175](https://github.com/tauri-apps/plugins-workspace/pull/1175)) Add a `on_before_exit` hook for cleanup before spawning the updater on Windows, defaults to `app.cleanup_before_exit` when used through `UpdaterExt`
- [`293f363`](https://github.com/tauri-apps/plugins-workspace/commit/293f363c0dccc43e8403729fdc8cc2b4311c2d5b)([#1175](https://github.com/tauri-apps/plugins-workspace/pull/1175)) **Breaking change:** The `rustls-tls` feature flag is now enabled by default.
- [`e3d41f4`](https://github.com/tauri-apps/plugins-workspace/commit/e3d41f4011bd3ea3ce281bb38bbe31d3709f8e0f)([#1191](https://github.com/tauri-apps/plugins-workspace/pull/1191)) Internally use the webview scoped resources table instead of the app one, so other webviews can't access other webviews resources.
- [`7e2fcc5`](https://github.com/tauri-apps/plugins-workspace/commit/7e2fcc5e74df7c3c718e40f75bfb0eafc7d69d8d)([#1146](https://github.com/tauri-apps/plugins-workspace/pull/1146)) Update dependencies to align with tauri 2.0.0-beta.14.
- [`e3d41f4`](https://github.com/tauri-apps/plugins-workspace/commit/e3d41f4011bd3ea3ce281bb38bbe31d3709f8e0f)([#1191](https://github.com/tauri-apps/plugins-workspace/pull/1191)) Update for tauri 2.0.0-beta.15.

## \[2.0.0-beta.3]

- [`4e37316`](https://github.com/tauri-apps/plugins-workspace/commit/4e37316af0d6532bf9a9bd0e712b5b14b0598285)([#1051](https://github.com/tauri-apps/plugins-workspace/pull/1051)) Fix deserialization of `windows > installerArgs` config field.
- [`4e37316`](https://github.com/tauri-apps/plugins-workspace/commit/4e37316af0d6532bf9a9bd0e712b5b14b0598285)([#1051](https://github.com/tauri-apps/plugins-workspace/pull/1051)) On Windows, fallback to `passive` install mode when not defined in config.
- [`a3b5396`](https://github.com/tauri-apps/plugins-workspace/commit/a3b5396113ca93912274f6890d9ef5b1a409587a)([#1054](https://github.com/tauri-apps/plugins-workspace/pull/1054)) Fix Windows powershell window flashing on update
- [`a04ea2f`](https://github.com/tauri-apps/plugins-workspace/commit/a04ea2f38294d5a3987578283badc8eec87a7752)([#1071](https://github.com/tauri-apps/plugins-workspace/pull/1071)) The global API script is now only added to the binary when the `withGlobalTauri` config is true.

## \[2.0.0-beta.2]

- [`99bea25`](https://github.com/tauri-apps/plugins-workspace/commit/99bea2559c2c0648c2519c50a18cd124dacef57b)([#1005](https://github.com/tauri-apps/plugins-workspace/pull/1005)) Update to tauri beta.8.

## \[2.0.0-beta.1]

- [`569defb`](https://github.com/tauri-apps/plugins-workspace/commit/569defbe9492e38938554bb7bdc1be9151456d21) Update to tauri beta.4.

## \[2.0.0-beta.0]

- [`d198c01`](https://github.com/tauri-apps/plugins-workspace/commit/d198c014863ee260cb0de88a14b7fc4356ef7474)([#862](https://github.com/tauri-apps/plugins-workspace/pull/862)) Update to tauri beta.
- [`0879a87`](https://github.com/tauri-apps/plugins-workspace/commit/0879a87a7ecc83c9e886e6f1412fe253082b8d34)([#899](https://github.com/tauri-apps/plugins-workspace/pull/899)) Fix `Started` event not emitted to JS when downloading update.
- [`8505a75`](https://github.com/tauri-apps/plugins-workspace/commit/8505a756b569d88757ec58e452bfe4814d8107bf)([#907](https://github.com/tauri-apps/plugins-workspace/pull/907)) Add support for specifying proxy to use for checking and downloading updates.

## \[2.0.0-alpha.5]

- [`387c2f9`](https://github.com/tauri-apps/plugins-workspace/commit/387c2f9e0ce4c75c07ffa3fd76391a25b58f5daf)([#802](https://github.com/tauri-apps/plugins-workspace/pull/802)) Update to @tauri-apps/api v2.0.0-alpha.13.
- [`e5f979f`](https://github.com/tauri-apps/plugins-workspace/commit/e5f979f91abbb1775fa048af3219b30ff30ed691)([#818](https://github.com/tauri-apps/plugins-workspace/pull/818)) Fix NSIS updater failing to launch when using `basicUi` mode.

## \[2.0.0-alpha.4]

- [`387c2f9`](https://github.com/tauri-apps/plugins-workspace/commit/387c2f9e0ce4c75c07ffa3fd76391a25b58f5daf)([#802](https://github.com/tauri-apps/plugins-workspace/pull/802)) Update to @tauri-apps/api v2.0.0-alpha.12.

## \[2.0.0-alpha.3]

- [`e438e0a`](https://github.com/tauri-apps/plugins-workspace/commit/e438e0a62d4b430a5159f05f13ecd397dd891a0d)([#676](https://github.com/tauri-apps/plugins-workspace/pull/676)) Update to @tauri-apps/api v2.0.0-alpha.11.

## \[2.0.0-alpha.2]

- [`5c13736`](https://github.com/tauri-apps/plugins-workspace/commit/5c137365c60790e8d4037d449e8237aa3fffdab0)([#673](https://github.com/tauri-apps/plugins-workspace/pull/673)) Update to @tauri-apps/api v2.0.0-alpha.9.

## \[2.0.0-alpha.2]

- [`4e2cef9`](https://github.com/tauri-apps/plugins-workspace/commit/4e2cef9b702bbbb9cf4ee17de50791cb21f1b2a4)([#593](https://github.com/tauri-apps/plugins-workspace/pull/593)) Update to alpha.12.

## \[2.0.0-alpha.1]

- [`d74fc0a`](https://github.com/tauri-apps/plugins-workspace/commit/d74fc0a097996e90a37be8f57d50b7d1f6ca616f)([#555](https://github.com/tauri-apps/plugins-workspace/pull/555)) Update to alpha.11.
- [`4ab90f0`](https://github.com/tauri-apps/plugins-workspace/commit/4ab90f048eab2918344f97dc8e04413a404e392d)([#431](https://github.com/tauri-apps/plugins-workspace/pull/431)) The updater plugin is recieving a few changes to improve consistency and ergonomics of the Rust and JS APIs

## \[2.0.0-alpha.0]

- [`717ae67`](https://github.com/tauri-apps/plugins-workspace/commit/717ae670978feb4492fac1f295998b93f2b9347f)([#371](https://github.com/tauri-apps/plugins-workspace/pull/371)) First v2 alpha release!
