// Drive headless Chromium over the DevTools protocol to test Thump.
// Usage: node tools/cdp.mjs <url> [--shot out.png] [--eval "js expr"] [--wait ms] [--size 1400x900]
//        [--fake-media] [--grant-midi]   (--grant-midi allows MIDI with SysEx, for the pad lights)
//        [--flags "--chromium --flags"] [--select-bt NAME]   (answers Web Bluetooth's chooser with NAME)
//        [--close]   (ends by closing the page the way a window closes, so the page's close code runs)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const url = args[0];
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const evals = args.flatMap((a, i) => a === '--eval' ? [args[i + 1]] : []);
const shot = opt('--shot'), wait = +opt('--wait', 1500), [W, H] = opt('--size', '1400x900').split('x').map(Number);
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'thump-cdp-'));
const extra = args.includes('--fake-media') ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : [];
const flags = opt('--flags', '').split(' ').filter(Boolean), selectBt = opt('--select-bt');
const chrome = spawn('chromium', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`, '--hide-scrollbars', ...extra, ...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d; });
chrome.on('exit', (code, sig) => { if (code || sig) console.error('chromium exited', code, sig, chromeErr.slice(-1500)); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const waiting = new Map(), logs = [], answered = new Set();
try {
  let target;
  let lastErr;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch (e) { lastErr = e.cause || e; }
  }
  if (!target) throw new Error('no devtools target: ' + lastErr);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('close', () => { for (const [, r] of waiting) r({ result: { result: { value: 'devtools connection closed' } } }); waiting.clear(); });
  ws.addEventListener('message', m => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled') logs.push(`[console.${d.params.type}] ` + d.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    if (d.method === 'Runtime.exceptionThrown') { const e = d.params.exceptionDetails; logs.push(`[exception] ${e.exception?.description || e.text} @${e.url}:${e.lineNumber}`); }
    if (d.method === 'DeviceAccess.deviceRequestPrompted' && selectBt) {
      const dev = d.params.devices.find(x => (x.name || '').includes(selectBt));
      logs.push('[bluetooth chooser] ' + d.params.devices.map(x => x.name).join(', '));
      if (dev && !answered.has(d.params.id)) answered.add(d.params.id), ws.send(JSON.stringify({ id: ++id, method: 'DeviceAccess.selectPrompt', params: { id: d.params.id, deviceId: dev.id } }));
    }
    if (d.method === 'Log.entryAdded') logs.push(`[log.${d.params.entry.level}] ${d.params.entry.text}`);
  });
  const send = (method, params = {}) => new Promise(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  if (selectBt) await send('DeviceAccess.enable');
  if (args.includes('--grant-midi')) {
    const r = await send('Browser.grantPermissions', { permissions: ['midi', 'midiSysex'] });
    if (r.error) console.error('grant failed', JSON.stringify(r.error));
  }
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(wait);
  for (const expr of evals) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    const v = r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? JSON.stringify(r.result);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  }
  if (shot) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot, Buffer.from(r.result.data, 'base64'));
    console.log('screenshot ' + shot);
  }
  if (args.includes('--close')) {
    // Page.close runs the page's beforeunload and pagehide code like closing a window does.
    // (Browser.close would skip it.) The browser then gets a moment before it is stopped.
    const gone = new Promise(r => ws.addEventListener('close', r));
    send('Page.close');
    console.log(await Promise.race([gone.then(() => 'page closed'), sleep(5000).then(() => 'page did not close in 5 s')]));
    await sleep(1500);
  }
  if (logs.length) console.log('--- page log\n' + logs.join('\n'));
} finally {
  try { ws && ws.close(); } catch { }
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
