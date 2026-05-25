"""后端共享状态与工具函数。"""
import json
from src.storage import load_graph, DATA_DIR

# 全局任务状态（跨路由共享）
task_status = {
    "classify": {"running": False, "progress": 0, "total": 0, "current": "", "result": None},
    "relations": {"running": False, "progress": 0, "total": 0, "current": "", "result": None},
    "update": {"running": False, "progress": 0, "total": 0, "current": "", "result": None, "phase": ""},
    "phases": {"running": False, "progress": 0, "total": 0, "current": "", "result": None},
}
