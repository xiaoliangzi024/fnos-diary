"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/* 主窗口里就是飞牛那套网页界面，客户端只多给它两样东西：
   一个同步按钮要用的动作，和"这台是我自己"的标记。
   没有这两个接口（比如用浏览器直接打开本机地址），界面就还是原来的样子。 */
contextBridge.exposeInMainWorld("diaryClient", {
  sync: () => ipcRenderer.invoke("client:sync"),
  state: () => ipcRenderer.invoke("client:state"),
  openPanel: () => ipcRenderer.invoke("client:open-panel"),
  login: () => ipcRenderer.invoke("client:login-active"),
  onSync: (cb) => ipcRenderer.on("client:sync", (e, d) => cb(d)),
  onState: (cb) => ipcRenderer.on("client:state", (e, d) => cb(d)),
  onPull: (cb) => ipcRenderer.on("client:pull", (e, d) => cb(d)),
});
