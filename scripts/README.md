# 脚本索引

## 日常运行

- `start-robot.ps1`：旧网页诊断入口。
- `stop-robot.ps1`：停止网页与相关本地进程。
- `nightly-memory-worker.mjs`：夜间记忆整理 worker。

## 桌面构建

- `install-desktop-config.ps1`：安装桌面版本机配置。
- `prepare-desktop-runtime.mjs`：准备随包 Node 与 Next standalone runtime。
- `prepare-desktop-visual-assets.mjs`：从正式源图生成 PNG、ICO、WebP 与安装 GIF。

## 回归测试

- `desktop-runtime-regression.mjs`：桌面运行时与安全契约。
- `persona-regression.mjs`：人格与语气。
- `recall-ranking-regression.mjs`：五路召回与排序。
- `conversation-policy-regression.mjs`：对话策略。
- `proactive-arbitration-regression.mjs`：主动消息仲裁。
- `memory-reconciliation-regression.mjs`：记忆冲突与合并。

## 内部 worker

- `proactive-activity-route-worker.mjs`：主动活动路由测试 worker。

脚本保持扁平目录，避免为当前数量引入额外层级和修改 npm 调用路径。
