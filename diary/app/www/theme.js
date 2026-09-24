/* 外观（明暗 + 强调色）：只存这台设备，不进备份、不跟账号走。
   单独成文件、放在 <head> 里最先执行，避免打开时先闪一下浅色。 */
(function () {
  "use strict";

  var MODE_KEY = "diary-theme";
  var ACCENT_KEY = "diary-accent";
  var MODES = ["auto", "light", "sepia", "dark"];
  var ACCENTS = ["moss", "indigo", "tea", "rose", "slate", "plum"];

  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function read(key, list, fallback) {
    try {
      var v = localStorage.getItem(key);
      return list.indexOf(v) >= 0 ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* 隐私模式写不进去也别报错，颜色照样能换，只是下次打开要重选 */
    }
  }

  function systemTheme() {
    return mq && mq.matches ? "dark" : "light";
  }

  var state = {
    mode: read(MODE_KEY, MODES, "auto"),
    accent: read(ACCENT_KEY, ACCENTS, "moss"),
  };

  // auto 会在 <html> 上写成真正生效的那一档，CSS 只用具体档位匹配
  function resolved() {
    return state.mode === "auto" ? systemTheme() : state.mode;
  }

  function paint() {
    var h = document.documentElement;
    h.setAttribute("data-theme", resolved());
    h.setAttribute("data-accent", state.accent);
  }

  paint();
  if (mq) {
    var onSystem = function () {
      if (state.mode === "auto") paint();
    };
    if (mq.addEventListener) mq.addEventListener("change", onSystem);
    else if (mq.addListener) mq.addListener(onSystem);
  }

  window.DiaryTheme = {
    mode: function () {
      return state.mode;
    },
    theme: resolved,
    // 系统本身是哪档（跟“跟随系统”时实际生效的那一档区分开）
    system: systemTheme,
    accent: function () {
      return state.accent;
    },
    setMode: function (m) {
      if (MODES.indexOf(m) < 0) return;
      state.mode = m;
      write(MODE_KEY, m);
      paint();
    },
    setAccent: function (a) {
      if (ACCENTS.indexOf(a) < 0) return;
      state.accent = a;
      write(ACCENT_KEY, a);
      paint();
    },
  };
})();
