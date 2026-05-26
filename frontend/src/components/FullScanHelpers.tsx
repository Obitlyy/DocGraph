import { useState } from 'react'
import type { FullScanHistoryItem, SubdirInfo } from '../api'

// ========== 辅助函数 ==========

export function phaseLabel(phase: string): string {
  return {
    starting: '准备中',
    scanning: '扫描文件',
    clustering: '算法聚合',
    llm_review: 'LLM 智能审阅',
    deep_summarize: '🔭 深度探索 - 快速摘要',
    deep_candidates: '🔭 深度探索 - 跨组比对',
    deep_confirm: '🔭 深度探索 - 精读确认',
    deep_done: '🔭 深度探索完成',
    done: '完成',
    error: '错误',
  }[phase] || phase
}

export function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString()
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mm = `${d.getMinutes()}`.padStart(2, '0')
  if (sameDay) return `今天 ${hh}:${mm}`
  if (yesterday) return `昨天 ${hh}:${mm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

// ========== 小型组件 ==========

export function HistoryCard({ item, isDark, onOpen, onDelete, onRename, onRescan }: {
  item: FullScanHistoryItem
  isDark: boolean
  onOpen: () => void
  onDelete: () => void
  onRename: () => void
  onRescan: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onOpen}
      className={`relative cursor-pointer rounded-2xl backdrop-blur-xl border p-4 transition-all hover:scale-[1.01] ${
        isDark ? 'bg-white/5 border-white/10 hover:bg-white/[0.07]'
               : 'bg-white/60 border-black/5 hover:bg-white/80'
      }`}
    >
      <div className={`text-sm font-semibold mb-1 truncate ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
        {item.name}
      </div>
      <div className={`text-[11px] mb-2 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
        {formatTime(item.scanned_at)} · {item.cluster_count} 群 · {item.file_count} 文件
      </div>
      <div className={`text-[10px] truncate ${isDark ? 'text-white/30' : 'text-black/30'}`}>
        {item.scan_paths.map(p => p.split('/').pop()).join(' · ')}
      </div>

      {/* 悬浮操作 */}
      {hover && (
        <div
          onClick={e => e.stopPropagation()}
          className={`absolute top-2 right-2 flex items-center gap-1 px-1 py-1 rounded-lg backdrop-blur-xl ${
            isDark ? 'bg-black/60' : 'bg-white/80'
          }`}
        >
          <IconBtn title="重命名" isDark={isDark} onClick={onRename}>✎</IconBtn>
          <IconBtn title="重新扫描相同路径" isDark={isDark} onClick={onRescan}>↻</IconBtn>
          <IconBtn title="删除" isDark={isDark} onClick={onDelete} danger>🗑</IconBtn>
        </div>
      )}

      {item.llm_used && (
        <div className={`absolute bottom-2 right-3 text-[9px] px-1.5 py-0.5 rounded-full ${
          isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-500/15 text-emerald-700'
        }`}>
          ✨ LLM
        </div>
      )}
    </div>
  )
}

export function IconBtn({ children, onClick, title, isDark, danger }: {
  children: React.ReactNode; onClick: () => void; title: string; isDark: boolean; danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-6 h-6 text-[11px] rounded flex items-center justify-center transition-colors ${
        danger
          ? (isDark ? 'hover:bg-red-500/30 text-red-300' : 'hover:bg-red-500/20 text-red-600')
          : (isDark ? 'hover:bg-white/10 text-white/70' : 'hover:bg-black/5 text-black/60')
      }`}
    >{children}</button>
  )
}

export function Check({ checked, isDark }: { checked: boolean; isDark: boolean }) {
  return (
    <div className={`w-5 h-5 rounded-md flex items-center justify-center transition-all flex-shrink-0 ${
      checked
        ? 'bg-[#0A84FF]'
        : isDark ? 'border border-white/30' : 'border border-black/30'
    }`}>
      {checked && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      )}
    </div>
  )
}

export function SubdirRow({ sd, isDark, checked, onToggle }: {
  sd: SubdirInfo; isDark: boolean; checked: boolean; onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-3 px-5 py-3 transition-colors text-left ${
        isDark ? 'hover:bg-white/5' : 'hover:bg-black/[0.03]'
      }`}
    >
      <Check checked={checked} isDark={isDark} />
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium truncate ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
          {sd.name}
        </div>
        <div className={`text-[11px] mt-0.5 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
          {sd.file_count} 个文件 · {(sd.total_bytes / 1024 / 1024).toFixed(1)} MB
        </div>
      </div>
    </button>
  )
}
