import { signIn, Replica, request } from "./client.js";
import { browserStore, remembered } from "./browser.js";
const el = (id) => document.getElementById(id);
let session, replica, timer;
async function refresh() {
  const current = session;
  if (!current) return;
  el("status").textContent = await replica.syncStatus();
  try {
    const list = await request("", "devices", { session: current });
    if (current !== session) return;
    el("devices").replaceChildren(
      ...list.map((row) => {
        const li = document.createElement("li"),
          detail = document.createElement("small");
        li.append(document.createTextNode(row.device), detail);
        detail.textContent =
          row.confirmed === null
            ? "Awaiting first sync"
            : "Last confirmed revision " + row.confirmed;
        return li;
      }),
    );
    el("notice").textContent = "";
  } catch (e) {
    if (current === session) el("notice").textContent = e.message;
  }
}
function activate(s) {
  session = s;
  replica = new Replica(s, browserStore(s));
  replica.start();
  el("entry").hidden = true;
  el("dashboard").hidden = false;
  el("learner").textContent = s.account.name;
  refresh();
  timer = setInterval(refresh, 2000);
}
el("entry").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.target;
  const fields = Object.fromEntries(new FormData(form));
  const buttons = form.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  el("notice").textContent = "Unlocking account…";
  try {
    const s = await signIn("", {
      ...fields,
      device:
        "Olymp web · " +
        (navigator.userAgentData?.platform || navigator.platform || "Browser"),
      signup: event.submitter.value === "signup",
    });
    await remembered.save(s);
    form.reset();
    activate(s);
  } catch (e) {
    el("notice").textContent = e.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
};
el("logout").onclick = async () => {
  try {
    await request("", "logout", { session, method: "POST" }).catch((e) => {
      if (e.status !== 401) throw e;
    });
    replica.close();
    clearInterval(timer);
    await remembered.clear(session);
    session = null;
    el("entry").hidden = false;
    el("dashboard").hidden = true;
    el("notice").textContent = "";
  } catch (e) {
    el("notice").textContent = e.message;
  }
};
remembered.onChange(() => location.reload());
const saved = await remembered.read();
if (saved) activate(saved);
