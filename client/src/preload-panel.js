"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/* 设置面板要做的每件事都走这一个桥：面板本身不知道也不该知道 NAS 的口令，
   登录是在主进程开的那扇登录窗口里完成的 */
contextBridge.exposeInMainWorld("panel", {
  data: () => ipcRenderer.invoke("client:state"),
  add: (url, name) => ipcRenderer.invoke("client:add-address", { url, name }),
  remove: (id) => ipcRenderer.invoke("client:remove-address", id),
  pick: (id) => ipcRenderer.invoke("client:pick-address", id),
  move: (id, delta) => ipcRenderer.invoke("client:move-address", { id, delta }),
  rename: (id, name) => ipcRenderer.invoke("client:rename-address", { id, name }),
  keep: (id, keep) => ipcRenderer.invoke("client:keep", { id, keep }),
  test: (id) => ipcRenderer.invoke("client:test-address", id),
  login: (id) => ipcRenderer.invoke("client:login", id),
  logout: (id) => ipcRenderer.invoke("client:logout", id),
  sync: () => ipcRenderer.invoke("client:sync"),
  every: (min) => ipcRenderer.invoke("client:every", min),
  openData: () => ipcRenderer.invoke("client:open-data"),
  onState: (cb) => ipcRenderer.on("client:state", (e, d) => cb(d)),
  onSync: (cb) => ipcRenderer.on("client:sync", (e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on("client:log", (e, d) => cb(d)),
});
