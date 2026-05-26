import { useState, useEffect } from 'react'
import {
  getAutoScanConfig, updateAutoScanConfig,
  getSchedulerStatus, triggerScanNow, fetchGraphs,
} from '../api'
import type { AutoScanConfig, WatchDirectory, SchedulerStatus, GraphSummary } from '../api'
import { useLocale } from '../locale'

interface Props {
  isDark: boolean
}

export default function AutoScanSettings({ isDark }: Props) {
  const { t } = useLocale()
  const [config, setConfig] = useState<AutoScanConfig | null>(null)
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [graphs, setGraphs] = useState<GraphSummary[]>([])
  const [showGraphPicker, setShowGraphPicker] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    try {
      const [cfg, sts, gs] = await Promise.all([
        getAutoScanConfig(),
        getSchedulerStatus(),
        fetchGraphs(),
      ])
      // 防御后端返回不完整的数据
      setConfig({
        enabled: cfg.enabled ?? false,
        interval_minutes: cfg.interval_minutes ?? 120,
        watch_directories: cfg.watch_directories ?? [],
        options: cfg.options ?? { max_new_files_per_scan: 50, analysis_mode: 'fast' },
      })
      setStatus(sts)
      setGraphs(gs ?? [])
    } catch { /* 后端未启动时静默 */ }
  }

  async function save(patch: Partial<AutoScanConfig>) {
    if (!config) return
    const next = { ...config, ...patch }
    setConfig(next)
    setSaving(true)
    try {
      await updateAutoScanConfig(next)
      const sts = await getSchedulerStatus()
      setStatus(sts)
    } catch { /* 静默 */ }
    setSaving(false)
  }

  async function handleAddGraph(g: GraphSummary) {
    if (!config) return
    // 需要获取图谱的 folder 字段
    const exists = config.watch_directories.some(w => w.graph_name === g.name)
    if (exists) return
    const entry: WatchDirectory = {
      path: '',  // 将从后端获取
      graph_name: g.name,
      label: g.name,
    }
    // 获取图谱详情来拿 folder
    try {
      const res = await fetch(`${getApiBase()}/graphs/${encodeURIComponent(g.name)}`)
      const data = await res.json()
      if (!data.folder) {
        alert('该图谱没有关联的源文件夹路径，无法监控')
        return
      }
      entry.path = data.folder
    } catch { return }

    const next = {
      ...config,
      watch_directories: [...config.watch_directories, entry],
    }
    await save(next)
    setShowGraphPicker(false)
  }

  function handleRemoveWatch(path: string) {
    if (!config) return
    save({
      watch_directories: config.watch_directories.filter(w => w.path !== path),
    })
  }

  async function handleTriggerNow() {
    try {
      await triggerScanNow()
      // 短暂延迟后刷新状态
      setTimeout(loadAll, 2000)
    } catch { /* 静默 */ }
  }

  if (!config) {
    return (
      <div className={`text-xs py-4 text-center ${isDark ? 'text-white/30' : 'text-black/30'}`}>
        {t('autoscan.loading')}
      </div>
    )
  }

  const watchedGraphNames = new Set(config.watch_directories.map(w => w.graph_name))

  return (
    <div className="space-y-4">
      {/* 标题 + 开关 */}
      <div className="flex items-center justify-between">
        <h4 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
          {t('autoscan.title')}
        </h4>
        <button
          onClick={() => save({ enabled: !config.enabled })}
          className={`relative w-10 h-6 rounded-full transition-colors ${
            config.enabled ? 'bg-[#34C759]' : isDark ? 'bg-white/20' : 'bg-black/15'
          }`}
        >
          <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all ${
            config.enabled ? 'left-5' : 'left-1'
          }`} />
        </button>
      </div>

      {config.enabled && (
        <>
          {/* 间隔选择 */}
          <div>
            <label className={`text-[11px] uppercase tracking-wider font-medium ${isDark ? 'text-white/40' : 'text-black/40'}`}>
              {t('autoscan.interval')}
            </label>
            <select
              value={config.interval_minutes}
              onChange={e => save({ interval_minutes: parseInt(e.target.value) })}
              className={`mt-1 w-full px-3 py-2 rounded-lg text-sm outline-none ${
                isDark ? 'bg-white/10 text-white' : 'bg-black/5 text-[#1D1D1F]'
              }`}
            >
              <option value={30}>30 {t('autoscan.minutes')}</option>
              <option value={60}>1 {t('autoscan.hour')}</option>
              <option value={120}>2 {t('autoscan.hours')}</option>
              <option value={360}>6 {t('autoscan.hours')}</option>
              <option value={720}>12 {t('autoscan.hours')}</option>
            </select>
          </div>

          {/* 监控目录列表 */}
          <div>
            <label className={`text-[11px] uppercase tracking-wider font-medium ${isDark ? 'text-white/40' : 'text-black/40'}`}>
              {t('autoscan.watchDirs')} ({config.watch_directories.length})
            </label>
            <div className="mt-1 space-y-1">
              {config.watch_directories.map(w => (
                <div
                  key={w.path}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg ${
                    isDark ? 'bg-white/5' : 'bg-black/[0.03]'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs font-medium truncate ${isDark ? 'text-white/80' : 'text-black/80'}`}>
                      {w.label}
                    </div>
                    <div className={`text-[10px] truncate ${isDark ? 'text-white/30' : 'text-black/30'}`}>
                      {w.path}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemoveWatch(w.path)}
                    className={`w-6 h-6 rounded flex items-center justify-center text-[11px] ${
                      isDark ? 'hover:bg-red-500/20 text-red-300' : 'hover:bg-red-500/10 text-red-500'
                    }`}
                  >✕</button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowGraphPicker(true)}
              className={`mt-2 w-full px-3 py-2 rounded-lg text-xs font-medium border border-dashed transition-colors ${
                isDark
                  ? 'border-white/20 text-white/60 hover:border-white/40 hover:text-white'
                  : 'border-black/15 text-black/50 hover:border-black/30 hover:text-black'
              }`}
            >
              + {t('autoscan.addFromGraphs')}
            </button>
          </div>

          {/* 图谱选择弹出 */}
          {showGraphPicker && (
            <div className={`p-3 rounded-xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-black/[0.02] border-black/5'}`}>
              <div className={`text-[11px] mb-2 font-medium ${isDark ? 'text-white/60' : 'text-black/60'}`}>
                {t('autoscan.selectGraph')}
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {graphs.filter(g => !watchedGraphNames.has(g.name)).map(g => (
                  <button
                    key={g.name}
                    onClick={() => handleAddGraph(g)}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                      isDark ? 'hover:bg-white/10 text-white/80' : 'hover:bg-black/5 text-black/80'
                    }`}
                  >
                    {g.name} <span className={`${isDark ? 'text-white/30' : 'text-black/30'}`}>({g.doc_count} 篇)</span>
                  </button>
                ))}
                {graphs.filter(g => !watchedGraphNames.has(g.name)).length === 0 && (
                  <div className={`text-[11px] text-center py-2 ${isDark ? 'text-white/30' : 'text-black/30'}`}>
                    所有图谱已添加
                  </div>
                )}
              </div>
              <button
                onClick={() => setShowGraphPicker(false)}
                className={`mt-2 text-[11px] ${isDark ? 'text-white/40' : 'text-black/40'}`}
              >取消</button>
            </div>
          )}

          {/* 状态 + 手动触发 */}
          <div className={`flex items-center justify-between p-3 rounded-xl ${
            isDark ? 'bg-white/5' : 'bg-black/[0.03]'
          }`}>
            <div>
              {status?.next_scan_in_seconds != null && status.next_scan_in_seconds > 0 ? (
                <span className={`text-[11px] ${isDark ? 'text-white/50' : 'text-black/50'}`}>
                  {t('autoscan.nextScan')}: {formatCountdown(status.next_scan_in_seconds)}
                </span>
              ) : (
                <span className={`text-[11px] ${isDark ? 'text-white/50' : 'text-black/50'}`}>
                  {t('autoscan.waiting')}
                </span>
              )}
            </div>
            <button
              onClick={handleTriggerNow}
              disabled={config.watch_directories.length === 0}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                config.watch_directories.length === 0
                  ? (isDark ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-black/5 text-black/20 cursor-not-allowed')
                  : (isDark ? 'bg-blue-500/80 hover:bg-blue-500 text-white' : 'bg-[#0A84FF] hover:bg-[#006FE0] text-white')
              }`}
            >
              {t('autoscan.scanNow')}
            </button>
          </div>

          {/* 保存提示 */}
          {saving && (
            <div className={`text-[10px] text-center ${isDark ? 'text-white/30' : 'text-black/30'}`}>
              保存中...
            </div>
          )}
        </>
      )}
    </div>
  )
}

function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
}

function getApiBase(): string {
  return typeof window !== 'undefined' && window.location.protocol === 'file:'
    ? 'http://localhost:8000/api'
    : '/api'
}
