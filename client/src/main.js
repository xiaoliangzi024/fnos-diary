"use strict";

const { app, BrowserWindow, Menu, ipcMain, session, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { LocalDiary } = require("./local.js");
const { syncOnce, call, apiUrl } = require("./sync.js");
const store = require("./state.js");

/* 免安装版把所有东西（日记数据、设置、浏览器 cookie）都收在 exe 旁边的一个文件夹里，
   不然删掉文件夹 %APPDATA% 下还会留一份带 cookie 的 profile。
   这一步必须在单实例锁之前：那把锁本身就会在 %APPDATA% 下建文件。放不了就退回 %APPDATA%。 */
if (app.isPackaged) {
  const side = path.join(path.dirname(process.execPath), "日记本数据");
  try {
    fs.mkdirSync(side, { recursive: true });
    fs.accessSync(side, fs.constants.W_OK);
    app.setPath("userData", side);
  } catch (e) {
    /* 挪不动（比如装在 Program Files）就用默认位置，日记照样能写 */
  }
}

/* 单实例：第二次双击图标要把已经开着的那扇窗口叫到前面，而不是再起一份本机服务 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => focusMain());
}

const APP_DIR = app.isPackaged ? path.join(process.resourcesPath, "app", "diary", "app") : path.join(__dirname, "..", "..", "diary", "app");

const DATA_DIR = path.join(app.getPath("userData"), "data");
const STATE_FILE = path.join(app.getPath("userData"), "state.json");

let state = store.blank();
let local = null;
let mainWin = null;
let panelWin = null;
let syncing = false;
let autoTimer = null;

/* --------------------------------------------------------------------- 小工具 */

function activeAddr() {
  return state.addresses.find((a) => a.id === state.active) || state.addresses[0] || null;
}

function sesOf(addr) {
  // 没勾"保持登录"就用只存内存的分区，关掉程序 cookie 就跟着没了
  return session.fromPartition(store.partitionOf(addr.base, addr.keep !== false));
}

function remoteFetcher(addr) {
  const ses = sesOf(addr);
  return (url, init) => ses.fetch(url, init);
}

function broadcast(channel, data) {
  for (const w of [mainWin, panelWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, data);
  }
}

function saveState() {
  try {
    store.save(STATE_FILE, state);
  } catch (e) {
    /* 存不进去只影响游标，下次全量重取一遍，不会写坏日记 */
  }
}

function loginOf(addr) {
  return addr ? state.logins[addr.base] || null : null;
}

/** 面板和主窗口都要看到的那份状态（不含任何口令、cookie） */
function publicState() {
  const addr = activeAddr();
  const log = loginOf(addr);
  return {
    addresses: state.addresses.map((a) => ({
      id: a.id,
      base: a.base,
      root: a.root,
      name: a.name || "",
      active: a.id === state.active,
      keep: a.keep !== false,
      uid: (state.logins[a.base] || {}).uid || "",
      username: (state.logins[a.base] || {}).username || "",
      last: state.last[a.base] || null,
    })),
    every: state.every,
    syncing,
    clientUid: local ? local.uid : "local",
    shownName: (log && log.username) || (local && local.uid !== "local" ? "账号 " + local.uid : "本机（还没登录）"),
    dataDir: DATA_DIR,
    needsLogin: !!addr && !(state.logins[addr.base] || {}).uid,
  };
}

function notify() {
  fullState().then((s) => broadcast("client:state", s));
}

/** 本机还有多少处没传上去：让他一眼看见"待同步"，别让没同步的日记悄悄躺着 */
async function pendingCount() {
  const addr = activeAddr();
  const acc = addr ? state.logins[addr.base] : null;
  if (!addr || !acc) return 0;
  const st = store.accountState(state, addr.base, acc.uid);
  const r = await call(local.fetcher, "GET", apiUrl(local.base, "/api/changes?since=" + encodeURIComponent(st.pushCursor || "") + "&limit=500"));
  if (!r.ok) return 0;
  const j = r.json;
  return (j.updated || []).length + (j.deleted || []).length + (j.cats || []).length + (j.catsDeleted || []).length + (j.more ? 1 : 0);
}

async function fullState() {
  return Object.assign(publicState(), { pending: await pendingCount() });
}

/* ------------------------------------------------------------------- NAS 地址 */

/** 他只要把网址粘进来：带不带 /app/diary 都认，认不出来才报错 */
async function resolveBase(fetcher, input) {
  const raw = String(input || "").trim();
  if (!raw) return { error: "先填写 NAS 的网址" };
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch (e) {
    return { error: "网址格式不对，形如 https://你的飞牛域名 或 http://192.168.1.100:5666" };
  }
  const origin = u.origin;
  const tail = u.pathname.replace(/\/+$/, "");
  const cands = [];
  if (/\/app\/diary$/i.test(tail)) cands.push(origin + tail);
  else if (tail) cands.push(origin + tail, origin + "/app/diary");
  else cands.push(origin + "/app/diary", origin);

  let portalHit = "";
  for (const c of cands) {
    const r = await call(fetcher, "GET", apiUrl(c, "/api/info"));
    if (r.ok) {
      if (r.json.client) return { error: "这是另一台电脑上的日记本客户端，要填 NAS 上那一份的地址" };
      if (!r.json.syncApi) return { error: "这台 NAS 上的日记本是 " + r.json.version + " 版，先在 NAS 上升级到 0.4.1 以上" };
      return { base: c, info: r.json };
    }
    if (r.portal && !portalHit) portalHit = c;
  }
  // 拿到的是网页而不是接口：多半是没登录，地址照收，登录之后再同步
  if (portalHit) return { base: portalHit, needLogin: true };
  return { error: "在这个地址上没找到日记本，检查一下网址或者换成 NAS 的网址" };
}

async function probeLogin(addr) {
  const fetcher = remoteFetcher(addr);
  const info = await call(fetcher, "GET", apiUrl(addr.base, "/api/info"));
  if (!info.ok) return { online: false, portal: !!info.portal, error: info.error };
  const who = await call(fetcher, "GET", apiUrl(addr.base, "/api/session"));
  const uid = who.json ? String(who.json.uid || "") : "";
  if (!who.ok || !/^\d{1,12}$/.test(uid)) return { online: true, portal: true };
  return { online: true, uid, username: who.json.username || "" };
}

/** 认下这条地址当前登录的账号；只有这条正在用，才把本机服务切到那个账号名下 */
async function rememberLogin(addr) {
  const p = await probeLogin(addr);
  if (!p.uid) return null;
  const prev = state.logins[addr.base];
  if (!prev || prev.uid !== p.uid || prev.username !== p.username) {
    state.logins[addr.base] = { uid: p.uid, username: p.username };
    saveState();
  }
  if (addr.id === state.active && state.shownUid !== p.uid) {
    state.shownUid = p.uid;
    await local.setUid(p.uid);
    reloadMain();
    saveState();
  }
  notify();
  return state.logins[addr.base];
}

/* ------------------------------------------------------------------------ 同步 */

/** 本机服务得跟上「当前在用」这条地址的账号，不然切了地址还在往上一个账号写 */
async function applyActiveAccount() {
  const addr = activeAddr();
  return addr ? rememberLogin(addr) : null;
}

async function runSync(reason) {
  const addr = activeAddr();
  if (!addr) return { ok: false, error: "还没有填写 NAS 地址，先在「同步与设置」里加一条" };
  if (syncing) return { ok: false, busy: true, error: "上一次同步还没结束" };

  const fetcher = remoteFetcher(addr);
  const lines = [];
  const log = (s) => {
    lines.push(s);
    if (lines.length > 200) lines.shift();
    broadcast("client:log", { line: s });
  };
  if (!(state.logins[addr.base] || {}).uid) await rememberLogin(addr);
  const acc = state.logins[addr.base] || null;

  syncing = true;
  broadcast("client:sync", { running: true, reason: reason || "" });
  let out;
  try {
    if (!acc) {
      const p = await probeLogin(addr);
      // portal 表示地址是通的、只是还没登录；两种 online 状态都算没登录，不算连不上
      out = p.portal
        ? { ok: false, needsLogin: true, error: "这台 NAS 还没登录，点「登录 NAS」输一次口令" }
        : { ok: false, error: "连不上这台 NAS：" + (p.error || "不在局域网里，远程地址也没通") };
    } else {
      const st = store.accountState(state, addr.base, acc.uid);
      out = await syncOnce({
        local: { base: local.base, fetch: local.fetcher },
        remote: { base: addr.base, fetch: fetcher },
        state: st,
        log,
      });
      if (out.ok) {
        const moved = (out.pull.updated || 0) + (out.pull.deleted || 0) + (out.pull.cats || 0) + (out.pull.catsDeleted || 0);
        // 取到新东西让页面自己刷：正在写的那篇不能被他刚打的字没了一半来换
        if (moved) broadcast("client:pull", out.pull);
      }
    }
  } catch (e) {
    out = { ok: false, error: "同步出错了：" + ((e && e.message) || e) };
  }
  out.at = new Date().toISOString();
  out.reason = reason || "";
  out.messages = lines;
  syncing = false;
  state.last[addr.base] = { at: out.at, ok: !!out.ok, error: out.error || "", needsLogin: !!out.needsLogin, pulled: out.pull ? out.pull.updated : 0, pushed: out.push ? out.push.pushed : 0 };
  saveState();
  broadcast("client:sync", out);
  notify();
  return out;
}

/* ------------------------------------------------------------------ 登录窗口 */

function openLogin(addr) {
  const ses = sesOf(addr);
  const w = new BrowserWindow({
    width: 1000,
    height: 780,
    title: "登录 NAS",
    autoHideMenuBar: true,
    parent: mainWin || undefined,
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
  });
  w.loadURL(addr.root);
  let done = false;
  const timer = setInterval(async () => {
    if (done || w.isDestroyed()) return;
    const p = await probeLogin(addr).catch(() => null);
    if (p && p.uid) {
      done = true;
      clearInterval(timer);
      w.close();
      rememberLogin(addr).then(() => runSync("登录后"));
    }
  }, 2000);
  w.on("closed", () => {
    clearInterval(timer);
    done = true;
  });
  return w;
}

async function logout(addr) {
  if (!addr) return;
  try {
    await sesOf(addr).clearStorageData({ storages: ["cookies"] });
  } catch (e) {}
  delete state.logins[addr.base];
  delete state.last[addr.base];
  saveState();
  notify();
}

/* ------------------------------------------------------------------- 本机界面 */

function reloadMain() {
  if (!mainWin || mainWin.isDestroyed()) return;
  // 换账号会重启本机服务、端口跟着变，用 reload() 会刷回那个已经死掉的旧端口
  mainWin.loadURL(local.base + "/");
}

function openMain() {
  mainWin = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 380,
    minHeight: 560,
    title: "日记本",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWin.loadURL(local.base + "/");
  mainWin.on("closed", () => {
    mainWin = null;
  });
  // 页面上所有链接都在本机窗口里打开，别让点了个网址就换了窗口
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.focus();
    notify();
    return;
  }
  panelWin = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 360,
    minHeight: 480,
    title: "同步与设置",
    autoHideMenuBar: true,
    parent: mainWin || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload-panel.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWin.loadFile(path.join(__dirname, "..", "ui", "panel.html"));
  panelWin.webContents.on("did-finish-load", () => notify());
  panelWin.on("closed", () => {
    panelWin = null;
  });
}

function focusMain() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.focus();
}

function buildMenu() {
  const template = [
    {
      label: "设置",
      submenu: [
        { label: "立即同步到 NAS", accelerator: "CommandOrControl+Shift+S", click: () => runSync("菜单") },
        { label: "NAS 地址与同步间隔", accelerator: "CommandOrControl+,", click: () => openPanel() },
        { label: "打开本机日记文件夹", click: () => shell.openPath(DATA_DIR) },
        { type: "separator" },
        { label: "退出", accelerator: "CommandOrControl+Q", click: () => app.quit() },
      ],
    },
    {
      label: "查看",
      submenu: [
        { label: "刷新列表", accelerator: "CommandOrControl+R", click: () => reloadMain() },
        { role: "toggleDevTools", label: "调试工具" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ----------------------------------------------------------------------- IPC */

function registerIpc() {
  const h = (channel, fn) => ipcMain.handle(channel, async (e, arg) => fn(arg));

  h("client:state", async () => fullState());
  h("client:open-panel", () => openPanel());
  h("client:sync", () => runSync("按钮"));
  /* 顶栏那个按钮显示「要登录」时点它就该直接出登录窗，而不是又跑一次注定失败的同步 */
  h("client:login-active", () => {
    const a = activeAddr();
    if (!a) {
      openPanel();
      return { error: "还没添加 NAS 地址" };
    }
    openLogin(a);
    return { ok: true };
  });

  h("client:add-address", async ({ url, name }) => {
    const r = await resolveBase((u, i) => session.defaultSession.fetch(u, i), url);
    if (r.error) return { error: r.error };
    const addr = { id: store.newAddressId(), root: new URL(r.base).origin, base: r.base, name: String(name || "").slice(0, 20) };
    state.addresses.push(addr);
    const becameActive = !state.active;
    if (becameActive) state.active = addr.id;
    saveState();
    // 只有这条被切成「在用」才认它的账号，加一条备用地址不该把本机日记换到别人名下
    const acc = becameActive ? await applyActiveAccount() : null;
    notify();
    return { ok: true, id: addr.id, base: addr.base, needLogin: !!r.needLogin && !acc, version: r.info ? r.info.version : "" };
  });

  h("client:remove-address", async (id) => {
    const a = state.addresses.find((x) => x.id === id);
    state.addresses = state.addresses.filter((x) => x.id !== id);
    if (a) {
      delete state.logins[a.base];
      delete state.last[a.base];
    }
    if (state.active === id) state.active = state.addresses.length ? state.addresses[0].id : "";
    saveState();
    await applyActiveAccount();
    return fullState();
  });

  h("client:pick-address", async (id) => {
    if (state.addresses.some((x) => x.id === id)) {
      state.active = id;
      saveState();
      await applyActiveAccount();
      notify();
    }
    return fullState();
  });

  h("client:move-address", ({ id, delta }) => {
    const i = state.addresses.findIndex((x) => x.id === id);
    const j = i + Number(delta || 0);
    if (i < 0 || j < 0 || j >= state.addresses.length) return fullState();
    const list = state.addresses;
    list.splice(j, 0, list.splice(i, 1)[0]);
    saveState();
    notify();
    return fullState();
  });

  h("client:rename-address", ({ id, name }) => {
    const a = state.addresses.find((x) => x.id === id);
    if (a) {
      a.name = String(name || "").slice(0, 20);
      saveState();
    }
    notify();
    return fullState();
  });

  h("client:keep", async ({ id, keep }) => {
    const a = state.addresses.find((x) => x.id === id);
    if (a) {
      // 改这个开关等于换了一种存 cookie 的方式，分区对不上，登录状态先清掉重来
      a.keep = !!keep;
      try {
        await session.fromPartition(store.partitionOf(a.base, true)).clearStorageData({ storages: ["cookies"] });
        await session.fromPartition(store.partitionOf(a.base, false)).clearStorageData({ storages: ["cookies"] });
      } catch (e) {}
      delete state.logins[a.base];
      saveState();
    }
    notify();
    return fullState();
  });

  h("client:test-address", async (id) => {
    const a = state.addresses.find((x) => x.id === id);
    if (!a) return { error: "这条地址已经不在了" };
    const p = await probeLogin(a);
    if (!p.online) return p.portal ? { ok: false, needLogin: true } : { error: p.error || "连不上这条地址" };
    if (p.uid) {
      const acc = await rememberLogin(a);
      return { ok: true, uid: acc.uid, username: acc.username };
    }
    return { ok: false, needLogin: true };
  });

  h("client:login", (id) => {
    const a = state.addresses.find((x) => x.id === id);
    if (!a) return { error: "先加一条 NAS 地址" };
    openLogin(a);
    return { ok: true };
  });

  h("client:logout", async (id) => {
    const a = state.addresses.find((x) => x.id === id);
    await logout(a);
    return fullState();
  });

  h("client:every", (min) => {
    const n = Number(min);
    if (!store.EVERY.includes(n)) return fullState();
    state.every = n;
    saveState();
    setupAuto();
    notify();
    return fullState();
  });

  h("client:open-data", () => {
    shell.openPath(DATA_DIR);
    return { ok: true };
  });

  h("client:info", () => ({ base: local ? local.base : "", uid: local ? local.uid : "local" }));
}

function setupAuto() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  const min = Number(state.every) || 0;
  if (min <= 0) return;
  autoTimer = setInterval(() => {
    if (syncing) return;
    if (!activeAddr()) return;
    if (!(state.logins[activeAddr().base] || {}).uid) return;
    runSync("自动");
  }, min * 60 * 1000);
}

/* ------------------------------------------------------------------- 启动收尾 */

app.on("window-all-closed", () => app.quit());

let quitPlanned = false;
app.on("before-quit", (e) => {
  const addr = activeAddr();
  const logged = addr && (state.logins[addr.base] || {}).uid;
  if (quitPlanned || !logged || syncing) return;
  // 写完日记直接关窗口的话，临走把这一篇送上去，别留在本机等下次开机。
  // preventDefault 必须在这一行就调用，放到 await 后面就来不及了
  e.preventDefault();
  quitPlanned = true;
  Promise.race([runSync("退出前"), new Promise((r) => setTimeout(r, 6000))])
    .catch(() => {})
    .then(() => app.quit());
});

app.on("will-quit", () => {
  if (autoTimer) clearInterval(autoTimer);
  if (local) local.stop();
});

app
  .whenReady()
  .then(async () => {
    state = store.load(STATE_FILE);
    local = new LocalDiary({ appDir: APP_DIR, dataRoot: DATA_DIR, uid: state.shownUid || "local" });
    await local.start();
    registerIpc();
    buildMenu();
    openMain();
    setupAuto();
    const addr = activeAddr();
    if (addr) {
      const acc = await rememberLogin(addr);
      if (acc) runSync("启动后");
    }
  })
  .catch((e) => {
    const { dialog } = require("electron");
    dialog.showErrorBox("日记本打不开", String((e && e.message) || e));
    app.quit();
  });
