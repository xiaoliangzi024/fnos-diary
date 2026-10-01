const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PREFIX = process.env.GATEWAY_PREFIX || "/app/diary";
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, "data");
const WWW_DIR = process.env.WWW_DIR || path.join(__dirname, "..", "www");
const SOCKET_PATH = process.env.SOCKET_PATH || "";
const PORT = Number(process.env.PORT || 5001);

const MAX_BODY = 2 * 1024 * 1024;
// 导入备份单独放宽：日记存上十几年，备份文件可能几十 MB
const MAX_IMPORT_BODY = 200 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
// 栏目编号：NAS 自己建的仍是 c1 / c2 这种短号，客户端离线新建的用 c+随机串，
// 两边不会撞号；万一撞了，同名就按同一个栏目处理
const ID_RE = /^c[0-9a-z]{1,12}$/;
const ENTRY_RE = /^e[0-9a-z]{6,16}$/;
const MAX_CAT = 30;
const APP_VER = process.env.APP_VER || "0.4.1";
const DATA_VER = "1";
const BK_KEEP = 10;
// 删除记录最多留这么多条，够几万台设备离线半年不重连
const TOMB_KEEP = 200000;
// 时间字段坏掉的旧条目按这个时刻算，至少保证第一次全量同步能把它带走
const EPOCH = "1970-01-01T00:00:00.000Z";

fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(path.join(DATA_ROOT, "backups"), { recursive: true });

function writeDataVer() {
  const file = path.join(DATA_ROOT, "data_version");
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, DATA_VER, "utf8");
  } catch {
    /* 只影响诊断信息，不影响写日记 */
  }
}
writeDataVer();

function pruneBackups() {
  const dir = path.join(DATA_ROOT, "backups");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^pre-import-.*\.json$/.test(n));
  } catch {
    return;
  }
  names.sort().reverse();
  for (const n of names.slice(BK_KEEP)) {
    try {
      fs.unlinkSync(path.join(dir, n));
    } catch {
      /* 清不掉就算了，不影响导入 */
    }
  }
}

function userDir(uid) {
  const dir = path.join(DATA_ROOT, "u" + uid);
  fs.mkdirSync(path.join(dir, "entries"), { recursive: true });
  return dir;
}

// 身份只取网关转发的 Header，绝不接受客户端传入的用户 ID
function getUid(req) {
  const raw = req.headers["x-trim-userid"];
  if (typeof raw === "string" && /^\d{1,12}$/.test(raw)) return raw;
  return "local";
}

function getUsername(req) {
  const raw = req.headers["x-trim-username"];
  if (typeof raw !== "string" || !raw) return "本机用户";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw.replace(/[^\w.-]/g, "").slice(0, 32) || "本机用户";
  }
}

function isAdmin(req) {
  return req.headers["x-trim-isadmin"] === "true";
}

function safeDate(value) {
  const s = String(value || "");
  if (!DATE_RE.test(s)) return null;
  const d = new Date(s + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : s;
}

function cleanName(value, max) {
  const s = String(value || "").replace(/[\x00-\x1f]/g, "").trim();
  return s.slice(0, max);
}

// 离线设备推上来的时间以它本机为准（排序、比新旧都靠它），格式不对就退回服务器时间。
// 传了个未来的时间要压回服务器此刻：整条同步的先后次序以 NAS 的时钟为准，
// 不然某台设备时钟快了，它写的内容会永远排在游标前面，别的设备再也拉不到删除记录
function safeStamp(value, fallback, maxIso) {
  const t = Date.parse(String(value || ""));
  if (Number.isNaN(t)) return fallback;
  const iso = new Date(t).toISOString();
  return maxIso && iso > maxIso ? maxIso : iso;
}

// /api/changes 的一页按"日记/栏目 + 改动/删除"分成四份返回，客户端各取各的
function pick(page, kind, live) {
  const out = [];
  for (const x of page) {
    if (x.kind !== kind) continue;
    if (live) {
      if (x.up) out.push(x.up);
    } else if (!x.up) {
      out.push({ id: x.id, deletedAt: x.ts });
    }
  }
  return out;
}

/* ---------- 栏目 ---------- */

function loadCats(dir) {
  const file = path.join(dir, "categories.json");
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = null;
  }
  // 只有栏目文件真的不存在时才建默认栏目；用户把栏目删空要保留空列表
  if (!data || !Array.isArray(data.items)) {
    data = {
      seq: 3,
      items: [
        { id: "c1", name: "日常", createdAt: new Date().toISOString() },
        { id: "c2", name: "工作", createdAt: new Date().toISOString() },
        { id: "c3", name: "学习", createdAt: new Date().toISOString() },
      ],
    };
    saveCats(dir, data);
  }
  let touched = false;
  data.items = data.items
    .filter((c) => c && ID_RE.test(String(c.id)) && c.name)
    .map((c) => {
      const createdAt = typeof c.createdAt === "string" ? c.createdAt : "";
      let updatedAt = typeof c.updatedAt === "string" ? c.updatedAt : "";
      // 0.4.1 之前的栏目文件没有时间戳，先拿建栏目的时间顶上；同步靠它判断改没改过
      if (!updatedAt) {
        touched = true;
        updatedAt = createdAt || EPOCH;
      }
      return { id: c.id, name: String(c.name).slice(0, 20), createdAt, updatedAt };
    });
  if (touched) saveCats(dir, data);
  return data;
}

function saveCats(dir, data) {
  const tmp = path.join(dir, "categories.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, path.join(dir, "categories.json"));
}

/* ---------- 条目 ---------- */

function entryPath(dir, id) {
  return path.join(dir, "entries", id + ".json");
}

function readEntry(dir, id) {
  try {
    const e = JSON.parse(fs.readFileSync(entryPath(dir, id), "utf8"));
    if (!e || typeof e !== "object" || !safeDate(e.date)) return null;
    return e;
  } catch {
    return null;
  }
}

// 写盘后同步维护缓存：列表和搜索靠缓存取，不必每篇打开硬盘
function writeEntry(dir, entry) {
  const file = entryPath(dir, entry.id);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), "utf8");
  fs.renameSync(tmp, file);
  cachePatch(dir, entry);
}

function dropEntry(dir, id) {
  fs.unlinkSync(entryPath(dir, id));
  cacheDrop(dir);
}

/* ---------- 删除记录（墓碑） ----------
   离线设备联网后会把本机写的日记整篇推上来、把本机新建的栏目再建一遍。
   没有"什么东西被删过"这份记录，就分不出"这是新写的"还是"这是删过的"，
   删掉的东西会复活。所以删除只留编号和时间，正文跟着文件一起删干净。
   这份记录只由本进程写，内存里那份就是准的，不用反复读硬盘。 */

function tombStore(fileName, idRe) {
  const cache = new Map();

  function mapOf(dir) {
    let m = cache.get(dir);
    if (m) return m;
    m = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, fileName), "utf8"));
      for (const t of Array.isArray(data && data.items) ? data.items : []) {
        if (t && idRe.test(String(t.id)) && typeof t.deletedAt === "string") m.set(t.id, t.deletedAt);
      }
    } catch {
      /* 没有这个文件就是还没删过任何东西 */
    }
    cache.set(dir, m);
    return m;
  }

  function save(dir, m) {
    const items = [...m.entries()]
      .map(([id, deletedAt]) => ({ id, deletedAt }))
      .sort((a, b) => (a.deletedAt < b.deletedAt ? -1 : a.deletedAt > b.deletedAt ? 1 : 0));
    const keep = items.length > TOMB_KEEP ? items.slice(items.length - TOMB_KEEP) : items;
    const tmp = path.join(dir, fileName + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify({ items: keep }), "utf8");
    fs.renameSync(tmp, path.join(dir, fileName));
  }

  return {
    of: mapOf,
    // 每个删除入口都要调它，漏一个那篇日记或那个栏目就可能被离线设备复活
    stamp(dir, ids) {
      const m = mapOf(dir);
      const now = new Date().toISOString();
      let changed = 0;
      for (const raw of ids) {
        const id = String(raw || "");
        if (!idRe.test(id)) continue;
        m.set(id, now);
        changed++;
      }
      if (changed) save(dir, m);
      return { deleted: changed, at: now };
    },
    // 同一个编号又真的重新建起来了，删除记录就让位
    clear(dir, id) {
      const m = mapOf(dir);
      if (m.delete(id)) save(dir, m);
    },
  };
}

const entryTombs = tombStore("deleted.json", ENTRY_RE);
const catTombs = tombStore("deleted-cats.json", ID_RE);

/* ---------- 读取缓存 ----------
   一万篇日记如果每次开列表都逐篇读硬盘会要等一两秒，所以每个账号在内存里
   留一份全量。内存这份只是副本，硬盘上的 .json 才是真的数据：
   不进备份、重启自动重建，所以不存在"两套数据对不上"。 */

const CACHE = new Map();

// 目录签名 = 文件数 + 全部文件名的滚动哈希。新增时 O(1) 跟着更新，
// 不必每保存一篇就作废整份缓存
function nameHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function sumNames(names) {
  let sum = 0;
  for (const n of names) sum = (sum + nameHash(n)) >>> 0;
  return sum >>> 0;
}

function sigOfNames(names) {
  return { count: names.length, sum: sumNames(names) };
}

function loadFromDisk(dir, names) {
  const out = [];
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    const id = n.slice(0, -5);
    if (!ENTRY_RE.test(id)) continue;
    const e = readEntry(dir, id);
    if (e) out.push(e);
  }
  return out;
}

function buildCache(dir, names, list) {
  const idx = new Map();
  for (let i = 0; i < list.length; i++) idx.set(list[i].id, i);
  const hit = Object.assign(sigOfNames(names), { list, idx });
  CACHE.set(dir, hit);
  return hit;
}

// 新增一篇：文件名多一个，签名跟着变，缓存继续有效，不用回头重读硬盘
function cachePutNew(dir, entry) {
  const hit = CACHE.get(dir);
  if (!hit) return;
  const h = nameHash(entry.id + ".json");
  hit.count++;
  hit.sum = (hit.sum + h) >>> 0;
  hit.idx.set(entry.id, hit.list.length);
  hit.list.push(entry);
}

function cachePatch(dir, entry) {
  const hit = CACHE.get(dir);
  if (!hit) return;
  const at = hit.idx.get(entry.id);
  if (at == null) return cachePutNew(dir, entry);
  hit.list[at] = entry;
}

// 删除要动数组下标，逐条挑反而更慢；直接作废，下次开列表重读一次硬盘
function cacheDrop(dir) {
  CACHE.delete(dir);
}

function allEntries(dir) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, "entries"));
  } catch {
    return [];
  }
  const hit = CACHE.get(dir);
  if (hit && hit.count === names.length && hit.sum === sumNames(names)) {
    return hit.list;
  }
  return buildCache(dir, names, loadFromDisk(dir, names)).list;
}

function newId() {
  return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 判断"是不是同一篇"用的指纹：导入时靠它去重，换设备恢复才不会复制成两份
function sigOf(e) {
  const raw = [e.date, e.cat, e.title || "", e.mood || "", e.body || ""].join("\u0001");
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function toMeta(e, catNames) {
  const known = catNames[e.cat] ? e.cat : "";
  return {
    id: e.id,
    date: e.date,
    cat: known,
    catName: known ? catNames[known] : "未分类",
    title: e.title || "",
    mood: e.mood || "",
    updatedAt: e.updatedAt || null,
    preview: String(e.body || "").replace(/\s+/g, " ").slice(0, 60),
    chars: String(e.body || "").length,
  };
}

// cat 过滤："all"/空 = 默认页（全部）；"none" = 未分类；其余按栏目 id
function matchCat(e, cat, catNames) {
  if (!cat || cat === "all") return true;
  if (cat === "none") return !catNames[e.cat];
  return e.cat === cat;
}

// 普通请求（写一篇日记）沿用小额上限；导入备份单独放宽，
// 日记存十几年后备份文件会很大，不能让它撞上限导不回来
function readBody(req, limit) {
  const max = limit || MAX_BODY;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("文件太大（已超过 " + Math.round(max / 1024 / 1024) + "MB 上限），请分批导入"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("数据格式不对"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, code, type, body) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function sendJson(res, code, data) {
  send(res, code, "application/json; charset=utf-8", JSON.stringify(data));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(res, urlPath) {
  let rel = urlPath === "/" || urlPath === "" ? "/index.html" : urlPath.split("?")[0];
  const root = path.resolve(WWW_DIR);
  const target = path.resolve(root, "." + rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return send(res, 403, "text/plain; charset=utf-8", "禁止访问");
  }
  let file = target;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(WWW_DIR, "index.html");
  if (!fs.existsSync(file)) return send(res, 404, "text/plain; charset=utf-8", "未找到页面");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 500, "text/plain; charset=utf-8", "读取失败");
    send(res, 200, MIME[path.extname(file).toLowerCase()] || "application/octet-stream", buf);
  });
}

async function api(req, res, uid, query) {
  const dir = userDir(uid);
  const route = req.url.split("?")[0];
  const method = req.method;
  const cats = loadCats(dir);
  const catNames = {};
  cats.items.forEach((c) => {
    catNames[c.id] = c.name;
  });

  if (route === "/api/session") {
    return sendJson(res, 200, { uid, username: getUsername(req), isAdmin: isAdmin(req) });
  }

  if (route === "/api/info") {
    // syncApi：客户端靠它判断这台 NAS 支不支持离线同步（1 = 支持本机编号上传 + /api/changes）
    return sendJson(res, 200, { version: APP_VER, dataDir: DATA_ROOT, dataVersion: DATA_VER, syncApi: 1 });
  }

  /* ----- 栏目增删改 ----- */

  if (route === "/api/categories" && method === "GET") {
    const counts = {};
    let loose = 0;
    for (const e of allEntries(dir)) {
      if (catNames[e.cat]) counts[e.cat] = (counts[e.cat] || 0) + 1;
      else loose++;
    }
    return sendJson(res, 200, {
      items: cats.items.map((c) => ({ id: c.id, name: c.name, count: counts[c.id] || 0 })),
      loose,
      total: Object.values(counts).reduce((a, b) => a + b, 0) + loose,
    });
  }

  if (route === "/api/categories" && method === "POST") {
    const body = await readBody(req);
    const name = cleanName(body.name, 20);
    if (!name) return sendJson(res, 400, { error: "栏目名不能为空" });
    const serverNow = new Date().toISOString();
    const stamp = safeStamp(body.updatedAt, serverNow, serverNow);
    const same = cats.items.find((c) => c.name === name);
    // 同名就认 NAS 上已有的那个：客户端离线建了「钓鱼」、NAS 上也建了「钓鱼」，
    // 不该多出两个一模一样的栏目，返回已有编号让客户端自己把本地的并过去
    if (same) {
      if (stamp > String(same.updatedAt || "")) {
        same.updatedAt = stamp;
        saveCats(dir, cats);
      }
      catTombs.clear(dir, same.id);
      return sendJson(res, 200, { ok: true, merged: true, item: { id: same.id, name: same.name, count: 0 } });
    }
    if (cats.items.length >= MAX_CAT) return sendJson(res, 400, { error: "栏目最多 " + MAX_CAT + " 个" });
    let id = String(body.id || "");
    if (!ID_RE.test(id)) id = "";
    if (id) {
      const gone = catTombs.of(dir).get(id);
      // 这个栏目在 NAS 上被删过，而且删除晚于客户端这份 → 删除赢，不建
      if (gone && gone >= stamp) return sendJson(res, 200, { ok: true, removed: true, skipped: "这个栏目已被删除" });
    }
    let renumbered = false;
    if (!id || cats.items.some((c) => c.id === id)) {
      // 编号被占了就另发一个，把真实编号回给客户端，别为了迁就它把两个栏目混成一个
      do {
        cats.seq = Number(cats.seq || 0) + 1;
        id = "c" + cats.seq;
      } while (cats.items.some((c) => c.id === id));
      renumbered = true;
    }
    cats.items.push({ id, name, createdAt: safeStamp(body.createdAt, stamp), updatedAt: stamp });
    saveCats(dir, cats);
    catTombs.clear(dir, id);
    return sendJson(res, 200, { ok: true, renumbered, item: { id, name, count: 0 } });
  }

  if (route === "/api/categories/rename" && method === "POST") {
    const body = await readBody(req);
    const id = String(body.id || "");
    const name = cleanName(body.name, 20);
    const item = cats.items.find((c) => c.id === id);
    if (!item) return sendJson(res, 404, { error: "栏目不存在" });
    if (!name) return sendJson(res, 400, { error: "栏目名不能为空" });
    if (cats.items.some((c) => c.name === name && c.id !== id)) {
      return sendJson(res, 400, { error: "已经有同名栏目了" });
    }
    const stamp = safeStamp(body.updatedAt, new Date().toISOString());
    // 旧设备补传的改名不覆盖新名字（网页端不传时间，所以永远生效）
    if (body.updatedAt && stamp <= String(item.updatedAt || "")) {
      return sendJson(res, 200, { ok: true, unchanged: true, item: { id, name: item.name } });
    }
    item.name = name;
    item.updatedAt = stamp;
    saveCats(dir, cats);
    return sendJson(res, 200, { ok: true, item: { id, name } });
  }

  if (route === "/api/categories/delete" && method === "POST") {
    const body = await readBody(req);
    const id = String(body.id || "");
    if (!cats.items.some((c) => c.id === id)) return sendJson(res, 404, { error: "栏目不存在" });
    const rest = cats.items.filter((c) => c.id !== id);
    // 删栏目绝不丢日记：有其他栏目就并过去，一个都不剩就退成"未分类"
    const wanted = String(body.to || "");
    const target = rest.find((c) => c.id === wanted) || rest[0] || null;
    // 先记下删除时刻，待会儿被并走的日记也用这同一个时间，
    // 这样离线客户端拉到这批日记时，拿到的是并过去之后的新栏目
    const stamped = catTombs.stamp(dir, [id]);
    let moved = 0;
    for (const e of allEntries(dir)) {
      if (e.cat !== id) continue;
      e.cat = target ? target.id : "";
      e.updatedAt = stamped.at;
      writeEntry(dir, e);
      moved++;
    }
    cats.items = rest;
    saveCats(dir, cats);
    return sendJson(res, 200, { ok: true, moved, to: target ? target.name : "未分类", deletedAt: stamped.at });
  }

  /* ----- 日记条目 ----- */

  if (route === "/api/list" && method === "GET") {
    const month = String(query.get("month") || "");
    const cat = String(query.get("cat") || "");
    if (!MONTH_RE.test(month)) return sendJson(res, 400, { error: "月份格式不正确" });
    const items = allEntries(dir)
      .filter((e) => e.date.startsWith(month))
      .filter((e) => matchCat(e, cat, catNames))
      .map((e) => toMeta(e, catNames))
      .sort((a, b) => (a.date === b.date ? String(a.cat).localeCompare(String(b.cat)) : a.date < b.date ? 1 : -1));
    return sendJson(res, 200, { month, items });
  }

  if (route === "/api/posts" && method === "GET") {
    // 博客式的文章流：按栏目/月份/某一天筛，日期新的在前，同一天里刚改过的在前
    const cat = String(query.get("cat") || "");
    const month = String(query.get("month") || "");
    const day = String(query.get("day") || "");
    const limit = Math.min(100, Math.max(1, Number(query.get("limit") || 20) || 20));
    const skip = Math.max(0, Number(query.get("skip") || 0) || 0);
    if (month && !MONTH_RE.test(month)) return sendJson(res, 400, { error: "月份格式不正确" });
    if (day && !DATE_RE.test(day)) return sendJson(res, 400, { error: "日期格式不正确" });
    const list = allEntries(dir)
      .filter((e) => (day ? e.date === day : month ? e.date.startsWith(month) : true))
      .filter((e) => matchCat(e, cat, catNames))
      .map((e) => toMeta(e, catNames))
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      });
    return sendJson(res, 200, { items: list.slice(skip, skip + limit), total: list.length, skip: skip, limit: limit });
  }

  if (route === "/api/entry" && method === "GET") {
    const id = String(query.get("id") || "");
    if (!ENTRY_RE.test(id)) return sendJson(res, 400, { error: "编号不对" });
    const e = readEntry(dir, id);
    if (!e) return sendJson(res, 404, { error: "日记不存在，可能已被删除" });
    return sendJson(res, 200, { entry: Object.assign(toMeta(e, catNames), { body: String(e.body || "") }) });
  }

  if (route === "/api/entry" && method === "POST") {
    const body = await readBody(req);
    const date = safeDate(body.date);
    if (!date) return sendJson(res, 400, { error: "日期格式不正确" });
    let cat = String(body.cat || "");
    // "none" 表示放在未分类里；栏目全被删光时新日记也归入未分类
    if (cat === "none") cat = "";
    let catFallback = false;
    const wantCat = cat;
    if (cat && !cats.items.some((c) => c.id === cat)) {
      // 这是离线客户端在自己机器上新建的栏目，编号还没同步到 NAS。
      // 日记先归入未分类，并把原编号回给客户端，让它补建栏目后再推一次。
      // 不能塞进"第一个栏目"——那等于把日记悄悄放进了毫不相干的栏目里
      catFallback = true;
      cat = "";
    }
    const title = cleanName(body.title, 120);
    const text = String(body.body || "").replace(/\x00/g, "").slice(0, 200000);
    const mood = cleanName(body.mood, 16);

    let id = String(body.id || "");
    if (!ENTRY_RE.test(id)) id = "";
    // 带编号就照这篇改；不带编号一律新建。网页端从不自己编号，
    // 所以它的保存永远用服务器时间，行为跟以前完全一样
    const existing = id ? readEntry(dir, id) : null;
    const serverNow = new Date().toISOString();
    const stamp = safeStamp(body.updatedAt, serverNow, serverNow);

    if (!title && !mood && !text.trim()) {
      if (existing) {
        dropEntry(dir, existing.id);
        entryTombs.stamp(dir, [id]);
      }
      return sendJson(res, 200, { ok: true, removed: true });
    }
    if (id && !existing) {
      const gone = entryTombs.of(dir).get(id);
      // 这篇在 NAS 上已经被删了，而且删除晚于客户端这份内容 → 删除赢，不把它救回来
      if (gone && gone >= stamp) return sendJson(res, 200, { ok: true, removed: true, skipped: "这篇已被删除" });
    }
    // NAS 上这份比客户端的更新，说明是台旧设备的补传，直接忽略，不覆盖新内容
    if (existing && stamp <= String(existing.updatedAt || "")) {
      return sendJson(res, 200, { ok: true, unchanged: true, entry: toMeta(existing, catNames) });
    }

    const entry = {
      id: id || newId(),
      date,
      cat,
      title,
      body: text,
      mood,
      createdAt: existing && existing.createdAt ? existing.createdAt : safeStamp(body.createdAt, stamp),
      updatedAt: stamp,
    };
    writeEntry(dir, entry);
    // 客户端重新写了这篇（比如删掉后又离线写了一份新的），删除记录就该让位
    if (id) entryTombs.clear(dir, id);
    return sendJson(res, 200, catFallback
      ? { ok: true, entry: toMeta(entry, catNames), catFallback: true, wantCat: wantCat }
      : { ok: true, entry: toMeta(entry, catNames) });
  }

  if (route === "/api/entry" && method === "DELETE") {
    const id = String(query.get("id") || "");
    if (!ENTRY_RE.test(id)) return sendJson(res, 400, { error: "编号不对" });
    if (readEntry(dir, id)) {
      dropEntry(dir, id);
      entryTombs.stamp(dir, [id]);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (route === "/api/entries/delete" && method === "POST") {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 100000) : [];
    if (!ids.length) return sendJson(res, 400, { error: "没有选中任何日记" });
    const gone = [];
    for (const raw of ids) {
      const id = String(raw || "");
      if (!ENTRY_RE.test(id)) continue;
      if (readEntry(dir, id)) {
        dropEntry(dir, id);
        gone.push(id);
      }
    }
    // 整批只写一次删除记录，删一万篇也不会碰一万次硬盘
    const stamped = entryTombs.stamp(dir, gone);
    return sendJson(res, 200, { ok: true, deleted: gone.length, deletedAt: stamped.at });
  }

  /* ----- 增量同步：谁改了哪几篇、哪几个栏目，删了哪几篇、哪几个栏目 -----
     客户端存一个上次拿到的 cursor，下次带上，只取比它新的改动。
     日记和栏目、改动和删除全排在同一条时间线上返回，
     所以不会只看到新增、漏掉删除，也不会拿到一篇挂着不存在栏目的日记。 */

  if (route === "/api/changes" && method === "GET") {
    const now = new Date().toISOString();
    // 游标是"时刻~编号"两段。只用时刻会在同一毫秒里出事：一次批量删除给一万篇日记
    // 盖的是同一个时间戳，翻页翻到一半时后面那几千条会永远排在游标之后取不到。
    // 带上编号做第二排序键，切在批次中间也能接着取。不带 ~ 的旧游标照样认
    const raw = String(query.get("since") || "");
    const sep = raw.indexOf("~");
    const rawTs = sep < 0 ? raw : raw.slice(0, sep);
    const sinceTs = rawTs ? safeStamp(rawTs, "") : "";
    const sinceId = sep < 0 ? "" : raw.slice(sep + 1);
    const newer = (ts, id) => !sinceTs || ts > sinceTs || (ts === sinceTs && id > sinceId);
    const limit = Math.min(500, Math.max(1, Number(query.get("limit") || 200) || 200));
    const events = [];
    for (const e of allEntries(dir)) {
      const ts = safeStamp(e.updatedAt || e.createdAt, EPOCH, now);
      if (newer(ts, e.id)) events.push({ ts, id: e.id, kind: "entry", up: e });
    }
    for (const [id, ts] of entryTombs.of(dir)) {
      if (newer(ts, id)) events.push({ ts, id, kind: "entry", up: null });
    }
    for (const c of cats.items) {
      const ts = safeStamp(c.updatedAt || c.createdAt, EPOCH, now);
      if (newer(ts, c.id)) events.push({ ts, id: c.id, kind: "cat", up: c });
    }
    for (const [id, ts] of catTombs.of(dir)) {
      if (newer(ts, id)) events.push({ ts, id, kind: "cat", up: null });
    }
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    const cut = Math.min(limit, events.length);
    const page = events.slice(0, cut);
    const last = page[page.length - 1];
    // 游标一律落在 NAS 自己的时钟上：没翻完就停在最后一条，翻完了就停在此刻。
    // 客户端下次带回来只会拿到真正更新的改动，既不漏也不重复
    return sendJson(res, 200, {
      ok: true,
      cursor: cut < events.length && last ? last.ts + "~" + last.id : now,
      serverTime: now,
      updated: pick(page, "entry", true),
      deleted: pick(page, "entry", false),
      cats: pick(page, "cat", true),
      catsDeleted: pick(page, "cat", false),
      more: cut < events.length,
    });
  }

  /* ----- 搜索：标题 + 正文 ----- */

  if (route === "/api/search" && method === "GET") {
    const raw = String(query.get("q") || "");
    const cat = String(query.get("cat") || "");
    const limit = Math.min(100, Math.max(1, Number(query.get("limit") || 20) || 20));
    const skip = Math.max(0, Number(query.get("skip") || 0) || 0);
    const words = raw.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return sendJson(res, 200, { items: [], words, total: 0, skip: 0, limit: limit });
    const items = [];
    for (const e of allEntries(dir)) {
      if (!matchCat(e, cat, catNames)) continue;
      const title = String(e.title || "");
      const text = String(e.body || "");
      const hay = (title + "\n" + text).toLowerCase();
      let hit = null;
      for (const w of words) {
        const at = hay.indexOf(w);
        if (at < 0) {
          hit = null;
          break;
        }
        if (!hit) hit = { at: at, w: w };
      }
      if (!hit) continue;
      let match;
      if (hit.at <= title.length) {
        match = text.trim().slice(0, 60) || "（正文为空）";
      } else {
        const pos = hit.at - title.length - 1;
        match = text.slice(Math.max(0, pos - 20), pos + 60);
      }
      items.push(Object.assign(toMeta(e, catNames), { match }));
    }
    items.sort((a, b) => (a.date < b.date ? 1 : -1));
    return sendJson(res, 200, {
      items: items.slice(skip, skip + limit),
      total: items.length,
      skip: skip,
      limit: limit,
      words,
    });
  }

  /* ----- 备份与恢复 ----- */

  if (route === "/api/export" && method === "GET") {
    const entries = allEntries(dir).sort((a, b) => (a.date < b.date ? -1 : 1));
    const payload = {
      app: "diary",
      kind: "backup",
      backupVersion: 2,
      exportedAt: new Date().toISOString(),
      categories: cats.items,
      entries: entries,
    };
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="diary-backup-' + safeDate(query.get("today")) + '.json"',
    });
    return res.end(JSON.stringify(payload, null, 2));
  }

  if (route === "/api/import" && method === "POST") {
    const body = await readBody(req, MAX_IMPORT_BODY);
    if (!body || !Array.isArray(body.entries)) {
      return sendJson(res, 400, { error: "这不是日记备份文件，或文件已损坏" });
    }
    const mode = body.mode === "overwrite" ? "overwrite" : "merge";

    // 导入前先把现有日记整体存一份，覆盖导入出错也能找回
    const before = allEntries(dir);
    if (before.length) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(
          path.join(DATA_ROOT, "backups", "pre-import-" + stamp + ".json"),
          JSON.stringify({ app: "diary", kind: "auto-backup", categories: cats.items, entries: before }, null, 2),
          "utf8"
        );
        pruneBackups();
      } catch {
        /* 快照失败不挡导入 */
      }
    }

    // 备份里的栏目名对上本地栏目，对不上就新建
    const byName = {};
    cats.items.forEach((c) => {
      byName[c.name] = c.id;
    });
    let catsAdded = 0;
    for (const c of Array.isArray(body.categories) ? body.categories : []) {
      const name = cleanName(c && c.name, 20);
      if (!name || byName[name]) continue;
      if (cats.items.length >= MAX_CAT) break;
      let id;
      do {
        cats.seq = Number(cats.seq || 0) + 1;
        id = "c" + cats.seq;
      } while (cats.items.some((x) => x.id === id));
      const at = new Date().toISOString();
      cats.items.push({ id, name, createdAt: at, updatedAt: at });
      byName[name] = id;
      catsAdded++;
    }
    const toCatId = (value) => {
      const direct = String(value || "");
      const hit = cats.items.find((c) => c.id === direct);
      if (hit) return hit.id;
      const named = cats.items.find((c) => c.name === cleanName(value, 20));
      if (named) return named.id;
      return cats.items.length ? cats.items[0].id : "";
    };
    if (catsAdded) saveCats(dir, cats);

    let added = 0;
    let skipped = 0;
    let replaced = 0;
    const byId = new Map();
    const bySig = new Map();
    for (const e of allEntries(dir)) {
      byId.set(e.id, e);
      bySig.set(sigOf(e), e);
    }
    // 全量导入，绝不少数篇：日记存十几年后一次导几万篇也要能一次导回来
    for (const raw of body.entries) {
      const date = safeDate(raw && raw.date);
      if (!date) {
        skipped++;
        continue;
      }
      const title = cleanName(raw.title, 120);
      const text = String(raw.body || "").replace(/\x00/g, "").slice(0, 200000);
      const mood = cleanName(raw.mood, 16);
      const cat = toCatId(raw.cat || raw.catName);
      if (!title && !mood && !text.trim()) {
        skipped++;
        continue;
      }
      const mine = { date, cat, title, body: text, mood };
      const sig = sigOf(mine);
      const target = mode === "overwrite" ? byId.get(String(raw.id || "")) || bySig.get(sig) : bySig.get(sig);
      if (target) {
        if (mode !== "overwrite") {
          skipped++;
          continue;
        }
        Object.assign(target, mine, { updatedAt: new Date().toISOString() });
        writeEntry(dir, target);
        bySig.set(sig, target);
        replaced++;
        continue;
      }
      const entry = Object.assign(
        {
          id: newId(),
          createdAt: String(raw.createdAt || "") || new Date().toISOString(),
          updatedAt: String(raw.updatedAt || "") || new Date().toISOString(),
        },
        mine
      );
      writeEntry(dir, entry);
      bySig.set(sig, entry);
      added++;
    }
    return sendJson(res, 200, { ok: true, added, skipped, replaced, catsAdded, mode });
  }

  if (route === "/api/overview" && method === "GET") {
    const list = allEntries(dir);
    let total = 0;
    const months = new Set();
    const days = new Set();
    for (const e of list) {
      total += String(e.body || "").length;
      months.add(e.date.slice(0, 7));
      days.add(e.date);
    }
    return sendJson(res, 200, {
      entries: list.length,
      days: days.size,
      months: months.size,
      totalChars: total,
    });
  }

  return sendJson(res, 404, { error: "接口不存在" });
}

const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split("?")[0];
  const query = new URL(req.url, "http://localhost").searchParams;
  const uid = getUid(req);

  try {
    // 只要路径里出现 /api/ 就交给接口处理，不依赖网关前缀的具体写法
    const apiAt = urlPath.indexOf("/api/");
    if (apiAt >= 0) {
      req.url = urlPath.slice(apiAt) + req.url.slice(urlPath.length);
      return await api(req, res, uid, query);
    }
    if (urlPath === PREFIX) {
      res.writeHead(302, { Location: PREFIX + "/" });
      return res.end();
    }
    if (urlPath.startsWith(PREFIX)) urlPath = urlPath.slice(PREFIX.length) || "/";
    return serveStatic(res, urlPath);
  } catch (error) {
    console.error("request failed:", error && error.message);
    return sendJson(res, 500, { error: "服务内部错误：" + (error && error.message) });
  }
});

process.on("uncaughtException", (e) => console.error("uncaught:", e && e.message));

if (SOCKET_PATH) {
  fs.rmSync(SOCKET_PATH, { force: true });
  server.listen(SOCKET_PATH, () => console.log("diary listening on " + SOCKET_PATH));
} else {
  server.listen(PORT, () => console.log(`diary running at http://localhost:${PORT}${PREFIX}`));
}
