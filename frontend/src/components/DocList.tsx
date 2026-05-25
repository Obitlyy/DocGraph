import type { Doc } from '../api'

interface Props {
  docs: Doc[]
  onSelect: (doc: Doc) => void
  isDark: boolean
}

export default function DocList({ docs, onSelect, isDark }: Props) {
  // 按分类分组
  const byCategory: Record<string, Doc[]> = {}
  docs.forEach(d => {
    const cat = d.category || '未分类'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(d)
  })

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-baseline gap-3">
        <h2 className={`text-xl font-semibold tracking-tight ${
          isDark ? 'text-white' : 'text-[#1D1D1F]'
        }`}>文档</h2>
        <span className={`text-sm ${isDark ? 'text-white/30' : 'text-black/30'}`}>
          {docs.length} 篇
        </span>
      </div>

      {Object.entries(byCategory).sort().map(([cat, catDocs]) => (
        <section key={cat}>
          <h3 className={`text-xs font-semibold uppercase tracking-wider mb-3 ${
            isDark ? 'text-white/40' : 'text-black/40'
          }`}>
            {cat} <span className={isDark ? 'text-white/20' : 'text-black/20'}>({catDocs.length})</span>
          </h3>
          <div className="space-y-1.5">
            {catDocs.map(d => (
              <button
                key={d.id}
                onClick={() => onSelect(d)}
                className={`w-full text-left rounded-xl px-4 py-3.5 transition-all duration-200 active:scale-[0.995] ${
                  isDark
                    ? 'glass-card-dark hover:bg-white/6'
                    : 'glass-card-light hover:shadow-md'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-[#1D1D1F]'}`}>
                    {d.name}
                  </span>
                  <span className={`ml-auto text-[10px] font-medium ${isDark ? 'text-white/20' : 'text-black/20'}`}>
                    {d.char_count ? `${(d.char_count / 1000).toFixed(1)}k` : ''}
                  </span>
                </div>
                {d.summary && (
                  <p className={`text-xs mt-1 line-clamp-1 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                    {d.summary}
                  </p>
                )}
                {d.keywords && d.keywords.length > 0 && (
                  <div className="flex gap-1.5 mt-2 flex-wrap">
                    {d.keywords.map(k => (
                      <span key={k} className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                        isDark ? 'bg-white/10 text-white/50' : 'bg-black/5 text-black/40'
                      }`}>{k}</span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
