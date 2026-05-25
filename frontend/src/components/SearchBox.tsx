import { useState } from 'react'
import type { SearchMode } from '../hooks/useSuperSearch'

interface Props {
  query: string
  mode: SearchMode
  onQueryChange: (query: string) => void
  onModeChange: (mode: SearchMode) => void
  onSearch: (query: string, mode: SearchMode) => void
  isDark: boolean
  loading?: boolean
}

const MODES: { key: SearchMode; label: string; icon: string }[] = [
  { key: 'keyword', label: '关键词', icon: '📄' },
  { key: 'number', label: '数字', icon: '🔢' },
  { key: 'category', label: '分类', icon: '🏷️' },
  { key: 'relation', label: '关联', icon: '🔗' },
  { key: 'phase', label: '阶段', icon: '📊' },
]

export default function SearchBox({
  query,
  mode,
  onQueryChange,
  onModeChange,
  onSearch,
  isDark,
  loading = false,
}: Props) {
  const [isExpanded, setIsExpanded] = useState(false)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !loading) {
      onSearch(query, mode)
    }
  }

  const handleModeChange = (newMode: SearchMode) => {
    onModeChange(newMode)
    setIsExpanded(false)
  }

  const currentMode = MODES.find((m) => m.key === mode)

  return (
    <div
      className={`rounded-lg p-4 space-y-3 transition-all ${
        isDark
          ? 'bg-white/5 border border-white/10 backdrop-blur-md'
          : 'bg-white/60 border border-black/5 backdrop-blur-md'
      }`}
    >
      {/* 模式选择器 */}
      <div className="flex flex-wrap gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => handleModeChange(m.key)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1 ${
              mode === m.key
                ? isDark
                  ? 'bg-white/20 text-white'
                  : 'bg-black/10 text-black'
                : isDark
                ? 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'
                : 'bg-black/5 text-black/60 hover:bg-black/10 hover:text-black'
            }`}
          >
            <span>{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>

      {/* 输入框 */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            placeholder={`输入${currentMode?.label || '搜索'} - 按 Enter 搜索`}
            className={`w-full px-4 py-2.5 rounded-lg transition-all outline-none ${
              isDark
                ? 'bg-white/10 border border-white/20 text-white placeholder-white/40 focus:bg-white/15 focus:border-white/40'
                : 'bg-white border border-black/10 text-black placeholder-black/40 focus:bg-white/80 focus:border-black/20'
            } ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
          />
        </div>

        {/* 搜索按钮 */}
        <button
          onClick={() => onSearch(query, mode)}
          disabled={loading || !query.trim()}
          className={`px-4 py-2.5 rounded-lg font-medium transition-all flex items-center gap-2 whitespace-nowrap ${
            loading || !query.trim()
              ? isDark
                ? 'bg-white/5 text-white/40 cursor-not-allowed'
                : 'bg-black/5 text-black/40 cursor-not-allowed'
              : isDark
              ? 'bg-white/20 text-white hover:bg-white/30'
              : 'bg-black/10 text-black hover:bg-black/20'
          }`}
        >
          {loading ? (
            <>
              <svg
                className="w-4 h-4 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>搜索中...</span>
            </>
          ) : (
            <>
              <span>🔍</span>
              <span>搜索</span>
            </>
          )}
        </button>

        {/* 清除按钮 */}
        {query && !loading && (
          <button
            onClick={() => onQueryChange('')}
            className={`px-3 py-2.5 rounded-lg transition-all ${
              isDark
                ? 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'
                : 'bg-black/5 text-black/60 hover:bg-black/10 hover:text-black'
            }`}
            title="清除输入"
          >
            ✕
          </button>
        )}
      </div>

      {/* 帮助文本 */}
      <div
        className={`text-xs transition-all ${
          isDark ? 'text-white/40' : 'text-black/40'
        }`}
      >
        {mode === 'keyword' && '搜索文档名称、摘要或关键词'}
        {mode === 'number' && '输入数字查询，如 "3.14" 或 "100%"'}
        {mode === 'category' && '输入分类名称进行过滤'}
        {mode === 'relation' && '输入文档名称查找关联文档'}
        {mode === 'phase' && '输入阶段名称查看相关文档'}
      </div>
    </div>
  )
}
