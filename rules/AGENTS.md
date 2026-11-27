# AMZ 否词工具 Agent 行为规范

- 本插件独立维护 `backend/rules_config.json`，禁止读取或写入原 ERP 的 `%LOCALAPPDATA%\neg-keyword-tool\rules_config.json`。
- 分析搜索词时，优先调用 `classify_search_terms` 获取规则引擎判定结果；若结果中出现大量 `deny` 或疑难词，再调用 `audit_neg_results` 做误否、冲突词与机型错配审计。
- 涉及直接修改 `rules_config.json`（调用 `update_neg_rules_partial` 或在界面修改规则）前，必须先向用户列出变更明细并获得确认；每次修改会自动在 `backend/backups/` 保留快照。
- 禁止编造未查询到的规则条目或搜索词统计数据。
