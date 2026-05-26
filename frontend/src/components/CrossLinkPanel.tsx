import { useState, useMemo } from 'react'
import type { CrossLink, ScanCluster } from '../api'
import { applyCrossLinks } from '../api'

// 跨组关联类型标签
export const LINK_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  duplicate: { label: '重复造轮子', color: '#FF6B6B' },
  shared_data: { label: '共享数据', color: '#4ECDC4' },
  upstream: { label: '上下游', color: '#45B7D1' },
  reference: { label: '引用参考', color: '#96C93D' },
  evolution: { label: '版本迭代', color: '#DDA0DD' },
  topic: { label: '相同主题', color: '#FFA07A' },
}

interface Props {
  link: CrossLink
  allLinks: CrossLink[]
  clusters: ScanCluster[]
  isDark: boolean
  onClose: () => void
  onSelectLink: (l: CrossLink) => void
  scanId?: string
}

export default function CrossLinkPanel({ allLinks, clusters, isDark, onClose, onSelectLink, scanId }: Props) {
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set())
  const [filterClusters, setFilterClusters] = useState<Set<string>>(new Set())
  const [showTypeMenu, setShowTypeMenu] = useState(false)
  const [showClusterMenu, setShowClusterMenu] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<string | null>(null)
  const [clusterNameMode, setClusterNameMode] = useState<'smart' | 'raw'>('smart')

  // 选中要同步的 link（在 filtered 上选）
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  function linkKey(l: CrossLink, idx: number) { return `${l.source_file}|${l.target_file}|${idx}` }

  // 筛选后的列表
  const filtered = useMemo(() => {
    return allLinks.filter(l => {
      if (filterTypes.size > 0 && !filterTypes.has(l.link_type)) return false
      if (filterClusters.size > 0 && !filterClusters.has(l.source_cluster_id) && !filterClusters.has(l.target_cluster_id)) return false
      return true
    })
  }, [allLinks, filterTypes, filterClusters])

  // 出现过的类型集合
  const availableTypes = useMemo(() => {
    const s = new Set<string>()
    allLinks.forEach(l => s.add(l.link_type))
    return [...s]
  }, [allLinks])

  // 出现过的组集合
  const availableClusters = useMemo(() => {
    const s = new Set<string>()
    allLinks.forEach(l => { s.add(l.source_cluster_id); s.add(l.target_cluster_id) })
    return [...s].map(cid => {
      const c = clusters.find(x => x.id === cid)
      const rawName = c?.root_path ? c.root_path.split('/').pop() || c.root_path : cid
      return {
        id: cid,
        label: clusterNameMode === 'smart' ? (c?.label || rawName) : rawName,
      }
    })
  }, [allLinks, clusters, clusterNameMode])

  function toggleType(t: string) {
    const next = new Set(filterTypes)
    if (next.has(t)) next.delete(t); else next.add(t)
    setFilterTypes(next)
  }

  function toggleCluster(cid: string) {
    const next = new Set(filterClusters)
    if (next.has(cid)) next.delete(cid); else next.add(cid)
    setFilterClusters(next)
  }

  function toggleSelect(l: CrossLink, idx: number) {
    const k = linkKey(l, idx)
    const next = new Set(selectedKeys)
    if (next.has(k)) next.delete(k); else next.add(k)
    setSelectedKeys(next)
  }

  function selectAllFiltered() {
    const next = new Set<string>()
    filtered.forEach((l) => next.add(linkKey(l, allLinks.indexOf(l))))
    setSelectedKeys(next)
  }

  function clearSelection() { setSelectedKeys(new Set()) }

  async function handleApply() {
    if (!scanId || selectedKeys.size === 0) return
    const indexes = allLinks
      .map((l, i) => selectedKeys.has(linkKey(l, i)) ? i : -1)
      .filter(i => i >= 0)
    if (indexes.length === 0) return
    setApplying(true)
    setApplyResult(null)
    try {
      const r = await applyCrossLinks(scanId, indexes)
      const msgs: string[] = [`同步 ${r.applied}/${r.total} 条`]
      const allGraphs = new Set<string>()
      r.results.forEach((x: Record<string, any>) => x.graphs?.forEach((g: string) => allGraphs.add(g)))  // eslint-disable-line @typescript-eslint/no-explicit-any
      if (allGraphs.size > 0) msgs.push(`影响图谱：${[...allGraphs].join('、')}`)
      const skipped = r.results.filter((x: Record<string, any>) => !x.applied)  // eslint-disable-line @typescript-eslint/no-explicit-any
      if (skipped.length > 0) msgs.push(`${skipped.length} 条跳过（两边都不在任何图谱）`)
      setApplyResult(msgs.join(' · '))
      setSelectedKeys(new Set())
    } catch (e: unknown) {
      setApplyResult(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplying(false)
    }
  }

  const hasFilter = filterTypes.size > 0 || filterClusters.size > 0

  return (
    <div className={`w-[480px] flex-shrink-0 border-l overflow-y-auto ${
      isDark ? 'border-white/10 bg-[#1C1C1E]/90' : 'border-black/5 bg-white/70'
    } backdrop-blur-2xl`}>
      <div className="p-4">
        {/* 头部 */}
        <div className="flex items-center justify-between mb-3">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
            🔭 跨组关联
            <span className={`ml-2 text-[11px] font-normal ${isDark ? 'text-white/40' : 'text-black/40'}`}>
              {filtered.length}/{allLinks.length}
            </span>
          </h3>
          <button
            onClick={onClose}
            className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
            }`}
          >✕</button>
        </div>

        {/* 筛选栏 */}
        <div className="flex items-center gap-2 mb-3 text-[11px]">
          {/* 类型筛选 */}
          <div className="relative">
            <button
              onClick={() => { setShowTypeMenu(v => !v); setShowClusterMenu(false) }}
              className={`px-2 py-1 rounded-md flex items-center gap-1 ${
                filterTypes.size > 0
                  ? 'bg-amber-500/20 text-amber-400'
                  : isDark ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-black/60 hover:bg-black/10'
              }`}
            >类型 {filterTypes.size > 0 ? `(${filterTypes.size})` : '全部'} <span className="text-[9px]">▾</span></button>
            {showTypeMenu && (
              <div
                onMouseLeave={() => setShowTypeMenu(false)}
                className={`absolute top-full left-0 mt-1 z-30 rounded-lg backdrop-blur-xl border overflow-hidden min-w-[140px] ${
                  isDark ? 'bg-[#1C1C1E]/95 border-white/10' : 'bg-white/95 border-black/10'
                }`}
              >
                {availableTypes.map(t => {
                  const ti = LINK_TYPE_LABELS[t] || { label: t, color: '#888' }
                  const enabled = filterTypes.size === 0 || filterTypes.has(t)
                  return (
                    <button
                      key={t}
                      onClick={() => toggleType(t)}
                      className={`w-full px-3 py-1.5 text-left text-[11px] flex items-center gap-2 ${
                        isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
                      }`}
                    >
                      <div className={`w-3 h-3 rounded-sm flex items-center justify-center ${
                        enabled ? '' : isDark ? 'border border-white/30' : 'border border-black/30'
                      }`} style={enabled ? { background: ti.color } : {}}>
                        {enabled && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg>}
                      </div>
                      <span className={isDark ? 'text-white/80' : 'text-black/80'}>{ti.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* 组筛选 */}
          <div className="relative">
            <button
              onClick={() => { setShowClusterMenu(v => !v); setShowTypeMenu(false) }}
              className={`px-2 py-1 rounded-md flex items-center gap-1 ${
                filterClusters.size > 0
                  ? 'bg-amber-500/20 text-amber-400'
                  : isDark ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-black/60 hover:bg-black/10'
              }`}
            >组 {filterClusters.size > 0 ? `(${filterClusters.size})` : '全部'} <span className="text-[9px]">▾</span></button>
            {showClusterMenu && (
              <div
                onMouseLeave={() => setShowClusterMenu(false)}
                className={`absolute top-full left-0 mt-1 z-30 rounded-lg backdrop-blur-xl border overflow-hidden min-w-[180px] max-h-72 overflow-y-auto ${
                  isDark ? 'bg-[#1C1C1E]/95 border-white/10' : 'bg-white/95 border-black/10'
                }`}
              >
                {/* 命名模式切换 */}
                <div className={`flex border-b px-1 py-1 ${isDark ? 'border-white/10' : 'border-black/5'}`}>
                  <button
                    onClick={() => setClusterNameMode('smart')}
                    className={`flex-1 px-2 py-1 rounded text-[10px] font-medium ${
                      clusterNameMode === 'smart'
                        ? isDark ? 'bg-white/15 text-white' : 'bg-black/10 text-black'
                        : isDark ? 'text-white/50' : 'text-black/50'
                    }`}
                  >智能命名</button>
                  <button
                    onClick={() => setClusterNameMode('raw')}
                    className={`flex-1 px-2 py-1 rounded text-[10px] font-medium ${
                      clusterNameMode === 'raw'
                        ? isDark ? 'bg-white/15 text-white' : 'bg-black/10 text-black'
                        : isDark ? 'text-white/50' : 'text-black/50'
                    }`}
                  >原始名</button>
                </div>
                {availableClusters.map(c => {
                  const enabled = filterClusters.size === 0 || filterClusters.has(c.id)
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleCluster(c.id)}
                      className={`w-full px-3 py-1.5 text-left text-[11px] flex items-center gap-2 ${
                        isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
                      }`}
                    >
                      <div className={`w-3 h-3 rounded-sm flex items-center justify-center ${
                        enabled ? 'bg-amber-500' : isDark ? 'border border-white/30' : 'border border-black/30'
                      }`}>
                        {enabled && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg>}
                      </div>
                      <span className={`truncate ${isDark ? 'text-white/80' : 'text-black/80'}`}>{c.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {hasFilter && (
            <button
              onClick={() => { setFilterTypes(new Set()); setFilterClusters(new Set()) }}
              className={`text-[10px] ${isDark ? 'text-white/40 hover:text-white' : 'text-black/40 hover:text-black'}`}
            >清除</button>
          )}
        </div>

        {/* 同步动作区 */}
        <div className={`mb-3 p-2.5 rounded-xl flex items-center gap-2 ${
          isDark ? 'bg-white/5' : 'bg-black/[0.03]'
        }`}>
          <button
            onClick={selectAllFiltered}
            className={`text-[10px] px-2 py-1 rounded ${
              isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-black/5 hover:bg-black/10 text-black'
            }`}
          >全选筛选 ({filtered.length})</button>
          {selectedKeys.size > 0 && (
            <button
              onClick={clearSelection}
              className={`text-[10px] px-2 py-1 rounded ${
                isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-black/5 hover:bg-black/10 text-black'
              }`}
            >取消</button>
          )}
          <div className="flex-1" />
          <button
            onClick={handleApply}
            disabled={applying || selectedKeys.size === 0 || !scanId}
            className={`text-[11px] px-3 py-1 rounded font-semibold transition-colors ${
              applying || selectedKeys.size === 0
                ? (isDark ? 'bg-blue-500/20 text-blue-300/50 cursor-not-allowed' : 'bg-blue-500/10 text-blue-700/50 cursor-not-allowed')
                : 'bg-[#0A84FF] hover:bg-[#0070E0] text-white'
            }`}
            title="同步选中的关联到已有图谱"
          >
            {applying ? '同步中...' : `🚀 同步到图谱 ${selectedKeys.size > 0 ? `(${selectedKeys.size})` : ''}`}
          </button>
        </div>

        {applyResult && (
          <div className={`mb-3 p-2 rounded-lg text-[11px] ${
            applyResult.startsWith('❌')
              ? (isDark ? 'bg-red-500/15 text-red-300' : 'bg-red-500/10 text-red-700')
              : (isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-500/10 text-emerald-700')
          }`}>
            {applyResult}
          </div>
        )}

        {/* 列表 */}
        <div className="space-y-1.5">
          {filtered.map((l) => {
            const origIdx = allLinks.indexOf(l)
            const k = linkKey(l, origIdx)
            const ti = LINK_TYPE_LABELS[l.link_type] || { label: l.link_type, color: '#888' }
            const srcC = clusters.find(c => c.id === l.source_cluster_id)
            const tgtC = clusters.find(c => c.id === l.target_cluster_id)
            const expanded = expandedIdx === origIdx
            const selected = selectedKeys.has(k)
            return (
              <div
                key={k}
                className={`rounded-xl border overflow-hidden transition-all ${
                  selected
                    ? (isDark ? 'border-blue-500/40 bg-blue-500/10' : 'border-blue-500/30 bg-blue-500/5')
                    : isDark ? 'border-white/10 bg-white/[0.03]' : 'border-black/5 bg-white/40'
                }`}
              >
                <div className="flex items-stretch">
                  {/* 选择框 */}
                  <button
                    onClick={() => toggleSelect(l, origIdx)}
                    className={`px-2 flex-shrink-0 flex items-center ${
                      isDark ? 'hover:bg-white/5' : 'hover:bg-black/[0.03]'
                    }`}
                    title="选中以同步到图谱"
                  >
                    <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                      selected
                        ? 'bg-[#0A84FF] border-[#0A84FF]'
                        : isDark ? 'border-white/30' : 'border-black/30'
                    }`}>
                      {selected && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                  </button>

                  {/* 内容区 */}
                  <button
                    onClick={() => { setExpandedIdx(expanded ? null : origIdx); onSelectLink(l) }}
                    className="flex-1 text-left p-2.5 min-w-0"
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-medium flex-shrink-0" style={{
                        background: ti.color + '20',
                        color: ti.color,
                      }}>{ti.label}</span>
                      <span className={`text-[10px] flex-shrink-0 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                        {Math.round(l.confidence * 100)}%
                      </span>
                    </div>
                    <div className={`text-xs font-medium truncate ${isDark ? 'text-white/90' : 'text-[#1D1D1F]'}`}>
                      {l.source_name}
                    </div>
                    <div className={`text-[10px] truncate mb-1 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                      {srcC?.label || l.source_cluster_id}
                    </div>
                    <div className={`text-center text-[10px] my-0.5 ${isDark ? 'text-white/30' : 'text-black/30'}`}>⇅</div>
                    <div className={`text-xs font-medium truncate ${isDark ? 'text-white/90' : 'text-[#1D1D1F]'}`}>
                      {l.target_name}
                    </div>
                    <div className={`text-[10px] truncate ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                      {tgtC?.label || l.target_cluster_id}
                    </div>
                    {expanded && (
                      <div className={`mt-2 pt-2 border-t text-[11px] leading-relaxed ${
                        isDark ? 'border-white/10 text-white/70' : 'border-black/5 text-black/60'
                      }`}>
                        {l.detail || l.reason || '发现潜在关联'}
                        <div className={`text-[10px] mt-1 truncate ${isDark ? 'text-white/30' : 'text-black/30'}`}>
                          {l.source_file}
                        </div>
                        <div className={`text-[10px] truncate ${isDark ? 'text-white/30' : 'text-black/30'}`}>
                          {l.target_file}
                        </div>
                      </div>
                    )}
                  </button>
                </div>
              </div>
            )
          })}
          {filtered.length === 0 && (
            <div className={`text-center text-xs py-8 ${isDark ? 'text-white/30' : 'text-black/30'}`}>
              无匹配的关联
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
