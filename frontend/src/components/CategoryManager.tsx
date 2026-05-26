import { useState, useEffect } from 'react'
import { listCategories, mergeCategories, renameCategory } from '../api'

interface Props {
  graphName: string
  isDark: boolean
  onCategoriesChanged: () => void
}

export default function CategoryManager({ graphName, isDark, onCategoriesChanged }: Props) {
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [mergeMode, setMergeMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mergeName, setMergeName] = useState('')

  const reload = async () => {
    if (!graphName) return
    try {
      const data = await listCategories(graphName)
      setCategories(data.categories)
    } catch {
      // 加载分类失败时静默忽略
    }
  }

  useEffect(() => { reload() }, [graphName])

  const handleRename = async (oldName: string) => {
    if (!editValue.trim() || editValue === oldName) {
      setEditing(null)
      return
    }
    try {
      await renameCategory(graphName, oldName, editValue.trim())
      setEditing(null)
      await reload()
      onCategoriesChanged()
    } catch (e: any) {
      alert('重命名失败: ' + e.message)
    }
  }

  const handleMerge = async () => {
    if (selected.size < 2 || !mergeName.trim()) return
    const mapping: Record<string, string> = {}
    selected.forEach(name => { mapping[name] = mergeName.trim() })
    try {
      await mergeCategories(graphName, mapping)
      setMergeMode(false)
      setSelected(new Set())
      setMergeName('')
      await reload()
      onCategoriesChanged()
    } catch (e: any) {
      alert('合并失败: ' + e.message)
    }
  }

  const toggleSelect = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  if (!graphName || categories.length === 0) return null

  return (
    <section className="px-3 py-4">
      <div className="flex items-center justify-between px-2 mb-2">
        <p className={`text-[10px] font-semibold uppercase tracking-widest ${
          isDark ? 'text-white/30' : 'text-black/30'
        }`}>分类管理 ({categories.length})</p>
        <button
          onClick={() => { setMergeMode(!mergeMode); setSelected(new Set()); setMergeName('') }}
          className={`text-[9px] px-2 py-0.5 rounded-md transition-all ${
            mergeMode
              ? 'bg-[#FF9F0A]/20 text-[#FF9F0A]'
              : isDark ? 'text-white/30 hover:text-white/50' : 'text-black/30 hover:text-black/50'
          }`}
        >
          {mergeMode ? '取消合并' : '合并'}
        </button>
      </div>

      <div className="space-y-1">
        {categories.map(cat => (
          <div
            key={cat.name}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all ${
              mergeMode && selected.has(cat.name)
                ? isDark ? 'bg-[#FF9F0A]/15 ring-1 ring-[#FF9F0A]/40' : 'bg-[#FF9500]/10 ring-1 ring-[#FF9500]/30'
                : isDark ? 'hover:bg-white/5' : 'hover:bg-black/3'
            }`}
          >
            {mergeMode && (
              <input
                type="checkbox"
                checked={selected.has(cat.name)}
                onChange={() => toggleSelect(cat.name)}
                className="w-3 h-3 rounded accent-[#FF9F0A]"
              />
            )}
            
            {editing === cat.name ? (
              <input
                className={`flex-1 text-[11px] rounded px-2 py-1 outline-none ${
                  isDark ? 'bg-white/10 text-white' : 'bg-black/5 text-[#1D1D1F]'
                }`}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleRename(cat.name)
                  if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={() => handleRename(cat.name)}
                autoFocus
              />
            ) : (
              <span
                className={`flex-1 text-[11px] truncate cursor-pointer ${
                  isDark ? 'text-white/70' : 'text-black/60'
                }`}
                onClick={() => {
                  if (!mergeMode) {
                    setEditing(cat.name)
                    setEditValue(cat.name)
                  } else {
                    toggleSelect(cat.name)
                  }
                }}
              >
                {cat.name}
              </span>
            )}
            
            <span className={`text-[10px] tabular-nums ${isDark ? 'text-white/20' : 'text-black/20'}`}>
              {cat.count}
            </span>
          </div>
        ))}
      </div>

      {/* 合并操作区 */}
      {mergeMode && selected.size >= 2 && (
        <div className={`mt-3 mx-2 p-2.5 rounded-xl ${isDark ? 'bg-white/5' : 'bg-black/3'}`}>
          <p className={`text-[10px] mb-1.5 ${isDark ? 'text-white/30' : 'text-black/30'}`}>
            已选 {selected.size} 个分类，合并为：
          </p>
          <div className="flex gap-1.5">
            <input
              className={`flex-1 text-[11px] rounded-lg px-2.5 py-1.5 outline-none ${
                isDark ? 'bg-white/10 text-white placeholder-white/25' : 'bg-white text-[#1D1D1F] placeholder-black/25'
              }`}
              placeholder="新分类名称"
              value={mergeName}
              onChange={e => setMergeName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleMerge() }}
            />
            <button
              onClick={handleMerge}
              disabled={!mergeName.trim()}
              className="text-[10px] px-3 py-1.5 rounded-lg bg-[#FF9F0A] text-white font-medium disabled:opacity-40"
            >合并</button>
          </div>
        </div>
      )}
    </section>
  )
}
