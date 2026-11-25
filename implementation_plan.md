# Olymp implementation plan

## Integrated product checkpoint · 2026-11-25

The Linux acceptance run used the TCP Olymp service, the built vizint rounding page in Chromium, and the extracted Gestalter Debian application with Electron IPC and bundled Python/SQLite. Playwright supplied credentials, answered the activity and selected a PNG in the note editor. Reads of the manifests, attachment bytes and device confirmations were assertions. All writes and retries went through the applications.

| Tested implementation | Git revision |
|---|---|
| Olymp service, 1.1.0 SDK and acceptance test | `35fbb66e284caa1e93c56ad6863b2c233b81fe6a` |
| vizint | `90f5cf48d7b79a79e166f6274910c6d1d4c48906` |
| Gestalter desktop | `d037aabf5d701dee1305a7fcd61b05f36ff0a84a` |

Both consumers vendor the 1.1.0 archive with SHA-256 `4266f2c8533f31e2b440879b96615abfefd3fc850ad85e3234c58dbc8b443c14`. Their builds verify the digest before extracting the browser runtime. The [1.1.0 contract](protocol/1.1.0.md) defines the typed record key and the correspondence between note attachment references and ordered files. The SDK commits related records in one manifest write. It compares JSON values independently of object member order and checks the durable revision before reporting a previous confirmation. HTTP and encryption remain compatible with v1.

| Exercise | Observed result |
|---|---|
| Round while disconnected, reconnect, lose the successful PUT response | The open Recent practice route updated automatically. The SQLite replica contained the original learning-event ID once, and the single skill row displayed the original UTC timestamp. Both devices confirmed revision 1. |
| Attach a four-chunk PNG on desktop, interrupt vizint after one chunk | Desktop confirmed revision 3. Vizint retained its previous readable manifest and its earlier confirmation. |
| Restart vizint, retry automatically, disconnect again | Vizint fetched the other three chunks. Its complete note and all 936,914 original image bytes were readable offline. |
| Restart desktop and compare | Both persisted manifests agreed, including heads, attachment order and superseded operation IDs. Both had pending=false. Both sessions reported revision 3 on the service. The reopened desktop editor read the same bytes from SQLite. |
| Sign out | Vizint reopened its prior guest practice. Desktop reopened its empty guest workspace. |

### Reproduce

From the respective checkouts, using Node 26, Cargo 1.91.1, and the desktop project's locked Playwright and Chromium installation:

```sh
# vizint
npm run build
# gestalter-desktop
npm ci
npm run package:linux
npm test
npm run test:package:storage
# thia-olymp
sha256sum -c release/SHA256SUMS
cargo build --locked --offline
npm test
xvfb-run -a node tests/products.mjs
```

Each checkout also built from an isolated source copy. Olymp passed `cargo build --locked --offline && npm test`. Vizint passed `npm run build` without a dependency install. Desktop passed `npm ci --offline --no-audit --no-fund && npm run build` using the host's populated npm cache.

The [cross-product test](tests/products.mjs) defaults to the desktop development executable and adjacent product directories. Set `VIZINT_ROOT` and `GESTALTER_ROOT` to use other checkouts. For an installed desktop package, set `GESTALTER_TEST_LAUNCHER=/usr/bin/gestalter`. The harness starts both servers on temporary loopback ports, allocates its own data directories, interrupts HTTP responses and restarts the client processes.

On this host we ran the extracted package with Electron's Chromium sandbox enabled using the host's installed, root-owned Chromium helper. Reproduce from Olymp:

```sh
stage=$(mktemp -d)
dpkg-deb -x ../gestalter-desktop/release/gestalter-desktop_0.1.0_amd64.deb "$stage"
mv "$stage/opt/gestalter/chrome-sandbox" "$stage/opt/gestalter/chrome-sandbox.unprivileged"
ln -s /opt/google/chrome/chrome-sandbox "$stage/opt/gestalter/chrome-sandbox"
GESTALTER_TEST_LAUNCHER="$stage/usr/bin/gestalter" xvfb-run -a node tests/products.mjs
```

The package SHA-256 was `73c86b6b660016ac824829bae2ba03122711dcaee2a5063f90277a4a47a18d04`. The final cross-app run set the development Python command to an unavailable path and passed using the bundled interpreter. Clean system installation, a production HTTPS deployment, mobile interoperability and visual review remain open. The existing [protocol verification](VERIFICATION.md) covers CAS conflicts, account isolation, quota and recovery from service storage loss.

## Original implementation scope

Olymp owns the versioned sync and sign-in interfaces. Publish the protocol, examples and any reusable client bindings from here. Consumers pin a release. Treat payloads as opaque to the server and preserve unknown client record kinds. The service can be implemented and exercised without any product repo or shared schema runtime.

1. Extract the relevant behavior from the current gestalts repo: `crates/account`, `web/server/src/auth.rs`, `packages/client/src/account.worker.ts` and the personal crypto worker. Preserve the reviewed protocol/library primitives, password-based unlock and device session semantics. Adapt the identifier to an email-free login. Test correct/wrong credentials, fresh devices and sign-out/account switching.
2. Start from the existing revision-checked encrypted snapshot in `web/server/src/personal_sync.rs`. Specify local base revision, pending writes, tombstones, and attachment transfer. Choose snapshot or incremental transport against a representative image-heavy base before freezing the wire format. Preserve pending local changes across a failed upload or process exit.
3. Define reconciliation once. Union independent events by ID, coalesce name-keyed references, merge independent changes and retain both versions of a genuinely conflicting edit. Exercise concurrent delete/edit explicitly. Never drop unknown academic or inbox payloads on a round trip.
4. Provide a client integration for persistent local storage, unlock, background catch-up when running, retry and observable status. Scope tokens, keys and local replicas to the account. Define first sign-in with local work and test on previously used devices so one learner’s data cannot enter another account.
5. Build the minimal account frontend and deployment. Run the same scenario across independently implemented clients: offline edits, interruption during image transfer, reconnect, download on a fresh device, compare whole bases. Verify server storage and logs lack plaintext records, attachments, passwords and unlock keys. Test recovery from a surviving replica separately from an ordinary empty new-client download.
