import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { visibleE2eWindows } from './electron'

test.skip(!visibleE2eWindows, '原生验证码呈现回归会显示主窗口, 抢占焦点并捕获桌面窗口; 设置 STREAM_SYNC_E2E_VISIBLE=1')

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureRoot = path.join(projectRoot, 'e2e', '.data')
const evidenceRoot = path.join(projectRoot, '.runtime-cache', 'login-v4-display-20261108', 'e2e')
const huyaEvidenceRoot = path.join(projectRoot, '.runtime-cache', 'huya-captcha-20261109', 'input', 'e2e')
const require = createRequire(import.meta.url)

interface ActivationEvidence {
  ok: boolean
  failedPhase?: string
  failure?: string
  phases: Array<{ phase: string; counters?: Record<string, number | boolean | string | null>; localId?: number; remoteId?: number }>
  presentations: string[]
  activation?: { requests: number; frames: number; ready: number; clicks: number }
  activatedWithinMs?: number
  nativeCapture?: { backgroundPixels: number; panelPixels: number; width: number; height: number; controlsInCrop?: boolean }
  nativeInput?: { transport: string; events: Array<{ type: string; trusted: boolean; captcha: boolean }> }
  finalCounters?: Record<string, number | boolean | string | null>
  complete?: { loggedIn: boolean; viewsDestroyed: boolean; sameRiskDocument: boolean; isolatedSessions: boolean }
  failureContext?: Record<string, unknown>
  captureProbe?: Record<string, unknown>
  showAt?: number
  actions?: Array<{ kind: string; ok: boolean; atMs: number }>
  baseline?: boolean
}

// This process runs the production app without Playwright's Electron/CDP connection.
// No focus emulation, screenshot, or input is introduced before challenge activation.
const bootstrap = String.raw`
const { app, BrowserWindow, WebContentsView, webContents, desktopCapturer, screen, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.STREAM_SYNC_DIRECT_EVIDENCE;
const platform = process.env.STREAM_SYNC_DIRECT_PLATFORM || 'bilibili';
const isHuya = platform === 'huya';
const evidence = { ok: false, phases: [], presentations: [], actions: [], baseline: process.env.STREAM_SYNC_DIRECT_BASELINE === '1' };
let phase = 'boot', main, original, riskUrl, history;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (operation, ms = 3000) => {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Renderer operation timed out')), ms);
  })]).finally(() => clearTimeout(timer));
};
const evaluate = (contents, script) => bounded(contents.executeJavaScript(script));
const bridge = (method, args) => evaluate(main.webContents,
  'window.streamSyncer.invoke(' + JSON.stringify(method) + ',' + (args === undefined ? 'undefined' : JSON.stringify(args)) + ')');
const counters = () => {
  const current = global.__streamSyncerTest?.getEmbeddedLoginFixtureState();
  if (!current) return undefined;
  return Object.fromEntries(['active', 'phase', 'submitted', 'smsSent', 'verified', 'pendingCaptcha',
    'phoneChanges', 'navigationCount', 'mediaRequests'].map(key => [key, current[key]]));
};
const mark = async next => {
  phase = next;
  const sample = { phase, counters: counters(), ...(original ? { localId: original.localId, remoteId: original.remoteId } : {}) };
  evidence.phases.push(sample);
  await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify(evidence, null, 2));
  process.stdout.write('FY1SYNC_DIRECT_PHASE ' + JSON.stringify(sample) + '\n');
};
const poll = async (label, predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(label + ' timed out');
};
const descendants = (root, visible = true) => root.children.flatMap(view => {
  const shown = visible && view.getVisible();
  return [{ view, parent: root, visible: shown }, ...descendants(view, shown)];
});
const views = () => {
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'One OS window must own both login views');
  const all = descendants(main.contentView).filter(item => item.view instanceof WebContentsView
    && item.view.webContents.id !== main.webContents.id);
  assert.equal(all.length, 2, 'Exactly two login views must exist');
  const local = all.find(item => item.view.webContents.getURL().startsWith('app://login/'));
  const remote = all.find(item => !item.view.webContents.getURL().startsWith('app://login/'));
  assert.ok(local && remote, 'Local and original fixture views must both exist');
  assert.notEqual(local.view.webContents.session, remote.view.webContents.session, 'Login sessions must be isolated');
  assert.notEqual(local.view.webContents.session, main.webContents.session, 'Credential session must be isolated from main');
  assert.notEqual(remote.view.webContents.session, main.webContents.session, 'Official session must be isolated from main');
  if (original) {
    assert.equal(local.view.webContents.id, original.localId, 'Local view must be retained');
    assert.equal(remote.view.webContents.id, original.remoteId, 'Original official view must be retained');
    assert.equal(local.view.webContents.session, original.localSession, 'Local session must be retained');
    assert.equal(remote.view.webContents.session, original.remoteSession, 'Official session must be retained');
  }
  return { local, remote };
};
const state = async () => {
  const current = await bridge('getEmbeddedLogin');
  assert.equal(current.ok, true, 'Login presentation IPC must succeed');
  if (current.value?.presentation) {
    if (evidence.presentations.at(-1) !== current.value.presentation) evidence.presentations.push(current.value.presentation);
    assert.notEqual(current.value.presentation, 'official', 'Activation must never require the full official website');
  }
  return current.value;
};
const card = async () => {
  const current = await evaluate(webContents.fromId(original.localId), 'window.loginCard.state()');
  return current && { stage: current.stage, mode: current.mode, busy: current.busy, sms: current.sms };
};
const act = async action => {
  const result = await evaluate(webContents.fromId(original.localId), 'window.loginCard.act(' + JSON.stringify(action) + ')');
  evidence.actions.push({ kind: action.kind, ok: result.ok, atMs: Date.now() - evidence.showAt });
  assert.equal(result.ok, true, 'Synthetic local card action must be accepted');
};
const activation = async () => {
  const remote = webContents.fromId(original.remoteId);
  const script = '(() => { const a=globalThis.__fixtureActivation; return a ? {requests:a.requests,frames:a.frames,ready:a.ready,clicks:a.clicks} : null; })()';
  if (!isHuya) return evaluate(remote, script);
  const samples = (await Promise.all(remote.mainFrame.framesInSubtree.map(frame => evaluate(frame, script)))).filter(Boolean);
  const active = samples.filter(sample => sample.requests || sample.frames || sample.ready || sample.clicks);
  assert.ok(active.length <= 1, 'Exactly one frame must own synthetic captcha activation');
  return active[0] || samples[0] || null;
};

const captchaGeometry = async remote => {
  if (!isHuya) return evaluate(remote, '(() => {' +
    'const button=document.querySelector("button[data-fixture-captcha]");' +
    'const panel=button?.closest(".geetest_panel_box,.geetest_box");' +
    'if(!button||!panel)throw new Error("Synthetic captcha geometry missing");' +
    'const rect=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};' +
    'return{panel:rect(panel),button:rect(button)};' +
  '})()');
  // Frame DOM reads cannot focus or capture the hidden renderer. Geometry is read only after ready.
  const matches = [];
  for (const frame of remote.mainFrame.framesInSubtree) {
    const geometry = await evaluate(frame, '(() => {' +
      'const button=document.querySelector("button[data-fixture-captcha]");' +
      'const panel=button?.closest("[data-fixture-panel]");if(!button||!panel)return null;' +
      'const rect=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};' +
      'return{panel:rect(panel),button:rect(button),controls:Array.from(panel.querySelectorAll("button,input")).map(rect)};' +
    '})()');
    if (geometry) matches.push({ frame, geometry });
  }
  assert.equal(matches.length, 1, 'Exactly one frame must contain the original synthetic challenge');
  const match = matches[0];
  let offsetX = 0, offsetY = 0;
  for (let frame = match.frame; frame.parent; frame = frame.parent) {
    const owner = await evaluate(frame.parent, '(() => {' +
      'const url=' + JSON.stringify(frame.url) + ',name=' + JSON.stringify(frame.name) + ';' +
      'const all=Array.from(document.querySelectorAll("iframe"));' +
      'const matches=all.filter(element=>element.src===url&&(!name||element.name===name));' +
      'if(matches.length!==1)throw new Error("Synthetic iframe owner is ambiguous");' +
      'const element=matches[0],r=element.getBoundingClientRect();' +
      'return{x:r.x+element.clientLeft,y:r.y+element.clientTop};' +
    '})()');
    offsetX += owner.x;
    offsetY += owner.y;
  }
  const translate = rect => ({ ...rect, x: rect.x + offsetX, y: rect.y + offsetY });
  return { panel: translate(match.geometry.panel), button: translate(match.geometry.button),
    controls: match.geometry.controls.map(translate) };
};

const clickHuyaCaptcha = async (remote, geometry) => {
  const leaves = remote.mainFrame.framesInSubtree.filter(frame =>
    frame.url === 'https://t.captcha.qq.com/cap_union_new_show?fixture=1');
  assert.equal(leaves.length, 1, 'Exactly one synthetic Tencent document must receive native input');
  const leaf = leaves[0], owner = leaf.parent;
  assert.ok(owner, 'Synthetic challenge must retain its original iframe owner');
  // Preserve trusted event evidence in the owner because completion destroys the leaf.
  await evaluate(owner, '(() => {globalThis.__directNativeInput=[];window.addEventListener("message",event=>{' +
    'if(event.origin!=="https://t.captcha.qq.com"||event.source!==document.querySelector("#tcaptcha_iframe")?.contentWindow)return;' +
    'const input=event.data?.__fy1syncDirectNativeInput;if(input)globalThis.__directNativeInput.push(input);});})()');
  await evaluate(leaf, '(() => {for(const type of ["mousedown","mouseup","click"])window.addEventListener(type,event=>{' +
    'window.parent.postMessage({__fy1syncDirectNativeInput:{type:event.type,trusted:event.isTrusted,' +
    'captcha:event.target instanceof Element&&event.target.hasAttribute("data-fixture-captcha")}},"*");},true);})()');
  // Electron 44 sendInputEvent forwards to the root RenderWidgetHost and bypasses OOPIF routing.
  // Use the production broker's existing connection only after automatic readiness is proved.
  // Root Input dispatch performs Chromium hit testing across the original cross-origin frames.
  assert.equal(remote.debugger.isAttached(), true, 'The production challenge broker must already own its connection');
  const point = { x: geometry.button.x + geometry.button.width / 2,
    y: geometry.button.y + geometry.button.height / 2 };
  await bounded(remote.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }));
  await bounded(remote.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }));
  await bounded(remote.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }));
  await poll('Trusted original Tencent input', async () => {
    const events = await evaluate(owner, 'globalThis.__directNativeInput');
    evidence.nativeInput = { transport: 'chromium-root-input', events };
    return events.length === 3;
  });
  assert.deepEqual(evidence.nativeInput.events, ['mousedown', 'mouseup', 'click'].map(type => ({ type, trusted: true, captcha: true })),
    'Native input must hit the original Tencent button and produce exactly one trusted click');
};

const installCaptureProbe = remote => {
  const originalCapture = remote.capturePage;
  const start = Date.now();
  const captured = contents => { try { return contents.isBeingCaptured(); } catch { return null; } };
  const probe = evidence.captureProbe = { calls: 0, resolved: 0, rejected: 0, samples: [], firstError: null };
  remote.capturePage = async function(rect, options) {
    probe.calls++;
    const sample = { atMs: Date.now() - start, phase, rect, options, capturedBefore: captured(this) };
    if (probe.samples.length < 128) probe.samples.push(sample);
    try {
      // This opt-in negative control disables only the test instance's render pulse.
      const result = evidence.baseline ? nativeImage.createEmpty() : await originalCapture.call(this, rect, options);
      probe.resolved++;
      sample.resolvedAtMs = Date.now() - start;
      sample.capturedAfter = captured(this);
      return result;
    } catch (error) {
      probe.rejected++;
      sample.rejectedAtMs = Date.now() - start;
      if (!probe.firstError) {
        const message = error instanceof Error ? error.message : '';
        probe.firstError = { name: error instanceof Error ? error.name.slice(0, 40) : 'UnknownError',
          message: /^(Failed to capture|Cannot capture|Capture failed|capturePage failed|Object has been destroyed|The object has been destroyed|Invalid rectangle)/i.test(message)
            ? message.slice(0, 160).replace(/https?:\/\/\S+/g, '[redacted-url]') : 'Native capture rejected (message omitted)' };
      }
      throw error;
    }
  };
};
const diagnosticContext = async () => {
  const current = views();
  const root = await evaluate(main.webContents, '(() => {' +
    'const host=document.querySelector(".embedded-login-host"),dialog=document.querySelector(".embedded-login-card");' +
    'const r=host?.getBoundingClientRect();return{hidden:document.hidden,visibilityState:document.visibilityState,' +
    'host:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,dialogOpen:dialog?.open??false};})()');
  return { ownerVisible: main.isVisible(), ownerMinimized: main.isMinimized(), ownerFocused: main.isFocused(),
    root, localVisible: current.local.visible, remoteVisible: current.remote.visible,
    localBounds: current.local.view.getBounds(), remoteBounds: current.remote.view.getBounds(),
    card: await card(), presentation: (await state())?.presentation ?? null,
    isBeingCaptured: current.remote.view.webContents.isBeingCaptured() };
};

async function captureInteractive() {
  const current = views(), remote = current.remote.view.webContents;
  const geometry = await captchaGeometry(remote);
  const panelHeight = isHuya ? 280 : 410;
  assert.equal(geometry.panel.width, 340);
  assert.equal(geometry.panel.height, panelHeight);
  assert.notEqual(current.remote.parent, main.contentView, 'Original challenge must have a clipping host');
  const host = current.remote.parent.getBounds(), zoom = remote.getZoomFactor();
  assert.ok(Math.abs(host.width - 340 * zoom) <= 1, 'Clipping host must fit the full panel width');
  assert.ok(Math.abs(host.height - panelHeight * zoom) <= 1, 'Clipping host must fit the full panel height');
  if (isHuya) {
    const viewport = current.remote.view.getBounds();
    assert.ok(Math.abs(viewport.x + geometry.panel.x * zoom) <= 1, 'Crop must start at the actual top-document panel x');
    assert.ok(Math.abs(viewport.y + geometry.panel.y * zoom) <= 1, 'Crop must start at the actual top-document panel y');
    assert.ok(geometry.controls.length > 0, 'Synthetic challenge must contain interactive controls');
    for (const control of geometry.controls) {
      assert.ok(control.x >= geometry.panel.x && control.y >= geometry.panel.y
        && control.x + control.width <= geometry.panel.x + geometry.panel.width
        && control.y + control.height <= geometry.panel.y + geometry.panel.height,
      'Every original interactive control must be inside the full panel crop');
    }
  }
  assert.equal(current.local.visible, false, 'Local credential card must yield the slot to the captcha');
  assert.equal(current.remote.visible, true, 'Original challenge must be visible');
  const content = main.getContentBounds(), dpi = screen.getDisplayMatching(main.getBounds()).scaleFactor;
  let png, size;
  let backgroundPixels = 0, panelPixels = 0;
  const capture = async () => {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: {
      width: Math.round(content.width * dpi), height: Math.round(content.height * dpi) } });
    const source = sources.find(item => item.id === main.getMediaSourceId());
    assert.ok(source && !source.thumbnail.isEmpty(), 'Native capture of this disposable app window must exist');
    png = source.thumbnail.toPNG();
    const image = nativeImage.createFromBuffer(png), bitmap = image.toBitmap();
    size = image.getSize();
    const backgrounds = [[204, 18, 52]];
    if (!isHuya) {
      const backdrop = (await remote.capturePage({ x: 0, y: 0, width: 1, height: 1 })).toBitmap();
      backgrounds.push([backdrop[2], backdrop[1], backdrop[0]]);
    }
    backgroundPixels = 0;
    panelPixels = 0;
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      const red = bitmap[offset + 2], green = bitmap[offset + 1], blue = bitmap[offset];
      if (backgrounds.some(rgb => red === rgb[0] && green === rgb[1] && blue === rgb[2])) backgroundPixels++;
      if (red === 18 && green === 204 && blue === 222) panelPixels++;
    }
  };
  await capture();
  if (isHuya) {
    // DWM can commit after DOM ready. Passive OS captures never pulse or focus the renderer.
    const deadline = Date.now() + 3000;
    while (panelPixels <= 1000 && Date.now() < deadline) { await delay(50); await capture(); }
  }
  await fs.writeFile(path.join(output, 'interactive-native-window.png'), png);
  evidence.nativeCapture = { backgroundPixels, panelPixels, width: size.width, height: size.height };
  if (isHuya) evidence.nativeCapture.controlsInCrop = true;
  assert.equal(backgroundPixels, 0, 'Native window must not expose the official page backdrop');
  assert.ok(panelPixels > 1000, 'Native window must actually contain the original cyan challenge panel');
  return geometry;
}

async function runHuya() {
  const fields = { phone: '15500000000', countryCode: '+86', accepted: true };
  await mark('sms-prepare');
  await act({ kind: 'mode', mode: 'sms' });
  await poll('SMS form', async () => (await card())?.stage === 'form' && (await card())?.mode === 'sms');
  await act({ kind: 'prepare-sms', ...fields });
  await poll('Official SMS preparation', async () => (await card())?.sms.canSend === true
    && counters().phoneChanges === 1);
  const remote = webContents.fromId(original.remoteId);
  riskUrl = await evaluate(remote, 'location.href');
  assert.equal(riskUrl, 'https://www.huya.com/');
  const loginFrames = remote.mainFrame.framesInSubtree.filter(frame => frame.url === 'https://aq.huya.com/p/udb_login.html');
  assert.equal(loginFrames.length, 1, 'The original official account iframe must exist');
  const accountFrame = loginFrames[0], accountFrameId = accountFrame.frameTreeNodeId;
  const retainedDocument = async () => {
    views();
    assert.equal(await evaluate(remote, 'location.href'), riskUrl, 'Activation must retain the official parent document');
    assert.equal(accountFrame.isDestroyed(), false, 'Activation must retain the official account iframe');
    assert.equal(accountFrame.frameTreeNodeId, accountFrameId);
    assert.equal(await evaluate(accountFrame, 'location.href'), 'https://aq.huya.com/p/udb_login.html', 'Activation must retain the official account document');
  };
  assert.deepEqual(await activation(), { requests: 0, frames: 0, ready: 0, clicks: 0 });
  assert.equal(counters().smsSent, 0);
  await mark('sms-send');
  const activatedAt = Date.now();
  await act({ kind: 'send-sms', ...fields });
  await poll('Automatic render activation', async () => {
    evidence.activation = await activation();
    return evidence.activation?.ready === 1 && (await state())?.presentation === 'captcha';
  }, 10000);
  evidence.activatedWithinMs = Date.now() - activatedAt;
  assert.equal(evidence.activation.requests, 1);
  assert.ok(evidence.activation.frames >= 2);
  assert.equal(evidence.activation.ready, 1);
  assert.equal(evidence.activation.clicks, 0);
  assert.equal(counters().smsSent, 0);
  assert.equal(counters().pendingCaptcha, true);
  assert.equal(counters().phoneChanges, 1);
  await retainedDocument();
  await mark('captcha-interactive');
  // Native synthetic input requires a focused owner. Focus only after automatic activation.
  main.focus();
  await poll('Focused owner for synthetic user input', async () => main.isFocused());
  const geometry = await captureInteractive();
  await clickHuyaCaptcha(remote, geometry);
  await poll('Return to SMS form', async () => (await state())?.presentation === 'form'
    && (await card())?.stage === 'form' && (await card())?.sms.cooldownSeconds === 37
    && counters().smsSent === 1 && counters().pendingCaptcha === false);
  const returned = views();
  assert.equal(returned.local.visible, true);
  assert.equal(returned.remote.visible, false);
  await retainedDocument();
  evidence.activation = await activation();
  assert.equal(evidence.activation.clicks, 1);
  assert.equal(evidence.activation.requests, 1);
  assert.equal(evidence.activation.ready, 1);
  assert.equal(counters().phoneChanges, 1);
  await mark('sms-code');
  await act({ kind: 'sms', ...fields, code: '123456' });
  await poll('Authenticated identity and destroyed views', async () => {
    const result = await bridge('loginStatus');
    return result.ok && result.value.huya.loggedIn === true
      && !webContents.fromId(original.localId) && !webContents.fromId(original.remoteId)
      && (await state()) === null;
  });
  const final = counters();
  assert.equal(final.active, false);
  assert.equal(final.submitted, 0);
  assert.equal(final.smsSent, 1);
  assert.equal(final.verified, 1);
  assert.equal(final.phoneChanges, 1);
  assert.equal(final.mediaRequests, 0);
  evidence.finalCounters = final;
}

async function run() {
  assert.equal(process.env.STREAM_SYNC_E2E, '1');
  assert.equal(process.env.STREAM_SYNC_E2E_VISIBLE, '1', 'Native presentation regression requires explicit visible-window opt-in');
  assert.equal(process.env.STREAM_SYNC_OFFLINE_E2E, '1');
  assert.equal(app.commandLine.hasSwitch('remote-debugging-port'), false, 'No automation endpoint may be opened');
  assert.equal(app.commandLine.hasSwitch('remote-debugging-pipe'), false, 'No automation pipe may be opened');
  app.setPath('userData', process.env.STREAM_SYNC_USER_DATA_DIR);
  app.setPath('sessionData', process.env.STREAM_SYNC_DIRECT_SESSION_DIR);
  app.setPath('temp', process.env.TEMP);
  require(process.env.STREAM_SYNC_DIRECT_MAIN);
  app.setPath('sessionData', process.env.STREAM_SYNC_DIRECT_SESSION_DIR);
  await app.whenReady();
  await mark('await-main');
  await poll('Main bridge', async () => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length !== 1 || !global.__streamSyncerTest) return false;
    main = windows[0];
    if (!main.webContents.getURL().startsWith('app://app/')) return false;
    return evaluate(main.webContents, 'typeof window.streamSyncer?.invoke === "function"');
  }, 30000);
  // windowsHide suppresses the launcher's first native window on Windows.
  // The production scenario requires its user-facing owner window to be visible.
  main.show();
  evidence.showAt = Date.now();
  assert.equal(main.isVisible(), true, 'The disposable user-facing app window must be visible');
  const fixture = global.__streamSyncerTest;
  fixture.setEmbeddedLoginFixture();
  fixture.setEmbeddedLoginFixtureScenario(process.env.STREAM_SYNC_DIRECT_SCENARIO || 'second-factor-render');
  await mark('open-login');
  await evaluate(main.webContents, 'void window.streamSyncer.invoke("login",{platform:' + JSON.stringify(platform) + '}).then(result=>{' +
    'globalThis.__directLoginCompleted=result.ok;}).catch(()=>{globalThis.__directLoginCompleted=false;});true');
  await poll('Local login card', async () => {
    const all = descendants(main.contentView).filter(item => item.view instanceof WebContentsView);
    const local = all.find(item => item.view.webContents.getURL().startsWith('app://login/'));
    if (!local) return false;
    const localState = await evaluate(local.view.webContents, 'window.loginCard?.state()');
    return localState?.stage === 'form';
  });
  const initial = views();
  assert.equal(main.isVisible(), true, 'The owner must remain visible before synthetic input');
  assert.equal(initial.local.visible, true, 'The local credential card must be visible before input');
  assert.equal(initial.remote.visible, false, 'The original official view must remain hidden before input');
  original = { localId: initial.local.view.webContents.id, remoteId: initial.remote.view.webContents.id,
    localSession: initial.local.view.webContents.session, remoteSession: initial.remote.view.webContents.session };
  installCaptureProbe(initial.remote.view.webContents);
  history = setInterval(() => { void state().catch(() => {}); }, 50);
  await state();
  if (isHuya) {
    await runHuya();
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(evidence.presentations.includes('official'), false);
    evidence.complete = { loggedIn: true, viewsDestroyed: true, sameRiskDocument: true, isolatedSessions: true };
    evidence.ok = true;
    await mark('complete');
    return;
  }
  await mark('password-submit');
  await act({ kind: 'password', username: 'fixture-user', password: 'fixture-pass', accepted: true });
  await poll('Standard second factor', async () => (await state())?.presentation === 'verification'
    && (await card())?.stage === 'verification');
  views();
  const remote = webContents.fromId(original.remoteId);
  riskUrl = await evaluate(remote, 'location.href');
  assert.equal(new URL(riskUrl).pathname, '/pc/passport/riskVerify');
  const before = await activation();
  assert.deepEqual(before, { requests: 0, frames: 0, ready: 0, clicks: 0 });
  assert.equal(counters().smsSent, 0);
  const preparation = await card();
  assert.equal(preparation.sms.canSend, false, 'Send must wait for delayed risk captcha preparation');
  const early = await evaluate(webContents.fromId(original.localId), 'window.loginCard.act({kind:"second-send"})');
  assert.equal(early.ok, false, 'Early send must not enter the official empty-captcha branch');
  assert.deepEqual(await activation(), { requests: 0, frames: 0, ready: 0, clicks: 0 });
  await poll('Official captcha preparation', async () => (await card())?.sms.canSend === true);
  await mark('second-factor-send');
  const activatedAt = Date.now();
  await act({ kind: 'second-send' });
  await poll('Automatic render activation', async () => {
    evidence.activation = await activation();
    return evidence.activation?.ready === 1 && (await state())?.presentation === 'captcha';
  }, 10000);
  evidence.activatedWithinMs = Date.now() - activatedAt;
  assert.equal(evidence.activation.requests, 1);
  assert.ok(evidence.activation.frames >= 2);
  assert.equal(evidence.activation.ready, 1);
  assert.equal(evidence.activation.clicks, 0);
  assert.equal(counters().smsSent, 0);
  assert.equal(counters().pendingCaptcha, true);
  assert.equal(await evaluate(remote, 'location.href'), riskUrl, 'Activation must retain the risk document');
  await mark('captcha-interactive');
  await captureInteractive();
  const point = await evaluate(remote, '(() => {const r=document.querySelector("button[data-fixture-captcha]").getBoundingClientRect();' +
    'return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
  const zoom = remote.getZoomFactor(), x = Math.round(point.x * zoom), y = Math.round(point.y * zoom);
  remote.sendInputEvent({ type: 'mouseMove', x, y });
  remote.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  remote.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await poll('Return to second factor', async () => (await state())?.presentation === 'verification'
    && (await card())?.stage === 'verification' && (await card())?.sms.cooldownSeconds === 37
    && counters().smsSent === 1 && counters().pendingCaptcha === false);
  const returned = views();
  assert.equal(returned.local.visible, true);
  assert.equal(returned.remote.visible, false);
  assert.equal(await evaluate(remote, 'location.href'), riskUrl, 'Successful captcha must retain the risk document');
  evidence.activation = await activation();
  assert.equal(evidence.activation.clicks, 1);
  assert.equal(evidence.activation.requests, 1);
  assert.equal(evidence.activation.ready, 1);
  await mark('second-factor-code');
  await act({ kind: 'second-submit', code: '123456' });
  await poll('Authenticated identity and destroyed views', async () => {
    const result = await bridge('loginStatus');
    return result.ok && result.value.bilibili.loggedIn === true
      && !webContents.fromId(original.localId) && !webContents.fromId(original.remoteId)
      && (await state()) === null;
  });
  const final = counters();
  assert.equal(final.active, false);
  assert.equal(final.submitted, 1);
  assert.equal(final.smsSent, 1);
  assert.equal(final.verified, 1);
  assert.equal(final.mediaRequests, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(evidence.presentations.includes('official'), false);
  evidence.complete = { loggedIn: true, viewsDestroyed: true, sameRiskDocument: true, isolatedSessions: true };
  evidence.ok = true;
  await mark('complete');
}

const watchdog = setTimeout(() => app.exit(1), 100000);
run().catch(async error => {
  evidence.failedPhase = phase;
  evidence.failure = error instanceof Error ? error.message : 'Direct regression failed';
  if (original && webContents.fromId(original.remoteId)) {
    evidence.activation = await activation().catch(() => null);
    evidence.failureContext = await diagnosticContext().catch(() => ({ unavailable: true }));
  }
  evidence.phases.push({ phase: 'failed', counters: counters(), ...(original ? { localId: original.localId, remoteId: original.remoteId } : {}) });
}).finally(async () => {
  clearInterval(history);
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  clearTimeout(watchdog);
  process.exitCode = evidence.ok ? 0 : 1;
  app.quit();
  setTimeout(() => app.exit(evidence.ok ? 0 : 1), 3000);
});
`

for (const scenario of ['second-factor-render', 'second-factor-v4', 'huya-captcha-child', 'huya-captcha-parent'] as const) test(`${scenario.startsWith('huya-') ? '虎牙短信' : '二次验证'} ${scenario} 验证码无焦点模拟自动显示并完成原会话登录`, async ({}, testInfo) => {
  test.setTimeout(120_000)
  const id = randomUUID()
  const dataDir = path.join(fixtureRoot, id)
  const isHuya = scenario.startsWith('huya-')
  const evidenceDir = path.join(isHuya ? huyaEvidenceRoot : evidenceRoot, id)
  const bootstrapPath = path.join(evidenceDir, 'bootstrap.cjs')
  const directories = Object.fromEntries(['appData', 'localAppData', 'userData', 'sessionData', 'temp', 'data']
    .map(name => [name, path.join(dataDir, name)]))
  await Promise.all([mkdir(evidenceDir, { recursive: true }), ...Object.values(directories).map(dir => mkdir(dir, { recursive: true }))])
  await writeFile(bootstrapPath, bootstrap)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'NODE_OPTIONS')) as Record<string, string>
  Object.assign(env, {
    STREAM_SYNC_E2E: '1', STREAM_SYNC_E2E_VISIBLE: visibleE2eWindows ? '1' : '0', STREAM_SYNC_OFFLINE_E2E: '1',
    STREAM_SYNC_USER_DATA_DIR: directories.userData,
    STREAM_SYNC_DIRECT_SESSION_DIR: directories.sessionData,
    STREAM_SYNC_DATA_DIR: directories.data,
    STREAM_SYNC_DIRECT_MAIN: path.join(process.env.STREAM_SYNC_E2E_APP_DIR || path.join(projectRoot, 'dist'), 'electron', 'main.cjs'),
    STREAM_SYNC_DIRECT_EVIDENCE: evidenceDir,
    STREAM_SYNC_DIRECT_SCENARIO: scenario,
    STREAM_SYNC_DIRECT_PLATFORM: isHuya ? 'huya' : 'bilibili',
    APPDATA: directories.appData, LOCALAPPDATA: directories.localAppData,
    TEMP: directories.temp, TMP: directories.temp,
  })
  const child = spawn(require('electron') as string, [bootstrapPath, '--autoplay-policy=no-user-gesture-required', '--mute-audio'], {
    cwd: projectRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const phaseLines: string[] = []
  let incomplete = ''
  child.stdout.on('data', (chunk: Buffer) => {
    const lines = (incomplete + chunk.toString()).split(/\r?\n/)
    incomplete = lines.pop() ?? ''
    for (const line of lines) if (line.startsWith('FY1SYNC_DIRECT_PHASE ')) phaseLines.push(line)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  try {
    const exitCode = await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Direct Electron regression exceeded its process deadline')), 110_000)
    })])
    await writeFile(path.join(evidenceDir, 'phases.log'), phaseLines.join('\n') + '\n')
    const result = JSON.parse(await readFile(path.join(evidenceDir, 'result.json'), 'utf8')) as ActivationEvidence
    await testInfo.attach('direct-render-activation', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
    expect(result.ok, `${result.failedPhase ?? 'exit'}: ${result.failure ?? 'Direct regression incomplete'}`).toBe(true)
    expect(exitCode).toBe(0)
    expect(result.activatedWithinMs).toBeLessThanOrEqual(10_000)
    expect(result.activation).toMatchObject({ requests: 1, ready: 1, clicks: 1 })
    expect(result.activation!.frames).toBeGreaterThanOrEqual(2)
    expect(result.presentations).toContain('captcha')
    expect(result.presentations).not.toContain('official')
    expect(result.nativeCapture!.backgroundPixels).toBe(0)
    expect(result.nativeCapture!.panelPixels).toBeGreaterThan(1000)
    if (isHuya) {
      expect(result.nativeCapture!.controlsInCrop).toBe(true)
      expect(result.nativeInput).toEqual({ transport: 'chromium-root-input', events:
        ['mousedown', 'mouseup', 'click'].map(type => ({ type, trusted: true, captcha: true })) })
      expect(result.finalCounters).toMatchObject({ active: false, submitted: 0, smsSent: 1, verified: 1, phoneChanges: 1, mediaRequests: 0 })
      expect(result.actions?.map(action => action.kind)).toEqual(['mode', 'prepare-sms', 'send-sms', 'sms'])
    }
    expect(result.complete).toEqual({ loggedIn: true, viewsDestroyed: true, sameRiskDocument: true, isolatedSessions: true })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited.catch(() => undefined)
    // Only the exact UUID directory allocated by this invocation may be removed.
    if (path.dirname(path.resolve(dataDir)) !== path.resolve(fixtureRoot) || path.basename(dataDir) !== id
      || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid disposable profile cleanup target')
    await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
})
