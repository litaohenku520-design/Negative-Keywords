---
name: neg-keyword-ops
description: >-
  亚马逊广告否词工具操作与审计 SOP。在用户要求打开否词工作台、批量分类搜索词、
  排查误否高价值词/冲突词/机型错配，或查询/更新 rules_config.json 规则库时使用。
---

# AMZ 否词工具操作 SOP

## 1. 可用工具与工作台模块
- `open_neg_workbench`：在侧边栏或全局打开 Discover amzn 亚马逊运营工作台（内置否词助手、ASIN智能否定与文件夹导出、搜索词劣词优化等模块）。
- `classify_search_terms`：批量执行搜索词分类（`deny` / `keep` / `review`）。
- `audit_neg_results`：对分类结果运行 `neg_audit_engine` 深度审计（检测冲突词、误否高价值词、机型错配、漏否垃圾词）。
- `get_neg_rules_summary` / `query_neg_rules`：查询独立维护的 `backend/rules_config.json`。
- `update_neg_rules_partial`：受控更新 `rules_config.json`（自动备份到 `backend/backups/`）。

## 2. ASIN 智能自动判定工作流 (西柚 MCP 联动)
1. **报表导入**：在「否词助手」面板切换至「🧩 ASIN否定」Tab，点击「⚡ 导入报表自动判定ASIN」选择原始广告搜索词报表（.xlsx / .csv）。
2. **西柚 MCP 穿透**：系统自动调用西柚 MCP `get_asin_info` 批量拉取商品详情标题、五点描述与 Amazon 链接。
3. **智能机型判定**：
   - 过滤手机本体（如 256GB/50MP 裸机）与纯屏幕保护膜（实际类型不匹配，判定否定）；
   - 兼容性比对：支持目标机型精准比对与通用规则（如 Moto G 2026 系列多型号通用保留、iPhone 17/18 Pro Max 通用保留）；
   - 五点回退：无标题商品自动回退至兼容性五点描述进行识别。
4. **一键导出文件夹**：
   - 点击「📁 导出判定文件夹」：自动在本地 `C:\Users\admin\AMZ\` 生成以站点和时间戳命名的完整结果文件夹，内置完整 32 列判定明细 Excel（带表头样式与判定结果高亮）及 Amazon 官方否商品定向上传模板，并可在 Windows 资源管理器中一键打开。
   - 点击「📊 导出完整判定Excel」/「⚡ 导出Amazon否ASIN模板」：支持单独下载单份表格。

## 3. 推荐工作流
1. **打开工作台或批量分析**：如果用户需要上传 Excel/CSV 报表或可视化操作，调用 `open_neg_workbench`。如果用户直接在对话中粘贴了搜索词和广告活动名，先调用 `classify_search_terms`。
2. **误否审计**：对关键活动或高花费词，调用 `audit_neg_results` 检查是否存在品牌词反咬、同款通用机型（如 `16e/17e`、`A17/A26`）误否或缩写错配。
3. **规则变更**：确认需要补充白名单（`keep_case_words`）、否定品牌（`deny_brands`）或活动映射（`campaign_group_map`）时，先向用户展示拟修改内容，确认后再调用 `update_neg_rules_partial`。
