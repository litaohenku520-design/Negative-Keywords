---
name: neg-keyword-ops
description: >-
  亚马逊广告否词工具操作与审计 SOP。在用户要求打开否词工作台、批量分类搜索词、
  排查误否高价值词/冲突词/机型错配，或查询/更新 rules_config.json 规则库时使用。
---

# AMZ 否词工具操作 SOP

## 1. 可用工具
- `open_neg_workbench`：在侧边栏或全局打开否词工具交互工作台（完整保留原 ERP 否词 UI）。
- `classify_search_terms`：批量执行搜索词分类（`deny` / `keep` / `review`）。
- `audit_neg_results`：对分类结果运行 `neg_audit_engine` 深度审计（检测冲突词、误否高价值词、机型错配、漏否垃圾词）。
- `get_neg_rules_summary` / `query_neg_rules`：查询独立维护的 `backend/rules_config.json`。
- `update_neg_rules_partial`：受控更新 `rules_config.json`（自动备份到 `backend/backups/`）。

## 2. 推荐工作流
1. **打开工作台或批量分析**：如果用户需要上传 Excel/CSV 报表或可视化操作，调用 `open_neg_workbench`。如果用户直接在对话中粘贴了搜索词和广告活动名，先调用 `classify_search_terms`。
2. **误否审计**：对关键活动或高花费词，调用 `audit_neg_results` 检查是否存在品牌词反咬、同款通用机型（如 `16e/17e`、`A17/A26`）误否或缩写错配。
3. **规则变更**：确认需要补充白名单（`keep_case_words`）、否定品牌（`deny_brands`）或活动映射（`campaign_group_map`）时，先向用户展示拟修改内容，确认后再调用 `update_neg_rules_partial`。
