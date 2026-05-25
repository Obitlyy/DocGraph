"""场景化关系库定义。

每个场景包含一组关系类型 + 描述 + 方向性。
LLM 在分析关系时只能在该场景的类型集合内选择。
"""

# 关系库定义：每个 schema 是一个场景，包含若干关系类型
SCHEMAS = {
    "general": {
        "name": "通用",
        "description": "适合混合内容、未知类型的文件夹",
        "relations": [
            {"type": "提供数据", "directional": True, "desc": "A 为 B 提供数据/输入"},
            {"type": "浓缩版本", "directional": True, "desc": "A 是 B 的精简/摘要版"},
            {"type": "旧版本", "directional": True, "desc": "A 是 B 的旧版本"},
            {"type": "衍生文档", "directional": True, "desc": "B 由 A 派生而来"},
            {"type": "引用参考", "directional": False, "desc": "互相引用/参考"},
            {"type": "同一项目", "directional": False, "desc": "属于同一个项目"},
            {"type": "同一批次", "directional": False, "desc": "属于同一批次/系列"},
        ],
    },
    "academic": {
        "name": "学术/课程",
        "description": "适合课程资料、论文、教材、习题等学习场景",
        "relations": [
            {"type": "前置知识", "directional": True, "desc": "A 是学习 B 的前置知识"},
            {"type": "理论支撑", "directional": True, "desc": "A 提供理论，B 是其应用/实践"},
            {"type": "实践应用", "directional": True, "desc": "A 的理论在 B 中实践"},
            {"type": "习题对应", "directional": False, "desc": "讲义与对应的习题/作业"},
            {"type": "同周课程", "directional": False, "desc": "属于同一周/同一节的课程材料"},
            {"type": "考点呼应", "directional": False, "desc": "围绕同一知识点/考点"},
            {"type": "参考文献", "directional": True, "desc": "A 引用了 B 作为参考"},
            {"type": "同一章节", "directional": False, "desc": "属于同一章节/单元"},
            {"type": "旧版本", "directional": True, "desc": "A 是 B 的旧版本"},
        ],
    },
    "work": {
        "name": "工作项目",
        "description": "适合公司/团队的项目文档、汇报、调研、复盘等",
        "relations": [
            {"type": "立项依据", "directional": True, "desc": "A 是 B 项目立项的依据"},
            {"type": "需求来源", "directional": True, "desc": "A 提出的需求驱动了 B"},
            {"type": "阶段交付", "directional": False, "desc": "属于项目同一阶段的交付物"},
            {"type": "汇报浓缩", "directional": True, "desc": "B 是 A 的精简汇报版"},
            {"type": "复盘对应", "directional": True, "desc": "B 是对 A 的复盘/总结"},
            {"type": "决策依据", "directional": True, "desc": "A 为 B 的决策提供依据"},
            {"type": "协作产出", "directional": False, "desc": "多方协作的同主题产出"},
            {"type": "版本迭代", "directional": True, "desc": "A 是 B 的旧版本"},
            {"type": "引用参考", "directional": False, "desc": "互相引用/参考"},
        ],
    },
    "code": {
        "name": "代码项目",
        "description": "适合代码仓库、API、技术文档、配置文件等",
        "relations": [
            {"type": "接口实现", "directional": True, "desc": "A 定义接口，B 实现/调用"},
            {"type": "依赖引用", "directional": True, "desc": "B 依赖/引用 A"},
            {"type": "配置驱动", "directional": True, "desc": "A 是配置，B 由其驱动"},
            {"type": "测试对应", "directional": False, "desc": "实现与对应的测试"},
            {"type": "文档说明", "directional": True, "desc": "A 是 B 的文档/说明"},
            {"type": "API 引用", "directional": False, "desc": "互相引用 API"},
            {"type": "部署对应", "directional": False, "desc": "代码与对应的部署/运维文档"},
            {"type": "模块协作", "directional": False, "desc": "属于同一模块/子系统"},
            {"type": "版本迭代", "directional": True, "desc": "A 是 B 的旧版本"},
        ],
    },
}


def get_schema(schema_id: str = "general") -> dict:
    """获取关系库定义，未知 id 回退到 general。"""
    return SCHEMAS.get(schema_id) or SCHEMAS["general"]


def list_schemas() -> list[dict]:
    """列出所有关系库（用于前端选择）。"""
    return [
        {
            "id": sid,
            "name": s["name"],
            "description": s["description"],
            "relation_count": len(s["relations"]),
            "relations": [r["type"] for r in s["relations"]],
        }
        for sid, s in SCHEMAS.items()
    ]


def get_relation_types(schema_id: str = "general") -> list[str]:
    """返回该 schema 的所有关系 type 列表。"""
    return [r["type"] for r in get_schema(schema_id)["relations"]]


def get_directional(schema_id: str = "general") -> set:
    """返回该 schema 中有方向性的关系 type 集合。"""
    return {r["type"] for r in get_schema(schema_id)["relations"] if r["directional"]}


def format_relations_for_prompt(schema_id: str = "general") -> str:
    """格式化关系类型列表，用于 LLM prompt。"""
    schema = get_schema(schema_id)
    lines = []
    for r in schema["relations"]:
        arrow = "A → B" if r["directional"] else "A ↔ B"
        lines.append(f'- {r["type"]} ({arrow}): {r["desc"]}')
    return "\n".join(lines)


# ============ 自动检测项目类型 ============
DETECT_PROMPT = """根据下面的文件清单，判断这个文件夹最适合哪种关系库类型。

文件清单：
{file_list}

可选类型：
- academic: 学术/课程材料（讲义、习题、论文、教材等）
- work: 工作项目文档（汇报、调研、复盘、方案等）
- code: 代码项目（源代码、API 文档、配置、测试等）
- general: 通用（混合或无法明确归类）

只返回 JSON：
{{"schema": "academic|work|code|general", "confidence": 0.0-1.0, "reason": "20字内简述"}}
"""


def detect_schema(docs: list[dict], model: str = None) -> dict:
    """让 LLM 判断这批文档适合哪种关系库。"""
    from src.llm_client import chat
    # 取前 30 个文件名 + 文件夹结构
    file_list = []
    for d in docs[:30]:
        rel = d.get("rel_path", d.get("name", ""))
        file_list.append(f"- {rel}")
    if len(docs) > 30:
        file_list.append(f"... 还有 {len(docs) - 30} 个文件")

    prompt = DETECT_PROMPT.format(file_list="\n".join(file_list))
    resp = chat(
        prompt,
        system="你是文档分类专家，输出严格 JSON。",
        model=model or "deepseek-v4-flash",
        json_mode=True,
        max_tokens=200,
        temperature=0.1,
        thinking="disabled",
    )
    data = resp.get("data") or {}
    schema_id = data.get("schema", "general")
    if schema_id not in SCHEMAS:
        schema_id = "general"
    return {
        "schema": schema_id,
        "confidence": data.get("confidence", 0.5),
        "reason": data.get("reason", ""),
        "name": SCHEMAS[schema_id]["name"],
    }
