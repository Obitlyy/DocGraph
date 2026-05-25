import { useState } from 'react'
import type { GraphSummary } from '../api'
import CategoryManager from './CategoryManager'
import SegmentedControl from './SegmentedControl'

interface Props {
  graphs: GraphSummary[]
  currentName: string
  onLoadGraph: (name: string) => void
  onDeleteGraph: (name: string) => void
  onRenameGraph: (oldName: string, newName: string) => void
  onRescanGraph: (name: string) => void
  onScan: (folder: string, name: string) => void
  onClassify: (mode: string) => void
  onRelations: (mode: string) => void
  onUpdate: () => void
  onProposePhases: () => void
  onCategoriesChanged: () => void
  classifyRunning: boolean
  relationsRunning: boolean
  updateRunning: boolean
  updateProgress: { phase: string; current: string; progress: number; total: number }
  phasesRunning: boolean
  classifyProgress: { done: number; total: number; current: string }
  taskMsg: string
  isDark: boolean
  onToggleTheme: () => void
}

export default function Sidebar({
  graphs, currentName, onLoadGraph, onDeleteGraph, onRenameGraph, onRescanGraph, onScan,
  onClassify, onRelations, onUpdate, onProposePhases, onCategoriesChanged,
  classifyRunning, relationsRunning, updateRunning, updateProgress,
  phasesRunning,
  classifyProgress, taskMsg,
  isDark, onToggleTheme,
}: Props) {
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [analysisMode, setAnalysisMode] = useState<'fast' | 'standard' | 'deep'>('standard')

  const glassPanel = `glass-panel ${isDark ? 'glass-panel-dark' : 'glass-panel-light'}`
  const glassInput = isDark ? 'glass-input-dark' : 'glass-input-light'
  const glassButton = `glass-button ${isDark ? 'glass-button-dark' : 'glass-button-light'}`

  return (
    <aside className={`w-64 flex flex-col overflow-y-auto ${glassPanel}`}>
      {/* Logo */}
      <div className="px-5 py-5">
        <h2 className={`text-sm font-bold tracking-tight ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
          DocGraph
        </h2>
        <p className={`text-[10px] mt-0.5 ${isDark ? 'text-white/30' : 'text-black/30'}`}>
          文档关系图谱
        </p>
      </div>

      {/* 图谱列表 */}
      <section className="px-3 pb-4">
        <p className={`px-2 mb-2 text-[10px] font-semibold uppercase tracking-widest ${
          isDark ? 'text-white/30' : 'text-black/30'
        }`}>图谱</p>
        <div className="space-y-1">
          {graphs.map(g => (
            <GraphCard
              key={g.name}
              graph={g}
              isCurrent={currentName === g.name}
              isDark={isDark}
              onLoad={() => onLoadGraph(g.name)}
              onDelete={() => onDeleteGraph(g.name)}
              onRename={(newName) => onRenameGraph(g.name, newName)}
              onRescan={() => onRescanGraph(g.name)}
            />
          ))}
          {graphs.length === 0 && (
            <p className={`text-[10px] text-center py-6 ${isDark ? 'text-white/20' : 'text-black/20'}`}>
              暂无图谱
            </p>
          )}
        </div>
      </section>

      {/* 分隔线 */}
      <div className={`mx-4 border-t ${isDark ? 'border-white/5' : 'border-black/5'}`} />

      {/* 扫描 */}
      <section className="px-3 py-4">
        <p className={`px-2 mb-2 text-[10px] font-semibold uppercase tracking-widest ${
          isDark ? 'text-white/30' : 'text-black/30'
        }`}>新建</p>
        <input
          className={`w-full px-3 py-2 text-xs rounded-lg mb-1.5 outline-none ${glassInput} ${
            isDark ? 'text-white placeholder-white/25' : 'text-[#1D1D1F] placeholder-black/25'
          }`}
          placeholder="文件夹路径"
          value={folder}
          onChange={e => setFolder(e.target.value)}
        />
        <input
          className={`w-full px-3 py-2 text-xs rounded-lg mb-2 outline-none ${glassInput} ${
            isDark ? 'text-white placeholder-white/25' : 'text-[#1D1D1F] placeholder-black/25'
          }`}
          placeholder="图谱名称"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <button
          className="w-full px-3 py-2 bg-[#007AFF] text-white text-xs font-medium rounded-lg hover:bg-[#0071E3] transition-all active:scale-[0.97] disabled:opacity-40 shadow-sm shadow-[#007AFF]/20"
          onClick={() => onScan(folder, name)}
          disabled={!folder || !name}
        >
          扫描并创建
        </button>
      </section>

      {/* 分隔线 */}
      <div className={`mx-4 border-t ${isDark ? 'border-white/5' : 'border-black/5'}`} />

      {/* AI 分析 */}
      {currentName && (
        <section className="px-3 py-4">
          <p className={`px-2 mb-2 text-[10px] font-semibold uppercase tracking-widest ${
            isDark ? 'text-white/30' : 'text-black/30'
          }`}>AI 分析</p>

          {/* 分析模式选择器（带滑动动画） */}
          <SegmentedControl
            items={[
              { key: 'fast', label: '☇ 快速' },
              { key: 'standard', label: '◆ 中度' },
              { key: 'deep', label: '◇ 深度' },
            ] as const}
            value={analysisMode}
            onChange={setAnalysisMode}
            isDark={isDark}
            size="sm"
            fill="equal"
            className="mb-3 w-full"
          />
          <p className={`text-[9px] px-2 mb-2 ${
            isDark ? 'text-white/20' : 'text-black/20'
          }`}>
            {analysisMode === 'fast' && '☇ flash模型·精简字段·最快最省'}
            {analysisMode === 'standard' && '◆ flash模型·完整字段·平衡质量与成本'}
            {analysisMode === 'deep' && '◇ reasoner模型·深度思考·最高质量'}
          </p>

          <div className="space-y-1.5">
            <button
              className={`w-full px-3 py-2.5 text-xs font-medium rounded-xl transition-all active:scale-[0.97] disabled:opacity-40 ${glassButton} ${
                isDark ? 'text-[#30D158]' : 'text-[#248A3D]'
              }`}
              onClick={() => onClassify(analysisMode)}
              disabled={classifyRunning}
            >
              {classifyRunning
                ? `分类中 ${classifyProgress.done}/${classifyProgress.total}`
                : '🏷️ 文档分类'
              }
            </button>
            <button
              className={`w-full px-3 py-2.5 text-xs font-medium rounded-xl transition-all active:scale-[0.97] disabled:opacity-40 ${glassButton} ${
                isDark ? 'text-[#FF9F0A]' : 'text-[#C93400]'
              }`}
              onClick={() => onRelations(analysisMode)}
              disabled={relationsRunning}
            >
              {relationsRunning ? '推断中...' : '🔗 推断关系'}
            </button>
            {/* 增量更新按钮 */}
            <button
              className={`w-full px-3 py-2.5 text-xs font-medium rounded-xl transition-all active:scale-[0.97] disabled:opacity-40 ${glassButton} ${
                isDark ? 'text-[#30D158]' : 'text-[#248A3D]'
              }`}
              onClick={onUpdate}
              disabled={updateRunning || classifyRunning || relationsRunning}
              title="检测文件夹变化并增量重跑分类/关系"
            >
              {updateRunning ? `更新中... ${updateProgress.phase}` : '🔄 增量更新'}
            </button>
            {/* 阶段划分按钮 */}
            <button
              className={`w-full px-3 py-2.5 text-xs font-medium rounded-xl transition-all active:scale-[0.97] disabled:opacity-40 ${glassButton} ${
                isDark ? 'text-[#5E5CE6]' : 'text-[#5856D6]'
              }`}
              onClick={onProposePhases}
              disabled={phasesRunning || classifyRunning || relationsRunning || updateRunning}
              title="根据文件夹结构识别项目阶段"
            >
              {phasesRunning ? '总结中...' : '🧭 阶段划分'}
            </button>
          </div>
          {classifyRunning && classifyProgress.current && (
            <p className={`text-[10px] mt-2 px-2 truncate ${isDark ? 'text-white/30' : 'text-black/30'}`}>
              {classifyProgress.current}
            </p>
          )}
        </section>
      )}

      {/* 分类管理 */}
      {currentName && (
        <>
          <div className={`mx-4 border-t ${isDark ? 'border-white/5' : 'border-black/5'}`} />
          <CategoryManager
            graphName={currentName}
            isDark={isDark}
            onCategoriesChanged={onCategoriesChanged}
          />
        </>
      )}

      {/* 底部状态 */}
      <div className="mt-auto px-3 py-3">
        {taskMsg && (
          <p className={`text-[10px] px-3 py-2 rounded-xl ${
            isDark ? 'glass-card-dark text-white/50' : 'glass-card-light text-black/40'
          }`}>
            {taskMsg}
          </p>
        )}
      </div>
    </aside>
  )
}

// ============ 图谱卡片组件（带悬浮操作按钮） ============

function GraphCard({ graph, isCurrent, isDark, onLoad, onDelete, onRename, onRescan }: {
  graph: GraphSummary
  isCurrent: boolean
  isDark: boolean
  onLoad: () => void
  onDelete: () => void
  onRename: (newName: string) => void
  onRescan: () => void
}) {
  const [hover, setHover] = useState(false)

  function handleRename() {
    const newName = prompt('重命名图谱', graph.name)?.trim()
    if (newName && newName !== graph.name) {
      onRename(newName)
    }
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="relative"
    >
      <button
        onClick={onLoad}
        className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition-all duration-200 ${
          isCurrent
            ? isDark
              ? 'glass-card-dark text-white'
              : 'glass-card-light text-[#1D1D1F]'
            : isDark
              ? 'text-white/60 hover:bg-white/5'
              : 'text-black/50 hover:bg-black/[0.03]'
        }`}
      >
        <div className="font-medium text-xs pr-16">{graph.name}</div>
        <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/30' : 'text-black/30'}`}>
          {graph.doc_count} 文档 · {graph.relation_count} 关系
        </div>
      </button>

      {/* 悬浮操作按钮 */}
      {hover && (
        <div
          onClick={e => e.stopPropagation()}
          className={`absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1 py-0.5 rounded-lg backdrop-blur-xl z-10 ${
            isDark ? 'bg-black/60' : 'bg-white/80'
          }`}
        >
          <CardIconBtn title="重命名" isDark={isDark} onClick={handleRename}>✎</CardIconBtn>
          <CardIconBtn title="重新扫描（增量更新）" isDark={isDark} onClick={onRescan}>↻</CardIconBtn>
          <CardIconBtn title="删除" isDark={isDark} onClick={onDelete} danger>🗑</CardIconBtn>
        </div>
      )}
    </div>
  )
}

function CardIconBtn({ children, onClick, title, isDark, danger }: {
  children: React.ReactNode; onClick: () => void; title: string; isDark: boolean; danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-5 h-5 text-[10px] rounded flex items-center justify-center transition-colors ${
        danger
          ? (isDark ? 'hover:bg-red-500/30 text-red-300' : 'hover:bg-red-500/20 text-red-600')
          : (isDark ? 'hover:bg-white/10 text-white/70' : 'hover:bg-black/5 text-black/60')
      }`}
    >{children}</button>
  )
}
