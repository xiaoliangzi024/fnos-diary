"use strict";

/* 客户端本机的设置与同步状态，存 %APPDATA%\diary-client\state.json。
   这里面只有网址、账号编号和同步游标，绝不存 NAS 的口令——登录靠内嵌浏览器
   留下的 cookie，退出登录就是把那个分区的 cookie 清掉。
   游标和栏目对照表按「这台 NAS 的这个账号」各存一份，换网址、换账号互不影响。 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** 自动同步间隔只能取这几档（分钟，0=关） */
const EVERY = [0, 1, 5, 15, 30, 60];

function blank() {
  return {
    addresses: [], // [{ id, root, base, name }]
    active: "",
    every: 5, // 自动同步间隔（分钟），0 = 不自动同步
    shownUid: "local", // 本机现在展示哪个账号的日记（退出登录不改变它）
    logins: {}, // base -> { uid, username }
    accounts: {}, // "base|uid" -> { pullCursor, pushCursor, catMap }
    last: {}, // base -> 上次同步结果
  };
}

function load(file) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    raw = null;
  }
  const s = blank();
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.addresses)) s.addresses = raw.addresses.filter((a) => a && a.base);
    s.active = String(raw.active || "");
    /* 老状态文件里只有一个 auto 勾：勾着算 5 分钟，取消算关闭 */
    s.every = EVERY.includes(Number(raw.every)) ? Number(raw.every) : raw.auto === false ? 0 : 5;
    s.shownUid = /^[A-Za-z0-9_-]{1,12}$/.test(String(raw.shownUid || "")) ? String(raw.shownUid) : "local";
    s.logins = raw.logins && typeof raw.logins === "object" ? raw.logins : {};
    s.accounts = raw.accounts && typeof raw.accounts === "object" ? raw.accounts : {};
    s.last = raw.last && typeof raw.last === "object" ? raw.last : {};
  }
  if (!s.addresses.some((a) => a.id === s.active)) s.active = s.addresses.length ? s.addresses[0].id : "";
  return s;
}

function save(file, state) {
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function newAddressId() {
  return "a" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
}

function stateKey(base, uid) {
  return base + "|" + uid;
}

function accountState(state, base, uid) {
  const k = stateKey(base, uid);
  if (!state.accounts[k]) state.accounts[k] = { pullCursor: "", pushCursor: "", catMap: {} };
  const s = state.accounts[k];
  if (!s.catMap || typeof s.catMap !== "object") s.catMap = {};
  return s;
}

/** 每条 NAS 地址一个独立的浏览器分区：cookie 是跟着来源走的，
    共用一个分区会让两台 NAS 互相认成已登录。
    勾了"不保持登录"就用不带 persist: 的分区，cookie 只在内存里，关掉程序就没了 */
function partitionOf(base, keep) {
  const tag = crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 10);
  return (keep === false ? "" : "persist:") + "nas-" + tag;
}

module.exports = { load, save, blank, EVERY, newAddressId, stateKey, accountState, partitionOf };
