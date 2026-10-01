/* ------------------------------------------------------------------------------
   飞牛那一份 server.js 的同步接口回归（单实例，55 条）。
   测的是接口本身：本机编号能不能带上来、删除留不留记录、旧补传盖不盖得掉新的、
   /api/changes 的游标翻页会不会漏事件。客户端整条链路在 twobox.js 里测。
   跑法：cd client && npm run test:nas
   端口被上一个没死干净的测试进程占着时会在 waitUp 里报错，先 netstat 看一眼 5099
------------------------------------------------------------------------------ */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SERVER = process.env.SERVER_JS || path.join(__dirname, "..", "..", "diary", "app", "server", "server.js");
const DATA = process.env.DATA_DIR || path.join(__dirname, ".data-nas");
const PORT = 5099;
const BASE = "http://127.0.0.1:" + PORT + "/app/diary";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function req(method, url, body, uid) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = require("http").request(url, {
      method,
      headers: Object.assign(
        { "X-Trim-Userid": String(uid || 1001) },
        data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}
      ),
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, json: j, text: buf });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function waitUp() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function loop() {
      req("GET", BASE + "/api/info", undefined, 1001).then((r) => {
        if (r.json && r.json.version) resolve(r.json);
        else if (Date.now() - t0 > 8000) reject(new Error("起不来: " + r.text.slice(0, 200)));
        else setTimeout(loop, 120);
      }).catch(() => (Date.now() - t0 > 8000 ? reject(new Error("连不上")) : setTimeout(loop, 120)));
    })();
  });
}

function start() {
  const fd = fs.openSync(path.join(__dirname, "server.log"), "a");
  const p = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { DATA_DIR: DATA, PORT: String(PORT), GATEWAY_PREFIX: "/app/diary" }),
    stdio: ["ignore", fd, fd],
  });
  p.on("exit", (c) => { if (!process.__closing) console.log("!! 服务退出 code=" + c + "  看 server.log"); });
  return p;
}

const iso = (ms) => new Date(ms).toISOString();
let clock = 1700000000000;
const next = () => iso((clock += 1000));

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  let srv = start();
  const info = await waitUp();
  // 客户端时间要贴着服务器时间走：墓碑用的是 NAS 的真实时钟，
  // 测试里再拿 2023 这种假时间比就会变成"客户端时钟慢了三年"的场景
  const st = (await req("GET", BASE + "/api/changes")).json.serverTime;
  clock = Date.parse(st);
  const OLD = iso(clock - 365 * 24 * 3600 * 1000);
  console.log("服务已起，版本 " + info.version + "  syncApi=" + info.syncApi);
  ok("01 /api/info 报出 syncApi，客户端能判断 NAS 支不支持同步", info.syncApi === 1, info);

  console.log("\n[1] 本机自己生成编号往上传");
  const cid = "e9k3m2p7x1";
  const r1 = await req("POST", BASE + "/api/entry", { id: cid, date: "2026-10-01", cat: "c1", title: "离线写的第一篇", body: "本机离线写的正文", updatedAt: next() });
  ok("02 带新编号不再回 404，照这个编号建篇", r1.status === 200 && r1.json && r1.json.entry && r1.json.entry.id === cid, r1.json);
  const onDisk = path.join(DATA, "u1001", "entries", cid + ".json");
  ok("03 硬盘上就是这个编号的文件", fs.existsSync(onDisk));
  const r2 = await req("POST", BASE + "/api/entry", { id: cid, date: "2026-10-01", cat: "c1", title: "离线写的第一篇", body: "改了一次的正文", updatedAt: next() });
  ok("04 同编号再传是修改", r2.json.entry.id === cid && r2.json.ok === true, r2.json);
  const list = await req("GET", BASE + "/api/posts?limit=50");
  ok("05 列表里只有一篇，没复制成两份", list.json.items.filter((x) => x.id === cid).length === 1 && list.json.total === 1, list.json.total);

  console.log("\n[2] 旧设备补传不能盖掉新内容");
  const r3 = await req("POST", BASE + "/api/entry", { id: cid, date: "2026-10-01", cat: "c1", title: "旧设备的陈旧版本", body: "旧正文", updatedAt: OLD });
  ok("06 时间比 NAS 旧的补传被忽略", r3.json.unchanged === true, r3.json);
  const back = await req("GET", BASE + "/api/entry?id=" + cid);
  ok("07 正文还是新那份，没被旧设备覆盖", back.json.entry.body === "改了一次的正文", back.json.entry.body);

  console.log("\n[3] 删除要留下删除记录");
  const d1 = await req("POST", BASE + "/api/entries/delete", { ids: [cid] });
  ok("08 批量删除回 deleted 和 deletedAt", d1.json.deleted === 1 && !!d1.json.deletedAt, d1.json);
  ok("09 条目文件已删干净", !fs.existsSync(onDisk));
  const tombFile = path.join(DATA, "u1001", "deleted.json");
  ok("10 硬盘上有 deleted.json 记录", fs.existsSync(tombFile) && JSON.parse(fs.readFileSync(tombFile, "utf8")).items.some((t) => t.id === cid));

  console.log("\n[4] 被删的日记不会被离线设备救回来");
  const r4 = await req("POST", BASE + "/api/entry", { id: cid, date: "2026-10-01", cat: "c1", title: "离线设备的旧副本", body: "不该出现", updatedAt: OLD });
  ok("11 删除晚于这份内容 -> 不复活", r4.json.removed === true && !fs.existsSync(onDisk), r4.json);
  const r5 = await req("POST", BASE + "/api/entry", { id: cid, date: "2026-10-01", cat: "c1", title: "删掉之后又新写的", body: "这是删除之后写的", updatedAt: next() });
  ok("12 删除之后真的又写了新的 -> 能建起来", r5.json.entry && r5.json.entry.id === cid && fs.existsSync(onDisk), r5.json);
  const tombAfter = JSON.parse(fs.readFileSync(tombFile, "utf8"));
  ok("13 复活之后删除记录让位（记录里已无此编号）", !tombAfter.items.some((t) => t.id === cid), tombAfter);

  console.log("\n[5] 增量拉取 /api/changes");
  const c0 = await req("GET", BASE + "/api/changes");
  ok("14 首次全量拿到正文", c0.json.updated.length === 1 && c0.json.updated[0].body === "这是删除之后写的", c0.json);
  ok("15 复活之后不再有删除事件要下发", c0.json.deleted.length === 0, c0.json.deleted);
  const cur = c0.json.cursor;
  const c1 = await req("GET", BASE + "/api/changes?since=" + encodeURIComponent(cur));
  ok("16 带上 cursor 之后没有重复下发", c1.json.updated.length === 0 && c1.json.deleted.length === 0, c1.json);
  const w2 = await req("POST", BASE + "/api/entry", { id: "eabc123456", date: "2026-10-02", cat: "c1", title: "第二篇", body: "b2", updatedAt: next() });
  ok("17 新建第二篇成功", w2.json.entry.id === "eabc123456", w2.json);
  const c2 = await req("GET", BASE + "/api/changes?since=" + encodeURIComponent(cur));
  ok("18 只拿到新那一篇", c2.json.updated.length === 1 && c2.json.updated[0].id === "eabc123456" && c2.json.deleted.length === 0, c2.json);
  const d2 = await req("POST", BASE + "/api/entry", { id: "eabc123456", date: "2026-10-02", cat: "c1", title: "", body: "", mood: "" });
  ok("19 空正文 + 已存在编号 = 删除并记墓碑", d2.json.removed === true && !fs.existsSync(path.join(DATA, "u1001", "entries", "eabc123456.json")), d2.json);
  const c3 = await req("GET", BASE + "/api/changes?since=" + encodeURIComponent(c2.json.cursor));
  ok("19b 这次删除会作为删除事件下发给别的设备", c3.json.deleted.some((t) => t.id === "eabc123456") && c3.json.updated.length === 0, c3.json);

  console.log("\n[6] 翻页不漏不重");
  for (let i = 0; i < 12; i++) {
    await req("POST", BASE + "/api/entry", { id: "ebatch" + String(i).padStart(4, "0"), date: "2026-10-03", cat: "c1", title: "批量" + i, body: "x", updatedAt: next() });
  }
  const total = await req("GET", BASE + "/api/posts?limit=50");
  const all = await req("GET", BASE + "/api/changes?limit=500");
  const baseline = new Set([
    ...all.json.updated.map((e) => e.id),
    ...all.json.deleted.map((t) => "DEL:" + t.id),
    ...all.json.cats.map((c) => "CAT:" + c.id),
    ...all.json.catsDeleted.map((c) => "CATDEL:" + c.id),
  ]);
  const seen = new Set();
  let cursor = "", rounds = 0;
  while (rounds < 200) {
    const r = await req("GET", BASE + "/api/changes?since=" + encodeURIComponent(cursor) + "&limit=3");
    for (const e of r.json.updated) seen.add(e.id);
    for (const e of r.json.deleted) seen.add("DEL:" + e.id);
    for (const e of r.json.cats) seen.add("CAT:" + e.id);
    for (const e of r.json.catsDeleted) seen.add("CATDEL:" + e.id);
    if (r.json.cursor === cursor) { console.log("  !! cursor 卡住不动"); break; }
    cursor = r.json.cursor;
    rounds++;
    if (!r.json.more) break;
  }
  ok("20 每页 3 条翻完，收到条数 = 一次全量的条数（" + rounds + " 轮）", seen.size === baseline.size, { seen: seen.size, baseline: baseline.size });
  ok("21 翻页没有漏项", [...baseline].every((k) => seen.has(k)), [...baseline].filter((k) => !seen.has(k)));
  ok("21b 列表里条目数正常", total.json.total >= 12, total.json.total);

  console.log("\n[7] 多账号互不可见");
  const other = await req("GET", BASE + "/api/changes", undefined, 2002);
  ok("22 另一个账号的 changes 是空的", other.json.updated.length === 0 && other.json.deleted.length === 0, other.json);
  await req("POST", BASE + "/api/entry", { id: "eother0001", date: "2026-10-01", cat: "c1", title: "别人的", body: "secret", updatedAt: next() }, 2002);
  const mine = await req("GET", BASE + "/api/changes");
  ok("23 别人写的不会出现在我的 changes 里", !mine.json.updated.some((e) => e.id === "eother0001"), mine.json.updated.map((e) => e.id));

  console.log("\n[8] 网页端原行为不变（不带编号、不带时间）");
  const web1 = await req("POST", BASE + "/api/entry", { date: "2026-10-04", cat: "c1", title: "网页写的", body: "网页正文" });
  ok("24 网页保存照常新建", !!web1.json.entry && /^e[0-9a-z]{6,16}$/.test(web1.json.entry.id), web1.json);
  const web2 = await req("POST", BASE + "/api/entry", { id: web1.json.entry.id, date: "2026-10-04", cat: "c1", title: "网页写的", body: "网页正文改过" });
  ok("25 网页改自己刚写的那篇照常生效", web2.json.entry && web2.json.entry.id === web1.json.entry.id && !web2.json.unchanged, web2.json);
  const web3 = await req("POST", BASE + "/api/entry", { id: "e0000000", date: "2026-10-04", cat: "c1", title: "", body: "", mood: "" });
  ok("26 空正文 + 不存在的编号 = 不写墓碑也不报错", web3.json.removed === true && !fs.existsSync(path.join(DATA, "u1001", "entries", "e0000000.json")), web3.json);
  const bad = await req("POST", BASE + "/api/entry", { id: "E../pwn", date: "2026-10-04", cat: "c1", title: "路径穿越", body: "x" });
  ok("27 非法编号被当成没编号处理（不写越界路径）", bad.json.entry && bad.json.entry.id !== "E../pwn" && !fs.existsSync(path.join(DATA, "u1001", "entries", "E../pwn.json")), bad.json);
  ok("28 数据目录里没有多出乱七八糟的文件", fs.readdirSync(path.join(DATA, "u1001", "entries")).every((n) => /^e[0-9a-z]{6,16}\.json$/.test(n)), fs.readdirSync(path.join(DATA, "u1001", "entries")));

  console.log("\n[9] 重启后删除记录还在");
  const before = await req("GET", BASE + "/api/changes");
  process.__closing = true;
  srv.kill();
  await new Promise((r) => setTimeout(r, 400));
  process.__closing = false;
  srv = start();
  await waitUp();
  const after = await req("GET", BASE + "/api/changes");
  ok("29 重启后 changes 的删除条数一致", after.json.deleted.length === before.json.deleted.length, { before: before.json.deleted.length, after: after.json.deleted.length });
  const reDead = await req("POST", BASE + "/api/entry", { id: cid, date: "2026-10-01", cat: "c1", title: "重启后推旧内容", body: "x", updatedAt: OLD });
  ok("30 重启后陈旧补传被忽略", reDead.json.unchanged === true, reDead.json);
  const reCheck = await req("GET", BASE + "/api/entry?id=" + cid);
  ok("30b 重启后陈旧补传没盖掉新内容", reCheck.json.entry.body === "这是删除之后写的", reCheck.json.entry.body);

  console.log("\n[10] 客户端时钟快了也不会漏删除");
  const FAST = iso(Date.now() + 365 * 24 * 3600 * 1000);
  const f1 = await req("POST", BASE + "/api/entry", { id: "efast00001", date: "2026-10-05", cat: "c1", title: "时钟快一年的设备写的", body: "x", updatedAt: FAST });
  const sv = (await req("GET", BASE + "/api/changes?limit=500")).json;
  ok("31 未来的时间被压回 NAS 此刻", f1.json.entry.updatedAt <= sv.serverTime, { sent: FAST, stored: f1.json.entry.updatedAt, serverTime: sv.serverTime });
  await req("POST", BASE + "/api/entries/delete", { ids: ["efast00001"] });
  const c4 = await req("GET", BASE + "/api/changes?since=" + encodeURIComponent(sv.cursor));
  ok("32 这台设备照样能收到这条删除（不会永远排在游标前面）", c4.json.deleted.some((t) => t.id === "efast00001"), c4.json);
  const c5 = await req("GET", BASE + "/api/changes?since=" + encodeURIComponent(c4.json.cursor));
  ok("33 拉完之后再拉是空的，不会反复重发", c5.json.updated.length === 0 && c5.json.deleted.length === 0 && !c5.json.more, c5.json);

  console.log("\n[11] 栏目也要能双向同步");
  const cfId = "cfish9k2";
  const nc = await req("POST", BASE + "/api/categories", { id: cfId, name: "钓鱼", createdAt: next(), updatedAt: next() });
  ok("34 客户端自己编的栏目编号照样建得起来", nc.json.ok === true && nc.json.item.id === cfId && !nc.json.renumbered, nc.json);
  ok("35 栏目列表里多出一个「钓鱼」", (await req("GET", BASE + "/api/categories")).json.items.filter((c) => c.name === "钓鱼").length === 1);
  const nc2 = await req("POST", BASE + "/api/categories", { id: "cduck777", name: "钓鱼", createdAt: next(), updatedAt: next() });
  ok("36 另一台设备离线也建了「钓鱼」-> 认回已有那个，不重复建", nc2.json.merged === true && nc2.json.item.id === cfId, nc2.json);
  ok("37 建完还是没有两个「钓鱼」", (await req("GET", BASE + "/api/categories")).json.items.filter((c) => c.name === "钓鱼").length === 1);
  const clash = await req("POST", BASE + "/api/categories", { id: "c1", name: "撞号栏目", createdAt: next(), updatedAt: next() });
  const c1now = (await req("GET", BASE + "/api/categories")).json.items.find((c) => c.id === "c1");
  ok("38 编号撞上 NAS 已有的 -> 另发一个，原栏目一个字不改", clash.json.renumbered === true && clash.json.item.id !== "c1" && c1now.name === "日常", clash.json);
  await req("POST", BASE + "/api/categories/delete", { id: clash.json.item.id });

  await req("POST", BASE + "/api/categories/rename", { id: cfId, name: "钓鱼与露营" });
  const rn2 = await req("POST", BASE + "/api/categories/rename", { id: cfId, name: "老名字", updatedAt: OLD });
  ok("39 旧设备补传的改名被忽略", rn2.json.unchanged === true, rn2.json);
  ok("40 NAS 上栏目名仍是新那个", (await req("GET", BASE + "/api/categories")).json.items.find((c) => c.id === cfId).name === "钓鱼与露营");

  const orphan = await req("POST", BASE + "/api/entry", { id: "eorphan001", date: "2026-10-06", cat: "cnotsync1", title: "栏目还没同步过来", body: "x", updatedAt: next() });
  ok("41 认不出的栏目不再塞进第一个栏目，落到未分类并回 catFallback", orphan.json.catFallback === true && orphan.json.entry.cat === "" && orphan.json.wantCat === "cnotsync1", orphan.json);
  await req("POST", BASE + "/api/categories", { id: "cnotsync1", name: "补建的栏目", createdAt: next(), updatedAt: next() });
  const fixed = await req("POST", BASE + "/api/entry", { id: "eorphan001", date: "2026-10-06", cat: "cnotsync1", title: "栏目还没同步过来", body: "x", updatedAt: next() });
  ok("42 栏目补建好再推一次，日记就归位了", fixed.json.entry.cat === "cnotsync1" && !fixed.json.catFallback, fixed.json);

  const mark = (await req("GET", BASE + "/api/changes")).json.cursor;
  const eFish = await req("POST", BASE + "/api/entry", { id: "efish00001", date: "2026-10-07", cat: cfId, title: "今天钓到两条", body: "x", updatedAt: next() });
  ok("43 日记能挂在同步过来的栏目里", eFish.json.entry.cat === cfId, eFish.json);
  const pull1 = (await req("GET", BASE + "/api/changes?since=" + encodeURIComponent(mark))).json;
  ok("44 这篇新日记下发了", pull1.updated.some((e) => e.id === "efish00001" && e.cat === cfId), pull1.updated);
  const delCat = await req("POST", BASE + "/api/categories/delete", { id: cfId, to: "c1" });
  ok("45 删栏目回删除时刻，并说清并去了哪", !!delCat.json.deletedAt && delCat.json.to === "日常" && delCat.json.moved === 1, delCat.json);
  const pull2 = (await req("GET", BASE + "/api/changes?since=" + encodeURIComponent(pull1.cursor))).json;
  ok("46 删掉的栏目作为栏目删除事件下发", pull2.catsDeleted.some((c) => c.id === cfId), pull2);
  ok("47 被并走的日记也重新下发，客户端不会留幽灵栏目", pull2.updated.some((e) => e.id === "efish00001" && e.cat === "c1"), pull2.updated);
  const revive = await req("POST", BASE + "/api/categories", { id: cfId, name: "钓鱼", createdAt: OLD, updatedAt: OLD });
  ok("48 删除晚于这份内容的补建 -> 栏目不复活", revive.json.removed === true && !(await req("GET", BASE + "/api/categories")).json.items.some((c) => c.id === cfId), revive.json);
  const reMake = await req("POST", BASE + "/api/categories", { id: cfId, name: "钓鱼", createdAt: next(), updatedAt: next() });
  ok("49 删掉之后真的又建了同名栏目 -> 建得回来", reMake.json.ok === true && reMake.json.item.id === cfId, reMake.json);
  ok("50 重建后栏目删除记录让位", !JSON.parse(fs.readFileSync(path.join(DATA, "u1001", "deleted-cats.json"), "utf8")).items.some((t) => t.id === cfId));

  console.log("\n[12] 同一毫秒删一批，翻页也不能漏");
  for (let i = 0; i < 6; i++) {
    await req("POST", BASE + "/api/entry", { id: "esame00" + i, date: "2026-10-08", cat: "c1", title: "同一毫秒" + i, body: "x", updatedAt: next() });
  }
  const mark2 = (await req("GET", BASE + "/api/changes")).json.cursor;
  const bulk = await req("POST", BASE + "/api/entries/delete", { ids: [0, 1, 2, 3, 4, 5].map((i) => "esame00" + i) });
  ok("51 一次删六篇，一次拿到删除时刻", bulk.json.deleted === 6 && !!bulk.json.deletedAt, bulk.json);
  const gotDel = [];
  let cur2 = mark2, rounds2 = 0;
  while (rounds2 < 50) {
    const r = (await req("GET", BASE + "/api/changes?since=" + encodeURIComponent(cur2) + "&limit=2")).json;
    for (const t of r.deleted) gotDel.push(t.id);
    rounds2++;
    if (!r.more || r.cursor === cur2) break;
    cur2 = r.cursor;
  }
  ok("52 每页 2 条翻完，六篇的删除一个都没漏", [0, 1, 2, 3, 4, 5].every((i) => gotDel.indexOf("esame00" + i) >= 0), gotDel);

  srv.kill();
  console.log("\n===== " + pass + " 通过 / " + fail + " 失败 =====");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("跑挂了", e); try { srv_kill(); } catch (_) {} process.exit(2); });
function srv_kill() {}
