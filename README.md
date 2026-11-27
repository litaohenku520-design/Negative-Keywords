# AMZ 否词工具 Agent 插件 (`upbestks-neg-keyword`)

基于 Antigravity Plugin + MCP App 架构的亚马逊广告否词工具独立插件，独立维护 `backend/rules_config.json`。

## 目录结构
- `plugin.json`：插件清单
- `mcp_config.json`：MCP Server 启动配置（`backend/neg_mcp_server.py`）
- `backend/`：否词分类引擎、审计引擎、规则配置 `rules_config.json` 与 MCP Server
- `ui/`：React + AntD + `@modelcontextprotocol/ext-apps` 单文件工作台（`ui/dist/app.html`）
- `skills/neg-keyword-ops/SKILL.md`：否词操作与审计 SOP
- `rules/AGENTS.md`：安全规范与红线

## 跨机器部署注意
1. 若新机器的 Python 路径不是 `C:\Users\admin\AppData\Local\Programs\Python\Python312\python.exe`，请修改 `mcp_config.json` 中的 `command`。
2. 如需修改并重新打包 UI：
   ```bash
   cd ui
   npm install
   npm run build
   ```
