import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function registerTypeScriptPaths() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const candidate = specifier.startsWith("@/")
        ? path.join(root, "apps/web/src", specifier.slice(2))
        : specifier.startsWith(".") && context.parentURL
          ? fileURLToPath(new URL(specifier, context.parentURL))
          : null;
      if (candidate) {
        for (const filePath of [candidate, `${candidate}.ts`, path.join(candidate, "index.ts")]) {
          if (existsSync(filePath)) {
            return { url: pathToFileURL(filePath).href, shortCircuit: true };
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

async function runChild() {
  registerTypeScriptPaths();
  const localStore = await import(
    "../apps/web/src/lib/memory/local-store.ts"
  );
  const { reconcileCurrentFactCorrection } = await import(
    "../apps/web/src/lib/memory/reconciliation.ts"
  );
  const { retrieveUnifiedMemory } = await import(
    "../apps/web/src/lib/memory/retriever.ts"
  );

  const old = localStore.createMemoryRecord({
    content: "用户之前发烧，身体不舒服",
    category: "sensitive",
    sensitive: true,
    confidence: 0.88,
    sourceConversationId: "old-conversation",
    sourceExcerpt: "用户之前说自己发烧不舒服",
  }).record;
  localStore.markMemoryConfirmed(old.id, "vector-old-fever");

  const deleted = [];
  const success = await reconcileCurrentFactCorrection(
    {
      userText: "我之前不是发烧，是食物中毒。",
      conversationId: "correction-conversation",
    },
    {
      async delete(id) {
        assert.equal(
          localStore.getMemoryRecord(old.id)?.status,
          "rejected",
          "首次外部向量调用前，旧 X 必须已在本地事务中停用",
        );
        const staged = localStore
          .listMemoryRecords("confirmed")
          .find((memory) => memory.content.includes("食物中毒"));
        assert.equal(staged?.mem0Id, null);
        deleted.push(id);
      },
      async add() {
        return "vector-new-poisoning";
      },
    },
  );
  assert.equal(success.status, "confirmed");
  assert.deepEqual(deleted, ["vector-old-fever"]);
  assert.equal(localStore.getMemoryRecord(old.id)?.status, "rejected");

  const confirmedAfterSuccess = localStore.listMemoryRecords("confirmed");
  const corrected = confirmedAfterSuccess.find(
    (memory) => memory.id === success.newMemoryId,
  );
  assert.equal(corrected?.content, "用户之前食物中毒，身体不舒服");
  assert.equal(corrected?.mem0Id, "vector-new-poisoning");
  assert.ok(confirmedAfterSuccess.every((memory) => !memory.content.includes("发烧")));

  const oldRecall = await retrieveUnifiedMemory({ query: "之前发烧", limit: 6 });
  assert.ok(oldRecall.items.every((item) => !item.content.includes("发烧")));
  const newRecall = await retrieveUnifiedMemory({ query: "之前食物中毒", limit: 6 });
  assert.ok(
    newRecall.items.some((item) => item.content.includes("食物中毒")),
    "纠正后的后续 Recall 必须返回安全的 Y",
  );

  const secondOld = localStore.createMemoryRecord({
    content: "用户今天练的是倒库",
    category: "temporary_state",
    sensitive: false,
    confidence: 0.9,
    sourceConversationId: "driving-old",
    sourceExcerpt: "用户说今天练的是倒库",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }).record;
  localStore.markMemoryConfirmed(secondOld.id, "vector-old-driving");

  const failedVector = await reconcileCurrentFactCorrection(
    {
      userText: "今天练的不是倒库，而是侧方停车。",
      conversationId: "driving-correction",
    },
    {
      async delete() {
        assert.equal(localStore.getMemoryRecord(secondOld.id)?.status, "rejected");
        const staged = localStore
          .listMemoryRecords("confirmed")
          .find((memory) => memory.content.includes("侧方停车"));
        assert.equal(staged?.mem0Id, null);
        throw new Error("delete unavailable");
      },
      async add() {
        throw new Error("add unavailable");
      },
    },
  );
  assert.equal(failedVector.status, "confirmed_local_only");
  assert.equal(localStore.getMemoryRecord(secondOld.id)?.status, "rejected");
  const localOnly = localStore.getMemoryRecord(failedVector.newMemoryId);
  assert.equal(localOnly?.status, "confirmed");
  assert.equal(localOnly?.mem0Id, null);
  assert.match(localOnly?.governanceReason ?? "", /向量同步失败/);

  const failedOldRecall = await retrieveUnifiedMemory({ query: "今天练倒库", limit: 6 });
  assert.ok(failedOldRecall.items.every((item) => !item.content.includes("倒库")));
  const localOnlyRecall = await retrieveUnifiedMemory({
    query: "今天练侧方停车",
    limit: 6,
  });
  assert.ok(localOnlyRecall.items.some((item) => item.content.includes("侧方停车")));

  const cuisine = localStore.createMemoryRecord({
    content: "用户喜欢上海菜",
    category: "ordinary_preference",
    sensitive: false,
    confidence: 0.9,
    sourceExcerpt: "用户说喜欢上海菜",
  }).record;
  localStore.markMemoryConfirmed(cuisine.id, "vector-shanghai-cuisine");
  const residence = localStore.createMemoryRecord({
    content: "用户住在上海",
    category: "stable_fact",
    sensitive: false,
    confidence: 0.9,
    sourceExcerpt: "用户说住在上海",
  }).record;
  localStore.markMemoryConfirmed(residence.id, "vector-shanghai-residence");
  const scoped = await reconcileCurrentFactCorrection(
    {
      userText: "我住的地方不是上海，而是北京。",
      conversationId: "residence-correction",
    },
    {
      async delete() {},
      async add() {
        return "vector-beijing-residence";
      },
    },
  );
  assert.equal(scoped.status, "confirmed");
  assert.equal(localStore.getMemoryRecord(cuisine.id)?.status, "confirmed");
  assert.equal(localStore.getMemoryRecord(residence.id)?.status, "rejected");
  assert.equal(localStore.getMemoryRecord(scoped.newMemoryId)?.content, "用户住在北京");

  const raceOld = localStore.createMemoryRecord({
    content: "用户住在甲地",
    category: "stable_fact",
    sensitive: false,
    confidence: 0.9,
    sourceExcerpt: "用户说住在甲地",
  }).record;
  localStore.markMemoryConfirmed(raceOld.id, "vector-race-x");
  const addStarted = deferred();
  const releaseFirstAdd = deferred();
  const firstDeleted = [];
  const first = reconcileCurrentFactCorrection(
    {
      userText: "我住的地方不是甲地，是乙地。",
      conversationId: "race-a",
    },
    {
      async delete(id) {
        firstDeleted.push(id);
        if (id === "vector-race-stale-y") {
          throw new Error("stale vector delete unavailable");
        }
      },
      async add() {
        addStarted.resolve();
        return releaseFirstAdd.promise;
      },
    },
  );
  await addStarted.promise;

  const second = await reconcileCurrentFactCorrection(
    {
      userText: "我住的地方不是乙地，是丙地。",
      conversationId: "race-b",
    },
    {
      async delete() {},
      async add() {
        return "vector-race-z";
      },
    },
  );
  assert.equal(second.status, "confirmed");
  releaseFirstAdd.resolve("vector-race-stale-y");
  const superseded = await first;
  assert.equal(superseded.status, "superseded");
  assert.deepEqual(firstDeleted, ["vector-race-x", "vector-race-stale-y"]);
  const staleTombstone = localStore.getMemoryRecordByMem0Id(
    "vector-race-stale-y",
  );
  assert.equal(staleTombstone?.status, "rejected");
  assert.match(staleTombstone?.governanceReason ?? "", /过时向量删除失败/);

  const raceConfirmed = localStore.listMemoryRecords("confirmed");
  assert.ok(raceConfirmed.every((memory) => !memory.content.includes("乙地")));
  assert.ok(raceConfirmed.some((memory) => memory.content.includes("丙地")));
  const raceYRecall = await retrieveUnifiedMemory({ query: "住在乙地", limit: 6 });
  assert.ok(raceYRecall.items.every((item) => !item.content.includes("乙地")));
  const raceZRecall = await retrieveUnifiedMemory({ query: "住在丙地", limit: 6 });
  assert.ok(raceZRecall.items.some((item) => item.content.includes("丙地")));

  console.log(
    JSON.stringify({
      ok: true,
      success: success.status,
      vectorFailure: failedVector.status,
      scopeIsolation: scoped.status,
      concurrentSupersession: superseded.status,
      oldFactsRetired: 5,
    }),
  );
}

if (process.argv.includes("--child")) {
  await runChild();
} else {
  const temp = mkdtempSync(path.join(tmpdir(), "robot-memory-reconciliation-"));
  const child = spawnSync(
    process.execPath,
    ["--no-warnings", fileURLToPath(import.meta.url), "--child"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ROBOT_MEMORY_DB_PATH: path.join(temp, "memory.db"),
        ROBOT_STATE_DB_PATH: path.join(temp, "state.db"),
        ROBOT_MEMORY_ENABLED: "false",
      },
    },
  );
  try {
    assert.equal(child.status, 0, child.stderr || child.stdout);
    process.stdout.write(child.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
