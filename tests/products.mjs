// Cross-product acceptance only. No sibling is needed for any product build.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { png } from './image.js';

const desktop = resolve(process.env.GESTALTER_ROOT || '../gestalter-desktop');
const vizint = resolve(process.env.VIZINT_ROOT || '../vizint');
const require = createRequire(join(desktop, 'package.json'));
const { chromium, _electron } = require('playwright');
const temp = await mkdtemp(join(tmpdir(), 'olymp-products-'));
const children = [];
let app, browser;
let packagedLauncher = process.env.GESTALTER_TEST_LAUNCHER;

async function server(cmd, args, env, pattern) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  for await (const line of createInterface({ input: child.stdout })) {
    const match = line.match(pattern);
    if (match) return match[1];
  }
  throw Error(cmd + ' exited before listening');
}
async function desktopPage(service) {
  app = await _electron.launch({
    executablePath: packagedLauncher ?? require('electron'),
    args: [...(packagedLauncher ? [] : [desktop]), '--ozone-platform=x11'],
    chromiumSandbox: process.env.GESTALTER_TEST_SANDBOX !== '0',
    env: { ...process.env, OLYMP_ORIGIN: service,
      ...(packagedLauncher && { GESTALTER_PYTHON: '/unused-in-the-package' }),
      XDG_DATA_HOME: join(temp, 'data'), XDG_CONFIG_HOME: join(temp, 'config') },
    timeout: 20000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', e => console.error('Desktop:', e.message));
  page.on('console', msg => { if (msg.type() === 'error') console.error('Desktop:', msg.text()); });
  page.setDefaultTimeout(20000);
  return page;
}
async function credentials(page, button) {
  await page.getByLabel('Login name').fill('rounding-proof');
  await page.getByLabel('Password').fill('rounding proof passphrase');
  await page.getByRole('button', { name: button, exact: true }).click();
}
async function snapshot(page) {
  return page.evaluate(async () => {
    const { replica } = await import('/storage.mjs');
    const heads = await replica.records();
    const files = [];
    for (const head of heads)
      for (const file of head.files) files.push((await replica.attachment(file)).toBase64());
    const { browserStore, remembered } = await import('/olymp/browser.js');
    const { base, revision, pending } = await browserStore(await remembered.read()).state();
    return { heads, files, base, revision, pending };
  });
}
async function devices(page) {
  return page.evaluate(async () => {
    const { session } = await import('/storage.mjs');
    const { request } = await import('/olymp/client.js');
    return request(session.origin, 'devices', { session });
  });
}
async function eventually(check) {
  for (let i = 0; i < 150; ++i) {
    if (await check()) return;
    await delay(200);
  }
  assert.fail('Timed out waiting for ' + check.toString());
}

try {
  if (process.env.GESTALTER_DEB) {
    execFileSync('dpkg-deb', ['-x', resolve(process.env.GESTALTER_DEB), join(temp, 'install')], { stdio: 'inherit' });
    packagedLauncher = join(temp, 'install/usr/bin/gestalter');
  }
  const address = await server(resolve('target/debug/olymp'), [], {
    OLYMP_DATA: join(temp, 'service'), OLYMP_LISTEN: '127.0.0.1:0',
  }, /listening on (.*)/);
  const service = 'http://' + address;
  const site = await server(process.execPath, [join(vizint, 'scripts/serve.mjs')],
    { OLYMP_ORIGIN: service, PORT: '0' }, /listening on (.*)/);
  browser = await chromium.launchPersistentContext(join(temp, 'browser'), { headless: true });
  let web = await browser.newPage();
  web.on('pageerror', e => console.error('Vizint:', e.message));
  await web.goto(site + '/rounding/');
  await web.frameLocator('iframe').locator('#options button').first().click();
  await web.getByText('Practice attempt saved on this device.').waitFor();
  const guestRecords = await web.evaluate(async () => (await import('/storage.mjs')).readRecords());
  await credentials(web, 'Create account');
  await web.getByText('Fully synced at revision 0', { exact: true }).waitFor();
  let desk = await desktopPage(service);
  await desk.getByRole('link', { name: 'Account' }).click();
  await credentials(desk, 'Sign in');
  await desk.getByText('Fully synced at revision 0', { exact: true }).waitFor();
  await desk.getByRole('link', { name: 'Recent practice' }).click();
  await desk.getByText('No practice recorded yet.').waitFor();

  await browser.setOffline(true);
  await web.frameLocator('iframe').locator('#options button').first().click();
  await web.getByText('Practice attempt saved on this device.').waitFor();
  const local = await snapshot(web);
  assert.equal(local.heads.length, 2);
  const event = local.heads.find(h => h.value.kind === 'learning-event').value;
  assert.equal(event.type, 'attempt');
  await desk.getByText('No practice recorded yet.').waitFor();
  let lostAck = false;
  await browser.route('**/v1/base', async route => {
    if (lostAck || route.request().method() !== 'PUT') return route.continue();
    const reply = await route.fetch();
    assert.equal(reply.status(), 200);
    lostAck = true;
    await route.abort();
  });
  await browser.setOffline(false);
  const skill = desk.getByText('Round to the nearest tenth', { exact: true });
  await skill.waitFor();
  assert.equal(await skill.count(), 1);
  assert.equal(await skill.locator('xpath=../..').locator('time').getAttribute('datetime'),
    new Date(event.occurredAtMs).toISOString());
  await eventually(async () => (await devices(web)).every(d => d.confirmed === 1));
  assert.ok(lostAck);
  console.log('Lost publication acknowledgement retried automatically.');
  console.log('Offline attempt reached the open desktop practice route with its original timestamp.');

  const image = png(600, 520);
  const markdown = '# Rounding observations\n\nA diagram from the desktop editor.';
  let received = 0, interrupted = false;
  await browser.route('**/v1/chunks/*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (received >= 1) {
      interrupted = true;
      return route.abort();
    }
    received++;
    return route.continue();
  });
  await desk.getByRole('link', { name: 'Notes', exact: true }).click();
  await desk.getByRole('link', { name: 'New note' }).click();
  await desk.getByLabel('Note Markdown').fill(markdown);
  await desk.getByLabel('Note Markdown').press('Control+s');
  await desk.getByRole('link', { name: 'Rounding observations' }).waitFor();
  await desk.locator('input[type=file][multiple]').setInputFiles({
    name: 'rounding.png', mimeType: 'image/png', buffer: image,
  });
  await desk.getByRole('img', { name: 'rounding.png' }).waitFor();
  await eventually(() => interrupted);
  const revision = await web.evaluate(async () => {
    const { session } = await import('/storage.mjs');
    const { request } = await import('/olymp/client.js');
    return (await request(session.origin, 'base', { session })).revision;
  });
  await eventually(async () => (await devices(web)).find(d => d.device === 'Gestalter desktop').confirmed === revision);
  const list = await devices(web);
  assert.ok(revision >= 2);
  assert.ok(list.find(d => d.device === 'Vizint').confirmed < revision);
  assert.equal((await snapshot(web)).files.length, 0);
  assert.notEqual(await web.locator('#olymp-status').textContent(), 'Fully synced at revision ' + revision);
  console.log('Interrupted image download after one chunk. Vizint had not confirmed revision', revision);

  await browser.close();
  browser = await chromium.launchPersistentContext(join(temp, 'browser'), { headless: true });
  let remaining = 0;
  browser.on('request', req => { if (req.method() === 'GET' && req.url().includes('/v1/chunks/')) remaining++; });
  web = await browser.newPage();
  await web.goto(site);
  const complete = 'Fully synced at revision ' + revision;
  await web.getByText(complete, { exact: true }).waitFor();
  await desk.getByText(complete, { exact: true }).waitFor();
  assert.deepEqual((await devices(web)).map(d => d.confirmed), [revision, revision]);
  await browser.setOffline(true);
  const downloaded = await snapshot(web);
  const note = downloaded.heads.find(h => h.value.kind === 'note');
  assert.equal(note.value.text, markdown);
  assert.deepEqual(downloaded.files, [image.toString('base64')]);
  assert.equal(remaining, note.files[0].length - 1);
  assert.equal(downloaded.heads.length, 3);

  await app.close();
  app = undefined;
  desk = await desktopPage(service);
  await desk.getByText(complete, { exact: true }).waitFor();
  await desk.getByRole('link', { name: 'Rounding observations' }).click();
  assert.equal(await desk.getByLabel('Note Markdown').inputValue(), markdown);
  const img = desk.getByRole('img', { name: 'rounding.png' });
  await img.waitFor();
  assert.equal(await img.getAttribute('src'), 'data:image/png;base64,' + downloaded.files[0]);
  const stored = await desk.evaluate(async () => {
    const { remembered } = await import('/olymp/browser.js');
    const session = await remembered.read();
    return window.gestalter.call('account', JSON.stringify([session.origin, session.account.id]), 'state', []);
  });
  assert.deepEqual(stored.base, downloaded.base);
  assert.equal(downloaded.revision, revision);
  assert.equal(downloaded.pending, false);
  assert.equal(stored.pending, false);
  assert.equal(stored.revision, revision);
  assert.deepEqual(stored.base.heads.filter(h => h.value?.kind === 'learning-event').map(h => h.value), [event]);
  await desk.getByRole('link', { name: 'Recent practice' }).click();
  await desk.getByText('Round to the nearest tenth', { exact: true }).waitFor();
  assert.equal(await desk.locator('main time').count(), 1);
  console.log('Both clients restarted. Complete heads and', image.length,
    'offline image bytes agree. Retry fetched', remaining, 'remaining chunks. Confirmed revision', revision);
  await browser.setOffline(false);
  await web.getByRole('button', { name: 'Sign out' }).click();
  await web.getByLabel('Login name').waitFor();
  assert.deepEqual(await web.evaluate(async () => (await import('/storage.mjs')).readRecords()), guestRecords);
  await desk.getByRole('link', { name: 'Account' }).click();
  await desk.getByRole('button', { name: 'Sign out' }).click();
  await desk.getByLabel('Login name').waitFor();
  await desk.getByRole('link', { name: 'Notes', exact: true }).click();
  await desk.getByText('No notes yet.').waitFor();
  console.log('Sign-out restored both isolated local workspaces.');
} catch (failure) {
  if (app) {
    const page = app.windows()[0];
    if (page) console.error('Desktop window:', page.url(), await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'unavailable'));
  }
  throw failure;
} finally {
  try {
    await app?.close();
    await browser?.close();
  } finally {
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode) continue;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(temp, { recursive: true, force: true });
  }
}
