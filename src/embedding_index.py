"""语义向量索引 — 基于 DeepSeek Embedding API + numpy 余弦相似度。

功能：
1. 为图谱文档生成 embedding 向量
2. 存储为 .npz 文件（numpy 压缩格式）
3. 搜索时计算余弦相似度，返回 top-K 结果
"""
import json
import logging
import time
from pathlib import Path
from typing import Optional

import numpy as np

from src.llm_client import get_client
from src.storage import load_graph, DATA_DIR

logger = logging.getLogger(__name__)

# Embedding 模型配置
EMBEDDING_MODEL = "text-embedding-v1"  # DeepSeek 兼容的 embedding 模型
EMBEDDING_BATCH_SIZE = 20  # API 每批最大条数
EMBEDDING_DIM = 1024  # 向量维度（会在首次调用时自动检测）


def get_embedding(texts: list[str]) -> list[list[float]]:
    """调用 Embedding API，批量生成向量。

    分批处理，每批最多 EMBEDDING_BATCH_SIZE 条。
    """
    client = get_client()
    all_embeddings = []

    for i in range(0, len(texts), EMBEDDING_BATCH_SIZE):
        batch = texts[i:i + EMBEDDING_BATCH_SIZE]
        # 截断过长文本（embedding 模型通常有 8K token 限制）
        batch = [t[:6000] if len(t) > 6000 else t for t in batch]

        try:
            resp = client.embeddings.create(
                input=batch,
                model=EMBEDDING_MODEL,
            )
            batch_vectors = [item.embedding for item in resp.data]
            all_embeddings.extend(batch_vectors)
        except Exception as e:
            logger.error(f"[embedding] 批次 {i//EMBEDDING_BATCH_SIZE + 1} 失败: {e}")
            # 失败的批次填充零向量（不中断整体流程）
            dim = EMBEDDING_DIM
            if all_embeddings:
                dim = len(all_embeddings[0])
            all_embeddings.extend([[0.0] * dim] * len(batch))

        # 简单限流：批次间间隔
        if i + EMBEDDING_BATCH_SIZE < len(texts):
            time.sleep(0.3)

    return all_embeddings


def _doc_to_text(doc: dict) -> str:
    """将文档元数据拼接为适合 embedding 的文本。"""
    parts = []
    if doc.get("name"):
        parts.append(doc["name"])
    if doc.get("category"):
        parts.append(doc["category"])
    if doc.get("summary"):
        parts.append(doc["summary"])
    if doc.get("keywords"):
        parts.append("、".join(doc["keywords"]))
    return " | ".join(parts) if parts else doc.get("name", "未知文档")


def build_embedding_index(graph_name: str, progress_cb=None) -> dict:
    """为图谱所有文档生成 embedding 并保存。

    参数:
        graph_name: 图谱名称
        progress_cb: 可选回调 (done, total, current_name)

    返回:
        {"doc_count": int, "dimensions": int}
    """
    g = load_graph(graph_name)
    if not g:
        raise ValueError(f"图谱不存在: {graph_name}")

    docs = g.get("docs", [])
    if not docs:
        return {"doc_count": 0, "dimensions": 0}

    # 准备文本
    texts = [_doc_to_text(d) for d in docs]
    doc_ids = [d["id"] for d in docs]
    total = len(texts)

    logger.info(f"[embedding] 开始为 {graph_name} 生成 embedding ({total} 篇文档)")

    # 分批生成 embedding（带进度回调）
    all_vectors = []
    for i in range(0, total, EMBEDDING_BATCH_SIZE):
        batch = texts[i:i + EMBEDDING_BATCH_SIZE]
        batch_truncated = [t[:6000] if len(t) > 6000 else t for t in batch]

        try:
            client = get_client()
            resp = client.embeddings.create(input=batch_truncated, model=EMBEDDING_MODEL)
            batch_vectors = [item.embedding for item in resp.data]
            all_vectors.extend(batch_vectors)
        except Exception as e:
            logger.error(f"[embedding] 批次失败: {e}")
            # 用零向量填充
            dim = len(all_vectors[0]) if all_vectors else EMBEDDING_DIM
            all_vectors.extend([[0.0] * dim] * len(batch))

        done = min(i + EMBEDDING_BATCH_SIZE, total)
        if progress_cb:
            current_name = docs[min(done - 1, total - 1)]["name"]
            progress_cb(done, total, current_name)

        # 限流
        if i + EMBEDDING_BATCH_SIZE < total:
            time.sleep(0.3)

    # 保存为 npz
    vectors_np = np.array(all_vectors, dtype=np.float32)
    save_path = DATA_DIR / f"{graph_name}_embeddings.npz"
    np.savez_compressed(
        save_path,
        vectors=vectors_np,
        doc_ids=np.array(json.dumps(doc_ids, ensure_ascii=False), dtype=object),
    )

    dimensions = vectors_np.shape[1] if vectors_np.ndim == 2 else 0
    logger.info(f"[embedding] 完成: {total} 篇, {dimensions} 维, 保存至 {save_path}")

    return {"doc_count": total, "dimensions": dimensions}


def load_embedding_index(graph_name: str) -> Optional[dict]:
    """加载已有的 embedding 索引。

    返回:
        {"vectors": np.ndarray (N, D), "doc_ids": list[str]} 或 None
    """
    path = DATA_DIR / f"{graph_name}_embeddings.npz"
    if not path.exists():
        return None

    try:
        data = np.load(path, allow_pickle=True)
        vectors = data["vectors"]
        doc_ids_raw = str(data["doc_ids"])
        doc_ids = json.loads(doc_ids_raw)
        return {"vectors": vectors, "doc_ids": doc_ids}
    except Exception as e:
        logger.warning(f"[embedding] 加载索引失败 ({graph_name}): {e}")
        return None


def search_by_embedding(index: dict, query_text: str, top_k: int = 8) -> list[dict]:
    """语义搜索：query → embedding → 余弦相似度 → top_k。

    参数:
        index: load_embedding_index() 的返回值
        query_text: 搜索文本
        top_k: 返回前 K 个结果

    返回:
        [{"doc_id": str, "score": float}, ...]  score 范围 0~1
    """
    if not index or index["vectors"].shape[0] == 0:
        return []

    # 生成 query 向量
    try:
        query_vectors = get_embedding([query_text])
        if not query_vectors or not query_vectors[0]:
            return []
        query_vec = np.array(query_vectors[0], dtype=np.float32)
    except Exception as e:
        logger.warning(f"[embedding] query embedding 失败: {e}")
        return []

    vectors = index["vectors"]
    doc_ids = index["doc_ids"]

    # 余弦相似度
    # cos_sim = (q · v) / (|q| * |v|)
    query_norm = np.linalg.norm(query_vec)
    if query_norm < 1e-10:
        return []

    doc_norms = np.linalg.norm(vectors, axis=1)
    # 防止除零
    doc_norms = np.maximum(doc_norms, 1e-10)

    similarities = np.dot(vectors, query_vec) / (doc_norms * query_norm)

    # 取 top_k
    top_indices = np.argsort(similarities)[::-1][:top_k]

    results = []
    for idx in top_indices:
        score = float(similarities[idx])
        if score > 0.1:  # 过滤掉相似度太低的
            results.append({
                "doc_id": doc_ids[idx],
                "score": score,
            })

    return results
