# Olymp 1.0.0 verification

Run from the repository root on Linux. Observed with rustc/cargo 1.91.1, Node 26.12.0 and Firefox 159.0. The integration suite creates a temporary service database, an atomic-file SDK store, an independently implemented SQLite peer and empty replacement stores. The peer shares OPAQUE sign-in and the cryptographic library with the SDK. It implements the HTTP exchange, chunk framing, persistence and manifest reconciliation separately in `tests/peer.js`.

## Build and protocol proof

```sh
cargo fmt --all --check
cargo clippy --locked --offline --workspace --all-targets -- -D warnings
cargo build --release --locked --offline --bin olymp
npm test
```

Formatting, Clippy and the optimized service build exited 0. The npm command built the locked debug service and ran `node tests/integration.test.js`. Observed output:

```text
✔ Olymp v1 interoperation, durability and isolation
ℹ Stored encrypted chunks 2330878 bytes, manifest 3804 base64 bytes. Image retry uploaded 7 of 9 chunks.
ℹ Metadata edit: 0 chunk transfers; inline JSON candidate 3109999 bytes before encryption.
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

| Exercise | Observed result |
|---|---|
| Enroll, unlock, switch | A second session unlocked the same base. Wrong password failed, duplicate enrollment returned 409, logout revoked only its session. A second account on the same local device started empty. Mismatched account header returned 403 and a foreign chunk returned 404. |
| Local work before signup | Adoption imported a signed-out record and attachment, survived a repeat adoption and rejected adoption by another account. |
| Offline, concurrent and retry | Independent clients added practice events and PNG records offline. Separate field edits composed. Identical name-keyed references coalesced. Same-record edits and concurrent delete/edit retained both versions. An uncontested deletion stayed deleted. A stale CAS returned 409. A lost successful publication response produced no duplicate operation. |
| Image interruption | The transfer stopped after two of nine chunks. The manifest remained pending on disk. A reopened file store uploaded the remaining seven. An interrupted replacement download left its session confirmation null. Automatic retry completed and its local image matched the source byte-for-byte. |
| Transport decision | The fixture contained real 1024×683 and 320×240 RGB PNGs, a small signed-out attachment and mixed JSON payloads. Editing record metadata transferred zero chunks. Embedding the two images in a JSON snapshot would have required 3,109,999 bytes before envelope encryption. |
| Quota | Limits removed for personal testing: a 5 MiB chunk is accepted. A simulated 413 still surfaced the storage-limit status, retained the pending write, then reconciled successfully on retry. |
| Full recovery | The test transactionally deleted **all** server manifests and chunks while retaining accounts, sessions and OPAQUE setup. A complete surviving replica repopulated the service. A new empty SQLite peer recovered the same manifest, including tombstone IDs, and both original PNGs. |
| Ciphertext inspection | The test scanned service files (SQLite, WAL and setup) and captured stdout/stderr. It found none of the sampled password, raw/base64 root and content keys, live bearer token, image marker or plaintext record markers. The wire implementation separately authenticates the account and revision or chunk context. |

## Browser acceptance

```sh
OLYMP_PLAYWRIGHT="$PWD/../../gestalts/node_modules/.pnpm/playwright-core@1.65.0/node_modules/playwright-core/index.mjs" timeout 65 node tests/browser.mjs
```

This verification machine supplied its existing Playwright installation via the environment variable. With Playwright and its Firefox binary installed locally, the equivalent command is `node tests/browser.mjs`. The test exercised the embedded page, WASM, WebCrypto, IndexedDB and Web Locks in Firefox. Observed output:

```text
Firefox 159.0: registration, device list, durable IndexedDB records and bytes, reload, logout and account switch passed.
```

## Consumer pin

```sh
npm_config_cache=/tmp/olymp-npm-cache npm pack --pack-destination release
sha256sum release/thia-olymp-1.0.0.tgz protocol/1.0.0.md > release/SHA256SUMS
sha256sum -c release/SHA256SUMS
```

The archive contained 13 files. Both checksums verified. The archive SHA-256 was `3807aa5e46440d87f3ab8ac4506166eae9019a752870cb51af87371b56f1d217`.

The following commands installed that exact archive into an empty consumer directory and ran the same interoperation test using the installed exports, WASM and sodium modules. The working directory remained the Olymp checkout so the test could launch the service executable.

```sh
olymp_consumer=$(mktemp -d)
npm_config_cache=/tmp/olymp-npm-cache npm install --prefix "$olymp_consumer" --offline --no-audit --no-fund "$PWD/release/thia-olymp-1.0.0.tgz"
cp -r tests "$olymp_consumer/"
sed -i 's|"../web/client.js"|"@thia/olymp"|;s|new URL("../web/opaque/opaque_bg.wasm", import.meta.url)|new URL(import.meta.resolve("@thia/olymp/opaque.wasm"))|' "$olymp_consumer/tests/integration.test.js"
sed -i 's|../web/sodium/|../node_modules/@thia/olymp/web/sodium/|' "$olymp_consumer/tests/peer.js"
node "$olymp_consumer/tests/integration.test.js"
```

npm installed one package offline. The installed-client run passed all assertions and reported the same transfer counts. Node emitted an ES module autodetection warning for the copied test in the temporary consumer directory.

## Local listener verification limit

```sh
OLYMP_DATA=$(mktemp -d) cargo run --locked --bin olymp
```

The executable started and the sandbox rejected TCP bind with OS error 1, `Operation not permitted`. Port escalation was unavailable here. The passing tests carried real HTTP/1.1 requests, binary responses and status codes over an inherited Unix stream into the same service router. The Firefox driver forwarded the browser's requests to that stream. The normal loopback listener remains unverified on this machine. The local service command and URL are in the README.
