"""后端共享状态与工具函数。"""
import json
import threading
from src.storage import load_graph, DATA_DIR

# 线程锁：保护 task_status 的并发读写（BackgroundTasks 在独立线程中执行）
task_lock = threading.Lock()

# 全局任务状态（跨路由共享）
task_status = {
    "classify": {"running": False, "progress": 0, "total": 0, "current": "", "result": None},
    "relations": {"running": False, "progress": 0, "total": 0, "current": "", "result": None},
    "update": {"running": False, "progress": 0, "total": 0, "current": "", "result": None, "phase": ""},
    "phases": {"running": False, "progress": 0, "total": 0, "current": "", "result": None},
    "embedding": {"running": False, "result": None},
}
