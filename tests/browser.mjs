// Optional browser acceptance test, with the same stream transport as the
// protocol suite. OLYMP_PLAYWRIGHT may identify an installed Playwright module.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectedFetch } from "./http.js";
const { firefox } = await import(process.env.OLYMP_PLAYWRIGHT || "playwright");
const data = await mkdtemp(join(tmpdir(), "olymp-browser-"));
const server = spawn(
  "sh",
  ["-c", "exec target/debug/olymp --connected-stdin <&3"],
  {
    env: { ...process.env, OLYMP_DATA: data, OLYMP_SIGNUP: "open" },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  },
);
await once(server.stdout, "data");
const http = connectedFetch(server.stdio[3]);
const browser = await firefox.launch({ headless: true, timeout: 15000 });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error(e));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const response = await http(req.url(), {
      method: req.method(),
      headers: await req.allHeaders(),
      body: req.postDataBuffer(),
    });
    await route.fulfill({
      status: response.status,
      contentType:
        response.headers.get("Content-Type") || "application/octet-stream",
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  const name = page.getByLabel("Login name"),
    password = page.getByLabel("Password");
  await page.goto("http://localhost:8787/");
  await name.fill("browser-user");
  await password.fill("browser passphrase");
  await page.getByRole("button", { name: "Create account" }).click();
  await page
    .getByRole("heading", { name: "browser-user" })
    .waitFor({ timeout: 15000 });
  await page.getByText("Fully synced at revision 0", { exact: true }).waitFor();
  const write = await page.evaluate(async () => {
    const { Replica } = await import("/client.js");
    const { remembered, browserStore } = await import("/browser.js");
    const session = await remembered.read();
    const replica = new Replica(session, browserStore(session));
    await replica.put("unrendered", { kind: "app.future" }, [
      new Uint8Array([4, 9, 17]),
    ]);
    return await replica.sync();
  });
  assert.equal(write, 1);
  await page.reload();
  await page.getByText("Last confirmed revision 1", { exact: true }).waitFor();
  const local = await page.evaluate(async () => {
    const { Replica } = await import("/client.js");
    const { remembered, browserStore } = await import("/browser.js");
    const session = await remembered.read();
    const replica = new Replica(session, browserStore(session));
    const [record] = await replica.records();
    return [
      record.value,
      Array.from(await replica.attachment(record.files[0])),
    ];
  });
  assert.deepEqual(local, [{ kind: "app.future" }, [4, 9, 17]]);
  await page.getByRole("button", { name: "Sign out" }).click();
  await name.waitFor();
  await name.fill("second-user");
  await password.fill("second passphrase");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("heading", { name: "second-user" }).waitFor();
  await page.getByText("Fully synced at revision 0", { exact: true }).waitFor();
  assert.equal(await page.locator("#devices li").count(), 1);
  console.log(
    "Firefox " +
      browser.version() +
      ": registration, device list, durable IndexedDB records and bytes, reload, logout and account switch passed.",
  );
} finally {
  await browser.close();
  server.kill();
  await rm(data, { recursive: true, force: true });
}
