import { createReadStream } from "node:fs";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const EXPECTED_NODE_VERSION = "v24.15.0";
const EXPECTED_NODE_ABI = "137";
const EXPECTED_NODE_LICENSE_SHA256 =
  "4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18";

const root = path.resolve(import.meta.dirname, "..");
const web = path.join(root, "apps", "web");
const desktop = path.join(root, "apps", "desktop");
const runtime = path.join(desktop, "runtime");
const standaloneSource = path.join(web, ".next", "standalone");
const standaloneTarget = path.join(runtime, "standalone");
const webRuntime = path.join(standaloneTarget, "apps", "web");
const nodeTarget = path.join(runtime, "node", "node.exe");
const nodeLicenseSource = path.join(
  desktop,
  "licenses",
  "node-v24.15.0-LICENSE.txt",
);
const nodeLicenseTarget = path.join(runtime, "node", "LICENSE.txt");
const omittedDesktopPublicPaths = ["avatar-candidates"];

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(
    `桌面运行时目前只支持 Windows x64，当前为 ${process.platform}/${process.arch}`,
  );
}
if (
  process.version !== EXPECTED_NODE_VERSION ||
  process.versions.modules !== EXPECTED_NODE_ABI
) {
  throw new Error(
    `桌面构建必须使用 Node ${EXPECTED_NODE_VERSION} / ABI ${EXPECTED_NODE_ABI}，` +
      `当前为 ${process.version} / ABI ${process.versions.modules}`,
  );
}

await access(standaloneSource);

async function fileMetadata(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const details = await stat(filePath);
  return {
    sha256: hash.digest("hex"),
    bytes: details.size,
  };
}

function verifyAuthenticode(filePath) {
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:HOME_ROBOT_NODE_PATH",
    "$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
    "[pscustomobject]@{ Status = [string]$signature.Status; Subject = $subject } | ConvertTo-Json -Compress",
  ].join("; ");
  const environment = {
    ...process.env,
    HOME_ROBOT_NODE_PATH: filePath,
  };
  // Codex/PowerShell 7 的 PSModulePath 会让 Windows PowerShell 5.1 无法自动加载
  // Microsoft.PowerShell.Security；让子进程恢复自己的系统模块搜索路径。
  delete environment.PSModulePath;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: environment,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Node 签名校验命令失败（退出代码 ${result.status ?? "unknown"}）`);
  }

  const signature = JSON.parse(result.stdout.trim());
  if (
    signature.Status !== "Valid" ||
    !String(signature.Subject).includes("OpenJS Foundation")
  ) {
    throw new Error(
      `Node 签名无效或签名者不匹配：${signature.Status} / ${signature.Subject || "unknown"}`,
    );
  }
  return signature;
}

function cleanChildEnvironment() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return environment;
}

function probeNativeSqlite(nodeExecutable, betterSqlitePackage) {
  const probe = [
    "const { DatabaseSync } = require('node:sqlite')",
    "const NativeDatabase = require(process.argv[1])",
    "const builtIn = new DatabaseSync(':memory:')",
    "const native = new NativeDatabase(':memory:')",
    "const builtInValue = builtIn.prepare('select 1 as value').get().value",
    "const nativeValue = native.prepare('select 1 as value').get().value",
    "native.close()",
    "builtIn.close()",
    "process.stdout.write(JSON.stringify({ node: process.version, abi: process.versions.modules, builtInValue, nativeValue }))",
  ].join("; ");
  const result = spawnSync(
    nodeExecutable,
    ["-e", probe, betterSqlitePackage],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: cleanChildEnvironment(),
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `桌面 Node SQLite 原生探针失败（退出代码 ${result.status ?? "unknown"}）：` +
        String(result.stderr || result.stdout).trim().slice(0, 500),
    );
  }
  const output = JSON.parse(result.stdout);
  if (
    output.node !== EXPECTED_NODE_VERSION ||
    output.abi !== EXPECTED_NODE_ABI ||
    output.builtInValue !== 1 ||
    output.nativeValue !== 1
  ) {
    throw new Error(`桌面 Node SQLite 原生探针结果异常：${result.stdout}`);
  }
  return output;
}

verifyAuthenticode(process.execPath);
const licenseSourceMetadata = await fileMetadata(nodeLicenseSource);
if (licenseSourceMetadata.sha256 !== EXPECTED_NODE_LICENSE_SHA256) {
  throw new Error("Node LICENSE 文件与锁定的 Node v24.15.0 版本不匹配");
}

await rm(runtime, { recursive: true, force: true });
await mkdir(webRuntime, { recursive: true });
await cp(standaloneSource, standaloneTarget, {
  recursive: true,
  force: true,
  // Next standalone 会生成指向 workspace node_modules 的链接；桌面运行时必须
  // 成为可独立移动的真实文件树，同时避免要求 Windows Developer Mode。
  dereference: true,
});
await cp(path.join(web, ".next", "static"), path.join(webRuntime, ".next", "static"), {
  recursive: true,
  force: true,
});
await cp(path.join(web, "public"), path.join(webRuntime, "public"), {
  recursive: true,
  force: true,
});
for (const relativePath of omittedDesktopPublicPaths) {
  // 这些是历史视觉候选，当前页面没有引用；源文件仍保留在 Web public，
  // 最终视觉确认后可按选择重新纳入桌面运行时。
  await rm(path.join(webRuntime, "public", relativePath), {
    recursive: true,
    force: true,
  });
}
await cp(
  path.join(root, "scripts", "nightly-memory-worker.mjs"),
  path.join(runtime, "nightly-memory-worker.mjs"),
);
await mkdir(path.dirname(nodeTarget), { recursive: true });
await cp(process.execPath, nodeTarget);
await cp(nodeLicenseSource, nodeLicenseTarget);

const copiedSignature = verifyAuthenticode(nodeTarget);

const serverPath = path.join(webRuntime, "server.js");
const betterSqlitePackage = path.join(
  standaloneTarget,
  "node_modules",
  "better-sqlite3",
);
const betterSqliteAddon = path.join(
  betterSqlitePackage,
  "build",
  "Release",
  "better_sqlite3.node",
);
await access(betterSqliteAddon);
const nativeProbe = probeNativeSqlite(nodeTarget, betterSqlitePackage);
const [server, node, nodeLicense, nativeAddon, buildId] = await Promise.all([
  fileMetadata(serverPath),
  fileMetadata(nodeTarget),
  fileMetadata(nodeLicenseTarget),
  fileMetadata(betterSqliteAddon),
  readFile(path.join(web, ".next", "BUILD_ID"), "utf8"),
]);
if (nodeLicense.sha256 !== EXPECTED_NODE_LICENSE_SHA256) {
  throw new Error("复制后的 Node LICENSE 校验失败");
}
const manifest = {
  formatVersion: 1,
  createdAt: new Date().toISOString(),
  buildId: buildId.trim(),
  server: "standalone/apps/web/server.js",
  serverSha256: server.sha256,
  serverBytes: server.bytes,
  node: "node/node.exe",
  nodeVersion: process.version,
  nodeModulesAbi: process.versions.modules,
  nodeSha256: node.sha256,
  nodeBytes: node.bytes,
  nodeSignatureStatus: copiedSignature.Status,
  nodeSignatureSubject: copiedSignature.Subject,
  nodeLicense: "node/LICENSE.txt",
  nodeLicenseSha256: nodeLicense.sha256,
  nativeAddon: "standalone/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  nativeAddonSha256: nativeAddon.sha256,
  nativeProbe,
  omittedDesktopPublicPaths,
};
await writeFile(
  path.join(runtime, "desktop-runtime.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify({ ok: true, runtime, ...manifest }));
