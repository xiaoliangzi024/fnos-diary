"use strict";

/* ------------------------------------------------------------------------------
   日记本 Windows 客户端的同步引擎（纯 Node，不依赖 Electron）。

   客户端本机跑的就是飞牛上那同一份 server.js（同一套文件布局、同一个界面），
   那份服务已经有 /api/changes，所以同步是对称的两件事：
     推 = 按 pushCursor 从本机翻页取改动，一条条打到 NAS
     拉 = 按 pullCursor 从 NAS 翻页取改动，一条条灌进本机
   本机库天然就是待传队列，不用另建一份队列文件，也就不会出现
   "队列写好了、日记没写进去"这种半截状态。

   栏目编号：本机这套服务自己发号（c1、c2…），NAS 那套也自己发号，
   同一条「钓鱼」在两边编号很可能不同。所以引擎不猜编号，只维护一张
   「本机编号 → NAS 编号」的对照表（state.catMap），每轮同步先按栏目名
   双向对齐一次。这张表只是缓存：删了它、换台电脑、换个账号，
   靠同名栏目一样能重新对上，不会把日记弄丢。
   日记编号不用这张表——编号本身带随机串，两台机器不会撞。

   远端那个"要带登录 cookie 的 fetch"由外面喂进来：Electron 里是 session.fetch，
   测试里就是普通 fetch。引擎只管数据，不管界面。
------------------------------------------------------------------------------ */

const PAGE = 200;

/** 把 /app/diary 这种基址拼成接口地址 */
function apiUrl(base, route) {
  return String(base).replace(/\/+$/, "") + route;
}

/**
 * 一次请求。ok=false 分两类，性质完全不同：
 *  - portal=true：拿回来的已经不是接口，而是飞牛的登录门户页 → 这条地址当前没登录
 *  - 其他：网络不通 / NAS 上没装新版 / 服务器报错
 */
async function call(fetcher, method, url, body) {
  let res;
  try {
    res = await fetcher(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, net: true, error: (e && e.message) || "网络不通" };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = null;
  }
  if (!json) {
    return { ok: false, portal: true, status: res.status, snippet: text.slice(0, 120) };
  }
  if (!res.ok) return { ok: false, status: res.status, error: json.error || "HTTP " + res.status, json };
  return { ok: true, json };
}

/** 从一侧按游标翻页取改动，一直翻到 more=false；半路停下的游标会丢事件，所以不认 */
async function takeChanges(fetcher, base, since) {
  const out = { updated: [], deleted: [], cats: [], catsDeleted: [], cursor: since || "", rounds: 0 };
  let cur = since || "";
  for (;;) {
    const r = await call(fetcher, "GET", apiUrl(base, "/api/changes?since=" + encodeURIComponent(cur) + "&limit=" + PAGE));
    if (!r.ok) return { abort: true, error: r };
    const j = r.json;
    out.updated = out.updated.concat(j.updated || []);
    out.deleted = out.deleted.concat(j.deleted || []);
    out.cats = out.cats.concat(j.cats || []);
    out.catsDeleted = out.catsDeleted.concat(j.catsDeleted || []);
    out.rounds++;
    if (j.more) {
      cur = j.cursor;
      if (!cur) return { abort: true, error: { ok: false, error: "翻页翻不动了：游标没有前进" } };
      continue;
    }
    out.cursor = j.cursor;
    return out;
  }
}

/* ------------------------------------------------------------------ 栏目编号对照表 */

function catMapOf(state) {
  if (!state.catMap || typeof state.catMap !== "object") state.catMap = {};
  return state.catMap;
}

/** 反查：NAS 上这个编号对应本机哪个编号 */
function localIdFor(map, remoteId) {
  for (const k in map) {
    if (map[k] === remoteId) return k;
  }
  return "";
}

async function listCats(store) {
  const r = await call(store.fetch, "GET", apiUrl(store.base, "/api/categories"));
  if (!r.ok) return { error: r };
  return { items: r.json.items || [] };
}

/**
 * 两边栏目按名字对齐：缺的补建，同名对上编号。
 * 这里绝不做改名——改名带时间戳，只有 /api/changes 那条事件才分得出谁新谁旧，
 * 在对齐的时候盲改会把旧设备补传的名字盖到新名字上。
 * 只有取栏目列表本身失败（断网、没登录）才算这轮做不下去。
 */
async function reconcileCats(local, remote, map, log) {
  const L = await listCats(local);
  if (L.error) return { abort: true, error: L.error };
  const R = await listCats(remote);
  if (R.error) return { abort: true, error: R.error };

  const rIds = new Set(R.items.map((c) => c.id));
  const lUsed = new Set();

  // 1) 本机有的栏目：NAS 上没有就在 NAS 上建一个，名字对上的直接记编号
  for (const c of L.items) {
    let rid = map[c.id];
    if (rid && !rIds.has(rid)) rid = ""; // NAS 上这个栏目已经被删了，对照作废
    if (rid) {
      lUsed.add(c.id);
      continue;
    }
    const hit = R.items.find((x) => x.name === c.name);
    if (hit && !lUsed.has(hit.id) && !localIdFor(map, hit.id)) {
      map[c.id] = hit.id;
      lUsed.add(c.id);
      continue;
    }
    const n = await call(remote.fetch, "POST", apiUrl(remote.base, "/api/categories"), { name: c.name });
    if (!n.ok) {
      log("栏目「" + c.name + "」没能在 NAS 上建起来：" + (n.error || "连不上"));
      if (n.portal || n.net) return { abort: true, error: n };
      continue;
    }
    const back = n.json.item && n.json.item.id;
    if (back) {
      map[c.id] = back;
      lUsed.add(c.id);
    }
  }

  // 2) NAS 上本机还没有的栏目，在本机建出来，本机才有地方放这些日记
  for (const c of R.items) {
    if (localIdFor(map, c.id)) continue; // 已经配上了（名字不同也先不动，改名交给事件处理）
    const hit = L.items.find((x) => x.name === c.name);
    if (hit) {
      if (lUsed.has(hit.id) || map[hit.id]) {
        log("栏目「" + c.name + "」本机已经另有一个同名的，先不动，请在栏目里核对一下");
        continue;
      }
      map[hit.id] = c.id;
      lUsed.add(hit.id);
      continue;
    }
    const n = await call(local.fetch, "POST", apiUrl(local.base, "/api/categories"), {
      id: c.id,
      name: c.name,
    });
    if (!n.ok) {
      log("本机建栏目「" + c.name + "」失败：" + (n.error || "连不上"));
      continue;
    }
    if (n.json.removed) {
      log("栏目「" + c.name + "」本机已经删过了，这一轮不再取回来");
      continue;
    }
    const back = n.json.item && n.json.item.id;
    if (back) map[back] = c.id;
  }
  return { abort: false };
}

/* ---------------------------------------------------------------- 推（本机 → NAS） */

async function pushSide(local, remote, pushCursor, map, log) {
  const res = { pushed: 0, pushFail: 0, deleted: 0, cats: 0, catsFail: 0, cursor: pushCursor, error: null };
  const take = await takeChanges(local.fetch, local.base, pushCursor, log);
  if (take.abort) {
    res.error = take.error;
    return res;
  }

  // 本机删掉的栏目先落到 NAS。这一步必须在栏目对齐之前：
  // 对齐是"本机有的栏目 NAS 上也要有"，NAS 刚删掉的会被它重新建回去
  for (const id of take.catsDeleted.map((c) => c.id)) {
    const rid = map[id];
    delete map[id]; // 本机已经没这条栏目了，对照留着没用
    if (!rid) continue; // 这条栏目从没同步出去过，NAS 上没什么要删的
    const r = await call(remote.fetch, "POST", apiUrl(remote.base, "/api/categories/delete"), { id: rid });
    if (r.ok || r.status === 404) res.cats++;
    else if (r.portal || r.net) {
      res.error = r;
      return res;
    } else res.catsFail++;
  }

  // 栏目先对齐：日记挂的栏目编号要在 NAS 上先存在，不然这一篇会白落进未分类
  const rc = await reconcileCats(local, remote, map, log);
  if (rc.abort) {
    res.error = rc.error;
    return res;
  }

  // 删掉的栏目先记下：同一轮里"这条栏目又改过、又被删了"，以删除为准，别再建回去
  const dead = new Set(take.catsDeleted.map((c) => c.id));

  for (const c of take.cats) {
    if (dead.has(c.id)) continue;
    const rid = map[c.id];
    if (rid) {
      const r = await call(remote.fetch, "POST", apiUrl(remote.base, "/api/categories/rename"), {
        id: rid,
        name: c.name,
        updatedAt: c.updatedAt,
      });
      if (r.ok) {
        res.cats++;
        continue;
      }
      if (r.portal || r.net) {
        res.error = r;
        return res;
      }
      // NAS 上这个栏目没了（404）或者名字撞了别的栏目（400）：按名字重新对一次
      if (r.status !== 404 && r.status !== 400) {
        res.catsFail++;
        log("栏目「" + c.name + "」改名没同步过去：" + (r.error || ""));
        continue;
      }
      delete map[c.id];
    }
    const n = await call(remote.fetch, "POST", apiUrl(remote.base, "/api/categories"), {
      name: c.name,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    });
    if (!n.ok) {
      if (n.portal || n.net) {
        res.error = n;
        return res;
      }
      res.catsFail++;
      log("栏目「" + c.name + "」推失败：" + (n.error || ""));
      continue;
    }
    if (n.json.removed) {
      // NAS 上这条栏目被删过、而且删得比本机这份晚：删除赢，本机这份跟着删
      await call(local.fetch, "POST", apiUrl(local.base, "/api/categories/delete"), { id: c.id });
      delete map[c.id];
      log("栏目「" + c.name + "」在 NAS 上已被删除，本机这份也一并删掉了");
      continue;
    }
    const back = n.json.item && n.json.item.id;
    if (back) map[c.id] = back;
    res.cats++;
  }

  for (const e of take.updated) {
    let cat = "";
    if (e.cat) {
      cat = map[e.cat] || "";
      if (!cat) log("《" + (e.title || "无标题") + "》挂的栏目没能同步到 NAS，这篇先落在未分类");
    }
    const r = await call(remote.fetch, "POST", apiUrl(remote.base, "/api/entry"), {
      id: e.id,
      date: e.date,
      cat,
      title: e.title,
      body: e.body,
      mood: e.mood,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    });
    if (!r.ok) {
      if (r.portal || r.net) {
        res.error = r;
        return res;
      }
      res.pushFail++;
      log("《" + (e.title || "无标题") + "》推失败：" + (r.error || ""));
      continue;
    }
    if (r.json.catFallback && r.json.wantCat) {
      log("《" + (e.title || "无标题") + "》的栏目 NAS 上还没有，先落未分类，下轮再归位");
    }
    res.pushed++;
  }

  for (const id of take.deleted.map((d) => d.id)) {
    const r = await call(remote.fetch, "DELETE", apiUrl(remote.base, "/api/entry?id=" + encodeURIComponent(id)));
    if (r.portal || r.net) {
      res.error = r;
      return res;
    }
    if (r.ok || r.status === 404) res.deleted++;
    else res.pushFail++;
  }
  res.cursor = take.cursor;
  return res;
}

/* ---------------------------------------------------------------- 拉（NAS → 本机） */

async function pullSide(local, remote, pullCursor, map, log) {
  const res = { updated: 0, deleted: 0, cats: 0, catsDeleted: 0, cursor: pullCursor, error: null };
  const take = await takeChanges(remote.fetch, remote.base, pullCursor, log);
  if (take.abort) {
    res.error = take.error;
    return res;
  }
  // NAS 删掉的栏目先落到本机，再做对齐：对齐是"NAS 有的栏目本机也要有"，
  // 刚删掉的那条会被重新建回本机，而且编号对照表要在这一步清干净
  for (const id of take.catsDeleted.map((c) => c.id)) {
    const lid = localIdFor(map, id);
    if (!lid) {
      res.catsDeleted++; // 本机没有这条栏目，等于已经是删掉的状态
      continue;
    }
    const r = await call(local.fetch, "POST", apiUrl(local.base, "/api/categories/delete"), { id: lid });
    if (r.ok || r.status === 404) {
      delete map[lid];
      res.catsDeleted++;
    }
  }
  const dead = new Set(take.catsDeleted.map((c) => c.id));

  const rc = await reconcileCats(local, remote, map, log);
  if (rc.abort) {
    res.error = rc.error;
    return res;
  }

  for (const c of take.cats) {
    if (dead.has(c.id)) continue; // 这一轮里它已经被删掉了，别再改名建回来
    const lid = localIdFor(map, c.id);
    if (!lid) continue; // 对齐那一轮已经把它建出来了
    const r = await call(local.fetch, "POST", apiUrl(local.base, "/api/categories/rename"), {
      id: lid,
      name: c.name,
      updatedAt: c.updatedAt,
    });
    if (r.ok) res.cats++;
    else if (r.status !== 404 && r.status !== 400) log("栏目「" + c.name + "」本机落地失败：" + (r.error || ""));
  }

  for (const e of take.updated) {
    let cat = "";
    if (e.cat) {
      cat = localIdFor(map, e.cat);
      if (!cat) log("《" + (e.title || "无标题") + "》的栏目本机还没有，先落未分类");
    }
    const r = await call(local.fetch, "POST", apiUrl(local.base, "/api/entry"), {
      id: e.id,
      date: e.date,
      cat,
      title: e.title,
      body: e.body,
      mood: e.mood,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    });
    if (r.ok) res.updated++;
    else log("《" + (e.title || "无标题") + "》落地失败：" + (r.error || ""));
  }

  for (const id of take.deleted.map((d) => d.id)) {
    const r = await call(local.fetch, "DELETE", apiUrl(local.base, "/api/entry?id=" + encodeURIComponent(id)));
    if (r.ok || r.status === 404) res.deleted++;
  }
  res.cursor = take.cursor;
  return res;
}

/* -------------------------------------------------------------------- 一轮完整同步 */

/**
 * cfg = { local:{base,fetch}, remote:{base,fetch}, state, log }
 * state 由调用方存盘：{ pullCursor, pushCursor, catMap }，本函数就地写回新的值。
 * state 要按「这条地址 + 这个账号」各存一份：换网址、换账号都不能沿用旧的游标，
 * 不然新 NAS 上比旧游标更早的改动就永远拉不下来了。
 *
 * 先拉后推：先把别人删掉的东西落到本机，再推本机这轮的改动，
 * 省得把一台设备早已删掉的日记又补传上去。
 * 拉/推各自成功就各自记账：中途断网只丢一半进度，另一半不用重跑。
 */
async function syncOnce(cfg) {
  const local = cfg.local;
  const remote = cfg.remote;
  const log = cfg.log || function () {};
  const state = cfg.state || {};
  const map = catMapOf(state);
  const out = { ok: false, needsLogin: false, pull: null, push: null };

  const info = await call(remote.fetch, "GET", apiUrl(remote.base, "/api/info"));
  if (!info.ok) {
    out.needsLogin = !!info.portal;
    out.error = info.portal ? "这条地址还没登录（拿回来的是飞牛的登录页面）" : "连不上这条地址：" + (info.error || "");
    return out;
  }
  if (!info.json.syncApi) {
    out.error = "这台 NAS 上的日记本太旧（" + info.json.version + "），先升级到 0.4.1 以上再同步";
    return out;
  }
  if (info.json.client) {
    out.error = "这条地址是另一台电脑上的日记本客户端，同步要填 NAS 上那一份的地址";
    return out;
  }

  out.pull = await pullSide(local, remote, state.pullCursor || "", map, log);
  if (out.pull.error) {
    out.needsLogin = !!out.pull.error.portal;
    out.error = "取不下来：" + (out.pull.error.error || "连不上");
    return out;
  }
  state.pullCursor = out.pull.cursor;

  out.push = await pushSide(local, remote, state.pushCursor || "", map, log);
  if (out.push.error) {
    out.needsLogin = !!out.push.error.portal;
    out.error = "传不上去：" + (out.push.error.error || "连不上");
    return out;
  }
  state.pushCursor = out.push.cursor;

  out.ok = true;
  return out;
}

module.exports = { syncOnce, call, apiUrl, takeChanges, reconcileCats, localIdFor, catMapOf, PAGE };
