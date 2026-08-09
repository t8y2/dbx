# DBX plugin signing model

DBX plugin signing v1 uses one signature owned by the repository that distributes the package. It does not require every plugin author to maintain a private signing key.

## Trust boundary

The official flow is:

1. The plugin author publishes source and unsigned `.dbxp` candidates.
2. DBX Store reviews the source, Manifest, permissions, candidate hashes, and release metadata.
3. A protected store workflow signs the approved candidate with the DBX Store repository key.
4. The catalog references the final signed artifact, SHA-256, size, and `signingKeyId`.
5. DBX verifies the catalog metadata, package checksums, repository signature, Manifest identity, version, publisher, and permissions before activation.

The `publisher` field records authorship and catalog ownership. It is not a signing-key owner. The repository signature proves that the repository approved and published the exact installed bytes; it does not replace code review or sandbox native code.

## Official and custom repositories

- The official repository key is controlled by DBX Store and its public key is shipped with DBX.
- A custom or private repository controls one or more repository keys and distributes the public keys to its users through an independent trusted channel.
- Plugin authors do not need `dbx-plugin keygen` for official submissions.
- `dbx-plugin keygen` exists only for operators of custom or private repositories.
- Unsigned packages are accepted only through the explicit local-development installation option.

## Key rotation

`signingKeyId` identifies a repository key and supports rotation. A key ID must never be reused for different public-key bytes. Rotation adds a new key ID, ships the new public key to clients, begins signing with the new key, and later revokes the old key after supported clients have updated.

## Why there is no author signature in v1

Author identity is currently established through the source repository, account ownership, submission history, review records, and the catalog publisher record. Adding a second cryptographic author signature would introduce author key recovery, rotation, revocation, organization transfer, and historical verification requirements without improving the repository-to-user integrity path needed for v1.

A future author-attestation layer is optional, not inevitable. If commercial distribution or stronger supply-chain provenance requires it, add a separate author attestation with its own schema and trust policy while retaining the repository signature. Do not overload the existing `signature.json` or reinterpret `signingKeyId` as an author identity.
