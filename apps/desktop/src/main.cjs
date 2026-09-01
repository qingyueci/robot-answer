const { app, BrowserWindow, Menu, dialog, session, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {
  DESKTOP_TOKEN_HEADER,
  desktopDataPaths,
  hasConfiguredChatModel,
  isTrustedAppUrl,
  parseEnvText,
  parsePort,
} = require("./runtime-support.cjs");

function handleSquirrelStartup() {
  if (process.platform !== "win32") return false;
  const event = process.argv[1];
  if (!event?.startsWith("--squirrel-")) return false;

  if (event === "--squirrel-obsolete") {
    app.quit();
    return true;
  }

  const executableName = path.basename(process.execPath);
  const updateExecutable = path.resolve(
    path.dirname(process.execPath),
    "..",
    "Update.exe",
  );
  const actions = {
    "--squirrel-install": [`--createShortcut=${executableName}`],
    "--squirrel-updated": [`--createShortcut=${executableName}`],
    "--squirrel-uninstall": [`--removeShortcut=${executableName}`],
  };
  const args = actions[event];
  if (!args) return false;

  const child = spawn(updateExecutable, args, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.once("error", () => app.quit());
  child.once("close", () => app.quit());
  return true;
}

const squirrelStartup = handleSquirrelStartup();

const APP_HOST = "127.0.0.1";
const APP_PORT = 3210;
const APP_ORIGIN = `http://${APP_HOST}:${APP_PORT}`;
const HEALTH_URL = `${APP_ORIGIN}/api/desktop/health`;
const STARTUP_TIMEOUT_MS = 180_000;
const SIDECAR_SHUTDOWN_GRACE_MS = 3_000;
const SIDECAR_FORCE_KILL_WAIT_MS = 2_000;
const RENDERER_RECOVERY_WINDOW_MS = 30_000;
const SMOKE_TEST = process.argv.includes("--desktop-smoke-test");
const SMOKE_DATA_PROBE =
  SMOKE_TEST && process.argv.includes("--desktop-smoke-data-probe");
const SMOKE_START_WORKER =
  SMOKE_TEST && process.argv.includes("--desktop-smoke-start-worker");
const SMOKE_CHAT_PROBE =
  SMOKE_TEST && process.argv.includes("--desktop-smoke-chat-probe");
const SMOKE_WITH_SPLASH =
  SMOKE_TEST && process.argv.includes("--desktop-smoke-with-splash");
const smokeScreenshotArgument = process.argv.find((argument) =>
  argument.startsWith("--desktop-smoke-screenshot="),
);
const SMOKE_SCREENSHOT_PATH = smokeScreenshotArgument
  ? path.resolve(smokeScreenshotArgument.slice(smokeScreenshotArgument.indexOf("=") + 1))
  : null;
const smokeRouteArgument = process.argv.find((argument) =>
  argument.startsWith("--desktop-smoke-route="),
);
const requestedSmokeRoute = smokeRouteArgument
  ? smokeRouteArgument.slice(smokeRouteArgument.indexOf("=") + 1)
  : "/";
const SMOKE_ROUTE = new Set(["/", "/journal", "/memories", "/letters"]).has(
  requestedSmokeRoute,
)
  ? requestedSmokeRoute
  : "/";
const splashCaptureArgument = process.argv.find((argument) =>
  argument.startsWith("--desktop-splash-capture="),
);
const SPLASH_CAPTURE_PATH = splashCaptureArgument
  ? path.resolve(splashCaptureArgument.slice(splashCaptureArgument.indexOf("=") + 1))
  : null;
const smokeHoldArgument = process.argv.find((argument) =>
  argument.startsWith("--desktop-smoke-hold-ms="),
);
const SMOKE_HOLD_MS = Math.min(
  Math.max(Number(smokeHoldArgument?.split("=", 2)[1]) || 0, 0),
  30_000,
);
const desktopSessionToken = randomBytes(32).toString("hex");
const parentWatchdogPipe =
  `\\\\.\\pipe\\home-robot-parent-${process.pid}-${randomBytes(16).toString("hex")}`;
const DESKTOP_ICON_PATH = path.join(__dirname, "..", "assets", "home-robot.ico");
const BOOTSTRAP_HTML_PATH = path.join(__dirname, "bootstrap.html");

let mainWindow = null;
let bootstrapWindow = null;
let bootstrapStatus = "正在准备桌面环境…";
let serverProcess = null;
let workerProcess = null;
let runtimeManifest = null;
let quitting = false;
let shutdownFinished = false;
let quitAfterCleanupScheduled = false;
let shutdownPromise = null;
let parentWatchdogServer = null;
let parentWatchdogStartPromise = null;
let serverStartFailure = null;
let serverHealthy = false;
let lastRendererRecoveryAt = 0;
let smokeChatProbeResult = null;
let logDescriptors = [];
const parentWatchdogSockets = new Set();

function runtimeRoot() {
  return path.join(app.getAppPath(), "runtime");
}

function configPath() {
  return path.join(app.getPath("userData"), "config", ".env.local");
}

function logPath(name) {
  const directory = path.join(app.getPath("userData"), "logs");
  mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

function logEvent(level, message, details = {}) {
  try {
    appendFileSync(
      logPath("desktop.log"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        level,
        message,
        ...details,
      })}\n`,
      "utf8",
    );
  } catch (error) {
    console.error("Home Robot desktop log failure", error);
  }
}

function openLog(name) {
  const descriptor = openSync(logPath(name), "a");
  logDescriptors.push(descriptor);
  return descriptor;
}

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return false;
  let entries;
  try {
    entries = parseEnvText(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`桌面配置读取或解析失败：${filePath}\n${message}`, {
      cause: error,
    });
  }
  for (const [key, value] of Object.entries(entries)) {
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

function updateBootstrap(message) {
  bootstrapStatus = message;
  if (!bootstrapWindow || bootstrapWindow.isDestroyed()) return;
  bootstrapWindow.webContents
    .executeJavaScript(
      `document.querySelector('#status').textContent=${JSON.stringify(message)}`,
    )
    .catch((error) => {
      logEvent("warning", "载入状态更新失败", { error: error.message });
    });
}

function createBootstrapWindow() {
  bootstrapWindow = new BrowserWindow({
    width: 600,
    height: 360,
    frame: Boolean(SPLASH_CAPTURE_PATH),
    resizable: false,
    center: true,
    show: false,
    transparent: !SPLASH_CAPTURE_PATH,
    backgroundColor: SPLASH_CAPTURE_PATH ? "#e3dfd6" : "#00000000",
    hasShadow: !SPLASH_CAPTURE_PATH,
    skipTaskbar: !SPLASH_CAPTURE_PATH,
    icon: DESKTOP_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  bootstrapWindow.once("ready-to-show", () => bootstrapWindow?.show());
  bootstrapWindow.webContents.once("did-finish-load", () => {
    updateBootstrap(bootstrapStatus);
  });
  return bootstrapWindow.loadFile(BOOTSTRAP_HTML_PATH);
}

async function captureWindow(window, targetPath) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const image = await window.webContents.capturePage();
  writeFileSync(targetPath, image.toPNG());
}

async function waitForScreenshotReady(window, timeoutMs = 3_000) {
  await window.webContents.executeJavaScript(
    "document.fonts?.ready ?? Promise.resolve()",
    true,
  );
  const deadline = Date.now() + timeoutMs;
  const loadingMarkers = [
    "正在读取记忆…",
    "正在整理共同记录…",
    "正在读取信件…",
  ];

  while (Date.now() < deadline) {
    const pending = await window.webContents.executeJavaScript(
      `(${JSON.stringify(loadingMarkers)}).some((text) => document.body?.innerText.includes(text))`,
      true,
    );
    if (!pending) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("桌面截图等待页面数据就绪超时。");
}

function canConnect(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForPort(host, port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label}启动超时。`);
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "尚未收到响应";

  while (Date.now() < deadline) {
    if (serverStartFailure) throw serverStartFailure;
    if (serverProcess?.exitCode != null) {
      throw new Error(
        `Home Robot 后端提前退出（退出代码 ${serverProcess.exitCode}）。`,
      );
    }
    try {
      const response = await fetch(HEALTH_URL, {
        cache: "no-store",
        headers: { [DESKTOP_TOKEN_HEADER]: desktopSessionToken },
        signal: AbortSignal.timeout(1_500),
      });
      const body = await response.json();
      if (
        response.ok &&
        body?.ok === true &&
        body?.service === "home-robot-desktop"
      ) {
        serverHealthy = true;
        return body;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Home Robot 启动超时：${lastFailure}`);
}

async function runDataProbe() {
  const results = {};
  for (const endpoint of ["/api/journal", "/api/memories?status=confirmed"]) {
    const response = await fetch(`${APP_ORIGIN}${endpoint}`, {
      cache: "no-store",
      headers: { [DESKTOP_TOKEN_HEADER]: desktopSessionToken },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`桌面数据探针失败：${endpoint} / HTTP ${response.status}`);
    }
    await response.json();
    results[endpoint] = response.status;
  }
  return results;
}

async function runChatProbe() {
  const expectedMarker =
    process.env.HOME_ROBOT_SMOKE_EXPECT_TEXT?.trim() || "DESKTOP_STUB_OK";
  const probeId = randomBytes(12).toString("hex");
  const response = await fetch(`${APP_ORIGIN}/api/chat`, {
    method: "POST",
    cache: "no-store",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      [DESKTOP_TOKEN_HEADER]: desktopSessionToken,
    },
    body: JSON.stringify({
      messages: [
        {
          id: `desktop-smoke-${probeId}`,
          role: "user",
          parts: [
            {
              type: "text",
              text:
                `[DESKTOP_SMOKE_CHAT_PROBE:${probeId}] ` +
                "这是隔离链路探针，不代表用户事实，也不应写入长期记忆。请返回测试标记。",
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = Buffer.from(await response.arrayBuffer());
  smokeChatProbeResult = {
    status: response.status,
    contentType,
    bytes: payload.byteLength,
    markerPresent: payload.toString("utf8").includes(expectedMarker),
  };

  if (!response.ok) {
    throw new Error(`桌面对话链路探针失败：HTTP ${response.status}`);
  }
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    throw new Error("桌面对话链路探针未返回 UI SSE。");
  }
  if (!smokeChatProbeResult.markerPresent) {
    throw new Error("桌面对话链路探针响应未包含预期标记。");
  }

  return smokeChatProbeResult;
}

function commandPath(command, fallback = "") {
  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  const first = result.status === 0
    ? result.stdout.split(/\r?\n/).find(Boolean)
    : "";
  return first || fallback;
}

function runCommand(command, args, timeoutMs, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(environment ? { env: environment } : {}),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const append = (current, chunk) => `${current}${chunk}`.slice(-32_000);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
    timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
  });
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function ensureOllama() {
  const configuredUrl =
    process.env.ROBOT_OLLAMA_URL?.trim() || "http://127.0.0.1:11434";
  const target = new URL(configuredUrl);
  const targetHost = target.hostname.replace(/^\[|\]$/g, "");
  if (!isLoopbackHost(targetHost)) return "external";

  const port = parsePort(
    target.port,
    target.protocol === "https:" ? 443 : 80,
  );
  const ollamaEnvironment = {
    ...process.env,
    OLLAMA_HOST: target.origin,
  };
  const fallback = path.join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "Ollama",
    "ollama.exe",
  );
  const ollama = commandPath("ollama.exe", fallback);
  if (!ollama || !existsSync(ollama)) {
    throw new Error("未找到 Ollama，本地向量记忆暂不可用。");
  }
  if (!(await canConnect(targetHost, port))) {
    const output = openLog("ollama.log");
    const child = spawn(ollama, ["serve"], {
      detached: true,
      env: ollamaEnvironment,
      windowsHide: true,
      stdio: ["ignore", output, output],
    });
    child.once("error", (error) => {
      logEvent("error", "Ollama 启动失败", { error: error.message });
    });
    child.unref();
    await waitForPort(targetHost, port, 30_000, "Ollama");
  }

  const models = await runCommand(
    ollama,
    ["list"],
    15_000,
    ollamaEnvironment,
  );
  const expectedModel =
    process.env.ROBOT_MEMORY_EMBED_MODEL?.trim() ||
    "nomic-embed-text-v2-moe";
  if (
    models.timedOut ||
    models.code !== 0 ||
    !models.stdout.includes(expectedModel)
  ) {
    throw new Error(`Ollama 缺少嵌入模型 ${expectedModel}。`);
  }
  return "ready";
}

async function dockerReady(docker) {
  const result = await runCommand(docker, ["info"], 15_000);
  return !result.timedOut && result.code === 0;
}

async function ensureQdrant() {
  const host = process.env.ROBOT_QDRANT_HOST?.trim() || "127.0.0.1";
  const port = parsePort(process.env.ROBOT_QDRANT_PORT, 6_333);
  if (!isLoopbackHost(host)) return "external";
  if (await canConnect(host, port)) return "ready";

  const docker = commandPath("docker.exe");
  if (!docker) throw new Error("未找到 Docker Desktop，本地向量记忆暂不可用。");
  if (!(await dockerReady(docker))) {
    const desktop = path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "Docker",
      "Docker",
      "Docker Desktop.exe",
    );
    if (!existsSync(desktop)) throw new Error("未找到 Docker Desktop。");
    spawn(desktop, [], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    }).unref();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !(await dockerReady(docker))) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!(await dockerReady(docker))) throw new Error("Docker Desktop 启动超时。");
  }

  const inspected = await runCommand(
    docker,
    ["container", "inspect", "robot-qdrant"],
    15_000,
  );
  const action = inspected.code === 0
    ? ["start", "robot-qdrant"]
    : [
        "run",
        "-d",
        "--name",
        "robot-qdrant",
        "--restart",
        "unless-stopped",
        "-p",
        `127.0.0.1:${port}:6333`,
        "-v",
        "robot_qdrant_data:/qdrant/storage",
        process.env.ROBOT_QDRANT_IMAGE || "qdrant/qdrant:latest",
      ];
  const result = await runCommand(docker, action, 120_000);
  const alreadyRunning = result.stderr.includes("already running");
  if (result.timedOut || (result.code !== 0 && !alreadyRunning)) {
    throw new Error("Qdrant 容器启动失败，请查看桌面日志。");
  }
  await waitForPort(host, port, 45_000, "Qdrant");
  return "ready";
}

async function prepareOptionalMemoryServices() {
  if (process.env.ROBOT_MEMORY_ENABLED?.trim().toLowerCase() === "false") {
    logEvent("info", "本地向量记忆已由配置关闭");
    return;
  }

  const results = await Promise.allSettled([ensureOllama(), ensureQdrant()]);
  for (const [index, result] of results.entries()) {
    const service = index === 0 ? "Ollama" : "Qdrant";
    if (result.status === "fulfilled") {
      logEvent("info", `${service} 状态已确认`, { status: result.value });
    } else {
      logEvent("warning", `${service} 准备失败，聊天继续使用降级路径`, {
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  }
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function verifyRuntime() {
  const root = runtimeRoot();
  const manifestPath = path.join(root, "desktop-runtime.json");
  if (!existsSync(manifestPath)) {
    throw new Error("桌面运行时清单不存在，请重新构建应用。");
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("桌面运行时清单损坏，请重新构建应用。");
  }
  if (manifest.formatVersion !== 1) {
    throw new Error("桌面运行时版本不受支持，请重新构建应用。");
  }

  const expected = [
    ["serverSha256", path.join(root, "standalone", "apps", "web", "server.js")],
    ["nodeSha256", path.join(root, "node", "node.exe")],
    ["nodeLicenseSha256", path.join(root, "node", "LICENSE.txt")],
    [
      "nativeAddonSha256",
      path.join(
        root,
        "standalone",
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node",
      ),
    ],
  ];
  for (const [field, filePath] of expected) {
    if (!existsSync(filePath) || sha256File(filePath) !== manifest[field]) {
      throw new Error(`桌面运行时文件校验失败：${path.basename(filePath)}`);
    }
  }

  runtimeManifest = manifest;
  return manifest;
}

function configurePersistentPaths() {
  const userData = app.getPath("userData");
  const defaults = desktopDataPaths(userData);
  for (const [key, defaultPath] of Object.entries(defaults)) {
    let configured = process.env[key]?.trim();
    if (!configured) configured = defaultPath;
    if (!path.isAbsolute(configured)) configured = path.resolve(userData, configured);
    process.env[key] = configured;
    mkdirSync(path.dirname(configured), { recursive: true });
  }
}

function loadDesktopEnvironment() {
  const configured = parseEnvFile(configPath());
  if (!configured && !app.isPackaged) {
    parseEnvFile(path.join(__dirname, "..", "..", "web", ".env.local"));
  }
  if (!hasConfiguredChatModel(process.env)) {
    throw new Error(`桌面对话模型尚未配置。配置文件位置：\n${configPath()}`);
  }

  configurePersistentPaths();
  process.env.NODE_ENV = "production";
  process.env.NEXT_TELEMETRY_DISABLED = "1";
  process.env.HOST = APP_HOST;
  process.env.HOSTNAME = APP_HOST;
  process.env.PORT = String(APP_PORT);
  process.env.ROBOT_MAINTENANCE_BASE_URL = APP_ORIGIN;
  process.env.ROBOT_DESKTOP_SESSION_TOKEN = desktopSessionToken;
}

function childEnvironment() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return environment;
}

function sidecarEnvironment(role) {
  return {
    ...childEnvironment(),
    HOME_ROBOT_PARENT_PIPE: parentWatchdogPipe,
    HOME_ROBOT_SIDECAR_ROLE: role,
  };
}

function sidecarArguments(entryPoint) {
  return [
    "--require",
    path.join(__dirname, "sidecar-parent-watch.cjs"),
    entryPoint,
  ];
}

function startParentWatchdog() {
  if (parentWatchdogStartPromise) return parentWatchdogStartPromise;

  const watchdogModule = path.join(__dirname, "sidecar-parent-watch.cjs");
  if (!existsSync(watchdogModule)) {
    throw new Error("父进程看门狗模块不存在，请重新构建应用。");
  }

  parentWatchdogServer = net.createServer((socket) => {
    if (quitting) {
      socket.end("shutdown\n");
      return;
    }
    parentWatchdogSockets.add(socket);
    socket.setEncoding("utf8");
    let incoming = "";

    socket.on("data", (chunk) => {
      incoming = `${incoming}${chunk}`.slice(-8_192);
      let separator = incoming.indexOf("\n");
      while (separator >= 0) {
        const line = incoming.slice(0, separator).trim();
        incoming = incoming.slice(separator + 1);
        try {
          const message = JSON.parse(line);
          if (
            message?.type === "ready" &&
            typeof message.role === "string" &&
            Number.isInteger(message.pid)
          ) {
            logEvent("info", "子进程父级看门狗已连接", {
              role: message.role,
              pid: message.pid,
            });
          }
        } catch {
          // 管道只接受 sidecar 的单行就绪消息；其他内容直接忽略。
        }
        separator = incoming.indexOf("\n");
      }
    });
    socket.on("error", (error) => {
      if (!quitting) {
        logEvent("warning", "子进程父级看门狗连接异常", {
          error: error.message,
        });
      }
    });
    socket.once("close", () => parentWatchdogSockets.delete(socket));
  });

  parentWatchdogStartPromise = new Promise((resolve, reject) => {
    const handleStartupError = (error) => {
      parentWatchdogServer = null;
      reject(
        new Error(`父进程看门狗启动失败：${error.message}`, { cause: error }),
      );
    };
    parentWatchdogServer.once("error", handleStartupError);
    parentWatchdogServer.listen(parentWatchdogPipe, () => {
      parentWatchdogServer.removeListener("error", handleStartupError);
      parentWatchdogServer.on("error", (error) => {
        logEvent("error", "父进程看门狗运行异常", { error: error.message });
      });
      resolve();
    });
  });

  return parentWatchdogStartPromise;
}

function startInternalServer() {
  if (quitting) return;
  updateBootstrap("正在启动 Home Robot…");
  const server = path.join(
    runtimeRoot(),
    "standalone",
    "apps",
    "web",
    "server.js",
  );
  const node = path.join(runtimeRoot(), "node", "node.exe");
  const output = openLog("server.log");
  serverStartFailure = null;
  serverHealthy = false;
  serverProcess = spawn(node, sidecarArguments(server), {
    cwd: path.dirname(server),
    env: sidecarEnvironment("server"),
    windowsHide: true,
    stdio: ["ignore", output, output],
  });
  serverProcess.once("error", (error) => {
    serverStartFailure = new Error(`Home Robot 后端创建失败：${error.message}`, {
      cause: error,
    });
    logEvent("error", "Home Robot 后端创建失败", { error: error.message });
  });
  serverProcess.once("exit", (code, signal) => {
    logEvent(quitting ? "info" : "error", "Home Robot 后端已退出", {
      code,
      signal,
    });
    if (!quitting && !serverHealthy) {
      serverStartFailure ??= new Error(
        `Home Robot 后端提前退出（退出代码 ${code ?? "unknown"}）。`,
      );
      return;
    }
    if (!quitting) {
      dialog.showErrorBox(
        "Home Robot 后端已停止",
        `退出代码：${code ?? "unknown"}\n日志：${logPath("server.log")}`,
      );
      app.quit();
    }
  });
}

function startNightlyWorker() {
  if (quitting) return;
  const worker = path.join(runtimeRoot(), "nightly-memory-worker.mjs");
  if (!existsSync(worker)) {
    logEvent("warning", "夜间记忆整理脚本不存在");
    return;
  }
  const output = openLog("nightly-maintenance.log");
  const node = path.join(runtimeRoot(), "node", "node.exe");
  workerProcess = spawn(node, sidecarArguments(worker), {
    cwd: runtimeRoot(),
    env: sidecarEnvironment("nightly-worker"),
    windowsHide: true,
    stdio: ["ignore", output, output],
  });
  workerProcess.once("error", (error) => {
    logEvent("error", "夜间记忆整理进程创建失败", { error: error.message });
  });
  workerProcess.once("exit", (code, signal) => {
    if (!quitting) {
      logEvent(code === 0 ? "warning" : "error", "夜间记忆整理进程已退出", {
        code,
        signal,
      });
    }
  });
}

function maintenanceLockPid(contents) {
  const text = String(contents).trim();
  if (/^[1-9]\d*$/.test(text)) return Number(text);
  try {
    const parsed = JSON.parse(text);
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function waitForNightlyWorkerReady(timeoutMs = 5_000) {
  const lockFile = process.env.ROBOT_MAINTENANCE_LOCK_PATH?.trim();
  if (!lockFile) throw new Error("夜间记忆整理锁文件路径未配置。");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workerProcess?.pid) {
      throw new Error("夜间记忆整理进程创建失败。");
    }
    if (workerProcess.exitCode != null || workerProcess.signalCode != null) {
      throw new Error(
        `夜间记忆整理进程提前退出（退出代码 ${workerProcess.exitCode ?? "unknown"}）。`,
      );
    }
    try {
      if (
        maintenanceLockPid(readFileSync(lockFile, "utf8")) === workerProcess.pid
      ) {
        return lockFile;
      }
    } catch {
      // worker 会在完成启动时原子创建锁，短暂不存在时继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`夜间记忆整理进程就绪超时：${lockFile}`);
}

function installSessionProtection() {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${APP_ORIGIN}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          [DESKTOP_TOKEN_HEADER]: desktopSessionToken,
        },
      });
    },
  );
}

async function createMainWindow({ visible }) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 880,
    minHeight: 640,
    show: false,
    title: "Home Robot",
    backgroundColor: "#e3dfd6",
    autoHideMenuBar: true,
    icon: DESKTOP_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url, APP_ORIGIN)) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logEvent("error", "桌面渲染进程已停止", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    if (
      quitting ||
      details.reason === "clean-exit" ||
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      return;
    }

    const now = Date.now();
    if (now - lastRendererRecoveryAt < RENDERER_RECOVERY_WINDOW_MS) {
      dialog.showErrorBox(
        "Home Robot 窗口连续异常",
        `渲染进程在 30 秒内再次停止（${details.reason}），应用将重新启动。`,
      );
      app.relaunch();
      app.quit();
      return;
    }

    lastRendererRecoveryAt = now;
    const recoveringWindow = mainWindow;
    setTimeout(() => {
      if (quitting || recoveringWindow.isDestroyed()) return;
      recoveringWindow
        .loadURL(APP_ORIGIN)
        .then(() => {
          logEvent("info", "桌面渲染进程已自动恢复");
          if (visible) recoveringWindow.show();
        })
        .catch((error) => {
          logEvent("error", "桌面渲染进程恢复失败", {
            error: error.message,
          });
          dialog.showErrorBox(
            "Home Robot 窗口恢复失败",
            `${error.message}\n\n应用将重新启动。`,
          );
          app.relaunch();
          app.quit();
        });
    }, 250);
  });
  mainWindow.once("ready-to-show", () => {
    bootstrapWindow?.close();
    bootstrapWindow = null;
    if (visible) mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(new URL(SMOKE_ROUTE, APP_ORIGIN).href);
  return mainWindow.webContents.executeJavaScript(
    `({ title: document.title, bodyPresent: Boolean(document.body), url: location.href })`,
    true,
  );
}

function childHasExited(child) {
  return (
    !child ||
    child.pid == null ||
    child.exitCode != null ||
    child.signalCode != null
  );
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", handleClose);
      resolve(exited);
    };
    const handleClose = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once("close", handleClose);
  });
}

function stopChild(child) {
  if (childHasExited(child)) return;
  try {
    if (!child.kill()) {
      logEvent("warning", "子进程未接受停止信号", { pid: child.pid });
    }
  } catch (error) {
    logEvent("warning", "子进程停止失败", {
      pid: child.pid,
      error: error.message,
    });
  }
}

function beginParentWatchdogShutdown() {
  for (const socket of parentWatchdogSockets) {
    try {
      socket.end("shutdown\n");
    } catch (error) {
      logEvent("warning", "父进程看门狗停止通知失败", {
        error: error.message,
      });
    }
  }

  const server = parentWatchdogServer;
  if (!server) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      for (const socket of parentWatchdogSockets) socket.destroy();
      finish();
    }, SIDECAR_SHUTDOWN_GRACE_MS + SIDECAR_FORCE_KILL_WAIT_MS);

    server.once("close", finish);
    const closeServer = () => {
      try {
        server.close();
      } catch (error) {
        if (error?.code !== "ERR_SERVER_NOT_RUNNING") {
          logEvent("warning", "父进程看门狗关闭失败", {
            error: error.message,
          });
        }
        finish();
      }
    };

    if (server.listening) {
      closeServer();
    } else if (parentWatchdogStartPromise) {
      parentWatchdogStartPromise.then(closeServer, finish);
    } else {
      finish();
    }
  });
}

async function performProcessCleanup() {
  const watchdogClosed = beginParentWatchdogShutdown();
  const children = [workerProcess, serverProcess].filter(Boolean);
  const gracefulResults = await Promise.all(
    children.map((child) => waitForChildExit(child, SIDECAR_SHUTDOWN_GRACE_MS)),
  );

  const forcedChildren = children.filter(
    (child, index) => !gracefulResults[index] && !childHasExited(child),
  );
  for (const child of forcedChildren) stopChild(child);
  await Promise.all(
    forcedChildren.map((child) =>
      waitForChildExit(child, SIDECAR_FORCE_KILL_WAIT_MS),
    ),
  );

  for (const socket of parentWatchdogSockets) socket.destroy();
  parentWatchdogSockets.clear();
  await watchdogClosed;

  quitting = true;
  for (const descriptor of logDescriptors) {
    try {
      closeSync(descriptor);
    } catch (error) {
      logEvent("warning", "子进程日志关闭失败", { error: error.message });
    }
  }
  logDescriptors = [];
}

function cleanupProcesses() {
  quitting = true;
  if (!shutdownPromise) {
    shutdownPromise = performProcessCleanup().catch((error) => {
      logEvent("error", "桌面子进程清理失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return shutdownPromise;
}

function writeSmokeResult(result) {
  writeFileSync(
    logPath("desktop-smoke-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

async function startDesktop() {
  Menu.setApplicationMenu(null);
  if (SPLASH_CAPTURE_PATH) {
    await createBootstrapWindow();
    bootstrapWindow.show();
    bootstrapWindow.focus();
    updateBootstrap("正在唤醒 Home Robot…");
    await new Promise((resolve) => setTimeout(resolve, 800));
    await captureWindow(bootstrapWindow, SPLASH_CAPTURE_PATH);
    app.quit();
    return;
  }
  if (!SMOKE_TEST || SMOKE_WITH_SPLASH) void createBootstrapWindow();
  loadDesktopEnvironment();
  installSessionProtection();
  verifyRuntime();

  if (await canConnect(APP_HOST, APP_PORT)) {
    throw new Error(
      `本机端口 ${APP_PORT} 已被其他程序占用，Home Robot 未连接到未知服务。`,
    );
  }
  await startParentWatchdog();
  if (quitting) return;
  startInternalServer();
  const health = await waitForHealth(STARTUP_TIMEOUT_MS);
  const unauthorizedResponse = await fetch(HEALTH_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (unauthorizedResponse.status !== 403) {
    throw new Error(
      `桌面本地服务访问保护校验失败：HTTP ${unauthorizedResponse.status}`,
    );
  }
  const dataProbe = SMOKE_DATA_PROBE ? await runDataProbe() : null;
  const chatProbe = SMOKE_CHAT_PROBE ? await runChatProbe() : null;
  const renderer = await createMainWindow({ visible: !SMOKE_TEST });
  if (SMOKE_SCREENSHOT_PATH) {
    await waitForScreenshotReady(mainWindow);
    await captureWindow(mainWindow, SMOKE_SCREENSHOT_PATH);
  }

  if (SMOKE_TEST) {
    let maintenanceLockPath =
      process.env.ROBOT_MAINTENANCE_LOCK_PATH?.trim() || null;
    if (SMOKE_START_WORKER) {
      startNightlyWorker();
      maintenanceLockPath = await waitForNightlyWorkerReady();
    }
    writeSmokeResult({
      ok: true,
      at: new Date().toISOString(),
      origin: APP_ORIGIN,
      health,
      unauthorizedStatus: unauthorizedResponse.status,
      dataProbe,
      ...(SMOKE_CHAT_PROBE ? { chatProbe } : {}),
      renderer,
      tokenProtected: true,
      nodeVersion: runtimeManifest.nodeVersion,
      nodeModulesAbi: runtimeManifest.nodeModulesAbi,
      buildId: runtimeManifest.buildId,
      serverPid: serverProcess?.pid ?? null,
      workerPid: workerProcess?.pid ?? null,
      maintenanceLockPath,
    });
    if (SMOKE_HOLD_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, SMOKE_HOLD_MS));
    }
    app.quit();
    return;
  }

  startNightlyWorker();
  void prepareOptionalMemoryServices();
}

if (!squirrelStartup) {
  const singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      const target = mainWindow || bootstrapWindow;
      if (!target) return;
      if (target.isMinimized()) target.restore();
      if (!SMOKE_TEST) {
        target.show();
        target.focus();
      }
    });

    app.whenReady()
      .then(() => {
        app.setAppUserModelId("com.home-robot.desktop");
        return startDesktop();
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const detail =
          error instanceof Error ? error.stack || error.message : String(error);
        logEvent("error", "Home Robot 启动失败", {
          error: message,
          detail,
        });
        if (SMOKE_TEST || SPLASH_CAPTURE_PATH) {
          writeSmokeResult({
            ok: false,
            at: new Date().toISOString(),
            error: message,
            ...(smokeChatProbeResult
              ? { chatProbe: smokeChatProbeResult }
              : {}),
          });
          await cleanupProcesses();
          app.exit(1);
          return;
        } else {
          dialog.showErrorBox(
            "Home Robot 启动失败",
            `${message}\n\n日志目录：${path.dirname(logPath("server.log"))}`,
          );
        }
        app.quit();
      });
  }
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (shutdownFinished) return;
  event.preventDefault();
  if (quitAfterCleanupScheduled) return;
  quitAfterCleanupScheduled = true;
  void cleanupProcesses().finally(() => {
    shutdownFinished = true;
    app.quit();
  });
});
