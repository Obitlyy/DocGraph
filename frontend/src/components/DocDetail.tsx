import { useEffect, useState, useCallback, useRef } from 'react'
import type { Doc, RelatedDoc } from '../api'
import { fetchRelated, updateDocMeta, revealInFinder } from '../api'

interface MetricItem {
  name: string
  value: string
  unit?: string
  context?: string
}

function MetricsEditor({ metrics, isDark, onSave, onCancel }: {
  metrics: MetricItem[]
  isDark: boolean
  onSave: (metrics: MetricItem[]) => void
  onCancel: () => void
}) {
  const [items, setItems] = useState<MetricItem[]>(() => metrics.length ? [...metrics] : [{ name: '', value: '', unit: '', context: '' }])

  const updateItem = (idx: number, field: keyof MetricItem, val: string) => {
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, [field]: val } : item))
  }

  const removeItem = (idx: number) => {
    setItems(prev => prev.filter((_, i) => i !== idx))
  }

  const addItem = () => {
    setItems(prev => [...prev, { name: '', value: '', unit: '', context: '' }])
  }

  const handleSave = () => {
    const cleaned = items.filter(m => m.name.trim() && m.value.trim())
    onSave(cleaned)
  }

  return (
    <div className={`rounded-xl p-3 space-y-2 ${isDark ? 'bg-white/5' : 'bg-black/3'}`}>
      {items.map((item, i) => (
        <div key={i} className={`rounded-lg p-2 space-y-1 ${isDark ? 'bg-white/5' : 'bg-black/3'}`}>
          <div className="flex gap-1.5">
            <input
              className={`flex-1 text-[11px] rounded px-2 py-1 outline-none ${isDark ? 'bg-white/10 text-white placeholder-white/25' : 'bg-white text-[#1D1D1F] placeholder-black/25'}`}
              placeholder="指标名"
              value={item.name}
              onChange={e => updateItem(i, 'name', e.target.value)}
            />
            <input
              className={`w-20 text-[11px] rounded px-2 py-1 outline-none font-semibold ${isDark ? 'bg-white/10 text-[#FFD60A] placeholder-white/25' : 'bg-white text-[#FF9500] placeholder-black/25'}`}
              placeholder="数值"
              value={item.value}
              onChange={e => updateItem(i, 'value', e.target.value)}
            />
            <input
              className={`w-12 text-[11px] rounded px-2 py-1 outline-none ${isDark ? 'bg-white/10 text-white/60 placeholder-white/20' : 'bg-white text-black/50 placeholder-black/20'}`}
              placeholder="单位"
              value={item.unit || ''}
              onChange={e => updateItem(i, 'unit', e.target.value)}
            />
            <button
              onClick={() => removeItem(i)}
              className={`w-5 h-5 rounded flex items-center justify-center text-[10px] ${isDark ? 'text-red-400 hover:bg-red-500/20' : 'text-red-500 hover:bg-red-50'}`}
            >✕</button>
          </div>
          <input
            className={`w-full text-[10px] rounded px-2 py-1 outline-none ${isDark ? 'bg-white/5 text-white/40 placeholder-white/15' : 'bg-black/3 text-black/40 placeholder-black/15'}`}
            placeholder="上下文（可选）"
            value={item.context || ''}
            onChange={e => updateItem(i, 'context', e.target.value)}
          />
        </div>
      ))}
      <div className="flex justify-between pt-1">
        <button
          onClick={addItem}
          className={`text-[10px] px-2 py-1 rounded ${isDark ? 'text-[#64D2FF] hover:bg-white/10' : 'text-[#007AFF] hover:bg-black/5'}`}
        >+ 添加指标</button>
        <div className="flex gap-1.5">
          <button onClick={handleSave} className="text-[10px] px-3 py-1 rounded bg-[#007AFF] text-white hover:bg-[#0071E3]">保存</button>
          <button onClick={onCancel} className={`text-[10px] px-3 py-1 rounded ${isDark ? 'bg-white/10 text-white/50' : 'bg-black/5 text-black/40'}`}>取消</button>
        </div>
      </div>
    </div>
  )
}

interface Props {
  doc: Doc
  graphName: string
  folder?: string
  onClose: () => void
  onSelectRelated: (docId: string) => void
  onDocUpdated: () => void
  isDark: boolean
}

const REASON_LABELS: Record<string, string> = {
  direct_relation: '直接关系',
  same_category: '同分类',
  shared_keywords: '共享关键词',
  shared_people: '共同人物',
  shared_entities: '共享实体',
  shared_metrics: '共享指标',
}

export default function DocDetail({ doc, graphName, folder, onClose, onSelectRelated, onDocUpdated, isDark }: Props) {
  const [related, setRelated] = useState<RelatedDoc[]>([])
  const [loadingRelated, setLoadingRelated] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  // 可编辑字段状态
  const [editCategory, setEditCategory] = useState(doc.category || '')
  const [editPhase, setEditPhase] = useState(doc.phase || '')
  const [editSummary, setEditSummary] = useState(doc.summary || '')
  const [editKeywords, setEditKeywords] = useState((doc.keywords || []).join(', '))
  const [editPeople, setEditPeople] = useState((doc.people || []).join(', '))

  // doc 变化时重置编辑状态
  useEffect(() => {
    setEditing(null)
    setEditCategory(doc.category || '')
    setEditPhase(doc.phase || '')
    setEditSummary(doc.summary || '')
    setEditKeywords((doc.keywords || []).join(', '))
    setEditPeople((doc.people || []).join(', '))
  }, [doc.id])

  useEffect(() => {
    const controller = new AbortController()
    setLoadingRelated(true)
    fetchRelated(graphName, doc.id, 6, controller.signal)
      .then(setRelated)
      .catch(() => {
        // 忽略因切换文档导致的 abort 或网络错误
      })
      .finally(() => setLoadingRelated(false))
    return () => controller.abort()
  }, [doc.id, graphName])

  const saveField = useCallback(async (field: string) => {
    const update: any = {}
    switch (field) {
      case 'category': update.category = editCategory.trim() || undefined; break
      case 'phase': update.phase = editPhase.trim() || undefined; break
      case 'summary': update.summary = editSummary.trim() || undefined; break
      case 'keywords': update.keywords = editKeywords.split(/[,，]/).map(s => s.trim()).filter(Boolean); break
      case 'people': update.people = editPeople.split(/[,，]/).map(s => s.trim()).filter(Boolean); break
    }
    try {
      await updateDocMeta(graphName, doc.id, update)
      setEditing(null)
      onDocUpdated()
    } catch (e: any) {
      alert('保存失败: ' + e.message)
    }
  }, [graphName, doc.id, editCategory, editPhase, editSummary, editKeywords, editPeople, onDocUpdated])

  const handleKeyDown = (e: React.KeyboardEvent, field: string) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      saveField(field)
    } else if (e.key === 'Escape') {
      setEditing(null)
    }
  }

  const sectionTitle = (label: string) => (
    <p className={`text-[10px] font-semibold uppercase tracking-wider mb-1.5 ${
      isDark ? 'text-white/30' : 'text-black/30'
    }`}>{label}</p>
  )

  const editableField = (field: string, label: string, value: string, setter: (v: string) => void, multiline = false) => (
    <div className={`rounded-xl px-3 py-2.5 cursor-pointer transition-all ${
      isDark ? 'glass-card-dark' : 'glass-card-light'
    } ${editing === field ? 'ring-1 ring-[#007AFF]/50' : 'hover:ring-1 hover:ring-white/10'}`}
      onClick={() => { if (editing !== field) setEditing(field) }}
    >
      <p className={`text-[10px] font-medium ${isDark ? 'text-white/30' : 'text-black/30'}`}>
        {label} {editing !== field && <span className="opacity-0 group-hover:opacity-100">✏️</span>}
      </p>
      {editing === field ? (
        <div className="mt-1 flex gap-1.5 items-start">
          {multiline ? (
            <textarea
              className={`flex-1 text-xs rounded-md px-2 py-1.5 outline-none resize-none min-h-[60px] ${
                isDark ? 'bg-white/10 text-white' : 'bg-black/5 text-[#1D1D1F]'
              }`}
              value={value}
              onChange={e => setter(e.target.value)}
              onKeyDown={e => handleKeyDown(e, field)}
              autoFocus
            />
          ) : (
            <input
              className={`flex-1 text-xs rounded-md px-2 py-1.5 outline-none ${
                isDark ? 'bg-white/10 text-white' : 'bg-black/5 text-[#1D1D1F]'
              }`}
              value={value}
              onChange={e => setter(e.target.value)}
              onKeyDown={e => handleKeyDown(e, field)}
              autoFocus
            />
          )}
          <button
            onClick={(e) => { e.stopPropagation(); saveField(field) }}
            className="text-[10px] px-2 py-1 rounded bg-[#007AFF] text-white hover:bg-[#0071E3]"
          >✓</button>
          <button
            onClick={(e) => { e.stopPropagation(); setEditing(null) }}
            className={`text-[10px] px-2 py-1 rounded ${isDark ? 'bg-white/10 text-white/50' : 'bg-black/5 text-black/40'}`}
          >✕</button>
        </div>
      ) : (
        <p className={`text-sm font-semibold mt-0.5 ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
          {value || '—'}
        </p>
      )}
    </div>
  )

  return (
    <aside className={`w-96 overflow-y-auto glass-panel transition-colors duration-300 ${
      isDark ? 'glass-panel-dark' : 'glass-panel-light'
    }`}>
      {/* 头部 */}
      <div className={`px-5 py-4 flex items-center justify-between sticky top-0 backdrop-blur-xl z-10 ${
        isDark ? 'bg-black/40' : 'bg-white/60'
      }`}>
        <h3 className={`text-xs font-semibold truncate pr-2 ${
          isDark ? 'text-white' : 'text-[#1D1D1F]'
        }`}>{doc.name}</h3>
        <button
          onClick={onClose}
          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs transition-colors ${
            isDark ? 'text-white/40 hover:bg-white/10' : 'text-black/30 hover:bg-black/5'
          }`}
        >✕</button>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* 基础指标（不可编辑） */}
        <div className="grid grid-cols-2 gap-2">
          <div className={`rounded-xl px-3 py-2.5 ${isDark ? 'glass-card-dark' : 'glass-card-light'}`}>
            <p className={`text-[10px] font-medium ${isDark ? 'text-white/30' : 'text-black/30'}`}>字数</p>
            <p className={`text-sm font-semibold mt-0.5 ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
              {(doc.char_count || 0).toLocaleString()}
            </p>
          </div>
          <div className={`rounded-xl px-3 py-2.5 ${isDark ? 'glass-card-dark' : 'glass-card-light'}`}>
            <p className={`text-[10px] font-medium ${isDark ? 'text-white/30' : 'text-black/30'}`}>大小</p>
            <p className={`text-sm font-semibold mt-0.5 ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
              {(doc.size / 1024).toFixed(1)} KB
            </p>
          </div>
        </div>

        {/* 文件操作 */}
        {folder && (
          <button
            onClick={() => revealInFinder(`${folder}/${doc.rel_path}`)}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
              isDark
                ? 'bg-white/5 hover:bg-white/10 text-white/70 hover:text-white'
                : 'bg-black/[0.03] hover:bg-black/[0.06] text-black/60 hover:text-black'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            在 Finder 中显示
          </button>
        )}

        {/* 可编辑字段 */}
        <div className="grid grid-cols-2 gap-2">
          {editableField('category', '分类', editCategory, setEditCategory)}
          {editableField('phase', '阶段', editPhase, setEditPhase)}
        </div>

        {/* 摘要（可编辑） */}
        <div>
          {sectionTitle('摘要')}
          {editing === 'summary' ? (
            <div className={`rounded-xl px-3.5 py-2.5 ${isDark ? 'bg-[#0A84FF]/15' : 'bg-[#007AFF]/8'}`}>
              <textarea
                className={`w-full text-xs leading-relaxed bg-transparent outline-none resize-none min-h-[80px] ${
                  isDark ? 'text-[#64D2FF]' : 'text-[#0066CC]'
                }`}
                value={editSummary}
                onChange={e => setEditSummary(e.target.value)}
                onKeyDown={e => handleKeyDown(e, 'summary')}
                autoFocus
              />
              <div className="flex gap-1.5 mt-2 justify-end">
                <button
                  onClick={() => saveField('summary')}
                  className="text-[10px] px-2 py-1 rounded bg-[#007AFF] text-white hover:bg-[#0071E3]"
                >保存</button>
                <button
                  onClick={() => setEditing(null)}
                  className={`text-[10px] px-2 py-1 rounded ${isDark ? 'bg-white/10 text-white/50' : 'bg-black/5 text-black/40'}`}
                >取消</button>
              </div>
            </div>
          ) : (
            <p
              className={`text-xs leading-relaxed rounded-xl px-3.5 py-2.5 cursor-pointer hover:ring-1 hover:ring-[#007AFF]/30 transition-all ${
                isDark ? 'bg-[#0A84FF]/15 text-[#64D2FF]' : 'bg-[#007AFF]/8 text-[#0066CC]'
              }`}
              onClick={() => setEditing('summary')}
            >{doc.summary || '点击添加摘要...'}</p>
          )}
        </div>

        {/* 关键词（可编辑） */}
        <div>
          {sectionTitle('关键词')}
          {editing === 'keywords' ? (
            <div className="flex gap-1.5 items-center">
              <input
                className={`flex-1 text-xs rounded-lg px-3 py-2 outline-none ${
                  isDark ? 'bg-white/10 text-white placeholder-white/30' : 'bg-black/5 text-[#1D1D1F] placeholder-black/30'
                }`}
                value={editKeywords}
                onChange={e => setEditKeywords(e.target.value)}
                onKeyDown={e => handleKeyDown(e, 'keywords')}
                placeholder="逗号分隔关键词"
                autoFocus
              />
              <button onClick={() => saveField('keywords')} className="text-[10px] px-2 py-1 rounded bg-[#007AFF] text-white">✓</button>
              <button onClick={() => setEditing(null)} className={`text-[10px] px-2 py-1 rounded ${isDark ? 'bg-white/10 text-white/50' : 'bg-black/5 text-black/40'}`}>✕</button>
            </div>
          ) : (
            <div
              className="flex gap-1.5 flex-wrap cursor-pointer hover:ring-1 hover:ring-[#007AFF]/30 rounded-lg p-1.5 transition-all min-h-[28px]"
              onClick={() => setEditing('keywords')}
            >
              {doc.keywords && doc.keywords.length > 0 ? doc.keywords.map(k => (
                <span key={k} className={`text-[11px] font-medium px-2.5 py-1 rounded-full ${
                  isDark ? 'glass-pill-dark text-white/70' : 'glass-pill-light text-black/60'
                }`}>{k}</span>
              )) : (
                <span className={`text-[11px] ${isDark ? 'text-white/20' : 'text-black/20'}`}>点击添加关键词...</span>
              )}
            </div>
          )}
        </div>

        {/* 指标（可编辑） */}
        <div>
          {sectionTitle(`📊 关键指标 (${(doc.metrics || []).length})`)}
          {editing === 'metrics' ? (
            <MetricsEditor
              metrics={doc.metrics || []}
              isDark={isDark}
              onSave={async (newMetrics) => {
                try {
                  await updateDocMeta(graphName, doc.id, { metrics: newMetrics })
                  setEditing(null)
                  onDocUpdated()
                } catch (e: any) {
                  alert('保存失败: ' + e.message)
                }
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div
              className="space-y-1.5 cursor-pointer hover:ring-1 hover:ring-[#FFD60A]/30 rounded-xl p-1.5 transition-all min-h-[28px]"
              onClick={() => setEditing('metrics')}
            >
              {doc.metrics && doc.metrics.length > 0 ? doc.metrics.map((m, i) => (
                <div key={i} className={`rounded-lg px-3 py-2 ${
                  isDark ? 'glass-card-dark' : 'glass-card-light'
                }`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`text-[11px] ${isDark ? 'text-white/60' : 'text-black/50'}`}>
                      {m.name}
                    </span>
                    <span className={`text-sm font-semibold ${
                      isDark ? 'text-[#FFD60A]' : 'text-[#FF9500]'
                    }`}>
                      {m.value}{m.unit && m.unit !== m.value ? '' : ''}
                    </span>
                  </div>
                  {m.context && (
                    <p className={`text-[10px] mt-1 line-clamp-1 ${isDark ? 'text-white/30' : 'text-black/30'}`}>
                      {m.context}
                    </p>
                  )}
                </div>
              )) : (
                <span className={`text-[11px] ${isDark ? 'text-white/20' : 'text-black/20'}`}>点击添加指标...</span>
              )}
            </div>
          )}
        </div>

        {/* 时间线 */}
        {doc.timeline && doc.timeline.length > 0 && (
          <div>
            {sectionTitle(`📅 时间线 (${doc.timeline.length})`)}
            <div className="space-y-1">
              {doc.timeline.map((t, i) => (
                <div key={i} className="flex gap-2 text-[11px]">
                  <span className={`font-mono whitespace-nowrap ${
                    isDark ? 'text-[#64D2FF]' : 'text-[#007AFF]'
                  }`}>{t.date}</span>
                  <span className={isDark ? 'text-white/50' : 'text-black/50'}>{t.event}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 实体 */}
        {doc.entities && doc.entities.length > 0 && (
          <div>
            {sectionTitle(`🏢 实体 (${doc.entities.length})`)}
            <div className="flex gap-1.5 flex-wrap">
              {doc.entities.map((e, i) => (
                <span
                  key={i}
                  className={`text-[10px] font-medium px-2 py-1 rounded-full ${
                    isDark ? 'bg-[#BF5AF2]/15 text-[#DA8EFF]' : 'bg-[#AF52DE]/10 text-[#8E3FAA]'
                  }`}
                  title={e.type}
                >
                  {e.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 人物（可编辑） */}
        <div>
          {sectionTitle('相关人物')}
          {editing === 'people' ? (
            <div className="flex gap-1.5 items-center">
              <input
                className={`flex-1 text-xs rounded-lg px-3 py-2 outline-none ${
                  isDark ? 'bg-white/10 text-white placeholder-white/30' : 'bg-black/5 text-[#1D1D1F] placeholder-black/30'
                }`}
                value={editPeople}
                onChange={e => setEditPeople(e.target.value)}
                onKeyDown={e => handleKeyDown(e, 'people')}
                placeholder="逗号分隔人物名"
                autoFocus
              />
              <button onClick={() => saveField('people')} className="text-[10px] px-2 py-1 rounded bg-[#007AFF] text-white">✓</button>
              <button onClick={() => setEditing(null)} className={`text-[10px] px-2 py-1 rounded ${isDark ? 'bg-white/10 text-white/50' : 'bg-black/5 text-black/40'}`}>✕</button>
            </div>
          ) : (
            <div
              className="flex gap-1.5 flex-wrap cursor-pointer hover:ring-1 hover:ring-[#30D158]/30 rounded-lg p-1.5 transition-all min-h-[28px]"
              onClick={() => setEditing('people')}
            >
              {doc.people && doc.people.length > 0 ? doc.people.map(p => (
                <span key={p} className={`text-[11px] font-medium px-2.5 py-1 rounded-full ${
                  isDark ? 'bg-[#30D158]/15 text-[#30D158]' : 'bg-[#34C759]/10 text-[#1F8B3F]'
                }`}>{p}</span>
              )) : (
                <span className={`text-[11px] ${isDark ? 'text-white/20' : 'text-black/20'}`}>点击添加人物...</span>
              )}
            </div>
          )}
        </div>

        {/* 引用 */}
        {doc.citations && doc.citations.length > 0 && (
          <div>
            {sectionTitle(`📚 引用 (${doc.citations.length})`)}
            <div className="space-y-1">
              {doc.citations.map((c, i) => (
                <div key={i} className={`text-[10px] rounded-lg px-2.5 py-1.5 ${
                  isDark ? 'bg-white/5 text-white/50' : 'bg-black/3 text-black/50'
                }`}>
                  <p className="font-medium">{c.source}</p>
                  {c.context && <p className={`mt-0.5 ${isDark ? 'text-white/30' : 'text-black/30'}`}>{c.context}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 相关文档 */}
        <div>
          {sectionTitle(`🔗 相关文档${related.length ? ` (${related.length})` : ''}`)}
          {loadingRelated ? (
            <p className={`text-[11px] ${isDark ? 'text-white/30' : 'text-black/30'}`}>加载中...</p>
          ) : related.length === 0 ? (
            <p className={`text-[11px] ${isDark ? 'text-white/30' : 'text-black/30'}`}>暂无相关文档</p>
          ) : (
            <div className="space-y-1.5">
              {related.map(r => (
                <button
                  key={r.doc_id}
                  onClick={() => onSelectRelated(r.doc_id)}
                  className={`w-full text-left rounded-lg px-3 py-2 transition-all active:scale-[0.99] ${
                    isDark ? 'glass-card-dark hover:bg-white/8' : 'glass-card-light hover:shadow-md'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`text-[11px] font-medium truncate ${
                      isDark ? 'text-white/80' : 'text-[#1D1D1F]'
                    }`}>{r.doc_name}</span>
                    <span className={`text-[10px] font-mono ${
                      isDark ? 'text-[#FFD60A]' : 'text-[#FF9500]'
                    }`}>{r.score.toFixed(2)}</span>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {r.reasons.slice(0, 3).map((reason, i) => (
                      <span
                        key={i}
                        className={`text-[9px] px-1.5 py-0.5 rounded ${
                          isDark ? 'bg-white/10 text-white/40' : 'bg-black/5 text-black/40'
                        }`}
                        title={Array.isArray(reason.detail) ? reason.detail.join(', ') : String(reason.detail)}
                      >
                        {REASON_LABELS[reason.type] || reason.type}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 路径 */}
        <div>
          {sectionTitle('路径')}
          <p className={`text-[10px] font-mono rounded-lg px-3 py-2 break-all ${
            isDark ? 'bg-white/5 text-white/40' : 'bg-black/3 text-black/40'
          }`}>{doc.rel_path}</p>
        </div>
      </div>
    </aside>
  )
}
