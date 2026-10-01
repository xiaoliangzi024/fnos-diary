"use strict";

/* Windows 客户端真机端到端实测。
   起两台"假 NAS"（每台 = 真 server.js + 一层带登录门的网关代理，网关负责注入 X-Trim-Userid），
   再起真 Electron，从调试端口驱动真界面：填网址、点登录、点保存、点同步、换地址、换账号、退出登录、窄屏。
   跑法：node client/test/shell-e2e.js */

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..");
const ROOT = path.join(CLIENT, "..");
const SERVER_JS = path.join(ROOT, "diary", "app", "server", "server.js");
const TMP = path.join(__dirname, ".data-shell");
const USER_DATA = path.join(TMP, "user-data");
const CDP_PORT = 9333;

/* 同一套流程既能测源码，也能测打包出来的免安装版：E2E_EXE 指过去就行 */
const PACKAGED = !!process.env.E2E_EXE;
const EXE = PACKAGED ? process.env.E2E_EXE : path.join(CLIENT, "node_modules", "electron", "dist", "electron.exe");
const SIDE_DATA = PACKAGED ? path.join(path.dirname(EXE), "日记本数据") : null;
const LOCAL_DATA = PACKAGED ? path.join(SIDE_DATA, "data") : path.join(USER_DATA, "data");
const STATE_JSON = path.join(PACKAGED ? SIDE_DATA : USER_DATA, "state.json");
const E2E_ARGS = PACKAGED
  ? ["--remote-debugging-port=" + CDP_PORT]
  : [CLIENT, "--user-data-dir=" + USER_DATA, "--remote-debugging-port=" + CDP_PORT];

const NAS = { gw1: 5210, srv1: 5211, gw2: 5212, srv2: 5213 };
const UID1 = 9001;
const UID2 = 9002;
const NAME1 = "飞牛用户甲";
const NAME2 = "飞牛用户乙";

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : ""));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 小工具 */

function req(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        method,
        path: u.pathname + u.search,
        headers: Object.assign({}, headers, data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let j = null;
          try {
            j = JSON.parse(buf);
          } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, json: j, text: buf });
        });
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

const kids = [];
function spawnLogged(cmd, args, opts, logName) {
  const fd = fs.openSync(path.join(TMP, logName), "a");
  const p = spawn(cmd, args, Object.assign({ stdio: ["ignore", fd, fd] }, opts));
  kids.push(p);
  return p;
}

/** NAS 上某个账号写了哪些标题（直接读硬盘，不看界面） */
function titlesOn(dir, uid) {
  const d = path.join(dir, "u" + uid, "entries");
  if (!fs.existsSync(d)) return null;
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")).title);
}

/** 模拟飞牛的统一网关：没登录一律给登录页，登录后才把请求转给日记本并注入用户身份 */
const PORTAL = '<!doctype html><meta charset="utf-8"><title>飞牛私有云</title><h1>请先登录</h1><a id="go-login" href="/login">登录</a>';
function gateway(listenPort, srvPort, uid, username, cookie) {
  const s = http.createServer((rq, rs) => {
    const has = String(rq.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .includes(cookie + "=1");
    if (rq.url === "/login") {
      rs.writeHead(302, { Location: "/", "Set-Cookie": cookie + "=1; Path=/" });
      rs.end();
      return;
    }
    if (!/^\/app\/diary([/?]|$)/.test(rq.url)) {
      rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      rs.end(has ? '<!doctype html><meta charset="utf-8"><h1>飞牛桌面</h1>' : PORTAL);
      return;
    }
    if (!has) {
      rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      rs.end(PORTAL);
      return;
    }
    const pr = http.request(
      {
        host: "127.0.0.1",
        port: srvPort,
        method: rq.method,
        path: rq.url,
        headers: Object.assign({}, rq.headers, { "X-Trim-Userid": String(uid), "X-Trim-Username": encodeURIComponent(username), host: "127.0.0.1:" + srvPort }),
      },
      (up) => {
        rs.writeHead(up.statusCode, up.headers);
        up.pipe(rs);
      }
    );
    pr.on("error", () => {
      rs.writeHead(502, { "Content-Type": "text/plain" });
      rs.end("网关断了");
    });
    rq.pipe(pr);
  });
  return new Promise((r) => s.listen(listenPort, "127.0.0.1", r)).then(() => s);
}

async function waitNas(port) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await req("GET", "http://127.0.0.1:" + port + "/app/diary/api/info", undefined, { "X-Trim-Userid": String(UID1) });
      if (r.json && r.json.version) return r.json;
    } catch (e) {}
    if (Date.now() - t0 > 15000) throw new Error("假 NAS " + port + " 起不来");
    await sleep(150);
  }
}

/* ------------------------------------------------------------------ CDP */

async function targets() {
  try {
    const r = await req("GET", "http://127.0.0.1:" + CDP_PORT + "/json/list");
    return Array.isArray(r.json) ? r.json : [];
  } catch (e) {
    return [];
  }
}

function cdp(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch (e) {}
      reject(new Error("CDP 超时 " + method));
    }, 30000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method, params: params || {} })));
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== 1) return;
      clearTimeout(timer);
      try {
        ws.close();
      } catch (e) {}
      if (m.error) reject(new Error(method + "：" + m.error.message));
      else resolve(m.result);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP 连不上"));
    });
  });
}

const RE_MAIN = /^http:\/\/127\.0\.0\.1:\d+\/app\/diary/;
const RE_PANEL = /panel\.html$/;

async function findPage(re, label, ms) {
  const t0 = Date.now();
  for (;;) {
    const hit = (await targets()).filter((t) => t.type === "page" && re.test(t.url));
    if (hit.length) return hit[hit.length - 1];
    if (Date.now() - t0 > (ms || 30000)) throw new Error("找不到窗口：" + label);
    await sleep(250);
  }
}

async function evalJs(re, label, expr, ms) {
  const t = await findPage(re, label, ms);
  const r = await cdp(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception || {};
    throw new Error(label + " 里脚本报错：" + (d.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

const inMain = (expr, ms) => evalJs(RE_MAIN, "主窗口", expr, ms);
const inPanel = (expr, ms) => evalJs(RE_PANEL, "设置面板", expr, ms);

/** 点顶栏的同步。同步拉到东西时主窗口会自己刷新，页面上下文可能当场没了，所以拿不到结果就轮询状态 */
async function syncFromMain() {
  let out = null;
  try {
    out = await inMain(
      "window.diaryClient.sync().then(o => ({ ok: !!o.ok, error: o.error || '', pull: o.pull || null, push: o.push || null, needsLogin: !!o.needsLogin }))",
      90000
    );
  } catch (e) {
    out = null;
  }
  if (out) return out;
  const s = await until(
    "同步跑完",
    () => inMain("window.diaryClient.state().then(s => s.syncing ? null : { done: true, value: s })"),
    60000
  );
  return { ok: true, pulledNothing: true, pending: s.pending };
}

/** 等主窗口界面重新就绪（换账号、拉到新内容都会刷新页面），再动手写 */
function uiReady() {
  return until(
    "主窗口界面就绪",
    () =>
      inMain(
        js(`(() => { const b = document.getElementById("btn-sync"), n = document.getElementById("btn-new");
          return b && n ? { done: true, value: b.textContent.trim() } : null; })()`)
      ),
    60000
  );
}

/** 等主窗口界面重新就绪（换账号、拉到新内容都会刷新页面）后，看列表里有没有某个标题 */
function feedHas(title, ms) {
  return until(
    "列表里出现「" + title + "」",
    () =>
      inMain(
        js(`(() => { const b = document.getElementById("btn-sync"); if (!b) return null;
          return document.body.innerText.indexOf(${JSON.stringify(title)}) >= 0 ? { done: true, value: { badge: b.textContent.trim(), who: document.getElementById("who").textContent } } : null; })()`)
      ),
    ms || 40000
  ).catch(() => null);
}

/** 列表里确认没有某个标题 */
async function feedLacks(title, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 4000)) {
    const hit = await inMain(
      js(`(() => { const b = document.getElementById("btn-sync"); if (!b) return null; return document.body.innerText.indexOf(${JSON.stringify(title)}) >= 0 ? 1 : 0; })()`)
    ).catch(() => null);
    if (hit === 1) return false;
    await sleep(300);
  }
  return true;
}

/** 轮询到界面满足条件为止，超时就把最后一次值吐出来 */
async function until(label, fn, ms) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last && last.done) return last.value;
    } catch (e) {
      last = { error: e.message };
    }
    if (Date.now() - t0 > (ms || 30000)) throw new Error("等不到：" + label + "  最后看到 " + JSON.stringify(last));
    await sleep(300);
  }
}

const js = (s) => s; // 只是给 IDE 标一下后面是页面里跑的 JS

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  if (PACKAGED) {
    console.log("测的是打包出来的免安装版：" + EXE);
    fs.rmSync(SIDE_DATA, { recursive: true, force: true });
  }

  const nasDirs = [path.join(TMP, "nas1"), path.join(TMP, "nas2")];
  nasDirs.forEach((d) => fs.mkdirSync(d, { recursive: true }));

  const s1 = spawnLogged(process.execPath, [SERVER_JS], { env: Object.assign({}, process.env, { DATA_DIR: nasDirs[0], PORT: String(NAS.srv1), GATEWAY_PREFIX: "/app/diary" }) }, "nas1.log");
  const s2 = spawnLogged(process.execPath, [SERVER_JS], { env: Object.assign({}, process.env, { DATA_DIR: nasDirs[1], PORT: String(NAS.srv2), GATEWAY_PREFIX: "/app/diary" }) }, "nas2.log");
  const g1 = await gateway(NAS.gw1, NAS.srv1, UID1, NAME1, "gwa");
  const g2 = await gateway(NAS.gw2, NAS.srv2, UID2, NAME2, "gwb");
  await waitNas(NAS.srv1);
  await waitNas(NAS.srv2);
  console.log("两台假 NAS 起来了（网关 " + NAS.gw1 + "/" + NAS.gw2 + "）");

  const ej = spawnLogged(EXE, E2E_ARGS, { cwd: CLIENT }, "electron.log");
  let ejExit = null;
  ej.on("exit", (code) => (ejExit = code));
  console.log("Electron 启动中…");

  await until(
    "主窗口界面就绪",
    () =>
      inMain(
        js(`(() => { const b = document.getElementById("btn-sync");
          const v = { title: document.title, url: location.href, body: document.body ? document.body.innerText.slice(0, 120) : "(没有 body)" };
          return b ? { done: true, value: v } : { value: v }; })()`)
      ),
    60000
  );

  /* ---- 1. 还没填网址：同步按钮在，并且提醒要登录 ---- */
  let st = await inMain(
    js(`(() => { const b = document.getElementById("btn-sync");
      return { hidden: b.classList.contains("hidden"), text: b.textContent.trim(), display: getComputedStyle(b).display }; })()`)
  );
  ok("主窗口标题是日记本", (await inMain("document.title")) === "日记本");
  /* 原生菜单条 CDP 看不到，直接查源码：他说左上角那个不该叫「日记本」 */
  const menuSrc = fs.readFileSync(path.join(CLIENT, "src", "main.js"), "utf8");
  const menuLabel = ((menuSrc.match(/function buildMenu\(\)[\s\S]{0,220}/) || [""])[0].match(/label:\s*"([^"]+)"/) || [])[1];
  ok("窗口菜单第一栏不叫「日记本」（跟页面标题撞名）", menuLabel === "设置", menuLabel);
  ok("客户端模式下同步按钮可见", st.hidden === false && st.display !== "none", st);
  ok("没填网址时按钮写「要登录」", st.text === "要登录", st);
  const stSet = await inMain(
    js(`(() => { const b = document.getElementById("btn-settings");
      return b ? { hidden: b.classList.contains("hidden"), text: b.textContent.trim(), display: getComputedStyle(b).display } : null; })()`)
  );
  ok("顶栏有「设置」按钮（不用去翻窗口菜单）", stSet && stSet.hidden === false && stSet.display !== "none" && stSet.text === "设置", stSet);

  /* ---- 2. 登录前先在本机写一篇（之后登录要挪到账号名下并补传） ---- */
  const T_PRE = "登录之前在本机写的";
  const w1 = await inMain(
    js(`(async () => {
      const q = (id) => document.getElementById(id);
      q("btn-new").click();
      await new Promise(r => setTimeout(r, 400));
      q("title").value = ${JSON.stringify(T_PRE)};
      q("body").value = "还没连 NAS 的时候写的，看登录后会不会自己补传上去。";
      q("body").dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      q("btn-save").click();
      await new Promise(r => setTimeout(r, 1800));
      return { status: q("status").textContent, badge: q("btn-sync").textContent.trim() };
    })()`)
  );
  ok("没登录也能写、能保存", /已保存/.test(w1.status), w1);
  ok("没登录时按钮还是「要登录」，不虚报待传", w1.badge === "要登录", w1);

  /* ---- 3. 点顶栏「设置」打开面板，只粘网址根地址 ---- */
  await inMain(
    js(`(async () => { const b = document.getElementById("btn-settings"); if (!b) return "no-btn"; b.click(); await new Promise(r => setTimeout(r, 1200)); return "clicked"; })()`)
  );
  await until("面板出现", () => inPanel("document.readyState === 'complete' ? {done:true, value: document.title} : null", 30000));
  ok("面板标题是同步与设置", (await inPanel("document.title")) === "同步与设置");
  ok("空状态有提示", (await inPanel("document.getElementById('empty-hint').style.display")) !== "none");
  ok("网址输入框里没有示例网址当已填内容", (await inPanel("document.getElementById('new-url').value")) === "");

  /* ---- 3b. 自动同步间隔：档位由界面选，选完存本机 ---- */
  const allow = require(path.join(CLIENT, "src", "state.js")).EVERY;
  const evShow = await inPanel(
    js(`(() => { const s = document.getElementById("every");
      return { opts: [...s.options].map(o => Number(o.value)), texts: [...s.options].map(o => o.text), value: s.value }; })()`)
  );
  ok("面板上的间隔档位和主进程白名单一模一样", evShow.opts.join(",") === allow.join(","), { panel: evShow.opts, allow });
  ok("每一档都写着中文（没有英文数字光秃秃的）", evShow.texts.every((t) => /分钟|小时|关闭/.test(t)), evShow.texts);
  ok("默认选中的是 5 分钟", evShow.value === "5", evShow);

  const evOff = await inPanel(
    js(`(async () => { const s = document.getElementById("every"); s.value = "0";
      s.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r => setTimeout(r, 1600));
      return { value: s.value, log: document.getElementById("log").innerText }; })()`)
  );
  ok("选「关闭」以后下拉框停在关闭（主进程认了这个值）", evOff.value === "0", evOff);
  ok("选「关闭」写进了本机 state.json", JSON.parse(fs.readFileSync(STATE_JSON, "utf8")).every === 0, evOff);
  ok("面板同步记录里说了改成什么", /关闭/.test(evOff.log), evOff.log);

  const evBack = await inPanel(
    js(`(async () => { const s = document.getElementById("every"); s.value = "5";
      s.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r => setTimeout(r, 1600)); return s.value; })()`)
  );
  ok("改回 5 分钟也存下来了", evBack === "5" && JSON.parse(fs.readFileSync(STATE_JSON, "utf8")).every === 5, evBack);

  const add1 = await inPanel(
    js(`(async () => {
      document.getElementById("new-url").value = "http://127.0.0.1:${NAS.gw1}";
      document.getElementById("new-name").value = "家里的飞牛";
      document.getElementById("btn-add").click();
      await new Promise(r => setTimeout(r, 4000));
      return {
        addrs: document.querySelectorAll("#addrs .addr").length,
        msg: document.getElementById("add-msg").textContent,
        badge: document.getElementById("state-badge").textContent.trim(),
        acct: document.getElementById("account-line").textContent,
        row: document.querySelector("#addrs .addr") ? document.querySelector("#addrs .addr").innerText.replace(/\\s+/g, " ") : "",
        log: document.getElementById("log").innerText,
      };
    })()`)
  );
  ok("只填根地址也能加上（自己找到 /app/diary）", add1.addrs === 1 && /app\/diary/.test(add1.row), add1);
  ok("加地址没有报错文案", add1.msg === "", add1);
  ok("面板徽章：需要登录", add1.badge === "需要登录", add1);
  ok("地址行显示「还没登录」", /还没登录/.test(add1.row), add1);

  /* ---- 4. 点「登录 NAS」：登录窗出来，在假门户里过登录门 ---- */
  await inPanel(
    js(`(async () => { document.querySelector('#addrs .addr button[data-act="login"]').click(); await new Promise(r => setTimeout(r, 1200)); })()`)
  );
  const loginT = await findPage(/^http:\/\/127\.0\.0\.1:5210\b/, "登录窗口", 20000);
  ok("登录窗口开在 NAS 根地址上", /127\.0\.0\.1:5210/.test(loginT.url), loginT.url);
  const wasPortal = await cdp(loginT.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "!!document.getElementById('go-login')", returnByValue: true });
  ok("没登录时拿到的是飞牛登录页", wasPortal.result.value === true);
  await cdp(loginT.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "document.getElementById('go-login').click()", returnByValue: true });

  // 主进程每 2 秒探一次登录态，探到会切账号 + 自动同步一次
  const logged = await until(
    "登录成功后面板变绿",
    () =>
      inPanel(
        js(`(() => { const b = document.getElementById("state-badge").textContent.trim();
          const r = document.querySelector("#addrs .addr").innerText.replace(/\\s+/g, " ");
          return /已经同步好了|还有 \\d+ 处/.test(b) && /已登录/.test(r) ? { done: true, value: { badge: b, row: r, acct: document.getElementById("account-line").textContent } } : null; })()`)
      ),
    45000
  );
  ok("登录窗口认到 NAS 账号", /已登录：.*飞牛用户甲/.test(logged.row), logged);
  ok("面板写明本机现在放的是谁的日记", /飞牛用户甲/.test(logged.acct), logged);
  const loginWinGone = await until(
    "登录完自动关窗",
    async () => {
      const t = (await targets()).filter((x) => /127\.0\.0\.1:5210/.test(x.url));
      return t.length ? null : { done: true, value: true };
    },
    20000
  );
  ok("登录成功后登录窗口自己关掉", loginWinGone === true);

  /* ---- 5. 换账号后本机那份要跟着切：ulocal 目录挪到 u9001，先写一篇要在待传里看得见 ---- */
  ok("登录前写的挪到了账号名下（ulocal 已没了）", !fs.existsSync(path.join(USER_DATA, "data", "ulocal")));
  const preLocal = titlesOn(LOCAL_DATA, UID1) || [];
  ok("本机 u9001 里有登录前那篇", preLocal.includes(T_PRE), preLocal);

  // 登录后本机服务换了账号会重启一次，主窗口正在刷新，等它重新就绪
  const badge1 = await until(
    "主窗口同步按钮落到稳定状态",
    () =>
      inMain(
        js(`(() => { const b = document.getElementById("btn-sync"); if (!b) return null;
          const x = b.textContent.trim(); return x === "同步中…" ? null : { done: true, value: x }; })()`)
      ),
    60000
  );
  ok("登录前写的日记要么还在待传、要么已被自动同步清掉", /^待传 \d+$/.test(badge1) || badge1 === "同步", badge1);

  /* ---- 6. 再写一篇，点同步，NAS 硬盘上应出现 ---- */
  const T_PUSH = "客户端写的要传NAS";
  await uiReady();
  const w2 = await inMain(
    js(`(async () => {
      const q = (id) => document.getElementById(id);
      q("btn-new").click();
      await new Promise(r => setTimeout(r, 400));
      q("title").value = ${JSON.stringify(T_PUSH)};
      q("body").value = "在 Windows 客户端写的第二篇。";
      q("body").dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      q("btn-save").click();
      await new Promise(r => setTimeout(r, 1500));
      return { status: q("status").textContent, badgeAfterSave: q("btn-sync").textContent.trim() };
    })()`, 60000)
  );
  ok("保存成功", /已保存/.test(w2.status), w2);
  ok("保存后按钮立刻显出「待传」（不用等同步广播）", /^待传 \d+$/.test(w2.badgeAfterSave), w2);
  const out2 = await syncFromMain();
  ok("点同步成功", out2.ok === true, out2);
  const badge2 = await until(
    "同步跑完后按钮落定",
    () =>
      inMain(
        js(`(() => { const b = document.getElementById("btn-sync"); if (!b) return null; const x = b.textContent.trim(); return x === "同步中…" ? null : { done: true, value: x }; })()`)
      ),
    40000
  );
  ok("同步干净了：按钮回到「同步」，不再写待传", badge2 === "同步", badge2);
  const nas1Titles = titlesOn(nasDirs[0], UID1) || [];
  ok("NAS 上收得到这两篇", nas1Titles.includes(T_PUSH) && nas1Titles.includes(T_PRE), nas1Titles);

  /* ---- 7. NAS 上写的，取回到本机 ---- */
  const T_FROM_NAS = "NAS上写的要取回";
  const catR = await req("GET", "http://127.0.0.1:" + NAS.srv1 + "/app/diary/api/categories", undefined, { "X-Trim-Userid": String(UID1) });
  const catId = (catR.json.items || [])[0] ? catR.json.items[0].id : "";
  const postR = await req(
    "POST",
    "http://127.0.0.1:" + NAS.srv1 + "/app/diary/api/entry",
    { date: new Date().toISOString().slice(0, 10), cat: catId, title: T_FROM_NAS, body: "在 NAS 网页上写的，看客户端能不能取回本机。" },
    { "X-Trim-Userid": String(UID1), "X-Trim-Username": encodeURIComponent(NAME1) }
  );
  ok("直接往假 NAS 写一篇成功", postR.json && postR.json.entry, postR.json);
  const pulled = await syncFromMain();
  ok("同步跑完了", pulled.ok === true, pulled);
  ok("本机 u9001 里也有这篇了", (titlesOn(LOCAL_DATA, UID1) || []).includes(T_FROM_NAS), titlesOn(LOCAL_DATA, UID1));
  const feed7 = await feedHas(T_FROM_NAS);
  ok("取回的日记出现在本机列表里（界面自己刷新了）", !!feed7, feed7);
  ok("顶栏显示的是 NAS 账号名，不是本机的假名字", feed7 && /飞牛用户甲/.test(String(feed7.who)), feed7);

  /* ---- 8. 加第二条地址（先不切过去，账号不该被带走） ---- */
  const add2 = await inPanel(
    js(`(async () => {
      document.getElementById("new-url").value = "http://127.0.0.1:${NAS.gw2}/app/diary";
      document.getElementById("new-name").value = "公司的飞牛";
      document.getElementById("btn-add").click();
      await new Promise(r => setTimeout(r, 4000));
      return { n: document.querySelectorAll("#addrs .addr").length, acct: document.getElementById("account-line").textContent, badge: document.getElementById("state-badge").textContent.trim() };
    })()`)
  );
  ok("第二条地址加上（带 /app/diary 也认）", add2.n === 2, add2);
  ok("加备用地址不会把本机日记换到别人名下", /飞牛用户甲/.test(add2.acct) && add2.badge !== "", add2);

  /* ---- 9. 换网址 + 换账号：登录第二条，再切过去 ---- */
  await inPanel(
    js(`(async () => { document.querySelectorAll('#addrs .addr')[1].querySelector('button[data-act="login"]').click(); await new Promise(r => setTimeout(r, 1200)); })()`)
  );
  const loginT2 = await findPage(/^http:\/\/127\.0\.0\.1:5212/, "第二个登录窗口", 20000);
  ok("第二条地址的登录窗开在它自己的地址上", /5212/.test(loginT2.url), loginT2.url);
  await cdp(loginT2.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "document.getElementById('go-login').click()", returnByValue: true });
  await sleep(3500);
  const twoRows = await inPanel(
    js(`(() => { const rs = [...document.querySelectorAll("#addrs .addr")].map(r => r.innerText.replace(/\\s+/g, " ")); return { rows: rs, acct: document.getElementById("account-line").textContent, cur: document.querySelector("#addrs .addr.cur") ? document.querySelector("#addrs .addr.cur").innerText.replace(/\\s+/g," ").slice(0,12) : "" }; })()`)
  );
  ok("第二条也显示已登录（乙）", /已登录：.*飞牛用户乙/.test(twoRows.rows[1] || ""), twoRows.rows);
  ok("还没点「用这条」时，本机依旧放甲的日记", /飞牛用户甲/.test(twoRows.acct), twoRows);
  ok("当前在用的还是第一条", /家里的飞牛/.test(twoRows.cur), twoRows);

  const switched = await inPanel(
    js(`(async () => {
      document.querySelectorAll('#addrs .addr')[1].querySelector('button[data-act="pick"]').click();
      await new Promise(r => setTimeout(r, 4000));
      return { badge: document.getElementById("state-badge").textContent.trim(), acct: document.getElementById("account-line").textContent };
    })()`)
  );
  ok("点「用这条」后本机换到乙名下", /飞牛用户乙/.test(switched.acct), switched);
  const goneJia = (await feedLacks(T_PUSH, 8000)) && (await feedLacks(T_FROM_NAS, 4000));
  ok("换账号后甲的日记不再显示（各人各一份）", goneJia === true);
  ok("甲那份数据还在硬盘上，没被删", (titlesOn(LOCAL_DATA, UID1) || []).includes(T_PUSH));

  /* ---- 10. 在乙账号下同步：把乙 NAS 的日记取回本机 ---- */
  const T_NAS2 = "乙NAS上的日记";
  await req(
    "POST",
    "http://127.0.0.1:" + NAS.srv2 + "/app/diary/api/entry",
    { date: new Date().toISOString().slice(0, 10), cat: "", title: T_NAS2, body: "第二台 NAS 上本来就有的。" },
    { "X-Trim-Userid": String(UID2), "X-Trim-Username": encodeURIComponent(NAME2) }
  );
  const s2out = await syncFromMain();
  ok("换到第二条地址后同步成功", s2out.ok === true, s2out);
  ok("第二台 NAS 的日记取到本机硬盘了", (titlesOn(LOCAL_DATA, UID2) || []).includes(T_NAS2), titlesOn(LOCAL_DATA, UID2));
  const feed10 = await feedHas(T_NAS2);
  ok("乙 NAS 的日记显示在列表里", !!feed10, feed10);
  ok("顶栏换成了乙", feed10 && /飞牛用户乙/.test(String(feed10.who)), feed10);

  /* ---- 11. 退出登录：还能写，写下来的不算丢，重新登录后补传 ---- */
  const out11 = await inPanel(
    js(`(async () => { document.querySelectorAll('#addrs .addr')[1].querySelector('button[data-act="logout"]').click(); await new Promise(r => setTimeout(r, 2500)); return { badge: document.getElementById("state-badge").textContent.trim(), rows: [...document.querySelectorAll("#addrs .addr")].map(r => r.innerText.replace(/\\s+/g," ")) }; })()`)
  );
  ok("退出后面板变「需要登录」", out11.badge === "需要登录", out11);
  ok("退出后这条地址显示还没登录", /还没登录/.test(out11.rows[1] || ""), out11.rows);

  const T_OFFLINE = "退出登录期间写的";
  await uiReady();
  const w3 = await inMain(
    js(`(async () => {
      const q = (id) => document.getElementById(id);
      q("btn-new").click();
      await new Promise(r => setTimeout(r, 400));
      q("title").value = ${JSON.stringify(T_OFFLINE)};
      q("body").value = "退出登录的时候照样写，等重新登录再补传。";
      q("body").dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      q("btn-save").click();
      await new Promise(r => setTimeout(r, 1500));
      return { status: q("status").textContent, badge: q("btn-sync").textContent.trim() };
    })()`)
  );
  ok("退出登录照样能写能保存", /已保存/.test(w3.status), w3);
  ok("没登录时不虚报待传", w3.badge === "要登录", w3);

  /* 他报的真 bug：按钮写着「要登录」，点下去却只是又跑一次同步、什么都不弹。
     现在点它必须直接出登录窗。 */
  const clicked = await inMain(
    js(`(async () => { const b = document.getElementById("btn-sync"); if (!b) return "no-btn"; const t = b.textContent.trim(); b.click(); await new Promise(r => setTimeout(r, 1500)); return t; })()`)
  );
  ok("主窗口按钮此时确实写着「要登录」", clicked === "要登录", clicked);
  const loginT3 = await findPage(/^http:\/\/127\.0\.0\.1:5212/, "点「要登录」弹出的登录窗", 20000);
  const stillPortal = await cdp(loginT3.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "!!document.getElementById('go-login')", returnByValue: true });
  ok("退出登录后 cookie 真清了，还要过一次登录门", stillPortal.result.value === true);
  await cdp(loginT3.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "document.getElementById('go-login').click()", returnByValue: true });

  const backOn = await inMain(
    js(`(async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500));
        const b = document.getElementById("btn-sync");
        if (!b) continue;
        const x = b.textContent.trim();
        if (/^待传 \\d+$/.test(x) || x === "同步") return { badge: x };
      }
      const bb = document.getElementById("btn-sync");
      return { badge: bb ? bb.textContent.trim() : "(页面一直没就绪)", timeout: true };
    })()`, 60000)
  );
  ok("重新登录后按钮不再写「要登录」", backOn.badge !== "要登录" && !backOn.timeout, backOn);
  ok("重新登录后，退出期间写的那篇进待传或被自动传走", /^待传 \d+$/.test(backOn.badge) || backOn.badge === "同步", backOn);
  const flushed = await syncFromMain();
  ok("补传成功", flushed.ok === true, flushed);
  ok("第二台 NAS 收到了退出期间写的那篇", (titlesOn(nasDirs[1], UID2) || []).includes(T_OFFLINE), titlesOn(nasDirs[1], UID2));

  /* ---- 12. 窄屏实测（这是改了顶栏按钮必须过的关） ---- */
  // Electron 的调试端口不接 Browser.getWindowForTarget，改用视口模拟，宽度是真的
  async function setViewport(target, w, h) {
    await cdp(target.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
  }
  async function clearViewport(target) {
    try {
      await cdp(target.webSocketDebuggerUrl, "Emulation.clearDeviceMetricsOverride", {});
    } catch (e) {}
  }
  const mainT = await findPage(RE_MAIN, "主窗口");
  await setViewport(mainT, 400, 760);
  const narrow = await inMain(
    js(`(() => { const de = document.documentElement; const b = document.getElementById("btn-sync"); const r = b.getBoundingClientRect();
      const s = document.getElementById("btn-settings"); const sr = s.getBoundingClientRect();
      return { sw: de.scrollWidth, iw: window.innerWidth, right: Math.round(r.right), bw: Math.round(r.width), text: b.textContent.trim(), cs: getComputedStyle(b).display,
        sRight: Math.round(sr.right), sWidth: Math.round(sr.width), sText: s.textContent.trim(), sH: Math.round(sr.height) }; })()`)
  );
  ok("窄屏 400 宽：页面不横向溢出", narrow.sw <= narrow.iw + 1, narrow);
  ok("窄屏 400 宽：同步按钮还在视区内", narrow.bw > 0 && narrow.cs !== "none" && narrow.right <= narrow.iw + 1, narrow);
  ok("窄屏 400 宽：设置按钮也在视区内、字没被拆成两行", narrow.sWidth > 0 && narrow.sRight <= narrow.iw + 1 && narrow.sH <= 44 && narrow.sText === "设置", narrow);
  await cdp(mainT.webSocketDebuggerUrl, "Page.enable", {});
  const shotMain = await cdp(mainT.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(TMP, "窄屏-主窗口.png"), Buffer.from(shotMain.data, "base64"));
  await clearViewport(mainT);
  /* 桌面宽度再截一张：顶栏按钮从 5 个变 6 个，得亲眼看看排不排得下 */
  await setViewport(mainT, 1180, 700);
  await sleep(600);
  const wide = await inMain(
    js(`(() => { const b = document.getElementById("btn-sync"), s = document.getElementById("btn-settings");
      const rb = b.getBoundingClientRect(), rs = s.getBoundingClientRect();
      return { overlap: rb.right > rs.left + 1 && rb.left < rs.right && Math.abs(rb.top - rs.top) < 2, top: Math.round(rs.top), iw: window.innerWidth, sRight: Math.round(rs.right) }; })()`)
  );
  ok("桌面宽度：同步和设置两个按钮不叠在一起", wide.overlap === false, wide);
  await cdp(mainT.webSocketDebuggerUrl, "Page.enable", {});
  const shotWide = await cdp(mainT.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1180, height: 120, scale: 1 } });
  fs.writeFileSync(path.join(TMP, "宽屏-顶栏.png"), Buffer.from(shotWide.data, "base64"));
  await clearViewport(mainT);
  /* 他报的：加了「设置」按钮之后左上角「日记本」被挤成两行。多档宽度都量一遍 */
  for (const w of [1280, 1180, 1000, 900, 800, 700, 400]) {
    await setViewport(mainT, w, 700);
    await sleep(500);
    const b = await inMain(
      js(`(() => { const n = document.getElementById("brand-name"); const r = n.getBoundingClientRect();
        const s = document.getElementById("btn-settings"); const sr = s.getBoundingClientRect();
        const box = document.getElementById("search").getBoundingClientRect();
        return { h: Math.round(r.height), rects: n.getClientRects().length, text: n.textContent, iw: window.innerWidth,
          sw: document.documentElement.scrollWidth, sameRow: Math.abs(sr.top - r.top) < 20, searchW: Math.round(box.width) }; })()`)
    );
    ok("宽度 " + w + "：「日记本」标题没被拆成两行", b.rects === 1 && b.h <= 30 && b.text === "日记本", b);
    ok("宽度 " + w + "：页面不横向溢出", b.sw <= b.iw + 1, b);
    /* 1080 以上必须还是一整行；再窄就允许整组换行，但不许拆字 */
    ok("宽度 " + w + "：" + (w > 1080 ? "顶栏是一整行" : "换行后按钮仍在视区内"), w > 1080 ? b.sameRow === true : b.sameRow === false, b);
    if (w >= 1080) ok("宽度 " + w + "：搜索框缩了但还能打字", b.searchW >= 160, b);
  }
  await setViewport(mainT, 1300, 700);
  await sleep(500);
  const shotWide2 = await cdp(mainT.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1300, height: 70, scale: 1 } });
  fs.writeFileSync(path.join(TMP, "顶栏-1300宽.png"), Buffer.from(shotWide2.data, "base64"));
  await setViewport(mainT, 1000, 700);
  await sleep(500);
  const shot1000 = await cdp(mainT.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1000, height: 130, scale: 1 } });
  fs.writeFileSync(path.join(TMP, "顶栏-1000宽.png"), Buffer.from(shot1000.data, "base64"));
  await clearViewport(mainT);

  const panelT = await findPage(RE_PANEL, "面板");
  await setViewport(panelT, 360, 640);
  const narrow2 = await inPanel(
    js(`(() => { const de = document.documentElement; const ev = document.getElementById("every"); return { sw: de.scrollWidth, iw: window.innerWidth, badge: document.getElementById("state-badge").textContent.trim(), evRight: Math.round(ev.getBoundingClientRect().right), evText: ev.options[ev.selectedIndex].text, rows: [...document.querySelectorAll("#addrs .addr")].map(r => Math.round(r.getBoundingClientRect().right)) }; })()`)
  );
  ok("面板 360 宽不横向溢出", narrow2.sw <= narrow2.iw + 1, narrow2);
  ok("面板 360 宽：同步间隔下拉框在视区内、选中的还是那一档", narrow2.evRight <= narrow2.iw + 1 && /分钟|关闭|小时/.test(narrow2.evText), narrow2);
  ok("面板 360 宽：地址行不超出视区", narrow2.rows.every((x) => x <= narrow2.iw + 1), narrow2);
  await cdp(panelT.webSocketDebuggerUrl, "Page.enable", {});
  const shotPanel = await cdp(panelT.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(TMP, "窄屏-设置面板.png"), Buffer.from(shotPanel.data, "base64"));

  /* ---- 12b. 选 1 分钟：不点任何按钮，它自己该把新写的传上去 ---- */
  await inPanel(
    js(`(async () => { const s = document.getElementById("every"); s.value = "1";
      s.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r => setTimeout(r, 800)); return s.value; })()`)
  );
  await uiReady();
  const T_AUTO = "选一分钟自动传的";
  await inMain(
    js(`(async () => {
      const q = (id) => document.getElementById(id);
      q("btn-new").click();
      await new Promise(r => setTimeout(r, 400));
      q("title").value = ${JSON.stringify(T_AUTO)};
      q("body").value = "写完什么都不点，看它自己传不传。";
      q("body").dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      q("btn-save").click();
      await new Promise(r => setTimeout(r, 1500));
      return q("status").textContent;
    })()`)
  );
  ok(
    "选「每 1 分钟」后，不点同步它自己传上去了",
    (await until(
      "NAS 上出现「" + T_AUTO + "」",
      () => ((titlesOn(nasDirs[1], UID2) || []).includes(T_AUTO) ? { done: true, value: true } : null),
      110000
    )) === true
  );

  /* 选「关闭」以后就该真的不自己跑：写下一篇，短时间里 NAS 上不该出现 */
  await inPanel(
    js(`(async () => { const s = document.getElementById("every"); s.value = "0";
      s.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r => setTimeout(r, 800)); return s.value; })()`)
  );
  const T_NOAUTO = "关了自动同步之后写的";
  await uiReady();
  await inMain(
    js(`(async () => {
      const q = (id) => document.getElementById(id);
      q("btn-new").click();
      await new Promise(r => setTimeout(r, 400));
      q("title").value = ${JSON.stringify(T_NOAUTO)};
      q("body").value = "自动同步关了，这篇该一直留在本机等我手动传。";
      q("body").dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      q("btn-save").click();
      await new Promise(r => setTimeout(r, 1500));
      return { status: q("status").textContent, badge: q("btn-sync").textContent.trim() };
    })()`)
  );
  await sleep(20000);
  const badgeOff = await inMain(js(`(() => document.getElementById("btn-sync").textContent.trim())()`));
  ok("关掉自动同步：这一篇老实等着，按钮写着待传", /^待传 \d+$/.test(badgeOff) && !(titlesOn(nasDirs[1], UID2) || []).includes(T_NOAUTO), {
    badgeOff,
    onNas: (titlesOn(nasDirs[1], UID2) || []).includes(T_NOAUTO),
  });
  ok("关掉自动同步写进了 state.json", JSON.parse(fs.readFileSync(STATE_JSON, "utf8")).every === 0);
  await inPanel(
    js(`(async () => { const s = document.getElementById("every"); s.value = "5";
      s.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r => setTimeout(r, 800)); })()`)
  );

  /* ---- 13. 写完直接关窗口：临走把这篇送上去 ---- */
  const T_QUIT = "关窗口前那一篇";
  await uiReady();
  await inMain(
    js(`(async () => {
      const q = (id) => document.getElementById(id);
      q("btn-new").click();
      await new Promise(r => setTimeout(r, 400));
      q("title").value = ${JSON.stringify(T_QUIT)};
      q("body").value = "写完不点同步，直接关窗口。";
      q("body").dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      q("btn-save").click();
      await new Promise(r => setTimeout(r, 1500));
      return q("status").textContent;
    })()`)
  );
  const pages = (await targets()).filter((t) => t.type === "page");
  for (const p of pages) {
    try {
      await cdp(p.webSocketDebuggerUrl, "Page.close", {});
    } catch (e) {}
  }
  const t0 = Date.now();
  while (!ejExit && Date.now() - t0 < 40000) await sleep(300);
  ok("关掉所有窗口后程序自己退出", ejExit !== null, ejExit);
  ok("退出前把那一篇带上了 NAS", (titlesOn(nasDirs[1], UID2) || []).includes(T_QUIT), titlesOn(nasDirs[1], UID2));

  console.log("\n数据留在 " + TMP + "，两个窄屏截图在那儿。");
}

const timers = [];

main()
  .catch((e) => {
    fail++;
    console.log("\n!! 测试中断：" + ((e && e.stack) || e));
  })
  .then(() => {
    for (const p of kids) {
      try {
        p.kill();
      } catch (e) {}
    }
    console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
    setTimeout(() => process.exit(fail ? 1 : 0), 500);
  });
