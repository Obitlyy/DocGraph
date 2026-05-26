import { useState, useEffect, useRef } from 'react'
import { getScanHistory, markScansRead } from '../api'
import type { ScanHistory, ScanRecord } from '../api'
import { useLocale } from '../locale'

interface Props {
  isDark: boolean
}

export default function NotificationBell({ isDark }: Props) {
  const { t } = useLocale()
  const [history, setHistory] = useState<ScanHistory | null>(null)
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // 每 30 秒轮询一次通知
  useEffect(() => {
    fetchHistory()
    const iv = setInterval(fetchHistory, 30000)
    return () => clearInterval(iv)
  }, [])

  // 点击外部关闭面板
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function fetchHistory() {
    try {
      const data = await getScanHistory(15)
      setHistory({ scans: data.scans || [], unread_count: data.unread_count || 0 })
    } catch { /* 静默 */ }
  }

  async function handleMarkAllRead() {
    try {
      await markScansRead()
      setHistory(prev => prev ? {
        ...prev,
        unread_count: 0,
        scans: prev.scans.map(s => ({ ...s, read: true })),
      } : null)
    } catch { /* 静默 */ }
  }

  const unread = history?.unread_count || 0

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(v => !v)}
        className={`w-9 h-9 rounded-full flex items-center justify-center transition-all relative ${
          isDark
            ? 'hover:bg-white/10 text-white/70 hover:text-white'
            : 'hover:bg-black/5 text-black/60 hover:text-black'
        }`}
        aria-label={t('notifications.title')}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className={`absolute right-0 top-full mt-2 w-80 rounded-2xl border backdrop-blur-2xl shadow-xl z-50 overflow-hidden ${
          isDark ? 'bg-[#1C1C1E]/95 border-white/10' : 'bg-white/95 border-black/10'
        }`}>
          {/* 头部 */}
          <div className={`px-4 py-3 flex items-center justify-between border-b ${
            isDark ? 'border-white/10' : 'border-black/5'
          }`}>
            <h4 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
              {t('notifications.title')}
            </h4>
            {unread > 0 && (
              <button
                onClick={handleMarkAllRead}
                className={`text-[11px] ${isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'}`}
              >
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>

          {/* 列表 */}
          <div className="max-h-80 overflow-y-auto">
            {(!history || !history.scans || history.scans.length === 0) ? (
              <div className={`text-center text-xs py-8 ${isDark ? 'text-white/30' : 'text-black/30'}`}>
                {t('notifications.empty')}
              </div>
            ) : (
              history.scans.map(scan => (
                <NotificationItem key={scan.id} scan={scan} isDark={isDark} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function NotificationItem({ scan, isDark }: { scan: ScanRecord; isDark: boolean }) {
  const timeStr = formatRelative(scan.timestamp)

  if (scan.status === 'skipped') {
    return (
      <div className={`px-4 py-2.5 border-b last:border-b-0 ${isDark ? 'border-white/5' : 'border-black/[0.03]'}`}>
        <div className="flex items-center gap-2">
          <span className="text-[11px]">⏭</span>
          <span className={`text-[11px] flex-1 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
            扫描跳过（有任务在运行）
          </span>
          <span className={`text-[10px] ${isDark ? 'text-white/25' : 'text-black/25'}`}>{timeStr}</span>
        </div>
      </div>
    )
  }

  if (scan.status === 'error') {
    return (
      <div className={`px-4 py-2.5 border-b last:border-b-0 ${isDark ? 'border-white/5' : 'border-black/[0.03]'}`}>
        <div className="flex items-center gap-2">
          <span className="text-[11px]">⚠️</span>
          <span className={`text-[11px] flex-1 ${isDark ? 'text-red-300' : 'text-red-600'}`}>
            扫描出错
          </span>
          <span className={`text-[10px] ${isDark ? 'text-white/25' : 'text-black/25'}`}>{timeStr}</span>
        </div>
      </div>
    )
  }

  // completed
  const hasChanges = scan.total_added > 0 || scan.total_modified > 0 || scan.total_deleted > 0
  return (
    <div className={`px-4 py-2.5 border-b last:border-b-0 ${
      !scan.read ? (isDark ? 'bg-blue-500/5' : 'bg-blue-500/[0.03]') : ''
    } ${isDark ? 'border-white/5' : 'border-black/[0.03]'}`}>
      <div className="flex items-start gap-2">
        <span className="text-[11px] mt-0.5">{hasChanges ? '✅' : '·'}</span>
        <div className="flex-1 min-w-0">
          {hasChanges ? (
            <div className={`text-[11px] font-medium ${isDark ? 'text-white/80' : 'text-black/80'}`}>
              {scan.total_added > 0 && <span className="text-green-500">+{scan.total_added} 新 </span>}
              {scan.total_modified > 0 && <span className="text-amber-500">~{scan.total_modified} 改 </span>}
              {scan.total_deleted > 0 && <span className="text-red-400">-{scan.total_deleted} 删</span>}
            </div>
          ) : (
            <div className={`text-[11px] ${isDark ? 'text-white/40' : 'text-black/40'}`}>
              无变化
            </div>
          )}
          {scan.results.filter(r => r.new_doc_names?.length).map(r => (
            <div key={r.graph_name} className={`text-[10px] mt-0.5 truncate ${isDark ? 'text-white/30' : 'text-black/30'}`}>
              {r.new_doc_names?.slice(0, 3).join('、')}
            </div>
          ))}
        </div>
        <div className="flex flex-col items-end flex-shrink-0">
          <span className={`text-[10px] ${isDark ? 'text-white/25' : 'text-black/25'}`}>{timeStr}</span>
          {hasChanges && scan.results.some(r => r.analyzed) && (
            <span className={`text-[9px] mt-0.5 px-1.5 py-0.5 rounded-full ${
              isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-500/15 text-emerald-700'
            }`}>🤖 已分析</span>
          )}
        </div>
      </div>
    </div>
  )
}

function formatRelative(ts: number): string {
  const now = Date.now() / 1000
  const diff = now - ts
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}
