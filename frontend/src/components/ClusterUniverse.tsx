import { useEffect, useMemo, useRef, useState } from 'react'
import type { ScanCluster, CrossLink } from '../api'

interface Props {
  clusters: ScanCluster[]
  isDark: boolean
  onClusterClick?: (cluster: ScanCluster) => void
  mergeSelection?: Set<string>
  onToggleMerge?: (clusterId: string) => void
  crossLinks?: CrossLink[]
  onCrossLinkClick?: (link: CrossLink) => void
}

const KIND_COLORS_LIGHT: Record<string, { bg: string; border: string }> = {
  project:  { bg: '#7BA7CC', border: '#5B8FAF' },
  notebook: { bg: '#7DBF96', border: '#5BA87A' },
  album:    { bg: '#C9A065', border: '#AF8A4D' },
  cache:    { bg: '#A8A8AE', border: '#8E8E93' },
  mixed:    { bg: '#9B7DB8', border: '#8567A0' },
  pattern:  { bg: '#C47B93', border: '#A86578' },
  orphan:   { bg: '#A8A8AE', border: '#8E8E93' },
}

const KIND_COLORS_DARK: Record<string, { bg: string; border: string }> = {
  project:  { bg: '#5B8FAF', border: '#3F6E8C' },
  notebook: { bg: '#5BA87A', border: '#3F865B' },
  album:    { bg: '#AF8A4D', border: '#8C6E3A' },
  cache:    { bg: '#7C7C82', border: '#5C5C62' },
  mixed:    { bg: '#8567A0', border: '#634D7A' },
  pattern:  { bg: '#A86578', border: '#864B5C' },
  orphan:   { bg: '#7C7C82', border: '#5C5C62' },
}

function getColor(c: ScanCluster, isDark: boolean) {
  const kind = c.llm_kind || c.kind
  const palette = isDark ? KIND_COLORS_DARK : KIND_COLORS_LIGHT
  return palette[kind] || palette.mixed
}

interface TopBubble {
  cluster: ScanCluster
  children: ScanCluster[]
  x: number
  y: number
  r: number  // 圆半径
}

// 半径计算
function childRadius(c: ScanCluster) {
  return 18 + (Math.max(0, Math.min(100, c.info_score)) / 100) * 22
}
function leafRadius(c: ScanCluster) {
  return 22 + (Math.max(0, Math.min(100, c.info_score)) / 100) * 30
}
// 父圆半径：根据子圆总面积 + 最大子圆两者取大，大量子圆时选多环布局
function parentRadius(children: ScanCluster[]) {
  if (children.length === 0) return 30
  const childRs = children.map(childRadius)
  const totalArea = childRs.reduce((s, r) => s + r * r * Math.PI, 0)
  // 子圆总面积占父圆面积的比例：子圆多时提高填充率（多环能填更多）
  const fillRatio = children.length <= 4 ? 0.42 : children.length <= 8 ? 0.5 : 0.55
  const minR = Math.sqrt(totalArea / Math.PI / fillRatio)
  const maxChildR = Math.max(...childRs)
  // 底线：能够包含最大子圆两倍距离 + padding
  const floor = maxChildR * 2 + 24
  return Math.max(minR, floor)
}

// 子圆在父圆内的布局：多环 + 力导防重叠
function layoutChildren(children: ScanCluster[], parentR: number): { x: number; y: number; r: number }[] {
  const n = children.length
  if (n === 0) return []
  const childRs = children.map(childRadius)

  if (n === 1) {
    return [{ x: 0, y: 0, r: childRs[0] }]
  }

  // 多环布局：按子圆大小降序，大的靠内环
  const sorted = children
    .map((c, i) => ({ c, idx: i, r: childRs[i] }))
    .sort((a, b) => b.r - a.r)

  const positions: { x: number; y: number; r: number; idx: number }[] = []

  // 判定是否需要中心圆：n>=5 且最大子圆明显比其他大
  const useCenter = n >= 5 && sorted[0].r > sorted[Math.min(2, n - 1)].r * 1.2
  let startIdx = 0
  if (useCenter) {
    positions.push({ x: 0, y: 0, r: sorted[0].r, idx: sorted[0].idx })
    startIdx = 1
  }

  // 剩下的子圆分环
  const remaining = sorted.slice(startIdx)
  const remainingCount = remaining.length

  if (remainingCount === 0) {
    return positions.sort((a, b) => a.idx - b.idx).map(p => ({ x: p.x, y: p.y, r: p.r }))
  }

  // 估计需要几环：每环能装几个平均大小的子圆
  const avgR = remaining.reduce((s, p) => s + p.r, 0) / remainingCount
  // 内环半径需要避开中心圆 + padding
  const innerOrbitMin = useCenter ? sorted[0].r + avgR + 10 : avgR + 6
  // 外环不超过父圆内边界
  const outerOrbitMax = parentR - avgR - 8

  // 单环能装的数量：周长 / (2*avgR + gap)
  function ringCapacity(orbitR: number): number {
    const itemSpan = 2 * avgR + 8 // 间距
    const circumference = 2 * Math.PI * orbitR
    return Math.max(3, Math.floor(circumference / itemSpan))
  }

  // 决定环数（1、2、或3 环）
  let rings: { orbit: number; count: number }[] = []
  if (remainingCount <= ringCapacity(innerOrbitMin) + 1) {
    // 单环
    const orbit = useCenter
      ? Math.min(outerOrbitMax, parentR * 0.62)
      : Math.min(outerOrbitMax, Math.max(parentR * 0.45, innerOrbitMin))
    rings = [{ orbit, count: remainingCount }]
  } else {
    // 多环：先 ≥2 环布局
    const innerOrbit = useCenter ? Math.max(innerOrbitMin, parentR * 0.42) : parentR * 0.4
    const outerOrbit = Math.min(outerOrbitMax, parentR * 0.78)
    const innerCap = ringCapacity(innerOrbit)

    if (remainingCount <= innerCap + ringCapacity(outerOrbit)) {
      // 两环能装下
      const innerCount = Math.min(innerCap, Math.ceil(remainingCount * 0.4))
      rings = [
        { orbit: innerOrbit, count: innerCount },
        { orbit: outerOrbit, count: remainingCount - innerCount },
      ]
    } else {
      // 三环
      const midOrbit = (innerOrbit + outerOrbit) / 2
      const innerCount = Math.min(innerCap, Math.ceil(remainingCount / 4))
      const midCount = Math.min(ringCapacity(midOrbit), Math.ceil(remainingCount / 3))
      rings = [
        { orbit: innerOrbit, count: innerCount },
        { orbit: midOrbit, count: midCount },
        { orbit: outerOrbit, count: remainingCount - innerCount - midCount },
      ]
    }
  }

  // 按 ring 布置子圆（大的优先进内环）
  let cursor = 0
  rings.forEach((ring, ringIdx) => {
    const items = remaining.slice(cursor, cursor + ring.count)
    cursor += ring.count
    const offset = ringIdx % 2 === 0 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / items.length
    items.forEach((p, i) => {
      const angle = (i / items.length) * Math.PI * 2 + offset
      positions.push({
        x: Math.cos(angle) * ring.orbit,
        y: Math.sin(angle) * ring.orbit,
        r: p.r,
        idx: p.idx,
      })
    })
  })

  // 力导松弛防重叠（在父圆内，保持中心圆不动）
  const innerLimit = parentR - 4 // 子圆中心不能超出父圆 - 自身半径
  for (let step = 0; step < 80; step++) {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i], b = positions[j]
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
        const minDist = a.r + b.r + 4
        if (dist < minDist) {
          const overlap = (minDist - dist) / dist
          // 中心圆（useCenter 且是第一个）不动
          const aFixed = useCenter && i === 0
          const bFixed = useCenter && j === 0
          if (!aFixed) {
            a.x -= dx * overlap * (bFixed ? 1 : 0.5)
            a.y -= dy * overlap * (bFixed ? 1 : 0.5)
          }
          if (!bFixed) {
            b.x += dx * overlap * (aFixed ? 1 : 0.5)
            b.y += dy * overlap * (aFixed ? 1 : 0.5)
          }
        }
      }
    }
    // 夹取在父圆内
    for (let i = 0; i < positions.length; i++) {
      if (useCenter && i === 0) continue
      const p = positions[i]
      const dist = Math.sqrt(p.x * p.x + p.y * p.y)
      const maxDist = innerLimit - p.r
      if (dist > maxDist && dist > 0) {
        p.x = (p.x / dist) * maxDist
        p.y = (p.y / dist) * maxDist
      }
    }
  }

  // 恢复原始顺序
  return positions.sort((a, b) => a.idx - b.idx).map(p => ({ x: p.x, y: p.y, r: p.r }))
}

// 顶层圆（父圆 + 单独叶圆）的力导布局
function layoutTopLevel(
  topItems: { cluster: ScanCluster; children: ScanCluster[]; r: number }[],
  width: number,
  height: number
): TopBubble[] {
  // 初始位置：圆形分布
  const cx = width / 2
  const cy = height / 2
  const bubbles: TopBubble[] = topItems.map((item, i) => {
    const angle = (i / topItems.length) * Math.PI * 2
    const initR = Math.min(width, height) * 0.3
    return {
      cluster: item.cluster,
      children: item.children,
      x: cx + Math.cos(angle) * initR,
      y: cy + Math.sin(angle) * initR,
      r: item.r,
    }
  })

  // 力导松弛
  for (let step = 0; step < 250; step++) {
    // 中心吸引（弱）
    for (const b of bubbles) {
      const dx = cx - b.x
      const dy = cy - b.y
      b.x += dx * 0.005
      b.y += dy * 0.005
    }
    // 互斥
    for (let i = 0; i < bubbles.length; i++) {
      for (let j = i + 1; j < bubbles.length; j++) {
        const a = bubbles[i], c = bubbles[j]
        const dx = c.x - a.x, dy = c.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
        const minDist = a.r + c.r + 24  // padding
        if (dist < minDist) {
          const overlap = (minDist - dist) / dist
          a.x -= dx * overlap * 0.5
          a.y -= dy * overlap * 0.5
          c.x += dx * overlap * 0.5
          c.y += dy * overlap * 0.5
        }
      }
    }
    // 边界约束
    for (const b of bubbles) {
      b.x = Math.max(b.r + 12, Math.min(width - b.r - 12, b.x))
      b.y = Math.max(b.r + 12, Math.min(height - b.r - 12, b.y))
    }
  }
  return bubbles
}

// 应用 overrides + 边界夹取
function positionedBubblesClamp(
  bubbles: TopBubble[],
  overrides: Record<string, { x: number; y: number }>,
  w: number,
  h: number,
): TopBubble[] {
  const padding = 12
  return bubbles.map(b => {
    const ov = overrides[b.cluster.id]
    let x = ov ? ov.x : b.x
    let y = ov ? ov.y : b.y
    // 夹取在画布范围内
    x = Math.max(b.r + padding, Math.min(w - b.r - padding, x))
    y = Math.max(b.r + padding, Math.min(h - b.r - padding, y))
    return { ...b, x, y }
  })
}

export default function ClusterUniverse({ clusters, isDark, onClusterClick, mergeSelection, onToggleMerge, crossLinks, onCrossLinkClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [draggingPan, setDraggingPan] = useState(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const panStartRef = useRef<{ pan: { x: number; y: number }; mouse: { x: number; y: number } } | null>(null)

  // 父圆位置 override（用户拖动后保留）
  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>({})

  // 内部逻辑画布尺寸（固定）：所有圈圈在这个尺寸里布局
  const SCENE_W = 1000
  const SCENE_H = 700

  // 外层缩放 = 容器尺寸 / 场景尺寸 × 用户 zoom
  const fitScale = Math.min(
    size.w > 0 ? size.w / SCENE_W : 1,
    size.h > 0 ? size.h / SCENE_H : 1,
  )
  const totalScale = fitScale * zoom

  // 监听容器尺寸
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => {
      const rect = containerRef.current!.getBoundingClientRect()
      setSize({ w: rect.width, h: rect.height })
    })
    ro.observe(containerRef.current)
    const rect = containerRef.current.getBoundingClientRect()
    setSize({ w: rect.width, h: rect.height })
    return () => ro.disconnect()
  }, [])

  // 计算每个父圆的子圆数据
  const topItems = useMemo(() => {
    const childrenMap: Record<string, ScanCluster[]> = {}
    for (const c of clusters) {
      if (c.parent_id) {
        if (!childrenMap[c.parent_id]) childrenMap[c.parent_id] = []
        childrenMap[c.parent_id].push(c)
      }
    }
    return clusters
      .filter(c => !c.parent_id)
      .map(c => {
        const children = childrenMap[c.id] || []
        const r = children.length > 0 ? parentRadius(children) : leafRadius(c)
        return { cluster: c, children, r }
      })
  }, [clusters])

  // 力导布局始终使用 SCENE 尺寸（不随容器变）
  const bubbles = useMemo(() => {
    if (topItems.length === 0) return []
    return layoutTopLevel(topItems, SCENE_W, SCENE_H)
  }, [topItems])

  // 应用 overrides + 边界夹取（边界以场景尺寸为准）
  const positionedBubbles = positionedBubblesClamp(bubbles, overrides, SCENE_W, SCENE_H)

  // 拖动逻辑（按场景坐标计算，需要除以 totalScale 将屏幕距离转场景距离）
  function handleBubbleMouseDown(e: React.MouseEvent, bubble: TopBubble) {
    e.stopPropagation()
    setDraggingId(bubble.cluster.id)
    const rect = containerRef.current!.getBoundingClientRect()
    const sceneX = (e.clientX - rect.left - pan.x) / totalScale
    const sceneY = (e.clientY - rect.top - pan.y) / totalScale
    dragOffsetRef.current = { x: sceneX - bubble.x, y: sceneY - bubble.y }
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (draggingId) {
      const rect = containerRef.current!.getBoundingClientRect()
      const sceneX = (e.clientX - rect.left - pan.x) / totalScale
      const sceneY = (e.clientY - rect.top - pan.y) / totalScale
      setOverrides(prev => ({
        ...prev,
        [draggingId]: {
          x: sceneX - dragOffsetRef.current.x,
          y: sceneY - dragOffsetRef.current.y,
        },
      }))
    } else if (draggingPan && panStartRef.current) {
      const dx = e.clientX - panStartRef.current.mouse.x
      const dy = e.clientY - panStartRef.current.mouse.y
      setPan({
        x: panStartRef.current.pan.x + dx,
        y: panStartRef.current.pan.y + dy,
      })
    }
  }

  function handleMouseUp() {
    setDraggingId(null)
    setDraggingPan(false)
    panStartRef.current = null
  }

  function handleBackgroundMouseDown(e: React.MouseEvent) {
    setDraggingPan(true)
    panStartRef.current = { pan, mouse: { x: e.clientX, y: e.clientY } }
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault()
    const rect = containerRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    const newZoom = Math.max(0.3, Math.min(3, zoom * factor))
    const oldTotal = fitScale * zoom
    const newTotal = fitScale * newZoom
    // 以鼠标位置为锚
    const newPan = {
      x: mx - (mx - pan.x) * (newTotal / oldTotal),
      y: my - (my - pan.y) * (newTotal / oldTotal),
    }
    setZoom(newZoom)
    setPan(newPan)
  }

  function handleResetView() {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setOverrides({})
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      style={{
        cursor: draggingPan ? 'grabbing' : draggingId ? 'grabbing' : 'grab',
        background: isDark ? 'transparent' : 'transparent',
      }}
    >
      {/* 拖动背景捕获 */}
      <div
        className="absolute inset-0"
        onMouseDown={handleBackgroundMouseDown}
      />

      {/* 圆圈层 */}
      <div
        className="absolute"
        style={{
          left: 0,
          top: 0,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${totalScale})`,
          transformOrigin: '0 0',
          width: SCENE_W,
          height: SCENE_H,
          pointerEvents: 'none',
          transition: draggingId || draggingPan ? 'none' : 'transform 0.25s ease-out',
        }}
      >
        {positionedBubbles.map(bubble => (
          <Bubble
            key={bubble.cluster.id}
            bubble={bubble}
            isDark={isDark}
            onMouseDown={handleBubbleMouseDown}
            onClusterClick={onClusterClick}
            mergeSelection={mergeSelection}
            onToggleMerge={onToggleMerge}
          />
        ))}

        {/* 跨组关联指示器：必须在 transform 容器内 */}
        {crossLinks && crossLinks.length > 0 && (
          <CrossLinkOverlay
            crossLinks={crossLinks}
            bubbles={positionedBubbles}
            isDark={isDark}
            onLinkClick={onCrossLinkClick}
          />
        )}
      </div>

      {/* 图例 */}
      <div className={`absolute top-4 left-4 px-3 py-2 rounded-xl backdrop-blur-xl border text-[10px] flex items-center gap-3 z-20 ${
        isDark ? 'bg-white/5 border-white/10 text-white/70' : 'bg-white/70 border-black/5 text-black/60'
      }`}>
        <Legend color={(isDark ? KIND_COLORS_DARK : KIND_COLORS_LIGHT).project.bg} label="项目" />
        <Legend color={(isDark ? KIND_COLORS_DARK : KIND_COLORS_LIGHT).notebook.bg} label="笔记" />
        <Legend color={(isDark ? KIND_COLORS_DARK : KIND_COLORS_LIGHT).album.bg} label="图集" />
        <Legend color={(isDark ? KIND_COLORS_DARK : KIND_COLORS_LIGHT).mixed.bg} label="混合" />
        <Legend color={(isDark ? KIND_COLORS_DARK : KIND_COLORS_LIGHT).cache.bg} label="冗余/缓存" />
      </div>

      {/* 控制条 */}
      <div className={`absolute bottom-4 right-4 flex items-center gap-1 px-2 py-1 rounded-xl backdrop-blur-xl border z-20 ${
        isDark ? 'bg-white/5 border-white/10' : 'bg-white/70 border-black/5'
      }`}>
        <button
          onClick={() => setZoom(z => Math.min(3, z * 1.2))}
          className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm ${
            isDark ? 'hover:bg-white/10 text-white/70' : 'hover:bg-black/5 text-black/60'
          }`}
          title="放大"
        >+</button>
        <button
          onClick={() => setZoom(z => Math.max(0.3, z * 0.85))}
          className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm ${
            isDark ? 'hover:bg-white/10 text-white/70' : 'hover:bg-black/5 text-black/60'
          }`}
          title="缩小"
        >−</button>
        <button
          onClick={handleResetView}
          className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs ${
            isDark ? 'hover:bg-white/10 text-white/70' : 'hover:bg-black/5 text-black/60'
          }`}
          title="重置视图"
        >⌖</button>
        <span className={`px-2 text-[10px] ${isDark ? 'text-white/40' : 'text-black/40'}`}>
          {Math.round(zoom * 100)}%
        </span>
      </div>
    </div>
  )
}

function Bubble({ bubble, isDark, onMouseDown, onClusterClick, mergeSelection, onToggleMerge }: {
  bubble: TopBubble
  isDark: boolean
  onMouseDown: (e: React.MouseEvent, b: TopBubble) => void
  onClusterClick?: (c: ScanCluster) => void
  mergeSelection?: Set<string>
  onToggleMerge?: (id: string) => void
}) {
  const c = bubble.cluster
  const color = getColor(c, isDark)
  const isParent = bubble.children.length > 0
  const dim = c.redundant
  const selected = mergeSelection?.has(c.id) || false
  const hasMergeMode = mergeSelection && mergeSelection.size > 0
  const childPositions = useMemo(
    () => isParent ? layoutChildren(bubble.children, bubble.r) : [],
    [bubble.children, bubble.r, isParent]
  )

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    // shift/cmd 点击进入多选合并
    if ((e.shiftKey || e.metaKey || e.ctrlKey) && onToggleMerge) {
      onToggleMerge(c.id)
      return
    }
    // 已在合并选择模式下，直接点击也 toggle
    if (hasMergeMode && onToggleMerge) {
      onToggleMerge(c.id)
      return
    }
    if (onClusterClick) onClusterClick(c)
  }

  return (
    <div
      className="absolute group"
      style={{
        left: bubble.x - bubble.r,
        top: bubble.y - bubble.r,
        width: bubble.r * 2,
        height: bubble.r * 2,
        pointerEvents: 'auto',
      }}
    >
      {/* 父圆/独立圆容器 */}
      <div
        onMouseDown={e => onMouseDown(e, bubble)}
        onClick={handleClick}
        className="relative rounded-full transition-shadow cursor-grab active:cursor-grabbing"
        style={{
          width: '100%',
          height: '100%',
          background: isParent
            ? (isDark ? color.bg + '20' : color.bg + '15')
            : color.bg,
          border: selected
            ? `3px solid #0A84FF`
            : `${isParent ? 1.5 : 2}px solid ${color.border}${isParent ? '99' : ''}`,
          opacity: dim ? 0.4 : 1,
          boxShadow: selected
            ? '0 0 0 4px rgba(10,132,255,0.25), 0 4px 16px rgba(10,132,255,0.4)'
            : isParent
              ? 'none'
              : (isDark ? '0 4px 16px rgba(0,0,0,0.3)' : '0 4px 12px rgba(0,0,0,0.06)'),
          backdropFilter: isParent ? 'blur(2px)' : 'none',
        }}
      >
        {/* 选中角标 */}
        {selected && (
          <div
            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#0A84FF] flex items-center justify-center shadow-md pointer-events-none z-10"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        )}
        {/* 父圆的 label 在顶部 */}
        {isParent && (
          <div
            className="absolute left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap pointer-events-none"
            style={{
              top: -28,
              color: isDark ? '#FFFFFF' : '#1D1D1F',
              background: isDark ? 'rgba(28,28,30,0.7)' : 'rgba(255,255,255,0.7)',
              backdropFilter: 'blur(8px)',
            }}
          >
            {c.label}
            <span className={`ml-1.5 text-[10px] ${isDark ? 'text-white/50' : 'text-black/40'}`}>
              {c.file_count}
            </span>
          </div>
        )}

        {/* 叶节点的 label 在圆内 */}
        {!isParent && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-1.5 text-center"
          >
            <div
              className="text-[11px] font-semibold leading-tight"
              style={{
                color: '#FFFFFF',
                textShadow: '0 1px 2px rgba(0,0,0,0.25)',
                fontSize: Math.min(13, Math.max(10, bubble.r / 4)),
              }}
            >
              {truncate(c.label, Math.floor(bubble.r / 5))}
            </div>
            <div
              className="text-[9px] mt-0.5"
              style={{
                color: 'rgba(255,255,255,0.85)',
                fontSize: Math.min(10, Math.max(8, bubble.r / 6)),
              }}
            >
              {c.file_count}
            </div>
          </div>
        )}

        {/* 子圆（坐标相对父圆中心） */}
        {isParent && bubble.children.map((child, i) => {
          const cp = childPositions[i]
          const childColor = getColor(child, isDark)
          const dimChild = child.redundant
          const childSelected = mergeSelection?.has(child.id) || false
          return (
            <div
              key={child.id}
              onMouseDown={e => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                if ((e.shiftKey || e.metaKey || e.ctrlKey) && onToggleMerge) {
                  onToggleMerge(child.id)
                  return
                }
                if (hasMergeMode && onToggleMerge) {
                  onToggleMerge(child.id)
                  return
                }
                if (onClusterClick) onClusterClick(child)
              }}
              className="absolute rounded-full cursor-pointer transition-all hover:scale-105"
              style={{
                left: bubble.r + cp.x - cp.r,
                top: bubble.r + cp.y - cp.r,
                width: cp.r * 2,
                height: cp.r * 2,
                background: childColor.bg,
                border: childSelected
                  ? `3px solid #0A84FF`
                  : `2px solid ${childColor.border}`,
                boxShadow: childSelected
                  ? '0 0 0 3px rgba(10,132,255,0.3)'
                  : (isDark ? '0 3px 10px rgba(0,0,0,0.4)' : '0 3px 8px rgba(0,0,0,0.08)'),
                opacity: dimChild ? 0.4 : 1,
              }}
            >
              {childSelected && (
                <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#0A84FF] flex items-center justify-center shadow-md pointer-events-none z-10">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="5"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
              )}
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-1 text-center">
                <div
                  className="font-semibold leading-tight"
                  style={{
                    color: '#FFFFFF',
                    textShadow: '0 1px 2px rgba(0,0,0,0.3)',
                    fontSize: Math.min(11, Math.max(9, cp.r / 4)),
                  }}
                >
                  {truncate(child.label, Math.floor(cp.r / 4.5))}
                </div>
                <div
                  className="mt-0.5"
                  style={{
                    color: 'rgba(255,255,255,0.85)',
                    fontSize: Math.min(9, Math.max(8, cp.r / 5.5)),
                  }}
                >
                  {child.file_count}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, Math.max(2, maxChars - 1)) + '…'
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <div className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  )
}


// ============ 跨组关联：光点 + hover 连线 ============

function CrossLinkOverlay({ crossLinks, bubbles, isDark, onLinkClick }: {
  crossLinks: CrossLink[]
  bubbles: TopBubble[]
  isDark: boolean
  onLinkClick?: (link: CrossLink) => void
}) {
  const [hoveredCluster, setHoveredCluster] = useState<string | null>(null)

  // 统计每个 cluster 参与的 link 数
  const clusterLinkCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const link of crossLinks) {
      m[link.source_cluster_id] = (m[link.source_cluster_id] || 0) + 1
      m[link.target_cluster_id] = (m[link.target_cluster_id] || 0) + 1
    }
    return m
  }, [crossLinks])

  // hover 时显示的连线
  const activeLines = useMemo(() => {
    if (!hoveredCluster) return []
    return crossLinks.filter(
      l => l.source_cluster_id === hoveredCluster || l.target_cluster_id === hoveredCluster
    )
  }, [crossLinks, hoveredCluster])

  // 找到有关联的 cluster 的 bubble 位置
  const linkedClusterIds = Object.keys(clusterLinkCount)

  return (
    <>
      {/* 光点层（放在气泡之上） */}
      {linkedClusterIds.map(cid => {
        const bubble = bubbles.find(b => b.cluster.id === cid)
        if (!bubble) return null
        const count = clusterLinkCount[cid]
        // 光点位置：右上角偏移
        const dotX = bubble.x + bubble.r * 0.7
        const dotY = bubble.y - bubble.r * 0.7
        const isHovered = hoveredCluster === cid
        return (
          <div
            key={`dot-${cid}`}
            onMouseEnter={() => setHoveredCluster(cid)}
            onMouseLeave={() => setHoveredCluster(null)}
            onClick={() => {
              // 点击光点 → 弹出第一条关联
              const link = crossLinks.find(l => l.source_cluster_id === cid || l.target_cluster_id === cid)
              if (link && onLinkClick) onLinkClick(link)
            }}
            className={`absolute z-20 cursor-pointer transition-all ${
              isHovered ? 'scale-125' : 'animate-pulse'
            }`}
            style={{
              left: dotX - 8,
              top: dotY - 8,
              width: 16,
              height: 16,
            }}
            title={`${count} 条跨组关联`}
          >
            <div className="w-full h-full rounded-full flex items-center justify-center"
              style={{
                background: isDark ? 'rgba(255, 176, 56, 0.85)' : 'rgba(220, 140, 20, 0.85)',
                boxShadow: `0 0 ${isHovered ? 12 : 6}px ${isDark ? 'rgba(255, 176, 56, 0.5)' : 'rgba(220, 140, 20, 0.4)'}`,
              }}
            >
              <span className="text-[8px] font-bold text-white">{count}</span>
            </div>
          </div>
        )
      })}

      {/* hover 时的连线（SVG） */}
      {activeLines.length > 0 && (
        <svg
          className="absolute inset-0 pointer-events-none z-[15]"
          style={{ width: '100%', height: '100%', overflow: 'visible' }}
        >
          {activeLines.map((link, i) => {
            const srcBubble = bubbles.find(b => b.cluster.id === link.source_cluster_id)
            const tgtBubble = bubbles.find(b => b.cluster.id === link.target_cluster_id)
            if (!srcBubble || !tgtBubble) return null
            // 从圆圈边缘出发而非中心
            const dx = tgtBubble.x - srcBubble.x
            const dy = tgtBubble.y - srcBubble.y
            const dist = Math.sqrt(dx * dx + dy * dy) || 1
            const nx = dx / dist
            const ny = dy / dist
            const x1 = srcBubble.x + nx * srcBubble.r
            const y1 = srcBubble.y + ny * srcBubble.r
            const x2 = tgtBubble.x - nx * tgtBubble.r
            const y2 = tgtBubble.y - ny * tgtBubble.r
            // 贝塞尔曲线（微弧形）
            const midX = (x1 + x2) / 2 + (y2 - y1) * 0.1
            const midY = (y1 + y2) / 2 - (x2 - x1) * 0.1
            return (
              <g key={i}>
                <path
                  d={`M ${x1} ${y1} Q ${midX} ${midY} ${x2} ${y2}`}
                  fill="none"
                  stroke={isDark ? '#FFB038' : '#DC8C14'}
                  strokeWidth={1.5}
                  strokeOpacity={0.6}
                  strokeLinecap="round"
                />
                {/* 端点小圆 */}
                                <circle cx={x2} cy={y2} r={3} fill={isDark ? '#FFB038' : '#DC8C14'} fillOpacity={0.8} />
              </g>
            )
          })}
        </svg>
      )}
    </>
  )
}
