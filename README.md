# Olymp 1.1.0

Olymp gives each signed-in device a complete local replica of a learner's base. The service stores OPAQUE credentials, device sessions, encrypted manifests and encrypted attachment chunks in SQLite. The embedded account page lets a learner register with a login name and password, sign in, see each session's last confirmed revision and sign out.

## Run locally

From this repository, with Rust/Cargo 1.91.1 or compatible:

```sh
cargo run --locked --bin olymp
```

Open **http://127.0.0.1:8787/**. The default data directory is `./olymp-data`. To change the location or listening address:

```sh
OLYMP_DATA=./learner-data OLYMP_LISTEN=127.0.0.1:9797 cargo run --locked --bin olymp
```

For deployment, `cargo build --locked --release --bin olymp` produces a standalone executable with embedded browser assets. Run a single service against a private persistent data directory. Terminate HTTPS at a reverse proxy. Back up the SQLite database using a consistent SQLite backup and preserve the matching `opaque-setup-v1` file. For a browser app on another origin, proxy its `/v1/` path to the service with the path preserved. For example, Vite's `server.proxy` can map `"/v1"` to `"http://127.0.0.1:8787"`.

On a dedicated Ubuntu 24.04 VPS, run `sudo bash deploy/ubuntu.sh gestalter.koljasam.com` from the checkout. The script builds Olymp, installs its systemd unit, and replaces `/etc/caddy/Caddyfile` with a single-site configuration. Service data lives in `/var/lib/olymp`. Rerun the script from an updated checkout to deploy a new build. Point the domain's A record at the VPS and allow inbound TCP ports 80 and 443 so Caddy can provision HTTPS.

## Integrate a client

Pin the [1.1.0 protocol](protocol/1.1.0.md) or install the vendored npm archive into a consumer repo and commit its package lock. The archive contains the ES modules, OPAQUE WASM and sodium runtime. No registry publication or product repository is required.

```sh
# From an adjacent consumer repository, verify the pin, then install it.
(cd ../thia-olymp && sha256sum -c release/SHA256SUMS)
mkdir -p vendor
cp ../thia-olymp/release/thia-olymp-1.1.0.tgz vendor/
npm install --save-exact ./vendor/thia-olymp-1.1.0.tgz
```

Use a current browser with WebCrypto, WebAssembly, IndexedDB, Web Locks and the Uint8Array base64/hex methods. Serve the WASM beside its generated JS, or pass WASM bytes via the optional `wasm` sign-in field. A browser example:

```js
import { signIn, Replica, entries, request } from "@thia/olymp";
import { browserStore, remembered } from "@thia/olymp/browser";

// The app supplies these values from its form. signup=true enrolls then signs in.
const session = await signIn("", { name, password, device: "Study · desktop", signup });
await remembered.save(session);
const replica = new Replica(session, browserStore(session));
replica.start();

await replica.put("notes/123", { text: "First observation" }, [imageBytes]);
const records = entries(await replica.records());
const note = records.find(r => r.key === "notes/123").versions[0];
const image = await replica.attachment(note.files[0]);
await replica.put("notes/123", { text: "Revised" }, [], { observed: note.ids, files: note.files });
const status = await replica.syncStatus();
```

`put` replaces the entire record and its attachment list; `files` reuses existing references and new byte arrays append files. `remove(key, observedIds)` creates a replicated deletion. Groups with multiple versions require resolution by the caller. Preserve concurrent delete/edit alternatives. On app launch, read `remembered.read()`, open that session's scoped store and call `start()`. It syncs immediately, after commits, on the browser's online event and every five seconds while running. Poll `syncStatus()` for display. `sync()` explicitly waits for a completed round or rejects with the failure. On sign-out, revoke with `request(session.origin,"logout",{method:"POST",session})`, call `replica.close()`, clear `remembered.clear(session)` and release references to the unlocked session. A 401 also permits local session removal. Use the session-change notification to close stale views in other tabs. Store the active session only when persistence is desired.

For signed-out local work, allocate a fresh profile with `createLocal()`, persist its random ID in the app's active profile selection, and use a Replica with that session and browserStore without starting network sync. Reopen with `resumeLocal(id)`. When the learner chooses to include that profile on sign-in, close the editor and call `adoptLocal({session: local, store: browserStore(local)}, session, browserStore(session))`. It binds the source to one account, re-encrypts its attachments and preserves operation IDs. If interrupted, use `resumeLocal(id, session)` and retry the adoption. Forget the active guest ID after success. Create a fresh guest for subsequent signed-out use. An account switch always opens the selected account's separate replica.

Use the exported `recordKey(record)` for thia-gestalts records. Pass an ordered list of note image bytes matching the attachment references. Use `writeBatch(prepare)` to commit related records together. See the application mapping in the protocol.

Native clients may implement the wire protocol directly. A custom JS store supplies `scope = JSON.stringify([origin, accountId])`, `lock(asyncFunction)`, `state()/save(state)` and `chunk(id)/saveChunk(id,bytes)`. Use an exclusive lock across all writers and synchronizers of that scope. A missing value returns undefined. Manifest replacement must be atomic, and writes must be durable when resolved. Store encrypted bytes unchanged. Allocate protected app-local storage for the manifest, which contains decrypted records. The browser binding stores the non-extractable local HKDF key and session in IndexedDB. A client with missing or evicted storage must download and verify its replica again.

## Verification and maintenance

Run `npm test` from this checkout with Node 26 and Cargo to build the service and exercise two independent persistent client implementations over HTTP. [Verification results](VERIFICATION.md) record the observed outcomes and environment limits.

The OPAQUE profile and WASM PasswordExchange were extracted from the gestalts account and WASM crates. The server retains its two-stage challenge, credential verification and hashed-session flow. The root-key wrapping follows the account worker. Manifest and chunk protection use the personal crypto worker's libsodium XChaCha20-Poly1305-IETF primitive. The snapshot CAS now publishes an encrypted record manifest with independently staged chunks. The vendored sodium ES modules are libsodium-sumo and libsodium-wrappers-sumo 0.8.4, with the wrapper's module import adjusted to a sibling file. Their licenses are in web/sodium.

To regenerate the shipped OPAQUE bindings, install the wasm32-unknown-unknown Rust target and wasm-bindgen CLI 0.2.130. From the checkout:

```sh
cargo build --locked --release -p olymp-account --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir web/opaque --out-name opaque target/wasm32-unknown-unknown/release/olymp_account.wasm
```
