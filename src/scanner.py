"""文件夹扫描和文档解析。支持多种格式：文本、文档、代码、图片等。"""
import os
import hashlib
from pathlib import Path
from typing import Optional

# 文本与文档格式
DOC_EXTS = {".md", ".txt", ".docx", ".xlsx", ".pdf", ".pptx", ".csv", ".json", ".html", ".htm", ".rst", ".tex", ".epub"}

# 代码格式
CODE_EXTS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".vue", ".svelte",
    ".java", ".kt", ".scala", ".groovy",
    ".go", ".rs", ".cpp", ".cc", ".c", ".h", ".hpp",
    ".cs", ".swift", ".m", ".mm",
    ".rb", ".php", ".pl", ".lua", ".r",
    ".sh", ".bash", ".zsh", ".fish", ".ps1",
    ".sql", ".graphql", ".gql",
    ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg",
    ".xml", ".dockerfile", ".makefile", ".cmake",
    ".vim", ".el", ".clj", ".ex", ".exs", ".erl", ".hs",
}

# 图片格式
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg"}

SUPPORTED_EXTS = DOC_EXTS | CODE_EXTS | IMAGE_EXTS
MAX_TEXT_CHARS = 200000  # 不限制扫描时的文本长度，DeepSeek 支持 128K context


def read_text_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        return f"[读取失败: {e}]"


def read_docx(path: Path) -> str:
    try:
        from docx import Document
        doc = Document(str(path))
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    except Exception as e:
        return f"[docx读取失败: {e}]"


def read_xlsx(path: Path) -> str:
    try:
        from openpyxl import load_workbook
        wb = load_workbook(str(path), data_only=True, read_only=True)
        parts = []
        for sheet in wb.sheetnames:
            ws = wb[sheet]
            parts.append(f"# Sheet: {sheet}")
            for row in ws.iter_rows(values_only=True, max_row=200):
                line = "\t".join(str(c) if c is not None else "" for c in row)
                if line.strip():
                    parts.append(line)
        return "\n".join(parts)
    except Exception as e:
        return f"[xlsx读取失败: {e}]"


def read_pdf(path: Path) -> str:
    """读取 PDF 文本内容"""
    try:
        import pymupdf  # PyMuPDF
        doc = pymupdf.open(str(path))
        parts = []
        for page in doc:
            text = page.get_text()
            if text.strip():
                parts.append(text)
        doc.close()
        return "\n".join(parts)
    except ImportError:
        # fallback: pdfplumber
        try:
            import pdfplumber
            parts = []
            with pdfplumber.open(str(path)) as pdf:
                for page in pdf.pages[:50]:  # 最多50页
                    text = page.extract_text()
                    if text and text.strip():
                        parts.append(text)
            return "\n".join(parts)
        except ImportError:
            return "[需要安装 pymupdf 或 pdfplumber: pip install pymupdf]"
        except Exception as e:
            return f"[pdf读取失败: {e}]"
    except Exception as e:
        return f"[pdf读取失败: {e}]"


def read_pptx(path: Path) -> str:
    """读取 PPTX 幻灯片文本"""
    try:
        from pptx import Presentation
        prs = Presentation(str(path))
        parts = []
        for i, slide in enumerate(prs.slides, 1):
            slide_texts = []
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        t = para.text.strip()
                        if t:
                            slide_texts.append(t)
            if slide_texts:
                parts.append(f"[Slide {i}]")
                parts.extend(slide_texts)
        return "\n".join(parts)
    except ImportError:
        return "[需要安装 python-pptx: pip install python-pptx]"
    except Exception as e:
        return f"[pptx读取失败: {e}]"


def read_csv(path: Path) -> str:
    """读取 CSV 前200行"""
    try:
        import csv
        parts = []
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            reader = csv.reader(f)
            for i, row in enumerate(reader):
                if i >= 200:
                    parts.append("[... 更多行已截断]")
                    break
                parts.append("\t".join(row))
        return "\n".join(parts)
    except Exception as e:
        return f"[csv读取失败: {e}]"


def read_html(path: Path) -> str:
    """读取 HTML 并提取纯文本"""
    try:
        from html.parser import HTMLParser
        class TextExtractor(HTMLParser):
            def __init__(self):
                super().__init__()
                self.parts = []
                self._skip = False
            def handle_starttag(self, tag, attrs):
                if tag in ("script", "style"):
                    self._skip = True
            def handle_endtag(self, tag):
                if tag in ("script", "style"):
                    self._skip = False
            def handle_data(self, data):
                if not self._skip and data.strip():
                    self.parts.append(data.strip())
        raw = path.read_text(encoding="utf-8", errors="ignore")
        extractor = TextExtractor()
        extractor.feed(raw)
        return "\n".join(extractor.parts)
    except Exception as e:
        return f"[html读取失败: {e}]"


def read_code_file(path: Path, max_lines: int = 800) -> str:
    """读代码文件：保留前 max_lines 行，后面加截断提示。"""
    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
        lines = content.splitlines()
        ext = path.suffix.lower().lstrip(".")
        head = f"# {path.name} ({ext}, {len(lines)} 行)\n"
        if len(lines) <= max_lines:
            return head + content
        return head + "\n".join(lines[:max_lines]) + f"\n\n[... 还有 {len(lines) - max_lines} 行已截断]"
    except Exception as e:
        return f"[代码文件读取失败: {e}]"


def read_image(path: Path) -> str:
    """读取图片。优先用视觉模型识别内容；如未配置则返回基础元信息。"""
    # 基础元信息
    try:
        from PIL import Image
        img = Image.open(path)
        size_info = f"{img.size[0]}x{img.size[1]}"
        mode = img.mode
        format_name = img.format or path.suffix.upper().lstrip(".")
        img.close()
        meta = f"图片: {path.name}\n格式: {format_name}\n尺寸: {size_info}\n色彩模式: {mode}"
    except Exception as e:
        meta = f"图片: {path.name}\n读取元信息失败: {e}"

    # 可选：调视觉模型识别内容
    vision_model = os.getenv("VISION_MODEL")  # 如 doubao-seed-1-6 / gpt-4o / qwen-vl-max
    if not vision_model:
        return meta + "\n\n[内容分析：未配置视觉模型。在 DocGraph/.env 中取消 VISION_MODEL/VISION_API_KEY/VISION_BASE_URL 的注释可启用图片识别]"
    try:
        description = describe_image_with_vision(path, vision_model)
        if description:
            return meta + "\n\n[视觉识别内容]\n" + description
        return meta + "\n\n[视觉模型返回为空]"
    except Exception as e:
        return meta + f"\n\n[视觉模型调用失败: {type(e).__name__}: {e}]"


def describe_image_with_vision(path: Path, model: str) -> str:
    """调用视觉模型描述图片内容。

    需 .env 配置：
      VISION_API_KEY  - API Key
      VISION_BASE_URL - API 基址（OpenAI 兼容）
      VISION_MODEL    - 模型名

    默认回退：使用 OPENAI_API_KEY / OPENAI_BASE_URL。
    支持火山方舟豆包（doubao-vision/seed-1.6）、OpenAI GPT-4o、通义千问 Qwen-VL、智谱 GLM-4V。
    """
    import base64
    from openai import OpenAI

    api_key = os.getenv("VISION_API_KEY") or os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("VISION_BASE_URL") or os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    if not api_key:
        raise RuntimeError("未配置 VISION_API_KEY\u3002请在 .env 中设置。")

    # 大于 10MB 的图片调用会被拒（各家接口限制不同，取保守值）
    file_size = path.stat().st_size
    if file_size > 10 * 1024 * 1024:
        raise RuntimeError(f"图片超过 10MB（{file_size/1024/1024:.1f}MB），跳过视觉识别")

    # 读图转 base64
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    ext = path.suffix.lower().lstrip(".")
    mime_map = {"jpg": "jpeg", "jpe": "jpeg", "jpeg": "jpeg",
                "png": "png", "webp": "webp", "gif": "gif",
                "bmp": "bmp", "tiff": "tiff", "svg": "svg+xml"}
    mime_ext = mime_map.get(ext, ext)
    data_url = f"data:image/{mime_ext};base64,{b64}"

    client = OpenAI(api_key=api_key, base_url=base_url, timeout=60)
    resp = client.chat.completions.create(
        model=model,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": data_url},
                },
                {
                    "type": "text",
                    "text": "请描述这张图片的内容。重点包含：\n1. 主题/场景\n2. 主要元素与人物/物体\n3. 画面中的文字内容（如果有）\n4. 潜在用途或含义\n\n中文输出，200 字以内，紧凑信息密集。",
                },
            ],
        }],
        max_tokens=500,
        temperature=0.2,
    )
    content = resp.choices[0].message.content or ""
    return content.strip()


def extract_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".md", ".txt", ".rst", ".tex"):
        text = read_text_file(path)
    elif ext == ".docx":
        text = read_docx(path)
    elif ext == ".xlsx":
        text = read_xlsx(path)
    elif ext == ".pdf":
        text = read_pdf(path)
    elif ext in (".pptx", ".ppt"):
        text = read_pptx(path)
    elif ext == ".csv":
        text = read_csv(path)
    elif ext in (".html", ".htm"):
        text = read_html(path)
    elif ext == ".json":
        text = read_text_file(path)
    elif ext in CODE_EXTS:
        text = read_code_file(path)
    elif ext in IMAGE_EXTS:
        text = read_image(path)
    else:
        text = ""
    return text[:MAX_TEXT_CHARS]


# 代码项目中需跳过的垃圾目录
IGNORE_DIRS = {
    "node_modules", "__pycache__", "venv", ".venv", "env", ".env",
    "dist", "build", "target", "out", ".next", ".nuxt", ".cache",
    "vendor", "deps", "_build", ".gradle", ".idea", ".vscode",
    "coverage", ".nyc_output", ".pytest_cache", ".mypy_cache",
    ".tox", ".eggs", "egg-info", ".terraform",
}


def scan_folder(folder: str) -> list[dict]:
    """递归扫描文件夹，返回文档元数据列表。自动跳过隐藏目录和代码项目的垃圾目录。"""
    root = Path(folder).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        return []

    docs = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in SUPPORTED_EXTS:
            continue
        rel_parts = path.relative_to(root).parts
        if any(part.startswith(".") for part in rel_parts):
            continue  # 跳过隐藏目录
        if any(part in IGNORE_DIRS for part in rel_parts):
            continue  # 跳过代码项目垃圾目录
        if path.name.startswith("~$") or path.name.startswith("._"):
            continue  # 跳过临时锁文件

        rel = str(path.relative_to(root))
        stat = path.stat()
        text = extract_text(path)
        doc_id = hashlib.md5(rel.encode()).hexdigest()[:10]

        docs.append({
            "id": doc_id,
            "name": path.name,
            "rel_path": rel,
            "abs_path": str(path),
            "ext": path.suffix.lower(),
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "text": text,
            "preview": text[:300],
            "char_count": len(text),  # 信息量：文本长度（字符数）
            "category": "",            # 内容分类（待 Agent 填）
            "keywords": [],            # 关键词数组（待 Agent 填）
            "summary": "",             # 一句话摘要（待 Agent 填）
        })
    return docs


def scan_files(file_paths: list[str], common_root: str | None = None) -> list[dict]:
    """扫描任意文件列表，返回文档元数据。用于从全量扫描结果创建图谱。

    common_root: 可选的公共根路径，用于计算 rel_path。如果为 None 或不适用，使用文件名作为 rel_path。
    """
    docs = []
    root_p = Path(common_root).expanduser().resolve() if common_root else None

    for fp in file_paths:
        path = Path(fp).expanduser().resolve()
        if not path.exists() or not path.is_file():
            continue
        if path.suffix.lower() not in SUPPORTED_EXTS:
            continue
        if path.name.startswith("~$") or path.name.startswith("._"):
            continue

        # 计算 rel_path
        rel = path.name
        if root_p:
            try:
                rel = str(path.relative_to(root_p))
            except ValueError:
                rel = path.name

        stat = path.stat()
        text = extract_text(path)
        # 统一使用 rel_path 生成 ID，与 scan_folder 保持一致
        doc_id = hashlib.md5(rel.encode()).hexdigest()[:10]

        docs.append({
            "id": doc_id,
            "name": path.name,
            "rel_path": rel,
            "abs_path": str(path),
            "ext": path.suffix.lower(),
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "text": text,
            "preview": text[:300],
            "char_count": len(text),
            "category": "",
            "keywords": [],
            "summary": "",
        })

    return docs


def diff_folder(folder: str, existing_docs: list[dict]) -> dict:
    """对比文件夹当前状态与已有图谱文档，返回变化集。

    Returns:
        {
            "added": [<新扫的 doc dict，完整包含 text>],
            "modified": [<新扫的 doc dict>],   # mtime > 已存的 mtime
            "deleted_ids": [<doc_id>],          # 文件夹里没了的
            "unchanged_ids": [<doc_id>],        # 没变化的
        }
    所有 added/modified 都是完整结构（含 text），可直接走分析流程。
    """
    fresh = scan_folder(folder)
    fresh_by_id = {d["id"]: d for d in fresh}
    existing_by_id = {d["id"]: d for d in existing_docs}

    added: list[dict] = []
    modified: list[dict] = []
    unchanged_ids: list[str] = []

    for did, fdoc in fresh_by_id.items():
        edoc = existing_by_id.get(did)
        if edoc is None:
            added.append(fdoc)
            continue
        # mtime 可能为 int/float/None
        old_mtime = edoc.get("mtime") or 0
        new_mtime = fdoc.get("mtime") or 0
        # 考虑浮点误差，差 0.5s 以内视为一致
        if new_mtime - old_mtime > 0.5:
            modified.append(fdoc)
        else:
            unchanged_ids.append(did)

    deleted_ids = [did for did in existing_by_id if did not in fresh_by_id]

    return {
        "added": added,
        "modified": modified,
        "deleted_ids": deleted_ids,
        "unchanged_ids": unchanged_ids,
    }
