# Discover amzn — 全能亚马逊运营工作台

基于 Antigravity Plugin + MCP App 架构打造的亚马逊运营集成平台，所有工具模块化存放于 `tools/` 下，并统一通过 GitHub 仓库备份同步。

## 仓库目录结构
- `shell/`：Discover amzn 总控容器（`mcp_server.py`、`sub_mcp_bridge.py`、`git_sync.py` 与统一侧边栏前端 `shell/ui/`）
- `tools/`：每个工具独立目录与各自数据目录：
  - `tools/ops-planner/`：运营计划（默认主页面，数据位于 `server/data/planner_data.json`）
  - `tools/neg-keyword/`：否词助手（引擎 + 独立规则库 `rules_config.json` 与分店铺 `stores/`）
  - `tools/ad-scout/`：广告数据汇总
  - `tools/weekly-planner/`：周广告复盘优化（数据位于 `server/data/`）
  - `tools/sales-hub/`：销售采购与补货（数据位于 `server/data/`）
  - `tools/erp-workbench/`：库存销售分析（数据位于 `server/data/`）
  - `tools/product-hub/`：产品库
  - `tools/xydc-asin-analyzer/`：西柚竞品分析（数据位于 `server/data/`）
- `skills/` & `rules/`：Agent 技能规范与安全红线

## ROAS 配置持久化与同步
- Discover amzn 的 ROAS 预设、内置模板覆盖、最近配置和判定模板按店铺保存在 `tools/erp-workbench/server/data/roas/stores/`。
- 自动保存会写入仓库本地后端并排队进入 GitHub 同步；手动“备份”还会保留可恢复的 JSON 快照。
- ROAS 上传目录和 Excel 导出目录不纳入 Git，避免把原始广告数据推送到仓库。
