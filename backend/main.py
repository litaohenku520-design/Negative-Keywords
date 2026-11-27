"""
main.py — Discover.exe 桌面应用入口 (v4.2.2-FINAL-PLUS)
打包: pyinstaller Discover.spec
本地: python main.py [--with-backends]

【v4.2.2 ERP 实时生效机制】
EXE 启动时优先扫描 exe 同目录的 erp_overrides/ 文件夹:
- launcher.html → 覆盖内置版本
- src/*.tsx → 覆盖前端源码
- dist/assets/* → 覆盖前端打包产物
- neg-keyword-backend/*.py → 覆盖后端 Python 模块
- neg-keyword-backend/rules_config.json → 覆盖否词规则
- .env.local → 覆盖环境变量

任何 ERP 修改只需放在 erp_overrides/ 对应路径,重启 EXE 即生效。
不修改 erp_overrides 则使用 EXE 内置默认 ERP。
"""
import sys
import os
import shutil
import threading
import time
import argparse
import webview

# PyInstaller onefile: sys._MEIPASS 是临时解压目录
# 开发模式: __file__ 所在目录的父目录的 launcher/
if getattr(sys, 'frozen', False):
    BUNDLE_DIR = sys._MEIPASS
    EXE_DIR = os.path.dirname(sys.executable)
    LAUNCHER_HTML = os.path.join(BUNDLE_DIR, "launcher", "launcher.html")
    ICON = os.path.join(BUNDLE_DIR, "launcher", "icon.ico")
else:
    BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))
    EXE_DIR = BUNDLE_DIR
    LAUNCHER_HTML = os.path.normpath(os.path.join(BUNDLE_DIR, "..", "launcher", "launcher.html"))
    ICON = os.path.normpath(os.path.join(BUNDLE_DIR, "..", "launcher", "icon.ico"))

sys.path.insert(0, BUNDLE_DIR)

# v4.2.2-FIX: Windows GBK 控制台无法编码 ✅/❌ 等 Unicode 字符,
# 强制 stdout 为 UTF-8 兜底,errors='replace' 避免 emoji 触发 UnicodeEncodeError.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _apply_erp_overrides():
    """v4.2.2 ERP 实时生效: 优先使用 exe 同目录 erp_overrides/ 下的文件"""
    overrides_dir = os.path.join(EXE_DIR, "erp_overrides")
    if not os.path.exists(overrides_dir):
        print(f"[Discover] 无 erp_overrides/ 目录 → 使用内置默认 ERP")
        return

    print(f"[Discover] 检测到 erp_overrides/ → 应用实时覆盖: {overrides_dir}")
    override_count = 0
    skip_ext = (".pyc", ".db", ".sqlite", ".sqlite3", ".log", ".tmp")
    for root, dirs, files in os.walk(overrides_dir):
        rel = os.path.relpath(root, overrides_dir)
        for fname in files:
            if fname.endswith(skip_ext):
                continue
            src = os.path.join(root, fname)
            dst = os.path.join(BUNDLE_DIR, rel, fname)
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                override_count += 1
                print(f"  [Override] {rel}/{fname}")
            except Exception as e:
                print(f"  [Override FAIL] {rel}/{fname}: {e}")
    print(f"[Discover] ERP overrides 应用完成 · {override_count} 个文件已覆盖")


def start_backends(base_dir: str):
    """拉起否词与 Amazon 集成后端（可选）。"""
    try:
        from integrated_backends import start_neg_backend, start_integration_backend
    except Exception as e:
        print(f"[Discover] integrated_backends 导入失败: {e}")
        return

    t1 = threading.Thread(target=start_neg_backend, args=(base_dir,), daemon=True)
    t1.start()
    time.sleep(0.3)
    t2 = threading.Thread(target=start_integration_backend, args=(base_dir,), daemon=True)
    t2.start()
    print(f"[Discover] NEG:19876 Integration:19888 已拉起 (base_dir={base_dir})")
    time.sleep(2)


def _resolve_launcher_html() -> str:
    """v4.2.2: 按优先级返回 launcher.html 路径
    1) exe 同目录 erp_overrides/launcher/launcher.html  (开发者覆盖)
    2) exe 同目录 launcher/launcher.html                 (高级用户覆盖)
    3) BUNDLE_DIR 内置 launcher.html                     (打包默认)
    4) 开发模式源码                                     (dev only)
    """
    if getattr(sys, 'frozen', False):
        # 1) erp_overrides/ 优先
        p = os.path.join(EXE_DIR, "erp_overrides", "launcher", "launcher.html")
        if os.path.exists(p):
            print(f"[Discover] launcher.html ← erp_overrides (ERP 实时生效)")
            return p
        # 2) exe 同目录
        p = os.path.join(EXE_DIR, "launcher", "launcher.html")
        if os.path.exists(p):
            print(f"[Discover] launcher.html ← exe 同目录覆盖")
            return p
        # 3) BUNDLE_DIR 内置
        p = os.path.join(BUNDLE_DIR, "launcher", "launcher.html")
        if os.path.exists(p):
            print(f"[Discover] launcher.html ← 内置打包版本")
            return p
        # 4) fallback: 在 BUNDLE_DIR 找任何 launcher.html
        for root, dirs, files in os.walk(BUNDLE_DIR):
            for f in files:
                if f == 'launcher.html':
                    return os.path.join(root, f)
        return None
    else:
        # 开发模式: 优先项目根目录源码
        p = os.path.normpath(os.path.join(BUNDLE_DIR, "..", "launcher", "launcher.html"))
        if os.path.exists(p):
            print(f"[Discover] launcher.html ← 开发模式源码")
            return p
        return os.path.join(BUNDLE_DIR, "launcher", "launcher.html")


def create_window():
    src = _resolve_launcher_html()
    print(f"[Discover] LAUNCHER_HTML = {src}")
    print(f"[Discover] exists = {os.path.exists(src) if src else False}")

    if src and os.path.exists(src):
        with open(src, encoding='utf-8') as f:
            html_content = f.read()
    else:
        html_content = "<h1>Discover.exe — launcher.html not found</h1>"

    window = webview.create_window(
        title="AMZ 探险者 Discover",
        html=html_content,
        width=1280,
        height=820,
        resizable=True,
        easy_drag=True,
        confirm_close=True,
    )
    return window


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-dir", default=None, help="项目根目录")
    parser.add_argument("--with-backends", action="store_true",
                        help="同时拉起否词与 Amazon 集成后端（默认不启）")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    base_dir = args.base_dir or (os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else BUNDLE_DIR)

    print(f"[Discover] 启动 v4.2.2-FINAL-PLUS — Base {base_dir}")
    print(f"[Discover] Python {sys.version.split()[0]}")
    print(f"[Discover] 后端模式: {'WITH backends' if args.with_backends else 'NO backends (manual start needed)'}")

    # v4.2.2 ERP 实时生效: 优先应用 erp_overrides/
    _apply_erp_overrides()

    if args.with_backends:
        start_backends(base_dir)

    window = create_window()
    webview.start(debug=args.debug, http_port=None)


def _auto_start_all_backends():
    """v4.2.2-FIX: 在独立线程中自动拉起 launcher_server 与冻结安全后端。
    该函数被线程包装,立即返回,不阻塞 main() 的 webview.start()。
    """
    if not getattr(sys, 'frozen', False):
        return
    print("[Discover] 后台线程: 启动 launcher_server 与核心后端…")
    try:
        from launcher import launcher_server as _ls
        _ls.run_server_in_thread(18800)
        print("[Discover] launcher_server 已自动拉起 (port 18800)")
    except Exception as e:
        print(f"[Discover] launcher_server 自动拉起失败: {e}")
        return  # launcher_server 没起来就不要继续

    auto_services = ["neg", "erpSettings", "browserEngine"]
    print(f"[Discover] 自动启动 frozen-safe 后端: {auto_services}")
    for key in auto_services:
        try:
            t0 = time.time()
            result = _ls.start_service(key)
            dt = time.time() - t0
            status = "[OK]" if result.get("ok") else "[FAIL]"
            msg = result.get("message", result.get("error", "unknown"))
            print(f"  {status} {key}: {msg} ({dt:.1f}s)")
        except Exception as e:
            print(f"  [FAIL] {key}: {e}")
    print("[Discover] 自动启动完成 (dev/prod 需 npm,frozen 模式跳过)")


def _start_launcher_server_in_thread():
    """v4.2.2-FIX: 包装 _auto_start_all_backends() 到独立线程,立即返回。
    修复 v4.2.2-PRE-FIX 的"启动器卡住"bug: 旧版同步调用 _auto_start 4 个后端,
    每个 start_service 等 _wait_port timeout=10s,最坏 40 秒后才进 webview.start()。
    现版本立即返回,UI 立刻出现,后端在后台异步启动。
    """
    _t = threading.Thread(target=_auto_start_all_backends, daemon=True, name="auto-start")
    _t.start()


if __name__ == "__main__":
    _start_launcher_server_in_thread()
    main()
