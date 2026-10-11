# macOS MCP release identity

`mcp-release.yml` signs both native macOS MCP matrix builds after compilation and before npm staging. The release uses the desktop workflow's existing `APPLE_CERTIFICATE` (base64 PKCS12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID` secrets. The identity must be a valid Developer ID Application certificate; its exact name or SHA-1 fingerprint selects the imported identity. Signing credentials are used only in the signing step.

`sign-mcp-macos.mjs` imports that identity into a unique temporary keychain with a random password. Only the imported key receives the CI signing access settings. The helper restores the entire original user keychain search list, deletes only its temporary keychain, and removes the PKCS12 material on success, error or handled interruption. Cleanup errors fail the release. Like other process cleanup, this cannot run after SIGKILL or loss of the runner; use disposable CI runners for release signing.

The dedicated identifier is `com.dbx.app.mcp`. Its designated requirement binds the identifier to Apple's anchor, the Developer ID intermediate and Application certificate markers, and the configured Team ID. It follows Apple's Developer ID requirement generation and intentionally contains neither a build hash nor an individual certificate fingerprint. Renewal or rotation to another valid Developer ID Application certificate for the same team preserves that identity; update the configured signing identity when its name or fingerprint changes. A different team requires an explicit identity migration and renewed user authorization.

Signing requires a secure timestamp (`--timestamp`). An unavailable timestamp service, expired signing identity, missing credentials, incorrect team/identifier, weaker designated requirement, or invalid signature blocks publication. There is no ad-hoc fallback. Verification checks all architectures with `--strict` and the expected certificate requirement, as well as the embedded identifier, team, timestamp and designated requirement.

Staging and npm packing must preserve the signed bytes. macOS publishes the verified tarball, with package lifecycle scripts disabled. A rerun downloads and verifies an already-published npm package before accepting it; an older unsigned version must be replaced by a **new package version**, since npm versions are immutable. The MCP standalone repack job runs on macOS so it can verify both architectures before archiving and after extraction. Homebrew uses these archives and their SHA-256 checksums. The other Homebrew update workflow also renders the same formula from the published MCP archive checksums. There are no separate legacy MCP compiler jobs at this revision; any future build leg must use the same signing and verification gates. CLI signing and publication are separate.

The first upgrade from an ad-hoc build can still prompt once. Later builds with this identity can satisfy the earlier build's designated requirement. Custom Keychain ACLs and simultaneous prompts are separate behaviors; this release change does not edit users' keys or access controls. MCP startup already opens storage with secret-key creation disabled, and the standalone installer only replaces the binary/version marker.

## Validation

Run the focused `packages/app-tests/mcpReleaseSigning.test.ts` Vitest file. Its executable security/codesign mocks exercise the helper and the workflow shell blocks, including failures and cleanup; they do not establish that Apple accepted a real signature.

For a native check, use a disposable macOS runner with Xcode command-line tools, Node 22.13+ and **controlled** Developer ID Application credentials supplied through the four environment variables above. Set `TMPDIR` or `RUNNER_TEMP` to a private scratch directory, then run from the checkout:

```sh
bash .github/scripts/test-mcp-signing-macos.sh
```

The bounded probe compiles two distinct inert executables for each architecture, signs them with the production helper, checks the second against the first's requirement, verifies archive preservation, rejects tampering/ad-hoc signatures, and compares the keychain search list before/after. It never executes those binaries or reads any DBX secret-store item. A real Developer ID release and a consenting user's Keychain upgrade check remain separate release validation; no production credentials are required for the Linux regression tests.

## Apple references

- [Requirement Language](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html): build-specific `cdhash`, ad-hoc identity, certificate fields and Team ID.
- [TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html): Keychain tracking of designated requirements, certificate reissuance and secure timestamp validity.
- [Apple Security DRMaker](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/drmaker.cpp): Developer ID requirement generation using Apple's anchor, certificate markers and leaf `subject.OU`.
- [Apple Security requirement dumper](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/reqdumper.cpp): canonical display of certificate existence constraints.
