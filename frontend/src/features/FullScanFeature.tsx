import { useEffect, useMemo, useRef, useState } from 'react'
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
  applyCrossLinks,
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
import ClusterFilterBar, { type ClusterFilter, KIND_LABELS } from '../components/ClusterFilterBar'

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
    }).catch(console.error)

    refreshHistory()
  }, [])

  function refreshHistory() {
    fetchFullScanHistory().then(r => setHistory(r.items)).catch(console.error)
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
      } catch (err) {
        console.warn('[pollStatus] 轮询出错:', err)
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
    } catch (e) {
      console.error(e)
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
                  🔭 {t('fullscan.deepExplore')}
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
              🔭 深度探索已开启
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
            🔭 {result.cross_links.length} 条跨组关联
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

function phaseLabel(phase: string): string {
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

function formatTime(ts: number): string {
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

function HistoryCard({ item, isDark, onOpen, onDelete, onRename, onRescan }: {
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

function IconBtn({ children, onClick, title, isDark, danger }: {
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

function Check({ checked, isDark }: { checked: boolean; isDark: boolean }) {
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

function SubdirRow({ sd, isDark, checked, onToggle }: {
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

function ClusterDetailPanel({ cluster, isDark, onClose, onRequestBuildGraph, onUpdate, onDelete, onSplit, onAddToMerge, inMergeSelection }: {
  cluster: ScanCluster
  isDark: boolean
  onClose: () => void
  onRequestBuildGraph: (req: { suggestedName: string; files: string[]; commonRoot?: string; source: string }) => void
  onUpdate: (clusterId: string, patch: { label?: string; llm_kind?: string; redundant?: boolean; info_score?: number }) => Promise<void>
  onDelete: (clusterId: string) => Promise<void>
  onSplit: (srcId: string, files: string[], newLabel: string) => Promise<void>
  onAddToMerge: () => void
  inMergeSelection: boolean
}) {
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


// ============ 跨组关联面板 ============

const LINK_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  duplicate: { label: '重复造轮子', color: '#FF6B6B' },
  shared_data: { label: '共享数据', color: '#4ECDC4' },
  upstream: { label: '上下游', color: '#45B7D1' },
  reference: { label: '引用参考', color: '#96C93D' },
  evolution: { label: '版本迭代', color: '#DDA0DD' },
  topic: { label: '相同主题', color: '#FFA07A' },
}

function CrossLinkPanel({ link, allLinks, clusters, isDark, onClose, onSelectLink, scanId }: {
  link: CrossLink
  allLinks: CrossLink[]
  clusters: ScanCluster[]
  isDark: boolean
  onClose: () => void
  onSelectLink: (l: CrossLink) => void
  scanId?: string
}) {
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
    filtered.forEach((l, i) => next.add(linkKey(l, allLinks.indexOf(l))))
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
      r.results.forEach(x => x.graphs?.forEach(g => allGraphs.add(g)))
      if (allGraphs.size > 0) msgs.push(`影响图谱：${[...allGraphs].join('、')}`)
      const skipped = r.results.filter(x => !x.applied)
      if (skipped.length > 0) msgs.push(`${skipped.length} 条跳过（两边都不在任何图谱）`)
      setApplyResult(msgs.join(' · '))
      setSelectedKeys(new Set())
    } catch (e: any) {
      setApplyResult(`❌ ${e.message}`)
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
