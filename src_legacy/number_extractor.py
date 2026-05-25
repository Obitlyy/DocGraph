"""数字提取与归一化：从文档中提取所有数字 + 上下文。

设计目标：
- 0 LLM 调用，纯正则
- 支持多种格式：百分比、千分位、中文单位（万/亿）、英文单位（K/M/B）、负数、小数
- 提取上下文（前后各 N 字符）便于后续语义判断
"""
import re
from pathlib import Path
from typing import Optional


# ---- 数字正则 ----
# 匹配各种数字格式
NUMBER_PATTERN = re.compile(
    r"""
    (?<![a-zA-Z\d])                       # 前面不能是字母或数字（避免匹配 abc123 中的 123）
    (?P<sign>[-+]?)                       # 可选正负号
    (?P<num>
        \d{1,3}(?:,\d{3})+(?:\.\d+)?      # 千分位: 1,234.56
        |
        \d+\.\d+                          # 小数: 123.45
        |
        \d+                               # 整数: 123
    )
    (?P<unit>
        \s?%                              # 百分比
        |
        \s?(?:万亿|百万|千万|亿|万|千|百)    # 中文单位
        |
        \s?(?:[KkMmBbTt])(?![a-zA-Z])     # 英文单位（后面不能跟字母，避免匹配 KB/MB 等）
        |
        \s?(?:元|美元|美金|人民币|RMB|USD|CNY|港币|HKD|欧元|EUR)
    )?
    """,
    re.VERBOSE,
)

# ---- 日期正则 ----
DATE_PATTERNS = [
    # 2025-09-30, 2025/09/30, 2025.09.30
    re.compile(r"\b(20\d{2})[\-/.](\d{1,2})[\-/.](\d{1,2})\b"),
    # 2025年9月30日, 2025年9月
    re.compile(r"(20\d{2})年(\d{1,2})月(?:(\d{1,2})日?)?"),
    # 2025年Q3, 2025Q3, 2025 Q3
    re.compile(r"\b(20\d{2})\s?年?\s?Q([1-4])\b", re.IGNORECASE),
    re.compile(r"\bQ([1-4])[\s-]?(20\d{2})\b", re.IGNORECASE),
    # Sep 30 2025, September 30, 2025
    re.compile(
        r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b",
        re.IGNORECASE,
    ),
    # 30 Sep 2025
    re.compile(
        r"\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(20\d{2})\b",
        re.IGNORECASE,
    ),
    # 2025/09, 2025-09 (年月)
    re.compile(r"\b(20\d{2})[\-/](\d{1,2})\b(?![\-/.\d])"),
]

# 中文单位 → 倍数
CN_UNIT_MULT = {
    "百": 100, "千": 1_000, "万": 10_000, "百万": 1_000_000,
    "千万": 10_000_000, "亿": 100_000_000, "万亿": 1_000_000_000_000,
}
EN_UNIT_MULT = {
    "k": 1_000, "m": 1_000_000, "b": 1_000_000_000, "t": 1_000_000_000_000,
}


def normalize_number(sign: str, num_str: str, unit: str) -> dict:
    """把匹配到的数字规范化为统一格式。

    返回:
        {
            "raw": 原始字符串,
            "value": 浮点数（规范化后的真实值，百分比保留为 0-100）,
            "is_percent": 是否百分比,
            "unit": 单位字符串,
            "magnitude": 量级（用于排序：log10）,
        }
    """
    raw = f"{sign}{num_str}{unit}".strip()
    num_clean = num_str.replace(",", "")
    try:
        value = float(num_clean)
    except ValueError:
        value = 0.0
    if sign == "-":
        value = -value

    unit_clean = unit.strip() if unit else ""
    is_percent = "%" in unit_clean

    multiplier = 1.0
    if not is_percent and unit_clean:
        # 中文单位
        for cn, mult in sorted(CN_UNIT_MULT.items(), key=lambda x: -len(x[0])):
            if cn in unit_clean:
                multiplier = mult
                break
        else:
            # 英文单位
            unit_lower = unit_clean.lower().strip()
            if unit_lower in EN_UNIT_MULT:
                multiplier = EN_UNIT_MULT[unit_lower]

    real_value = value * multiplier
    import math
    magnitude = math.log10(abs(real_value)) if real_value != 0 else 0

    return {
        "raw": raw,
        "value": value,                # 显示用
        "real_value": real_value,      # 真实数值（用于比较）
        "is_percent": is_percent,
        "unit": unit_clean,
        "magnitude": round(magnitude, 2),
    }


def extract_numbers(text: str, context_chars: int = 80, min_value: float = 0) -> list[dict]:
    """从文本中提取所有数字 + 上下文。

    参数:
        text: 待扫描文本
        context_chars: 上下文字符数（前后各 N）
        min_value: 最小真实值，过滤掉太小的数字（如年份、序号等噪音）

    返回:
        [{raw, value, real_value, is_percent, unit, context, position}]
    """
    if not text:
        return []

    results = []
    seen_positions = set()

    for m in NUMBER_PATTERN.finditer(text):
        start = m.start()
        if start in seen_positions:
            continue
        seen_positions.add(start)

        sign = m.group("sign") or ""
        num_str = m.group("num")
        unit = m.group("unit") or ""

        # 过滤纯整数无单位且很小的（可能是序号、年份）
        if not unit and "," not in num_str and "." not in num_str:
            try:
                v = int(num_str)
                # 1-99: 可能是日/编号；过滤
                if v < 100:
                    continue
                # 1900-2100: 可能是年份；过滤（避免噪音）
                if 1900 <= v <= 2100:
                    continue
            except ValueError:
                pass

        info = normalize_number(sign, num_str, unit)

        if abs(info["real_value"]) < min_value and not info["is_percent"]:
            continue

        ctx_start = max(0, start - context_chars)
        ctx_end = min(len(text), m.end() + context_chars)
        context = text[ctx_start:ctx_end].replace("\n", " ").strip()
        # 在上下文里高亮目标
        info["context"] = context
        info["position"] = start

        results.append(info)

    return results


def extract_dates(text: str) -> list[dict]:
    """从文本中提取所有日期，归一化为 YYYY-MM-DD。"""
    if not text:
        return []

    MONTH_MAP = {
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
        "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    }

    results = []
    for pattern in DATE_PATTERNS:
        for m in pattern.finditer(text):
            try:
                groups = m.groups()
                raw = m.group(0)

                # 判断是哪种格式
                if "Q" in raw.upper():
                    # 季度
                    if groups[0].isdigit() and len(groups[0]) == 4:
                        year, q = int(groups[0]), int(groups[1])
                    else:
                        q, year = int(groups[0]), int(groups[1])
                    month = (q - 1) * 3 + 1
                    iso = f"{year:04d}-{month:02d}-01"
                    results.append({"raw": raw, "iso": iso, "type": "quarter", "year": year, "quarter": q})
                elif groups[0] and groups[0].isdigit() and len(groups[0]) == 4:
                    # YYYY-MM-DD 或 YYYY年M月D日
                    year = int(groups[0])
                    month = int(groups[1])
                    day = int(groups[2]) if len(groups) > 2 and groups[2] else 1
                    iso = f"{year:04d}-{month:02d}-{day:02d}"
                    results.append({"raw": raw, "iso": iso, "type": "date", "year": year, "month": month, "day": day})
                else:
                    # 英文月份
                    parts = [g for g in groups if g]
                    month_str = next((p for p in parts if p.lower()[:3] in MONTH_MAP), None)
                    if not month_str:
                        continue
                    month = MONTH_MAP[month_str.lower()[:3]]
                    nums = [int(p) for p in parts if p.isdigit()]
                    if not nums:
                        continue
                    year = max(nums)
                    day = next((n for n in nums if n != year and n <= 31), 1)
                    iso = f"{year:04d}-{month:02d}-{day:02d}"
                    results.append({"raw": raw, "iso": iso, "type": "date", "year": year, "month": month, "day": day})
            except (ValueError, IndexError):
                continue

    # 去重
    seen = set()
    unique = []
    for d in results:
        key = d["iso"]
        if key not in seen:
            seen.add(key)
            unique.append(d)
    unique.sort(key=lambda x: x["iso"])
    return unique


def extract_filename_date(filename: str) -> Optional[str]:
    """从文件名中提取日期，返回 ISO 格式或 None。"""
    dates = extract_dates(filename)
    if dates:
        return dates[0]["iso"]
    return None


def get_file_birthtime(path: Path) -> Optional[float]:
    """获取文件创建时间（macOS 有 birthtime，Linux 通常没有）。"""
    try:
        stat = path.stat()
        # macOS: st_birthtime
        if hasattr(stat, "st_birthtime"):
            return stat.st_birthtime
        return None
    except Exception:
        return None


def estimate_doc_time(doc: dict) -> dict:
    """综合判断文档的"代表时间"。

    优先级：文件名日期 > 内容首个日期 > 创建时间 > 修改时间
    返回:
        {
            "best_time": float (timestamp),
            "best_iso": "YYYY-MM-DD",
            "source": "filename" | "content" | "birthtime" | "mtime",
            "candidates": {filename, content, birthtime, mtime}
        }
    """
    import time
    candidates = {}

    # 1. 文件名日期
    fn_date = extract_filename_date(doc.get("name", ""))
    if fn_date:
        candidates["filename"] = fn_date

    # 2. 内容里首个日期
    text = doc.get("text") or doc.get("preview", "")
    content_dates = extract_dates(text)
    if content_dates:
        candidates["content"] = content_dates[0]["iso"]

    # 3. birthtime
    abs_path = doc.get("abs_path")
    if abs_path:
        bt = get_file_birthtime(Path(abs_path))
        if bt:
            candidates["birthtime"] = time.strftime("%Y-%m-%d", time.localtime(bt))

    # 4. mtime
    mtime = doc.get("mtime")
    if mtime:
        candidates["mtime"] = time.strftime("%Y-%m-%d", time.localtime(mtime))

    # 选最佳：filename > content > birthtime > mtime
    for source in ["filename", "content", "birthtime", "mtime"]:
        if source in candidates:
            iso = candidates[source]
            try:
                ts = time.mktime(time.strptime(iso, "%Y-%m-%d"))
            except ValueError:
                ts = 0
            return {
                "best_time": ts,
                "best_iso": iso,
                "source": source,
                "candidates": candidates,
            }

    return {"best_time": 0, "best_iso": "", "source": "none", "candidates": candidates}


# ---- 数字相似度判断（粗匹配） ----
def numbers_might_be_same(a: dict, b: dict, tol: float = 0.001) -> bool:
    """快速判断两个数字是不是"可能相同"（数值层面）。

    不考虑语义上下文，只看数值。tol 是相对误差。
    """
    if a["is_percent"] != b["is_percent"]:
        return False
    if a["real_value"] == 0 and b["real_value"] == 0:
        return True
    if a["real_value"] == 0 or b["real_value"] == 0:
        return False
    rel = abs(a["real_value"] - b["real_value"]) / max(abs(a["real_value"]), abs(b["real_value"]))
    return rel <= tol
