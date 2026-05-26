"""自动扫描调度器 —— 定时检测监控目录变化并自动执行增量更新。"""
import asyncio
import json
import time
import traceback
from pathlib import Path
from typing import Optional

from shared import task_status
from src.scanner import diff_folder
from src.storage import load_graph, apply_doc_diff, DATA_DIR
from src.llm_analyzer import analyze_all_docs, analyze_relations


# ========== 配置文件路径 ==========
CONFIG_PATH = DATA_DIR / "autoscan_config.json"
HISTORY_PATH = DATA_DIR / "autoscan_history.json"

# 默认配置
DEFAULT_CONFIG = {
    "enabled": False,
    "interval_minutes": 120,
    "watch_directories": [],
    "options": {"max_new_files_per_scan": 50, "analysis_mode": "fast"},
}


# ========== 配置持久化 ==========

def load_autoscan_config() -> dict:
    """加载自动扫描配置，文件不存在则返回默认配置。"""
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return DEFAULT_CONFIG.copy()


def save_autoscan_config(config: dict) -> None:
    """保存自动扫描配置到 JSON 文件。"""
    CONFIG_PATH.write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# ========== 扫描历史持久化 ==========

def load_scan_history() -> dict:
    """加载扫描历史记录。"""
    if HISTORY_PATH.exists():
        try:
            return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"scans": []}


def record_scan_result(result: dict) -> None:
    """记录一次扫描结果，最多保留 50 条记录。"""
    history = load_scan_history()
    scans = history.get("scans", [])
    # 新记录插到最前面
    scans.insert(0, result)
    # 最多保留 50 条
    history["scans"] = scans[:50]
    HISTORY_PATH.write_text(
        json.dumps(history, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# ========== 调度器核心 ==========

_scheduler_task: Optional[asyncio.Task] = None
_running = False


def _is_any_task_running() -> bool:
    """检查是否有手动任务正在运行。"""
    for key, status in task_status.items():
        if status.get("running"):
            return True
    return False


def _execute_scan(config: dict) -> None:
    """执行一次完整的自动扫描（同步函数，在线程中运行）。

    遍历所有监控目录，对每个目录执行 diff → apply → analyze 流程。
    """
    watch_dirs = config.get("watch_directories", [])
    options = config.get("options", {})
    max_new = options.get("max_new_files_per_scan", 50)
    analysis_mode = options.get("analysis_mode", "fast")

    scan_start = time.time()
    results = []
    total_added = 0
    total_modified = 0
    total_deleted = 0
    errors = []

    for entry in watch_dirs:
        graph_name = entry.get("graph_name", "")
        folder_path = entry.get("path", "")
        label = entry.get("label", folder_path)

        try:
            # 加载图谱
            graph = load_graph(graph_name)
            if not graph:
                errors.append(f"图谱不存在: {graph_name}")
                continue

            # 对比差异
            diff = diff_folder(folder_path, graph.get("docs", []))
            added = diff["added"]
            modified = diff["modified"]
            deleted_ids = diff["deleted_ids"]

            # 无变化则跳过
            if not added and not modified and not deleted_ids:
                results.append({
                    "graph_name": graph_name,
                    "label": label,
                    "status": "no_changes",
                })
                continue

            # 尊重最大新文件数限制
            if len(added) > max_new:
                added = added[:max_new]

            # 应用文档差量
            apply_doc_diff(
                graph_name,
                added=added,
                modified=modified,
                deleted_ids=deleted_ids,
                folder=folder_path,
            )

            # 统计
            total_added += len(added)
            total_modified += len(modified)
            total_deleted += len(deleted_ids)

            # 如果有新增/修改文档，执行 LLM 分析
            analyze_ids = [d["id"] for d in added] + [d["id"] for d in modified]
            if analyze_ids:
                analyze_all_docs(
                    graph_name,
                    mode=analysis_mode,
                    only_doc_ids=analyze_ids,
                )

            # 有任何变化都重推关系
            analyze_relations(graph_name, mode=analysis_mode)

            results.append({
                "graph_name": graph_name,
                "label": label,
                "status": "updated",
                "added": len(added),
                "modified": len(modified),
                "deleted": len(deleted_ids),
            })

        except Exception as e:
            error_msg = f"[{graph_name}] {str(e)}"
            errors.append(error_msg)
            traceback.print_exc()
            results.append({
                "graph_name": graph_name,
                "label": label,
                "status": "error",
                "error": str(e),
            })

    # 记录扫描结果
    scan_record = {
        "timestamp": time.time(),
        "duration_seconds": round(time.time() - scan_start, 1),
        "status": "complete",
        "total_added": total_added,
        "total_modified": total_modified,
        "total_deleted": total_deleted,
        "directories": results,
        "errors": errors,
        "read": False,
    }
    record_scan_result(scan_record)


async def _scan_loop() -> None:
    """异步调度循环：根据配置定期执行扫描。"""
    global _running
    _running = True

    while _running:
        try:
            config = load_autoscan_config()

            # 未启用时，每 30 秒检查一次配置变化
            if not config.get("enabled"):
                await asyncio.sleep(30)
                continue

            # 等待指定间隔
            interval = config.get("interval_minutes", 120) * 60
            await asyncio.sleep(interval)

            # 再次读取配置（可能在等待期间被修改）
            config = load_autoscan_config()
            if not config.get("enabled"):
                continue

            # 检查是否有手动任务正在运行
            if _is_any_task_running():
                record_scan_result({
                    "timestamp": time.time(),
                    "duration_seconds": 0,
                    "status": "skipped",
                    "reason": "有其他任务正在运行",
                    "read": False,
                })
                continue

            # 没有监控目录则跳过
            if not config.get("watch_directories"):
                continue

            # 在线程中执行扫描（避免阻塞事件循环）
            await asyncio.to_thread(_execute_scan, config)

        except asyncio.CancelledError:
            break
        except Exception:
            # 调度循环不能崩溃，打印错误后继续
            traceback.print_exc()
            await asyncio.sleep(60)

    _running = False


def start_scheduler() -> None:
    """启动自动扫描调度器。"""
    global _scheduler_task, _running

    if _scheduler_task and not _scheduler_task.done():
        return  # 已在运行

    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    _running = True
    _scheduler_task = loop.create_task(_scan_loop())


def stop_scheduler() -> None:
    """停止自动扫描调度器。"""
    global _scheduler_task, _running
    _running = False
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
    _scheduler_task = None


def restart_scheduler() -> None:
    """重启自动扫描调度器（配置更新后调用）。"""
    stop_scheduler()
    start_scheduler()
