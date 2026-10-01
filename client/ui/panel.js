"use strict";

/* 设置面板的全部逻辑都在这儿：只认 panel.* 这几个接口，碰不到硬盘也碰不到口令。 */

const $ = (id) => document.getElementById(id);
/* 面板只能给这几个档，跟主进程白名单一致（从下拉框自己读，免得两处数字对不上） */
const EVERY = Array.prototype.map.call($("every").options, (o) => Number(o.value));
let data = { addresses: [], every: 5, syncing: false, pending: 0, needsLogin: true, shownName: "", dataDir: "" };
const logs = [];

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function addLog(text, kind) {
  logs.unshift({ text, kind: kind || "", at: new Date() });
  if (logs.length > 40) logs.pop();
  renderLog();
}

function renderLog() {
  $("log").innerHTML = logs
    .map((l) => '<li class="' + esc(l.kind) + '">' + esc(fmtTime(l.at.toISOString())) + " " + esc(l.text) + "</li>")
    .join("");
  if (!logs.length) $("log").innerHTML = '<li class="mute">还没有同步记录。</li>';
}

function render() {
  const cur = data.addresses.find((a) => a.active);
  $("data-dir").textContent = "存在：" + data.dataDir;
  $("every").value = String(EVERY.indexOf(Number(data.every)) >= 0 ? Number(data.every) : 5);

  const badge = $("state-badge");
  if (data.syncing) {
    badge.className = "badge warn";
    badge.textContent = "正在同步…";
  } else if (!cur) {
    badge.className = "badge warn";
    badge.textContent = "还没有 NAS 地址";
  } else if (data.needsLogin) {
    badge.className = "badge warn";
    badge.textContent = "需要登录";
  } else if (data.pending > 0) {
    badge.className = "badge warn";
    badge.textContent = "还有 " + data.pending + " 处改动没传上去";
  } else {
    badge.className = "badge ok";
    badge.textContent = "已经同步好了";
  }
  $("btn-sync").disabled = !cur || data.syncing;

  const last = cur && cur.last;
  $("last-line").textContent = last
    ? "上次同步：" + fmtTime(last.at) + (last.ok ? " 成功" : " 没成功") + (last.error ? "（" + last.error + "）" : "")
    : cur
      ? "这台地址还没同步过。"
      : "";
  $("account-line").textContent = "本机现在放的是「" + data.shownName + "」的日记。换 NAS 或换账号，登录一次就自动切过去。";
  $("login-need").style.display = cur && data.needsLogin ? "" : "none";
  $("empty-hint").style.display = data.addresses.length ? "none" : "";

  $("addrs").innerHTML = data.addresses
    .map((a) => {
      const logged = !!a.uid;
      return (
        '<div class="addr' + (a.active ? " cur" : "") + '">' +
        "<div><strong>" +
        esc(a.name || "未命名地址") +
        "</strong>" +
        (a.active ? ' <span class="badge ok">当前在用</span>' : "") +
        " " +
        (logged ? '<span class="badge ok">已登录：' + esc(a.username || a.uid) + "</span>" : '<span class="badge warn">还没登录</span>') +
        "</div>" +
        '<div class="url">' +
        esc(a.base) +
        "</div>" +
        '<div class="ops">' +
        (a.active ? "" : '<button data-act="pick" data-id="' + a.id + '">用这条</button>') +
        '<button data-act="login" data-id="' + a.id + '">' +
        (logged ? "换一个账号" : "登录 NAS") +
        "</button>" +
        (logged ? '<button data-act="logout" data-id="' + a.id + '">退出登录</button>' : "") +
        '<button data-act="test" data-id="' + a.id + '">测一下</button>' +
        '<button data-act="up" data-id="' + a.id + '">上移</button>' +
        '<button data-act="down" data-id="' + a.id + '">下移</button>' +
        '<button data-act="del" data-id="' + a.id + '">删除</button>' +
        '<label class="keep"><input type="checkbox" data-act="keep" data-id="' +
        a.id +
        '"' +
        (a.keep === false ? "" : " checked") +
        " /> 保持登录</label>" +
        "</div>" +
        "</div>"
      );
    })
    .join("");
}

async function refresh() {
  data = (await panel.data()) || data;
  render();
}

/* 面板上的所有按钮 */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const id = b.dataset.id;
  const act = b.dataset.act;
  try {
    if (act === "pick") data = await panel.pick(id);
    if (act === "up") data = await panel.move(id, -1);
    if (act === "down") data = await panel.move(id, 1);
    if (act === "test") {
      addLog("正在测这条地址…");
      const r = await panel.test(id);
      if (r.error) addLog("测不通：" + r.error, "err");
      else if (r.needLogin) addLog("地址是通的，但要登录 NAS", "warn");
      else addLog("通了：NAS 上登录的是「" + (r.username || r.uid) + "」", "ok");
      await refresh();
    }
    if (act === "login") {
      await panel.login(id);
      addLog("登录窗口已经打开，输完口令它会自己关。");
    }
    if (act === "logout") {
      data = await panel.logout(id);
      addLog("已退出这条地址的登录，本机的日记还在，照常能写。", "warn");
    }
    if (act === "del") {
      if (!confirm("删除这条地址？本机的日记不会被删，只是不再往它同步。")) return;
      data = await panel.remove(id);
    }
  } catch (err) {
    addLog("操作失败：" + ((err && err.message) || err), "err");
  }
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.act === "keep") {
    data = await panel.keep(t.dataset.id, t.checked);
    addLog(t.checked ? "这条地址改成保持登录，下次打开不用再登录。" : "这条地址改成不保持登录，关掉程序就要重新登录。", "warn");
  }
  if (t.id === "every") {
    data = await panel.every(Number(t.value));
    addLog("自动同步改成「" + t.options[t.selectedIndex].text + "」" + (Number(t.value) ? "。" : "，要传的时候点上面「立即同步」。"));
  }
});

$("btn-sync").addEventListener("click", () => panel.sync());
$("btn-login-now").addEventListener("click", async () => {
  const cur = data.addresses.find((a) => a.active);
  if (cur) {
    await panel.login(cur.id);
    addLog("登录窗口已经打开，输完口令它会自己关。");
  }
});
$("btn-open-data").addEventListener("click", () => panel.openData());
$("btn-add").addEventListener("click", async () => {
  const url = $("new-url").value.trim();
  const name = $("new-name").value.trim();
  $("add-msg").textContent = "";
  if (!url) {
    $("add-msg").textContent = "先填网址。";
    return;
  }
  $("btn-add").disabled = true;
  try {
    const r = await panel.add(url, name);
    if (r.error) {
      $("add-msg").textContent = r.error;
      addLog("添加失败：" + r.error, "err");
    } else {
      $("new-url").value = "";
      $("new-name").value = "";
      addLog("已添加：" + r.base + (r.needLogin ? "（还需要登录一次）" : ""), r.needLogin ? "warn" : "ok");
      await refresh();
    }
  } catch (err) {
    $("add-msg").textContent = "添加出错：" + ((err && err.message) || err);
  } finally {
    $("btn-add").disabled = false;
  }
});

panel.onState((d) => {
  data = d || data;
  render();
});

panel.onSync((d) => {
  if (d && d.running) {
    data.syncing = true;
    render();
    addLog("开始同步…");
    return;
  }
  data.syncing = false;
  if (!d) return;
  if (d.ok) {
    const p = d.pull || {};
    const q = d.push || {};
    addLog(
      "同步完成：取回 " +
        (p.updated || 0) +
        " 篇、清掉 " +
        (p.deleted || 0) +
        " 篇删除；传上去 " +
        (q.pushed || 0) +
        " 篇、清掉 " +
        (q.deleted || 0) +
        " 篇删除。" +
        ((d.pull && d.pull.cats) || (d.push && d.push.cats) ? "栏目也一起动了 " + ((d.pull.cats || 0) + (d.push.cats || 0)) + " 处。" : ""),
      "ok"
    );
  } else if (d.busy) {
    addLog("上一次还没结束，这次先不抢。", "warn");
  } else {
    addLog("同步没完成：" + (d.error || "不知道哪儿断了"), d.needsLogin ? "warn" : "err");
  }
  if (Array.isArray(d.messages)) d.messages.forEach((m) => addLog(m));
  refresh();
});

panel.onLog((d) => {
  if (d && d.line) addLog(d.line);
});

renderLog();
refresh();
