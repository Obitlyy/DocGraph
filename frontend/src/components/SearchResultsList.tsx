import { useState, useMemo } from 'react'
import { SearchResult } from '../hooks/useSuperSearch'
import SearchResultCard from './SearchResultCard'

interface Props {
  results: SearchResult[]
  loading: boolean
  isDark: boolean
  onSelectResult?: (result: SearchResult) => void
  graphName: string
}

const RESULTS_PER_PAGE = 20

export default function SearchResultsList({
  results,
  loading,
  isDark,
  onSelectResult,
  graphName,
}: Props) {
  const [currentPage, setCurrentPage] = useState(1)
  const [sortBy, setSortBy] = useState<'relevance' | 'name'>('relevance')

  // Sort and paginate results
  const sortedResults = useMemo(() => {
    const sorted = [...results]
    if (sortBy === 'relevance') {
      sorted.sort((a, b) => b.relevance - a.relevance)
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title))
    }
    return sorted
  }, [results, sortBy])

  const totalPages = Math.ceil(sortedResults.length / RESULTS_PER_PAGE)
  const paginatedResults = sortedResults.slice(
    (currentPage - 1) * RESULTS_PER_PAGE,
    currentPage * RESULTS_PER_PAGE
  )

  const handleSelectResult = (docId: string) => {
    const result = sortedResults.find((r) => r.docId === docId)
    if (result && onSelectResult) {
      onSelectResult(result)
    }
  }

  // Loading skeleton
  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className={`rounded-lg p-4 border animate-pulse ${
              isDark
                ? 'bg-white/5 border-white/10'
                : 'bg-white/40 border-black/5'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`w-6 h-6 rounded ${
                isDark ? 'bg-white/10' : 'bg-black/10'
              }`} />
              <div className="flex-1 space-y-2">
                <div className={`h-4 w-2/3 rounded ${
                  isDark ? 'bg-white/10' : 'bg-black/10'
                }`} />
                <div className={`h-3 w-1/2 rounded ${
                  isDark ? 'bg-white/5' : 'bg-black/5'
                }`} />
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // No results state
  if (sortedResults.length === 0) {
    return null
  }

  return (
    <div className="space-y-4">
      {/* 排序选项 */}
      <div className="flex items-center gap-3">
        <span className={`text-xs font-medium ${
          isDark ? 'text-white/50' : 'text-black/50'
        }`}>
          排序：
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setSortBy('relevance')
              setCurrentPage(1)
            }}
            className={`px-3 py-1 rounded text-xs font-medium transition-all ${
              sortBy === 'relevance'
                ? isDark
                  ? 'bg-white/20 text-white'
                  : 'bg-black/10 text-black'
                : isDark
                ? 'bg-white/5 text-white/60 hover:bg-white/10'
                : 'bg-black/5 text-black/60 hover:bg-black/10'
            }`}
          >
            相关度
          </button>
          <button
            onClick={() => {
              setSortBy('name')
              setCurrentPage(1)
            }}
            className={`px-3 py-1 rounded text-xs font-medium transition-all ${
              sortBy === 'name'
                ? isDark
                  ? 'bg-white/20 text-white'
                  : 'bg-black/10 text-black'
                : isDark
                ? 'bg-white/5 text-white/60 hover:bg-white/10'
                : 'bg-black/5 text-black/60 hover:bg-black/10'
            }`}
          >
            名称
          </button>
        </div>
      </div>

      {/* 结果列表 */}
      <div className="space-y-3">
        {paginatedResults.map((result, i) => (
          <SearchResultCard
            key={`${result.id}-${i}`}
            result={result}
            isDark={isDark}
            onClick={handleSelectResult}
          />
        ))}
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-4">
          <button
            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
            disabled={currentPage === 1}
            className={`px-3 py-1.5 rounded text-sm transition-all ${
              currentPage === 1
                ? isDark
                  ? 'bg-white/5 text-white/40 cursor-not-allowed'
                  : 'bg-black/5 text-black/40 cursor-not-allowed'
                : isDark
                ? 'bg-white/10 text-white hover:bg-white/20'
                : 'bg-black/10 text-black hover:bg-black/20'
            }`}
          >
            上一页
          </button>

          <div className={`text-xs font-medium px-2 ${
            isDark ? 'text-white/60' : 'text-black/60'
          }`}>
            第 {currentPage} / {totalPages} 页
          </div>

          <button
            onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage === totalPages}
            className={`px-3 py-1.5 rounded text-sm transition-all ${
              currentPage === totalPages
                ? isDark
                  ? 'bg-white/5 text-white/40 cursor-not-allowed'
                  : 'bg-black/5 text-black/40 cursor-not-allowed'
                : isDark
                ? 'bg-white/10 text-white hover:bg-white/20'
                : 'bg-black/10 text-black hover:bg-black/20'
            }`}
          >
            下一页
          </button>
        </div>
      )}

      {/* 底部信息 */}
      <div className={`text-xs text-center py-2 ${
        isDark ? 'text-white/40' : 'text-black/40'
      }`}>
        显示 {paginatedResults.length} / {sortedResults.length} 个结果
      </div>
    </div>
  )
}
