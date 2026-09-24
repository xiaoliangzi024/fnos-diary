(function () {
  "use strict";

  var BASE = (function () {
    var p = location.pathname.replace(/index\.html$/, "");
    if (p.charAt(p.length - 1) !== "/") p = p.slice(0, p.lastIndexOf("/") + 1);
    return p;
  })();

  var MOODS = ["开心", "平静", "一般", "疲惫", "难过"];
  var WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];
  var PAGE_STEPS = [10, 20, 30, 50];
  var PAGE_DEFAULT = 20;
  var pageKey = "diary-page-size";
  var FEED_PAGE = PAGE_DEFAULT;

  function el(id) {
    return document.getElementById(id);
  }
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function iso(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var calendar = el("calendar");
  var monthLabel = el("month-label");
  var catList = el("cat-list");
  var catInput = el("cat-input");
  var catSelect = el("cat-select");
  var titleEl = el("title");
  var bodyEl = el("body");
  var moodsEl = el("moods");
  var statusEl = el("status");
  var saveBtn = el("btn-save");
  var againBtn = el("btn-again");
  var deleteBtn = el("btn-delete");
  var dateInput = el("edit-date");
  var statsEl = el("stats");
  var searchEl = el("search");

  var postList = el("post-list");
  var feedEl = el("feed");
  var postEl = el("post");
  var editEl = el("edit");

  var now = new Date();
  var todayStr = iso(now);
  var viewYear = now.getFullYear();
  var viewMonth = now.getMonth() + 1;

  var cats = [];
  var catTotal = 0;
  var catLoose = 0;
  var monthItems = [];

  // 当前看的是哪一批文章：栏目 / 某一天 / 搜索词
  var filter = { cat: "all", day: "", q: "" };
  var feedItems = [];
  var feedTotal = 0;
  var feedSkip = 0;
  var feedLoading = false;

  var draft = { id: "", date: todayStr, cat: "", title: "", body: "", mood: "" };
  var readingPost = { id: "", date: "", cat: "", title: "", body: "", mood: "" };
  var backTarget = { view: "feed", id: "" };

  var view = "feed";
  var dirty = false;
  var batchMode = false;
  var selected = {};
  var selectedCount = 0;

  var FS_STEPS = [16, 18, 20, 22, 24, 26, 28, 30];
  var FS_DEFAULT = 18;
  var fontSize = FS_DEFAULT;
  var fsKey = "diary-font";

  function api(path, options) {
    return fetch(BASE + path, options).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : "请求失败（" + res.status + "）");
        return data;
      });
    });
  }

  function post(path, payload) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  }

  function toast(msg) {
    var t = el("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      t.classList.add("hidden");
    }, 3000);
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  /* ---------- 通用弹窗 ---------- */

  function dialog(cfg) {
    return new Promise(function (resolve) {
      var box = el("dialog");
      el("dialog-title").textContent = cfg.title || "";
      el("dialog-text").innerHTML = cfg.html || "";
      el("dialog-ok").textContent = cfg.okText || "确定";
      el("dialog-cancel").textContent = cfg.cancelText || "取消";
      el("dialog-cancel").classList.toggle("hidden", !cfg.cancelText);
      el("dialog-ok").classList.toggle("hidden", !cfg.okText);
      box.classList.remove("hidden");
      var input = box.querySelector("input[type=text]");
      if (input) input.focus();

      function close(value) {
        box.classList.add("hidden");
        el("dialog-ok").onclick = null;
        el("dialog-cancel").onclick = null;
        document.removeEventListener("keydown", onKey);
        resolve(value);
      }
      function ok() {
        close(cfg.getValue ? cfg.getValue() : true);
      }
      function onKey(ev) {
        if (ev.key === "Escape") close(null);
        if (ev.key === "Enter" && (!input || document.activeElement === input || !cfg.getValue)) {
          ev.preventDefault();
          ok();
        }
      }
      el("dialog-ok").onclick = ok;
      el("dialog-cancel").onclick = function () {
        close(null);
      };
      document.addEventListener("keydown", onKey);
    });
  }

  function promptText(title, value, okText) {
    return dialog({
      title: title,
      html: '<input id="dlg-input" type="text" maxlength="20" value="' + esc(value || "") + '" />',
      okText: okText || "确定",
      cancelText: "取消",
      getValue: function () {
        var i = el("dlg-input");
        return i ? i.value.trim() : "";
      },
    });
  }

  /* ---------- 日期与栏目 ---------- */

  function cnDate(isoStr) {
    var p = isoStr.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return Number(p[0]) + "年" + Number(p[1]) + "月" + Number(p[2]) + "日 星期" + WEEK_CN[d.getDay()];
  }

  function shortDate(isoStr) {
    var p = isoStr.split("-");
    return Number(p[1]) + "月" + Number(p[2]) + "日";
  }

  function weekCn(isoStr) {
    var p = isoStr.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return "周" + WEEK_CN[d.getDay()];
  }

  function longDay(isoStr) {
    var p = isoStr.split("-");
    return Number(p[0]) + " 年 " + Number(p[1]) + " 月 " + Number(p[2]) + " 日";
  }

  function relDate(isoStr) {
    var days = Math.round((new Date(todayStr + "T00:00:00") - new Date(isoStr + "T00:00:00")) / 86400000);
    if (days === 0) return "今天";
    if (days === 1) return "昨天";
    if (days === -1) return "明天";
    if (days > 1) return days + " 天前";
    return "还有 " + -days + " 天";
  }

  function hhmm(isoTs) {
    if (!isoTs) return "";
    var d = new Date(isoTs);
    if (isNaN(d.getTime())) return "";
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function catName(id) {
    if (!id || id === "none") return "未分类";
    var c = cats.find(function (x) {
      return x.id === id;
    });
    return c ? c.name : "未分类";
  }

  // 下拉里的"栏目"值：真实 id，或 "none" 表示未分类
  function catForEntry(cat) {
    return cats.some(function (c) {
      return c.id === cat;
    })
      ? cat
      : "none";
  }

  function inCat(it, cat) {
    if (!cat || cat === "all") return true;
    if (cat === "none") return !it.cat;
    return it.cat === cat;
  }

  /* ---------- 栏目 ---------- */

  function loadCats() {
    return api("api/categories").then(function (data) {
      cats = data.items;
      catTotal = data.total;
      catLoose = data.loose || 0;
      renderCats();
      renderCatSelect();
    });
  }

  function renderCats() {
    catList.innerHTML = "";
    var rows = [{ id: "all", name: "全部日记", count: catTotal }].concat(cats);
    if (catLoose) rows.push({ id: "none", name: "未分类", count: catLoose });
    rows.forEach(function (c) {
      var li = document.createElement("li");
      if (filter.cat === c.id) li.className = "on";
      li.setAttribute("data-cat", c.id);

      var label = document.createElement("span");
      label.className = "cat-name";
      label.textContent = c.name;
      var n = document.createElement("span");
      n.className = "cat-count";
      n.textContent = c.count;
      li.appendChild(label);
      li.appendChild(n);

      if (c.id !== "all" && c.id !== "none") {
        var ops = document.createElement("span");
        ops.className = "cat-ops";
        var r = document.createElement("button");
        r.type = "button";
        r.textContent = "改名";
        r.setAttribute("data-ren", c.id);
        var d = document.createElement("button");
        d.type = "button";
        d.textContent = "删除";
        d.setAttribute("data-del", c.id);
        ops.appendChild(r);
        ops.appendChild(d);
        li.appendChild(ops);
      }
      catList.appendChild(li);
    });
  }

  function renderCatSelect() {
    catSelect.innerHTML = "";
    cats.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      catSelect.appendChild(o);
    });
    var loose = document.createElement("option");
    loose.value = "none";
    loose.textContent = "未分类";
    catSelect.appendChild(loose);
    catSelect.value = catForEntry(draft.cat);
  }

  function addCat() {
    var name = catInput.value.trim();
    if (!name) {
      catInput.focus();
      return;
    }
    post("api/categories", { name: name })
      .then(function () {
        catInput.value = "";
        return loadCats();
      })
      .catch(function (e) {
        toast(e.message);
      });
  }

  function renameCat(id) {
    var item = cats.find(function (c) {
      return c.id === id;
    });
    if (!item) return;
    promptText("把栏目「" + item.name + "」改名为", item.name, "改名").then(function (name) {
      if (!name || name === item.name) return;
      post("api/categories/rename", { id: id, name: name })
        .then(function () {
          return refreshAll();
        })
        .catch(function (e) {
          toast(e.message);
        });
    });
  }

  function deleteCat(id) {
    var item = cats.find(function (c) {
      return c.id === id;
    });
    if (!item) return;
    var next = cats.find(function (c) {
      return c.id !== id;
    });
    var n = item.count || 0;
    var where = next ? "会自动并入「" + next.name + "」" : "会退回「全部日记」页面（未分类），等你新建栏目再归进去";
    dialog({
      title: "删除栏目「" + item.name + "」？",
      html:
        (n ? "这个栏目下有 <b>" + n + " 篇</b>日记，删掉栏目不会删日记，它们" + where + "。" : "这个栏目还没有日记，可以直接删掉。") +
        "<br><b>栏目本身删除后不可恢复。</b>",
      okText: "确认删除栏目",
      cancelText: "取消",
    }).then(function (ok) {
      if (!ok) return;
      post("api/categories/delete", { id: id })
        .then(function (r) {
          toast("栏目已删除，" + r.moved + " 篇挪进了「" + r.to + "」");
          if (filter.cat === id) filter.cat = "all";
          if (draft.cat === id) draft.cat = "";
          if (!draft.cat && cats.length) draft.cat = cats[0].id;
          return refreshAll();
        })
        .catch(function (e) {
          toast(e.message);
        });
    });
  }

  /* ---------- 日历 ---------- */

  function itemsOf(date) {
    return monthItems.filter(function (it) {
      return it.date === date && inCat(it, filter.cat);
    });
  }

  function renderCalendar() {
    monthLabel.textContent = viewYear + " 年 " + pad(viewMonth) + " 月";
    calendar.innerHTML = "";
    var first = new Date(viewYear, viewMonth - 1, 1);
    var offset = (first.getDay() + 6) % 7;
    var total = new Date(viewYear, viewMonth, 0).getDate();
    for (var i = 0; i < offset; i++) {
      var blank = document.createElement("div");
      blank.className = "cell blank";
      calendar.appendChild(blank);
    }
    for (var day = 1; day <= total; day++) {
      var dateStr = viewYear + "-" + pad(viewMonth) + "-" + pad(day);
      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.setAttribute("data-date", dateStr);
      var num = document.createElement("span");
      num.textContent = day;
      cell.appendChild(num);
      if (dateStr === todayStr) cell.classList.add("today");
      var mine = itemsOf(dateStr);
      if (mine.length) {
        cell.classList.add("has-entry");
        var dots = document.createElement("i");
        dots.className = "dot";
        if (mine.length > 1) dots.className = "dot dot-multi";
        dots.title = mine
          .map(function (m) {
            return m.catName + "：" + (m.title || "无标题");
          })
          .join("\n");
        cell.appendChild(dots);
        cell.title = mine.length + " 篇：" + dots.title;
      }
      if (filter.day === dateStr) cell.classList.add("active");
      calendar.appendChild(cell);
    }
  }

  function loadMonth() {
    var ym = viewYear + "-" + pad(viewMonth);
    return api("api/list?month=" + ym + "&cat=all").then(function (data) {
      monthItems = data.items;
      renderCalendar();
    });
  }

  function loadOverview() {
    return api("api/overview").then(function (d) {
      statsEl.innerHTML =
        "共 <b>" +
        d.entries +
        "</b> 篇，写了 <b>" +
        d.days +
        "</b> 天<br>跨越 <b>" +
        d.months +
        "</b> 个月，累计 <b>" +
        d.totalChars.toLocaleString("zh-CN") +
        "</b> 字";
    });
  }

  /* ---------- 文章列表（feed） ---------- */

  function feedScope() {
    if (filter.q) return "搜索「" + filter.q + "」";
    if (filter.day) return cnDate(filter.day);
    if (filter.cat === "all") return "全部日记";
    if (filter.cat === "none") return "未分类";
    return "栏目：" + catName(filter.cat);
  }

  function buildFeedQuery(skip, limit) {
    var tail = "&skip=" + skip + "&limit=" + limit;
    if (filter.q) {
      return "api/search?q=" + encodeURIComponent(filter.q) + "&cat=" + encodeURIComponent(filter.cat) + tail;
    }
    var u = "api/posts?cat=" + encodeURIComponent(filter.cat) + tail;
    if (filter.day) u += "&day=" + filter.day;
    return u;
  }

  // reset=true 重新从第一篇开始；false 往后面追加
  function loadFeed(reset) {
    var skip = reset ? 0 : feedSkip;
    feedLoading = true;
    if (reset) renderFeed();
    return api(buildFeedQuery(skip, FEED_PAGE))
      .then(function (data) {
        if (reset) feedItems = [];
        feedItems = feedItems.concat(data.items);
        feedTotal = data.total != null ? data.total : data.items.length;
        feedSkip = feedItems.length;
        feedLoading = false;
        renderFeed();
      })
      .catch(function (e) {
        feedLoading = false;
        feedItems = feedItems || [];
        renderFeed(e.message);
      });
  }

  function renderFeed(err) {
    el("feed-title").textContent = feedScope();
    var shown = feedItems.length;
    el("feed-count").textContent = err
      ? "读取失败"
      : shown + " / " + feedTotal + (filter.q ? " 篇命中" : " 篇");

    postList.innerHTML = "";
    if (!shown) {
      el("feed-empty").classList.remove("hidden");
      el("feed-more").classList.add("hidden");
      if (err) {
        el("feed-empty").textContent = "打不开日记列表：" + err;
      } else if (filter.q) {
        el("feed-empty").textContent = "没有找到包含「" + filter.q + "」的日记";
      } else if (filter.day) {
        el("feed-empty").innerHTML =
          esc(cnDate(filter.day)) + " 这一篇还没有写<br><button class=\"primary-btn\" type=\"button\" data-newdate=\"" +
          filter.day + '">写这一篇</button>';
      } else if (filter.cat !== "all") {
        el("feed-empty").innerHTML =
          "「" + esc(catName(filter.cat)) + "」里还没有文章<br><button class=\"primary-btn\" type=\"button\" data-newdate=\"" +
          todayStr + '">往这里写一篇</button>';
      } else {
        el("feed-empty").innerHTML =
          "还没有写过日记<br><button class=\"primary-btn\" type=\"button\" data-newdate=\"" + todayStr + '">写第一篇</button>';
      }
      updateBatchBar();
      return;
    }
    el("feed-empty").classList.add("hidden");

    feedItems.forEach(function (it) {
      postList.appendChild(cardOf(it));
    });

    var left = feedTotal - feedItems.length;
    el("feed-more").classList.toggle("hidden", left <= 0);
    if (left > 0) {
      el("btn-more").textContent = "再看更早的（还剩 " + left + " 篇）";
    }
    updateBatchBar();
  }

  function cardOf(it) {
    var li = document.createElement("li");
    li.className = "card" + (it.id === readingPost.id && view === "post" ? " on" : "");
    li.setAttribute("data-id", it.id);
    if (batchMode) {
      if (selected[it.id]) li.className += " picked";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.className = "chk-box";
      box.checked = !!selected[it.id];
      box.setAttribute("data-chk", it.id);
      box.setAttribute("aria-label", "选择 " + (it.title || "无标题"));
      li.appendChild(box);
    }

    var top = document.createElement("div");
    top.className = "card-top";
    var d = document.createElement("span");
    d.className = "card-date";
    d.textContent = longDay(it.date) + " " + weekCn(it.date) + (it.date === todayStr ? " · 今天" : "");
    top.appendChild(d);
    var tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = it.catName;
    top.appendChild(tag);
    if (it.mood) {
      var md = document.createElement("span");
      md.className = "mood-tag";
      md.textContent = it.mood;
      top.appendChild(md);
    }
    var t = document.createElement("div");
    t.className = "card-title";
    t.textContent = it.title || "无标题";
    var p = document.createElement("div");
    p.className = "card-preview";
    p.textContent = it.match || it.preview || "（正文为空）";
    var f = document.createElement("div");
    f.className = "card-foot";
    f.textContent = (it.chars || 0) + " 字" + (hhmm(it.updatedAt) ? " · 更新于 " + hhmm(it.updatedAt) : "");

    li.appendChild(top);
    li.appendChild(t);
    li.appendChild(p);
    li.appendChild(f);
    return li;
  }

  /* ---------- 批量删除 ---------- */

  function updateBatchBar() {
    el("btn-batch").textContent = batchMode ? "退出批量" : "批量删除";
    el("batch-bar").classList.toggle("hidden", !batchMode);
    el("batch-count").textContent = "已选 " + selectedCount + " 篇";
    var all = el("chk-all");
    all.checked = feedItems.length > 0 && feedItems.every(function (it) { return !!selected[it.id]; });
    el("btn-batch-del").disabled = selectedCount === 0;
  }

  function toggleBatch(on) {
    batchMode = typeof on === "boolean" ? on : !batchMode;
    if (!batchMode) {
      selected = {};
      selectedCount = 0;
    }
    postList.classList.toggle("batch", batchMode);
    renderFeed();
  }

  function pickEntry(id, want) {
    if (selected[id] === want) return;
    if (want) {
      selected[id] = true;
      selectedCount++;
    } else {
      delete selected[id];
      selectedCount--;
    }
    renderFeed();
  }

  function pickAll(want) {
    feedItems.forEach(function (it) {
      if (want ? !selected[it.id] : selected[it.id]) pickEntry(it.id, want);
    });
    updateBatchBar();
  }

  function deleteSelected() {
    var ids = Object.keys(selected);
    if (!ids.length) {
      toast("先勾出要删的日记");
      return;
    }
    var list = feedItems.filter(function (it) {
      return selected[it.id];
    });
    var sample = list
      .slice(0, 6)
      .map(function (it) {
        return "· " + it.date + " " + esc(it.title || "无标题") + "（" + esc(it.catName) + "）";
      })
      .join("<br>");
    dialog({
      title: "确认删除这 " + ids.length + " 篇日记？",
      html:
        (ids.length > 6 ? sample + "<br>…共 " + ids.length + " 篇" : sample) +
        '<br><br><b>删掉就找不回来了。</b>拿不准就先点"取消"，用「导出备份」存一份再删。',
      okText: "确认删除 " + ids.length + " 篇",
      cancelText: "取消",
    }).then(function (ok) {
      if (!ok) return;
      var wasReading = !!selected[readingPost.id];
      if (selected[draft.id]) draft.id = "";
      post("api/entries/delete", { ids: ids })
        .then(function (r) {
          toast("已删除 " + r.deleted + " 篇");
          selected = {};
          selectedCount = 0;
          batchMode = false;
          postList.classList.remove("batch");
          return refreshAll().then(function () {
            if (wasReading) showFeed();
            else renderFeed();
          });
        })
        .catch(function (e) {
          toast("删除失败：" + e.message);
        });
    });
  }

  /* ---------- 视图切换 ---------- */

  function setView(next) {
    view = next;
    feedEl.classList.toggle("hidden", next !== "feed");
    postEl.classList.toggle("hidden", next !== "post");
    editEl.classList.toggle("hidden", next !== "edit");
    if (window.scrollTo) window.scrollTo(0, 0);
    renderCats();
  }

  function showFeed() {
    setView("feed");
    if (view === "feed") renderFeed();
  }

  /* ---------- 单篇阅读 ---------- */

  function renderPost() {
    el("post-title").textContent = readingPost.title || "无标题";
    el("post-meta").textContent =
      cnDate(readingPost.date) +
      "（" +
      relDate(readingPost.date) +
      "） · " +
      catName(readingPost.cat) +
      (readingPost.mood ? " · " + readingPost.mood : "") +
      " · " +
      String(readingPost.body || "").replace(/\s/g, "").length +
      " 字" +
      (readingPost.updatedAt ? " · 更新于 " + readingPost.updatedAt.slice(0, 10) + " " + hhmm(readingPost.updatedAt) : "");
    el("post-body").innerHTML = (readingPost.body || "").trim()
      ? linkify(readingPost.body)
      : '<span class="post-empty">这篇还没有正文</span>';
    var idx = feedItems.findIndex(function (x) {
      return x.id === readingPost.id;
    });
    var next = idx >= 0 ? feedItems[idx + 1] : null;
    var nb = el("btn-next-post");
    nb.classList.toggle("hidden", !next);
    if (next) nb.textContent = "下一篇：" + (next.title || "无标题");
  }

  function openPost(id) {
    withLeave(function () {
      api("api/entry?id=" + encodeURIComponent(id))
        .then(function (data) {
          var e = data.entry;
          readingPost = {
            id: e.id,
            date: e.date,
            cat: e.cat,
            title: e.title,
            body: e.body,
            mood: e.mood,
            updatedAt: e.updatedAt,
          };
          setView("post");
          renderPost();
          renderFeed();
        })
        .catch(function (err) {
          toast(err.message);
          refreshAll();
        });
    });
  }

  function goNextPost() {
    var idx = feedItems.findIndex(function (x) {
      return x.id === readingPost.id;
    });
    var next = idx >= 0 ? feedItems[idx + 1] : null;
    if (next) openPost(next.id);
  }

  /* ---------- 写作 / 修改 ---------- */

  function renderMoods() {
    moodsEl.innerHTML = "";
    MOODS.forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "mood" + (draft.mood === m ? " on" : "");
      b.textContent = m;
      b.setAttribute("data-mood", m);
      moodsEl.appendChild(b);
    });
  }

  function fillEditor() {
    titleEl.value = draft.title;
    bodyEl.value = draft.body;
    dateInput.value = draft.date;
    renderCatSelect();
    renderMoods();
    deleteBtn.classList.toggle("hidden", !draft.id);
    againBtn.disabled = false;
  }

  function defaultCat() {
    if (filter.cat !== "all" && filter.cat !== "none") {
      return cats.some(function (c) {
        return c.id === filter.cat;
      })
        ? filter.cat
        : cats.length
          ? cats[0].id
          : "";
    }
    return cats.length ? cats[0].id : "";
  }

  function newEntry(dateStr) {
    withLeave(function () {
      var d = dateStr || filter.day || todayStr;
      draft = { id: "", date: d, cat: defaultCat(), title: "", body: "", mood: "" };
      backTarget = { view: "feed", id: "" };
      fillEditor();
      setDirty(false);
      setStatus("新的一篇 · " + cnDate(d) + "，写完点下面的保存按钮才会存进去", "");
      setView("edit");
      renderFeed();
      titleEl.focus();
    });
  }

  function editEntry(id) {
    api("api/entry?id=" + encodeURIComponent(id))
      .then(function (data) {
        var e = data.entry;
        draft = { id: e.id, date: e.date, cat: e.cat, title: e.title, body: e.body, mood: e.mood };
        backTarget = { view: "post", id: e.id };
        fillEditor();
        dirty = false;
        saveBtn.disabled = true;
        setStatus("正在修改这篇", "");
        setView("edit");
        titleEl.focus();
      })
      .catch(function (err) {
        toast(err.message);
        refreshAll();
      });
  }

  function collect() {
    return {
      id: draft.id || undefined,
      date: draft.date,
      cat: catSelect.value || "none",
      title: titleEl.value.trim(),
      body: bodyEl.value,
      mood: draft.mood,
    };
  }

  function setDirty(value) {
    dirty = value;
    saveBtn.disabled = !value;
    againBtn.disabled = !value;
    if (value) setStatus("还没保存，点下面的按钮才会存进去", "dirty");
  }

  // mode: "stay" 存完留在这里 | "again" 存完清空接着写 | "back" 存完回列表/原稿
  function save(mode) {
    var payload = collect();
    draft.cat = payload.cat === "none" ? "" : payload.cat;
    if (!payload.title && !payload.mood && !String(payload.body).trim()) {
      if (!draft.id) {
        toast("这篇还是空的，没有东西可存");
        return Promise.resolve();
      }
      return saveEmpty(payload, mode);
    }
    setStatus("正在保存…", "saving");
    return post("api/entry", payload)
      .then(function (data) {
        draft.id = data.entry.id;
        setDirty(false);
        deleteBtn.classList.remove("hidden");
        setStatus("已保存 · " + hhmm(data.entry.updatedAt), "saved");
        return refreshAll().then(function () {
          return { id: draft.id, removed: false };
        });
      })
      .then(function (r) {
        afterSave(r, mode);
      })
      .catch(function (e) {
        setStatus("保存失败：" + e.message, "dirty");
        toast("保存失败，内容还在输入框里，没丢");
        setDirty(true);
      });
  }

  // 存的时候内容被清空了：把原来那篇删掉，等同于删这篇
  function saveEmpty(payload, mode) {
    setStatus("正文清空了，正在把原来那篇去掉…", "saving");
    return api("api/entry?id=" + encodeURIComponent(draft.id), { method: "DELETE" })
      .then(function () {
        draft.id = "";
        setDirty(false);
        deleteBtn.classList.add("hidden");
        toast("这篇已经空了，顺手删掉了");
        return refreshAll().then(function () {
          return { id: "", removed: true };
        });
      })
      .then(function (r) {
        afterSave(r, mode === "again" ? "again" : "back");
      })
      .catch(function (e) {
        setStatus("保存失败：" + e.message, "dirty");
        toast("保存失败，内容还在输入框里，没丢");
        setDirty(true);
      });
  }

  function afterSave(r, mode) {
    if (mode === "again") {
      var keep = { date: draft.date, cat: draft.cat };
      draft = { id: "", date: keep.date, cat: keep.cat, title: "", body: "", mood: "" };
      fillEditor();
      setDirty(false);
      setStatus("已经存好了，这里接着写下篇", "");
      titleEl.focus();
      return;
    }
    if (mode === "back") {
      if (r.id && backTarget.view === "post" && !r.removed) openPost(r.id);
      else if (r.removed || backTarget.view !== "post") backToFeed();
      else openPost(r.id);
    }
  }

  function backToFeed() {
    showFeed();
  }

  function markEdit() {
    setDirty(true);
  }

  // 不自动保存，所以切走之前必须问一句：存 / 不存 / 留下继续写
  function leaveEditor() {
    if (view !== "edit" || !dirty) return Promise.resolve(true);
    var hasText = !!(titleEl.value.trim() || bodyEl.value.trim() || draft.mood);
    if (!hasText) {
      setDirty(false);
      return Promise.resolve(true);
    }
    return dialog({
      title: "这篇还没保存",
      html:
        "「" +
        esc(titleEl.value.trim() || "无标题") +
        "」有没保存的内容。<br><br>" +
        '<label><input type="radio" name="lv" value="save" checked /> 保存这篇，然后离开</label><br>' +
        '<label><input type="radio" name="lv" value="drop" /> 不保存，改动丢掉</label>',
      okText: "好",
      cancelText: "留下继续写",
      getValue: function () {
        var r = document.querySelector('input[name="lv"]:checked');
        return r ? r.value : "save";
      },
    }).then(function (choice) {
      if (!choice) return false;
      if (choice === "drop") {
        setDirty(false);
        return true;
      }
      return save("stay").then(function () {
        return !dirty;
      });
    });
  }

  function withLeave(fn) {
    leaveEditor().then(function (ok) {
      if (ok) fn();
    });
  }

  function removeEntry(id, after) {
    var item = feedItems.find(function (x) {
      return x.id === id;
    });
    var title = id === readingPost.id ? readingPost.title : item && item.title;
    var date = id === readingPost.id ? readingPost.date : item && item.date;
    var cat = id === readingPost.id ? readingPost.cat : item && item.cat;
    dialog({
      title: "删除这篇日记？",
      html:
        "「" +
        esc(title || "无标题") +
        "」<br>" +
        esc(date || "") +
        " · " +
        esc(catName(cat)) +
        "<br><b>删掉就找不回来了</b>，建议先导出一份备份。",
      okText: "确认删除",
      cancelText: "取消",
    }).then(function (ok) {
      if (!ok) return;
      api("api/entry?id=" + encodeURIComponent(id), { method: "DELETE" })
        .then(function () {
          toast("已删除");
          if (draft.id === id) draft.id = "";
          if (readingPost.id === id) readingPost.id = "";
          return refreshAll().then(function () {
            if (after) after();
          });
        })
        .catch(function (e) {
          toast(e.message);
        });
    });
  }

  /* ---------- 字号 ---------- */

  function applyFontSize() {
    document.documentElement.style.setProperty("--fs", fontSize + "px");
    el("fs-label").textContent = fontSize;
  }

  function loadFontSize() {
    var v = Number(localStorage.getItem(fsKey) || 0);
    if (FS_STEPS.indexOf(v) >= 0) fontSize = v;
    applyFontSize();
  }

  function stepFontSize(dir) {
    var i = FS_STEPS.indexOf(fontSize);
    if (i < 0) i = 1;
    var next = Math.min(FS_STEPS.length - 1, Math.max(0, i + dir));
    fontSize = FS_STEPS[next];
    localStorage.setItem(fsKey, String(fontSize));
    applyFontSize();
    toast("正文字号 " + fontSize + "，会一直记住");
  }

  /* ---------- 每页显示多少篇 ---------- */

  function loadPageSize() {
    var v = Number(localStorage.getItem(pageKey) || 0);
    FEED_PAGE = PAGE_STEPS.indexOf(v) >= 0 ? v : PAGE_DEFAULT;
    el("page-size").value = String(FEED_PAGE);
  }

  function setPageSize(v) {
    v = Number(v);
    if (PAGE_STEPS.indexOf(v) < 0) return;
    FEED_PAGE = v;
    localStorage.setItem(pageKey, String(v));
    // 换每页条数会重列，批量选择先退出，免得选中的篇被换到看不见
    if (batchMode) setBatch(false);
    loadFeed(true).then(function () {
      toast("每页显示 " + v + " 篇，这台设备上一直这样");
    });
  }

  /* ---------- 正文里的网址可以直接点开 ---------- */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function linkify(raw) {
    var text = String(raw || "");
    var re = /https?:\/\/[^\s<>"'。、，；：！？）】《]+/g;
    var out = "";
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      var url = m[0];
      var tail = "";
      while (/[.,;:!?)\]}"']/.test(url.slice(-1))) {
        if (url.slice(-1) === ")" && url.indexOf("(") < 0) break;
        tail = url.slice(-1) + tail;
        url = url.slice(0, -1);
      }
      if (!url) break;
      out += escapeHtml(text.slice(last, m.index));
      var shown = url.length > 60 ? url.slice(0, 57) + "…" : url;
      out +=
        '<a class="url" href="' +
        escapeHtml(url) +
        '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(shown) +
        "</a>" +
        escapeHtml(tail);
      last = m.index + m[0].length;
    }
    out += escapeHtml(text.slice(last));
    // 正文没有 HTML 标签，按空行分段，行内保留换行
    return out.replace(/\n/g, "<br>");
  }

  /* ---------- 搜索 ---------- */

  function runSearch() {
    var q = searchEl.value.trim();
    withLeave(function () {
      filter.q = q;
      if (q) filter.day = "";
      setView("feed");
      renderCalendar();
      loadFeed(true);
    });
  }

  /* ---------- 导入导出 ---------- */

  function doExport() {
    var a = document.createElement("a");
    a.href = BASE + "api/export?today=" + todayStr;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast("正在下载备份文件，里面是当前账号的全部日记");
  }

  function pickImportFile() {
    var input = el("import-file");
    input.value = "";
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onerror = function () {
        toast("文件读不出来");
      };
      reader.onload = function () {
        var data;
        try {
          data = JSON.parse(String(reader.result));
        } catch (err) {
          toast("这不是有效的备份文件（JSON 读不开）");
          return;
        }
        if (!data || !Array.isArray(data.entries)) {
          toast("这个文件里没有日记条目，确认是日记本导出的备份");
          return;
        }
        askImport(data, f.name);
      };
      reader.readAsText(f, "utf-8");
    };
    input.click();
  }

  function askImport(data, filename) {
    var catsN = Array.isArray(data.categories) ? data.categories.length : 0;
    dialog({
      title: "导入 " + data.entries.length + " 篇日记？",
      html:
        "文件：" +
        esc(filename) +
        "<br>备份时间：" +
        esc(String(data.exportedAt || "未知").slice(0, 10).replace(/-/g, "/")) +
        "<br>内含 " +
        catsN +
        " 个栏目、" +
        data.entries.length +
        " 篇日记<br><br>" +
        '<label><input type="radio" name="imp-mode" value="merge" checked /> 只补进新的（已存在的跳过，最安全）</label><br>' +
        '<label><input type="radio" name="imp-mode" value="overwrite" /> 同名条目用备份里的覆盖</label>',
      okText: "开始导入",
      cancelText: "取消",
      getValue: function () {
        var r = document.querySelector('input[name="imp-mode"]:checked');
        return { mode: r ? r.value : "merge", entries: data.entries, categories: data.categories || [] };
      },
    }).then(function (payload) {
      if (!payload) return;
      post("api/import", payload)
        .then(function (r) {
          toast("导入完成：新增 " + r.added + " 篇，跳过 " + r.skipped + " 篇，覆盖 " + r.replaced + " 篇");
          return refreshAll();
        })
        .catch(function (e) {
          toast("导入失败：" + e.message);
        });
    });
  }

  function refreshAll() {
    return Promise.all([loadCats(), loadMonth(), loadOverview()]).then(function () {
      return loadFeed(true);
    });
  }

  /* ---------- 事件 ---------- */

  function closestAttr(node, attr) {
    while (node && node !== document.body) {
      if (node.getAttribute && node.hasAttribute(attr)) return node.getAttribute(attr);
      node = node.parentNode;
    }
    return null;
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (t.tagName === "A" && t.classList && t.classList.contains("url")) return;

    var chk = closestAttr(t, "data-chk");
    if (chk && t.tagName === "INPUT") {
      ev.stopPropagation();
      ev.preventDefault();
      pickEntry(chk, t.checked);
      return;
    }
    if (batchMode && t.closest && t.closest(".card")) {
      var cardId = t.closest(".card").getAttribute("data-id");
      if (cardId) {
        ev.preventDefault();
        pickEntry(cardId, !selected[cardId]);
        return;
      }
    }

    if (t.id === "btn-more" || closestAttr(t, "data-more")) {
      if (!feedLoading) {
        feedLoading = true;
        loadFeed(false);
      }
      return;
    }
    var newDate = closestAttr(t, "data-newdate");
    if (newDate) {
      newEntry(newDate);
      return;
    }

    var mood = closestAttr(t, "data-mood");
    if (mood) {
      draft.mood = draft.mood === mood ? "" : mood;
      renderMoods();
      markEdit();
      return;
    }
    var ren = closestAttr(t, "data-ren");
    if (ren) {
      ev.stopPropagation();
      renameCat(ren);
      return;
    }
    var del = closestAttr(t, "data-del");
    if (del) {
      ev.stopPropagation();
      deleteCat(del);
      return;
    }
    var cat = closestAttr(t, "data-cat");
    if (cat) {
      withLeave(function () {
        filter.cat = cat;
        filter.day = "";
        filter.q = "";
        searchEl.value = "";
        setView("feed");
        renderCats();
        renderCalendar();
        loadFeed(true);
      });
      return;
    }
    var entryId = closestAttr(t, "data-id");
    if (entryId) {
      openPost(entryId);
      return;
    }
    var dateStr = closestAttr(t, "data-date");
    if (dateStr) {
      withLeave(function () {
        filter.day = filter.day === dateStr ? "" : dateStr;
        filter.q = "";
        searchEl.value = "";
        setView("feed");
        renderCalendar();
        loadFeed(true);
      });
      return;
    }

    switch (t.id) {
      case "prev-month":
      case "next-month":
        viewMonth += t.id === "prev-month" ? -1 : 1;
        if (viewMonth < 1) {
          viewMonth = 12;
          viewYear--;
        }
        if (viewMonth > 12) {
          viewMonth = 1;
          viewYear++;
        }
        loadMonth().catch(function (e) {
          toast(e.message);
        });
        break;
      case "btn-new":
        newEntry();
        break;
      case "btn-save":
        save("back");
        break;
      case "btn-again":
        save("again");
        break;
      case "btn-delete":
        if (draft.id) removeEntry(draft.id, showFeed);
        break;
      case "btn-del-this":
        if (readingPost.id) removeEntry(readingPost.id, showFeed);
        break;
      case "btn-edit-this":
        if (readingPost.id) editEntry(readingPost.id);
        break;
      case "btn-back":
      case "btn-edit-back":
        withLeave(showFeed);
        break;
      case "btn-next-post":
        goNextPost();
        break;
      case "btn-export":
        doExport();
        break;
      case "btn-import":
        pickImportFile();
        break;
      case "btn-cat-add":
        addCat();
        break;
      case "btn-batch":
      case "btn-batch-exit":
        toggleBatch();
        break;
      case "btn-batch-del":
        deleteSelected();
        break;
      case "btn-fs-up":
        stepFontSize(1);
        break;
      case "btn-fs-down":
        stepFontSize(-1);
        break;
      default:
        break;
    }
  });

  el("chk-all").addEventListener("change", function () {
    pickAll(this.checked);
  });

  titleEl.addEventListener("input", markEdit);
  bodyEl.addEventListener("input", markEdit);

  dateInput.addEventListener("change", function () {
    var v = dateInput.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      dateInput.value = draft.date;
      return;
    }
    draft.date = v;
    var p = v.split("-");
    viewYear = Number(p[0]);
    viewMonth = Number(p[1]);
    loadMonth().catch(function () {});
    if (dirty || titleEl.value.trim() || bodyEl.value.trim()) markEdit();
    else setStatus("这一篇的日期改成 " + cnDate(v) + "，点保存才生效", "");
  });

  catSelect.addEventListener("change", function () {
    var want = catSelect.value === "none" ? "" : catSelect.value;
    if (!draft.id) {
      draft.cat = want;
      setStatus("这一篇会放进「" + catName(want) + "」，点保存才存进去", "");
      return;
    }
    dialog({
      title: "把这篇挪到「" + catName(want) + "」？",
      html:
        "「" +
        esc(titleEl.value.trim() || "无标题") +
        "」" +
        esc(draft.date) +
        " 会从「" +
        esc(catName(draft.cat)) +
        "」挪到「" +
        esc(catName(want)) +
        "」。<br>点保存后才会真正挪过去。",
      okText: "确认挪动",
      cancelText: "不挪了",
    }).then(function (ok) {
      if (!ok) {
        catSelect.value = catForEntry(draft.cat);
        return;
      }
      draft.cat = want;
      markEdit();
    });
  });

  el("search-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    runSearch();
  });

  var searchTimer = null;
  searchEl.addEventListener("input", function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 600);
  });

  document.addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === "s") {
      ev.preventDefault();
      if (view === "edit") save("stay");
    }
    if (ev.key === "Escape") {
      if (!el("dialog").classList.contains("hidden")) return;
      if (view === "post") withLeave(showFeed);
    }
  });

  // 只提醒，不替你存：这个版本一律点保存才写入
  window.addEventListener("beforeunload", function (ev) {
    if (dirty) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  /* ---------- 启动 ---------- */

  loadFontSize();
  loadPageSize();

  el("page-size").addEventListener("change", function () {
    setPageSize(this.value);
  });

  api("api/session")
    .then(function (s) {
      el("who").textContent = s.uid === "local" ? "本机预览（未接入登录）" : s.username;
    })
    .catch(function () {});

  api("api/info")
    .then(function (d) {
      el("verline").textContent = "版本 " + d.version + " · 日记存在 " + d.dataDir;
      el("verline").title = d.dataDir;
    })
    .catch(function () {});

  loadCats()
    .then(function () {
      draft.cat = defaultCat();
      fillEditor();
      return refreshAll();
    })
    .then(function () {
      setStatus("写完点「保存并返回」或「保存，再写一篇」，不点保存不会存", "");
    })
    .catch(function (e) {
      toast("打不开日记数据：" + e.message);
    });
})();
