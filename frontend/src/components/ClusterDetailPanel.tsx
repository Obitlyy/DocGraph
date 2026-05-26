import { useState, useEffect } from 'react'
import type { ScanCluster } from '../api'
import { KIND_LABELS } from './ClusterFilterBar'

interface Props {
  cluster: ScanCluster
  isDark: boolean
  onClose: () => void
  onRequestBuildGraph: (req: { suggestedName: string; files: string[]; commonRoot?: string; source: string }) => void
  onUpdate: (clusterId: string, patch: { label?: string; llm_kind?: string; redundant?: boolean; info_score?: number }) => Promise<void>
  onDelete: (clusterId: string) => Promise<void>
  onSplit: (srcId: string, files: string[], newLabel: string) => Promise<void>
  onAddToMerge: () => void
  inMergeSelection: boolean
}

export default function ClusterDetailPanel({ cluster, isDark, onClose, onRequestBuildGraph, onUpdate, onDelete, onSplit, onAddToMerge, inMergeSelection }: Props) {
  const allFiles = cluster.files

  const SUPPORTED = ['.md', '.txt', '.markdown', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.csv', '.json']
  const docFiles = allFiles.filter(f => {
    const ext = (f.name.split('.').pop() || '').toLowerCase()
    return SUPPORTED.includes('.' + ext)
  })

  // 编辑状态
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState(cluster.label)
  // 拆分选择
  const [splitMode, setSplitMode] = useState(false)
  const [splitSelection, setSplitSelection] = useState<Set<string>>(new Set())

  // cluster 切换时重置
  useEffect(() => {
    setEditingLabel(false)
    setLabelDraft(cluster.label)
    setSplitMode(false)
    setSplitSelection(new Set())
  }, [cluster.id])

  function handleBuildGraph() {
    if (docFiles.length === 0) {
      alert('这个组里没有可识别的文档（需 md/pdf/docx/xlsx 等）')
      return
    }
    onRequestBuildGraph({
      suggestedName: cluster.label,
      files: docFiles.map(f => f.path),
      commonRoot: cluster.root_path,
      source: `全量扫描 · ${cluster.label}`,
    })
  }

  async function handleLabelSave() {
    const next = labelDraft.trim()
    if (!next || next === cluster.label) {
      setEditingLabel(false)
      setLabelDraft(cluster.label)
      return
    }
    await onUpdate(cluster.id, { label: next })
    setEditingLabel(false)
  }

  async function handleSplitConfirm() {
    if (splitSelection.size === 0) {
      setSplitMode(false)
      return
    }
    if (splitSelection.size === allFiles.length) {
      alert('不能拆出全部文件（那会使源群为空）。请取消几个。')
      return
    }
    const newLabel = prompt(`拆出 ${splitSelection.size} 个文件为新群。新群名称：`, '拆分-新群')?.trim()
    if (!newLabel) return
    await onSplit(cluster.id, [...splitSelection], newLabel)
    setSplitMode(false)
    setSplitSelection(new Set())
  }

  function toggleSplitFile(path: string) {
    const next = new Set(splitSelection)
    if (next.has(path)) next.delete(path); else next.add(path)
    setSplitSelection(next)
  }

  return (
    <div className={`w-96 flex-shrink-0 border-l overflow-y-auto ${
      isDark ? 'border-white/10 bg-[#1C1C1E]/90' : 'border-black/5 bg-white/70'
    } backdrop-blur-2xl`}>
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          {editingLabel ? (
            <input
              autoFocus
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              onBlur={handleLabelSave}
              onKeyDown={e => {
                if (e.key === 'Enter') handleLabelSave()
                if (e.key === 'Escape') { setEditingLabel(false); setLabelDraft(cluster.label) }
              }}
              className={`flex-1 px-2 py-1 rounded-lg text-base font-semibold outline-none ${
                isDark ? 'bg-white/10 text-white' : 'bg-black/5 text-[#1D1D1F]'
              }`}
            />
          ) : (
            <h3
              onDoubleClick={() => setEditingLabel(true)}
              className={`text-base font-semibold cursor-text flex-1 mr-2 ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}
              title="双击重命名"
            >
              {cluster.label}
              <span className={`ml-1.5 text-[10px] font-normal ${isDark ? 'text-white/40' : 'text-black/40'}`}>✎</span>
            </h3>
          )}
          <button
            onClick={onClose}
            className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
            }`}
          >✕</button>
        </div>
        <div className={`text-[11px] mb-4 truncate ${isDark ? 'text-white/40' : 'text-black/40'}`}>
          {cluster.root_path}
        </div>

        <button
          onClick={handleBuildGraph}
          disabled={docFiles.length === 0}
          className={`w-full mb-2 px-4 py-2.5 rounded-xl font-medium text-sm transition-all flex items-center justify-center gap-2 ${
            docFiles.length === 0
              ? (isDark ? 'bg-white/5 text-white/30 cursor-not-allowed' : 'bg-black/5 text-black/30 cursor-not-allowed')
              : (isDark ? 'bg-blue-500/90 hover:bg-blue-500 text-white' : 'bg-[#0A84FF] hover:bg-[#006FE0] text-white')
          }`}
          title={docFiles.length === 0 ? '本组不含可识别文档' : ''}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/>
            <line x1="8.6" y1="7.5" x2="15.4" y2="7.5"/>
            <line x1="7.5" y1="8.5" x2="10.5" y2="15.5"/>
            <line x1="16.5" y1="8.5" x2="13.5" y2="15.5"/>
          </svg>
          绘制文档图谱
          <span className="text-xs opacity-70 ml-1">({docFiles.length} 个文档)</span>
        </button>

        {/* 编辑动作区 */}
        <div className="flex gap-1.5 mb-4">
          <button
            onClick={onAddToMerge}
            className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
              inMergeSelection
                ? 'bg-blue-500 text-white'
                : isDark ? 'bg-white/10 hover:bg-white/15 text-white/80' : 'bg-black/5 hover:bg-black/10 text-black/70'
            }`}
            title="加入/移出多选合并"
          >
            {inMergeSelection ? '✓ 待合并' : '⎣⎤ 合并'}
          </button>
          <button
            onClick={() => setSplitMode(v => !v)}
            className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
              splitMode
                ? 'bg-purple-500 text-white'
                : isDark ? 'bg-white/10 hover:bg-white/15 text-white/80' : 'bg-black/5 hover:bg-black/10 text-black/70'
            }`}
          >
            {splitMode ? `拆出 ${splitSelection.size}` : '⋮⋮ 拆分'}
          </button>
          <button
            onClick={() => onDelete(cluster.id)}
            className={`px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
              isDark ? 'bg-red-500/15 hover:bg-red-500/25 text-red-300' : 'bg-red-500/10 hover:bg-red-500/20 text-red-600'
            }`}
            title="删除该组（不会动硬盘文件）"
          >
            🗑
          </button>
        </div>

        {splitMode && (
          <div className={`mb-4 p-3 rounded-xl text-[11px] ${isDark ? 'bg-purple-500/15 text-purple-200' : 'bg-purple-500/10 text-purple-700'}`}>
            <div className="font-semibold mb-1">拆分模式</div>
            <div className="opacity-80 mb-2">下面勾选要拆出的文件，点「确认拆出」。</div>
            <div className="flex gap-1.5">
              <button
                onClick={handleSplitConfirm}
                disabled={splitSelection.size === 0}
                className="flex-1 px-2 py-1 rounded bg-purple-500 hover:bg-purple-600 text-white disabled:opacity-30 transition-colors"
              >确认拆出 ({splitSelection.size})</button>
              <button
                onClick={() => { setSplitMode(false); setSplitSelection(new Set()) }}
                className={`px-2 py-1 rounded ${isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-black/10 hover:bg-black/15'}`}
              >取消</button>
            </div>
          </div>
        )}

        {/* 类型 + 冷余 可编辑 */}
        <div className={`text-[10px] uppercase tracking-widest font-semibold mb-2 ${isDark ? 'text-white/40' : 'text-black/40'}`}>属性</div>
        <div className="flex items-center gap-2 mb-3">
          <select
            value={cluster.llm_kind || cluster.kind}
            onChange={e => onUpdate(cluster.id, { llm_kind: e.target.value })}
            className={`flex-1 px-2 py-1.5 rounded-lg text-xs outline-none ${
              isDark ? 'bg-white/10 text-white' : 'bg-black/5 text-[#1D1D1F]'
            }`}
          >
            {Object.entries(KIND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v} ({k})</option>
            ))}
          </select>
          <button
            onClick={() => onUpdate(cluster.id, { redundant: !cluster.redundant })}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              cluster.redundant
                ? 'bg-orange-500/30 text-orange-300'
                : isDark ? 'bg-white/10 text-white/60 hover:bg-white/15' : 'bg-black/5 text-black/60 hover:bg-black/10'
            }`}
            title="标记为冷余/缓存"
          >
            {cluster.redundant ? '✓ 冗余' : '· 冗余'}
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-2">
          <Stat label="文件" value={cluster.file_count.toString()} isDark={isDark} />
          <Stat label="大小" value={`${(cluster.total_bytes / 1024 / 1024).toFixed(1)}M`} isDark={isDark} />
          <Stat label="信息分" value={Math.round(cluster.info_score).toString()} isDark={isDark} />
        </div>

        {/* 信息分可视化 */}
        <div className={`mb-4 p-3 rounded-xl ${isDark ? 'bg-white/5' : 'bg-black/[0.03]'}`}>
          <div className={`text-[10px] mb-1.5 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
            信息分详情
          </div>
          <ScoreBar label="文件数" value={Math.min(100, cluster.file_count * 2)} text={`${cluster.file_count}`} isDark={isDark} color="#7BA7CC" />
          <ScoreBar label="大小" value={Math.min(100, Math.log2(cluster.total_bytes + 1) * 4)} text={`${(cluster.total_bytes / 1024 / 1024).toFixed(1)} MB`} isDark={isDark} color="#7DBF96" />
          <ScoreBar label="类型多样" value={Math.min(100, Object.keys(cluster.ext_distribution || {}).length * 14)} text={`${Object.keys(cluster.ext_distribution || {}).length} 种`} isDark={isDark} color="#C9A065" />
          <ScoreBar label="综合信息分" value={cluster.info_score} text={Math.round(cluster.info_score).toString()} isDark={isDark} color="#9B7DB8" bold />
        </div>

        {cluster.split_hint && cluster.split_hint.length > 0 && (
          <div className={`mb-4 p-2.5 rounded-xl text-[11px] ${
            isDark ? 'bg-purple-500/10 text-purple-200' : 'bg-purple-500/5 text-purple-700'
          }`}>
            <div className="font-semibold mb-1">💡 LLM 拆分建议</div>
            <div className="opacity-80">{cluster.split_hint.join(' / ')}</div>
          </div>
        )}

        <div className={`text-[10px] uppercase tracking-widest font-semibold mb-2 mt-2 flex items-center gap-2 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
          <span>文件清单 ({cluster.file_count})</span>
          {splitMode && splitSelection.size > 0 && (
            <span className="text-purple-400 normal-case">· 选中 {splitSelection.size}</span>
          )}
        </div>
        <div className="space-y-1">
          {cluster.files.slice(0, 100).map(f => {
            const selected = splitMode && splitSelection.has(f.path)
            return (
              <div
                key={f.path}
                onClick={() => splitMode && toggleSplitFile(f.path)}
                className={`text-xs px-2 py-1.5 rounded transition-colors ${
                  splitMode ? 'cursor-pointer' : ''
                } ${
                  selected
                    ? 'bg-purple-500/30 ring-1 ring-purple-400'
                    : isDark ? 'bg-white/5 text-white/80 hover:bg-white/10' : 'bg-black/[0.03] text-black/70 hover:bg-black/[0.06]'
                }`}
              >
                <div className="flex items-center gap-2">
                  {splitMode && (
                    <div className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center flex-shrink-0 ${
                      selected ? 'bg-purple-500' : isDark ? 'border border-white/30' : 'border border-black/30'
                    }`}>
                      {selected && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-mono">{f.name}</div>
                    <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/30' : 'text-black/30'}`}>
                      {(f.size / 1024).toFixed(1)} KB · {f.rel_dir || '根目录'}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
          {cluster.files.length > 100 && (
            <div className={`text-xs text-center py-2 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
              … 还有 {cluster.files.length - 100} 个
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ========== 辅助小组件 ==========

function ScoreBar({ label, value, text, isDark, color, bold }: {
  label: string; value: number; text: string; isDark: boolean; color: string; bold?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="flex justify-between items-center text-[10px] mb-0.5">
        <span className={`${bold ? 'font-semibold' : ''} ${isDark ? 'text-white/60' : 'text-black/60'}`}>{label}</span>
        <span className={`font-mono ${isDark ? 'text-white/50' : 'text-black/50'}`}>{text}</span>
      </div>
      <div className={`h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  return (
    <div className={`px-3 py-2 rounded-xl ${isDark ? 'bg-white/5' : 'bg-black/[0.03]'}`}>
      <div className={`text-[10px] ${isDark ? 'text-white/40' : 'text-black/40'}`}>{label}</div>
      <div className={`text-sm font-semibold mt-0.5 ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>{value}</div>
    </div>
  )
}
