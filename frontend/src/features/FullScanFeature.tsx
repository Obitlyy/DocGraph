import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLocale } from '../locale'
import {
  fetchFullScanDefaults,
  fetchFullScanList,
  startFullScan,
  fetchFullScanStatus,
  fetchFullScanResult,
  fetchFullScanHistory,
  loadFullScanHistory,
  deleteFullScanHistory,
  renameFullScanHistory,
  updateCluster,
  deleteCluster,
  mergeClusters,
  splitCluster,
} from '../api'
import type {
  FullScanRoot,
  ScanRootListing,
  SubdirInfo,
  FullScanResult,
  ScanCluster,
  FullScanHistoryItem,
  CrossLink,
} from '../api'
import ClusterUniverse from '../components/ClusterUniverse'
import ClusterFilterBar, { type ClusterFilter } from '../components/ClusterFilterBar'
import ClusterDetailPanel from '../components/ClusterDetailPanel'
import CrossLinkPanel from '../components/CrossLinkPanel'
import { HistoryCard, IconBtn, Check, SubdirRow, formatTime, phaseLabel } from '../components/FullScanHelpers'
import { getAutoScanConfig, updateAutoScanConfig, getSchedulerStatus } from '../api'
import type { AutoScanConfig, SchedulerStatus } from '../api'

interface Props {
  isDark: boolean
  onRequestBuildGraph: (req: { suggestedName: string; files: string[]; commonRoot?: string; source: string }) => void
}

type Step = 'pick-roots' | 'pick-subdirs' | 'scanning' | 'result'

export default function FullScanFeature({ isDark, onRequestBuildGraph }: Props) {
  const { t } = useLocale()
  const [step, setStep] = useState<Step>('pick-roots')
  const [roots, setRoots] = useState<FullScanRoot[]>([])
  const [selectedRoots, setSelectedRoots] = useState<Set<string>>(new Set())
  const [listings, setListings] = useState<ScanRootListing[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [useLlm, setUseLlm] = useState(true)
  const [deepExplore, setDeepExplore] = useState(false)

  const [history, setHistory] = useState<FullScanHistoryItem[]>([])

  const [status, setStatus] = useState<{ phase: string; message: string; progress: number; error: string | null }>({
    phase: '', message: '', progress: 0, error: null,
  })
  const [result, setResult] = useState<FullScanResult | null>(null)
  const [selectedCluster, setSelectedCluster] = useState<ScanCluster | null>(null)

  // 过滤状态
  const [filter, setFilter] = useState<ClusterFilter>({
    minScore: 0,
    hideRedundant: false,
    enabledKinds: new Set(),
  })

  // 合并选择状态（多选群 ID）
  const [mergeSelection, setMergeSelection] = useState<Set<string>>(new Set())

  // 跨组关联详情视图
  const [activeCrossLink, setActiveCrossLink] = useState<CrossLink | null>(null)

  // 自动扫描快捷状态
  const [autoScanEnabled, setAutoScanEnabled] = useState<boolean | null>(null)
  const [autoScanStatus, setAutoScanStatus] = useState<SchedulerStatus | null>(null)

  // 轮询 interval ref，组件卸载时清理
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [])

  // 初始化 + 历史列表
  useEffect(() => {
    fetchFullScanDefaults().then(d => {
      setRoots(d.roots)
      setSelectedRoots(new Set(d.roots.filter(r => r.exists).map(r => r.path)))
    }).catch(() => {})

    refreshHistory()
    loadAutoScanState()
  }, [])

  function refreshHistory() {
    fetchFullScanHistory().then(r => setHistory(r.items)).catch(() => {})
  }

  async function loadAutoScanState() {
    try {
      const [cfg, sts] = await Promise.all([getAutoScanConfig(), getSchedulerStatus()])
      setAutoScanEnabled(cfg.enabled ?? false)
      setAutoScanStatus(sts)
    } catch { /* 静默 */ }
  }

  async function toggleAutoScan() {
    try {
      const cfg = await getAutoScanConfig()
      const next: AutoScanConfig = {
        enabled: !cfg.enabled,
        interval_minutes: cfg.interval_minutes ?? 120,
        watch_directories: cfg.watch_directories ?? [],
        options: cfg.options ?? { max_new_files_per_scan: 50, analysis_mode: 'fast' },
      }
      await updateAutoScanConfig(next)
      setAutoScanEnabled(next.enabled)
      const sts = await getSchedulerStatus()
      setAutoScanStatus(sts)
    } catch { /* 静默 */ }
  }

  async function handleListSubdirs() {
    const paths = [...selectedRoots]
    if (paths.length === 0) return
    const resp = await fetchFullScanList(paths)
    setListings(resp.items)
    const def = new Set<string>()
    for (const item of resp.items) {
      for (const sd of item.subdirs) {
        if (sd.file_count >= 10) def.add(sd.path)
      }
    }
    setSelectedPaths(def)
    setStep('pick-subdirs')
  }

  async function handleStartScan() {
    if (selectedPaths.size === 0) return
    try {
      await startFullScan([...selectedPaths], useLlm, undefined, deepExplore)
      setStep('scanning')
      pollStatus()
    } catch (e: any) {
      alert(e.message)
    }
  }

  function pollStatus() {
    // 清理之前可能存在的轮询
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
    }
    const iv = setInterval(async () => {
      try {
        const s = await fetchFullScanStatus()
        setStatus({
          phase: s.phase,
          message: s.message,
          progress: s.progress,
          error: s.error,
        })
        if (!s.running) {
          clearInterval(iv)
          pollIntervalRef.current = null
          if (s.error) return
          const r = await fetchFullScanResult()
          if (r) {
            setResult(r)
            setStep('result')
            refreshHistory()
          }
        }
      } catch {
        // 轮询出错时静默忽略，等下一次重试
      }
    }, 600)
    pollIntervalRef.current = iv
  }

  async function handleOpenHistory(item: FullScanHistoryItem) {
    try {
      const r = await loadFullScanHistory(item.id)
      setResult(r)
      setSelectedCluster(null)
      setMergeSelection(new Set())
      setStep('result')
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function handleDeleteHistory(item: FullScanHistoryItem) {
    if (!confirm(`确认删除「${item.name}」？`)) return
    try {
      await deleteFullScanHistory(item.id)
      refreshHistory()
      if (result?.id === item.id) {
        setResult(null)
        setStep('pick-roots')
      }
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function handleRenameHistory(item: FullScanHistoryItem) {
    const name = prompt('重命名扫描', item.name)?.trim()
    if (!name || name === item.name) return
    try {
      await renameFullScanHistory(item.id, name)
      refreshHistory()
      if (result?.id === item.id) setResult({ ...result, name })
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function handleRescan(paths: string[]) {
    // 直接复用之前的路径，跳过选择步骤
    if (paths.length === 0) return
    try {
      await startFullScan(paths, useLlm, undefined, deepExplore)
      setStep('scanning')
      pollStatus()
    } catch (e: any) {
      alert(e.message)
    }
  }

  // ============== 群编辑 ==============

  async function refreshResult() {
    if (!result?.id) return
    try {
      const r = await loadFullScanHistory(result.id)
      setResult(r)
      // 同步刷新选中的群
      if (selectedCluster) {
        const updated = r.clusters.find(c => c.id === selectedCluster.id)
        setSelectedCluster(updated || null)
      }
    } catch {
      // 加载失败时静默忽略
    }
  }

  async function handleClusterUpdate(clusterId: string, patch: Parameters<typeof updateCluster>[2]) {
    if (!result?.id) return
    try {
      await updateCluster(result.id, clusterId, patch)
      await refreshResult()
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function handleClusterDelete(clusterId: string) {
    if (!result?.id) return
    if (!confirm('确认删除这个群？子群会一起删除，不会动硬盘文件。')) return
    try {
      await deleteCluster(result.id, clusterId)
      setSelectedCluster(null)
      const next = new Set(mergeSelection)
      next.delete(clusterId)
      setMergeSelection(next)
      await refreshResult()
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function handleClusterSplit(srcId: string, files: string[], newLabel: string) {
    if (!result?.id) return
    try {
      await splitCluster(result.id, srcId, { file_paths: files, new_label: newLabel })
      await refreshResult()
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function handleMerge() {
    if (!result?.id || mergeSelection.size < 2) return
    const ids = [...mergeSelection]
    const head = result.clusters.find(c => c.id === ids[0])
    const newLabel = prompt(
      `合并 ${ids.length} 个群为一个。新名称：`,
      head?.label || ''
    )?.trim()
    if (!newLabel) return
    try {
      await mergeClusters(result.id, { cluster_ids: ids, new_label: newLabel })
      setMergeSelection(new Set())
      await refreshResult()
    } catch (e: any) {
      alert(e.message)
    }
  }

  function toggleMergeSelect(id: string) {
    const next = new Set(mergeSelection)
    if (next.has(id)) next.delete(id); else next.add(id)
    setMergeSelection(next)
  }

  // ============== 过滤计算 ==============

  const filteredClusters = useMemo(() => {
    if (!result) return []
    return result.clusters.filter(c => {
      if (c.info_score < filter.minScore) return false
      if (filter.hideRedundant && c.redundant) return false
      if (filter.enabledKinds.size > 0) {
        const k = c.llm_kind || c.kind
        if (!filter.enabledKinds.has(k)) return false
      }
      return true
    })
  }, [result, filter])

  // ============== 渲染 ==============
  if (step === 'pick-roots') {
    return (
      <div className="h-full overflow-auto">
        <div className="max-w-3xl mx-auto px-8 py-10">
          <h2 className={`text-2xl font-semibold tracking-tight mb-2 text-center ${
            isDark ? 'text-white' : 'text-[#1D1D1F]'
          }`}>全量扫描</h2>
          <p className={`text-sm text-center mb-4 ${isDark ? 'text-white/50' : 'text-black/50'}`}>
            {t('fullscan.pickRoots')}
          </p>

          {/* 深度探索主打开关 */}
          <div className={`mb-8 rounded-2xl backdrop-blur-xl border p-4 ${
            deepExplore
              ? (isDark ? 'bg-blue-500/10 border-blue-500/30' : 'bg-blue-500/5 border-blue-500/20')
              : (isDark ? 'bg-white/5 border-white/10' : 'bg-white/60 border-black/5')
          }`}>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setDeepExplore(v => !v)}
                className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${
                  deepExplore ? 'bg-[#0A84FF]' : isDark ? 'bg-white/20' : 'bg-black/15'
                }`}
              >
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
                  deepExplore ? 'translate-x-[22px]' : 'translate-x-0.5'
                }`} />
              </button>
              <div className="flex-1">
                <div className={`text-sm font-semibold flex items-center gap-1.5 ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
                  {t('fullscan.deepExplore')}
                </div>
                <div className={`text-[11px] mt-0.5 leading-relaxed ${isDark ? 'text-white/50' : 'text-black/50'}`}>
                  自动发现跨组文件的逻辑关联，帮你避免重复造轮子
                </div>
              </div>
            </div>
            {deepExplore && (
              <div className={`mt-3 pt-3 border-t text-[10px] flex items-center gap-4 ${
                isDark ? 'border-white/10 text-white/40' : 'border-black/5 text-black/40'
              }`}>
                <span>① 快速摘要每个文件</span>
                <span>② 跨组比对候选</span>
                <span>③ 精读确认关联</span>
              </div>
            )}
          </div>

          {/* 自动扫描快捷开关 */}
          {autoScanEnabled !== null && (
            <div className={`mb-8 rounded-2xl backdrop-blur-xl border p-4 ${
              autoScanEnabled
                ? (isDark ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-emerald-500/5 border-emerald-500/20')
                : (isDark ? 'bg-white/5 border-white/10' : 'bg-white/60 border-black/5')
            }`}>
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleAutoScan}
                  className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${
                    autoScanEnabled ? 'bg-[#34C759]' : isDark ? 'bg-white/20' : 'bg-black/15'
                  }`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
                    autoScanEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                  }`} />
                </button>
                <div className="flex-1">
                  <div className={`text-sm font-semibold flex items-center gap-1.5 ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
                    {t('autoscan.title')}
                  </div>
                  <div className={`text-[11px] mt-0.5 leading-relaxed ${isDark ? 'text-white/50' : 'text-black/50'}`}>
                    {autoScanEnabled
                      ? (autoScanStatus?.next_scan_in_seconds != null && autoScanStatus.next_scan_in_seconds > 0
                          ? `已启用 · ${t('autoscan.nextScan')} ${Math.floor(autoScanStatus.next_scan_in_seconds / 60)} 分钟后`
                          : `已启用 · 每 ${autoScanStatus?.interval_minutes || 120} 分钟自动检测变化`)
                      : '定时检测文件变化，自动分类和推断关系'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 历史扫描 */}
          {history.length > 0 && (
            <section className="mb-8">
              <div className={`text-[11px] uppercase tracking-widest font-semibold mb-3 ${
                isDark ? 'text-white/40' : 'text-black/40'
              }`}>
                历史扫描 ({history.length})
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {history.map(item => (
                  <HistoryCard
                    key={item.id}
                    item={item}
                    isDark={isDark}
                    onOpen={() => handleOpenHistory(item)}
                    onDelete={() => handleDeleteHistory(item)}
                    onRename={() => handleRenameHistory(item)}
                    onRescan={() => handleRescan(item.scan_paths)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 新建扫描 */}
          <section>
            <div className={`text-[11px] uppercase tracking-widest font-semibold mb-3 ${
              isDark ? 'text-white/40' : 'text-black/40'
            }`}>
              新建扫描
            </div>
            <div className={`rounded-2xl backdrop-blur-xl border overflow-hidden ${
              isDark ? 'bg-white/5 border-white/10' : 'bg-white/60 border-black/5'
            }`}>
              {roots.map(r => {
                const checked = selectedRoots.has(r.path)
                return (
                  <button
                    key={r.path}
                    disabled={!r.exists}
                    onClick={() => {
                      const next = new Set(selectedRoots)
                      if (checked) next.delete(r.path); else next.add(r.path)
                      setSelectedRoots(next)
                    }}
                    className={`w-full flex items-center gap-3 px-5 py-4 transition-colors text-left ${
                      !r.exists ? 'opacity-30 cursor-not-allowed' :
                        isDark ? 'hover:bg-white/5' : 'hover:bg-black/[0.03]'
                    }`}
                  >
                    <Check checked={checked} isDark={isDark} />
                    <div className="flex-1">
                      <div className={`text-sm font-medium ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>{r.label}</div>
                      <div className={`text-xs mt-0.5 ${isDark ? 'text-white/40' : 'text-black/40'}`}>{r.path}</div>
                    </div>
                    {!r.exists && <span className="text-[10px] text-red-400">不存在</span>}
                  </button>
                )
              })}
            </div>

            <button
              disabled={selectedRoots.size === 0}
              onClick={handleListSubdirs}
              className={`w-full mt-6 py-3.5 rounded-xl text-sm font-semibold transition-all ${
                selectedRoots.size === 0
                  ? 'opacity-30 cursor-not-allowed bg-white/10 text-white'
                  : 'bg-[#0A84FF] text-white hover:bg-[#0070E0]'
              }`}
            >
              下一步：查看子目录
            </button>
          </section>
        </div>
      </div>
    )
  }

  if (step === 'pick-subdirs') {
    const totalFiles = [...selectedPaths].reduce((sum, p) => {
      for (const item of listings) {
        const sd = item.subdirs.find(s => s.path === p)
        if (sd) return sum + sd.file_count
      }
      return sum
    }, 0)

    return (
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-auto px-8 py-6">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className={`text-xl font-semibold tracking-tight ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
                  选择具体目录
                </h2>
                <p className={`text-xs mt-1 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                  已选 {selectedPaths.size} 个目录 · ~{totalFiles} 个文件
                </p>
              </div>
              <button
                onClick={() => setStep('pick-roots')}
                className={`text-xs ${isDark ? 'text-white/50 hover:text-white' : 'text-black/50 hover:text-black'}`}
              >
                ← 返回
              </button>
            </div>

            {listings.map(item => (
              <section key={item.root} className="mb-6">
                <div className={`text-xs uppercase tracking-widest font-semibold mb-2 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                  {item.root}
                </div>
                <div className={`rounded-2xl backdrop-blur-xl border overflow-hidden ${
                  isDark ? 'bg-white/5 border-white/10' : 'bg-white/60 border-black/5'
                }`}>
                  {item.subdirs.map(sd => (
                    <SubdirRow key={sd.path} sd={sd} isDark={isDark}
                      checked={selectedPaths.has(sd.path)}
                      onToggle={() => {
                        const next = new Set(selectedPaths)
                        if (next.has(sd.path)) next.delete(sd.path); else next.add(sd.path)
                        setSelectedPaths(next)
                      }}
                    />
                  ))}
                  {item.loose_files.length > 0 && (
                    <div className={`px-5 py-3 text-xs ${isDark ? 'text-white/40 bg-white/[0.02]' : 'text-black/40 bg-black/[0.02]'}`}>
                      📄 根目录散落 {item.loose_files.length} 个文件 (会自动扫描)
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className={`flex-shrink-0 border-t px-8 py-4 flex items-center gap-4 ${
          isDark ? 'border-white/10 bg-black/40' : 'border-black/5 bg-white/60'
        }`}>
          <label className={`flex items-center gap-2 text-sm ${isDark ? 'text-white/70' : 'text-black/70'}`}>
            <input type="checkbox" checked={useLlm} onChange={e => setUseLlm(e.target.checked)} />
            启用 LLM 智能聚合
          </label>
          {deepExplore && (
            <span className={`text-xs px-2 py-1 rounded-full ${
              isDark ? 'bg-blue-500/20 text-blue-300' : 'bg-blue-500/15 text-blue-700'
            }`}>
              深度探索已开启
            </span>
          )}
          <div className="flex-1" />
          <button
            disabled={selectedPaths.size === 0}
            onClick={handleStartScan}
            className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              selectedPaths.size === 0
                ? 'opacity-30 cursor-not-allowed bg-white/10 text-white'
                : 'bg-[#0A84FF] text-white hover:bg-[#0070E0]'
            }`}
          >
            {t('fullscan.startScan')} {selectedPaths.size > 0 ? `(${selectedPaths.size})` : ''}
          </button>
        </div>
      </div>
    )
  }

  if (step === 'scanning') {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-md px-8">
          <div className="text-7xl mb-6 animate-pulse">🔍</div>
          <div className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
            {phaseLabel(status.phase)}
          </div>
          <div className={`text-sm ${isDark ? 'text-white/50' : 'text-black/50'}`}>{status.message}</div>
          {status.progress > 0 && (
            <div className={`mt-4 text-xs ${isDark ? 'text-white/40' : 'text-black/40'}`}>
              已扫 {status.progress} 个文件
            </div>
          )}
          {status.error && (
            <div className="mt-6 text-sm text-red-400">❌ {status.error}</div>
          )}
        </div>
      </div>
    )
  }

  // result
  return (
    <div className="h-full flex flex-col">
      <div className={`flex-shrink-0 px-6 py-3 flex items-center gap-4 border-b ${
        isDark ? 'border-white/10' : 'border-black/5'
      }`}>
        {/* 返回 */}
        <button
          onClick={() => { setStep('pick-roots'); setResult(null); refreshHistory() }}
          className={`text-xs ${isDark ? 'text-white/50 hover:text-white' : 'text-black/50 hover:text-black'}`}
        >
          ← {t('graph.back').replace('← ', '')}
        </button>

        <h2 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
          {result?.name || t('fullscan.result')}
        </h2>
        <span className={`text-xs ${isDark ? 'text-white/40' : 'text-black/40'}`}>
          {result?.cluster_count || 0} 群 · {result?.file_count || 0} 文件 · {result?.elapsed_sec || 0}s
        </span>
        {result && (
          <span className={`text-[10px] px-2 py-1 rounded-full ${
            result.llm_used
              ? (isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-500/15 text-emerald-700')
              : (isDark ? 'bg-orange-500/20 text-orange-300' : 'bg-orange-500/15 text-orange-700')
          }`}>
            {result.llm_used ? `✨ LLM 已重审 ${result.llm_review_count}/${result.cluster_count}` : '⚠️ 仅算法聚合'}
          </span>
        )}
        {result && result.cross_links && result.cross_links.length > 0 && (
          <button
            onClick={() => setActiveCrossLink(result.cross_links![0])}
            className={`text-[10px] px-2 py-1 rounded-full cursor-pointer transition-colors hover:scale-105 ${
              isDark ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30' : 'bg-amber-500/15 text-amber-700 hover:bg-amber-500/25'
            }`}
            title="查看所有跨组关联"
          >
            {result.cross_links.length} 条跨组关联
          </button>
        )}
        <div className="flex-1" />

        {/* 多选合并提示 */}
        {mergeSelection.size > 0 && (
          <>
            <span className={`text-xs ${isDark ? 'text-white/60' : 'text-black/60'}`}>
              已选 {mergeSelection.size} 群
            </span>
            <button
              onClick={handleMerge}
              disabled={mergeSelection.size < 2}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                mergeSelection.size < 2
                  ? 'opacity-30 cursor-not-allowed bg-blue-500/30 text-white'
                  : 'bg-blue-500 hover:bg-blue-600 text-white'
              }`}
            >
              合并 ({mergeSelection.size})
            </button>
            <button
              onClick={() => setMergeSelection(new Set())}
              className={`text-xs ${isDark ? 'text-white/50 hover:text-white' : 'text-black/50 hover:text-black'}`}
            >取消选择</button>
          </>
        )}

        <button
          onClick={() => result && handleRescan(result.scan_paths)}
          disabled={!result?.scan_paths?.length}
          className={`text-xs px-3 py-1.5 rounded-lg ${
            isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-black/5 hover:bg-black/10 text-black'
          } disabled:opacity-30`}
          title="用相同路径重新扫描"
        >
          ↻ 重新扫描
        </button>
      </div>

      {/* 过滤栏 */}
      {result && (
        <ClusterFilterBar
          filter={filter}
          onChange={setFilter}
          totalCount={result.clusters.length}
          visibleCount={filteredClusters.length}
          isDark={isDark}
        />
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative">
          {result && (
            <ClusterUniverse
              clusters={filteredClusters}
              isDark={isDark}
              onClusterClick={setSelectedCluster}
              mergeSelection={mergeSelection}
              onToggleMerge={toggleMergeSelect}
              crossLinks={result?.cross_links}
              onCrossLinkClick={setActiveCrossLink}
            />
          )}
        </div>

        {selectedCluster && (
          <ClusterDetailPanel
            cluster={selectedCluster}
            isDark={isDark}
            onClose={() => setSelectedCluster(null)}
            onRequestBuildGraph={onRequestBuildGraph}
            onUpdate={handleClusterUpdate}
            onDelete={handleClusterDelete}
            onSplit={handleClusterSplit}
            onAddToMerge={() => toggleMergeSelect(selectedCluster.id)}
            inMergeSelection={mergeSelection.has(selectedCluster.id)}
          />
        )}

        {/* 跨组关联详情面板 */}
        {activeCrossLink && (
          <CrossLinkPanel
            link={activeCrossLink}
            allLinks={result?.cross_links || []}
            clusters={result?.clusters || []}
            isDark={isDark}
            onClose={() => setActiveCrossLink(null)}
            onSelectLink={setActiveCrossLink}
            scanId={result?.id}
          />
        )}
      </div>
    </div>
  )
}
