"""CLI: 扫描文件夹并保存为图谱（仅文档，无关系）

用法:
    python -m src.cli scan <folder> --name <graph_name>
    python -m src.cli dump <name>          # 输出文档全文，便于Agent分析
    python -m src.cli set-relations <name> <relations.json>
"""
import argparse
import json
import sys
from pathlib import Path

# 允许直接用 python src/cli.py
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.scanner import scan_folder
from src.storage import save_graph, load_graph, write_relations, write_doc_meta, DATA_DIR


def cmd_scan(args):
    docs = scan_folder(args.folder)
    if not docs:
        print(f"⚠️  在 {args.folder} 没找到文档")
        return 1
    path = save_graph(args.name, docs, [])
    print(f"✅ 扫描到 {len(docs)} 个文档，已保存: {path}")
    print(f"📌 下一步: 运行 `python -m src.cli dump {args.name}` 查看待分析内容")
    return 0


def cmd_dump(args):
    """输出所有文档的全文内容（含 id/路径），供 Agent 一次性阅读分析"""
    data = load_graph(args.name)
    if not data:
        print(f"❌ 找不到图谱: {args.name}")
        return 1

    out = {
        "graph_name": args.name,
        "doc_count": len(data["docs"]),
        "docs": [],
    }
    for d in data["docs"]:
        # 重新读取全文（保存时去掉了 text）
        from src.scanner import extract_text
        text = extract_text(Path(d["abs_path"])) if Path(d["abs_path"]).exists() else d.get("preview", "")
        out["docs"].append({
            "id": d["id"],
            "name": d["name"],
            "rel_path": d["rel_path"],
            "ext": d["ext"],
            "content": text,
        })

    if args.output:
        Path(args.output).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✅ 已写入: {args.output}")
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_set_relations(args):
    """从 JSON 文件读取关系并写入图谱"""
    rels_path = Path(args.relations_file)
    if not rels_path.exists():
        print(f"❌ 找不到文件: {rels_path}")
        return 1
    relations = json.loads(rels_path.read_text(encoding="utf-8"))
    path = write_relations(args.name, relations)
    print(f"✅ 已写入 {len(relations)} 条候选关系到: {path}")
    data = load_graph(args.name)
    print(f"   有效关系: {len(data['relations'])} 条（已过滤无效项）")
    return 0


def cmd_set_meta(args):
    """从 JSON 文件读取文档分类/关键词/摘要并写入图谱"""
    meta_path = Path(args.meta_file)
    if not meta_path.exists():
        print(f"❌ 找不到文件: {meta_path}")
        return 1
    meta_list = json.loads(meta_path.read_text(encoding="utf-8"))
    msg = write_doc_meta(args.name, meta_list)
    print(f"✅ {msg}")
    return 0


def cmd_list(args):
    from src.storage import list_graphs
    graphs = list_graphs()
    if not graphs:
        print("还没有图谱")
        return 0
    for g in graphs:
        data = load_graph(g)
        print(f"  📊 {g}: {len(data['docs'])} 文档, {len(data['relations'])} 关系")
    return 0


def cmd_categories(args):
    """列出图谱的分类信息"""
    from src.category_manager import list_categories
    cats = list_categories(args.name)
    print(f"\n📊 图谱 [{args.name}] 分类统计（{len(cats)} 个分类）:\n")
    for c in cats:
        print(f"  [{c['count']}] {c['category']}")
        if args.verbose:
            for d in c['docs']:
                print(f"       - {d['name']} ({d['id'][:8]})")
    return 0


def cmd_gen_taxonomy(args):
    """生成分类体系"""
    from src.category_manager import generate_taxonomy
    print(f"📊 正在为 [{args.name}] 生成分类体系...")
    result = generate_taxonomy(args.name, mode=args.mode)
    print(f"\n✅ 生成完成！共 {result['cat_count']} 个分类：")
    for c in result['categories']:
        print(f"  - {c['name']}: {c.get('description', '')}")
    print(f"\n消耗 tokens: {result['tokens']}")
    return 0


def cmd_merge_cats(args):
    """合并分类"""
    from src.category_manager import manual_merge_categories
    old_cats = [c.strip() for c in args.old_categories.split(",")]
    msg = manual_merge_categories(args.name, old_cats, args.new_name)
    print(f"✅ {msg}")
    return 0


def cmd_rename_cat(args):
    """重命名分类"""
    from src.category_manager import manual_rename_category
    msg = manual_rename_category(args.name, args.old_name, args.new_name)
    print(f"✅ {msg}")
    return 0


def cmd_set_cat(args):
    """修改单篇文档的分类"""
    from src.category_manager import manual_set_category
    msg = manual_set_category(args.name, args.doc_id, args.category)
    print(f"✅ {msg}")
    return 0


def main():
    parser = argparse.ArgumentParser(prog="docgraph")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_scan = sub.add_parser("scan", help="扫描文件夹")
    p_scan.add_argument("folder")
    p_scan.add_argument("--name", required=True)

    p_dump = sub.add_parser("dump", help="导出全文供分析")
    p_dump.add_argument("name")
    p_dump.add_argument("--output", "-o", help="输出到文件，否则打印")

    p_set = sub.add_parser("set-relations", help="写入关系")
    p_set.add_argument("name")
    p_set.add_argument("relations_file")

    p_meta = sub.add_parser("set-meta", help="写入文档分类/关键词/摘要")
    p_meta.add_argument("name")
    p_meta.add_argument("meta_file")

    sub.add_parser("list", help="列出所有图谱")

    # 分类管理命令
    p_cats = sub.add_parser("categories", help="列出分类统计")
    p_cats.add_argument("name")
    p_cats.add_argument("-v", "--verbose", action="store_true", help="显示每个分类下的文档")

    p_gentax = sub.add_parser("gen-taxonomy", help="生成分类体系")
    p_gentax.add_argument("name")
    p_gentax.add_argument("--mode", default="standard", choices=["fast", "standard", "deep"])

    p_merge = sub.add_parser("merge-cats", help="合并分类")
    p_merge.add_argument("name")
    p_merge.add_argument("old_categories", help="要合并的分类名，逗号分隔")
    p_merge.add_argument("new_name", help="合并后的新分类名")

    p_rename = sub.add_parser("rename-cat", help="重命名分类")
    p_rename.add_argument("name")
    p_rename.add_argument("old_name")
    p_rename.add_argument("new_name")

    p_setcat = sub.add_parser("set-cat", help="修改单篇文档分类")
    p_setcat.add_argument("name")
    p_setcat.add_argument("doc_id")
    p_setcat.add_argument("category")

    args = parser.parse_args()
    handlers = {
        "scan": cmd_scan,
        "dump": cmd_dump,
        "set-relations": cmd_set_relations,
        "set-meta": cmd_set_meta,
        "list": cmd_list,
        "categories": cmd_categories,
        "gen-taxonomy": cmd_gen_taxonomy,
        "merge-cats": cmd_merge_cats,
        "rename-cat": cmd_rename_cat,
        "set-cat": cmd_set_cat,
    }
    sys.exit(handlers[args.cmd](args))


if __name__ == "__main__":
    main()
