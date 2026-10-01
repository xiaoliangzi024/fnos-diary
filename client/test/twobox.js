const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

/* ------------------------------------------------------------------------------
   假装有两台电脑：起一份真的 server.js 当 NAS，再起两份 TRUST_UID 的本机实例
   当 A、B 两台客户端，然后拿 sync.js 真的来回同步，逐条核对硬盘上的结果。
   引擎里每一条规则都得在这里被"做坏一次"验过，不然到了真机上才发现。
   跑法：cd client && npm run test:box
------------------------------------------------------------------------------ */

const SERVER = process.env.SERVER_JS || path.join(__dirname, "..", "..", "diary", "app", "server", "server.js");
const ROOT = path.join(__dirname, ".data");
const NAV = "9001";
const OTHER = "9002";
const P = { nas: 5101, a: 5102, b: 5103, nas2: 5104, portal: 5105, c: 5106, old: 5107, dead: 5199 };

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

const { syncOnce, call, apiUrl } = require("../src/sync.js");

function store(port, uid) {
  const base = "http://127.0.0.1:" + port + "/app/diary";
  const heads = uid ? { "X-Trim-Userid": String(uid) } : {};
  return {
    base,
    fetch: (url, opts) =>
      fetch(url, Object.assign({}, opts, { headers: Object.assign({}, heads, (opts && opts.headers) || {}) })),
  };
}

async function api(st, method, route, body) {
  const r = await call(st.fetch, method, apiUrl(st.base, route), body);
  if (!r.ok) throw new Error(route + " 调用失败：" + JSON.stringify(r).slice(0, 300));
  return r.json;
}

async function write(st, opts) {
  const body = Object.assign({ date: "2026-10-01", title: "无题", body: "正文" }, opts);
  const r = await call(st.fetch, "POST", apiUrl(st.base, "/api/entry"), body);
  if (!r.ok) throw new Error("写日记失败：" + JSON.stringify(r).slice(0, 300));
  return r.json;
}

async function addCat(st, name, opts) {
  const r = await call(st.fetch, "POST", apiUrl(st.base, "/api/categories"), Object.assign({ name }, opts || {}));
  if (!r.ok) throw new Error("建栏目失败：" + JSON.stringify(r).slice(0, 300));
  return r.json.item;
}

async function renameCat(st, id, name, updatedAt) {
  const r = await call(st.fetch, "POST", apiUrl(st.base, "/api/categories/rename"), { id, name, updatedAt });
  if (!r.ok) throw new Error("改栏目名失败：" + JSON.stringify(r).slice(0, 300));
  return r.json;
}

async function posts(st) {
  const j = await api(st, "GET", "/api/posts?limit=100");
  return j.items;
}

async function catList(st) {
  const j = await api(st, "GET", "/api/categories");
  return j.items;
}

/** 拿全文：标题+正文+栏目名，比对结果就看这个 */
async function texts(st) {
  const out = [];
  for (const p of await posts(st)) {
    const j = await api(st, "GET", "/api/entry?id=" + p.id);
    out.push({ id: p.id, title: j.entry.title, body: j.entry.body, cat: j.entry.catName, date: j.entry.date });
  }
  out.sort((a, b) => (a.title < b.title ? -1 : 1));
  return out;
}

async function byTitle(st, title) {
  const hit = (await texts(st)).find((x) => x.title === title);
  return hit || null;
}

const logLines = [];
const log = (s) => logLines.push(s);
const hadLog = (part) => logLines.some((s) => s.indexOf(part) >= 0);

function start(name, port, dataDir, trustUid) {
  const fd = fs.openSync(path.join(ROOT, name + ".log"), "a");
  const env = Object.assign({}, process.env, {
    DATA_DIR: dataDir,
    PORT: String(port),
    GATEWAY_PREFIX: "/app/diary",
    BIND_HOST: "127.0.0.1",
  });
  if (trustUid) env.TRUST_UID = trustUid;
  const p = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", fd, fd] });
  p.on("exit", (code) => {
    if (!shuttingDown) console.log("!! " + name + " 服务退出了 code=" + code + "  看 " + name + ".log");
  });
  procs.push(p);
  return p;
}

const procs = [];
let shuttingDown = false;

async function waitUp(st, dataDir) {
  const want = String(dataDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const t0 = Date.now();
  for (;;) {
    try {
      const j = await api(st, "GET", "/api/info");
      // 认一下数据目录：端口被上一个没死干净的测试进程占着时，这一步会拦下来，
      // 不然所有断言都在测旧代码
      if (String(j.dataDir).replace(/\\/g, "/").replace(/\/+$/, "") === want) return j;
      throw new Error("端口 " + st.base + " 上是别的东西（dataDir=" + j.dataDir + "）");
    } catch (e) {
      if (e.message && e.message.indexOf("别的东西") >= 0) throw e;
      if (Date.now() - t0 > 10000) throw new Error(st.base + " 起不来：" + (e.message || e));
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}

function fakePortal(port) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body>飞牛登录页</body></html>");
    });
    s.listen(port, "127.0.0.1", () => resolve(s));
    servers.push(s);
  });
}
const servers = [];

function newState() {
  return { pullCursor: "", pushCursor: "", catMap: {} };
}

async function sync(st, remote, state, name) {
  const out = await syncOnce({ local: st, remote, state, log });
  if (!out.ok) throw new Error("同步[" + name + "]没成功：" + out.error);
  return out;
}

/* ---------------------------------------------------------------------- 场景 */

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const D = (n) => path.join(ROOT, n);
  const dirs = { nas: D("nas"), nas2: D("nas2"), a: D("a"), b: D("b"), c: D("c") };

  start("nas", P.nas, dirs.nas, "");
  start("nas2", P.nas2, dirs.nas2, "");
  start("a", P.a, dirs.a, NAV);
  start("b", P.b, dirs.b, NAV);
  start("c", P.c, dirs.c, OTHER);
  await Promise.all([
    waitUp(store(P.nas, NAV), dirs.nas),
    waitUp(store(P.nas2, NAV), dirs.nas2),
    waitUp(store(P.a), dirs.a),
    waitUp(store(P.b), dirs.b),
    waitUp(store(P.c, OTHER), dirs.c),
    fakePortal(P.portal),
  ]);

  const nas = store(P.nas, NAV);
  const nas2 = store(P.nas2, NAV);
  const A = store(P.a);
  const B = store(P.b);
  const C = store(P.c);
  const noLogin = store(P.portal);
  const nowhere = store(P.dead);

  console.log("\n[1] 客户端本机那份不该有默认栏目");
  ok("本机实例一打开没有「日常/工作/学习」", (await catList(A)).length === 0, await catList(A));
  ok("NAS 上还是那三条默认栏目（网页端行为没变）", (await catList(nas)).map((c) => c.name).join(",") === "日常,工作,学习");
  const infoA = await api(A, "GET", "/api/info");
  ok("本机那份自称是客户端", infoA.client === 1, infoA);
  ok("NAS 那份不冒充客户端", (await api(nas, "GET", "/api/info")).client === 0);
  // 本机随便一个程序伪造 X-Trim-Userid 也换不了账号：账号是启动时钉死的
  const spoof = store(P.a, "1001");
  ok("本机实例不认请求头里的账号", (await api(spoof, "GET", "/api/session")).uid === NAV, await api(spoof, "GET", "/api/session"));
  ok("伪造账号看到的还是同一份日记", JSON.stringify(await texts(spoof)) === JSON.stringify(await texts(A)));

  console.log("\n[2] 第一次同步：NAS 上已有的东西整份拉到本机");
  const fish = await addCat(nas, "钓鱼");
  await write(nas, { title: "NAS 上的旧日记", body: "装客户端之前就有的", cat: fish.id });
  const stA = newState();
  await sync(A, nas, stA, "A→NAS 首同步");
  const t2 = await texts(A);
  ok("本机拿到了 NAS 的栏目", (await catList(A)).some((c) => c.name === "钓鱼"), await catList(A));
  ok("本机拿到了 NAS 的日记", t2.some((x) => x.title === "NAS 上的旧日记"), t2);
  ok("拉过来的日记还在「钓鱼」里", (t2.find((x) => x.title === "NAS 上的旧日记") || {}).cat === "钓鱼", t2);
  ok("本机栏目编号直接沿用 NAS 的", stA.catMap[fish.id] === fish.id, stA.catMap);
  ok("第二次同步没有新东西", (await sync(A, nas, stA, "A 再同步")).pull.updated === 0);

  console.log("\n[3] 离线写东西 → 联网补传，NAS 上不该多出重复栏目");
  const offlineCat = await addCat(A, "夜钓");
  await write(A, { title: "离线写的第一篇", body: "飞机上写的", cat: offlineCat.id });
  await write(A, { title: "离线写的第二篇", body: "还是没网", cat: offlineCat.id });
  const r3 = await sync(A, nas, stA, "A 补传");
  ok("两篇都传上去了", r3.push.pushed === 2, r3.push);
  const nasT3 = await texts(nas);
  ok("NAS 上能看到离线写的内容", nasT3.filter((x) => x.title.indexOf("离线写的") === 0).length === 2, nasT3);
  ok("离线新建的栏目在 NAS 上只有一条", (await catList(nas)).filter((c) => c.name === "夜钓").length === 1, await catList(nas));
  ok("NAS 上这两篇归在「夜钓」里", nasT3.filter((x) => x.title.indexOf("离线写的") === 0).every((x) => x.cat === "夜钓"), nasT3);
  ok("本机没多出重复栏目", (await catList(A)).filter((c) => c.name === "夜钓").length === 1);

  console.log("\n[4] 第二台设备：B 同步一次就该和 A 看到一样的东西");
  const stB = newState();
  await sync(B, nas, stB, "B 首同步");
  const ta = await texts(A);
  const tb = await texts(B);
  ok("B 拿到了 A 离线写的内容", tb.some((x) => x.title === "离线写的第一篇"), tb);
  ok("A、B 两份内容逐篇一致", JSON.stringify(ta) === JSON.stringify(tb), { ta, tb });
  ok("B 的栏目列表和 NAS 一致", (await catList(B)).map((c) => c.name).sort().join() === (await catList(nas)).map((c) => c.name).sort().join());
  await write(B, { title: "B 上写的", body: "在另一台电脑上", cat: (await catList(B)).find((c) => c.name === "夜钓").id });
  await sync(B, nas, stB, "B 补传");
  await sync(A, nas, stA, "A 拉 B 的");
  ok("A 拿到了 B 写的那篇", (await texts(A)).some((x) => x.title === "B 上写的"), await texts(A));
  ok("B 那篇归在「夜钓」，没跑到未分类", (await byTitle(A, "B 上写的")).cat === "夜钓");

  console.log("\n[5] 同名栏目：本机自己建过「读书」，NAS 上也有一条「读书」");
  const readNas = await addCat(nas, "读书");
  const readA = await addCat(A, "读书");
  await write(A, { title: "本机读书篇", body: "离线建的栏目下写的", cat: readA.id });
  await sync(A, nas, stA, "A 合并同名栏目");
  ok("NAS 上「读书」只有一条", (await catList(nas)).filter((c) => c.name === "读书").length === 1, await catList(nas));
  ok("本机「读书」也对上了 NAS 那条", stA.catMap[readA.id] === readNas.id, stA.catMap);
  ok("本机也只有一条「读书」", (await catList(A)).filter((c) => c.name === "读书").length === 1, await catList(A));
  ok("合并之后日记还在，栏目名没变", ((await byTitle(nas, "本机读书篇")) || {}).cat === "读书");

  console.log("\n[6] 栏目改名要双向同步");
  await renameCat(nas, fish.id, "海钓");
  await sync(A, nas, stA, "A 拉改名");
  ok("NAS 改成「海钓」，本机跟着改", (await catList(A)).some((c) => c.name === "海钓"), await catList(A));
  ok("本机不再有旧的「钓鱼」", !(await catList(A)).some((c) => c.name === "钓鱼"));
  ok("改名后原日记还在，没掉进未分类", ((await byTitle(A, "NAS 上的旧日记")) || {}).cat === "海钓");
  const localCat = (await catList(A)).find((c) => c.name === "海钓");
  await renameCat(A, localCat.id, "台钓");
  await sync(A, nas, stA, "A 推改名");
  ok("本机改名传到了 NAS", (await catList(nas)).some((c) => c.name === "台钓"), await catList(nas));
  await sync(B, nas, stB, "B 拉改名");
  ok("第三台设备也跟上来了", (await catList(B)).some((c) => c.name === "台钓"), await catList(B));

  console.log("\n[7] 旧设备补传的改名不能盖掉新名字");
  await renameCat(B, (await catList(B)).find((c) => c.name === "台钓").id, "矶钓", "2020-01-01T00:00:00.000Z");
  await sync(B, nas, stB, "B 补传旧改名");
  ok("NAS 上还是「台钓」，没被旧名字顶掉", (await catList(nas)).some((c) => c.name === "台钓"), await catList(nas));

  console.log("\n[8] 删栏目：日记一篇都不能丢，也不能被旧设备救回来");
  const tempCat = await addCat(A, "临时");
  await write(A, { title: "临时栏目下的日记", body: "删栏目要看它去哪", cat: tempCat.id });
  await sync(A, nas, stA, "A 建临时栏目");
  const nasTemp = (await catList(nas)).find((c) => c.name === "临时");
  await api(nas, "POST", "/api/categories/delete", { id: nasTemp.id });
  await sync(B, nas, stB, "B 先删掉本机那份");
  await sync(A, nas, stA, "A 拉删除");
  ok("NAS 上「临时」没了", !(await catList(nas)).some((c) => c.name === "临时"), await catList(nas));
  ok("本机「临时」也跟着没了", !(await catList(A)).some((c) => c.name === "临时"), await catList(A));
  const keep = await byTitle(A, "临时栏目下的日记");
  ok("栏目下的日记没丢", !!keep, await texts(A));
  ok("日记退到了别的栏目而不是未分类", keep && keep.cat !== "未分类", keep);
  await sync(B, nas, stB, "B 再拉一次");
  ok("另一台设备不会把删掉的栏目救回来", !(await catList(B)).some((c) => c.name === "临时"), await catList(B));
  ok("编号对照表里把删掉的栏目清掉了", Object.values(stA.catMap).indexOf(nasTemp.id) < 0, stA.catMap);

  console.log("\n[8b] 本机删掉的栏目，同步后 NAS 上也要没有、别再被建回来");
  const wkCat = await addCat(A, "周末");
  await write(A, { title: "周末写的日记", body: "栏目删了我得跟着搬", cat: wkCat.id });
  await sync(A, nas, stA, "A 建周末栏目");
  ok("NAS 上有了「周末」", (await catList(nas)).some((c) => c.name === "周末"), await catList(nas));
  const wkNasId = stA.catMap[wkCat.id];
  await api(A, "POST", "/api/categories/delete", { id: wkCat.id });
  await sync(A, nas, stA, "A 删掉本机栏目后同步");
  ok("NAS 上「周末」被删掉了", !(await catList(nas)).some((c) => c.name === "周末"), await catList(nas));
  await sync(A, nas, stA, "A 再空跑一次");
  ok("对齐不会把删掉的栏目重新建回去", !(await catList(nas)).some((c) => c.name === "周末"), await catList(nas));
  ok("本机那条日记没丢，跟着搬进别的栏目", !!(await byTitle(nas, "周末写的日记")), await texts(nas));
  ok("搬走的这篇在 NAS 上的栏目和本机一致", ((await byTitle(nas, "周末写的日记")) || {}).cat === ((await byTitle(A, "周末写的日记")) || {}).cat, {
    nas: await byTitle(nas, "周末写的日记"),
    a: await byTitle(A, "周末写的日记"),
  });
  ok("对照表里不留死栏目", !stA.catMap[wkCat.id] && Object.values(stA.catMap).indexOf(wkNasId) < 0, stA.catMap);

  console.log("\n[9] 删日记：另一台设备上不能回来");
  const gone = await write(A, { title: "这篇要删掉", body: "删完看它会不会复活" });
  await sync(A, nas, stA, "A 传这篇");
  ok("NAS 上先有这篇", !!(await byTitle(nas, "这篇要删掉")));
  await call(A.fetch, "DELETE", apiUrl(A.base, "/api/entry?id=" + gone.entry.id));
  await sync(A, nas, stA, "A 传删除");
  ok("NAS 上这篇没了", !(await byTitle(nas, "这篇要删掉")), await texts(nas));
  await sync(B, nas, stB, "B 拉删除");
  ok("B 上这篇也没了", !(await byTitle(B, "这篇要删掉")), await texts(B));

  console.log("\n[10] 同一篇两台都改：谁改得晚谁赢，旧的补传盖不掉新的");
  const shared = await write(nas, { title: "两个人都改的日记", body: "初稿" });
  await sync(A, nas, stA, "A 拉这篇");
  await sync(B, nas, stB, "B 拉这篇");
  await write(A, { id: shared.entry.id, title: "两个人都改的日记", body: "A 改的（新）", date: "2026-10-01" });
  await sync(A, nas, stA, "A 先传");
  await write(B, { id: shared.entry.id, title: "两个人都改的日记", body: "B 改的（旧）", date: "2026-10-01", updatedAt: "2020-06-01T00:00:00.000Z" });
  await sync(B, nas, stB, "B 补传旧的");
  ok("NAS 上留的是 A 的新内容", ((await byTitle(nas, "两个人都改的日记")) || {}).body === "A 改的（新）", await byTitle(nas, "两个人都改的日记"));
  await sync(B, nas, stB, "B 再拉一次");
  ok("B 本机也被纠正成 A 的版本", ((await byTitle(B, "两个人都改的日记")) || {}).body === "A 改的（新）", await byTitle(B, "两个人都改的日记"));
  ok("NAS 上这一篇没被复制成两份", (await texts(nas)).filter((x) => x.title === "两个人都改的日记").length === 1);

  console.log("\n[11] 换网址：换一台 NAS，旧的游标不能沿用");
  const stA2 = newState();
  await sync(A, nas2, stA2, "A→第二台 NAS");
  const nas2T = await texts(nas2);
  ok("新 NAS 收到了本机全部内容", nas2T.length === (await texts(A)).length, { nas2: nas2T.length, a: (await texts(A)).length });
  ok("新 NAS 上没有重复标题", new Set(nas2T.map((x) => x.title)).size === nas2T.length, nas2T.map((x) => x.title));
  ok("新 NAS 上栏目名和本机一致（默认那三条按名字对上）", (await catList(nas2)).map((c) => c.name).sort().join() === (await catList(A)).map((c) => c.name).sort().join(), {
    nas2: await catList(nas2),
    a: await catList(A),
  });
  ok("旧地址的对照表没被污染", Object.keys(stA.catMap).length > 0 && stA.catMap !== stA2.catMap);
  await write(A, { title: "换网址之后写的", body: "新 NAS 也收到了" });
  await sync(A, nas2, stA2, "A 继续同步新 NAS");
  ok("换完地址照样能继续写继续传", !!(await byTitle(nas2, "换网址之后写的")));

  console.log("\n[12] 换账号：同一台 NAS 上另一个账号的数据不能串进来");
  const nas2B = store(P.nas2, OTHER);
  await write(nas2B, { title: "9002 账号的日记", body: "另一个人写的" });
  const stC = newState();
  await sync(C, nas2B, stC, "C（9002）同步");
  ok("C 只看到 9002 的那篇", (await texts(C)).length === 1 && !!(await byTitle(C, "9002 账号的日记")), await texts(C));
  ok("换账号后本机 A 的目录没被写花", (await byTitle(A, "两个人都改的日记")) !== null);
  const otherOnNas = await api(nas2B, "GET", "/api/posts?limit=100");
  ok("9002 在 NAS 上只有这一篇", otherOnNas.items.length === 1, otherOnNas.items.length);
  await write(C, { title: "C 写的", body: "不该出现在 A 上" });
  await sync(C, nas2B, stC, "C 补传");
  await sync(A, nas2, stA2, "A 再拉一次");
  ok("A 上没有串到 9002 的日记", !(await texts(A)).some((x) => x.title === "C 写的"), await texts(A));
  ok("C 补传的进了 9002 的目录", !!(await byTitle(nas2B, "C 写的")));
  ok("9001 的目录里没有 C 写的那篇", !(await byTitle(nas2, "C 写的")));

  console.log("\n[13] 地址没登录 / 地址写错的时候要说人话");
  const bad1 = await syncOnce({ local: A, remote: noLogin, state: newState(), log });
  ok("拿回来的是登录页 → 判定成需要登录", bad1.ok === false && bad1.needsLogin === true, bad1);
  ok("提示里说了怎么补", String(bad1.error).indexOf("没登录") >= 0, bad1.error);
  const bad2 = await syncOnce({ local: A, remote: nowhere, state: newState(), log });
  ok("端口没人听 → 报连不上而不是崩", bad2.ok === false && String(bad2.error).indexOf("连不上") >= 0, bad2);
  ok("连不上时本机日记一篇没少", (await texts(A)).length > 0);
  const fakeOld = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: "0.3.0", syncApi: 0, client: 0 }));
  });
  await new Promise((r) => fakeOld.listen(P.old, "127.0.0.1", r));
  servers.push(fakeOld);
  const bad3 = await syncOnce({ local: A, remote: store(P.old), state: newState(), log });
  ok("NAS 上是旧版 → 让他先升级", String(bad3.error).indexOf("升级") >= 0, bad3);
  const bad4 = await syncOnce({ local: A, remote: B, state: newState(), log });
  ok("填成另一台电脑上的客户端 → 说清楚要填 NAS", String(bad4.error).indexOf("NAS") >= 0, bad4);

  console.log("\n[14] 断网期间连着写，恢复后一次同步全传上去");
  const beforePush = stA.pushCursor;
  for (let i = 1; i <= 25; i++) await write(A, { title: "断网期间写的" + i, body: "第 " + i + " 篇", cat: (await catList(A)).find((c) => c.name === "夜钓").id });
  const r14 = await sync(A, nas, stA, "A 攒了 25 篇再同步");
  ok("25 篇全传上去了（多出来的是栏目并入后被搬走的那篇）", r14.push.pushed >= 25, r14.push);
  ok("传完游标确实前进了", stA.pushCursor !== beforePush);
  ok("NAS 上数得到这 25 篇", (await texts(nas)).filter((x) => x.title.indexOf("断网期间写的") === 0).length === 25);
  const dupCheck = await texts(nas);
  ok("没有一篇被复制成两份", new Set(dupCheck.map((x) => x.title)).size === dupCheck.length, dupCheck.map((x) => x.title));
  await sync(B, nas, stB, "B 拉这 25 篇");
  ok("B 一次同步全收到", (await texts(B)).filter((x) => x.title.indexOf("断网期间写的") === 0).length === 25);
  ok("B 收到的也都归在「夜钓」", (await texts(B)).filter((x) => x.title.indexOf("断网期间写的") === 0).every((x) => x.cat === "夜钓"));

  console.log("\n[15] 反复同步不该改坏任何东西");
  const snapA = JSON.stringify(await texts(A));
  const snapNas = JSON.stringify(await texts(nas));
  const catsA = JSON.stringify(await catList(A));
  await sync(A, nas, stA, "A 空跑 1");
  await sync(A, nas, stA, "A 空跑 2");
  await sync(B, nas, stB, "B 空跑");
  ok("本机内容没变", JSON.stringify(await texts(A)) === snapA);
  ok("NAS 内容没变", JSON.stringify(await texts(nas)) === snapNas);
  ok("栏目列表没变", JSON.stringify(await catList(A)) === catsA);
  ok("对照表还在", Object.keys(stA.catMap).length > 0);

  console.log("\n===== " + pass + " 通过 / " + fail + " 失败 =====");
  if (logLines.length) {
    console.log("\n引擎提示（前 20 条）：");
    logLines.slice(0, 20).forEach((s) => console.log("  · " + s));
  }
}

let timer;
function shutdown(code) {
  shuttingDown = true;
  clearTimeout(timer);
  for (const s of servers) {
    try {
      s.close();
    } catch (e) {}
  }
  for (const p of procs) {
    try {
      p.kill();
    } catch (e) {}
  }
  setTimeout(() => process.exit(code), 200);
}

const t0 = Date.now();
timer = setTimeout(() => {
  console.log("\n!! 超过 120 秒没跑完，可能是哪一步卡住了（已跑 " + pass + " 条）");
  shutdown(3);
}, 120000);

main()
  .then(() => shutdown(fail ? 1 : 0))
  .catch((e) => {
    console.log("\n!! 跑挂了：" + (e && e.stack));
    shutdown(1);
  });
