// Second implementation of the v1 replication protocol. Shares only sign-in
// with the SDK. Stores its own manifest and raw ciphertext in SQLite.
import sodium from "../web/sodium/libsodium-wrappers.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export class Peer {
  constructor(path, session) {
    this.s = session;
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS state(account TEXT PRIMARY KEY, body TEXT); CREATE TABLE IF NOT EXISTS data(account TEXT,id TEXT,body BLOB,PRIMARY KEY(account,id))",
    );
    this.id = session.account.id;
  }
  state() {
    const row = this.db
      .prepare("SELECT body FROM state WHERE account=?")
      .get(this.id);
    return row ? JSON.parse(row.body) : { heads: [], removed: [] };
  }
  save(base) {
    this.db
      .prepare("INSERT OR REPLACE INTO state VALUES(?,?)")
      .run(this.id, JSON.stringify(base));
  }
  async change(key, value, file) {
    const base = this.state(),
      files = [];
    if (file) {
      const parts = [];
      for (let start = 0; start < file.length; start += 262144) {
        const wire = await this.encrypt(
          ["chunk"],
          file.subarray(start, start + 262144),
        );
        const id = createHash("sha256").update(wire).digest("hex");
        this.saveBytes(id, wire);
        parts.push(id);
      }
      files.push(parts);
    }
    const parents = base.heads.filter((x) => x.key === key);
    let delta = {};
    const prev = parents[0];
    if (
      parents.length === 1 &&
      prev.value &&
      value &&
      [prev.value, value].every(
        (v) => typeof v === "object" && !Array.isArray(v),
      )
    ) {
      const fields = [
        ...new Set(Object.keys(prev.value).concat(Object.keys(value))),
      ].filter(
        (k) => JSON.stringify(prev.value[k]) !== JSON.stringify(value[k]),
      );
      delta = {
        edit: {
          from: prev.id,
          fields,
          files: JSON.stringify(files) !== JSON.stringify(prev.files),
        },
      };
    }
    base.removed.push(...parents.map((x) => x.id));
    base.heads = base.heads.filter((x) => x.key !== key);
    base.heads.push({
      key,
      id: randomUUID(),
      value,
      files,
      deleted: false,
      ...delta,
    });
    this.save(base);
  }
  saveBytes(id, wire) {
    this.db
      .prepare("INSERT OR REPLACE INTO data VALUES(?,?,?)")
      .run(this.id, id, wire);
  }
  async key() {
    await sodium.ready;
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: Buffer.alloc(0),
          info: Buffer.from("olymp-content-v1"),
        },
        this.s.key,
        256,
      ),
    );
  }
  context(parts) {
    return Buffer.from(JSON.stringify(["olymp", 1, this.id, ...parts]));
  }
  async encrypt(parts, data) {
    const nonce = randomBytes(24);
    return Buffer.concat([
      nonce,
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        data,
        this.context(parts),
        null,
        nonce,
        await this.key(),
      ),
    ]);
  }
  async decrypt(parts, wire) {
    return Buffer.from(
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        wire.subarray(24),
        this.context(parts),
        wire.subarray(0, 24),
        await this.key(),
      ),
    );
  }
  async http(path, method = "GET", body) {
    const headers = {
      Authorization: "Bearer " + this.s.token,
      "X-Olymp-Account": this.id,
    };
    if (body && !Buffer.isBuffer(body)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const res = await fetch(this.s.origin + "/v1/" + path, {
      method,
      body,
      headers,
    });
    if (!res.ok)
      throw Object.assign(Error("peer HTTP " + res.status), {
        status: res.status,
      });
    if (res.status === 204) return;
    return path.startsWith("chunks/")
      ? Buffer.from(await res.arrayBuffer())
      : res.json();
  }
  async sync() {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await this.round();
      } catch (e) {
        if (e.status !== 409) throw e;
      }
    }
    throw Error("Busy base");
  }
  async round() {
    const snapshot = await this.http("base");
    let rev = snapshot.revision;
    const remote = rev
      ? JSON.parse(
          await this.decrypt(
            ["manifest", rev],
            Buffer.from(snapshot.envelope, "base64"),
          ),
        )
      : { heads: [], removed: [] };
    const local = this.state();
    const removed = [...new Set([...remote.removed, ...local.removed])].sort();
    const live = new Map();
    for (const h of remote.heads.concat(local.heads))
      if (!removed.includes(h.id)) live.set(h.id, h);
    const base = {
      heads: [...live.keys()].sort().map((k) => live.get(k)),
      removed,
    };
    const ids = [...new Set(base.heads.flatMap((x) => x.files.flat()))];
    const absent = await this.http("missing", "POST", ids);
    for (const id of ids) {
      let wire = this.db
        .prepare("SELECT body FROM data WHERE account=? AND id=?")
        .get(this.id, id)?.body;
      if (!wire) wire = await this.http("chunks/" + id);
      if (createHash("sha256").update(wire).digest("hex") !== id)
        throw Error("digest mismatch");
      await this.decrypt(["chunk"], wire);
      this.saveBytes(id, wire);
      if (absent.includes(id))
        await this.http("chunks/" + id, "PUT", Buffer.from(wire));
    }
    if (absent.length || JSON.stringify(base) !== JSON.stringify(remote)) {
      const wire = await this.encrypt(
        ["manifest", rev + 1],
        Buffer.from(JSON.stringify(base)),
      );
      rev = await this.http("base", "PUT", {
        revision: rev,
        envelope: wire.toString("base64"),
        chunks: ids,
      });
    }
    this.save(base);
    await this.http("confirm", "POST", { revision: rev });
    return rev;
  }
  async file(ids) {
    return Buffer.concat(
      await Promise.all(
        ids.map((id) =>
          this.decrypt(
            ["chunk"],
            this.db
              .prepare("SELECT body FROM data WHERE account=? AND id=?")
              .get(this.id, id).body,
          ),
        ),
      ),
    );
  }
}
