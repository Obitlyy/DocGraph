import { useEffect, useRef, useMemo, useState } from 'react'
import type { GraphData } from '../api'
import SegmentedControl from './SegmentedControl'

// @ts-ignore
import { Network, DataSet } from 'vis-network/standalone'

// 低饱和莫兰迪色板 - 柔和舒适
const CATEGORY_COLORS_LIGHT = [
  '#7BA7CC', '#7DBF96', '#C9A065', '#9B7DB8', '#CC7B7B',
  '#C47B93', '#6BAFC4', '#B8A84D', '#C48A7B', '#8B87BF',
  '#6BC4D4', '#7BBF8A',
]

const CATEGORY_COLORS_DARK = [
  '#5B8FAF', '#5BA87A', '#AF8A4D', '#8567A0', '#AF6565',
  '#A86578', '#5597AB', '#9E9240', '#AB7565', '#7570A8',
  '#55ABBA', '#65A874',
]

const RELATION_COLORS: Record<string, string> = {
  '提供数据': '#7BA7CC',
  '浓缩版本': '#7DBF96',
  '旧版本': '#8E8E93',
  '衍生文档': '#C9A065',
  '引用参考': '#9B7DB8',
  '同一项目': '#CC7B7B',
  '同一批次': '#C47B93',
}

type SizeMode = 'fixed' | 'scaled'

interface Props {
  graph: GraphData
  onNodeClick: (docId: string) => void
  isDark: boolean
}

export default function GraphView({ graph, onNodeClick, isDark }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const networkRef = useRef<Network | null>(null)
  const nodesRef = useRef<any>(null)
  const edgesRef = useRef<any>(null)
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set())
  const initializedTypesRef = useRef(false)
  const [minConf, setMinConf] = useState(0.5)
  const [sizeMode, setSizeMode] = useState<SizeMode>('scaled')
  const [showExternal, setShowExternal] = useState(true)

  // 稳定的回调引用，避免重建 Network
  const onNodeClickRef = useRef(onNodeClick)
  onNodeClickRef.current = onNodeClick

  const palette = isDark ? CATEGORY_COLORS_DARK : CATEGORY_COLORS_LIGHT

  // 分类 → 颜色映射
  const catColorMap = useMemo(() => {
    const cats = [...new Set(graph.docs.map(d => d.category || '未分类'))].sort()
    const map: Record<string, string> = {}
    cats.forEach((c, i) => { map[c] = palette[i % palette.length] })
    return map
  }, [graph.docs, palette])

  // 关系类型
  const usedTypes = useMemo(() => {
    return [...new Set(graph.relations.map(r => r.type))]
  }, [graph.relations])

  // 切换图谱时，默认全选当前图谱实际存在的关系类型
  useEffect(() => {
    setActiveTypes(new Set(usedTypes))
    initializedTypesRef.current = true
  }, [graph.name, usedTypes.join('|')])

  // 文档分组（同一批次等元数据级归属）
  const groups = graph.groups || []
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null)

  // doc_id → group 索引集合
  const docToGroups = useMemo(() => {
    const map: Record<string, number[]> = {}
    groups.forEach((g, idx) => {
      g.doc_ids.forEach(id => {
        if (!map[id]) map[id] = []
        map[id].push(idx)
      })
    })
    return map
  }, [groups])

  // group 颜色序列（与分类错开）
  const GROUP_PALETTE = isDark
    ? ['#FF9F0A', '#5E5CE6', '#FF375F', '#30D158', '#64D2FF', '#FFD60A', '#BF5AF2']
    : ['#FF9500', '#5856D6', '#FF2D55', '#34C759', '#5AC8FA', '#FFCC00', '#AF52DE']

  // 过滤后的关系
  const filteredRels = useMemo(() => {
    return graph.relations.filter(
      r => activeTypes.has(r.type) && r.confidence >= minConf
    )
  }, [graph.relations, activeTypes, minConf])

  // 计算节点大小
  const calcSize = (charCount: number): number => {
    if (sizeMode === 'fixed') return 22
    // 信息量缩放: log 映射到 [12, 60]，差异扩大 30%
    const cc = Math.max(charCount || 100, 10)
    return Math.max(12, Math.min(60, 8 + 8 * Math.log10(cc)))
  }

  // 生成节点数据
  const buildNodes = () => {
    const textColor = isDark ? '#E8E8ED' : '#3A3A3C'
    return graph.docs.map(d => {
      const groupIdxs = docToGroups[d.id] || []
      const primaryGroup = groupIdxs[0]
      const groupColor = primaryGroup !== undefined ? GROUP_PALETTE[primaryGroup % GROUP_PALETTE.length] : null
      const inSelectedGroup = selectedGroup !== null && groupIdxs.includes(selectedGroup)
      const dimmed = selectedGroup !== null && !inSelectedGroup
      const baseBg = catColorMap[d.category || '未分类']

      return {
        id: d.id,
        label: d.keywords?.length ? d.keywords.slice(0, 2).join('\n') : d.name.replace(/\.[^.]+$/, '').slice(0, 12),
        color: {
          background: dimmed ? (isDark ? '#2c2c2e' : '#E5E5EA') : baseBg,
          border: (d as any).external ? (isDark ? '#FFB038' : '#DC8C14') : (inSelectedGroup ? (groupColor || 'transparent') : (groupColor ? `${groupColor}55` : 'transparent')),
          highlight: {
            background: baseBg,
            border: (d as any).external ? (isDark ? '#FFB038' : '#DC8C14') : (groupColor || (isDark ? '#E8E8ED' : '#3A3A3C')),
          },
          hover: {
            background: baseBg,
            border: (d as any).external ? (isDark ? '#FFB038' : '#DC8C14') : (groupColor || (isDark ? '#E8E8ED' : '#3A3A3C')),
          },
        },
        borderWidth: (d as any).external ? 3 : (groupColor ? (inSelectedGroup ? 4 : 2) : 0),
        borderWidthSelected: (d as any).external ? 4 : 4,
        shapeProperties: { borderDashes: (d as any).external ? [3, 2] : false },
        size: calcSize(d.char_count || 0),
        opacity: dimmed ? 0.35 : ((d as any).external && !showExternal ? 0.12 : 1),
        title: [
          d.name,
          d.category ? `分类: ${d.category}` : '',
          d.summary || '',
          d.char_count ? `${(d.char_count / 1000).toFixed(1)}k 字` : '',
          groupIdxs.length ? `所属批次: ${groupIdxs.map(i => groups[i].topic).join(', ')}` : '',
        ].filter(Boolean).join('\n'),
        font: {
          size: 10,
          color: textColor,
          face: '-apple-system, BlinkMacSystemFont, SF Pro Text, sans-serif',
        },
        shadow: {
          enabled: true,
          color: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.06)',
          size: 10,
          x: 0,
          y: 3,
        },
      }
    })
  }

  // 生成边数据
  const buildEdges = () => {
    return [
      // 真实逻辑关系边
      ...filteredRels.map((r, i) => ({
        id: `e${i}`,
        from: r.from,
        to: r.to,
        color: {
          color: RELATION_COLORS[r.type] || ((r as any).external ? (isDark ? '#FFB038' : '#DC8C14') : '#8E8E93'),
          opacity: (r as any).external
            ? (showExternal ? (isDark ? 0.5 : 0.4) : 0.08)
            : (isDark ? 0.4 : 0.3),
          highlight: RELATION_COLORS[r.type] || '#8E8E93',
          hover: RELATION_COLORS[r.type] || '#8E8E93',
        },
        dashes: (r as any).external ? [4, 3] : false,
        arrows: r.directional ? { to: { enabled: true, scaleFactor: 0.5, type: 'arrow' } } : '',
        width: 1,
        hoverWidth: 0.5,
        smooth: false,
        title: `${r.type} (${(r.confidence * 100).toFixed(0)}%)${(r as any).external ? ' · 外部关联' : ''}`,
      })),
      // 幽灵边：同一批次成员互联，仅参与物理使其聚集，不渲染
      ...groups.flatMap((g, gi) =>
        g.doc_ids.flatMap((a, i) =>
          g.doc_ids.slice(i + 1).map((b, j) => ({
            id: `gh-${gi}-${i}-${j}`,
            from: a,
            to: b,
            color: { color: 'rgba(0,0,0,0)', opacity: 0, highlight: 'rgba(0,0,0,0)', hover: 'rgba(0,0,0,0)' },
            width: 0.001,
            physics: true,
            smooth: false,
            chosen: false,
            selectionWidth: 0,
            hoverWidth: 0,
          }))
        )
      ),
    ]
  }

  // 初始化 Network — 仅在 graph 实例变化时重建
  useEffect(() => {
    if (!containerRef.current) return

    const nodes = new DataSet(buildNodes())
    const edges = new DataSet(buildEdges()) as any
    nodesRef.current = nodes
    edgesRef.current = edges

    const options = {
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -80,
          centralGravity: 0.008,
          springLength: 180,
          springConstant: 0.015,
          damping: 0.5,
          avoidOverlap: 0.3,
        },
        stabilization: {
          enabled: true,
          iterations: 300,
          updateInterval: 25,
          fit: true,
        },
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        zoomView: true,
        dragView: true,
        dragNodes: true,
      },
      nodes: {
        shape: 'dot',
        chosen: {
          node: (values: any) => {
            values.borderWidth = 2
            values.size = values.size * 1.12
          },
        },
      },
      edges: {
        font: { size: 0 },
        selectionWidth: 1,
        chosen: {
          edge: (values: any) => {
            values.width = 2.5
            values.opacity = 1
          },
        },
      },
      layout: {
        improvedLayout: true,
        randomSeed: 42,
      },
    }

    const network = new Network(containerRef.current, { nodes, edges }, options as any)
    networkRef.current = network

    // 稳定后关闭物理 → 点击不会重排
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } })
    })

    network.on('click', (params: any) => {
      if (params.nodes.length > 0) {
        onNodeClickRef.current(params.nodes[0])
      }
    })

    // 双击临时开启物理（拖拽调整后归位）
    network.on('doubleClick', () => {
      network.setOptions({ physics: { enabled: true } })
      setTimeout(() => {
        network.setOptions({ physics: { enabled: false } })
      }, 2000)
    })

    return () => {
      network.destroy()
      networkRef.current = null
      nodesRef.current = null
      edgesRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, isDark])

  // 筛选条件变化时增量更新边（不动节点位置，只改可见性）
  useEffect(() => {
    if (!edgesRef.current || !networkRef.current) return

    const newEdges = buildEdges()
    const currentIds = new Set(edgesRef.current.getIds() as string[])
    const newIds = new Set(newEdges.map((e: any) => e.id))

    // 只增删差异的边，不全量替换
    const toRemove = [...currentIds].filter(id => !newIds.has(id) && !id.startsWith('gh-'))
    const toAdd = newEdges.filter((e: any) => !currentIds.has(e.id))

    if (toRemove.length > 0) edgesRef.current.remove(toRemove)
    if (toAdd.length > 0) edgesRef.current.add(toAdd)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRels])

  // 节点样式变化（选中批次、大小模式、外部关联显隐）→ 只更新样式不动位置
  useEffect(() => {
    if (!nodesRef.current || !networkRef.current) return

    const updates = graph.docs.map(d => {
      const groupIdxs = docToGroups[d.id] || []
      const inSelectedGroup = selectedGroup !== null && groupIdxs.includes(selectedGroup)
      const dimmed = selectedGroup !== null && !inSelectedGroup
      return {
        id: d.id,
        size: calcSize(d.char_count || 0),
        opacity: dimmed ? 0.35 : ((d as any).external && !showExternal ? 0.12 : 1),
      }
    })
    nodesRef.current.update(updates)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeMode, selectedGroup, showExternal])

  const toggleType = (type: string) => {
    setActiveTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏 */}
      <div className={`px-5 py-3 flex items-center gap-5 flex-wrap glass-panel ${
        isDark ? 'glass-panel-dark' : 'glass-panel-light'
      }`}>
        {/* 关系筛选 */}
        <span className={`text-[10px] font-semibold tracking-widest uppercase ${
          isDark ? 'text-white/40' : 'text-black/30'
        }`}>关系</span>
        {usedTypes.map(type => (
          <label key={type} className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={activeTypes.has(type)}
              onChange={() => toggleType(type)}
              className="rounded-sm w-3 h-3"
            />
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: RELATION_COLORS[type] }}
            />
            <span className={isDark ? 'text-white/60' : 'text-black/50'}>{type}</span>
          </label>
        ))}

        {/* 分隔 */}
        <div className={`w-px h-4 ${isDark ? 'bg-white/10' : 'bg-black/10'}`} />

        {/* 批次选择器 */}
        {groups.length > 0 && (
          <>
            <span className={`text-[10px] font-semibold tracking-widest uppercase ${
              isDark ? 'text-white/40' : 'text-black/30'
            }`}>批次</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setSelectedGroup(null)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                  selectedGroup === null
                    ? (isDark ? 'bg-white/15 text-white' : 'bg-black/10 text-black')
                    : (isDark ? 'text-white/40 hover:text-white/60' : 'text-black/40 hover:text-black/60')
                }`}
              >全部</button>
              {groups.map((g, idx) => {
                const color = GROUP_PALETTE[idx % GROUP_PALETTE.length]
                const active = selectedGroup === idx
                return (
                  <button
                    key={idx}
                    onClick={() => setSelectedGroup(active ? null : idx)}
                    title={`${g.topic} (${g.doc_ids.length} 个文档)`}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                      active ? '' : 'opacity-60 hover:opacity-100'
                    }`}
                    style={{
                      background: active ? `${color}25` : 'transparent',
                      color,
                      border: `1px solid ${active ? color : `${color}55`}`,
                    }}
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                    <span className="max-w-[120px] truncate">{g.topic.slice(0, 10) || `批次${idx + 1}`}</span>
                    <span className="opacity-60">{g.doc_ids.length}</span>
                  </button>
                )
              })}
            </div>
            <div className={`w-px h-4 ${isDark ? 'bg-white/10' : 'bg-black/10'}`} />
          </>
        )}

        {/* 节点大小（带滑动动画） */}
        <span className={`text-[10px] font-semibold tracking-widest uppercase ${
          isDark ? 'text-white/40' : 'text-black/30'
        }`}>大小</span>
        <SegmentedControl
          items={[
            { key: 'fixed', label: '固定' },
            { key: 'scaled', label: '信息量' },
          ] as const}
          value={sizeMode}
          onChange={setSizeMode}
          isDark={isDark}
          size="sm"
        />

        {/* 置信度 */}
        <div className="ml-auto flex items-center gap-2">
          <span className={`text-[10px] ${isDark ? 'text-white/30' : 'text-black/30'}`}>
            ≥ {(minConf * 100).toFixed(0)}%
          </span>
          <input
            type="range"
            min={0} max={100} value={minConf * 100}
            onChange={e => setMinConf(Number(e.target.value) / 100)}
            className="w-20"
          />
        </div>

        {/* 外部关联 toggle（仅在有外部节点/关系时显示） */}
        {(graph.docs.some(d => (d as any).external) || graph.relations.some(r => (r as any).external)) && (
          <button
            onClick={() => setShowExternal(v => !v)}
            className={`text-[11px] px-2 py-1 rounded-md transition-colors flex items-center gap-1 ${
              showExternal
                ? (isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-500/15 text-amber-700')
                : (isDark ? 'bg-white/5 text-white/50' : 'bg-black/5 text-black/50')
            }`}
            title="切换外部关联节点/边的可见性"
          >
            🔭 外部关联 {showExternal ? '显示' : '隐藏'}
          </button>
        )}
      </div>

      {/* 图谱容器 */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{ background: isDark ? '#000000' : '#FAFAFA' }}
      />

      {/* 底部图例 */}
      <div className={`px-5 py-2.5 flex items-center gap-4 flex-wrap glass-panel ${
        isDark ? 'glass-panel-dark' : 'glass-panel-light'
      }`}>
        <span className={`text-[10px] font-semibold tracking-widest uppercase ${
          isDark ? 'text-white/40' : 'text-black/30'
        }`}>分类</span>
        {Object.entries(catColorMap).map(([cat, color]) => (
          <span key={cat} className={`flex items-center gap-1.5 text-xs ${
            isDark ? 'text-white/50' : 'text-black/40'
          }`}>
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
            {cat}
          </span>
        ))}
        {sizeMode === 'scaled' && (
          <>
            <div className={`w-px h-3 ml-2 ${isDark ? 'bg-white/10' : 'bg-black/10'}`} />
            <span className={`flex items-center gap-2 text-[10px] ${isDark ? 'text-white/30' : 'text-black/25'}`}>
              <span className="inline-block w-2 h-2 rounded-full bg-current" /> 小 = 少内容
              <span className="inline-block w-4 h-4 rounded-full bg-current" /> 大 = 多内容
            </span>
          </>
        )}
      </div>
    </div>
  )
}
