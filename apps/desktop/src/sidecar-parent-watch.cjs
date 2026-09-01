"use strict";

const net = require("node:net");

const parentPipe = process.env.HOME_ROBOT_PARENT_PIPE?.trim();
const sidecarRole = process.env.HOME_ROBOT_SIDECAR_ROLE?.trim() || "sidecar";

if (!parentPipe) {
  throw new Error("Home Robot sidecar 缺少父进程看门狗管道。");
}

let connected = false;
let terminating = false;
let incoming = "";

function terminate(exitCode, reason) {
  if (terminating) return;
  terminating = true;
  if (reason) {
    process.stderr.write(
      `[home-robot-parent-watch] ${sidecarRole}: ${reason}\n`,
    );
  }
  process.exit(exitCode);
}

const parentSocket = net.createConnection(parentPipe);
parentSocket.setEncoding("utf8");

parentSocket.once("connect", () => {
  connected = true;
  parentSocket.write(
    `${JSON.stringify({ type: "ready", role: sidecarRole, pid: process.pid })}\n`,
  );
  // 看门狗只约束已有 sidecar 的父进程生命周期；它本身不应让启动失败或
  // 未取得单实例锁的 sidecar 假性存活。
  parentSocket.unref();
});

parentSocket.on("data", (chunk) => {
  incoming = `${incoming}${chunk}`.slice(-8_192);
  let separator = incoming.indexOf("\n");
  while (separator >= 0) {
    const message = incoming.slice(0, separator).trim();
    incoming = incoming.slice(separator + 1);
    if (message === "shutdown") terminate(0);
    separator = incoming.indexOf("\n");
  }
});

parentSocket.once("end", () => terminate(0));
parentSocket.once("close", () => terminate(connected ? 0 : 1));
parentSocket.once("error", (error) => {
  terminate(
    connected ? 0 : 1,
    connected ? "父进程连接已丢失" : `连接父进程失败：${error.message}`,
  );
});
