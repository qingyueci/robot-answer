import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

const require = createRequire(import.meta.url);
const {
  DESKTOP_TOKEN_HEADER,
  desktopDataPaths,
  hasConfiguredChatModel,
  isTrustedAppUrl,
  parseEnvText,
  parsePort,
} = require("../apps/desktop/src/runtime-support.cjs");

let passedAssertions = 0;

function expectEqual(actual, expected, message) {
  assert.equal(actual, expected, message);
  passedAssertions += 1;
}

function expectDeepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  passedAssertions += 1;
}

const dotenvFixture = [
  "# full-line comment",
  'ROBOT_CHAT_API_KEY="secret value"',
  "export ROBOT_CHAT_MODEL=example-model",
  "PLAIN=value # inline comment",
  'DOUBLE_HASH="value # preserved"',
  "SINGLE_HASH='single # preserved'",
  'DOUBLE_NEWLINE="first\\nsecond"',
  "SINGLE_NEWLINE='first\\nsecond'",
  'DOUBLE_MULTILINE="first line',
  'second line"',
  "SINGLE_MULTILINE='alpha",
  "beta'",
  "EMPTY=",
  "",
].join("\n");
const parsed = parseEnvText(dotenvFixture);
const nodeParsed = parseEnv(dotenvFixture);

// Node 24 util.parseEnv is the compatibility oracle. Spread both values so the
// assertion checks dotenv semantics instead of an implementation's prototype.
expectDeepEqual(
  { ...parsed },
  { ...nodeParsed },
  "parseEnvText must match Node 24 util.parseEnv",
);
expectEqual(parsed.ROBOT_CHAT_API_KEY, "secret value");
expectEqual(parsed.ROBOT_CHAT_MODEL, "example-model");
expectEqual(parsed.PLAIN, "value");
expectEqual(parsed.DOUBLE_HASH, "value # preserved");
expectEqual(parsed.SINGLE_HASH, "single # preserved");
expectEqual(parsed.DOUBLE_NEWLINE, "first\nsecond");
expectEqual(parsed.SINGLE_NEWLINE, "first\\nsecond");
expectEqual(parsed.DOUBLE_MULTILINE, "first line\nsecond line");
expectEqual(parsed.SINGLE_MULTILINE, "alpha\nbeta");
expectEqual(parsed.EMPTY, "");
expectEqual(parseEnvText("INVALID-KEY=ignored")["INVALID-KEY"], undefined);

expectEqual(
  hasConfiguredChatModel({
    ROBOT_CHAT_API_KEY: "key",
    ROBOT_CHAT_MODEL: "model",
  }),
  true,
);
expectEqual(
  hasConfiguredChatModel({ KIMI_CODE_API_KEY: "key", KIMI_CODE_MODEL: "model" }),
  true,
);
expectEqual(
  hasConfiguredChatModel({ OPENAI_API_KEY: "key", OPENAI_MODEL: "model" }),
  true,
);
expectEqual(hasConfiguredChatModel({ ROBOT_CHAT_API_KEY: "key" }), false);

const origin = "http://127.0.0.1:3210";
expectEqual(isTrustedAppUrl(`${origin}/journal`, origin), true);
expectEqual(isTrustedAppUrl(`${origin}.example.invalid/`, origin), false);
expectEqual(isTrustedAppUrl("https://127.0.0.1:3210/", origin), false);
expectEqual(isTrustedAppUrl("not a url", origin), false);

const paths = desktopDataPaths("C:\\Users\\Example\\AppData\\Roaming\\Home Robot");
expectEqual(
  paths.ROBOT_STATE_DB_PATH,
  path.join(
    "C:\\Users\\Example\\AppData\\Roaming\\Home Robot",
    "data",
    "state",
    "robot-state.db",
  ),
);
expectEqual(
  paths.ROBOT_MAINTENANCE_LOCK_PATH.endsWith("nightly-maintenance.lock"),
  true,
);

expectEqual(parsePort("6333", 1), 6333);
expectEqual(parsePort("0", 3210), 3210);
expectEqual(parsePort("invalid", 3210), 3210);
expectEqual(DESKTOP_TOKEN_HEADER, "x-home-robot-desktop-token");

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const desktopRoot = path.join(workspaceRoot, "apps", "desktop");
const iconPath = path.join(desktopRoot, "assets", "home-robot.ico");
const splashPath = path.join(desktopRoot, "src", "bootstrap.html");
const iconBytes = readFileSync(iconPath);
expectEqual(iconBytes.readUInt16LE(0), 0);
expectEqual(iconBytes.readUInt16LE(2), 1);
expectEqual(iconBytes.readUInt16LE(4), 7);

const bootstrapHtml = readFileSync(splashPath, "utf8");
expectEqual(bootstrapHtml.includes('id="status"'), true);
expectEqual(bootstrapHtml.includes("splash-paper-background.webp"), true);
expectEqual(bootstrapHtml.includes("border-radius: 22px"), true);

const desktopMain = readFileSync(
  path.join(desktopRoot, "src", "main.cjs"),
  "utf8",
);
expectEqual(desktopMain.includes("loadFile(BOOTSTRAP_HTML_PATH)"), true);
expectEqual(desktopMain.includes("icon: DESKTOP_ICON_PATH"), true);
expectEqual(desktopMain.includes("--desktop-splash-capture="), true);
expectEqual(desktopMain.includes("--desktop-smoke-screenshot="), true);
expectEqual(desktopMain.includes("--desktop-smoke-route="), true);
expectEqual(desktopMain.includes("--desktop-smoke-with-splash"), true);

const forgeConfig = require("../apps/desktop/forge.config.cjs");
expectEqual(forgeConfig.packagerConfig.icon.endsWith("home-robot.ico"), true);
expectEqual(forgeConfig.makers[0].config.loadingGif.endsWith("installer-loading.gif"), true);

const workerPath = path.join(import.meta.dirname, "nightly-memory-worker.mjs");
const lockTestRoot = mkdtempSync(path.join(os.tmpdir(), "home-robot-lock-"));
const lockPath = path.join(lockTestRoot, "nightly-maintenance.lock");
const workerEnvPath = path.join(lockTestRoot, "worker.env");
const desktopToken = "desktop-session-token-for-regression";

function sessionFingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

function structuredLock({ owner, pid = process.pid, token = "" }) {
  const now = new Date().toISOString();
  return {
    formatVersion: 1,
    pid,
    instanceId: randomUUID(),
    owner,
    desktopSessionFingerprint:
      owner === "desktop" ? sessionFingerprint(token) : null,
    processStartedAt: now,
    createdAt: now,
  };
}

function probeEnvironment(overrides = {}) {
  const environment = {
    ...process.env,
    ROBOT_MAINTENANCE_LOCK_PATH: lockPath,
    ROBOT_MAINTENANCE_TIMEOUT_MS: "5000",
    ROBOT_MAINTENANCE_LOCK_HEARTBEAT_MS: "1000",
    ROBOT_MAINTENANCE_LOCK_STALE_MS: "60000",
    ...overrides,
  };
  if (overrides.ROBOT_DESKTOP_SESSION_TOKEN === null) {
    delete environment.ROBOT_DESKTOP_SESSION_TOKEN;
  }
  return environment;
}

function runLockProbeSync(overrides = {}) {
  const result = spawnSync(process.execPath, [workerPath, "--lock-probe"], {
    cwd: path.dirname(workerPath),
    env: probeEnvironment(overrides),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  expectEqual(
    result.status,
    0,
    `lock probe failed: ${String(result.stderr).trim().slice(0, 300)}`,
  );
  const line = String(result.stdout)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return JSON.parse(line);
}

function runPrintNext(overrides = {}) {
  const environment = {
    ...process.env,
    ROBOT_MAINTENANCE_ENV_PATH: workerEnvPath,
    ...overrides,
  };
  if (!("ROBOT_MEMORY_MAINTENANCE_HOUR" in overrides)) {
    delete environment.ROBOT_MEMORY_MAINTENANCE_HOUR;
  }
  if (!("ROBOT_MEMORY_MAINTENANCE_MINUTE" in overrides)) {
    delete environment.ROBOT_MEMORY_MAINTENANCE_MINUTE;
  }
  const result = spawnSync(process.execPath, [workerPath, "--print-next"], {
    cwd: path.dirname(workerPath),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  expectEqual(
    result.status,
    0,
    `worker env probe failed: ${String(result.stderr).trim().slice(0, 300)}`,
  );
  return new Date(String(result.stdout).trim());
}

let holdingProbe = null;
try {
  writeFileSync(
    workerEnvPath,
    [
      "ROBOT_MEMORY_MAINTENANCE_HOUR=7 # inline comment",
      'ROBOT_MEMORY_MAINTENANCE_MINUTE="45"',
      'UNUSED_MULTILINE="first line',
      'second line"',
      "",
    ].join("\n"),
    "utf8",
  );
  const fileConfiguredSchedule = runPrintNext();
  expectEqual(Number.isNaN(fileConfiguredSchedule.getTime()), false);
  expectEqual(fileConfiguredSchedule.getHours(), 7);
  expectEqual(fileConfiguredSchedule.getMinutes(), 45);

  const environmentPreferredSchedule = runPrintNext({
    ROBOT_MEMORY_MAINTENANCE_HOUR: "8",
  });
  expectEqual(environmentPreferredSchedule.getHours(), 8);
  expectEqual(environmentPreferredSchedule.getMinutes(), 45);

  // A live legacy PID remains authoritative for backward compatibility.
  writeFileSync(lockPath, `${process.pid}\n`, "utf8");
  const legacyLive = runLockProbeSync({ ROBOT_DESKTOP_SESSION_TOKEN: null });
  expectEqual(legacyLive.acquired, false);
  expectEqual(readFileSync(lockPath, "utf8").trim(), String(process.pid));
  rmSync(lockPath, { force: true });

  // A dead legacy PID is reclaimed and converted to the structured format.
  writeFileSync(lockPath, "2147483647\n", "utf8");
  const legacyDead = runLockProbeSync({ ROBOT_DESKTOP_SESSION_TOKEN: null });
  expectEqual(legacyDead.acquired, true);
  expectEqual(existsSync(lockPath), false);

  // CLI workers preserve global single-instance behavior while the owner is
  // alive and its heartbeat is fresh.
  writeFileSync(
    lockPath,
    `${JSON.stringify(structuredLock({ owner: "cli" }), null, 2)}\n`,
    "utf8",
  );
  const cliLive = runLockProbeSync({ ROBOT_DESKTOP_SESSION_TOKEN: null });
  expectEqual(cliLive.acquired, false);
  rmSync(lockPath, { force: true });

  // A new desktop session may immediately supersede a worker carrying the old
  // session fingerprint, even if that stale worker's PID is still alive.
  writeFileSync(
    lockPath,
    `${JSON.stringify(
      structuredLock({ owner: "desktop", token: "previous-session" }),
      null,
      2,
    )}\n`,
    "utf8",
  );
  const desktopTakeover = runLockProbeSync({
    ROBOT_DESKTOP_SESSION_TOKEN: desktopToken,
  });
  expectEqual(desktopTakeover.acquired, true);
  expectEqual(desktopTakeover.owner, "desktop");
  expectEqual(existsSync(lockPath), false);

  // A stale heartbeat allows recovery from forced termination or an unrelated
  // Windows process that has reused the recorded PID.
  writeFileSync(
    lockPath,
    `${JSON.stringify(structuredLock({ owner: "cli" }), null, 2)}\n`,
    "utf8",
  );
  const staleTime = new Date(Date.now() - 120_000);
  utimesSync(lockPath, staleTime, staleTime);
  const staleStructured = runLockProbeSync({
    ROBOT_DESKTOP_SESSION_TOKEN: null,
  });
  expectEqual(staleStructured.acquired, true);
  expectEqual(existsSync(lockPath), false);

  if (process.platform === "win32") {
    // Keep the heartbeat fresh but make the recorded process start older than
    // the live PID. Windows must identify this as PID reuse rather than a live
    // owner and reclaim it immediately.
    const reusedPidLock = structuredLock({ owner: "cli" });
    reusedPidLock.processStartedAt = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(lockPath, `${JSON.stringify(reusedPidLock, null, 2)}\n`, "utf8");
    const reusedPid = runLockProbeSync({ ROBOT_DESKTOP_SESSION_TOKEN: null });
    expectEqual(reusedPid.acquired, true);
    expectEqual(existsSync(lockPath), false);
  }

  // Inspect a real lock while its owner is alive: the token itself must never
  // be persisted, and normal exit must remove only that owner's lock.
  holdingProbe = spawn(process.execPath, [workerPath, "--lock-probe"], {
    cwd: path.dirname(workerPath),
    env: probeEnvironment({
      ROBOT_DESKTOP_SESSION_TOKEN: desktopToken,
      ROBOT_MAINTENANCE_LOCK_PROBE_HOLD_MS: "1200",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let holdingStdout = "";
  let holdingStderr = "";
  holdingProbe.stdout.on("data", (chunk) => {
    holdingStdout += chunk;
  });
  holdingProbe.stderr.on("data", (chunk) => {
    holdingStderr += chunk;
  });
  const holdingExit = new Promise((resolve, reject) => {
    holdingProbe.once("error", reject);
    holdingProbe.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const lockDeadline = Date.now() + 5_000;
  while (!existsSync(lockPath) && Date.now() < lockDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expectEqual(existsSync(lockPath), true);
  const persistedText = readFileSync(lockPath, "utf8");
  const persisted = JSON.parse(persistedText);
  expectEqual(persisted.formatVersion, 1);
  expectEqual(persisted.owner, "desktop");
  expectEqual(
    persisted.desktopSessionFingerprint,
    sessionFingerprint(desktopToken),
  );
  expectEqual(persistedText.includes(desktopToken), false);

  const holdingResult = await holdingExit;
  expectEqual(
    holdingResult.code,
    0,
    `holding lock probe failed (${holdingResult.signal ?? "no signal"}): ${holdingStderr
      .trim()
      .slice(0, 300)}`,
  );
  const holdingOutput = JSON.parse(
    holdingStdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean),
  );
  expectEqual(holdingOutput.acquired, true);
  expectEqual(existsSync(lockPath), false);
} finally {
  if (holdingProbe && holdingProbe.exitCode === null) holdingProbe.kill();
  rmSync(lockTestRoot, { recursive: true, force: true });
}

console.log(
  `desktop runtime regression: ${passedAssertions}/${passedAssertions} assertions passed`,
);
