# -*- coding: utf-8 -*-
"""
亚马逊否词标注工具 - 后向兼容入口
===================================
原文件 (8560行) 已拆分为模块化结构：
  config.py       - 配置管理
  models.py       - 机型数据/同义词库
  normalization.py - 关键词标准化
  matching.py     - 机型匹配/模糊匹配（含 marketplace 路由 ↓）
  rules.py        - 默认规则配置
  tencent_api.py  - 腾讯云API调用
  serve.py        - HTTP服务端
  main.py         - 统一入口
  gui/            - GUI界面模块

此文件保留为兼容入口，直接导入 main 模块。

═══════════════════════════════════════════════════════════════════════════════
v3.1-rc 修复点
═══════════════════════════════════════════════════════════════════════════════
  Bug1: USA 站限制导致欧洲站跳过"无壳类词"否掉
        —— marketplace 路由下沉到 matching.py（USA_SITES / EU_MARKETPLACES 常量）。
           此入口透传 --site 与环境变量 NEG_MARKETPLACE 给匹配层，让 EU 站严格
           SKU 守卫（见 matching._kw_has_sku_type_token）能命中"裸 base 误配带
           case SKU" 的判定。

  Bug2: 第二级匹配缺后缀保护致裸 base 名错配
        —— normalization._keyword_matches_single_model 加 SKU_TYPE_SUFFIXES 守卫，
           prefix/contains 反向匹配必须两侧 SKU 后缀对齐。

调用约定：
  python neg_keyword_tool.py --site usa     # 美国站（默认）
  python neg_keyword_tool.py --site de      # 德国站
  NEG_MARKETPLACE=de python neg_keyword_tool.py   # 环境变量兼容
"""
import sys
import os

# 确保当前目录在模块搜索路径中
_backend_dir = os.path.dirname(os.path.abspath(__file__))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)


def _resolve_marketplace(argv):
    """从 CLI 参数或环境变量解析 marketplace。优先 --site，否则 ENV，否则默认 'usa'。"""
    site = "usa"
    # 命令行 --site <value>
    if argv and "--site" in argv:
        i = argv.index("--site")
        if i + 1 < len(argv):
            site = argv[i + 1].lower().strip()
    # 环境变量兜底
    env_site = os.environ.get("NEG_MARKETPLACE", "").lower().strip()
    if env_site:
        site = env_site
    return site


# 解析入口参数（一次性）
_MARKETPLACE = _resolve_marketplace(sys.argv[1:])
# 将 marketplace 通过环境变量透传给 matching 层（matching 内 marketplace 参数默认 None 时按 USA 处理，
# 这里显式落地使所有以该 shim 为入口的调用方都能感知 marketplace）
os.environ["NEG_MARKETPLACE"] = _MARKETPLACE

# 导入模块化入口
from main import main

if __name__ == '__main__':
    main()