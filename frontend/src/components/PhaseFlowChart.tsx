import { useEffect, useMemo, useRef, useState } from 'react'
import type { Phase, PhaseFlow } from '../api'

interface Props {
  phases: Phase[]
  flow: PhaseFlow | null
  isDark: boolean
  onAnalyze: () => void
  analyzing: boolean
  palette: string[]
}

const EDGE_TYPE_STYLE: Record<string, { color: string; label: string }> = {
  feeds: { color: '#5AC8FA', label: '提供数据' },
  derives: { color: '#34C759', label: '推导分析' },
  concludes: { color: '#FF9500', label: '汇总结论' },
  references: { color: '#AF52DE', label: '引用参考' },
}

function roleIcon(name: string): string {
  if (name.includes('访谈')) return '💬'
  if (name.includes('分析') || name.includes('差异')) return '🔍'
  if (name.includes('数据') || name.includes('收集')) return '📊'
  if (name.includes('规划') || name.includes('启动') || name.includes('计划')) return '📋'
  return '⚙️'
}

function collectDocCount(node: Phase): number {
  return (node.doc_ids || []).length + (node.children || []).reduce((s, c) => s + collectDocCount(c), 0)
}

export default function PhaseFlowChart({ phases, flow, isDark, onAnalyze, analyzing, palette }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 顶层阶段按 order 排序
  const topPhases = useMemo(
    () => [...phases].sort((a, b) => (a.order || 0) - (b.order || 0)),
    [phases]
  )

  // 顶层之间的连线（来自 phase_flow，子节点的关系合并到父）
  const topEdges = useMemo(() => {
    if (!flow) {
      // 默认按 order 串成链
      return topPhases.slice(0, -1).map((p, i) => ({
        from: p.id,
        to: topPhases[i + 1].id,
        label: '',
        type: 'feeds',
      }))
    }
    // 子→顶层映射
    const idToTop = new Map<string, string>()
    function walk(p: Phase, topId: string) {
      idToTop.set(p.id, topId)
      ;(p.children || []).forEach(c => walk(c, topId))
    }
    topPhases.forEach(p => walk(p, p.id))

    const seen = new Set<string>()
    const result: Array<{ from: string; to: string; label: string; type: string }> = []
    flow.edges.forEach(e => {
      const tf = idToTop.get(e.from)
      const tt = idToTop.get(e.to)
      if (!tf || !tt || tf === tt) return
      const k = `${tf}->${tt}`
      if (seen.has(k)) return
      seen.add(k)
      result.push({ from: tf, to: tt, label: e.label || '', type: e.type || 'feeds' })
    })
    return result
  }, [flow, topPhases])

  // 布局：每个顶层是一个固定宽度卡片，水平排列
  const layout = useMemo(() => {
    const CARD_W = 260
    const HEAD_H = 50
    const SUB_H = 64
    const SUB_GAP = 10
    const PAD_INNER = 14
    const MIN_GAP_X = 90
    const PAD = 50

    // 根据连线标签最长文本动态计算间距
    const maxLabelW = topEdges.reduce((max, e) => {
      if (!e.label) return max
      const w = [...e.label].reduce((s, ch) => s + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 11 : 6), 0) + 20
      return Math.max(max, w)
    }, 0)
    const GAP_X = Math.max(MIN_GAP_X, maxLabelW + 50)

    const cards = topPhases.map((p, i) => {
      const subCount = (p.children || []).length
      const mainH = SUB_H
      const childrenH = subCount > 0 ? subCount * SUB_H + (subCount - 1) * SUB_GAP : 0
      const innerGap = subCount > 0 ? 12 : 0
      const labelH = subCount > 0 ? 18 : 0
      const h = HEAD_H + PAD_INNER + mainH + innerGap + labelH + childrenH + PAD_INNER
      return {
        id: p.id,
        index: i,
        x: PAD + i * (CARD_W + GAP_X),
        y: PAD,
        w: CARD_W,
        h,
      }
    })

    const totalWidth = PAD * 2 + topPhases.length * CARD_W + Math.max(0, topPhases.length - 1) * GAP_X
    const totalHeight = PAD * 2 + Math.max(...cards.map(c => c.h), 200)

    return { cards, totalWidth, totalHeight, HEAD_H }
  }, [topPhases, topEdges])

  const cardById = useMemo(() => {
    const m = new Map<string, typeof layout.cards[0]>()
    layout.cards.forEach(c => m.set(c.id, c))
    return m
  }, [layout])

  // 自适应缩放
  const fitToView = () => {
    if (!containerRef.current) return
    const cw = containerRef.current.clientWidth
    const ch = containerRef.current.clientHeight
    if (cw <= 0 || ch <= 0) return
    const scale = Math.max(0.2, Math.min(cw / layout.totalWidth, ch / layout.totalHeight, 1) * 0.9)
    setZoom(scale)
    setPan({
      x: Math.max(20, (cw - layout.totalWidth * scale) / 2),
      y: Math.max(20, (ch - layout.totalHeight * scale) / 2),
    })
  }

  useEffect(() => {
    const t = setTimeout(fitToView, 50)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topPhases.map(p => p.id).join(',')])

  // 平移
  const dragState = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null)
  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-card]')) return
    dragState.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragState.current) return
      setPan({
        x: dragState.current.px + e.clientX - dragState.current.sx,
        y: dragState.current.py + e.clientY - dragState.current.sy,
      })
    }
    const onUp = () => { dragState.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setZoom(z => Math.max(0.3, Math.min(2.5, z - e.deltaY * 0.002)))
  }

  // 计算连线路径
  const edgePaths = topEdges
    .map((e, idx) => {
      const src = cardById.get(e.from)
      const dst = cardById.get(e.to)
      if (!src || !dst) return null
      const reverse = dst.x < src.x
      let path: string
      let lx: number, ly: number
      if (reverse) {
        // 反向边：从底部绕过
        const sx = src.x + src.w * 0.7
        const sy = src.y + src.h
        const tx = dst.x + dst.w * 0.3
        const ty = dst.y + dst.h
        const midY = Math.max(sy, ty) + 60
        path = `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`
        lx = (sx + tx) / 2
        ly = midY - 4
      } else {
        const sx = src.x + src.w
        const sy = src.y + layout.HEAD_H / 2
        const tx = dst.x
        const ty = dst.y + layout.HEAD_H / 2
        lx = (sx + tx) / 2
        ly = (sy + ty) / 2
        const cx = sx + (tx - sx) * 0.5
        path = `M ${sx} ${sy} C ${cx} ${sy}, ${cx} ${ty}, ${tx} ${ty}`
      }
      return { path, lx, ly, edge: e, idx, reverse }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const subText = isDark ? 'text-white/55' : 'text-black/55'
  const dimText = isDark ? 'text-white/30' : 'text-black/30'

  if (topPhases.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className={`text-center ${dimText}`}>
          <p className="text-7xl mb-4">🔀</p>
          <p>还没有阶段</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* insight */}
      {flow?.insight && (
        <div
          className={`px-6 py-3 border-b flex items-start gap-3 ${
            isDark ? 'border-white/[0.06]' : 'border-black/[0.04]'
          }`}
        >
          <span className="text-xl">💡</span>
          <div className="flex-1">
            <div className={`text-[10px] font-semibold uppercase tracking-widest ${dimText}`}>
              整体洞察
            </div>
            <p className={`text-[13px] mt-0.5 ${isDark ? 'text-white/85' : 'text-black/80'}`}>
              {flow.insight}
            </p>
          </div>
        </div>
      )}

      {/* 工具条 */}
      <div
        className={`px-5 py-2 border-b flex items-center gap-3 text-[11px] ${
          isDark ? 'border-white/[0.06] text-white/50' : 'border-black/[0.04] text-black/50'
        }`}
      >
        {flow ? (
          <>
            <span className="font-medium">关系:</span>
            {Object.entries(EDGE_TYPE_STYLE).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span
                  className="inline-block w-5 h-[2px]"
                  style={{ background: v.color, borderRadius: 1 }}
                />
                <span>{v.label}</span>
              </span>
            ))}
          </>
        ) : (
          <span className="opacity-70">未生成内容流程，按阶段顺序串接</span>
        )}
        <span className="ml-auto opacity-60">
          {topPhases.length} 顶层阶段
        </span>
        <div className={`flex p-0.5 rounded-lg ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.05]'}`}>
          <button
            onClick={() => setZoom(z => Math.max(0.3, z - 0.15))}
            className={`px-2 py-0.5 rounded ${isDark ? 'hover:bg-white/10' : 'hover:bg-white'}`}
          >
            −
          </button>
          <span className={`px-2 py-0.5 font-mono text-[10px] ${dimText}`}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom(z => Math.min(2.5, z + 0.15))}
            className={`px-2 py-0.5 rounded ${isDark ? 'hover:bg-white/10' : 'hover:bg-white'}`}
          >
            +
          </button>
        </div>
        <button
          onClick={fitToView}
          className={`px-2 py-1 rounded ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}
        >
          ⤢ 适应
        </button>
        <button
          onClick={onAnalyze}
          disabled={analyzing}
          className="px-2.5 py-1 rounded text-white bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50"
        >
          🔮 {analyzing ? '分析中' : flow ? '重新分析' : '分析流程'}
        </button>
      </div>

      {/* 画布 */}
      <div
        ref={containerRef}
        className={`flex-1 overflow-hidden relative cursor-grab active:cursor-grabbing ${
          isDark ? 'bg-[#0a0a0a]' : 'bg-[#fafafa]'
        }`}
        onMouseDown={onMouseDown}
        onWheel={onWheel}
      >
        <div
          className="absolute origin-top-left"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            width: layout.totalWidth,
            height: layout.totalHeight,
          }}
        >
          {/* SVG 连线 */}
          <svg
            width={layout.totalWidth}
            height={layout.totalHeight}
            className="absolute top-0 left-0 pointer-events-none"
            style={{ overflow: 'visible' }}
          >
            <defs>
              {Object.entries(EDGE_TYPE_STYLE).map(([k, v]) => (
                <marker
                  key={k}
                  id={`arrow-${k}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="8"
                  markerHeight="8"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={v.color} />
                </marker>
              ))}
              <marker
                id="arrow-default"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={isDark ? '#888' : '#666'} />
              </marker>
            </defs>
            {edgePaths.map(({ path, lx, ly, edge, idx, reverse }) => {
              const style = EDGE_TYPE_STYLE[edge.type] || {
                color: isDark ? '#888' : '#666',
                label: '',
              }
              return (
                <g key={idx}>
                  <path
                    d={path}
                    stroke={style.color}
                    strokeWidth={2.2}
                    strokeDasharray={reverse ? '6,4' : undefined}
                    fill="none"
                    markerEnd={`url(#arrow-${edge.type || 'default'})`}
                    strokeLinecap="round"
                  />
                  {edge.label && (
                    <g transform={`translate(${lx},${ly})`}>
                      {(() => {
                        // 精确计算：中文字符约11px，ASCII约6px
                        const textW = [...edge.label].reduce((w, ch) => w + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 11 : 6), 0)
                        const padX = 10
                        const boxW = textW + padX * 2
                        return (
                          <rect
                            x={-boxW / 2}
                            y={-9}
                            width={boxW}
                            height={18}
                            rx={9}
                            fill={isDark ? '#1a1a1a' : '#ffffff'}
                            stroke={style.color}
                            strokeWidth={1.2}
                          />
                        )
                      })()}
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={11}
                        fontWeight={500}
                        fill={style.color}
                      >
                        {edge.label}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}
          </svg>

          {/* 阶段卡片 */}
          {layout.cards.map(card => {
            const phase = topPhases.find(p => p.id === card.id)!
            const color = palette[card.index % palette.length]
            const isHovered = hoveredId === card.id
            const subPhases = phase.children || []
            const docCount = collectDocCount(phase)

            return (
              <div
                key={card.id}
                data-card
                onMouseEnter={() => setHoveredId(card.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => setSelectedId(s => (s === card.id ? null : card.id))}
                className="absolute select-none cursor-pointer"
                style={{
                  left: card.x,
                  top: card.y,
                  width: card.w,
                  height: card.h,
                  zIndex: isHovered ? 5 : 1,
                }}
              >
                <div
                  className={`w-full h-full rounded-2xl overflow-hidden flex flex-col ${
                    isDark ? 'bg-[#1c1c1e]' : 'bg-white'
                  }`}
                  style={{
                    boxShadow: isHovered
                      ? `0 8px 24px ${color}40, 0 0 0 2px ${color}`
                      : isDark
                      ? `0 2px 8px rgba(0,0,0,0.4), 0 0 0 1px ${color}30`
                      : `0 2px 8px rgba(0,0,0,0.06), 0 0 0 1px ${color}20`,
                  }}
                >
                  {/* 标题栏 */}
                  <div
                    className="flex items-center gap-2 px-3.5 shrink-0"
                    style={{
                      height: layout.HEAD_H,
                      background: `linear-gradient(135deg, ${color}, ${color}dd)`,
                    }}
                  >
                    <span className="text-base">{roleIcon(phase.name)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[9px] font-bold uppercase tracking-widest text-white/80 leading-none">
                        第 {phase.order} 阶段
                      </div>
                      <div className="text-[14px] font-bold text-white truncate leading-tight mt-0.5">
                        {phase.name}
                      </div>
                    </div>
                    <span className="text-[10px] text-white/85 px-1.5 py-0.5 rounded bg-white/20 shrink-0">
                      {docCount}
                    </span>
                  </div>

                  {/* 内容 */}
                  <div className="flex-1 px-3 py-3 flex flex-col gap-2.5 overflow-hidden">
                    {/* 主块 */}
                    <div
                      className={`rounded-xl px-3 py-2 ${
                        isDark ? 'bg-white/[0.04]' : 'bg-black/[0.025]'
                      }`}
                      style={{ borderLeft: `3px solid ${color}` }}
                    >
                      <div
                        className={`text-[12px] font-semibold leading-tight truncate ${
                          isDark ? 'text-white/95' : 'text-black/90'
                        }`}
                      >
                        {phase.objective || phase.name}
                      </div>
                      {phase.summary && (
                        <div className={`text-[10px] mt-0.5 line-clamp-2 leading-snug ${subText}`}>
                          {phase.summary.slice(0, 80)}
                        </div>
                      )}
                    </div>

                    {/* 子阶段 */}
                    {subPhases.length > 0 && (
                      <>
                        <div
                          className={`text-[9px] font-bold uppercase tracking-widest px-1 ${dimText}`}
                        >
                          子阶段 · {subPhases.length}
                        </div>
                        {subPhases.map(sub => (
                          <div
                            key={sub.id}
                            className={`rounded-xl px-3 py-2 flex items-center gap-2 ${
                              isDark ? 'bg-white/[0.025]' : 'bg-black/[0.015]'
                            }`}
                            style={{ borderLeft: `3px solid ${color}99` }}
                          >
                            <span className="text-base">{roleIcon(sub.name)}</span>
                            <div className="flex-1 min-w-0">
                              <div
                                className={`text-[12px] font-semibold leading-tight truncate ${
                                  isDark ? 'text-white/90' : 'text-black/85'
                                }`}
                              >
                                {sub.name}
                              </div>
                              {sub.objective && (
                                <div
                                  className={`text-[10px] line-clamp-1 leading-snug ${subText}`}
                                >
                                  {sub.objective}
                                </div>
                              )}
                            </div>
                            {collectDocCount(sub) > 0 && (
                              <span
                                className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
                                style={{ background: `${color}22`, color }}
                              >
                                {collectDocCount(sub)}
                              </span>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* 选中详情 */}
        {selectedId &&
          (() => {
            const p = topPhases.find(x => x.id === selectedId)
            if (!p) return null
            return (
              <div
                className={`absolute right-4 top-4 max-w-sm rounded-2xl p-4 z-20 ${
                  isDark ? 'bg-[#1c1c1e]' : 'bg-white'
                }`}
                style={{
                  boxShadow: isDark
                    ? '0 8px 32px rgba(0,0,0,0.6)'
                    : '0 8px 32px rgba(0,0,0,0.15)',
                }}
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div
                      className={`text-[10px] font-semibold uppercase tracking-widest ${dimText}`}
                    >
                      第 {p.order} 阶段
                    </div>
                    <h4
                      className={`text-base font-bold mt-0.5 ${
                        isDark ? 'text-white' : 'text-black'
                      }`}
                    >
                      {p.name}
                    </h4>
                  </div>
                  <button
                    onClick={() => setSelectedId(null)}
                    className={`text-sm ${dimText} hover:text-red-500`}
                  >
                    ✕
                  </button>
                </div>
                {p.summary && (
                  <p className={`text-[12px] leading-relaxed ${subText}`}>{p.summary}</p>
                )}
                {(p.outputs?.length || 0) > 0 && (
                  <div className="mt-2.5">
                    <div
                      className={`text-[10px] font-semibold uppercase tracking-widest mb-1 ${dimText}`}
                    >
                      📦 产出
                    </div>
                    <ul className={`text-[11px] space-y-0.5 ${subText}`}>
                      {p.outputs!.map((o, i) => (
                        <li key={i}>· {o}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          })()}

        <div className={`absolute bottom-3 left-3 text-[10px] ${dimText}`}>
          拖动平移 · ⌘+滚轮缩放
        </div>
      </div>
    </div>
  )
}
