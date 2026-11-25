// IndexedDB writes resolve only after the transaction has committed.
const database = new Promise((ok, fail) => {
  const req = indexedDB.open("olymp-v1", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("data");
  req.onsuccess = () => ok(req.result);
  req.onerror = () => fail(req.error);
});
async function access(mode, op) {
  const tx = (await database).transaction("data", mode, {
    durability: "strict",
  });
  return new Promise((ok, fail) => {
    const req = op(tx.objectStore("data"));
    tx.oncomplete = () => ok(req.result);
    tx.onabort = () => fail(tx.error);
  });
}
const get = (k) => access("readonly", (s) => s.get(k));
const set = (k, v) => access("readwrite", (s) => s.put(v, k));
const sessionChanges = new BroadcastChannel("olymp-session-v1");
export const remembered = {
  read: () => get("session"),
  save: async (s) => {
    await set("session", s);
    sessionChanges.postMessage("changed");
  },
  clear: async (session) => {
    await access("readwrite", (s) => {
      const req = s.get("session");
      req.onsuccess = () => {
        if (req.result?.token === session.token) s.delete("session");
      };
      return req;
    });
    sessionChanges.postMessage("changed");
  },
  onChange: (f) => sessionChanges.addEventListener("message", f),
};
export function browserStore(session) {
  const scope = JSON.stringify([session.origin, session.account.id]);
  return {
    scope,
    lock: (f) => navigator.locks.request("olymp:" + scope, f),
    state: () => get([scope, "manifest"]),
    save: (v) => set([scope, "manifest"], v),
    chunk: (id) => get([scope, id]),
    saveChunk: (id, b) => set([scope, id], b),
  };
}

// Apps retain this random profile handle until first sign-in. After adoption,
// discard it and allocate a fresh handle for the next signed-out learner.
export async function createLocal() {
  const session = {
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
  await set(["local", session.account.id], session);
  return session;
}
export async function resumeLocal(id, destination) {
  const session = await get(["local", id]);
  if (!session) throw Error("Local profile unavailable");
  const owner = (await browserStore(session).state())?.owner;
  if (owner && (!destination || owner !== browserStore(destination).scope))
    throw Error("Local profile already belongs to an account");
  return session;
}
