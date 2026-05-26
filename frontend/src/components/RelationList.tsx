import { useMemo, useState } from 'react'
import type { GraphData } from '../api'
import { deleteRelation } from '../api'

interface Props {
  graph: GraphData
  graphName: string
  onReload: () => void
  isDark: boolean
}

const RELATION_COLORS: Record<string, string> = {
  '提供数据': '#007AFF',
  '浓缩版本': '#34C759',
  '旧版本': '#8E8E93',
  '衍生文档': '#FF9500',
  '引用参考': '#AF52DE',
  '同一项目': '#FF3B30',
  '同一批次': '#FF2D55',
}

export default function RelationList({ graph, graphName, onReload, isDark }: Props) {
  const [deleting, setDeleting] = useState<string | null>(null)
  const id2name = useMemo(() => Object.fromEntries(graph.docs.map(d => [d.id, d.name])), [graph.docs])

  const handleDelete = async (index: number, rel: { from: string; to: string; type: string }) => {
    const key = `${rel.from}-${rel.to}-${rel.type}`
    setDeleting(key)
    try {
      await deleteRelation(graphName, index, rel)
      onReload()
    } catch {
      // 删除失败时静默忽略
    }
    setDeleting(null)
  }

  if (!graph.relations.length) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className={`text-5xl mb-4 ${isDark ? 'opacity-30' : 'opacity-20'}`}>🔗</p>
          <p className={`text-sm ${isDark ? 'text-white/30' : 'text-black/30'}`}>
            暂无关系，点击侧边栏「推断关系」
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-baseline gap-3 mb-5">
        <h2 className={`text-xl font-semibold tracking-tight ${
          isDark ? 'text-white' : 'text-[#1D1D1F]'
        }`}>关系</h2>
        <span className={`text-sm ${isDark ? 'text-white/30' : 'text-black/30'}`}>
          {graph.relations.length} 条
        </span>
      </div>

      <div className="space-y-1.5">
        {graph.relations.map((r, i) => {
          const relKey = `${r.from}-${r.to}-${r.type}`
          return (
          <div key={relKey} className={`rounded-xl px-4 py-3 flex items-center gap-3 transition-all ${
            isDark ? 'glass-card-dark' : 'glass-card-light'
          }`}>
            <span className={`text-xs font-medium flex-1 truncate ${
              isDark ? 'text-white/80' : 'text-[#1D1D1F]'
            }`}>
              {id2name[r.from] || r.from}
            </span>

            <span
              className="text-[10px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
              style={{
                backgroundColor: `${RELATION_COLORS[r.type] || '#8E8E93'}${isDark ? '30' : '15'}`,
                color: RELATION_COLORS[r.type] || '#8E8E93',
              }}
            >
              {r.directional ? '→' : '↔'} {r.type}
            </span>

            <span className={`text-xs font-medium flex-1 truncate ${
              isDark ? 'text-white/80' : 'text-[#1D1D1F]'
            }`}>
              {id2name[r.to] || r.to}
            </span>

            <span className={`text-[10px] font-medium w-10 text-right ${
              isDark ? 'text-white/20' : 'text-black/20'
            }`}>
              {(r.confidence * 100).toFixed(0)}%
            </span>

            <button
              onClick={() => handleDelete(i, { from: r.from, to: r.to, type: r.type })}
              disabled={deleting === relKey}
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs transition-colors disabled:opacity-30 ${
                isDark ? 'text-white/20 hover:text-[#FF453A] hover:bg-[#FF453A]/20' : 'text-black/20 hover:text-[#FF3B30] hover:bg-[#FF3B30]/10'
              }`}
            >
              ×
            </button>
          </div>
          )
        })}
      </div>
    </div>
  )
}
