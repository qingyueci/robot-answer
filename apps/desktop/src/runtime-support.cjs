const path = require("node:path");
const { parseEnv } = require("node:util");

const DESKTOP_TOKEN_HEADER = "x-home-robot-desktop-token";

function parseEnvText(contents) {
  let parsed;
  try {
    parsed = parseEnv(String(contents));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`桌面环境配置格式错误：${message}`, { cause: error });
  }

  const result = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    result[key] = value;
  }

  return result;
}

function hasConfiguredChatModel(environment) {
  const hasPair = (keyName, modelName) =>
    Boolean(environment[keyName]?.trim() && environment[modelName]?.trim());

  return (
    hasPair("ROBOT_CHAT_API_KEY", "ROBOT_CHAT_MODEL") ||
    hasPair("KIMI_CODE_API_KEY", "KIMI_CODE_MODEL") ||
    hasPair("OPENAI_API_KEY", "OPENAI_MODEL")
  );
}

function desktopDataPaths(userDataPath) {
  const dataRoot = path.join(userDataPath, "data");
  const stateRoot = path.join(dataRoot, "state");
  return {
    ROBOT_MEMORY_DB_PATH: path.join(dataRoot, "memory", "robot-memory.db"),
    ROBOT_MEM0_HISTORY_DB_PATH: path.join(dataRoot, "memory", "mem0-history.db"),
    ROBOT_STATE_DB_PATH: path.join(stateRoot, "robot-state.db"),
    ROBOT_MAINTENANCE_STATE_PATH: path.join(
      stateRoot,
      "nightly-maintenance.json",
    ),
    ROBOT_MAINTENANCE_LOCK_PATH: path.join(
      stateRoot,
      "nightly-maintenance.lock",
    ),
  };
}

function isTrustedAppUrl(candidate, expectedOrigin) {
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" && url.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function parsePort(rawValue, fallback) {
  const port = Number(rawValue);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : fallback;
}

module.exports = {
  DESKTOP_TOKEN_HEADER,
  desktopDataPaths,
  hasConfiguredChatModel,
  isTrustedAppUrl,
  parseEnvText,
  parsePort,
};
