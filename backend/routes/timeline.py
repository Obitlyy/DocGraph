"""时间线视图 API 路由。"""
import time
from datetime import datetime, timedelta
from collections import defaultdict
from fastapi import APIRouter, HTTPException
from src.storage import load_graph

router = APIRouter(prefix="/api", tags=["timeline"])


def _get_month_bounds(dt: datetime) -> tuple[int, int, str]:
    """获取某月的起止时间戳和标签。"""
    start = datetime(dt.year, dt.month, 1)
    # 下个月第一天
    if dt.month == 12:
        end = datetime(dt.year + 1, 1, 1)
    else:
        end = datetime(dt.year, dt.month + 1, 1)
    label = f"{dt.year}年{dt.month}月"
    return int(start.timestamp()), int(end.timestamp()) - 1, label


def _get_week_bounds(dt: datetime) -> tuple[int, int, str]:
    """获取某周的起止时间戳和标签（ISO 周）。"""
    # 获取本周一
    monday = dt - timedelta(days=dt.weekday())
    monday = datetime(monday.year, monday.month, monday.day)
    sunday = monday + timedelta(days=7)
    iso_year, iso_week, _ = dt.isocalendar()
    label = f"{iso_year}年第{iso_week}周"
    return int(monday.timestamp()), int(sunday.timestamp()) - 1, label


def _get_day_bounds(dt: datetime) -> tuple[int, int, str]:
    """获取某天的起止时间戳和标签。"""
    start = datetime(dt.year, dt.month, dt.day)
    end = start + timedelta(days=1)
    label = f"{dt.year}年{dt.month}月{dt.day}日"
    return int(start.timestamp()), int(end.timestamp()) - 1, label


def _group_key(mtime: float, group_by: str) -> tuple[int, int, str]:
    """根据分组方式返回 (start_ts, end_ts, label)。"""
    dt = datetime.fromtimestamp(mtime)
    if group_by == "week":
        return _get_week_bounds(dt)
    elif group_by == "day":
        return _get_day_bounds(dt)
    else:
        # 默认按月
        return _get_month_bounds(dt)


@router.get("/graphs/{name}/timeline")
def api_graph_timeline(name: str, group_by: str = "month"):
    """返回文档的时间线数据，按月/周/日分组。

    group_by: "month" | "week" | "day"
    """
    # 参数校验
    if group_by not in ("month", "week", "day"):
        raise HTTPException(400, f"不支持的分组方式: {group_by}，可选: month, week, day")

    data = load_graph(name)
    if not data:
        raise HTTPException(404, f"图谱不存在: {name}")

    docs = data.get("docs", [])

    # 过滤出有 mtime 的文档
    docs_with_mtime = [d for d in docs if d.get("mtime")]
    if not docs_with_mtime:
        return {
            "timeline": [],
            "total_docs": 0,
            "date_range": {"earliest": None, "latest": None},
        }

    # 按时间分组
    groups: dict[tuple[int, int, str], list[dict]] = defaultdict(list)
    for doc in docs_with_mtime:
        key = _group_key(doc["mtime"], group_by)
        groups[key].append(doc)

    # 构建时间线，按 start_ts 排序（从旧到新）
    timeline = []
    for (start_ts, end_ts, label), group_docs in sorted(groups.items(), key=lambda x: x[0]):
        # 统计该时段内各分类的数量
        categories: dict[str, int] = defaultdict(int)
        doc_items = []
        for d in group_docs:
            cat = d.get("category", "未分类")
            categories[cat] += 1
            doc_items.append({
                "id": d["id"],
                "name": d["name"],
                "category": cat,
                "mtime": d["mtime"],
            })

        # 文档按 mtime 排序
        doc_items.sort(key=lambda x: x["mtime"])

        timeline.append({
            "period": label,
            "start_ts": start_ts,
            "end_ts": end_ts,
            "doc_count": len(group_docs),
            "docs": doc_items,
            "categories": dict(categories),
        })

    # 计算日期范围
    all_mtimes = [d["mtime"] for d in docs_with_mtime]
    earliest_dt = datetime.fromtimestamp(min(all_mtimes))
    latest_dt = datetime.fromtimestamp(max(all_mtimes))

    return {
        "timeline": timeline,
        "total_docs": len(docs_with_mtime),
        "date_range": {
            "earliest": earliest_dt.strftime("%Y-%m-%d"),
            "latest": latest_dt.strftime("%Y-%m-%d"),
        },
    }


@router.get("/graphs/{name}/weekly-summary")
def api_weekly_summary(name: str):
    """生成最近一周的文档活动摘要。"""
    data = load_graph(name)
    if not data:
        raise HTTPException(404, f"图谱不存在: {name}")

    docs = data.get("docs", [])
    now = time.time()
    seven_days_ago = now - 7 * 24 * 3600

    # 筛选最近 7 天内修改的文档
    recent_docs = [d for d in docs if d.get("mtime") and d["mtime"] >= seven_days_ago]

    # 按 mtime 降序排列
    recent_docs.sort(key=lambda d: d["mtime"], reverse=True)

    # 统计分类分布
    categories: dict[str, int] = defaultdict(int)
    doc_items = []
    for d in recent_docs:
        cat = d.get("category", "未分类")
        categories[cat] += 1
        doc_items.append({
            "id": d["id"],
            "name": d["name"],
            "category": cat,
            "mtime": d["mtime"],
            "size": d.get("size", 0),
        })

    # 生成摘要文本
    doc_count = len(recent_docs)
    if doc_count == 0:
        summary_text = "本周没有新增或修改的文档。"
    else:
        # 按数量降序取前几个分类描述
        sorted_cats = sorted(categories.items(), key=lambda x: x[1], reverse=True)
        cat_desc = "和".join(
            f"「{cat}」({count}篇)" for cat, count in sorted_cats[:3]
        )
        summary_text = f"本周新增/修改 {doc_count} 篇文档，主要集中在{cat_desc}分类。"

    # 计算时间范围标签
    start_date = datetime.fromtimestamp(seven_days_ago).strftime("%Y-%m-%d")
    end_date = datetime.fromtimestamp(now).strftime("%Y-%m-%d")

    return {
        "period": f"{start_date} ~ {end_date}",
        "doc_count": doc_count,
        "docs": doc_items,
        "categories": dict(categories),
        "summary_text": summary_text,
    }
