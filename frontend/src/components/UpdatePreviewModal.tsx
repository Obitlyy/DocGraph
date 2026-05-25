import { useMemo } from 'react'
import type { UpdatePreview } from '../api'

interface Props {
  preview: UpdatePreview
  isDark: boolean
  pending: boolean
  onConfirm: (skipRelations: boolean) => void
  onCancel: () => void
}

function fmtTime(t?: number) {
  if (!t) return ''
  const d = new Date(t * 1000)
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function UpdatePreviewModal({ preview, isDark, pending, onConfirm, onCancel }: Props) {
  const total = preview.added.length + preview.modified.length + preview.deleted.length
  const noChange = total === 0

  const sections = useMemo(() => [
    { key: 'added', label: '新增', items: preview.added, color: '#30D158', icon: '＋' },
    { key: 'modified', label: '修改', items: preview.modified, color: '#FF9F0A', icon: '✎' },
    { key: 'deleted', label: '删除', items: preview.deleted, color: '#FF453A', icon: '−' },
  ], [preview])

  const cardBg = isDark ? 'bg-[#1c1c1e] text-white' : 'bg-white text-[#1d1d1f]'
  const subText = isDark ? 'text-white/50' : 'text-black/50'
  const dimText = isDark ? 'text-white/30' : 'text-black/30'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        className={`${cardBg} rounded-2xl shadow-2xl w-[560px] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden`}
        style={{ animation: 'modalIn 240ms cubic-bezier(0.32,0.72,0,1)' }}
      >
        {/* 头部 */}
        <div className={`px-5 py-4 border-b ${isDark ? 'border-white/10' : 'border-black/5'}`}>
          <h3 className="text-base font-semibold">🔄 增量更新预览</h3>
          <p className={`text-[11px] mt-1 ${dimText} truncate`} title={preview.folder}>
            源目录: {preview.folder}
          </p>
        </div>

        {/* 概览 */}
        <div className={`px-5 py-3 flex items-center gap-4 text-xs ${isDark ? 'bg-white/5' : 'bg-black/[0.02]'}`}>
          {sections.map(s => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span style={{ color: s.color }} className="font-bold">{s.icon}</span>
              <span>{s.label} {s.items.length}</span>
            </div>
          ))}
          <div className={`ml-auto ${dimText}`}>未变 {preview.unchanged_count}</div>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-auto px-5 py-3 space-y-4">
          {noChange && (
            <div className={`text-center py-8 ${subText}`}>
              <div className="text-3xl mb-2">✨</div>
              <p className="text-sm">没有检测到任何变化</p>
              <p className={`text-[11px] mt-1 ${dimText}`}>所有 {preview.unchanged_count} 个文档都是最新的</p>
            </div>
          )}

          {sections.map(s => s.items.length > 0 && (
            <section key={s.key}>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider mb-2 flex items-center gap-2">
                <span style={{ color: s.color }}>{s.icon}</span>
                <span>{s.label} ({s.items.length})</span>
              </h4>
              <ul className="space-y-1">
                {s.items.map(d => (
                  <li
                    key={d.id}
                    className={`text-xs px-3 py-2 rounded-lg flex items-center gap-3 ${
                      isDark ? 'bg-white/[0.04]' : 'bg-black/[0.03]'
                    }`}
                  >
                    <span className="flex-1 truncate" title={d.rel_path}>{d.name}</span>
                    {d.mtime && (
                      <span className={`text-[10px] ${dimText} font-mono`}>{fmtTime(d.mtime)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {/* 底部操作 */}
        <div className={`px-5 py-4 border-t flex items-center gap-2 ${isDark ? 'border-white/10' : 'border-black/5'}`}>
          <p className={`text-[11px] ${dimText} flex-1`}>
            {!noChange && '将先同步文档，再重新分析变化文档，最后整图重推关系'}
          </p>
          <button
            onClick={onCancel}
            disabled={pending}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all active:scale-95 ${
              isDark ? 'bg-white/10 hover:bg-white/15 text-white/80' : 'bg-black/5 hover:bg-black/10 text-black/70'
            }`}
          >
            取消
          </button>
          {!noChange && (
            <>
              <button
                onClick={() => onConfirm(true)}
                disabled={pending}
                title="只同步文档变化和重分类，不重推关系（更快）"
                className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all active:scale-95 disabled:opacity-50 ${
                  isDark ? 'bg-white/10 hover:bg-white/15 text-white/80' : 'bg-black/5 hover:bg-black/10 text-black/70'
                }`}
              >
                仅同步
              </button>
              <button
                onClick={() => onConfirm(false)}
                disabled={pending}
                className="px-4 py-1.5 rounded-lg text-xs font-medium text-white bg-[#007AFF] hover:bg-[#0071E3] transition-all active:scale-95 disabled:opacity-50 shadow-sm shadow-[#007AFF]/30"
              >
                {pending ? '启动中...' : '完整更新'}
              </button>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.96) translateY(8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  )
}
