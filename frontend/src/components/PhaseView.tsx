import { useMemo, useState, useEffect, useCallback } from 'react'
import type { GraphData, Phase, Doc, PhaseFlow } from '../api'
import { savePhases, autoUpdatePhases, analyzePhaseFlow, fetchTaskStatus } from '../api'
import PhaseFlowChart from './PhaseFlowChart'

interface Props {
  graph: GraphData
  graphName: string
  isDark: boolean
  onSelectDoc: (doc: Doc) => void
  onRebuild: () => void
  onReload: () => Promise<void> | void
}

const PHASE_COLORS = {
  light: ['#007AFF', '#5856D6', '#34C759', '#FF9500', '#FF2D55', '#5AC8FA', '#AF52DE', '#FF3B30'],
  dark: ['#0A84FF', '#5E5CE6', '#30D158', '#FF9F0A', '#FF375F', '#64D2FF', '#BF5AF2', '#FF453A'],
}

type ViewMode = 'detail' | 'flow'

// ============ 工具函数 ============

function flattenTree(phases: Phase[]): { phase: Phase; level: number; topIdx: number; parentId: string | null }[] {
  const out: { phase: Phase; level: number; topIdx: number; parentId: string | null }[] = []
  phases.forEach((p, topIdx) => {
    const walk = (n: Phase, level: number, parentId: string | null) => {
      out.push({ phase: n, level, topIdx, parentId })
      ;(n.children || []).forEach(c => walk(c, level + 1, n.id))
    }
    walk(p, 0, null)
  })
  return out
}

function findPhaseById(phases: Phase[], id: string): Phase | null {
  for (const p of phases) {
    if (p.id === id) return p
    const child = findPhaseById(p.children || [], id)
    if (child) return child
  }
  return null
}

function collectAllDocIds(phase: Phase): string[] {
  const out = new Set<string>(phase.doc_ids)
  ;(phase.children || []).forEach(ch => collectAllDocIds(ch).forEach(id => out.add(id)))
  return Array.from(out)
}

// 深拷贝
function clonePhases(phases: Phase[]): Phase[] {
  return JSON.parse(JSON.stringify(phases))
}

// 在树中找到节点和它的父节点（带层级）
function findNodeWithParent(phases: Phase[], id: string): { node: Phase; parent: Phase | null; level: number; index: number } | null {
  for (let i = 0; i < phases.length; i++) {
    if (phases[i].id === id) return { node: phases[i], parent: null, level: 0, index: i }
  }
  function walk(nodes: Phase[], parent: Phase | null, level: number): any {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return { node: nodes[i], parent, level, index: i }
      const r = walk(nodes[i].children || [], nodes[i], level + 1)
      if (r) return r
    }
    return null
  }
  return walk(phases, null, 0)
}

// 计算节点深度（含子层）
function getNodeDepth(node: Phase): number {
  if (!node.children || node.children.length === 0) return 1
  return 1 + Math.max(...node.children.map(getNodeDepth))
}

// 从树中移除指定 id 的节点
function removeNode(phases: Phase[], id: string): Phase[] {
  return phases.filter(p => p.id !== id).map(p => ({
    ...p,
    children: p.children ? removeNode(p.children, id) : [],
  }))
}

// 移除文档
function removeDocFromAllPhases(phases: Phase[], docId: string): Phase[] {
  return phases.map(p => ({
    ...p,
    doc_ids: (p.doc_ids || []).filter(d => d !== docId),
    children: p.children ? removeDocFromAllPhases(p.children, docId) : [],
  }))
}

// 把 doc 加到指定 phase
function addDocToPhase(phases: Phase[], targetId: string, docId: string): Phase[] {
  return phases.map(p => {
    if (p.id === targetId) {
      const ids = new Set(p.doc_ids || [])
      ids.add(docId)
      return { ...p, doc_ids: Array.from(ids) }
    }
    return { ...p, children: p.children ? addDocToPhase(p.children, targetId, docId) : [] }
  })
}

// 把节点插入到目标父节点下（如果 targetParentId=null 则顶层）
function insertNode(phases: Phase[], targetParentId: string | null, node: Phase, beforeId?: string): Phase[] {
  if (targetParentId === null) {
    if (beforeId) {
      const idx = phases.findIndex(p => p.id === beforeId)
      if (idx >= 0) {
        const next = [...phases]
        next.splice(idx, 0, node)
        return next
      }
    }
    return [...phases, node]
  }
  return phases.map(p => {
    if (p.id === targetParentId) {
      const children = [...(p.children || [])]
      if (beforeId) {
        const idx = children.findIndex(c => c.id === beforeId)
        if (idx >= 0) {
          children.splice(idx, 0, node)
          return { ...p, children }
        }
      }
      return { ...p, children: [...children, node] }
    }
    return { ...p, children: p.children ? insertNode(p.children, targetParentId, node, beforeId) : [] }
  })
}

// 检查 newParent 不能是 nodeId 自身或它的后代
function isDescendant(phases: Phase[], ancestorId: string, descendantId: string): boolean {
  const node = findPhaseById(phases, ancestorId)
  if (!node) return false
  const all = collectAllPhaseIds(node)
  return all.has(descendantId) && ancestorId !== descendantId
}

function collectAllPhaseIds(node: Phase): Set<string> {
  const ids = new Set<string>([node.id])
  ;(node.children || []).forEach(ch => collectAllPhaseIds(ch).forEach(id => ids.add(id)))
  return ids
}

// 重排同级 order
function reorderTree(phases: Phase[]): Phase[] {
  return phases.map((p, i) => ({
    ...p,
    order: i + 1,
    children: p.children ? reorderTree(p.children) : [],
  }))
}

// ============ 主组件 ============

export default function PhaseView({ graph, graphName, isDark, onSelectDoc, onRebuild, onReload }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('detail')
  const [editing, setEditing] = useState(false)
  const [draftPhases, setDraftPhases] = useState<Phase[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [autoUpdating, setAutoUpdating] = useState(false)
  const [flowAnalyzing, setFlowAnalyzing] = useState(false)
  const [progressMsg, setProgressMsg] = useState('')

  // 当前显示的 phases:编辑中用 draft,否则用 graph 的
  const phases = editing ? draftPhases : (graph.phases || [])
  const flatList = useMemo(() => flattenTree(phases), [phases])

  // 默认选中第一个
  useEffect(() => {
    if (!selectedId && flatList.length > 0) {
      setSelectedId(flatList[0].phase.id)
    }
  }, [flatList, selectedId])

  const docsById = useMemo(() => {
    const m: Record<string, Doc> = {}
    graph.docs.forEach(d => { m[d.id] = d })
    return m
  }, [graph.docs])

  const palette = isDark ? PHASE_COLORS.dark : PHASE_COLORS.light
  const subText = isDark ? 'text-white/55' : 'text-black/55'
  const dimText = isDark ? 'text-white/30' : 'text-black/30'

  // ============ 拖拽逻辑 ============
  // 拖拽源:可以是 'phase:phaseId' 或 'doc:docId:fromPhaseId'
  const [dragSource, setDragSource] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<string | null>(null)  // 'phase:phaseId' or 'doc:phaseId'

  const handleDragStart = (e: React.DragEvent, source: string) => {
    if (!editing) { e.preventDefault(); return }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', source)
    setDragSource(source)
  }

  const handleDragOver = (e: React.DragEvent, hint: string) => {
    if (!editing || !dragSource) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropHint(hint)
  }

  const handleDragLeave = () => setDropHint(null)

  // 拖拽完成
  const handleDrop = (e: React.DragEvent, target: string) => {
    if (!editing || !dragSource) return
    e.preventDefault()
    e.stopPropagation()
    setDropHint(null)

    // 解析 source 和 target
    // source: 'phase:xxx' 或 'doc:docId:fromPhaseId'
    // target: 'phase-into:phaseId'(放到这个 phase 内)、'phase-before:phaseId'(放到这个 phase 之前同级)、
    //         'phase-root'(顶层末尾)、'doc-into:phaseId'(文档放进这个 phase)
    const src = dragSource
    setDragSource(null)

    setDraftPhases(prev => {
      const phases = clonePhases(prev)

      // === 文档拖拽 ===
      if (src.startsWith('doc:')) {
        const [, docId, fromPhaseId] = src.split(':')
        let targetPhaseId: string | null = null
        if (target.startsWith('doc-into:')) targetPhaseId = target.split(':')[1]
        else if (target.startsWith('phase-into:')) targetPhaseId = target.split(':')[1]
        if (!targetPhaseId || targetPhaseId === fromPhaseId) return phases
        // 移除原位置 + 加到目标
        let next = removeDocFromAllPhases(phases, docId)
        next = addDocToPhase(next, targetPhaseId, docId)
        return reorderTree(next)
      }

      // === 阶段拖拽 ===
      if (src.startsWith('phase:')) {
        const phaseId = src.split(':')[1]
        const found = findNodeWithParent(phases, phaseId)
        if (!found) return phases
        const movingNode = found.node

        // 校验:不能把自己拖到自己的后代
        let targetParentId: string | null = null
        let beforeId: string | undefined

        if (target === 'phase-root') {
          targetParentId = null
        } else if (target.startsWith('phase-into:')) {
          targetParentId = target.split(':')[1]
          if (targetParentId === phaseId || isDescendant(phases, phaseId, targetParentId)) return phases
          // 检查深度限制(3 层)
          const targetNode = findPhaseById(phases, targetParentId)
          if (!targetNode) return phases
          const targetLevel = (findNodeWithParent(phases, targetParentId)?.level ?? 0)
          const movingDepth = getNodeDepth(movingNode)
          if (targetLevel + movingDepth > 3) {
            alert('超过最大 3 层深度限制')
            return phases
          }
        } else if (target.startsWith('phase-before:')) {
          beforeId = target.split(':')[1]
          if (beforeId === phaseId) return phases
          const beforeFound = findNodeWithParent(phases, beforeId)
          if (!beforeFound) return phases
          targetParentId = beforeFound.parent?.id || null
          if (targetParentId === phaseId || (targetParentId && isDescendant(phases, phaseId, targetParentId))) return phases
          // 深度检查
          const targetLevel = beforeFound.level
          const movingDepth = getNodeDepth(movingNode)
          if (targetLevel + movingDepth > 3) {
            alert('超过最大 3 层深度限制')
            return phases
          }
        }

        // 先从原位置移除
        const removed = removeNode(phases, phaseId)
        // 再插入
        const next = insertNode(removed, targetParentId, movingNode, beforeId)
        return reorderTree(next)
      }

      return phases
    })
  }

  // ============ 编辑操作 ============
  const startEdit = () => {
    setDraftPhases(clonePhases(graph.phases || []))
    setEditing(true)
  }

  const cancelEdit = () => {
    if (!confirm('确定放弃编辑?')) return
    setEditing(false)
    setDraftPhases([])
  }

  const handleSaveEdit = async () => {
    setSaving(true)
    setProgressMsg('保存中...')
    try {
      await savePhases(graphName, draftPhases)
      setEditing(false)
      setDraftPhases([])
      setProgressMsg('✅ 已保存')
      await onReload()
      setTimeout(() => setProgressMsg(''), 2000)
    } catch (e: any) {
      setProgressMsg(`❌ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleAddPhase = () => {
    const name = prompt('新阶段名称:', '新阶段')
    if (!name) return
    const newPhase: Phase = {
      id: `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: name.slice(0, 30),
      path_pattern: '',
      doc_ids: [],
      order: draftPhases.length + 1,
      children: [],
    }
    setDraftPhases(prev => reorderTree([...prev, newPhase]))
  }

  const handleDeletePhase = (id: string) => {
    const node = findPhaseById(draftPhases, id)
    if (!node) return
    const docCount = collectAllDocIds(node).length
    if (!confirm(`确定删除阶段「${node.name}」?它及其子阶段共 ${docCount} 篇文档将变为未归类。`)) return
    setDraftPhases(prev => reorderTree(removeNode(prev, id)))
  }

  const handleRenamePhase = (id: string) => {
    const node = findPhaseById(draftPhases, id)
    if (!node) return
    const input = prompt('阶段名称:', node.name)
    if (!input || input === node.name) return
    const finalName = input.slice(0, 30)
    function rename(phases: Phase[]): Phase[] {
      return phases.map(p => p.id === id ? { ...p, name: finalName } : { ...p, children: p.children ? rename(p.children) : [] })
    }
    setDraftPhases(prev => rename(prev))
  }

  // ============ 自动更新 ============
  const handleAutoUpdate = async () => {
    if (!confirm('将基于当前目录结构,把新增文档自动归并到现有阶段中(不会覆盖你已有的手动调整)。继续?')) return
    setAutoUpdating(true)
    setProgressMsg('检测变化中...')
    try {
      await autoUpdatePhases(graphName, true)
      // 轮询
      const iv = setInterval(async () => {
        const st: any = await fetchTaskStatus('phases')
        if (st.current) setProgressMsg(`${st.current} (${st.progress}/${st.total || '?'})`)
        if (!st.running) {
          clearInterval(iv)
          setAutoUpdating(false)
          if (st.result?.error) {
            setProgressMsg(`❌ ${st.result.error}`)
          } else {
            const r = st.result || {}
            setProgressMsg(`✅ 新增 ${r.new_phase_count || 0} 个阶段, 追加 ${r.added_doc_count || 0} 篇文档`)
            await onReload()
            setTimeout(() => setProgressMsg(''), 4000)
          }
        }
      }, 800)
    } catch (e: any) {
      setProgressMsg(`❌ ${e.message}`)
      setAutoUpdating(false)
    }
  }

  // ============ 流程图分析 ============
  const handleAnalyzeFlow = async () => {
    setFlowAnalyzing(true)
    setProgressMsg('分析阶段流程中...')
    try {
      await analyzePhaseFlow(graphName)
      const iv = setInterval(async () => {
        const st: any = await fetchTaskStatus('phases')
        if (!st.running) {
          clearInterval(iv)
          setFlowAnalyzing(false)
          if (st.result?.error) {
            setProgressMsg(`❌ ${st.result.error}`)
          } else {
            const r = st.result || {}
            setProgressMsg(`✅ 流程图已生成 (${r.node_count} 节点, ${r.edge_count} 连线)`)
            await onReload()
            setViewMode('flow')
            setTimeout(() => setProgressMsg(''), 3000)
          }
        }
      }, 800)
    } catch (e: any) {
      setProgressMsg(`❌ ${e.message}`)
      setFlowAnalyzing(false)
    }
  }

  // ============ 渲染 ============

  if (phases.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <p className={`text-7xl mb-6 ${dimText}`}>🧭</p>
          <p className={`text-lg font-semibold mb-2 ${isDark ? 'text-white/80' : 'text-black/70'}`}>
            还没有阶段划分
          </p>
          <p className={`text-sm mb-5 ${subText}`}>
            点击下方按钮,根据文件夹结构自动识别项目阶段
          </p>
          <button
            onClick={onRebuild}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-[#007AFF] hover:bg-[#0071E3] transition-all active:scale-95 shadow-sm shadow-[#007AFF]/30"
          >
            🧭 立即开始划分
          </button>
        </div>
      </div>
    )
  }

  const selected = (selectedId ? findPhaseById(phases, selectedId) : null) || flatList[0]?.phase
  const selectedTopIdx = flatList.find(f => f.phase.id === selected?.id)?.topIdx ?? 0
  const selectedColor = palette[selectedTopIdx % palette.length]
  const allSelectedDocIds = selected ? collectAllDocIds(selected) : []

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏 */}
      <div className={`px-5 py-2.5 flex items-center gap-3 border-b ${
        isDark ? 'border-white/[0.06] bg-white/[0.01]' : 'border-black/[0.04] bg-white/40'
      }`}>
        {/* 视图切换 */}
        <div className={`flex p-0.5 rounded-lg ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.05]'}`}>
          <button
            onClick={() => setViewMode('detail')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
              viewMode === 'detail'
                ? (isDark ? 'bg-white/15 text-white shadow' : 'bg-white text-black shadow-sm')
                : (isDark ? 'text-white/50 hover:text-white/80' : 'text-black/50 hover:text-black/80')
            }`}
          >📋 详情</button>
          <button
            onClick={() => setViewMode('flow')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
              viewMode === 'flow'
                ? (isDark ? 'bg-white/15 text-white shadow' : 'bg-white text-black shadow-sm')
                : (isDark ? 'text-white/50 hover:text-white/80' : 'text-black/50 hover:text-black/80')
            }`}
          >🔀 流程图</button>
        </div>

        <div className="flex-1" />

        {/* 状态消息 */}
        {progressMsg && (
          <span className={`text-xs ${
            progressMsg.startsWith('❌') ? 'text-red-500' :
            progressMsg.startsWith('✅') ? 'text-green-500' :
            (isDark ? 'text-white/60' : 'text-black/60')
          }`}>{progressMsg}</span>
        )}

        {/* 操作按钮 */}
        {viewMode === 'detail' && !editing && (
          <>
            <button
              onClick={handleAutoUpdate}
              disabled={autoUpdating}
              className={`text-xs px-3 py-1.5 rounded-lg transition-all active:scale-95 disabled:opacity-50 ${
                isDark ? 'bg-white/[0.06] hover:bg-white/[0.1] text-white/80' : 'bg-black/[0.04] hover:bg-black/[0.08] text-black/70'
              }`}
              title="基于当前目录,把新增文档自动归并到现有阶段"
            >🔁 {autoUpdating ? '更新中...' : '自动更新'}</button>
            <button
              onClick={startEdit}
              className={`text-xs px-3 py-1.5 rounded-lg transition-all active:scale-95 ${
                isDark ? 'bg-white/[0.06] hover:bg-white/[0.1] text-white/80' : 'bg-black/[0.04] hover:bg-black/[0.08] text-black/70'
              }`}
            >✏️ 编辑</button>
            <button
              onClick={onRebuild}
              className={`text-xs px-3 py-1.5 rounded-lg transition-all active:scale-95 ${
                isDark ? 'bg-white/[0.06] hover:bg-white/[0.1] text-white/80' : 'bg-black/[0.04] hover:bg-black/[0.08] text-black/70'
              }`}
              title="清空并重新划分"
            >🧭 重新划分</button>
          </>
        )}
        {viewMode === 'detail' && editing && (
          <>
            <button
              onClick={handleAddPhase}
              className={`text-xs px-3 py-1.5 rounded-lg transition-all active:scale-95 ${
                isDark ? 'bg-white/[0.06] hover:bg-white/[0.1] text-white/80' : 'bg-black/[0.04] hover:bg-black/[0.08] text-black/70'
              }`}
            >➕ 新增阶段</button>
            <button
              onClick={cancelEdit}
              className={`text-xs px-3 py-1.5 rounded-lg transition-all active:scale-95 ${
                isDark ? 'bg-white/[0.06] hover:bg-white/[0.1] text-white/80' : 'bg-black/[0.04] hover:bg-black/[0.08] text-black/70'
              }`}
            >取消</button>
            <button
              onClick={handleSaveEdit}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded-lg text-white bg-[#007AFF] hover:bg-[#0071E3] transition-all active:scale-95 disabled:opacity-50"
            >{saving ? '保存中...' : '✅ 保存'}</button>
          </>
        )}
        {viewMode === 'flow' && (
          <button
            onClick={handleAnalyzeFlow}
            disabled={flowAnalyzing}
            className="text-xs px-3 py-1.5 rounded-lg text-white bg-[#007AFF] hover:bg-[#0071E3] transition-all active:scale-95 disabled:opacity-50"
          >🔮 {flowAnalyzing ? '分析中...' : graph.phase_flow ? '重新分析流程' : '分析流程'}</button>
        )}
      </div>

      {/* 主内容区 */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'flow' ? (
          <PhaseFlowChart
            phases={phases}
            flow={graph.phase_flow || null}
            isDark={isDark}
            onAnalyze={handleAnalyzeFlow}
            analyzing={flowAnalyzing}
            palette={palette}
          />
        ) : (
          <div className="h-full flex">
            {/* 左侧时间轴 */}
            <aside className={`w-[300px] flex-shrink-0 border-r overflow-auto ${
              isDark ? 'border-white/[0.06] bg-white/[0.01]' : 'border-black/[0.04] bg-black/[0.01]'
            }`}>
              <div className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className={`text-[10px] font-semibold uppercase tracking-widest ${dimText}`}>
                    项目阶段 {editing && <span className="ml-1 text-[#007AFF]">· 编辑中</span>}
                  </h3>
                </div>

                {editing && (
                  <div className={`text-[10px] mb-3 px-2 py-1.5 rounded ${
                    isDark ? 'bg-[#007AFF]/10 text-[#0A84FF]' : 'bg-[#007AFF]/8 text-[#007AFF]'
                  }`}>
                    💡 拖拽阶段调整顺序/层级,拖拽文档到其他阶段
                  </div>
                )}

                {/* 顶层 drop zone (放到最末尾) */}
                {editing && (
                  <div
                    onDragOver={(e) => handleDragOver(e, 'phase-root')}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, 'phase-root')}
                    className={`text-[10px] text-center py-1 mb-1 rounded border border-dashed transition-colors ${
                      dropHint === 'phase-root'
                        ? (isDark ? 'border-[#0A84FF] bg-[#0A84FF]/10 text-[#0A84FF]' : 'border-[#007AFF] bg-[#007AFF]/8 text-[#007AFF]')
                        : (isDark ? 'border-white/[0.08] text-white/20' : 'border-black/[0.06] text-black/20')
                    }`}
                  >拖到顶层末尾</div>
                )}

                <div className="space-y-1">
                  {flatList.map(({ phase, level, topIdx }) => {
                    const color = palette[topIdx % palette.length]
                    const active = phase.id === selected?.id
                    const allDocs = collectAllDocIds(phase)
                    const isDropBefore = dropHint === `phase-before:${phase.id}`
                    const isDropInto = dropHint === `phase-into:${phase.id}`
                    return (
                      <div key={phase.id}>
                        {/* 上方插入区 */}
                        {editing && (
                          <div
                            onDragOver={(e) => handleDragOver(e, `phase-before:${phase.id}`)}
                            onDragLeave={handleDragLeave}
                            onDrop={(e) => handleDrop(e, `phase-before:${phase.id}`)}
                            className={`h-1 transition-all ${
                              isDropBefore ? 'h-2 bg-[#007AFF] rounded' : ''
                            }`}
                          />
                        )}
                        <div
                          draggable={editing}
                          onDragStart={(e) => handleDragStart(e, `phase:${phase.id}`)}
                          onDragOver={(e) => handleDragOver(e, `phase-into:${phase.id}`)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, `phase-into:${phase.id}`)}
                          className={`group w-full text-left px-2.5 py-1.5 rounded-lg transition-all flex items-center gap-2 cursor-pointer ${
                            isDropInto
                              ? (isDark ? 'bg-[#0A84FF]/20 ring-1 ring-[#0A84FF]' : 'bg-[#007AFF]/10 ring-1 ring-[#007AFF]')
                              : active
                              ? (isDark ? 'bg-white/10' : 'bg-white shadow-sm')
                              : (isDark ? 'hover:bg-white/5' : 'hover:bg-black/[0.03]')
                          }`}
                          style={{ paddingLeft: `${10 + level * 14}px` }}
                          onClick={() => setSelectedId(phase.id)}
                        >
                          {editing && <span className={`text-xs ${dimText} cursor-grab`}>⋮⋮</span>}
                          <span
                            className="inline-block rounded-full transition-all shrink-0"
                            style={{
                              width: level === 0 ? 8 : 5,
                              height: level === 0 ? 8 : 5,
                              background: color,
                              opacity: level === 0 ? 1 : 0.6,
                              boxShadow: active ? `0 0 0 3px ${color}30` : 'none',
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            {level === 0 && (
                              <div className={`text-[10px] font-mono ${dimText} mb-0.5`}>
                                第 {phase.order} 阶段
                              </div>
                            )}
                            <div className={`text-${level === 0 ? '[13px]' : '[12px]'} font-${level === 0 ? 'semibold' : 'medium'} truncate ${active ? '' : (level === 0 ? subText : dimText)}`}>
                              {phase.name}
                            </div>
                          </div>
                          {allDocs.length > 0 && (
                            <span
                              className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
                              style={{ background: `${color}20`, color }}
                            >
                              {allDocs.length}
                            </span>
                          )}
                          {editing && (
                            <span className="opacity-0 group-hover:opacity-100 flex gap-0.5 transition-opacity">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRenamePhase(phase.id) }}
                                className={`text-[10px] px-1 ${dimText} hover:text-[#007AFF]`}
                                title="重命名"
                              >✏️</button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeletePhase(phase.id) }}
                                className={`text-[10px] px-1 ${dimText} hover:text-red-500`}
                                title="删除"
                              >🗑️</button>
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </aside>

            {/* 右侧详情 */}
            <main className="flex-1 overflow-auto">
              {!selected ? (
                <div className={`flex items-center justify-center h-full text-sm ${dimText}`}>选择一个阶段</div>
              ) : (
                <div className="max-w-3xl mx-auto px-8 py-8">
                  {/* 头部 */}
                  <div className="mb-6">
                    <div className="flex items-baseline gap-3 mb-2">
                      <span
                        className="text-[10px] font-mono px-2 py-0.5 rounded"
                        style={{ background: `${selectedColor}20`, color: selectedColor }}
                      >
                        第 {selected.order} 阶段
                        {selected.children && selected.children.length > 0 && ` · ${selected.children.length} 个子阶段`}
                      </span>
                      <span className={`text-[10px] font-mono ${dimText}`}>📁 {selected.path_pattern || '手动'}</span>
                    </div>
                    <h2 className="text-2xl font-bold tracking-tight mb-1">{selected.name}</h2>
                    {selected.objective && (
                      <p className={`text-sm ${subText}`}>🎯 {selected.objective}</p>
                    )}
                  </div>

                  {/* 总结 */}
                  {selected.summary && (
                    <section className="mb-6">
                      <h3 className={`text-[11px] font-semibold uppercase tracking-widest mb-2 ${dimText}`}>
                        阶段总结
                      </h3>
                      <p className={`text-[14px] leading-relaxed ${isDark ? 'text-white/85' : 'text-black/80'}`}>
                        {selected.summary}
                      </p>
                    </section>
                  )}

                  {/* 产出 + 关键发现 */}
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    {selected.outputs && selected.outputs.length > 0 && (
                      <section>
                        <h3 className={`text-[11px] font-semibold uppercase tracking-widest mb-2 ${dimText}`}>
                          📦 核心产出
                        </h3>
                        <ul className="space-y-1">
                          {selected.outputs.map((o, i) => (
                            <li key={i} className={`text-[13px] ${subText} flex gap-2`}>
                              <span style={{ color: selectedColor }}>·</span>
                              <span>{o}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {selected.key_findings && selected.key_findings.length > 0 && (
                      <section>
                        <h3 className={`text-[11px] font-semibold uppercase tracking-widest mb-2 ${dimText}`}>
                          💡 关键发现
                        </h3>
                        <ul className="space-y-1">
                          {selected.key_findings.map((f, i) => (
                            <li key={i} className={`text-[13px] ${subText} flex gap-2`}>
                              <span style={{ color: selectedColor }}>·</span>
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </div>

                  {/* 子阶段卡片 */}
                  {selected.children && selected.children.length > 0 && (
                    <section className="mb-6">
                      <h3 className={`text-[11px] font-semibold uppercase tracking-widest mb-2 ${dimText}`}>
                        子阶段 ({selected.children.length})
                      </h3>
                      <div className="grid grid-cols-2 gap-2">
                        {selected.children.map(ch => {
                          const allChildDocs = collectAllDocIds(ch)
                          return (
                            <button
                              key={ch.id}
                              onClick={() => setSelectedId(ch.id)}
                              className={`text-left p-3 rounded-xl transition-all active:scale-[0.98] ${
                                isDark ? 'bg-white/[0.03] hover:bg-white/[0.06]' : 'bg-black/[0.02] hover:bg-black/[0.04]'
                              }`}
                            >
                              <div className="flex items-baseline gap-2 mb-1">
                                <span className="text-sm font-semibold">{ch.name}</span>
                                <span className={`text-[10px] ml-auto ${dimText}`}>{allChildDocs.length} 篇</span>
                              </div>
                              {ch.objective && <p className={`text-[11px] ${subText} truncate`}>{ch.objective}</p>}
                            </button>
                          )
                        })}
                      </div>
                    </section>
                  )}

                  {/* 文档列表 */}
                  <section>
                    <h3 className={`text-[11px] font-semibold uppercase tracking-widest mb-2 ${dimText}`}>
                      文档列表 ({allSelectedDocIds.length}{selected.children?.length ? ' · 含子阶段' : ''})
                      {editing && <span className="ml-2 text-[#007AFF] normal-case">· 拖到左侧阶段以移动</span>}
                    </h3>
                    <ul
                      className={`space-y-1 ${editing ? 'min-h-[60px] rounded-lg p-1 border border-dashed ' + (isDark ? 'border-white/[0.06]' : 'border-black/[0.04]') : ''}`}
                      onDragOver={(e) => editing && selected && handleDragOver(e, `phase-into:${selected.id}`)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => editing && selected && handleDrop(e, `phase-into:${selected.id}`)}
                    >
                      {allSelectedDocIds.map(did => {
                        const d = docsById[did]
                        if (!d) return null
                        const isOwn = selected.doc_ids.includes(did)
                        const ownerPhase = isOwn ? selected.id : (findOwnerPhaseId(phases, did) || '')
                        return (
                          <li key={did}>
                            <div
                              draggable={editing && isOwn}
                              onDragStart={(e) => handleDragStart(e, `doc:${did}:${ownerPhase}`)}
                              className={`w-full text-left px-3 py-2 rounded-lg transition-all flex items-start gap-2 ${
                                editing && isOwn ? 'cursor-grab' : 'cursor-pointer'
                              } ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/[0.03]'}`}
                              onClick={() => onSelectDoc(d)}
                            >
                              {editing && isOwn && <span className={`text-xs ${dimText} mt-0.5`}>⋮⋮</span>}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  {!isOwn && <span className={`text-[10px] ${dimText}`}>↳</span>}
                                  <span className="text-sm flex-1 truncate">{d.name}</span>
                                  {d.category && (
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                      isDark ? 'bg-white/10 text-white/60' : 'bg-black/5 text-black/50'
                                    }`}>
                                      {d.category}
                                    </span>
                                  )}
                                </div>
                                {d.summary && (
                                  <p className={`text-[11px] mt-0.5 truncate ${dimText}`}>{d.summary}</p>
                                )}
                              </div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                </div>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  )
}

// 找到 doc 当前所属的 phase id
function findOwnerPhaseId(phases: Phase[], docId: string): string | null {
  for (const p of phases) {
    if ((p.doc_ids || []).includes(docId)) return p.id
    if (p.children) {
      const r = findOwnerPhaseId(p.children, docId)
      if (r) return r
    }
  }
  return null
}
