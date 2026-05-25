import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchGraphs, chatWithDocs } from '../api'
import type { ChatMessage, ChatResult } from '../api'
import { useLocale } from '../locale'

type SearchMode = 'all' | 'keyword' | 'number' | 'category' | 'relation' | 'phase'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  mode: SearchMode
  results?: ResultItem[]
  error?: string
  timestamp: number
}

interface ResultItem {
  id: string
  docId: string
  title: string
  preview: string
  graphName: string
  icon: string
}

interface Props {
  isDark: boolean
  onToggleTheme?: () => void
  onNavigateToGraph?: (graphName: string, docId: string) => void
}

const MODE_KEYS: { key: SearchMode; icon: string; labelKey: string; descKey: string }[] = [
  { key: 'all', icon: '✦', labelKey: 'mode.all', descKey: 'mode.all.desc' },
  { key: 'keyword', icon: '⌕', labelKey: 'mode.keyword', descKey: 'mode.keyword.desc' },
  { key: 'number', icon: '#', labelKey: 'mode.number', descKey: 'mode.number.desc' },
  { key: 'category', icon: '◉', labelKey: 'mode.category', descKey: 'mode.category.desc' },
  { key: 'relation', icon: '⋈', labelKey: 'mode.relation', descKey: 'mode.relation.desc' },
  { key: 'phase', icon: '◈', labelKey: 'mode.phase', descKey: 'mode.phase.desc' },
]

export default function SuperSearchFeature({ isDark, onNavigateToGraph }: Props) {
  const { t } = useLocale()
  const [messages, setMessages] = useState<Message[]>([])
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<SearchMode>('all')
  const [showModes, setShowModes] = useState(false)
  const [loading, setLoading] = useState(false)
  const [graphCount, setGraphCount] = useState(0)
  const [docCount, setDocCount] = useState(0)
  const [ready, setReady] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 加载图谱统计
  useEffect(() => {
    fetchGraphs()
      .then(summaries => {
        setGraphCount(summaries.length)
        setDocCount(summaries.reduce((s, g) => s + g.doc_count, 0))
        setReady(true)
      })
      .catch(() => setReady(true))
  }, [])

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 自动聚焦输入框
  useEffect(() => {
    inputRef.current?.focus()
  }, [loading])

  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  // 发送消息 → 调用 LLM
  const executeSearch = useCallback(async (query: string, searchMode: SearchMode) => {
    if (!query.trim()) return

    // 添加用户消息
    const userMsg: Message = {
      id: genId(),
      role: 'user',
      content: query,
      mode: searchMode,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, userMsg])
    setLoading(true)

    // 构建对话历史
    const newHistory: ChatMessage[] = [...chatHistory, { role: 'user', content: query }]
    setChatHistory(newHistory)

    try {
      const resp = await chatWithDocs(newHistory, searchMode === 'all' ? undefined : searchMode)

      const assistantMsg: Message = {
        id: genId(),
        role: 'assistant',
        content: resp.reply || '(无回复)',
        mode: searchMode,
        results: resp.results || [],
        timestamp: Date.now(),
      }
      setMessages(prev => [...prev, assistantMsg])
      setChatHistory(prev => [...prev, { role: 'assistant', content: resp.reply || '' }])
    } catch (err: any) {
      const errorMsg: Message = {
        id: genId(),
        role: 'assistant',
        content: t('search.failed'),
        mode: searchMode,
        error: err.message || '未知错误',
        timestamp: Date.now(),
      }
      setMessages(prev => [...prev, errorMsg])
    } finally {
      setLoading(false)
    }
  }, [chatHistory])

  const handleSubmit = () => {
    if (!input.trim() || loading) return
    const q = input.trim()
    setInput('')
    executeSearch(q, mode)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const currentMode = MODE_KEYS.find(m => m.key === mode)!

  return (
    <div className="h-full flex flex-col">
      {/* 顶部标题 */}
      <div className={`flex-shrink-0 px-6 py-4 border-b ${
        isDark ? 'border-white/10' : 'border-black/5'
      }`}>
        <div className="max-w-3xl mx-auto text-center">
          <h2 className={`text-lg font-semibold tracking-tight ${
            isDark ? 'text-white' : 'text-[#1D1D1F]'
          }`}>{t('search.title')}</h2>
          <p className={`text-xs mt-1 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
            {t('search.subtitle')}
            {ready && ` · ${t('search.loaded')} ${graphCount} ${t('search.graphs')} · ${docCount} ${t('search.docs')}`}
          </p>
        </div>
      </div>

      {/* 对话区域 */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          // 欢迎页 — 居中提示
          <div className="h-full flex items-center justify-center">
            <div className={`text-center ${isDark ? 'text-white/30' : 'text-black/30'}`}>
              <p className="text-sm">{t('search.welcome')}</p>
            </div>
          </div>
        ) : (
          // 消息流
          <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
            {messages.map(msg => (
              <div key={msg.id}>
                {msg.role === 'user' ? (
                  // 用户消息
                  <div className="flex justify-end items-start gap-3">
                    <div className={`max-w-[75%] px-4 py-2.5 rounded-2xl rounded-br-md text-sm ${
                      isDark ? 'bg-blue-600/80 text-white' : 'bg-[#007AFF] text-white'
                    }`}>
                      {msg.content}
                    </div>
                    <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-sm ${
                      isDark ? 'bg-blue-500/30 text-blue-300' : 'bg-blue-100 text-blue-600'
                    }`}>U</div>
                  </div>
                ) : (
                  // 助手消息
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-sm ${
                      isDark ? 'bg-emerald-500/30 text-emerald-300' : 'bg-emerald-100 text-emerald-600'
                    }`}>AI</div>
                    <div className="flex-1 min-w-0 space-y-3">
                    <div className={`prose prose-sm max-w-none ${
                      isDark ? 'prose-invert' : ''
                    } [&_table]:text-xs [&_table]:border-collapse [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1 ${
                      isDark ? '[&_th]:border-white/20 [&_td]:border-white/10' : '[&_th]:border-black/10 [&_td]:border-black/10'
                    }`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                    {msg.error && (
                      <p className={`text-xs px-3 py-2 rounded-lg ${
                        isDark ? 'bg-red-500/15 text-red-300' : 'bg-red-50 text-red-600'
                      }`}>{msg.error}</p>
                    )}
                    {msg.results && msg.results.length > 0 && (
                      <div className="space-y-2">
                        {msg.results.slice(0, 15).map(r => (
                          <div
                            key={r.id}
                            onClick={() => onNavigateToGraph?.(r.graphName, r.docId)}
                            className={`px-4 py-3 rounded-xl cursor-pointer transition-all ${
                              isDark
                                ? 'bg-white/5 hover:bg-white/10 border border-white/8'
                                : 'bg-white/70 hover:bg-white border border-black/5'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <span className="text-base flex-shrink-0 mt-0.5">{r.icon}</span>
                              <div className="flex-1 min-w-0">
                                <div className={`text-sm font-medium truncate ${
                                  isDark ? 'text-white' : 'text-[#1D1D1F]'
                                }`}>{r.title}</div>
                                <div className={`text-xs mt-0.5 line-clamp-1 ${
                                  isDark ? 'text-white/50' : 'text-black/50'
                                }`}>{r.preview}</div>
                              </div>
                              <span className={`text-[10px] flex-shrink-0 px-1.5 py-0.5 rounded ${
                                isDark ? 'bg-white/10 text-white/40' : 'bg-black/5 text-black/40'
                              }`}>{r.graphName}</span>
                            </div>
                          </div>
                        ))}
                        {msg.results.length > 15 && (
                          <p className={`text-xs text-center py-2 ${
                            isDark ? 'text-white/30' : 'text-black/30'
                          }`}>{msg.results.length - 15} {t('search.more')}</p>
                        )}
                      </div>
                    )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className={`text-sm ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                <span className="inline-block animate-pulse">{t('search.thinking')}</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* 底部输入栏 */}
      <div className={`flex-shrink-0 border-t px-4 py-3 ${
        isDark ? 'border-white/10 bg-black/40' : 'border-black/5 bg-white/60'
      }`}>
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          {/* 模式选择按钮 */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowModes(v => !v)}
              className={`h-10 px-3 rounded-xl text-sm font-medium transition-all flex items-center gap-1.5 ${
                isDark
                  ? 'bg-white/10 hover:bg-white/15 text-white/80'
                  : 'bg-black/5 hover:bg-black/10 text-black/70'
              }`}
              title={t(currentMode.descKey)}
            >
              <span className="text-xs">{currentMode.icon}</span>
              <span>{t(currentMode.labelKey)}</span>
            </button>

            {/* 模式下拉菜单 */}
            {showModes && (
              <div
                className={`absolute bottom-full left-0 mb-2 w-52 rounded-xl overflow-hidden shadow-lg border z-50 ${
                  isDark ? 'bg-[#1C1C1E] border-white/10' : 'bg-white border-black/10'
                }`}
                onMouseLeave={() => setShowModes(false)}
              >
                {MODE_KEYS.map(m => (
                  <button
                    key={m.key}
                    onClick={() => { setMode(m.key); setShowModes(false) }}
                    className={`w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 transition-colors ${
                      mode === m.key
                        ? isDark ? 'bg-white/10 text-white' : 'bg-black/5 text-black'
                        : isDark ? 'text-white/70 hover:bg-white/5' : 'text-black/70 hover:bg-black/[0.03]'
                    }`}
                  >
                    <span className="w-5 text-center text-xs opacity-70">{m.icon}</span>
                    <div>
                      <div className="font-medium">{t(m.labelKey)}</div>
                      <div className={`text-[10px] ${isDark ? 'text-white/40' : 'text-black/40'}`}>{t(m.descKey)}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 输入框 */}
          <div className={`flex-1 h-10 rounded-xl border transition-all flex items-center ${
            isDark
              ? 'bg-white/5 border-white/10 focus-within:border-white/25'
              : 'bg-white border-black/10 focus-within:border-black/20'
          }`}>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading || !ready}
              placeholder={ready ? t('search.placeholder') : t('search.connecting')}
              className={`w-full h-full px-4 text-sm bg-transparent outline-none ${
                isDark ? 'text-white placeholder-white/30' : 'text-[#1D1D1F] placeholder-black/30'
              }`}
            />
          </div>

          {/* 发送按钮 */}
          <button
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            className={`flex-shrink-0 w-10 h-10 rounded-xl transition-all flex items-center justify-center ${
              loading || !input.trim()
                ? isDark ? 'text-white/20' : 'text-black/20'
                : isDark ? 'bg-white/15 hover:bg-white/25 text-white' : 'bg-black/10 hover:bg-black/15 text-black'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
