import { useEffect, useMemo, useRef, useState } from 'react'
import type { Phase, GraphData } from '../api'
import { proposePhases } from '../api'

interface Props {
  graph: GraphData
  isDark: boolean
  pending: boolean
  onConfirm: (phases: Phase[], generateSummaries: boolean) => void
  onCancel: () => void
}

// ============ 工具函数 ============

let _tmpId = 0
const genId = () => `tmp_${Date.now()}_${++_tmpId}`

function ensureIds(phases: Phase[]): Phase[] {
  return phases.map(p => ({
    ...p,
    id: p.id || genId(),
    children: p.children ? ensureIds(p.children as any) : [],
  })) as any
}

function collectAllDocIds(phases: Phase[]): Set<string> {
  const s = new Set<string>()
  const walk = (ns: Phase[]) => {
    for (const n of ns) {
      n.doc_ids.forEach(id => s.add(id))
      if (n.children) walk(n.children as any)
    }
  }
  walk(phases)
  return s
}

// 用路径（index 数组）定位节点
type Path = number[]

function getNodeAt(phases: Phase[], path: Path): Phase | null {
  if (path.length === 0) return null
  let node: any = phases[path[0]]
  for (let i = 1; i < path.length; i++) {
    if (!node || !node.children) return null
    node = node.children[path[i]]
  }
  return node || null
}

// 计算节点高度（含子层）
function nodeHeight(node: Phase): number {
  if (!node.children || node.children.length === 0) return 1
  return 1 + Math.max(...(node.children as any).map(nodeHeight))
}

// path-string for set 比较
const pathKey = (p: Path) => p.join('.')

// 是否 a 是 b 的祖先（含相等）
function isAncestor(a: Path, b: Path): boolean {
  if (a.length > b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// 不可变地从树中移除某 path 节点，返回 [新树, 被移除节点]
function removeAt(phases: Phase[], path: Path): [Phase[], Phase] {
  if (path.length === 1) {
    const removed = phases[path[0]]
    return [phases.filter((_, i) => i !== path[0]), removed]
  }
  const head = path[0]
  const target = phases[head]
  const [newChildren, removed] = removeAt((target.children || []) as any, path.slice(1))
  const newPhases = phases.map((p, i) => i === head ? { ...p, children: newChildren as any } : p)
  return [newPhases, removed]
}

// 不可变地在某 parentPath 下的 insertIdx 位置插入节点
function insertAt(phases: Phase[], parentPath: Path, insertIdx: number, node: Phase): Phase[] {
  if (parentPath.length === 0) {
    const next = [...phases]
    next.splice(insertIdx, 0, node)
    return next
  }
  const head = parentPath[0]
  const target = phases[head]
  const newChildren = insertAt((target.children || []) as any, parentPath.slice(1), insertIdx, node)
  return phases.map((p, i) => i === head ? { ...p, children: newChildren as any } : p)
}

function updateAt(phases: Phase[], path: Path, patch: Partial<Phase>): Phase[] {
  if (path.length === 1) {
    return phases.map((p, i) => i === path[0] ? { ...p, ...patch } : p)
  }
  const head = path[0]
  const target = phases[head]
  const newChildren = updateAt((target.children || []) as any, path.slice(1), patch)
  return phases.map((p, i) => i === head ? { ...p, children: newChildren as any } : p)
}

// 重新分配 order
function reassignOrders(phases: Phase[]): Phase[] {
  return phases.map((p, i) => ({
    ...p,
    order: i + 1,
    children: p.children ? reassignOrders(p.children as any) : [],
  })) as any
}

// ============ 拖拽放置预览 ============
type DropMode = 'before' | 'inside' | 'after'
type DragKind = 'phase' | 'doc'

interface PhaseDropTarget {
  kind: 'phase'
  path: Path
  mode: DropMode
}

interface DocDropTarget {
  kind: 'doc'
  path: Path  // 目标 phaseㄧs path
}

type DropTarget = PhaseDropTarget | DocDropTarget

// 校验：将 sourcePath 节点按 mode 放到 targetPath，是否合法
function isDropValid(phases: Phase[], sourcePath: Path, target: PhaseDropTarget, MAX_DEPTH = 3): boolean {
  const { path: targetPath, mode } = target

  // 不能拖到自己或自己的后代
  if (isAncestor(sourcePath, targetPath)) return false

  const sourceNode = getNodeAt(phases, sourcePath)
  if (!sourceNode) return false
  const sourceSubtreeDepth = nodeHeight(sourceNode)

  if (mode === 'inside') {
    // 拖入 target 作为最后一个子节点
    // 新节点深度起点 = targetPath.length + 1，加上子树高度 - 1
    const newMaxDepth = targetPath.length + sourceSubtreeDepth
    if (newMaxDepth > MAX_DEPTH) return false
  } else {
    // before / after：新节点会作为 target 的兄弟，level = targetPath.length
    const newMaxDepth = (targetPath.length - 1) + sourceSubtreeDepth
    if (newMaxDepth > MAX_DEPTH) return false
    // 同一节点的 before/after 自身不应识别成移动（无变化的同位拖拽）
    if (pathKey(sourcePath) === pathKey(targetPath)) return false
  }
  return true
}

// 执行 drop
function performDrop(phases: Phase[], sourcePath: Path, target: PhaseDropTarget): Phase[] {
  // 1) 先取出节点
  const [afterRemove, removed] = removeAt(phases, sourcePath)

  // 2) 调整 targetPath：source 移除后，如果 target 在 source 后面同级或同祖先后续，索引需要 -1
  const adjustedTargetPath = adjustPathAfterRemoval(target.path, sourcePath)

  if (target.mode === 'inside') {
    // 插到 adjustedTargetPath 节点的 children 末尾
    const targetNode = getNodeAt(afterRemove, adjustedTargetPath)
    const childCount = ((targetNode?.children || []) as any).length
    return reassignOrders(insertAt(afterRemove, adjustedTargetPath, childCount, removed))
  }

  // before / after：parentPath = adjustedTargetPath 去掉最后一段
  const parentPath = adjustedTargetPath.slice(0, -1)
  const lastIdx = adjustedTargetPath[adjustedTargetPath.length - 1]
  const insertIdx = target.mode === 'before' ? lastIdx : lastIdx + 1
  return reassignOrders(insertAt(afterRemove, parentPath, insertIdx, removed))
}

// 当移除 sourcePath 后，targetPath 索引可能需要调整
function adjustPathAfterRemoval(targetPath: Path, sourcePath: Path): Path {
  // sourcePath 的父路径 == targetPath 的同位前缀，且在同一深度处 source 索引 < target 索引时，target 索引 -1
  const parentLen = sourcePath.length - 1
  // 检查 targetPath 是否与 sourcePath 在前 parentLen 段一致
  for (let i = 0; i < parentLen; i++) {
    if (targetPath[i] !== sourcePath[i]) return targetPath
  }
  if (targetPath.length <= parentLen) return targetPath
  // 同父层，比较索引
  if (targetPath[parentLen] > sourcePath[parentLen]) {
    const next = [...targetPath]
    next[parentLen] = next[parentLen] - 1
    return next
  }
  return targetPath
}

// ============ 节点组件 ============

interface NodeProps {
  phase: Phase
  path: Path
  isDark: boolean
  pending: boolean
  docsById: Record<string, any>
  unassignedIds: string[]
  // 操作回调（基于路径）
  onUpdatePath: (path: Path, patch: Partial<Phase>) => void
  onRemovePath: (path: Path) => void
  onAddChild: (parentPath: Path) => void
  // 拖拽
  draggingKind: DragKind | null
  draggingPath: Path | null
  draggingDocId: string | null
  dropTarget: DropTarget | null
  onDragStartPath: (path: Path) => void
  onDragStartDoc: (docId: string, sourcePath: Path) => void
  onDragEndPath: () => void
  onDragOverPhase: (path: Path, mode: DropMode) => void
  onDragOverDocTarget: (path: Path) => void
  // 同层兄弟数（用于禁用按钮）
  siblingCount: number
  siblingIdx: number
  onMoveInList: (path: Path, dir: -1 | 1) => void
}

function PhaseNode({
  phase, path, isDark, pending, docsById,
  unassignedIds, onUpdatePath, onRemovePath, onAddChild,
  draggingKind, draggingPath, draggingDocId, dropTarget,
  onDragStartPath, onDragStartDoc, onDragEndPath,
  onDragOverPhase, onDragOverDocTarget,
  siblingCount, siblingIdx, onMoveInList,
}: NodeProps) {
  const level = path.length - 1
  const [expanded, setExpanded] = useState(level < 1)
  const [showDocs, setShowDocs] = useState(false)
  const [showDocPicker, setShowDocPicker] = useState(false)
  const nodeRef = useRef<HTMLLIElement>(null)

  const subText = isDark ? 'text-white/55' : 'text-black/55'
  const dimText = isDark ? 'text-white/30' : 'text-black/30'
  const inputCls = isDark
    ? 'bg-white/5 text-white border border-white/10 focus:border-white/30'
    : 'bg-black/5 text-black border border-black/10 focus:border-black/30'

  const cardBg = level === 0
    ? (isDark ? 'bg-white/[0.03] border border-white/[0.08]' : 'bg-black/[0.02] border border-black/[0.06]')
    : (isDark ? 'bg-white/[0.02] border border-white/[0.05]' : 'bg-black/[0.015] border border-black/[0.04]')

  const children = (phase.children || []) as Phase[]
  const hasChildren = children.length > 0
  const canAddChild = level < 2  // 子节点 level+1 < 3

  const isDragging = draggingKind === 'phase' && draggingPath && pathKey(draggingPath) === pathKey(path)
  const samePathTarget = dropTarget && dropTarget.kind === 'phase' && pathKey(dropTarget.path) === pathKey(path)
  const showDropAbove = samePathTarget && (dropTarget as PhaseDropTarget).mode === 'before'
  const showDropBelow = samePathTarget && (dropTarget as PhaseDropTarget).mode === 'after'
  const showDropInside = samePathTarget && (dropTarget as PhaseDropTarget).mode === 'inside'
  const showDocDropTarget = dropTarget && dropTarget.kind === 'doc' && pathKey(dropTarget.path) === pathKey(path)

  const removeDocFromPhase = (did: string) => {
    onUpdatePath(path, { doc_ids: phase.doc_ids.filter(id => id !== did) })
  }

  const addDocToPhase = (did: string) => {
    if (!phase.doc_ids.includes(did)) {
      onUpdatePath(path, { doc_ids: [...phase.doc_ids, did] })
    }
  }

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', `phase:${pathKey(path)}`)
    onDragStartPath(path)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (draggingKind === 'doc') {
      // 文档拖动：整个节点作为目标 (不分 mode)
      onDragOverDocTarget(path)
      return
    }
    if (!nodeRef.current) return
    const headerEl = nodeRef.current.querySelector('[data-node-header]') as HTMLElement | null
    if (!headerEl) return
    const rect = headerEl.getBoundingClientRect()
    const offset = e.clientY - rect.top
    const h = rect.height
    let mode: DropMode
    if (offset < h * 0.25) mode = 'before'
    else if (offset > h * 0.75) mode = 'after'
    else mode = 'inside'
    onDragOverPhase(path, mode)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onDragEndPath()
  }

  return (
    <li
      ref={nodeRef}
      className={`relative rounded-xl p-3 transition-all ${cardBg} ${isDragging ? 'opacity-40' : ''}`}
      style={{
        boxShadow: showDropInside
          ? `0 0 0 2px ${isDark ? '#5E5CE6' : '#5856D6'}`
          : showDocDropTarget
            ? `0 0 0 2px ${isDark ? '#30D158' : '#34C759'}`
            : undefined,
      }}
      draggable={!pending}
      onDragStart={handleDragStart}
      onDragEnd={onDragEndPath}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 上方插入指示线 */}
      {showDropAbove && (
        <div
          className="absolute -top-1 left-0 right-0 h-0.5 rounded-full pointer-events-none"
          style={{ background: isDark ? '#5E5CE6' : '#5856D6', boxShadow: `0 0 6px ${isDark ? '#5E5CE6' : '#5856D6'}` }}
        />
      )}
      {/* 下方插入指示线 */}
      {showDropBelow && (
        <div
          className="absolute -bottom-1 left-0 right-0 h-0.5 rounded-full pointer-events-none"
          style={{ background: isDark ? '#5E5CE6' : '#5856D6', boxShadow: `0 0 6px ${isDark ? '#5E5CE6' : '#5856D6'}` }}
        />
      )}

      <div className="flex items-start gap-2" data-node-header>
        {/* 拖拽手柄 + 顺序按钮 */}
        <div className="flex flex-col items-center pt-1 shrink-0">
          <span
            className={`text-xs cursor-grab active:cursor-grabbing select-none ${dimText} hover:opacity-80`}
            title="拖拽调整顺序或层级"
          >⋮⋮</span>
          <button
            onClick={() => onMoveInList(path, -1)}
            disabled={siblingIdx === 0 || pending}
            className={`text-xs px-1 leading-none ${dimText} hover:opacity-100 disabled:opacity-20`}
          >▲</button>
          <span className={`text-[10px] font-mono ${subText}`}>{phase.order}</span>
          <button
            onClick={() => onMoveInList(path, 1)}
            disabled={siblingIdx >= siblingCount - 1 || pending}
            className={`text-xs px-1 leading-none ${dimText} hover:opacity-100 disabled:opacity-20`}
          >▼</button>
        </div>

        {/* 主区 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {hasChildren && (
              <button
                onClick={() => setExpanded(e => !e)}
                className={`text-[10px] ${dimText} hover:opacity-100 shrink-0 w-3`}
              >{expanded ? '▼' : '▶'}</button>
            )}
            <input
              value={phase.name}
              onChange={e => onUpdatePath(path, { name: e.target.value })}
              disabled={pending}
              className={`flex-1 text-sm font-semibold rounded px-2 py-1 ${inputCls}`}
              onMouseDown={e => e.stopPropagation()}
            />
            <span className={`text-[10px] font-mono ${dimText} shrink-0`}>
              {phase.doc_ids.length}{hasChildren ? `+${children.reduce((s, c: any) => s + (c.doc_ids?.length || 0), 0)}` : ''} 篇
            </span>
            <button
              onClick={() => onRemovePath(path)}
              disabled={pending}
              className={`text-xs px-1.5 py-1 rounded transition-colors ${
                isDark ? 'text-red-400 hover:bg-red-400/15' : 'text-red-500 hover:bg-red-500/10'
              }`}
              title="删除"
            >✕</button>
          </div>

          <p className={`text-[10px] ${dimText} font-mono truncate`} title={phase.path_pattern}>
            📁 {phase.path_pattern || <span className="italic">手动创建</span>}
          </p>

          <div className="flex items-center gap-2 mt-1.5">
            {phase.doc_ids.length > 0 && (
              <button
                onClick={() => setShowDocs(s => !s)}
                className={`text-[10px] ${dimText} hover:opacity-100`}
              >{showDocs ? '收起' : '查看'}文档 ({phase.doc_ids.length})</button>
            )}
            <button
              onClick={() => setShowDocPicker(s => !s)}
              className={`text-[10px] ${dimText} hover:opacity-100`}
              disabled={pending}
            >+ 添加文档</button>
            {canAddChild && (
              <button
                onClick={() => onAddChild(path)}
                className={`text-[10px] ${isDark ? 'text-[#5E5CE6]' : 'text-[#5856D6]'} hover:opacity-100`}
                disabled={pending}
              >+ 子阶段</button>
            )}
          </div>

          {showDocs && phase.doc_ids.length > 0 && (
            <ul className="mt-2 space-y-0.5 pl-2 max-h-[160px] overflow-auto">
              {phase.doc_ids.map(did => {
                const isDocDragging = draggingKind === 'doc' && draggingDocId === did
                return (
                  <li
                    key={did}
                    draggable={!pending}
                    onDragStart={(e) => {
                      e.stopPropagation()
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', `doc:${did}`)
                      onDragStartDoc(did, path)
                    }}
                    onDragEnd={onDragEndPath}
                    className={`text-[10px] flex items-center gap-1.5 group ${subText} cursor-grab active:cursor-grabbing rounded px-1 py-0.5 transition-colors ${
                      isDocDragging ? 'opacity-30' : (isDark ? 'hover:bg-white/5' : 'hover:bg-black/5')
                    }`}
                    title="拖拽到其他阶段"
                  >
                    <span className={dimText}>⋮</span>
                    <span className="flex-1 truncate">{docsById[did]?.name || did}</span>
                    <button
                      onClick={() => removeDocFromPhase(did)}
                      disabled={pending}
                      className={`opacity-0 group-hover:opacity-100 px-1 ${isDark ? 'text-red-400' : 'text-red-500'}`}
                    >×</button>
                  </li>
                )
              })}
            </ul>
          )}

          {showDocPicker && (
            <div className={`mt-2 p-2 rounded-lg max-h-[160px] overflow-auto ${
              isDark ? 'bg-black/30' : 'bg-white/80'
            }`}>
              <p className={`text-[10px] ${dimText} mb-1`}>从未分配中选择：</p>
              {unassignedIds.length === 0 && (
                <p className={`text-[10px] ${dimText} italic`}>无可添加文档</p>
              )}
              <ul className="space-y-0.5">
                {unassignedIds.slice(0, 50).map(did => (
                  <li key={did}>
                    <button
                      onClick={() => addDocToPhase(did)}
                      className={`text-[10px] w-full text-left px-1 py-0.5 rounded ${
                        isDark ? 'hover:bg-white/10 text-white/70' : 'hover:bg-black/5 text-black/70'
                      }`}
                    >+ {docsById[did]?.name || did}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasChildren && expanded && (
            <ul className="mt-3 space-y-2 pl-3 border-l-2 border-dashed"
                style={{ borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
              {children.map((ch, idx) => (
                <PhaseNode
                  key={ch.id}
                  phase={ch}
                  path={[...path, idx]}
                  isDark={isDark}
                  pending={pending}
                  docsById={docsById}
                  unassignedIds={unassignedIds}
                  onUpdatePath={onUpdatePath}
                  onRemovePath={onRemovePath}
                  onAddChild={onAddChild}
                  draggingKind={draggingKind}
                  draggingPath={draggingPath}
                  draggingDocId={draggingDocId}
                  dropTarget={dropTarget}
                  onDragStartPath={onDragStartPath}
                  onDragStartDoc={onDragStartDoc}
                  onDragEndPath={onDragEndPath}
                  onDragOverPhase={onDragOverPhase}
                  onDragOverDocTarget={onDragOverDocTarget}
                  siblingCount={children.length}
                  siblingIdx={idx}
                  onMoveInList={onMoveInList}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  )
}

// ============ 主组件 ============

export default function PhaseProposeModal({ graph, isDark, pending, onConfirm, onCancel }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [phases, setPhases] = useState<Phase[]>([])
  const [genSummaries, setGenSummaries] = useState(true)
  const [maxDepth, setMaxDepth] = useState(2)
  const [reloadKey, setReloadKey] = useState(0)
  const [draggingKind, setDraggingKind] = useState<DragKind | null>(null)
  const [draggingPath, setDraggingPath] = useState<Path | null>(null)
  const [draggingDocId, setDraggingDocId] = useState<string | null>(null)
  const [draggingDocSourcePath, setDraggingDocSourcePath] = useState<Path | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  const docsById = useMemo(() => {
    const m: Record<string, any> = {}
    graph.docs.forEach(d => { m[d.id] = d })
    return m
  }, [graph.docs])

  const assignedIds = useMemo(() => collectAllDocIds(phases), [phases])
  const unassignedIds = useMemo(() => {
    return graph.docs.filter(d => !assignedIds.has(d.id)).map(d => d.id)
  }, [graph.docs, assignedIds])

  useEffect(() => {
    setLoading(true)
    proposePhases(graph.name, true)
      .then(r => {
        setPhases(ensureIds(r.candidates))
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [graph.name, reloadKey])

  // ============ 路径化的操作回调 ============

  const handleUpdatePath = (path: Path, patch: Partial<Phase>) => {
    setPhases(prev => updateAt(prev, path, patch))
  }

  const handleRemovePath = (path: Path) => {
    setPhases(prev => reassignOrders(removeAt(prev, path)[0]))
  }

  const handleAddChild = (parentPath: Path) => {
    const parent = getNodeAt(phases, parentPath)
    if (!parent) return
    const childCount = ((parent.children || []) as any).length
    const newNode: Phase = {
      id: genId(), name: '子阶段', path_pattern: '',
      doc_ids: [], order: childCount + 1, children: [],
    }
    setPhases(prev => insertAt(prev, parentPath, childCount, newNode))
  }

  const handleAddRoot = () => {
    setPhases(prev => [...prev, {
      id: genId(), name: '新阶段', path_pattern: '',
      doc_ids: [], order: prev.length + 1, children: [],
    } as any])
  }

  const handleMoveInList = (path: Path, dir: -1 | 1) => {
    if (path.length === 0) return
    const parentPath = path.slice(0, -1)
    const idx = path[path.length - 1]
    const parentList: Phase[] = parentPath.length === 0
      ? phases
      : (getNodeAt(phases, parentPath)?.children as any) || []
    const targetIdx = idx + dir
    if (targetIdx < 0 || targetIdx >= parentList.length) return
    const arr = [...parentList]
    ;[arr[idx], arr[targetIdx]] = [arr[targetIdx], arr[idx]]
    arr.forEach((c, i) => (c.order = i + 1))
    if (parentPath.length === 0) {
      setPhases(arr as any)
    } else {
      setPhases(prev => updateAt(prev, parentPath, { children: arr as any }))
    }
  }

  // ============ 拖拽 ============

  const handleDragStart = (path: Path) => {
    setDraggingKind('phase')
    setDraggingPath(path)
    setDraggingDocId(null)
    setDraggingDocSourcePath(null)
  }

  const handleDragStartDoc = (docId: string, sourcePath: Path) => {
    setDraggingKind('doc')
    setDraggingDocId(docId)
    setDraggingDocSourcePath(sourcePath)
    setDraggingPath(null)
  }

  const handleDragOverPhase = (path: Path, mode: DropMode) => {
    if (draggingKind !== 'phase' || !draggingPath) return
    const target: PhaseDropTarget = { kind: 'phase', path, mode }
    if (!isDropValid(phases, draggingPath, target, 3)) {
      setDropTarget(null)
      return
    }
    setDropTarget(target)
  }

  const handleDragOverDocTarget = (path: Path) => {
    if (draggingKind !== 'doc' || !draggingDocId) return
    // 拖到原位置 不动
    if (draggingDocSourcePath && pathKey(draggingDocSourcePath) === pathKey(path)) {
      setDropTarget(null)
      return
    }
    setDropTarget({ kind: 'doc', path })
  }

  const handleDragEnd = () => {
    if (draggingKind === 'phase' && draggingPath && dropTarget && dropTarget.kind === 'phase') {
      if (isDropValid(phases, draggingPath, dropTarget, 3)) {
        setPhases(prev => performDrop(prev, draggingPath, dropTarget))
      }
    } else if (draggingKind === 'doc' && draggingDocId && draggingDocSourcePath && dropTarget && dropTarget.kind === 'doc') {
      // 从源 phase 移除 + 到目标 phase 添加
      const docId = draggingDocId
      const fromPath = draggingDocSourcePath
      const toPath = dropTarget.path
      if (pathKey(fromPath) !== pathKey(toPath)) {
        setPhases(prev => {
          // 1) 从源删文档
          const fromNode = getNodeAt(prev, fromPath)
          if (!fromNode) return prev
          const next1 = updateAt(prev, fromPath, {
            doc_ids: fromNode.doc_ids.filter(id => id !== docId),
          })
          // 2) 加到目标
          const toNode = getNodeAt(next1, toPath)
          if (!toNode) return next1
          if (toNode.doc_ids.includes(docId)) return next1
          return updateAt(next1, toPath, {
            doc_ids: [...toNode.doc_ids, docId],
          })
        })
      }
    }
    setDraggingKind(null)
    setDraggingPath(null)
    setDraggingDocId(null)
    setDraggingDocSourcePath(null)
    setDropTarget(null)
  }

  // 容器底部空白拖拽：作为根层最后位置
  const handleRootDragOver = (e: React.DragEvent) => {
    if (draggingKind !== 'phase' || !draggingPath) return
    e.preventDefault()
    if (phases.length === 0) return
    const lastIdx = phases.length - 1
    if (pathKey(draggingPath) === pathKey([lastIdx])) return
    handleDragOverPhase([lastIdx], 'after')
  }

  // ============ 渲染 ============

  const handleConfirm = () => {
    onConfirm(reassignOrders(phases), genSummaries)
  }

  const cardBg = isDark ? 'bg-[#1c1c1e] text-white' : 'bg-white text-[#1d1d1f]'
  const subText = isDark ? 'text-white/50' : 'text-black/50'
  const dimText = isDark ? 'text-white/30' : 'text-black/30'

  const totalNodes = useMemo(() => {
    let n = 0
    const walk = (ns: Phase[]) => { for (const x of ns) { n++; walk((x.children || []) as any) } }
    walk(phases)
    return n
  }, [phases])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget && !pending) onCancel() }}
    >
      <div
        className={`${cardBg} rounded-2xl shadow-2xl w-[760px] max-w-[94vw] max-h-[88vh] flex flex-col overflow-hidden`}
        style={{ animation: 'modalIn 240ms cubic-bezier(0.32,0.72,0,1)' }}
      >
        <div className={`px-5 py-4 border-b flex items-center gap-3 ${isDark ? 'border-white/10' : 'border-black/5'}`}>
          <div className="flex-1">
            <h3 className="text-base font-semibold">🧭 阶段划分</h3>
            <p className={`text-[11px] mt-0.5 ${dimText}`}>
              拖拽 ⋮⋮ 调整顺序或层级 · 最多 3 层 · 支持手动添加/删除
            </p>
          </div>
          <button
            onClick={() => { setMaxDepth(d => d === 2 ? 3 : 2); setReloadKey(k => k + 1) }}
            disabled={loading || pending}
            className={`text-[11px] px-2 py-1 rounded-lg transition-colors ${
              isDark ? 'text-white/60 hover:text-white hover:bg-white/10' : 'text-black/50 hover:text-black hover:bg-black/5'
            }`}
            title="切换默认划分深度"
          >默认 {maxDepth} 层 ⇄</button>
        </div>

        <div
          className="flex-1 overflow-auto px-5 py-3"
          onDragOver={handleRootDragOver}
          onDrop={() => handleDragEnd()}
        >
          {loading && (
            <div className={`text-center py-12 ${subText}`}>
              <div className="text-3xl mb-2 animate-pulse">🧭</div>
              <p className="text-sm">分析目录结构中...</p>
            </div>
          )}
          {error && <div className="text-center py-12 text-red-500"><p className="text-sm">{error}</p></div>}

          {!loading && !error && (
            <>
              <ul className="space-y-2.5">
                {phases.map((p, idx) => (
                  <PhaseNode
                    key={p.id}
                    phase={p}
                    path={[idx]}
                    isDark={isDark}
                    pending={pending}
                    docsById={docsById}
                    unassignedIds={unassignedIds}
                    onUpdatePath={handleUpdatePath}
                    onRemovePath={handleRemovePath}
                    onAddChild={handleAddChild}
                    draggingKind={draggingKind}
                    draggingPath={draggingPath}
                    draggingDocId={draggingDocId}
                    dropTarget={dropTarget}
                    onDragStartPath={handleDragStart}
                    onDragStartDoc={handleDragStartDoc}
                    onDragEndPath={handleDragEnd}
                    onDragOverPhase={handleDragOverPhase}
                    onDragOverDocTarget={handleDragOverDocTarget}
                    siblingCount={phases.length}
                    siblingIdx={idx}
                    onMoveInList={handleMoveInList}
                  />
                ))}
              </ul>

              <button
                onClick={handleAddRoot}
                disabled={pending}
                className={`mt-3 w-full text-[11px] py-2 rounded-lg border-2 border-dashed transition-all active:scale-[0.99] ${
                  isDark
                    ? 'border-white/15 text-white/50 hover:border-white/30 hover:text-white/80'
                    : 'border-black/10 text-black/40 hover:border-black/30 hover:text-black/70'
                }`}
              >+ 添加顶层阶段</button>

              {unassignedIds.length > 0 && (
                <div className={`mt-3 p-2.5 rounded-xl text-[11px] ${
                  isDark ? 'bg-amber-500/10 text-amber-300/80' : 'bg-amber-50 text-amber-700'
                }`}>
                  ⚠️ {unassignedIds.length} 篇文档未分配到任何阶段
                </div>
              )}
            </>
          )}
        </div>

        <div className={`px-5 py-3.5 border-t flex items-center gap-2 ${isDark ? 'border-white/10' : 'border-black/5'}`}>
          <label className={`flex items-center gap-1.5 text-[11px] cursor-pointer ${subText} flex-1`}>
            <input
              type="checkbox"
              checked={genSummaries}
              onChange={e => setGenSummaries(e.target.checked)}
              disabled={pending}
              className="rounded-sm w-3 h-3"
            />
            <span>同时生成阶段总结（共 {totalNodes} 个，约 {totalNodes * 5}s）</span>
          </label>
          <button
            onClick={onCancel}
            disabled={pending}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all active:scale-95 ${
              isDark ? 'bg-white/10 hover:bg-white/15 text-white/80' : 'bg-black/5 hover:bg-black/10 text-black/70'
            }`}
          >取消</button>
          <button
            onClick={handleConfirm}
            disabled={pending || loading || phases.length === 0}
            className="px-4 py-1.5 rounded-lg text-xs font-medium text-white bg-[#007AFF] hover:bg-[#0071E3] transition-all active:scale-95 disabled:opacity-50 shadow-sm shadow-[#007AFF]/30"
          >
            {pending ? '保存中...' : '确认划分'}
          </button>
        </div>
      </div>
    </div>
  )
}
