# LocalDeploy 技术方案（v1）

> 依据：grilling 26 项拍板决策（见 decisions.md）。本文件是架构唯一权威来源。
> 最后更新：2026-11-17T21:50+08:00

## 1. 总体架构

```
┌────────────────────────── LocalDeploy.exe (Electron) ──────────────────────────┐
│  主进程 (Node.js)                                                               │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐               │
│  │ ConfigStore│  │ ProcessMgr │  │ StaticSrv  │  │ Gateway    │               │
│  │ yaml+watch │  │ spawn/守护 │  │ dist+SPA   │  │ 80/443反代 │               │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘               │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐               │
│  │ HostsMgr   │  │ CertMgr    │  │ LogHub     │  │ AutoStart  │               │
│  │ hosts+UAC  │  │ mkcert调用 │  │ 环形+滚动  │  │ HKCU Run   │               │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘               │
│        ▲ IPC (contextBridge, 类型安全契约)                                      │
│  渲染进程 (Vue3 + Vite + TS + Naive UI)                                         │
│  仪表盘 / 添加向导 / 设置页 / 首启引导 / 日志抽屉                                │
│  托盘：关窗最小化，退出才停服务                                                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **单进程模型**：引擎全部跑在 Electron 主进程（Node 侧），不另起 daemon。
  窗口关闭→隐藏到托盘，引擎继续；托盘「退出」→优雅停止所有子进程后退出。
- **子进程**：后端项目用 `child_process.spawn`（shell:true 支持 npm 等命令），
  独立进程组，Windows 下用 `taskkill /pid /T /F` 杀进程树。

## 2. 目录结构

```
project-deployment/
├─ PLAN.md                  # 进度权威
├─ docs/                    # 技术方案/决策/审核/E2E 报告
├─ package.json             # 根：electron 主进程 + 构建脚本
├─ electron.vite.config.ts  # electron-vite 三段构建（main/preload/renderer）
├─ src/
│  ├─ main/                 # 主进程
│  │  ├─ index.ts           # app 生命周期/窗口/托盘
│  │  ├─ ipc.ts             # IPC handler 注册（契约见 §6）
│  │  └─ engine/
│  │     ├─ config.ts       # ConfigStore：yaml 读写+fs.watch 热加载+默认值
│  │     ├─ process-manager.ts  # 进程守护状态机
│  │     ├─ static-server.ts    # 静态托管+SPA fallback
│  │     ├─ gateway.ts      # http/https 反代网关（Host 分流）
│  │     ├─ hosts.ts        # hosts 读写+UAC 提权+降级
│  │     ├─ certs.ts        # mkcert 调用封装
│  │     ├─ logs.ts         # LogHub：环形缓冲+滚动文件
│  │     ├─ autostart.ts    # HKCU Run 注册表
│  │     └─ detect.ts       # 项目目录智能识别
│  ├─ preload/index.ts      # contextBridge 暴露类型安全 API
│  └─ renderer/             # Vue3 应用
│     ├─ src/views/         # Dashboard / Settings / Onboarding
│     ├─ src/components/    # ProjectCard / AddWizard / LogDrawer / StatusBadge
│     └─ src/stores/        # pinia：projects / settings / logs
├─ resources/mkcert.exe     # 内置 mkcert v1.4.4（BSD）
├─ tests/                   # Vitest：engine 单测 + 集成
└─ build/                   # 打包产物（gitignore）
```

## 3. 数据模型与配置

### 3.1 config.yaml（`%APPDATA%\LocalDeploy\config.yaml`）

```yaml
version: 1
settings:
  gateway:
    httpPort: 80          # 可配置；冲突仅提示
    httpsPort: 443
    httpsEnabled: false   # 全局总开关
  domain:
    suffix: zjj           # 可配置
    enabled: true         # hosts 写入总开关
  restart:
    autoRestart: true
    maxRetries: 5
    backoffBaseMs: 1000
    backoffCapMs: 30000
  logs:
    ringLines: 2000
    fileMaxMB: 5
    fileBackups: 3
  autostart:
    onBoot: false         # HKCU Run
    launchProjects: false # 启动时拉起上次运行中的项目
  ui:
    onboardingDone: false
projects:
  - id: p-xxxx            # nanoid
    name: myapp
    type: static | command
    dir: D:\sites\myapp\dist      # static: dist 目录; command: 工作目录
    command: node server.js       # command 型必填
    port: 3001                    # 项目自身端口（static 由内置静态服务器分配）
    domain: myapp                 # 子域名前缀，默认=name 规范化
    spa: true                     # static 型 SPA fallback
    autoStart: false              # 随应用启动
    env: {}                       # 附加环境变量
```

- **双通道热加载**：设置页写 → ConfigStore.save() → fs.watch 兜底外部编辑；
  变更事件广播 IPC `config:changed`，渲染层与引擎同步响应。
- 校验失败（外部改坏 yaml）：保留上一份合法快照继续运行 + 界面警告，不崩溃。
- 写入原子化：tmp 文件 + rename，避免半截文件。

### 3.2 运行时状态（不落盘，重启重建）

进程状态机：`stopped → starting → running → stopping → stopped`，
异常分支 `running → crashed(重试中) → running | failed(连败5次)`。
「上次运行中」集合落盘到 config 的 `lastRunning: [id...]`，供 launchProjects 使用。

## 4. 关键机制

### 4.1 进程守护（ProcessManager）
- spawn(command, {cwd, env, shell:true})；stdout/stderr → LogHub。
- exit 事件：非手动停止 → 指数退避重启（1s,2s,4s,8s,16s,30s,30s…），
  连续失败计数达 maxRetries → 状态 failed，界面亮红，手动「重启」清零计数。
- 停止：先 SIGTERM 语义（Windows 无信号，直接 taskkill /T 不带 /F 尝试温和，
  超时 5s 后 /F 强杀）；杀进程树防孤儿。
- 端口冲突检测：启动前 net.createServer 试绑，占用则报错提示（不自动换端口）。

### 4.2 静态服务（StaticServer）
- 每 static 项目一个 http.Server 监听分配端口（从 3100 起探测空闲）。
- MIME 按扩展名；路径穿越防护（resolve 后必须在 root 内）。
- SPA 模式：GET 未命中文件且 Accept 含 text/html → 回退 index.html。
- 缓存头：html no-cache，带 hash 资产长缓存（可选 v1.1）。

### 4.3 网关（Gateway）
- http.Server(httpPort) + https.Server(httpsPort, mkcert 证书)。
- 路由：Host 头 `<name>.<suffix>` → 查项目 → 反代到 127.0.0.1:项目端口
  （http-proxy-middleware 或手写 http.request 管道，含 WebSocket upgrade 透传）。
- httpsEnabled=true 时 HTTP 侧 301 → https 同 Host；false 时纯 HTTP。
- 未知 Host → 404 页（列出可用项目链接，友好）。
- 端口绑定失败（EADDRINUSE）→ 状态 degraded + 界面醒目提示改端口，不自动回退。
- 网关自身也托管一个内置管理入口？——不，管理界面在 Electron 窗口内，网关只服务项目。

### 4.4 hosts（HostsMgr）
- 读：解析 etc\hosts，识别 `# LocalDeploy BEGIN/END` 标记块，块内全量管理。
- 写：生成新块 → 普通权限尝试直接写；EPERM/EACCES → 触发 UAC：
  PowerShell `Start-Process -Verb RunAs` 执行写入脚本（一次性，合并所有域名）。
- UAC 被拒/失败 → 返回警告 `W_HOSTS_DENIED`，项目照常创建运行，
  界面琥珀色提示「域名不可用，可用端口访问」，提供「重试授权」按钮。
- 删除项目 → 同步清理块内条目（同样降级语义）。
- flushdns：`ipconfig /flushdns` 失败忽略（非管理员可失败，不影响 hosts 生效）。

### 4.5 证书（CertMgr）
- resources/mkcert.exe（打包进 extraResources，运行时路径 process.resourcesPath）。
- 首次启用 HTTPS：`mkcert -install`（装根 CA，会弹 UAC/系统确认）→
  `mkcert -cert-file <data>/certs/wildcard.zjj.pem -key-file <data>/certs/wildcard.zjj-key.pem "*.zjj" localhost 127.0.0.1`。
- CAROOT 固定到 `%APPDATA%\LocalDeploy\ca`（mkcert 环境变量 CAROOT），
  证书与 CA 材料不随项目走；私钥文件 ACL 当前用户。
- 失败降级：HTTPS 开关自动回落 false + 警告，HTTP 不受影响。
- 后缀变更 → 重新签发通配符证书。

### 4.6 日志（LogHub）
- 每项目：内存环形 2000 行（可配）+ 文件 `<data>/logs/<id>.log` 滚动 5MB×3。
- IPC 推送 `log:line`（节流批量 100ms）；历史读取 API；清空 API。
- 应用自身日志：electron-log 落 `<data>/logs/app.log`。

### 4.7 智能识别（detect.ts）
选目录后扫描（深度≤2，跳过 node_modules）：
- dist/ build/ out/ public/ 含 index.html → static 候选（优先 dist）
- package.json → 读 scripts：start > dev > serve；预填 `npm run <script>`，
  端口从 scripts/常见约定猜测（可改）
- *.jar → `java -jar <file>`；*.py → `python <file>`；go.mod+exe → 直接运行
- 输出候选列表让用户一键选择/微调，域名前缀=目录名规范化（小写连字符）。

### 4.8 开机自启（autostart.ts）
- HKCU\Software\Microsoft\Windows\CurrentVersion\Run，值名 LocalDeploy，
  指向 exe 路径（portable 路径变化时设置页可刷新）。reg.exe 读写，无需管理员。

## 5. 安全边界

- 渲染进程 nodeIntegration=false, contextIsolation=true, sandbox=true；
  preload 仅暴露白名单 IPC（见 §6），无任意 shell 通道。
- 网关/静态服务仅绑 127.0.0.1（局域网不可达，自用定位）。
- 路径穿越防护、Host 头校验（仅接受已注册域名）。
- 命令执行是产品核心功能（用户自己填的命令），IPC 层校验项目归属，
  不接受渲染层任意命令字符串直 exec。
- mkcert 私钥/CA 仅存用户 APPDATA，不进 git、不进日志。

## 6. IPC 契约（preload 暴露 window.api）

```ts
projects: list/get/create/update/remove/start/stop/restart
config:   get/set/onChange
logs:     tail(id)/history(id)/clear(id)/onLine(cb)
hosts:    status()/retryAuth()          // 降级警告状态
certs:    status()/enableHttps()/disableHttps()
detect:   scan(dir) → DetectResult[]
system:   openExternal(url)/openDir(dir)/pickDirectory()
app:      getVersion()/getPaths()/quit()
events:   project:stateChanged / config:changed / gateway:status
```

全部 invoke/handle 异步，错误统一 `{ok:false, code, message, warnings?}`。

## 7. 构建与交付

- electron-vite 构建 main/preload/renderer → electron-builder：
  - portable：`LocalDeploy-<ver>-portable.exe`（主交付）
  - nsis：`LocalDeploy-<ver>-setup.exe`（可选安装）
- extraResources：mkcert.exe；asar 打包源码。
- 不签名；README 写明 SmartScreen「更多信息→仍要运行」。
- 交付链：git init → GitHub 仓库（用户既有账号）→ Release 附 exe + SHA256SUMS →
  独立读回核验（API 查 asset + 重新下载算 SHA-256）→ 邮件发送下载链接 → emails_find 读回。

## 8. 测试策略

- Vitest 单测：config（解析/校验/热加载/坏文件降级）、process-manager
  （状态机/退避/连败上限，用真实短命 node 脚本）、static（MIME/SPA/穿越）、
  gateway（Host 分流/301/未知 Host）、hosts（块解析/生成，写盘用临时目录桩，
  不碰真实 hosts）、detect（ fixture 目录）、logs（环形/滚动）。
- 集成：临时目录起真实静态+node 后端，走完整生命周期。
- 真机 E2E（M4）：真实 hosts/HTTPS 演练需 UAC，由用户配合或授权一次完成；
  权限拒绝降级路径必须演练。
- 禁测试走真实副作用路径（hosts/特权端口）——单测一律桩/临时目录/高位端口。