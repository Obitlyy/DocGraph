"""全量扫描模块 - 扫描整台电脑的文件,自动聚合成有意义的分组

设计:
1. list_subdirs: 列出某个根目录下的子目录(让用户选择扫描范围)
2. quick_scan: 快速扫描(只读 metadata,不解析文件内容)
3. pre_cluster: 算法预聚合(按目录/前缀/时间)
4. llm_review_clusters: LLM 重审,给组起名/评分/调整粒度
5. full_scan_workflow: 完整流程
"""
import os
import re
import time
import json
import math
from pathlib import Path
from collections import defaultdict, Counter
from typing import Optional

from src.llm_client import chat


# 扫描时跳过的目录
IGNORE_DIRS = {
    "node_modules", "__pycache__", ".git", ".idea", ".vscode",
    "venv", ".venv", "env", "dist", "build", ".next", ".nuxt",
    ".cache", "Library", ".Trash", ".DS_Store", "Pods",
    "target", ".gradle", ".mvn", "vendor", "tmp", ".tmp",
}

# 扫描时跳过的隐藏目录前缀(除了用户主目录里的 . 文件夹)
IGNORE_HIDDEN = True

# 文件大小上限(>100MB 的文件不进 metadata)
MAX_FILE_SIZE = 100 * 1024 * 1024

# 文档/媒体扩展名(用于聚合的"文件类型多样性")
DOC_EXTS = {".md", ".txt", ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".csv", ".rtf", ".epub"}
CODE_EXTS = {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".swift", ".kt", ".rb", ".php", ".c", ".cpp", ".h"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".heic", ".svg"}
MEDIA_EXTS = {".mp4", ".mov", ".avi", ".mp3", ".wav", ".m4a", ".flac"}
ARCHIVE_EXTS = {".zip", ".tar", ".gz", ".rar", ".7z", ".dmg", ".pkg"}


def list_subdirs(root: str, max_depth: int = 1) -> dict:
    """列出某个根目录下的子目录及粗略统计

    返回:
        {
            "root": "/Users/xxx/Desktop",
            "exists": True,
            "subdirs": [
                {"name": "DocGraph", "path": "/Users/xxx/Desktop/DocGraph",
                 "file_count": 287, "total_bytes": 12345678, "is_dir": True},
                ...
            ],
            "loose_files": [{"name": "xxx.png", "path": "...", "size": 1234}, ...]  # 根目录下的散文件
        }
    """
    root_path = Path(root).expanduser().resolve()
    if not root_path.exists() or not root_path.is_dir():
        return {"root": str(root_path), "exists": False, "subdirs": [], "loose_files": []}

    subdirs = []
    loose_files = []

    try:
        for entry in root_path.iterdir():
            try:
                if entry.name.startswith(".") and IGNORE_HIDDEN:
                    continue
                if entry.name in IGNORE_DIRS:
                    continue

                if entry.is_dir():
                    file_count, total_bytes = _count_dir(entry, max_depth=3)
                    subdirs.append({
                        "name": entry.name,
                        "path": str(entry),
                        "file_count": file_count,
                        "total_bytes": total_bytes,
                        "is_dir": True,
                    })
                elif entry.is_file():
                    try:
                        stat = entry.stat()
                        loose_files.append({
                            "name": entry.name,
                            "path": str(entry),
                            "size": stat.st_size,
                            "mtime": stat.st_mtime,
                        })
                    except OSError:
                        pass
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError):
        pass

    # 按文件数倒序
    subdirs.sort(key=lambda x: x["file_count"], reverse=True)
    loose_files.sort(key=lambda x: x["mtime"], reverse=True)

    return {
        "root": str(root_path),
        "exists": True,
        "subdirs": subdirs,
        "loose_files": loose_files,
    }


def _count_dir(path: Path, max_depth: int = 3, _depth: int = 0) -> tuple[int, int]:
    """递归统计目录下的文件数和总字节数(带深度限制,防止扫太久)"""
    if _depth > max_depth:
        return 0, 0
    file_count = 0
    total_bytes = 0
    try:
        for entry in path.iterdir():
            try:
                if entry.name.startswith(".") or entry.name in IGNORE_DIRS:
                    continue
                if entry.is_file():
                    try:
                        size = entry.stat().st_size
                        if size <= MAX_FILE_SIZE:
                            file_count += 1
                            total_bytes += size
                    except OSError:
                        continue
                elif entry.is_dir():
                    fc, tb = _count_dir(entry, max_depth, _depth + 1)
                    file_count += fc
                    total_bytes += tb
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError):
        pass
    return file_count, total_bytes


def quick_scan(paths: list[str], on_progress=None) -> list[dict]:
    """快速扫描指定路径(只取元数据,不读内容)

    Args:
        paths: 文件夹路径列表
        on_progress: 回调 (current_path, scanned_count) -> None

    Returns:
        files: [{"path", "name", "ext", "size", "mtime", "rel_dir", "scan_root"}]
    """
    files = []
    scanned = 0
    for root_str in paths:
        root = Path(root_str).expanduser().resolve()
        if not root.exists():
            continue
        if root.is_file():
            try:
                stat = root.stat()
                files.append({
                    "path": str(root),
                    "name": root.name,
                    "ext": root.suffix.lower(),
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                    "rel_dir": "",
                    "scan_root": str(root.parent),
                })
                scanned += 1
            except OSError:
                pass
            continue

        for dirpath, dirnames, filenames in os.walk(root):
            # 原地修改 dirnames 来跳过 IGNORE 目录
            dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and not d.startswith(".")]

            dp = Path(dirpath)
            try:
                rel_dir = str(dp.relative_to(root))
            except ValueError:
                rel_dir = ""

            for fname in filenames:
                if fname.startswith("."):
                    continue
                fpath = dp / fname
                try:
                    stat = fpath.stat()
                    if stat.st_size > MAX_FILE_SIZE:
                        continue
                    files.append({
                        "path": str(fpath),
                        "name": fname,
                        "ext": fpath.suffix.lower(),
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                        "rel_dir": rel_dir if rel_dir != "." else "",
                        "scan_root": str(root),
                    })
                    scanned += 1
                    if on_progress and scanned % 100 == 0:
                        on_progress(str(fpath), scanned)
                except (OSError, PermissionError):
                    continue

    if on_progress:
        on_progress("done", scanned)
    return files


def _ext_kind(ext: str) -> str:
    """归类扩展名"""
    if ext in DOC_EXTS:
        return "doc"
    if ext in CODE_EXTS:
        return "code"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in MEDIA_EXTS:
        return "media"
    if ext in ARCHIVE_EXTS:
        return "archive"
    return "other"


# 文件名 prefix 模式(截屏、IMG_、Snipaste_、屏幕截图等)
PREFIX_PATTERNS = [
    re.compile(r"^(截屏|截图|屏幕截图|Screenshot|Screen Shot|Snipaste|IMG[_-]|DSC[_-]|VID[_-]|PXL[_-]|WechatIMG)", re.IGNORECASE),
]


def _extract_prefix(name: str) -> Optional[str]:
    """提取文件名的常见 prefix(用于聚合截屏类)"""
    for pat in PREFIX_PATTERNS:
        m = pat.match(name)
        if m:
            return m.group(1).rstrip("_-").lower()
    return None


DRILL_DOWN_THRESHOLD = 30          # 项目总文件数 ≥ 该值才考虑下钻
DRILL_DOWN_MIN_SUBDIRS = 2         # 下钻后至少 N 个子目录才从后不变
DRILL_DOWN_MIN_SUB_FILES = 5       # 有效子目录需≥5个文件


def _try_drill_down(top_files: list[dict]) -> tuple[bool, list[tuple[str, list[dict]]]]:
    """决定是否对某个项目目录下钻一层

    返回:
        (should_drill, sub_groups)
        sub_groups: [(sub_label, sub_files), ...]
    """
    if len(top_files) < DRILL_DOWN_THRESHOLD:
        return False, []

    # 抽取 rel_dir 的第二段(第一段是顶层本身)
    by_sub = defaultdict(list)
    direct_files = []  # 没有子目录的文件
    for f in top_files:
        parts = f["rel_dir"].split(os.sep)
        if len(parts) >= 2 and parts[1]:
            by_sub[parts[1]].append(f)
        else:
            direct_files.append(f)

    # 统计有效子目录(文件数 ≥ DRILL_DOWN_MIN_SUB_FILES)
    valid_subs = [(name, files) for name, files in by_sub.items() if len(files) >= DRILL_DOWN_MIN_SUB_FILES]

    if len(valid_subs) < DRILL_DOWN_MIN_SUBDIRS:
        return False, []

    # 按文件数降序
    valid_subs.sort(key=lambda x: -len(x[1]))
    sub_groups = list(valid_subs)

    # 小子目录合并到 "其他"
    small_subs = [(name, files) for name, files in by_sub.items() if len(files) < DRILL_DOWN_MIN_SUB_FILES]
    other_files = direct_files + [f for _, files in small_subs for f in files]
    if other_files:
        sub_groups.append(("其他", other_files))

    return True, sub_groups


def pre_cluster(files: list[dict]) -> list[dict]:
    """算法预聚合:基于目录 + 文件名 prefix + 临时文件特征

    返回的候选组按以下规则生成:
    1. 每个 scan_root 下的"顶层目录"作为 project 组(含其下全部文件)
    2. 散落在 scan_root 根上的相同 prefix 文件 → pattern 组
    3. 散落在 scan_root 根上、按扩展名归类的剩余文件 → orphan 组(按文件类型分)
    """
    clusters = []
    cluster_id = 0

    # 按 scan_root 分桶
    by_root = defaultdict(list)
    for f in files:
        by_root[f["scan_root"]].append(f)

    for scan_root, root_files in by_root.items():
        scan_root_name = Path(scan_root).name or scan_root

        # 把文件按“顶层目录”分组（rel_dir 的第一段）
        by_top = defaultdict(list)
        loose = []
        for f in root_files:
            if f["rel_dir"]:
                top = f["rel_dir"].split(os.sep)[0]
                by_top[top].append(f)
            else:
                loose.append(f)

        # 判断是否将整个 scan_root 作为“父群”，顶层目录作为子群
        # 条件：scan_root 总文件 ≥ DRILL_DOWN_THRESHOLD 且有 ≥ DRILL_DOWN_MIN_SUBDIRS 个有效顶层目录
        valid_tops = [(name, fs) for name, fs in by_top.items() if len(fs) >= DRILL_DOWN_MIN_SUB_FILES]
        scan_root_drill = (
            len(root_files) >= DRILL_DOWN_THRESHOLD
            and len(valid_tops) >= DRILL_DOWN_MIN_SUBDIRS
        )

        if scan_root_drill:
            # scan_root 作为父群
            cluster_id += 1
            scan_root_id = f"c{cluster_id}"
            clusters.append({
                "id": scan_root_id,
                "kind": "project",
                "label": scan_root_name,
                "root_path": scan_root,
                "scan_root": scan_root,
                "files": root_files,
                "parent_id": None,
                "child_ids": [],
            })
            scan_root_index = len(clusters) - 1
        else:
            scan_root_id = None

        # 顶层目录 → project 组（如果 scan_root 下钻，他们就是子群；否则是顶级群）
        for top, top_files in by_top.items():
            cluster_id += 1
            top_id = f"c{cluster_id}"
            top_path = str(Path(scan_root) / top)

            # 只有在 scan_root 未下钻时才考虑顶层目录自己下钻
            should_drill = False
            sub_groups: list = []
            if not scan_root_drill:
                should_drill, sub_groups = _try_drill_down(top_files)

            if should_drill:
                clusters.append({
                    "id": top_id,
                    "kind": "project",
                    "label": top,
                    "root_path": top_path,
                    "scan_root": scan_root,
                    "files": top_files,
                    "parent_id": None,
                    "child_ids": [],
                })
                top_index = len(clusters) - 1
                for sub_label, sub_files in sub_groups:
                    cluster_id += 1
                    child_id = f"c{cluster_id}"
                    clusters.append({
                        "id": child_id,
                        "kind": "project",
                        "label": sub_label,
                        "root_path": str(Path(top_path) / sub_label) if sub_label != "其他" else top_path,
                        "scan_root": scan_root,
                        "files": sub_files,
                        "parent_id": top_id,
                        "child_ids": [],
                    })
                    clusters[top_index]["child_ids"].append(child_id)
            else:
                clusters.append({
                    "id": top_id,
                    "kind": "project",
                    "label": top,
                    "root_path": top_path,
                    "scan_root": scan_root,
                    "files": top_files,
                    "parent_id": scan_root_id,  # 如果 scan_root 是父，这里赋值
                    "child_ids": [],
                })
                if scan_root_drill and scan_root_id:
                    clusters[scan_root_index]["child_ids"].append(top_id)

        # 2) 散落文件按 prefix 分组
        by_prefix = defaultdict(list)
        no_prefix = []
        for f in loose:
            p = _extract_prefix(f["name"])
            if p:
                by_prefix[p].append(f)
            else:
                no_prefix.append(f)

        for prefix, pfiles in by_prefix.items():
            if len(pfiles) >= 3:
                cluster_id += 1
                clusters.append({
                    "id": f"c{cluster_id}",
                    "kind": "pattern",
                    "label": f"{prefix} 系列",
                    "root_path": scan_root,
                    "scan_root": scan_root,
                    "files": pfiles,
                    "parent_id": None,
                    "child_ids": [],
                })
            else:
                no_prefix.extend(pfiles)

        # 3) 剩余散文件按 ext_kind 归类
        by_kind = defaultdict(list)
        for f in no_prefix:
            by_kind[_ext_kind(f["ext"])].append(f)

        for kind, kfiles in by_kind.items():
            if not kfiles:
                continue
            if len(kfiles) >= 2:
                cluster_id += 1
                clusters.append({
                    "id": f"c{cluster_id}",
                    "kind": "orphan",
                    "label": f"散落 {_kind_label(kind)}",
                    "root_path": scan_root,
                    "scan_root": scan_root,
                    "files": kfiles,
                    "parent_id": None,
                    "child_ids": [],
                })
            else:
                # 单文件也保留为独立项
                cluster_id += 1
                clusters.append({
                    "id": f"c{cluster_id}",
                    "kind": "orphan",
                    "label": kfiles[0]["name"],
                    "root_path": scan_root,
                    "scan_root": scan_root,
                    "files": kfiles,
                    "parent_id": None,
                    "child_ids": [],
                })

    # 计算每组的统计字段
    for c in clusters:
        c["file_count"] = len(c["files"])
        c["total_bytes"] = sum(f["size"] for f in c["files"])
        c["ext_distribution"] = dict(Counter(f["ext"] for f in c["files"]).most_common(10))

    return clusters


def _kind_label(kind: str) -> str:
    return {
        "doc": "文档", "code": "代码", "image": "图片",
        "media": "音视频", "archive": "压缩包", "other": "其他",
    }.get(kind, "其他")


def compute_info_score(cluster: dict, llm_score: Optional[float] = None) -> float:
    """信息量评分 1-100:用于圆圈大小

    算法分:文件数 × log(总字节) × 类型多样性
    LLM 分:语义价值(直接覆盖)

    最终用 0.4 * algo + 0.6 * llm(如果有 LLM 分),否则全部用 algo
    """
    fc = cluster["file_count"]
    tb = cluster["total_bytes"]
    diversity = len(cluster.get("ext_distribution", {}))

    # 算法分(归一到 1-100)
    raw = math.log(fc + 1) * (1 + math.log(tb + 1) / 20) * (1 + diversity / 5)
    algo = min(100, raw * 8)

    if llm_score is not None:
        return 0.4 * algo + 0.6 * llm_score
    return algo


# ============ LLM 重审 ============

LLM_REVIEW_PROMPT = """你是文件聚合专家。下面是用户电脑上的预聚合候选组(已按目录/文件名特征自动分好)。请你对每组:
1. 给一个**更人性化的中文标签**(label,<10 字,比如"达人研究项目" 而不是 "0430_达人研究")
2. 判断**类型**(kind):
   - project: 一个完整项目/课题
   - notebook: 笔记/参考资料合集
   - album: 截图/照片合集
   - cache: 临时/缓存/Office 残留(~$xxx 等)
   - mixed: 混杂内容
3. **信息量评分**(info_score, 1-100):
   - 项目代码/研究文档:60-100
   - 笔记/资料:40-70
   - 截图集合:20-40
   - 临时缓存/重复:1-10
4. **是否冗余**(redundant: bool):临时文件、Office 残留等设 true
5. (可选)**拆分建议**(split_hint):如果某组内容混杂明显,给出拆分关键词列表

输入候选组列表(JSON):
{clusters_json}

输出严格 JSON:
```json
[
  {{"id": "c1", "label": "...", "kind": "...", "info_score": 75, "redundant": false, "split_hint": []}},
  ...
]
```
"""


def llm_review_clusters(clusters: list[dict], model: str = "deepseek-v4-flash") -> dict:
    """让 LLM 重审聚合结果

    Returns:
        {cluster_id: {label, kind, info_score, redundant, split_hint}}
    """
    if not clusters:
        return {}

    # 给 LLM 看的简化版(不发完整文件列表,太长)
    simplified = []
    for c in clusters:
        sample_files = [f["name"] for f in c["files"][:8]]
        simplified.append({
            "id": c["id"],
            "current_label": c["label"],
            "current_kind": c["kind"],
            "root_path": c["root_path"],
            "file_count": c["file_count"],
            "total_mb": round(c["total_bytes"] / 1024 / 1024, 2),
            "ext_distribution": c["ext_distribution"],
            "sample_files": sample_files,
        })

    prompt = LLM_REVIEW_PROMPT.format(clusters_json=json.dumps(simplified, ensure_ascii=False, indent=2))

    try:
        resp = chat(
            prompt=prompt,
            system="你是一个文件聚合专家,输出严格 JSON。",
            model=model,
            json_mode=True,
            temperature=0.2,
            max_tokens=8000,
        )
        content = resp.get("content", "")
        token_info = resp.get("tokens", {})
        print(f"[full_scan] LLM 重审完成 · tokens={token_info} · 输出长度={len(content)}")

        # 提取 JSON。序列可能被包在 ```json ... ``` 中,或者就是裸 JSON
        # 使用贪婪匹配,避免嵌套 JSON 被截断
        m = re.search(r"```json\s*([\[\{][\s\S]*[\]\}])\s*```", content)
        if m:
            content = m.group(1)
        else:
            m2 = re.search(r"\[[\s\S]*\]", content)
            if m2:
                content = m2.group(0)
            else:
                # 输出可能是一个包裹对象 {"clusters": [...]}
                m3 = re.search(r"\{[\s\S]*\}", content)
                if m3:
                    try:
                        obj = json.loads(m3.group(0))
                        if isinstance(obj, dict):
                            for v in obj.values():
                                if isinstance(v, list):
                                    content = json.dumps(v)
                                    break
                            else:
                                # dict 中没有 list 值,直接用该对象
                                content = m3.group(0)
                    except json.JSONDecodeError:
                        # 正则匹配到的不是合法 JSON,保持原样让外层捕获
                        pass

        review = json.loads(content)
        if isinstance(review, dict):
            # 如果返回的是单个对象(只有一组时),包裹为列表
            review = [review]
        result = {item["id"]: item for item in review if "id" in item}
        print(f"[full_scan] LLM 返回 {len(result)} 组 / 原始 {len(simplified)} 组")
        return result
    except Exception as e:
        print(f"[full_scan] LLM 重审失败: {e}")
        import traceback
        traceback.print_exc()
        return {}


def full_scan_workflow(
    paths: list[str],
    use_llm: bool = True,
    on_progress=None,
) -> dict:
    """完整全量扫描流程

    Args:
        paths: 用户选定的扫描路径
        use_llm: 是否调 LLM 重审

    Returns:
        {
            "scan_paths": [...],
            "file_count": int,
            "clusters": [...],  # 已合并 LLM 审阅结果
            "scanned_at": timestamp,
        }
    """
    t0 = time.time()
    if on_progress:
        on_progress({"phase": "scanning", "message": "扫描文件中..."})

    files = quick_scan(paths, on_progress=lambda p, n: on_progress({
        "phase": "scanning", "message": f"已扫 {n} 个", "progress": n
    }) if on_progress else None)

    if on_progress:
        on_progress({"phase": "clustering", "message": f"算法聚合 {len(files)} 个文件..."})

    clusters = pre_cluster(files)

    if on_progress:
        on_progress({"phase": "llm_review", "message": f"LLM 重审 {len(clusters)} 组..."})

    review = llm_review_clusters(clusters) if use_llm else {}
    llm_used = use_llm and len(review) > 0

    # 合并 review 结果到 clusters
    for c in clusters:
        r = review.get(c["id"])
        if r:
            c["label"] = r.get("label") or c["label"]
            c["llm_kind"] = r.get("kind")
            c["info_score"] = compute_info_score(c, r.get("info_score"))
            c["redundant"] = bool(r.get("redundant", False))
            c["split_hint"] = r.get("split_hint", [])
        else:
            c["info_score"] = compute_info_score(c)
            c["redundant"] = False
            c["split_hint"] = []

    # 排序:信息量降序
    clusters.sort(key=lambda x: x["info_score"], reverse=True)

    return {
        "scan_paths": paths,
        "file_count": len(files),
        "cluster_count": len(clusters),
        "clusters": clusters,
        "scanned_at": time.time(),
        "elapsed_sec": round(time.time() - t0, 2),
        "llm_used": llm_used,
        "llm_review_count": len(review),
    }
