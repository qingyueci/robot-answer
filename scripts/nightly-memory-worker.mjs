import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const envFile = path.join(projectRoot, "apps", "web", ".env.local");

function loadLocalEnv() {
  if (!existsSync(envFile)) return;
  for (const rawLine of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
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
  const response = await fetch(`${baseUrl}/api/governance`, {
    method: dryRun ? "GET" : "POST",
    headers: dryRun ? undefined : { "content-type": "application/json" },
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

function writeLock() {
  const descriptor = openSync(lockPath, "wx");
  writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  closeSync(descriptor);
}

function acquireLock() {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    writeLock();
    return true;
  } catch {
    let existingPid = 0;
    try {
      existingPid = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(existingPid) && existingPid > 0) {
        process.kill(existingPid, 0);
        return false;
      }
    } catch {
      // 进程不存在或锁文件损坏，下面清理旧锁。
    }
    rmSync(lockPath, { force: true });
    writeLock();
    return true;
  }
}

function releaseLock() {
  try {
    if (Number(readFileSync(lockPath, "utf8").trim()) === process.pid) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // 锁已不存在时无需处理。
  }
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

  while (true) {
    const next = nextScheduledTime();
    console.log(`下次夜间记忆整理：${next.toLocaleString("zh-CN")}`);
    await new Promise((resolve) => setTimeout(resolve, next.getTime() - Date.now()));
    try {
      const result = await requestGovernance(false);
      console.log(`夜间记忆整理完成：${result.finishedAt}`);
    } catch (error) {
      await recordFailure(error);
      console.error(
        `夜间记忆整理失败，15 分钟后重试：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, 15 * 60 * 1000));
      try {
        const result = await requestGovernance(false);
        console.log(`夜间记忆整理重试完成：${result.finishedAt}`);
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
}

const args = new Set(process.argv.slice(2));
if (args.has("--print-next")) {
  console.log(nextScheduledTime().toISOString());
} else if (args.has("--run-once") || args.has("--dry-run")) {
  await runOnce(args.has("--dry-run"));
} else {
  await runForever();
}
