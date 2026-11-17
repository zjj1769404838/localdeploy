# LocalDeploy

Windows 本地部署管理桌面工具：一键托管前端构建产物与后端进程，崩溃自动拉起，自定义本地域名（`<项目名>.zjj`）+ 可选 HTTPS 统一访问。

免费开源（MIT），零云依赖，数据全部留在本机。

## 下载
Release 页：`LocalDeploy-0.1.1-portable.exe`（绿色版，双击即用）或 `LocalDeploy-0.1.1-setup.exe`（安装版）。
https://github.com/zjj1769404838/localdeploy/releases/latest

> **SmartScreen 提示**：本工具未做付费代码签名（零成本开源原则）。首次运行若出现 Windows 已保护你的电脑 → 点「更多信息」→「仍要运行」。

## 功能
- **智能添加**：选择项目目录自动识别（dist/build/out → 静态站点；package.json/jar/py/go → 进程），预填命令与端口
- **进程守护**：指数退避自动重启（1s→30s，连败 5 次标崩溃，一键复活）
- **本地域名**：自动写 hosts 托管区块，浏览器直接访问 `myapp.zjj`；非管理员按需 UAC 一次，拒绝也不阻塞（端口直连兜底）
- **本地 HTTPS**：内置 [mkcert](https://github.com/FiloSottile/mkcert) v1.4.4（BSD）自动装根 CA + `*.zjj` 通配符证书，全局开关默认关
- **日志**：实时 tail + 环形 2000 行 + 5MB×3 滚动落盘（`%APPDATA%\LocalDeploy\logs\`）
- **全量配置化**：设置页可视化编辑所有行为参数，与 `%APPDATA%\LocalDeploy\config.yaml` 双通道热加载
- **托盘常驻**：关窗最小化，服务不断

## 开发
```bash
npm install
npm test          # Vitest 31 用例（引擎单测 + 端到端演练）
npm run dev       # electron-vite 开发模式
npm run dist      # 打包 portable + nsis
```
架构与决策见 `docs/`。

## 已知限制
- 未签名：SmartScreen 首次拦截（见上）
- 80/443 若被 IIS/http.sys 占用：网关不自动回退，请在设置页改端口（界面会红字提示冲突）
- `--elevated-hosts` 为内部提权 helper 子命令，请勿手动调用
