# Robot · Home Robot

本地优先的陪伴应用。当前版本包含聊天人格、Supabase 会话保存、Mem0 长期记忆、关系连续性、记忆管理、共同日记、未完成话题和 Q 版桌宠。语音按计划延期。

## Windows 桌面版

Home Robot 的正式自用入口是 Windows 桌面程序，不再通过系统浏览器使用。Electron 只负责窗口，应用内部由随包的官方 Node 启动本地服务；服务固定绑定 `127.0.0.1:3210`，并用每次启动随机生成的令牌拒绝浏览器或其他本机进程直接访问。

首次构建先安装依赖和本机配置，再生成未安装的桌面目录包：

```powershell
& '.\scripts\install-desktop-config.ps1'
npm install
npm run test:desktop
npm run desktop:package
```

目录包位于 `apps\desktop\out\Home Robot-win32-x64`。它会优先沿用 `.env.local` 中已有的 Robot 私有数据库路径；未配置路径时才写入 `%APPDATA%\Home Robot\data`。Ollama 或 Docker/Qdrant 暂不可用时，窗口和聊天仍可启动，向量记忆走现有降级路径。

构建完成后也可双击仓库根目录的 `启动Home Robot.cmd`；该入口只启动桌面程序，不再打开浏览器。旧的网页启动脚本仅保留给开发诊断。

当前桌面版已完成“月白宣纸”视觉、应用图标、快捷方式图标、载入封面和 Squirrel 安装包验证。最终自用安装包位于 `artifacts\desktop-visual-20260820\release\Home-Robot-Setup.exe`，同目录保留便携 ZIP 与 SHA-256 校验材料。

开发调试桌面窗口：

```powershell
npm run desktop:dev
```

## 项目目录

- `apps/web`：Next.js 界面、API 与业务实现。
- `apps/desktop`：Electron 主进程、封面、图标和打包配置；`runtime`、`out`、`.next` 均为可再生成目录，不长期保留。
- `scripts`：启动、停止、桌面构建和回归测试脚本，分类说明见 `scripts/README.md`。
- `config`：配置模板与本机私有配置；私有配置不会提交。
- `data`：本机数据库、运行状态与历史备份，禁止作为普通构建产物清理。
- `docs`：设计、人格、交互和验证文档，索引见 `docs/README.md`。
- `supabase`：数据库迁移与 Supabase 相关文件。
- `artifacts`：阶段性审计、补丁、验证记录与发布件；当前桌面正式版本以 `desktop-visual-20260820` 为准。
- `node_modules`：本机依赖，可由 `npm install` 重建，但为保持开箱可用默认保留。

## 旧的诊断启动方式

下面的脚本只保留给开发诊断；日常使用桌面版：

```powershell
& '.\scripts\start-robot.ps1'
```

启动后访问：<http://127.0.0.1:3000>

停止网站：

```powershell
& '.\scripts\stop-robot.ps1'
```

如需同时停止 Qdrant：

```powershell
& '.\scripts\stop-robot.ps1' -IncludeMemoryServices
```

## 页面

- `/`：与Home Robot聊天
- `/memories`：查看、确认、修改或删除长期记忆
- `/journal`：关系状态、共同日记和未完成话题

聊天页支持新建、切换、重命名和删除会话。用户消息会在请求模型前先保存；模型失败时可直接重试，不会丢掉刚才输入。助手回复下方的“这句有点生硬”会把纠正写入当前会话，不会污染长期人格。

Supabase 在 3.5 秒内无法完成会话初始化时，聊天页会自动切换到客户端本地持久化，不再锁住输入框。本地模式同样支持历史会话、重命名、删除和关闭桌面程序后恢复。

## 模型配置

复制根目录 `.env.example` 中需要的配置到 `apps\web\.env.local`。陪伴聊天优先使用通用 OpenAI 兼容接口：

```dotenv
ROBOT_CHAT_API_KEY=
ROBOT_CHAT_BASE_URL=
ROBOT_CHAT_MODEL=
ROBOT_CHAT_PROVIDER=openai-compatible
ROBOT_MODEL_TIMEOUT_MS=45000
```

`KIMI_CODE_*` 仅作为兼容回退。密钥只放在 `apps\web\.env.local`，不要提交或复制到文档中。

每轮对话最多进行一次主聊天请求和一次后台整理请求。后台整理统一处理会话摘要、记忆候选、日记、未完成话题与关系事件，不再分别重复调用模型。

## 记忆与日记治理

- 纯确认、寒暄和笑声只更新互动时间，不调用后台整理模型。
- 临时状态到期后自动归档；待确认记忆超过 14 天自动归档。
- 第三方敏感候选不进入长期记忆。
- 相似记忆不会重复进入聊天上下文；可能互相矛盾的偏好必须由用户确认。
- 完成或放弃未完成话题时，对应的长期记忆会同时停用。
- 自动日记按同日合并，重复句不会反复追加；历史重复日记和话题可在日记页一键软合并。
- 治理只改变状态或软隐藏记录，不物理删除历史数据。

## 检查

```powershell
npm run typecheck
npm run test:persona
npm run test:recall
npm run test:conversation
npm run test:proactive
npm run test:reconciliation
npm run test:desktop
npm run build
```

## 数据位置

- 会话：由 `NEXT_PUBLIC_SUPABASE_URL` 指向的 Supabase 项目
- 记忆候选：`ROBOT_MEMORY_DB_PATH`；未配置时为桌面数据目录下的 `data\memory\robot-memory.db`
- Mem0 历史：`ROBOT_MEM0_HISTORY_DB_PATH`；未配置时为桌面数据目录下的 `data\memory\mem0-history.db`
- 向量记忆：Docker 卷 `robot_qdrant_data`
- 关系与日记：`ROBOT_STATE_DB_PATH`；未配置时为桌面数据目录下的 `data\state\robot-state.db`
- 桌宠：`${CODEX_HOME}\pets\home-robot`

真实密钥、会话、长期记忆、关系状态、备份、私有人格材料和本机配置均由 `.gitignore` 排除。仓库只保留 `.env.example` 与 `config/robot.example.yaml` 作为配置模板。
