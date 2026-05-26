import { useState, useEffect, useCallback, useRef } from 'react'
import { GraphData, GraphSummary, fetchGraphs, fetchGraph, scanFolder, scanFromFiles, startClassify, startRelations, fetchTaskStatus, deleteGraph, renameGraph, previewUpdate, startUpdate, confirmPhases, getOrganizeSuggestions } from '../api'
import type { UpdatePreview, Phase, Doc, OrganizeSuggestion } from '../api'
import { useLocale } from '../locale'
import GraphView from '../components/GraphView'
import DocList from '../components/DocList'
import RelationList from '../components/RelationList'
import DocDetail from '../components/DocDetail'
import SegmentedControl from '../components/SegmentedControl'
import UpdatePreviewModal from '../components/UpdatePreviewModal'
import PhaseProposeModal from '../components/PhaseProposeModal'
import PhaseView from '../components/PhaseView'

type Tab = 'graph' | 'docs' | 'relations' | 'phases'

import type { PendingImport, SelectedDocument } from '../App'

interface Props {
  isDark: boolean
  onToggleTheme: () => void
  pendingImport: PendingImport | null
  onConsumePendingImport: () => void
  selectedDocument?: SelectedDocument | null
  onConsumeSelectedDocument?: () => void
}

export default function GraphFeature({ isDark, onToggleTheme, pendingImport, onConsumePendingImport, selectedDocument, onConsumeSelectedDocument }: Props) {
  const { t } = useLocale()
  const [graphs, setGraphs] = useState<GraphSummary[]>([])
  const [currentGraph, setCurrentGraph] = useState<GraphData | null>(null)
  const [currentName, setCurrentName] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('graph')
  const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null)
  const [taskMsg, setTaskMsg] = useState('')
  const [classifyRunning, setClassifyRunning] = useState(false)
  const [relationsRunning, setRelationsRunning] = useState(false)
  const [classifyProgress, setClassifyProgress] = useState({ done: 0, total: 0, current: '' })
  const [updateRunning, setUpdateRunning] = useState(false)
  const [updateProgress, setUpdateProgress] = useState({ phase: '', current: '', progress: 0, total: 0 })
  const [updatePreview, setUpdatePreview] = useState<UpdatePreview | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState(false)
  const [phaseModalOpen, setPhaseModalOpen] = useState(false)
  const [phaseModalPending, setPhaseModalPending] = useState(false)
  const [phasesRunning, setPhasesRunning] = useState(false)
  const [importDialog, setImportDialog] = useState<PendingImport | null>(null)
  const [importNameInput, setImportNameInput] = useState('')
  const [importing, setImporting] = useState(false)

  // 整理建议状态
  const [organizeSuggestions, setOrganizeSuggestions] = useState<OrganizeSuggestion[] | null>(null)
  const [organizeLoading, setOrganizeLoading] = useState(false)

  // 用 useRef 追踪轮询 interval 和最新的 currentName
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentNameRef = useRef(currentName)
  currentNameRef.current = currentName

  // 组件卸载时清理轮询
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [])

  // 新建扫描
  const [newFolder, setNewFolder] = useState('')
  const [newName, setNewName] = useState('')

  // 分析模式
  const [analysisMode, setAnalysisMode] = useState<'fast' | 'standard' | 'deep'>('standard')
  const [showAnalysisMenu, setShowAnalysisMenu] = useState(false)

  useEffect(() => {
    fetchGraphs().then(setGraphs).catch(() => {})
  }, [])

  useEffect(() => {
    if (pendingImport) {
      setImportDialog(pendingImport)
      setImportNameInput(pendingImport.suggestedName)
      onConsumePendingImport()
    }
  }, [pendingImport, onConsumePendingImport])

  // Handle selected document from search feature
  useEffect(() => {
    if (selectedDocument) {
      const loadAndSelect = async () => {
        try {
          // Load the graph if it's different
          if (selectedDocument.graphName !== currentName) {
            await loadGraph(selectedDocument.graphName)
          }
          // Select the document
          const doc = currentGraph?.docs.find(d => d.id === selectedDocument.docId)
          if (doc) {
            setSelectedDoc(doc)
            setActiveTab('docs')
          }
          // Mark as consumed
          if (onConsumeSelectedDocument) {
            onConsumeSelectedDocument()
          }
        } catch (e: unknown) {
          setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      loadAndSelect()
    }
  }, [selectedDocument, currentName, currentGraph, onConsumeSelectedDocument])

  const handleImportConfirm = async () => {
    if (!importDialog || !importNameInput.trim()) return
    setImporting(true)
    try {
      setTaskMsg(`导入中：${importNameInput} (${importDialog.files.length} 个文件)…`)
      await scanFromFiles(importNameInput.trim(), importDialog.files, importDialog.commonRoot)
      const updatedGraphs = await fetchGraphs()
      setGraphs(updatedGraphs)
      await loadGraph(importNameInput.trim())
      setTaskMsg(`✅ 已导入 ${importDialog.files.length} 个文档`)
      setImportDialog(null)
      setImportNameInput('')
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setImporting(false)
    }
  }

  const loadGraph = async (name: string) => {
    try {
      const data = await fetchGraph(name)
      setCurrentGraph(data)
      setCurrentName(name)
      setSelectedDoc(null)
    } catch (e: unknown) {
      setTaskMsg(e instanceof Error ? e.message : String(e))
    }
  }

  const handleScan = async () => {
    if (!newFolder || !newName) return
    try {
      setTaskMsg('扫描中...')
      await scanFolder(newFolder, newName)
      const updatedGraphs = await fetchGraphs()
      setGraphs(updatedGraphs)
      await loadGraph(newName)
      setTaskMsg('✅ 扫描完成')
      setNewFolder('')
      setNewName('')
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleClassify = async (mode: string = 'standard') => {
    if (!currentName) return
    try {
      await startClassify(currentName, undefined, mode)
      setClassifyRunning(true)
      setTaskMsg(`分类进行中 (${mode})...`)
      pollTask('classify')
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleRelations = async (mode: string = 'standard') => {
    if (!currentName) return
    try {
      await startRelations(currentName, undefined, mode)
      setRelationsRunning(true)
      setTaskMsg(`关系推断中 (${mode})...`)
      pollTask('relations')
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleUpdate = async () => {
    if (!currentName) return
    try {
      setTaskMsg('检测变化中...')
      const preview = await previewUpdate(currentName)
      setUpdatePreview(preview)
      setTaskMsg('')
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleConfirmUpdate = async (skipRelations: boolean) => {
    if (!currentName || !updatePreview) return
    try {
      setPendingUpdate(true)
      await startUpdate(currentName, 'standard', undefined, skipRelations)
      setUpdateRunning(true)
      setUpdateProgress({ phase: 'starting', current: '', progress: 0, total: 0 })
      setTaskMsg('增量更新中...')
      setUpdatePreview(null)
      pollTask('update')
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPendingUpdate(false)
    }
  }

  const handleOrganizeSuggestions = async () => {
    if (!currentName) return
    setOrganizeLoading(true)
    setOrganizeSuggestions(null)
    try {
      const r = await getOrganizeSuggestions(currentName)
      setOrganizeSuggestions(Array.isArray(r.suggestions) ? r.suggestions : [])
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setOrganizeLoading(false)
    }
  }

  const handleProposePhases = () => {
    if (!currentName) return
    setPhaseModalOpen(true)
  }

  const handleConfirmPhases = async (phases: Phase[], generateSummaries: boolean) => {
    if (!currentName) return
    try {
      setPhaseModalPending(true)
      const r = await confirmPhases(currentName, phases, generateSummaries)
      setPhaseModalOpen(false)
      if (generateSummaries) {
        setPhasesRunning(true)
        setTaskMsg(`阶段已保存，生成总结中 (${r.phase_count} 个)...`)
        pollTask('phases')
      } else {
        setTaskMsg(`✅ 阶段划分完成 (${r.phase_count} 个)`)
        await loadGraph(currentName)
      }
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPhaseModalPending(false)
    }
  }

  const pollTask = (taskName: string) => {
    // 清理之前可能存在的轮询
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
    }
    const iv = setInterval(async () => {
      try {
        const status: any = await fetchTaskStatus(taskName)
        if (taskName === 'classify') {
          setClassifyProgress({ done: status.progress, total: status.total, current: status.current })
        }
        if (taskName === 'update') {
          setUpdateProgress({
            phase: status.phase || '',
            current: status.current || '',
            progress: status.progress || 0,
            total: status.total || 0,
          })
        }
        if (!status.running) {
          clearInterval(iv)
          pollIntervalRef.current = null
          if (taskName === 'classify') setClassifyRunning(false)
          if (taskName === 'relations') setRelationsRunning(false)
          if (taskName === 'update') setUpdateRunning(false)
          if (taskName === 'phases') setPhasesRunning(false)
          if (status.result?.error) {
            setTaskMsg(`❌ ${status.result.error}`)
          } else {
            if (taskName === 'update') {
              const r = status.result || {}
              const sync = r.sync || {}
              const cls = r.classify
              const rel = r.relations
              const parts = [
                `+${sync.added_count || 0} ~${sync.modified_count || 0} -${sync.deleted_count || 0}`,
              ]
              if (cls) parts.push(`分类 ${cls.doc_count} 篇`)
              if (rel) parts.push(`关系 ${rel.relation_count} 条`)
              setTaskMsg(`✅ 增量更新完成 · ${parts.join(' · ')}`)
            } else if (taskName === 'phases') {
              setTaskMsg(`✅ 阶段总结生成完成 (${status.result?.phase_count || 0} 个)`)
            } else {
              setTaskMsg(`✅ ${taskName === 'classify' ? '分类' : '关系推断'}完成`)
            }
            // 使用 ref 获取最新的 currentName，避免闭包陈旧
            await loadGraph(currentNameRef.current)
          }
        }
      } catch (err) {
        // 网络错误时静默，等下次重试
      }
    }, 1000)
    pollIntervalRef.current = iv
  }

  const handleDeleteGraph = async (name: string) => {
    if (!confirm(`确定删除图谱「${name}」？此操作不可恢复。`)) return
    try {
      await deleteGraph(name)
      const updatedGraphs = await fetchGraphs()
      setGraphs(updatedGraphs)
      if (currentName === name) {
        setCurrentGraph(null)
        setCurrentName('')
        setSelectedDoc(null)
      }
      setTaskMsg(`✅ 已删除 ${name}`)
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleRenameGraph = async (oldName: string) => {
    const newN = prompt('重命名图谱', oldName)?.trim()
    if (!newN || newN === oldName) return
    try {
      const r = await renameGraph(oldName, newN)
      const updatedGraphs = await fetchGraphs()
      setGraphs(updatedGraphs)
      if (currentName === oldName) {
        setCurrentName(r.name)
        if (currentGraph) setCurrentGraph({ ...currentGraph, name: r.name })
      }
      setTaskMsg(`✅ 已重命名为 ${r.name}`)
    } catch (e: unknown) {
      setTaskMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleRescanGraph = async (name: string) => {
    if (currentName !== name) await loadGraph(name)
    handleUpdate()
  }

  const handleDocUpdated = async () => {
    if (currentName) {
      const data = await fetchGraph(currentName)
      setCurrentGraph(data)
      if (selectedDoc) {
        const updated = data.docs.find(d => d.id === selectedDoc.id)
        if (updated) setSelectedDoc(updated)
      }
    }
  }

  const handleNodeClick = useCallback((docId: string) => {
    setCurrentGraph(prev => {
      if (!prev) return prev
      const doc = prev.docs.find(d => d.id === docId)
      if (doc) setSelectedDoc(doc)
      return prev
    })
  }, [])

  const tabs: { key: Tab; label: string }[] = [
    { key: 'graph', label: t('tab.graph') },
    { key: 'docs', label: t('tab.docs') },
    { key: 'relations', label: t('tab.relations') },
    { key: 'phases', label: t('tab.phases') },
  ]

  const anyRunning = classifyRunning || relationsRunning || updateRunning || phasesRunning

  // ============ 未选择图谱：居中列表 ============
  if (!currentGraph) {
    return (
      <div className="h-full overflow-auto">
        <div className="max-w-3xl mx-auto px-8 py-10">
          <h2 className={`text-2xl font-semibold tracking-tight mb-2 text-center ${
            isDark ? 'text-white' : 'text-[#1D1D1F]'
          }`}>{t('graph.title')}</h2>
          <p className={`text-sm text-center mb-8 ${isDark ? 'text-white/50' : 'text-black/50'}`}>
            {t('graph.selectOrCreate')}
          </p>

          {/* 图谱卡片网格 */}
          {graphs.length > 0 && (
            <section className="mb-8">
              <div className={`text-[11px] uppercase tracking-widest font-semibold mb-3 ${
                isDark ? 'text-white/40' : 'text-black/40'
              }`}>
                {t('graph.existing')} ({graphs.length})
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {graphs.map(g => (
                  <GraphCard
                    key={g.name}
                    graph={g}
                    isDark={isDark}
                    onOpen={() => loadGraph(g.name)}
                    onDelete={() => handleDeleteGraph(g.name)}
                    onRename={() => handleRenameGraph(g.name)}
                    onRescan={() => handleRescanGraph(g.name)}
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
              {t('graph.new')}
            </div>
            <div
              className={`rounded-2xl backdrop-blur-xl border p-5 transition-all ${
                isDark ? 'bg-white/5 border-white/10' : 'bg-white/60 border-black/5'
              }`}
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('ring-2', 'ring-blue-500/50') }}
              onDragLeave={e => { e.currentTarget.classList.remove('ring-2', 'ring-blue-500/50') }}
              onDrop={e => {
                e.preventDefault()
                e.currentTarget.classList.remove('ring-2', 'ring-blue-500/50')
                // Electron/浏览器拖拽文件夹
                const files = e.dataTransfer.files
                if (files.length > 0) {
                  const file = files[0] as any
                  const path = file.path || file.name
                  if (path) {
                    setNewFolder(path)
                    if (!newName) setNewName(path.split('/').pop() || path.split('\\').pop() || '')
                  }
                }
              }}
            >
              <div className={`text-center py-4 mb-3 border-2 border-dashed rounded-xl ${
                isDark ? 'border-white/10 text-white/30' : 'border-black/10 text-black/30'
              }`}>
                <p className="text-2xl mb-1">📂</p>
                <p className="text-xs">拖拽文件夹到这里，或在下方输入路径</p>
              </div>
              <input
                className={`w-full px-3 py-2.5 text-sm rounded-lg mb-2 outline-none transition-colors ${
                  isDark
                    ? 'bg-white/5 border border-white/10 focus:border-blue-500/50 text-white placeholder-white/30'
                    : 'bg-black/[0.03] border border-black/10 focus:border-blue-500/50 text-[#1D1D1F] placeholder-black/30'
                }`}
                placeholder={t('graph.folderPath')}
                value={newFolder}
                onChange={e => setNewFolder(e.target.value)}
              />
              <input
                className={`w-full px-3 py-2.5 text-sm rounded-lg mb-3 outline-none transition-colors ${
                  isDark
                    ? 'bg-white/5 border border-white/10 focus:border-blue-500/50 text-white placeholder-white/30'
                    : 'bg-black/[0.03] border border-black/10 focus:border-blue-500/50 text-[#1D1D1F] placeholder-black/30'
                }`}
                placeholder={t('graph.name')}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
              />
              <button
                disabled={!newFolder || !newName}
                onClick={handleScan}
                className={`w-full py-3 rounded-xl text-sm font-semibold transition-all ${
                  !newFolder || !newName
                    ? (isDark ? 'opacity-40 cursor-not-allowed bg-white/10 text-white/50' : 'opacity-40 cursor-not-allowed bg-black/10 text-black/40')
                    : 'bg-[#0A84FF] text-white hover:bg-[#0070E0]'
                }`}
              >
                {t('graph.scanCreate')}
              </button>
            </div>
          </section>

          {/* 状态提示 */}
          {taskMsg && (
            <div className={`mt-4 text-xs text-center py-2 ${isDark ? 'text-white/50' : 'text-black/50'}`}>
              {taskMsg}
            </div>
          )}
        </div>

        {/* 弹窗 */}
        {renderImportDialog()}
      </div>
    )
  }

  // ============ 已选择图谱：上下布局 ============
  return (
    <div className="h-full flex flex-col">
      {/* 顶部 header */}
      <div className={`flex-shrink-0 px-6 py-3 flex items-center gap-4 border-b ${
        isDark ? 'border-white/10' : 'border-black/5'
      }`}>
        {/* 返回 */}
        <button
          onClick={() => { setCurrentGraph(null); setCurrentName(''); setSelectedDoc(null) }}
          className={`text-xs ${isDark ? 'text-white/50 hover:text-white' : 'text-black/50 hover:text-black'}`}
        >
          {t('graph.back')}
        </button>

        <h2 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
          {currentName}
        </h2>

        <span className={`text-xs ${isDark ? 'text-white/40' : 'text-black/40'}`}>
          {currentGraph.docs.length} {t('graph.docs')} · {currentGraph.relations.length} {t('graph.relations')}
        </span>

        <SegmentedControl
          items={tabs.map(t => ({ key: t.key, label: t.label }))}
          value={activeTab}
          onChange={setActiveTab}
          isDark={isDark}
          size="md"
        />

        <div className="flex-1" />

        {/* AI 分析按钮组 */}
        <div className="relative">
          <button
            onClick={() => setShowAnalysisMenu(v => !v)}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
              anyRunning
                ? 'bg-green-500/20 text-green-400 animate-pulse'
                : isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-black/5 hover:bg-black/10 text-black'
            }`}
          >
            {anyRunning ? '⏳ …' : t('graph.aiAnalyze')}
          </button>
          {showAnalysisMenu && !anyRunning && (
            <div
              onMouseLeave={() => setShowAnalysisMenu(false)}
              className={`absolute top-full right-0 mt-1 z-40 w-56 rounded-xl backdrop-blur-xl border overflow-hidden ${
                isDark ? 'bg-[#1C1C1E]/95 border-white/10' : 'bg-white/95 border-black/10'
              }`}
            >
              {/* 模式选择 */}
              <div className="p-2 pb-0">
                <SegmentedControl
                  items={[
                    { key: 'fast', label: '☇ 快' },
                    { key: 'standard', label: '◆ 中' },
                    { key: 'deep', label: '◇ 深' },
                  ] as const}
                  value={analysisMode}
                  onChange={setAnalysisMode}
                  isDark={isDark}
                  size="sm"
                  fill="equal"
                  className="w-full"
                />
              </div>
              <div className="p-1.5">
                <AnalysisMenuItem icon="🏷️" label={t('graph.classify')} isDark={isDark} onClick={() => { handleClassify(analysisMode); setShowAnalysisMenu(false) }} />
                <AnalysisMenuItem icon="🔗" label={t('graph.inferRelations')} isDark={isDark} onClick={() => { handleRelations(analysisMode); setShowAnalysisMenu(false) }} />
                <AnalysisMenuItem icon="🔄" label={t('graph.incrementalUpdate')} isDark={isDark} onClick={() => { handleUpdate(); setShowAnalysisMenu(false) }} />
                <AnalysisMenuItem icon="🧭" label={t('graph.phasePartition')} isDark={isDark} onClick={() => { handleProposePhases(); setShowAnalysisMenu(false) }} />
                <AnalysisMenuItem icon="📋" label={t('graph.organizeSuggestions')} isDark={isDark} onClick={() => { handleOrganizeSuggestions(); setShowAnalysisMenu(false) }} />
              </div>
            </div>
          )}
        </div>

        {/* 重新扫描 / 重命名 */}
        <button
          onClick={() => handleRescanGraph(currentName)}
          className={`text-xs px-3 py-1.5 rounded-lg ${
            isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-black/5 hover:bg-black/10 text-black'
          }`}
          title="增量更新"
        >↻</button>
        <button
          onClick={() => handleRenameGraph(currentName)}
          className={`text-xs px-3 py-1.5 rounded-lg ${
            isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-black/5 hover:bg-black/10 text-black'
          }`}
          title="重命名"
        >✎</button>
      </div>

      {/* 状态条 */}
      {taskMsg && (
        <div className={`flex-shrink-0 px-6 py-1.5 text-xs border-b ${
          isDark ? 'border-white/5 text-white/50 bg-white/[0.02]' : 'border-black/5 text-black/50 bg-black/[0.01]'
        }`}>
          {taskMsg}
          {classifyRunning && classifyProgress.current && (
            <span className="ml-2 opacity-60">· {classifyProgress.current}</span>
          )}
        </div>
      )}

      {/* 整理建议面板 */}
      {(organizeLoading || organizeSuggestions) && (
        <div className={`flex-shrink-0 px-6 py-3 border-b ${isDark ? 'border-white/5 bg-white/[0.02]' : 'border-black/5 bg-black/[0.01]'}`}>
          <div className="flex items-center justify-between mb-2">
            <span className={`text-xs font-semibold ${isDark ? 'text-white/70' : 'text-black/70'}`}>{t('graph.organizeSuggestions')}</span>
            <button onClick={() => setOrganizeSuggestions(null)} className={`text-[10px] ${isDark ? 'text-white/30 hover:text-white/60' : 'text-black/30 hover:text-black/60'}`}>关闭</button>
          </div>
          {organizeLoading ? (
            <div className={`text-xs ${isDark ? 'text-white/40' : 'text-black/40'}`}>AI 正在分析...</div>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {organizeSuggestions?.map((s, i) => (
                <div key={i} className={`px-3 py-2 rounded-lg text-xs ${isDark ? 'bg-white/5' : 'bg-black/[0.03]'}`}>
                  <div className={`font-semibold mb-0.5 ${isDark ? 'text-white/80' : 'text-black/80'}`}>{s.title}</div>
                  <div className={isDark ? 'text-white/50' : 'text-black/50'}>{s.action}</div>
                  <div className={`mt-1 text-[10px] ${isDark ? 'text-white/30' : 'text-black/30'}`}>涉及: {s.files?.join('、') || '—'} · {s.reason}</div>
                </div>
              ))}
              {organizeSuggestions?.length === 0 && (
                <div className={`text-xs ${isDark ? 'text-white/30' : 'text-black/30'}`}>暂无建议</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 主内容 */}
      <div className="flex-1 overflow-hidden flex">
        {/* 图谱容器：不需要 overflow-auto，vis-network 自己管滚动/缩放 */}
        <div className={`flex-1 ${activeTab === 'graph' ? 'block' : 'hidden'}`}>
          <GraphView graph={currentGraph} onNodeClick={handleNodeClick} isDark={isDark} />
        </div>
        {/* 其他 tab 需要滚动 */}
        {activeTab === 'docs' && (
          <div className="flex-1 overflow-auto">
            <DocList docs={currentGraph.docs} onSelect={setSelectedDoc} isDark={isDark} />
          </div>
        )}
        {activeTab === 'phases' && (
          <div className="flex-1 overflow-auto">
            <PhaseView
              graph={currentGraph}
              graphName={currentName}
              isDark={isDark}
              onSelectDoc={setSelectedDoc}
              onRebuild={handleProposePhases}
              onReload={() => loadGraph(currentName)}
            />
          </div>
        )}
        {activeTab === 'relations' && (
          <div className="flex-1 overflow-auto">
            <RelationList
              graph={currentGraph}
              graphName={currentName}
              onReload={() => loadGraph(currentName)}
              isDark={isDark}
            />
          </div>
        )}

        {selectedDoc && (
          <DocDetail
            doc={selectedDoc}
            graphName={currentName}
            folder={currentGraph?.folder}
            onClose={() => setSelectedDoc(null)}
            onSelectRelated={(docId) => {
              if (!currentGraph) return
              const d = currentGraph.docs.find(x => x.id === docId)
              if (d) setSelectedDoc(d)
            }}
            onDocUpdated={handleDocUpdated}
            isDark={isDark}
          />
        )}
      </div>

      {/* 弹窗 */}
      {updatePreview && (
        <UpdatePreviewModal
          preview={updatePreview}
          isDark={isDark}
          pending={pendingUpdate}
          onConfirm={handleConfirmUpdate}
          onCancel={() => setUpdatePreview(null)}
        />
      )}

      {phaseModalOpen && currentGraph && (
        <PhaseProposeModal
          graph={currentGraph}
          isDark={isDark}
          pending={phaseModalPending}
          onConfirm={handleConfirmPhases}
          onCancel={() => setPhaseModalOpen(false)}
        />
      )}

      {renderImportDialog()}
    </div>
  )

  // ============ 导入弹窗 ============
  function renderImportDialog() {
    if (!importDialog) return null
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        onClick={() => !importing && setImportDialog(null)}
      >
        <div
          onClick={e => e.stopPropagation()}
          className={`w-[420px] rounded-2xl p-6 shadow-2xl ${
            isDark ? 'bg-[#1C1C1E] border border-white/10' : 'bg-white border border-black/5'
          }`}
        >
          <h3 className={`text-lg font-semibold mb-1 ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
            创建文档图谱
          </h3>
          <div className={`text-xs mb-4 ${isDark ? 'text-white/50' : 'text-black/50'}`}>
            来源：{importDialog.source} · {importDialog.files.length} 个文档
          </div>

          <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-white/70' : 'text-black/70'}`}>
            图谱名称
          </label>
          <input
            type="text"
            value={importNameInput}
            onChange={e => setImportNameInput(e.target.value)}
            autoFocus
            disabled={importing}
            placeholder="为这份图谱起个名字"
            className={`w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors mb-4 ${
              isDark
                ? 'bg-white/5 border border-white/10 focus:border-blue-500/50 text-white placeholder-white/30'
                : 'bg-black/[0.03] border border-black/10 focus:border-blue-500/50 text-[#1D1D1F] placeholder-black/30'
            }`}
            onKeyDown={e => {
              if (e.key === 'Enter') handleImportConfirm()
              if (e.key === 'Escape') setImportDialog(null)
            }}
          />

          <div className="flex justify-end gap-2">
            <button
              onClick={() => setImportDialog(null)}
              disabled={importing}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${
                isDark ? 'hover:bg-white/5 text-white/70' : 'hover:bg-black/5 text-black/60'
              }`}
            >取消</button>
            <button
              onClick={handleImportConfirm}
              disabled={importing || !importNameInput.trim()}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                importing || !importNameInput.trim()
                  ? (isDark ? 'bg-white/10 text-white/30' : 'bg-black/10 text-black/30')
                  : (isDark ? 'bg-blue-500 hover:bg-blue-600 text-white' : 'bg-[#0A84FF] hover:bg-[#006FE0] text-white')
              }`}
            >{importing ? '导入中…' : '创建图谱'}</button>
          </div>
        </div>
      </div>
    )
  }
}

// ============ 图谱卡片 ============

function GraphCard({ graph, isDark, onOpen, onDelete, onRename, onRescan }: {
  graph: GraphSummary
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
        {graph.name}
      </div>
      <div className={`text-[11px] ${isDark ? 'text-white/40' : 'text-black/40'}`}>
        {graph.doc_count} docs · {graph.relation_count} rel
      </div>

      {hover && (
        <div
          onClick={e => e.stopPropagation()}
          className={`absolute top-2 right-2 flex items-center gap-1 px-1 py-1 rounded-lg backdrop-blur-xl ${
            isDark ? 'bg-black/60' : 'bg-white/80'
          }`}
        >
          <IconBtn title="重命名" isDark={isDark} onClick={onRename}>✎</IconBtn>
          <IconBtn title="增量更新" isDark={isDark} onClick={onRescan}>↻</IconBtn>
          <IconBtn title="删除" isDark={isDark} onClick={onDelete} danger>🗑</IconBtn>
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

function AnalysisMenuItem({ icon, label, isDark, onClick }: {
  icon: string; label: string; isDark: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 ${
        isDark ? 'hover:bg-white/10 text-white/80' : 'hover:bg-black/5 text-black/70'
      }`}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  )
}
