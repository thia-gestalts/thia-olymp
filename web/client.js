// Olymp v1.1.0 — shared browser / native JS binding.
import sodium from "./sodium/libsodium-wrappers.mjs";
import init, { PasswordExchange } from "./opaque/opaque.js";

const utf8 = new TextEncoder();
const decode = new TextDecoder("utf-8", { fatal: true });
const aad = (...parts) => utf8.encode(JSON.stringify(parts));
const CHUNK = 262144;
const empty = () => ({ heads: [], removed: [] });
const initial = () => ({ base: empty(), revision: 0, pending: false });
const bytes = (s) => Uint8Array.fromBase64(s);
const base64 = (b) => b.toBase64();

async function digest(b) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b)).toHex();
}
async function seal(key, data, additionalData) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    data,
  );
  const result = new Uint8Array(12 + body.byteLength);
  result.set(iv);
  result.set(new Uint8Array(body), 12);
  return result;
}
async function open(key, data, additionalData) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.subarray(0, 12), additionalData },
      key,
      data.subarray(12),
    ),
  );
}
async function wrapKey(raw) {
  try {
    const input = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
      "deriveKey",
    ]);
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: utf8.encode("thia-personal-key-wrap-v1"),
      },
      input,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    raw.fill(0);
  }
}
async function importKey(raw) {
  try {
    return await crypto.subtle.importKey("raw", raw, "HKDF", false, [
      "deriveBits",
    ]);
  } finally {
    raw.fill(0);
  }
}

const contentKeys = new WeakMap();
async function contentKey(root) {
  await sodium.ready;
  if (!contentKeys.has(root)) {
    const bits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: utf8.encode("olymp-content-v1"),
      },
      root,
      256,
    );
    contentKeys.set(root, new Uint8Array(bits));
  }
  return contentKeys.get(root);
}
async function encryptContent(root, data, context) {
  const key = await contentKey(root);
  const nonce = sodium.randombytes_buf(24);
  const wire = new Uint8Array(40 + data.length);
  wire.set(nonce);
  wire.set(
    sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      data,
      context,
      null,
      nonce,
      key,
    ),
    24,
  );
  return wire;
}
async function decryptContent(root, data, context) {
  const key = await contentKey(root);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    data.subarray(24),
    context,
    data.subarray(0, 24),
    key,
  );
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
// origin is the service origin or an empty string for same-origin requests.
export async function request(
  origin,
  path,
  { session, method = "GET", json, binary, signal } = {},
) {
  const headers = {};
  if (session) {
    headers.Authorization = "Bearer " + session.token;
    headers["X-Olymp-Account"] = session.account.id;
  }
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(origin + "/v1/" + path, {
    method,
    headers,
    redirect: "error",
    cache: "no-store",
    credentials: "omit",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: json === undefined ? binary : JSON.stringify(json),
  });
  if (!response.ok)
    throw new HttpError(
      response.status,
      (await response.json().catch(() => ({}))).error ||
        "Request failed (" + response.status + ")",
    );
  if (response.status === 204) return;
  if (path.startsWith("chunks/"))
    return new Uint8Array(await response.arrayBuffer());
  return response.json();
}

export async function signIn(
  origin,
  { name, password, device, signup = false, wasm },
) {
  if (!password || !device?.trim())
    throw Error("Enter a password and device label");
  await init(wasm ? { module_or_path: wasm } : undefined);
  const exchange = new PasswordExchange();
  const secret = utf8.encode(password);
  const post = (path, json) => request(origin, path, { method: "POST", json });
  try {
    if (signup) {
      const start = await post("signup/start", {
        name,
        message: base64(exchange.start(secret, true)),
      });
      const [reply, raw] = exchange.finish(secret, bytes(start.message), true);
      const key = crypto.getRandomValues(new Uint8Array(32));
      try {
        const wrapped = await seal(
          await wrapKey(raw),
          key,
          aad("thia-server-unlock", 1, start.id, 0),
        );
        await post("signup/finish", {
          challenge: start.challenge,
          message: base64(reply),
          wrapped: base64(wrapped),
        });
      } finally {
        key.fill(0);
      }
    }
    const start = await post("login/start", {
      name,
      message: base64(exchange.start(secret, false)),
    });
    const [reply, raw] = exchange.finish(secret, bytes(start.message), false);
    const { account, token, wrapped } = await post("login/finish", {
      challenge: start.challenge,
      message: base64(reply),
      device,
    });
    const key = await importKey(
      await open(
        await wrapKey(raw),
        bytes(wrapped),
        aad("thia-server-unlock", 1, account.id, account.generation),
      ),
    );
    return { origin, account, token, key };
  } finally {
    secret.fill(0);
    exchange.free();
  }
}

// A multi-value register per logical record. Only superseded operation IDs survive.
export function merge(left, right) {
  const removed = new Set([...left.removed, ...right.removed]);
  const heads = new Map();
  for (const h of [...left.heads, ...right.heads])
    if (!removed.has(h.id)) heads.set(h.id, h);
  return {
    heads: [...heads.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    removed: [...removed].sort(),
  };
}
const references = (base) =>
  [...new Set(base.heads.flatMap((h) => h.files.flat()))].sort();

// Logical records group simultaneous writes by key. Equal JSON writes share
// a value in the projection while retaining all operation IDs for resolution.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const objectPayload = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function editInfo(parents, value, files) {
  if (
    parents.length !== 1 ||
    parents[0].deleted ||
    !objectPayload(parents[0].value) ||
    !objectPayload(value)
  )
    return {};
  const parent = parents[0];
  const keys = [
    ...new Set([...Object.keys(value), ...Object.keys(parent.value)]),
  ];
  return {
    edit: {
      from: parent.id,
      fields: keys.filter(
        (k) =>
          !same(
            Object.hasOwn(value, k) ? value[k] : undefined,
            Object.hasOwn(parent.value, k) ? parent.value[k] : undefined,
          ),
      ),
      files: !same(files, parent.files),
    },
  };
}

// Concurrent replacements of separate top-level fields from the same observed
// version compose. Any incompatible overlap keeps each entire original edit.
function compose(heads) {
  if (
    heads.length < 2 ||
    !heads[0].edit ||
    heads.some((h) => h.deleted || h.edit?.from !== heads[0].edit.from)
  )
    return;
  const changes = new Map();
  let changedFiles;
  for (const h of heads) {
    for (const field of h.edit.fields) {
      const next = Object.hasOwn(h.value, field) ? h.value[field] : undefined;
      if (changes.has(field) && !same(changes.get(field), next)) return;
      changes.set(field, next);
    }
    if (h.edit.files) {
      if (changedFiles && !same(changedFiles, h.files)) return;
      changedFiles = h.files;
    }
  }
  const value = new Map(Object.entries(heads[0].value));
  for (const [field, next] of changes) {
    if (next === undefined) value.delete(field);
    else value.set(field, next);
  }
  return {
    ids: heads.map((h) => h.id),
    value: Object.fromEntries(value),
    files: changedFiles ?? heads[0].files,
    deleted: false,
  };
}
export function entries(heads) {
  const groups = Map.groupBy(heads, (h) => h.key);
  return [...groups].map(([key, group]) => {
    const composed = compose(group);
    if (composed) return { key, versions: [composed] };
    const versions = new Map();
    for (const { id, value, files, deleted } of group) {
      const signature = JSON.stringify([deleted, canonical(value), files]);
      if (!versions.has(signature))
        versions.set(signature, { ids: [], value, files, deleted });
      versions.get(signature).ids.push(id);
    }
    return { key, versions: [...versions.values()] };
  });
}

export function recordKey({ kind, id }) {
  if (typeof kind !== "string" || !kind || typeof id !== "string" || !id)
    throw Error("Expected a typed record identity");
  return "gestalt/" + JSON.stringify([kind, id]);
}

export class Replica {
  #session;
  #store;
  #call;
  #timer;
  #soonTimer;
  #run;
  #again = false;
  // Chunks already authenticated in this session. Content addressing keeps them valid.
  #verified = new Set();
  #abort = new AbortController();
  status = "Offline";
  constructor(session, store, call = request) {
    if (store.scope !== JSON.stringify([session.origin, session.account.id]))
      throw Error("Replica account mismatch");
    this.#session = session;
    this.#store = store;
    this.#call = (path, options) =>
      call(session.origin, path, {
        ...options,
        session,
        signal: this.#abort.signal,
      });
  }
  async #state() {
    return (await this.#store.state()) ?? initial();
  }
  #context(type, ...rest) {
    return aad("olymp", 1, this.#session.account.id, type, ...rest);
  }
  async #readChunk(id) {
    const data = await this.#store.chunk(id);
    if (!data || (await digest(data)) !== id)
      throw Error("Missing or damaged local chunk");
    return decryptContent(this.#session.key, data, this.#context("chunk"));
  }
  async attachment(ids) {
    this.#abort.signal.throwIfAborted();
    const parts = [];
    for (const id of ids) parts.push(await this.#readChunk(id));
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  }
  async syncStatus() {
    const state = await this.#state();
    if (this.status.startsWith("Fully synced")) {
      if (state.pending) return "Pending";
      if (this.status !== "Fully synced at revision " + state.revision)
        return "Awaiting confirmation";
    }
    return this.status;
  }
  async records() {
    this.#abort.signal.throwIfAborted();
    return (await this.#state()).base.heads;
  }
  // key is stable across apps. deleted heads have null payload and no files.
  async put(
    key,
    value,
    attachments = [],
    { observed, deleted = false, files: existing = [] } = {},
  ) {
    const [id] = await this.writeBatch(() => [
      { key, value, attachments, observed, deleted, files: existing },
    ]);
    return id;
  }

  // Prepare against the locked local snapshot. All operations become visible
  // in one durable manifest save. Interrupted staging leaves only orphan bytes.
  async writeBatch(prepare) {
    const ids = await this.#store.lock(async () => {
      this.#abort.signal.throwIfAborted();
      const state = await this.#state();
      if (state.owner) throw Error("Local work has already been adopted");
      const changes = await prepare(entries(state.base.heads));
      const ids = [];
      for (const change of changes) {
        const { key, value, attachments = [], observed, deleted = false, files: existing = [] } = change;
        if (typeof key !== "string" || !key) throw Error("Missing record key");
        const payload = JSON.parse(JSON.stringify(value));
        const id = crypto.randomUUID();
        const files = existing.map((ids) => [...ids]);
        for (const ref of new Set(files.flat())) await this.#readChunk(ref);
        for (const file of attachments) {
          if (!(file instanceof Uint8Array))
            throw Error("Expected attachment bytes");
          const ids = [];
          for (let i = 0; i < file.length; i += CHUNK) {
            const chunk = await encryptContent(
              this.#session.key,
              file.subarray(i, i + CHUNK),
              this.#context("chunk"),
            );
            const ref = await digest(chunk);
            await this.#store.saveChunk(ref, chunk);
            ids.push(ref);
          }
          files.push(ids);
        }
        const parents = state.base.heads.filter(
          (h) => h.key === key && (!observed || observed.includes(h.id)),
        );
        const superseded = parents.map((h) => h.id);
        const head = {
          key,
          id,
          value: payload,
          files,
          deleted,
          ...editInfo(parents, payload, files),
        };
        state.base = merge(state.base, { heads: [head], removed: superseded });
        ids.push(id);
      }
      if (!ids.length) return ids;
      await this.#store.save({ ...state, pending: true });
      this.status = "Pending";
      return ids;
    });
    if (ids.length && this.#timer) this.#soon();
    return ids;
  }
  remove(key, observed) {
    return this.put(key, null, [], { observed, deleted: true });
  }
  start(interval = 5000) {
    if (this.#timer) return;
    this.#abort.signal.throwIfAborted();
    const tick = () => this.sync().catch(() => {});
    globalThis.addEventListener?.("online", tick, {
      signal: this.#abort.signal,
    });
    this.#timer = setInterval(tick, interval);
    tick();
  }
  close() {
    this.#abort.abort();
    clearInterval(this.#timer);
    clearTimeout(this.#soonTimer);
    this.#timer = null;
    this.status = "Closed";
  }
  // Coalesce bursts of local writes into one round.
  #soon(delay = 300) {
    clearTimeout(this.#soonTimer);
    this.#soonTimer = setTimeout(() => this.sync().catch(() => {}), delay);
  }
  // Network transfers run outside the account lock so local writes never wait
  // on the service. Only the snapshot and the final merge-and-save are locked.
  sync() {
    if (this.#run) {
      this.#again = true;
      return this.#run;
    }
    this.#run = (async () => {
      this.#abort.signal.throwIfAborted();
      this.status = "Syncing";
      for (let i = 0; i < 5; i++) {
        try {
          return await this.#round();
        } catch (e) {
          if (e.status !== 409 || i === 4) throw e;
        }
      }
    })()
      .catch((e) => {
        this.status = this.#abort.signal.aborted
          ? "Closed"
          : e.status === 413 || e.name === "QuotaExceededError"
            ? "Storage limit reached"
            : e.status === 401
              ? "Sign in again"
              : e instanceof TypeError || e.name === "TimeoutError"
                ? "Connection unavailable"
                : "Sync incomplete";
        throw e;
      })
      .finally(() => {
        this.#run = null;
        if (this.#again && this.#timer) this.#soon(0);
        this.#again = false;
      });
    return this.#run;
  }
  async #chunk(id) {
    if (this.#verified.has(id)) return;
    let data = await this.#store.chunk(id);
    if (!data || (await digest(data)) !== id) {
      data = await this.#call("chunks/" + id);
      if ((await digest(data)) !== id) throw Error("Invalid remote chunk");
      await decryptContent(this.#session.key, data, this.#context("chunk"));
      await this.#store.saveChunk(id, data);
    } else {
      await decryptContent(this.#session.key, data, this.#context("chunk"));
    }
    this.#verified.add(id);
  }
  async #round() {
    if (this.#session.origin === "local:") throw Error("Sign in to sync");
    const { base } = await this.#store.lock(() => this.#state());
    let { revision, envelope } = await this.#call("base");
    const remote = envelope
      ? JSON.parse(
          decode.decode(
            await decryptContent(
              this.#session.key,
              bytes(envelope),
              this.#context("manifest", revision),
            ),
          ),
        )
      : empty();
    const combined = merge(base, remote);
    const chunks = references(combined);
    const missing = await this.#call("missing", { method: "POST", json: chunks });
    for (const id of chunks) await this.#chunk(id);
    for (const id of missing) {
      const data = await this.#store.chunk(id);
      if (!data || (await digest(data)) !== id)
        throw Error("Missing or damaged local chunk");
      await this.#call("chunks/" + id, { method: "PUT", binary: data });
    }
    if (missing.length || !same(combined, remote)) {
      const sealed = await encryptContent(
        this.#session.key,
        utf8.encode(JSON.stringify(combined)),
        this.#context("manifest", revision + 1),
      );
      const accepted = await this.#call("base", {
        method: "PUT",
        json: { revision, envelope: base64(sealed), chunks },
      });
      if (accepted !== revision + 1)
        throw Error("Invalid revision acknowledgement");
      revision = accepted;
    }
    // Writes made during the transfer stay pending for the next round.
    const pending = await this.#store.lock(async () => {
      this.#abort.signal.throwIfAborted();
      const current = await this.#state();
      const next = merge(current.base, combined);
      const pending = !same(next, combined);
      await this.#store.save({
        ...current,
        base: next,
        revision: Math.max(current.revision ?? 0, revision),
        pending,
      });
      return pending;
    });
    await this.#call("confirm", { method: "POST", json: { revision } });
    this.#abort.signal.throwIfAborted();
    this.status = pending ? "Pending" : "Fully synced at revision " + revision;
    if (pending) this.#again = true;
    return revision;
  }
}

// Adopt a signed-out app store. The source keeps an immutable owner binding so a
// retry after a crash can only target the same account. Caller closes the local
// editor before adoption and starts the account replica after it returns.
export async function adoptLocal(local, destination, target) {
  const source = local.store;
  const owner = JSON.stringify([destination.origin, destination.account.id]);
  if (
    target.scope !== owner ||
    source.scope !==
      JSON.stringify([local.session.origin, local.session.account.id]) ||
    local.session.origin !== "local:"
  )
    throw Error("Invalid adoption scope");
  await source.lock(async () => {
    const state = await source.state();
    if (!state) return;
    if (state.owner && state.owner !== owner)
      throw Error("Local work already belongs to another account");
    await source.save({ ...state, owner });
    await target.lock(async () => {
      const dst = (await target.state()) ?? initial();
      const known = new Set([
        ...dst.base.removed,
        ...dst.base.heads.map((h) => h.id),
      ]);
      const heads = [];
      const refs = new Map();
      for (const h of state.base.heads) {
        if (known.has(h.id)) continue;
        const files = [];
        for (const file of h.files) {
          const ids = [];
          for (const old of file) {
            if (!refs.has(old)) {
              const data = await source.chunk(old);
              if ((await digest(data)) !== old)
                throw Error("Damaged local attachment");
              const plain = await decryptContent(
                local.session.key,
                data,
                aad("olymp", 1, local.session.account.id, "chunk"),
              );
              const encrypted = await encryptContent(
                destination.key,
                plain,
                aad("olymp", 1, destination.account.id, "chunk"),
              );
              const id = await digest(encrypted);
              await target.saveChunk(id, encrypted);
              refs.set(old, id);
            }
            ids.push(refs.get(old));
          }
          files.push(ids);
        }
        heads.push({ ...h, files });
      }
      await target.save({
        ...dst,
        base: merge(dst.base, { heads, removed: state.base.removed }),
        pending: true,
      });
    });
  });
}
