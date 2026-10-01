"use strict";

/* 本机那一份日记服务：跑的就是飞牛上同一个 server.js。
   好处是界面、存储格式、备份格式全都和 NAS 一模一样，
   客户端不需要自己再写一套"读日记"的逻辑。 */

const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

class LocalDiary {
  constructor(opts) {
    this.appDir = opts.appDir; // 里面有 server/server.js 和 www/
    this.dataRoot = opts.dataRoot;
    this.uid = opts.uid || "local";
    this.child = null;
    this.port = 0;
    this.stopping = false;
    // 进程意外退出时通知外面（外面决定要不要重启一份）
    this.onDied = opts.onDied || function () {};
  }

  get base() {
    return "http://127.0.0.1:" + this.port + "/app/diary";
  }

  get fetcher() {
    return (url, init) => fetch(url, init);
  }

  /** 账号是启动时钉死的，端口和进程都由这里管 */
  async start() {
    if (this.child) this.stopChild();
    fs.mkdirSync(this.dataRoot, { recursive: true });
    const log = fs.openSync(path.join(this.dataRoot, "本机服务.log"), "a");
    for (let i = 0; i < 4; i++) {
      this.port = await freePort();
      const child = spawn(process.execPath, [path.join(this.appDir, "server", "server.js")], {
        // Electron 的主程序本身就是 Node，加这个环境变量它才会当 Node 用
        env: Object.assign({}, process.env, {
          ELECTRON_RUN_AS_NODE: "1",
          DATA_DIR: this.dataRoot,
          PORT: String(this.port),
          BIND_HOST: "127.0.0.1",
          GATEWAY_PREFIX: "/app/diary",
          WWW_DIR: path.join(this.appDir, "www"),
          TRUST_UID: this.uid,
        }),
        stdio: ["ignore", log, log],
      });
      this.child = child;
      child.on("exit", (code) => {
        if (this.stopping) return;
        this.child = null;
        this.onDied(code);
      });
      try {
        await this.waitUp();
        return;
      } catch (e) {
        this.stopChild();
        if (i === 3) throw e;
      }
    }
  }

  async waitUp() {
    const t0 = Date.now();
    const want = String(this.dataRoot).replace(/\\/g, "/");
    for (;;) {
      try {
        const j = await (await fetch(this.base + "/api/info")).json();
        // 认一下数据目录：端口被别的程序占了这一步会拦下来，别被假服务骗了
        if (String(j.dataDir).replace(/\\/g, "/") === want) return j;
        throw new Error("端口上是别的东西");
      } catch (e) {
        if (e.message === "端口上是别的东西") throw e;
        if (Date.now() - t0 > 8000) throw new Error("本机日记服务起不来：" + (e.message || e));
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }

  stopChild() {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    this.stopping = true;
    try {
      c.kill();
    } catch (e) {}
    this.stopping = false;
  }

  /** 换账号：先挪目录再重启 */
  async setUid(uid) {
    if (uid === this.uid) return;
    this.migrateIfFirstLogin(uid);
    this.uid = uid;
    this.stopChild();
    await this.start();
  }

  /** 没登录时写的内容在本机 ulocal 目录下，第一次登录要把它挪到那个账号名下 */
  migrateIfFirstLogin(uid) {
    if (!/^\d+$/.test(String(uid || ""))) return;
    const from = path.join(this.dataRoot, "ulocal");
    const to = path.join(this.dataRoot, "u" + uid);
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    try {
      fs.renameSync(from, to);
    } catch (e) {
      /* 挪不动就先用新目录：ulocal 还在硬盘上，一篇都没丢 */
    }
  }

  stop() {
    this.stopChild();
  }
}

module.exports = { LocalDiary };
