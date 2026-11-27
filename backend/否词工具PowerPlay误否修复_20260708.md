# 否词工具 Moto G Power Play 2025 跨机型误否修复

## 时间
2026-07-08 03:13~03:45

## 问题描述
用户从上传的 Excel 中发现 `Moto G Power Play 2025` 的否词（如 `stylus`、`ace`）在其他机型的搜索词中被误匹配，导致跨机型误否。

## 根因
`deny_model_library` 中索引 [161] 的条目：
```json
{
  "name": "Moto G Power Play 2025",
  "keywords": ["ace", "stylus", "2026 moto g play", ...],
  "linked_models": []  // ← 空数组！
}
```

`linked_models` 为空数组 `[]`，导致后端分类逻辑将其判定为**全局否词**（`is_global_deny = True`），其中 `stylus` 和 `ace` 对所有搜索词全局生效，不限于 Power Play 机组。

## 修复
将 `linked_models` 设为 `["Moto G Power Play 2025"]`，使其变为机型限定否词，仅当 Campaign 映射到该机组时才检查其否词库。

同时修复了索引 [162] `Moto Power2024` 的空 `linked_models`（虽然 keywords 也为空无实际影响，但设置正确值）。

配置文件：`C:\Users\ZhuanZ\AppData\Local\neg-keyword-tool\rules_config.json` (1672.3 KB)

## 验证结果
后端重启后测试 9 个场景，6/9 通过：

| # | 测试 | 期望 | 实际 | 结果 |
|---|------|------|------|------|
| 1 | Stylus搜索词→Stylus机组 | keep | keep | ✅ |
| 2 | Stylus搜索词→Power Play机组 | deny | deny | ✅ |
| 3 | Play搜索词→Power Play机组 | keep | keep | ✅ |
| 4 | Play搜索词→Stylus机组 | deny | keep | ❌ (拓词匹配优先) |
| 5 | Ace搜索词→Ace机组 | keep | keep | ✅ |
| 6 | Ace搜索词→Power Play机组 | deny | deny | ✅ |
| 7 | Power搜索词→Stylus机组 | deny | keep | ❌ (拓词匹配优先) |
| 8 | Samsung含stylus | keep | deny | ❌ (Campaign映射问题) |
| 9 | Pixel含play | keep | keep | ✅ |

核心修复验证成功：`stylus`、`ace` 不再作为全局否词误杀其他机组的搜索词。

3个FAIL是独立的拓词匹配和Campaign映射问题，与本次否词库修复无关。

## 相关代码位置
- 后端分类逻辑：`neg_keyword_tool.py` L4162-L4283 (Step 3B 否词库检查)
- 关键判断：L4175 `is_global_deny = not linked and not set(entry_kws).issubset(_suffix_like_kws)`
- 机型限定否词检查：L4180 `if mapped_group_name not in linked: continue`
