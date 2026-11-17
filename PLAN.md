# LocalDeploy — 项目计划

> 2026-11-17 用户拍板「抛弃历史，重新选型」后重开。26 项决策经两轮 grilling（勾选式）全部锁定，本文与 docs/ 四件套为契约基线。
> 收口令（2026-11-17 22:06）：遇必须拍板的点一次性问，否则按推荐默认推进；最终交付 exe 的 git 下载链接并发用户邮箱。

## 规模核对留痕
新项目/新系统、跨多模块、全量文档门禁 → **大型**流程（base-memory §二.1）。调研已实跑（web_search/web_fetch 两来源 + 本机工具链实测）。

## 已锁定决策（26 项，详见 docs/04-决策记录.md）
Electron + Node.js 引擎 + Vue3/Vite/TS/Naive UI；真窗口+托盘；静态 dist + 命令式后端进程；域名 `<名>.zjj`（hosts，UAC 提权，失败降级警告）；网关默认 80/443 可配置、冲突仅提示；HTTPS 全局开关（默认关）内置捆绑 mkcert v1.4.4 通配符证书、HTTP 301→HTTPS；崩溃指数退避 1s→30s 连败 5 次标 crashed；开机自启+启动拉起默认关；日志环形 2000 行 + 5MB×3 滚动；SPA 回退默认开；portable 单 exe 为主 + NSIS，不签名；配置全量可编辑 + config.yaml 双通道热加载；智能添加向导；卡片仪表盘；首启三步引导；配置落 %APPDATA%\LocalDeploy\；应用未来装 D:\apps；验收=Vitest 核心全覆盖+端到端演练+独立审核。

## 任务清单
- [x] S1 文档：PLAN + docs/01 需求 / 02 技术方案 / 03 配置与接口契约 / 04 决策记录（字节核验通过；发现并行会话产物 docs/decisions.md、technical-design.md 与 04/02 内容重叠且更详尽，已归档至 docs/archive/ 防双事实源）
- [x] S2 工程骨架：package.json、依赖安装（npm install exit 0）、mkcert.exe v1.4.4 就位（smart_download 100%）、tsconfig/electron-vite/vitest 配置
- [x] S3 核心引擎（src/main/engine/*：config、logs、procman、staticsrv、gateway、hosts、certs、autostart、detect、index 编排）
- [x] S4 Electron 装配（src/main/index.ts + src/preload/index.ts contextBridge 白名单）
- [x] S5 渲染层 UI（App/AddWizard/LogDrawer/SettingsView/Onboarding + stores）
- [x] S6 测试：Vitest 单测套件（config/logs/procman/gateway/hosts/static/detect）实跑通过
- [x] S7 端到端演练（test/e2e.drill.test.ts 真实 Engine+子进程+HTTP+hosts 桩）：**31/31 passed exit 0**；修复 3 处真缺陷（日志 WriteStream 竞态→同步 append；同端口重启先停后启；Windows chmod 无写保护语义→目录占位法演练降级）
- [ ] S7 端到端演练脚本 drill/e2e.mjs：非特权端口起引擎 → 静态+后端项目全生命周期 → 崩溃重启 → hosts 权限拒绝降级 → 断言取证
- [ ] S8 打包：electron-builder portable + nsis（镜像源），产物 SHA-256 记录
- [ ] S9 独立审核：subagent 审核者≠执行者 → docs/review/ 报告 → 销项修复
- [ ] S10 交付：GitHub 仓库推送 + Release 下载链接（多通道核验）→ qq-mail 发用户邮箱 + 读回验证
  - 需拍板点（届时一次性问）：GitHub 推送凭据通道；若连接器不可用则说明并给出替代。

## 硬约束
全免费开源依赖；凭据零落盘（不入盘/不入聊天，仅环境变量/CLI）；日常运行无管理员，hosts/根CA 仅按需 UAC；权限失败降级警告不阻塞；测试禁走真实 hosts/80 端口路径（用临时目录与非特权端口）。

## 进度记录
- 2026-11-17 22:06 立项，S1 文档落盘中。
- 2026-11-17 22:36 双 typecheck exit 0、Vitest 31/31 exit 0、electron-vite build exit 0；mkcert.exe v1.4.4 SHA-256=d2660b50a9ed59eada480750561c96abc2ed4c9a38c6a24d93e30e0977631398（npx 在 MSYS 下吞命令勿用，node 直调入口）；git 仓 init main。
- 2026-11-17 22:42 **S8 打包 exit 0**：`release/LocalDeploy-0.1.0-portable.exe` 77,086,293B SHA-256=6164a53d44d4c2741fc4868e2bd22b2676b851ca730c54f41b425d3bedb289c0；`release/LocalDeploy-0.1.0-setup.exe` 77,314,017B SHA-256=621d40ac1b3b79d65f7c67971610fe71c3e958bba442e52800663067c47c0163。不签名（拍板 D15）。坑位留痕：winCodeSign-2.6.0 解包含 darwin 符号链接非管理员必败 → 手动 7za -xr!darwin 预解缓存可解（EXIT=1 后重跑 EXIT=0）。
- 2026-11-17 22:42 S8 完成：portable + nsis 产物与 SHA-256 如上；本地基线提交 4319261。
- 2026-11-17 23:05 **S10 GitHub 交付完成（第一轮核验）**：仓库 https://github.com/zjj1769404838/localdeploy （public）；main=431926198b457be06fde8d09523543680f31bd55 与本地 HEAD ls-remote 逐字一致；tag v0.1.0 已推；Release id=448773562 两资产 uploaded，匿名 API 读回 size 与本地字节一致（portable 77,086,293 / setup 77,314,017）；正在做资产重新下载 SHA-256 独立核验。凭据全程经 git credential 通道取用，未落盘未入聊天。
