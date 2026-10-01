"use strict";

/* 拼一个免安装的 Windows 客户端目录，不下载任何东西：
   用已经装好的 Electron 运行时，把我们的代码和飞牛那套 server.js + www 放进去，
   再把 electron.exe 改名叫 日记本.exe。产物在 client/dist/日记本/，整个文件夹拷走就能用。 */

const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..");
const ROOT = path.join(CLIENT, "..");
const RUNTIME = path.join(CLIENT, "node_modules", "electron", "dist");
const DIST = path.join(CLIENT, "dist", "日记本");
const APP_OUT = path.join(DIST, "resources", "app");

if (!fs.existsSync(path.join(RUNTIME, "electron.exe"))) {
  console.log("!! 没找到 Electron 运行时，先在 client 目录跑 npm install");
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(APP_OUT, { recursive: true });

/* 1. Electron 运行时 */
for (const name of fs.readdirSync(RUNTIME)) {
  fs.cpSync(path.join(RUNTIME, name), path.join(DIST, name), { recursive: true });
}
fs.renameSync(path.join(DIST, "electron.exe"), path.join(DIST, "日记本.exe"));

/* 2. 客户端自己的代码（不搬 node_modules：只用 Electron 自带的 Node） */
fs.copyFileSync(path.join(CLIENT, "package.json"), path.join(APP_OUT, "package.json"));
for (const name of ["src", "ui"]) {
  fs.cpSync(path.join(CLIENT, name), path.join(APP_OUT, name), { recursive: true });
}

/* 3. 飞牛那套原样带上：本机跑的就是同一个 server.js 和同一个界面 */
fs.cpSync(path.join(ROOT, "diary", "app"), path.join(APP_OUT, "diary", "app"), { recursive: true });

/* 4. 说明 */
const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT, "package.json"), "utf8"));
fs.writeFileSync(
  path.join(DIST, "使用说明.txt"),
  [
    "日记本 Windows 客户端 " + pkg.version,
    "",
    "怎么用",
    "  1. 双击「日记本.exe」（第一次打开如果 Windows 拦，右键 → 仍要打开）。",
    "  2. 界面和 NAS 上的日记本一模一样，直接写就行，不点「保存」不会存。",
    "  3. 顶栏的「同步」按钮：写的时候一直能写；显示「待传 N」就是有 N 处还没上 NAS，点一下传上去。",
    "  4. 第一次用点顶栏「设置」→ 粘贴 NAS 的网址 → 添加 → 登录 NAS。网址带不带 /app/diary 都认。",
    "",
    "自动同步",
    "  「设置」里能选多久自动传一次：关闭 / 1 / 5 / 15 / 30 分钟 / 1 小时，默认 5 分钟。",
    "  这个选择只留在这台电脑上，不会跟着日记传到 NAS。选「关闭」也照样能手动点「同步」，关程序前会自己补一次。",
    "",
    "换网址 / 换账号",
    "  点顶栏「设置」再加一条地址，点那条的「登录 NAS」，登录完点「用这条」就切过去了。",
    "  每个账号在本机各存一份，互不覆盖；换回来还在。",
    "  「保持登录」不勾的话，关掉程序就要重新登录一次。",
    "",
    "数据在哪儿",
    "  就在这个文件夹里的「日记本数据」，日记是明文 JSON，能用记事本打开。",
    "  想备份：在日记本窗口点「导出备份」，导出的文件和 NAS 上的格式一样，可以互相导入。",
    "",
    "卸载",
    "  直接删掉整个「日记本」文件夹，不留任何东西。",
    "  删之前记得在 NAS 上确认日记都同步上去了（顶栏「同步」不写待传就是干净的）。",
    "",
    "说明",
    "  程序不存你的 NAS 口令，只存登录后的浏览器 cookie。",
    "",
  ].join("\r\n"),
  "utf8"
);

const bytes = (function size(p) {
  let s = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    s += e.isDirectory() ? size(f) : fs.statSync(f).size;
  }
  return s;
})(DIST);

console.log("做好了：" + DIST);
console.log("双击里面的 日记本.exe 就能用；总共 " + (bytes / 1024 / 1024).toFixed(1) + " MB");
