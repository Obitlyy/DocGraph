import { useState } from 'react'

export interface ClusterFilter {
  minScore: number
  hideRedundant: boolean
  enabledKinds: Set<string>  // 空集合表示全部启用
}

export const ALL_KINDS = ['project', 'notebook', 'album', 'mixed', 'cache', 'pattern', 'orphan'] as const
export const KIND_LABELS: Record<string, string> = {
  project: '项目',
  notebook: '笔记',
  album: '图集',
  mixed: '混合',
  cache: '冗余',
  pattern: '系列',
  orphan: '散落',
}

interface Props {
  filter: ClusterFilter
  onChange: (f: ClusterFilter) => void
  totalCount: number
  visibleCount: number
  isDark: boolean
}

export default function ClusterFilterBar({ filter, onChange, totalCount, visibleCount, isDark }: Props) {
  const [expanded, setExpanded] = useState(false)

  function toggleKind(kind: string) {
    const next = new Set(filter.enabledKinds)
    if (next.has(kind)) next.delete(kind); else next.add(kind)
    onChange({ ...filter, enabledKinds: next })
  }

  const hidden = totalCount - visibleCount
  const someKindsDisabled = filter.enabledKinds.size > 0 && filter.enabledKinds.size < ALL_KINDS.length

  return (
    <div className={`px-4 py-2 flex items-center gap-3 border-b text-xs ${
      isDark ? 'border-white/10 bg-black/30' : 'border-black/5 bg-white/40'
    }`}>
      {/* 信息分阈值 */}
      <div className="flex items-center gap-2">
        <span className={isDark ? 'text-white/50' : 'text-black/50'}>信息分 ≥</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={filter.minScore}
          onChange={e => onChange({ ...filter, minScore: Number(e.target.value) })}
          className="w-28 accent-blue-500"
        />
        <span className={`font-mono w-7 ${isDark ? 'text-white/70' : 'text-black/70'}`}>
          {filter.minScore}
        </span>
      </div>

      {/* 隐藏冗余 */}
      <button
        onClick={() => onChange({ ...filter, hideRedundant: !filter.hideRedundant })}
        className={`px-2 py-1 rounded-md transition-colors ${
          filter.hideRedundant
            ? 'bg-orange-500/20 text-orange-400'
            : isDark ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-black/60 hover:bg-black/10'
        }`}
      >
        {filter.hideRedundant ? '✓' : '○'} 隐藏冗余
      </button>

      {/* 类型过滤 */}
      <div className="relative">
        <button
          onClick={() => setExpanded(v => !v)}
          className={`px-2 py-1 rounded-md flex items-center gap-1 transition-colors ${
            someKindsDisabled
              ? 'bg-blue-500/20 text-blue-400'
              : isDark ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-black/60 hover:bg-black/10'
          }`}
        >
          类型 {someKindsDisabled ? `(${filter.enabledKinds.size})` : '全部'}
          <span className="text-[9px] opacity-60">▾</span>
        </button>
        {expanded && (
          <div
            onMouseLeave={() => setExpanded(false)}
            className={`absolute top-full left-0 mt-1 z-30 rounded-lg backdrop-blur-xl border overflow-hidden min-w-[140px] ${
              isDark ? 'bg-[#1C1C1E]/95 border-white/10' : 'bg-white/95 border-black/10'
            }`}
          >
            {ALL_KINDS.map(k => {
              const enabled = filter.enabledKinds.size === 0 || filter.enabledKinds.has(k)
              return (
                <button
                  key={k}
                  onClick={() => toggleKind(k)}
                  className={`w-full px-3 py-1.5 text-left text-[11px] flex items-center gap-2 transition-colors ${
                    isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
                  }`}
                >
                  <div className={`w-3 h-3 rounded-sm flex items-center justify-center ${
                    enabled ? 'bg-blue-500' : isDark ? 'border border-white/30' : 'border border-black/30'
                  }`}>
                    {enabled && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg>}
                  </div>
                  <span className={isDark ? 'text-white/80' : 'text-black/80'}>{KIND_LABELS[k] || k}</span>
                </button>
              )
            })}
            <div className={`border-t ${isDark ? 'border-white/10' : 'border-black/10'}`}>
              <button
                onClick={() => onChange({ ...filter, enabledKinds: new Set(ALL_KINDS) })}
                className={`w-full px-3 py-1.5 text-[11px] text-left ${isDark ? 'text-white/60 hover:bg-white/10' : 'text-black/60 hover:bg-black/5'}`}
              >全选</button>
              <button
                onClick={() => onChange({ ...filter, enabledKinds: new Set() })}
                className={`w-full px-3 py-1.5 text-[11px] text-left ${isDark ? 'text-white/60 hover:bg-white/10' : 'text-black/60 hover:bg-black/5'}`}
              >清空 (= 全部)</button>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1" />

      <span className={isDark ? 'text-white/40' : 'text-black/40'}>
        显示 {visibleCount}/{totalCount}
        {hidden > 0 && <span className="ml-1 text-orange-400/80">· 隐藏 {hidden}</span>}
      </span>

      {(filter.minScore > 0 || filter.hideRedundant || someKindsDisabled) && (
        <button
          onClick={() => onChange({ minScore: 0, hideRedundant: false, enabledKinds: new Set() })}
          className={`text-[10px] ${isDark ? 'text-white/40 hover:text-white' : 'text-black/40 hover:text-black'}`}
        >
          清除筛选
        </button>
      )}
    </div>
  )
}
