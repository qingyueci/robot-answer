import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parseEnv } from "node:util";

const projectRoot = path.resolve(import.meta.dirname, "..");
const envFile = process.env.ROBOT_MAINTENANCE_ENV_PATH?.trim()
  ? path.resolve(process.env.ROBOT_MAINTENANCE_ENV_PATH.trim())
  : path.join(projectRoot, "apps", "web", ".env.local");

function loadLocalEnv() {
  if (!existsSync(envFile)) return;
  let parsed;
  try {
    parsed = parseEnv(readFileSync(envFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`夜间记忆配置格式错误：${message}`, { cause: error });
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadLocalEnv();

function validNumber(raw, fallback, min, max) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

const baseUrl =
  process.env.ROBOT_MAINTENANCE_BASE_URL?.trim() || "http://127.0.0.1:3000";
const desktopSessionToken =
  process.env.ROBOT_DESKTOP_SESSION_TOKEN?.trim() || "";
const statePath =
  process.env.ROBOT_MAINTENANCE_STATE_PATH?.trim() ||
  path.join(projectRoot, "data", "state", "nightly-maintenance.json");
const lockPath =
  process.env.ROBOT_MAINTENANCE_LOCK_PATH?.trim() ||
  path.join(projectRoot, "data", "state", "nightly-maintenance.lock");
const timeoutMs = validNumber(
  process.env.ROBOT_MAINTENANCE_TIMEOUT_MS,
  120_000,
  5_000,
  600_000,
);
const lockHeartbeatMs = validNumber(
  process.env.ROBOT_MAINTENANCE_LOCK_HEARTBEAT_MS,
  30_000,
  1_000,
  60_000,
);
const lockStaleMs = validNumber(
  process.env.ROBOT_MAINTENANCE_LOCK_STALE_MS,
  Math.max(timeoutMs * 2 + 60_000, 300_000),
  Math.max(lockHeartbeatMs * 3, timeoutMs + 30_000),
  24 * 60 * 60 * 1000,
);
const hour = validNumber(
  process.env.ROBOT_MEMORY_MAINTENANCE_HOUR,
  23,
  0,
  23,
);
const minute = validNumber(
  process.env.ROBOT_MEMORY_MAINTENANCE_MINUTE,
  30,
  0,
  59,
);

const lockIdentity = Object.freeze({
  formatVersion: 1,
  pid: process.pid,
  instanceId: randomUUID(),
  owner: desktopSessionToken ? "desktop" : "cli",
  desktopSessionFingerprint: desktopSessionToken
    ? createHash("sha256").update(desktopSessionToken).digest("hex")
    : null,
  processStartedAt: new Date(
    Date.now() - Math.round(process.uptime() * 1000),
  ).toISOString(),
  createdAt: new Date().toISOString(),
});

let lockAcquired = false;

function scheduledTime(day = new Date()) {
  const scheduled = new Date(day);
  scheduled.setHours(hour, minute, 0, 0);
  return scheduled;
}

function nextScheduledTime(now = new Date()) {
  const next = scheduledTime(now);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(nextState) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  await rename(temporary, statePath);
}

async function requestGovernance(dryRun = false) {
  const startedAt = new Date().toISOString();
  const headers = {
    ...(dryRun ? {} : { "content-type": "application/json" }),
    ...(desktopSessionToken
      ? { "x-home-robot-desktop-token": desktopSessionToken }
      : {}),
  };
  const response = await fetch(`${baseUrl}/api/governance`, {
    method: dryRun ? "GET" : "POST",
    headers,
    body: dryRun ? undefined : JSON.stringify({ scope: "all" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`治理接口返回了无效 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok || (!dryRun && body.ok !== true)) {
    throw new Error(body.error || `治理接口失败（HTTP ${response.status}）`);
  }

  const finishedAt = new Date().toISOString();
  const previous = await readState();
  await writeState(
    dryRun
      ? {
          ...previous,
          lastDryRunAt: finishedAt,
          lastDryRunStats: body.stats ?? null,
        }
      : {
          ...previous,
          lastSuccessAt: finishedAt,
          lastResult: body.result ?? null,
          lastStats: body.stats ?? null,
          lastError: null,
        },
  );
  return { startedAt, finishedAt, body };
}

async function recordFailure(error) {
  const previous = await readState();
  await writeState({
    ...previous,
    lastFailureAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : String(error),
  });
}

function parseLock(contents) {
  const text = String(contents).trim();
  if (/^[1-9]\d*$/.test(text)) {
    return { formatVersion: 0, pid: Number(text), owner: "legacy" };
  }

  try {
    const parsed = JSON.parse(text);
    if (
      parsed?.formatVersion !== 1 ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.instanceId !== "string" ||
      !parsed.instanceId ||
      !["desktop", "cli"].includes(parsed.owner) ||
      typeof parsed.processStartedAt !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    if (
      parsed.owner === "desktop" &&
      (typeof parsed.desktopSessionFingerprint !== "string" ||
        !parsed.desktopSessionFingerprint)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readLockSnapshot() {
  const contents = readFileSync(lockPath, "utf8");
  const details = statSync(lockPath);
  return {
    contents,
    identity: parseLock(contents),
    inode: details.ino,
    modifiedAtMs: details.mtimeMs,
    size: details.size,
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function windowsProcessStartedAt(pid) {
  if (process.platform !== "win32") return null;

  const environment = {
    ...process.env,
    HOME_ROBOT_LOCK_PID: String(pid),
  };
  // PowerShell 7's module path can prevent Windows PowerShell 5.1 from loading
  // Microsoft.PowerShell.Management, which owns Get-Process.
  delete environment.PSModulePath;
  const command = [
    "$target = Get-Process -Id ([int]$env:HOME_ROBOT_LOCK_PID) -ErrorAction Stop",
    "[Console]::Out.Write($target.StartTime.ToUniversalTime().ToString('O'))",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      env: environment,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0) return null;
  const startedAt = Date.parse(String(result.stdout).trim());
  return Number.isFinite(startedAt) ? startedAt : null;
}

function processStartMatchesLock(existing, snapshot) {
  const actualStartedAt = windowsProcessStartedAt(existing.pid);
  if (actualStartedAt === null) return true;

  // Legacy workers create their PID lock immediately after startup. A process
  // that started substantially after the lock file is a reused Windows PID.
  if (existing.formatVersion === 0) {
    return actualStartedAt <= snapshot.modifiedAtMs + 30_000;
  }

  const recordedStartedAt = Date.parse(existing.processStartedAt);
  return (
    Number.isFinite(recordedStartedAt) &&
    Math.abs(actualStartedAt - recordedStartedAt) <= 30_000
  );
}

function isFreshLock(snapshot, now = Date.now()) {
  if (!Number.isFinite(snapshot.modifiedAtMs)) return false;
  if (snapshot.modifiedAtMs > now + lockHeartbeatMs) return false;
  return now - snapshot.modifiedAtMs <= lockStaleMs;
}

function hasCurrentIdentity(identity) {
  return Boolean(
    identity?.formatVersion === 1 &&
      identity.pid === lockIdentity.pid &&
      identity.instanceId === lockIdentity.instanceId,
  );
}

function lockBlocksCurrentProcess(snapshot) {
  const existing = snapshot.identity;
  if (!existing) return false;
  if (hasCurrentIdentity(existing)) return true;

  // 新进程恰好复用旧 PID 时，它不可能是这份旧锁的创建者。
  if (existing.pid === process.pid) return false;

  // Electron 强制退出可能留下上一个 worker。新桌面会话的
  // 随机令牌不同，因此允许新会话立即接管，但不将原始令牌写入磁盘。
  if (
    existing.owner === "desktop" &&
    lockIdentity.owner === "desktop" &&
    existing.desktopSessionFingerprint !==
      lockIdentity.desktopSessionFingerprint
  ) {
    return false;
  }

  if (!isProcessAlive(existing.pid)) return false;
  if (!processStartMatchesLock(existing, snapshot)) return false;

  // 旧版只有 PID，对仍存活的进程保持保守的单实例语义。
  if (existing.formatVersion === 0) return true;

  // CLI 之间以及 CLI/桌面之间仍是全局单实例；心跳过期后才接管。
  return isFreshLock(snapshot);
}

function writeLock() {
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(lockPath, "wx");
    created = true;
    writeFileSync(descriptor, `${JSON.stringify(lockIdentity, null, 2)}\n`, "utf8");
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
    }
    if (created) rmSync(lockPath, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function unchangedSnapshot(expected) {
  try {
    const current = readLockSnapshot();
    return (
      current.contents === expected.contents &&
      current.inode === expected.inode &&
      current.modifiedAtMs === expected.modifiedAtMs &&
      current.size === expected.size
    );
  } catch {
    return false;
  }
}

function acquireLock() {
  mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      writeLock();
      lockAcquired = true;
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let snapshot;
    try {
      snapshot = readLockSnapshot();
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (lockBlocksCurrentProcess(snapshot)) return false;
    if (!unchangedSnapshot(snapshot)) continue;
    rmSync(lockPath, { force: true });
  }

  return false;
}

function refreshLock() {
  if (!lockAcquired) return false;
  try {
    const snapshot = readLockSnapshot();
    if (!hasCurrentIdentity(snapshot.identity)) {
      lockAcquired = false;
      return false;
    }
    const now = new Date();
    utimesSync(lockPath, now, now);
    const confirmed = readLockSnapshot();
    if (!hasCurrentIdentity(confirmed.identity)) {
      lockAcquired = false;
      return false;
    }
    return true;
  } catch {
    lockAcquired = false;
    return false;
  }
}

function releaseLock() {
  if (!lockAcquired) return;
  try {
    const snapshot = readLockSnapshot();
    if (hasCurrentIdentity(snapshot.identity) && unchangedSnapshot(snapshot)) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // 锁已不存在时无需处理。
  } finally {
    lockAcquired = false;
  }
}

async function waitWhileHoldingLock(durationMs) {
  const deadline = Date.now() + Math.max(0, durationMs);
  do {
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(lockHeartbeatMs, remaining)),
      );
    }
    if (!refreshLock()) return false;
  } while (Date.now() < deadline);
  return true;
}

async function runOnce(dryRun) {
  try {
    const result = await requestGovernance(dryRun);
    console.log(
      JSON.stringify({
        ok: true,
        dryRun,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        result: result.body.result ?? null,
        stats: result.body.stats ?? null,
      }),
    );
  } catch (error) {
    await recordFailure(error);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runForever() {
  if (!acquireLock()) {
    console.log("夜间记忆整理进程已在运行。");
    return;
  }
  process.once("exit", releaseLock);
  process.once("SIGINT", () => {
    releaseLock();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    releaseLock();
    process.exit(0);
  });

  try {
    while (true) {
      const next = nextScheduledTime();
      console.log(`下次夜间记忆整理：${next.toLocaleString("zh-CN")}`);
      if (!(await waitWhileHoldingLock(next.getTime() - Date.now()))) {
        console.log("夜间记忆整理锁已由新会话接管，旧进程退出。");
        return;
      }
      try {
        const result = await requestGovernance(false);
        console.log(`夜间记忆整理完成：${result.finishedAt}`);
        if (!refreshLock()) {
          console.log("夜间记忆整理锁已由新会话接管，旧进程退出。");
          return;
        }
      } catch (error) {
        await recordFailure(error);
        console.error(
          `夜间记忆整理失败，15 分钟后重试：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (!(await waitWhileHoldingLock(15 * 60 * 1000))) {
          console.log("夜间记忆整理锁已由新会话接管，旧进程退出。");
          return;
        }
        try {
          const result = await requestGovernance(false);
          console.log(`夜间记忆整理重试完成：${result.finishedAt}`);
          if (!refreshLock()) {
            console.log("夜间记忆整理锁已由新会话接管，旧进程退出。");
            return;
          }
        } catch (retryError) {
          await recordFailure(retryError);
          console.error(
            `夜间记忆整理重试失败：${
              retryError instanceof Error ? retryError.message : String(retryError)
            }`,
          );
        }
      }
    }
  } finally {
    releaseLock();
  }
}

async function runLockProbe() {
  const acquired = acquireLock();
  console.log(
    JSON.stringify({
      ok: true,
      acquired,
      formatVersion: lockIdentity.formatVersion,
      owner: lockIdentity.owner,
    }),
  );
  if (!acquired) return;

  try {
    const holdMs = validNumber(
      process.env.ROBOT_MAINTENANCE_LOCK_PROBE_HOLD_MS,
      0,
      0,
      30_000,
    );
    if (holdMs > 0) await waitWhileHoldingLock(holdMs);
  } finally {
    releaseLock();
  }
}

const args = new Set(process.argv.slice(2));
if (args.has("--print-next")) {
  console.log(nextScheduledTime().toISOString());
} else if (args.has("--lock-probe")) {
  await runLockProbe();
} else if (args.has("--run-once") || args.has("--dry-run")) {
  await runOnce(args.has("--dry-run"));
} else {
  await runForever();
}
