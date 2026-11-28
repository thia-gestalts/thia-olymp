import { connectedFetch } from "./http.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { png } from "./image.js";
import { DatabaseSync } from "node:sqlite";
import {
  signIn,
  request,
  Replica,
  adoptLocal,
  entries,
  HttpError,
} from "../web/client.js";
import { Peer } from "./peer.js";

async function disk(root, session) {
  const dir = join(root, session.account.id);
  await mkdir(dir, { recursive: true });
  const read = async (id) =>
    readFile(join(dir, id)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  const write = async (id, data) => {
    await writeFile(join(dir, id + ".tmp"), data);
    await rename(join(dir, id + ".tmp"), join(dir, id));
  };
  let tail = Promise.resolve();
  return {
    scope: JSON.stringify([session.origin, session.account.id]),
    lock: (f) => {
      const next = tail.then(f);
      tail = next.catch(() => {});
      return next;
    },
    state: async () => JSON.parse((await read("manifest")) ?? "null"),
    save: (s) => write("manifest", JSON.stringify(s)),
    chunk: read,
    saveChunk: write,
  };
}

test("Olymp v1 interoperation, durability and isolation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "olymp-proof-")),
    data = join(dir, "service");
  const server = spawn(
    "sh",
    ["-c", "exec target/debug/olymp --connected-stdin <&3"],
    {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OLYMP_LISTEN: "127.0.0.1:0",
        OLYMP_DATA: data,
        OLYMP_SIGNUP: "open",
      },
    },
  );
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await once(server, "exit");
    }
    await rm(dir, { recursive: true, force: true });
  });
  const logs = [];
  server.stdout.on("data", (b) => logs.push(b));
  server.stderr.on("data", (b) => logs.push(b));
  await Promise.race([
    once(server.stdout, "data"),
    once(server, "exit").then(() => {
      throw Error("Service exited before startup");
    }),
  ]);
  const origin = "http://olymp.local";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = connectedFetch(server.stdio[3]);
  t.after(() => (globalThis.fetch = originalFetch));
  const wasm = await readFile(
    new URL("../web/opaque/opaque_bg.wasm", import.meta.url),
  );
  for (const path of [
    "/",
    "/ui.js",
    "/browser.js",
    "/client.js",
    "/sodium/libsodium-wrappers.mjs",
    "/sodium/libsodium-sumo.mjs",
    "/opaque/opaque.js",
    "/opaque/opaque_bg.wasm",
  ]) {
    assert.equal((await fetch(origin + path)).status, 200);
  }
  const roots = [];
  const importKey = crypto.subtle.importKey.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "importKey", (...args) => {
    if (args[0] === "raw" && args[2] === "HKDF" && args[1].length === 32)
      roots.push(Buffer.from(args[1]));
    return importKey(...args);
  });
  const name = "Replica.Proof",
    password = "secret-password-marker-7751";
  const login = (device, options) =>
    signIn(origin, { name, password, wasm, device, ...options });
  const a = await login("desktop", { signup: true }),
    b = await login("phone");
  await assert.rejects(login("wrong", { password: "incorrect" }));
  await assert.rejects(login("duplicate", { signup: true }), { status: 409 });
  let store = await disk(join(dir, "desktop"), a);
  let desktop = new Replica(a, store);
  const phone = new Peer(join(dir, "phone.db"), b);
  t.after(() => phone.db.close());
  const other = await login("other", { name: "another", signup: true });
  const otherStore = await disk(join(dir, "desktop"), other);
  const guest = {
    origin: "local:",
    account: { id: crypto.randomUUID() },
    key: await crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      "HKDF",
      false,
      ["deriveBits"],
    ),
  };
  const guestStore = await disk(join(dir, "desktop"), guest);
  const guestReplica = new Replica(guest, guestStore);
  await assert.rejects(guestReplica.writeBatch(() => [
    { key: "skill", value: { kind: "skill" } },
    { key: "event", value: {}, attachments: ["invalid attachment"] },
  ]), /Expected attachment bytes/);
  assert.deepEqual(await guestReplica.records(), []);
  await guestReplica.put("local-note", "signed-out work", [
    Buffer.from("guest image"),
  ]);
  await adoptLocal({ session: guest, store: guestStore }, a, store);
  await adoptLocal({ session: guest, store: guestStore }, a, store);
  await assert.rejects(
    adoptLocal({ session: guest, store: guestStore }, other, otherStore),
  );
  await desktop.put("same", "before");
  await desktop.put("delete-edit", "before");
  await desktop.put("fields", { title: "initial", score: 0 });
  await desktop.put("removed", "before");
  await desktop.sync();
  await phone.sync();
  await desktop.put("same", "desktop");
  await desktop.remove("delete-edit");
  await desktop.remove("removed");
  await desktop.put("fields", { title: "edited", score: 0 });
  await phone.change("fields", { title: "initial", score: 1 });
  await phone.change("same", "phone");
  await phone.change("delete-edit", "phone edit");
  await phone.change("event:unique-11", {
    kind: "unknown.education",
    value: "private-practice-marker",
  });
  const image = png(1024, 683),
    phoneImage = png(320, 240);
  await phone.change("photo/phone", { kind: "future.phone" }, phoneImage);
  await desktop.put("event:lesson-8", { kind: "browser.practice" });
  await phone.change("ref:algebra", { name: "algebra" });
  await desktop.put("ref:algebra", { name: "algebra" });
  await desktop.put(
    "inbox/photo",
    { kind: "unknown.inbox", title: "private-photo-marker" },
    [image],
  );
  let uploads = 0;
  desktop.close();
  desktop = new Replica(a, store, async (o, p, opts) => {
    if (p.startsWith("chunks/") && opts.method === "PUT" && ++uploads === 3)
      throw Error("transfer interrupted");
    return request(o, p, opts);
  });
  await assert.rejects(desktop.sync(), /interrupted/);
  assert.equal(desktop.status, "Sync incomplete");
  assert.equal((await store.state()).pending, true);
  desktop.close();
  store = await disk(join(dir, "desktop"), a);
  let retryUploads = 0,
    lost = true;
  desktop = new Replica(a, store, async (o, p, opts) => {
    if (p.startsWith("chunks/") && opts.method === "PUT") retryUploads++;
    const result = await request(o, p, opts);
    if (p === "base" && opts.method === "PUT" && lost) {
      lost = false;
      throw Error("reply lost");
    }
    return result;
  });
  await Promise.all([
    assert.rejects(desktop.sync(), /reply lost/),
    phone.sync(),
  ]);
  await desktop.sync();
  await phone.sync();
  await desktop.sync();
  assert.equal(retryUploads, 7);
  const heads = await desktop.records();
  assert.deepEqual(
    entries(heads).find((h) => h.key === "fields").versions[0].value,
    { title: "edited", score: 1 },
  );
  const ref = entries(heads).find((h) => h.key === "ref:algebra");
  assert.equal(ref.versions.length, 1);
  assert.equal(ref.versions[0].ids.length, 2);
  assert.deepEqual(heads, phone.state().heads);
  assert.deepEqual(
    heads
      .filter((h) => h.key === "same")
      .map((h) => h.value)
      .sort(),
    ["desktop", "phone"],
  );
  assert.deepEqual(
    heads
      .filter((h) => h.key === "delete-edit")
      .map((h) => h.deleted)
      .sort(),
    [false, true],
  );
  assert.deepEqual(
    heads.filter((h) => h.key === "removed").map((h) => h.deleted),
    [true],
  );
  const refs = heads.find((h) => h.key === "inbox/photo").files[0];
  assert.deepEqual(await phone.file(refs), image);
  const fresh = await login("replacement");
  const freshStore = await disk(join(dir, "replacement"), fresh);
  let reads = 0;
  const replacement = new Replica(fresh, freshStore, async (o, p, opts) => {
    if (p.startsWith("chunks/") && ++reads === 3)
      throw Error("download interrupted");
    return request(o, p, opts);
  });
  await assert.rejects(replacement.sync(), /interrupted/);
  assert.equal(replacement.status, "Sync incomplete");
  assert.equal(
    (await request(origin, "devices", { session: a })).find(
      (x) => x.device === "replacement",
    ).confirmed,
    null,
  );
  replacement.start(40);
  for (
    let i = 0;
    i < 100 && !replacement.status.startsWith("Fully synced");
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.match(replacement.status, /Fully synced/);
  assert.deepEqual(await replacement.records(), heads);
  assert.deepEqual(Buffer.from(await replacement.attachment(refs)), image);
  replacement.close();
  const foreign = new Replica(other, otherStore);
  await foreign.sync();
  assert.deepEqual(await foreign.records(), []);
  assert.throws(() => new Replica(other, store), /mismatch/);
  await assert.rejects(
    request(origin, "base", { session: { ...other, account: a.account } }),
    { status: 403 },
  );
  await assert.rejects(
    request(origin, "chunks/" + refs[0], { session: other }),
    { status: 404 },
  );
  const db = new DatabaseSync(join(data, "olymp.db"));
  t.after(() => db.close());
  const size = db
    .prepare("SELECT sum(length(bytes)) total FROM chunks")
    .get().total;
  const phoneRefs = heads.find((h) => h.key === "photo/phone").files[0];
  assert.deepEqual(
    Buffer.from(await desktop.attachment(phoneRefs)),
    phoneImage,
  );
  const saved = await request(origin, "base", { session: a });
  await assert.rejects(
    request(origin, "base", {
      method: "PUT",
      session: a,
      json: { ...saved, revision: saved.revision - 1, chunks: [] },
    }),
    { status: 409 },
  );
  // The service no longer caps chunk size or account storage.
  const large = new Uint8Array(5 * 1024 * 1024).fill(7);
  const largeId = Buffer.from(
    await crypto.subtle.digest("SHA-256", large),
  ).toString("hex");
  await request(origin, "chunks/" + largeId, {
    method: "PUT",
    session: a,
    binary: large,
  });
  const cost = db
    .prepare("SELECT length(envelope) size FROM bases WHERE account=?")
    .get(a.account.id).size;
  t.diagnostic(
    "Stored encrypted chunks " +
      size +
      " bytes, manifest " +
      cost +
      " base64 bytes. Image retry uploaded " +
      retryUploads +
      " of 9 chunks.",
  );
  // Compare metadata-only transport with embedding all local images as base64.
  let transferred = 0;
  const measured = new Replica(a, store, (o, p, opts) => {
    if (p.startsWith("chunks/")) transferred++;
    return request(o, p, opts);
  });
  await measured.put("event:lesson-8", { kind: "browser.practice", score: 1 });
  assert.equal(await desktop.syncStatus(), "Pending");
  await measured.sync();
  assert.equal(await desktop.syncStatus(), "Awaiting confirmation");
  assert.equal(transferred, 0);
  await phone.sync();
  const measuredHeads = await measured.records();
  const quota = new Replica(a, store, async (o, p, opts) => {
    if (p === "base" && opts.method === "PUT")
      throw new HttpError(413, "Payload too large");
    return request(o, p, opts);
  });
  await quota.put("quota-proof", "kept");
  await assert.rejects(quota.sync(), { status: 413 });
  assert.equal(quota.status, "Storage limit reached");
  assert.equal((await store.state()).pending, true);
  await measured.sync();
  await phone.sync();
  // A local write while a round waits on the service neither blocks nor gets lost.
  let release;
  const held = new Promise((r) => (release = r));
  const slow = new Replica(a, store, async (o, p, opts) => {
    if (p === "base" && !opts.method) await held;
    return request(o, p, opts);
  });
  const round = slow.sync();
  await new Promise((r) => setTimeout(r, 20));
  await slow.put("during-sync", "written");
  release();
  await round;
  assert.equal(slow.status, "Pending");
  assert.equal((await store.state()).pending, true);
  await slow.sync();
  assert.equal((await store.state()).pending, false);
  await phone.sync();
  assert.ok(phone.state().heads.some((h) => h.key === "during-sync"));
  const inline = Buffer.byteLength(
    JSON.stringify({
      heads: measuredHeads,
      images: [image.toString("base64"), phoneImage.toString("base64")],
    }),
  );
  t.diagnostic(
    "Metadata edit: " +
      transferred +
      " chunk transfers; inline JSON candidate " +
      inline +
      " bytes before encryption.",
  );
  // Actual service storage loss, retaining account enrollment and OPAQUE setup.
  db.exec("BEGIN; DELETE FROM bases; DELETE FROM chunks; COMMIT");
  await desktop.sync();
  const restored = new Peer(join(dir, "restored.db"), await login("restored"));
  t.after(() => restored.db.close());
  await restored.sync();
  assert.deepEqual(restored.state(), phone.state());
  assert.deepEqual(await restored.file(refs), image);
  assert.deepEqual(await restored.file(phoneRefs), phoneImage);
  const packed = await Promise.all(
    (await readdir(data)).map((p) => readFile(join(data, p))),
  );
  const contentKey = Buffer.from(await phone.key());
  assert.ok(roots.length >= 4);
  assert.deepEqual(roots[0], roots[1]);
  for (const buf of [...packed, ...logs])
    for (const sample of [
      ...roots,
      ...roots.map((b) => b.toString("base64")),
      contentKey,
      contentKey.toString("base64"),
      password,
      "private-photo-marker",
      "image-marker-8695",
      "private-practice-marker",
      a.token,
    ])
      assert.equal(buf.includes(sample), false);
  await request(origin, "logout", { session: a, method: "POST" });
  await assert.rejects(desktop.sync(), { status: 401 });
  await phone.sync();
});
