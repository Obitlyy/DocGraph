import { SearchResult } from '../hooks/useSuperSearch'

interface Props {
  result: SearchResult
  isDark: boolean
  onClick: (docId: string) => void
}

export default function SearchResultCard({ result, isDark, onClick }: Props) {
  return (
    <div
      onClick={() => result.docId && onClick(result.docId)}
      className={`rounded-lg p-4 border transition-all cursor-pointer ${
        isDark
          ? 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20'
          : 'bg-white/40 border-black/5 hover:bg-white/70 hover:border-black/10'
      }`}
    >
      {/* 顶部：图标、标题、分数 */}
      <div className="flex items-start gap-3 mb-2">
        <div className="text-xl flex-shrink-0">{result.icon || '📄'}</div>
        <div className="flex-1 min-w-0">
          <h3 className={`font-semibold text-sm leading-tight mb-1 truncate ${
            isDark ? 'text-white' : 'text-[#1D1D1F]'
          }`}>
            {result.title}
          </h3>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              isDark
                ? 'bg-white/10 text-white/60'
                : 'bg-black/10 text-black/60'
            }`}>
              {result.type === 'doc' ? '文档' : result.type}
            </span>
            {result.relevance > 0 && (
              <span className={`text-xs ${
                isDark ? 'text-white/40' : 'text-black/40'
              }`}>
                相关度: {(result.relevance * 10).toFixed(0)}%
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 预览 */}
      <p className={`text-xs leading-relaxed line-clamp-2 mb-2 ${
        isDark ? 'text-white/60' : 'text-black/60'
      }`}>
        {result.preview}
      </p>

      {/* 元数据 */}
      {Object.keys(result.metadata).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {result.metadata.category && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              isDark
                ? 'bg-blue-500/20 text-blue-300'
                : 'bg-blue-100 text-blue-700'
            }`}>
              {result.metadata.category}
            </span>
          )}
          {result.metadata.phase && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              isDark
                ? 'bg-purple-500/20 text-purple-300'
                : 'bg-purple-100 text-purple-700'
            }`}>
              {result.metadata.phase}
            </span>
          )}
          {result.metadata.count && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              isDark
                ? 'bg-green-500/20 text-green-300'
                : 'bg-green-100 text-green-700'
            }`}>
              x{result.metadata.count}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
