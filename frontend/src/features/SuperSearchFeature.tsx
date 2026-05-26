import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchGraphs, chatWithDocsStream } from '../api'
import type { ChatMessage, ChatResult, StreamEvent } from '../api'
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

// 聊天记录
interface ChatSession {
  id: string
  title: string
  messages: Message[]
  chatHistory: ChatMessage[]
  createdAt: number
  updatedAt: number
}

const STORAGE_KEY = 'docgraph_chat_sessions'

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveSessions(sessions: ChatSession[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
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
  const [sessions, setSessions] = useState<ChatSession[]>(loadSessions)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<SearchMode>('all')
  const [showModes, setShowModes] = useState(false)
  const [showSidebar, setShowSidebar] = useState(false)
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
  }, [loading, activeSessionId])

  // 保存当前会话到 sessions
  useEffect(() => {
    if (!activeSessionId || messages.length === 0) return
    setSessions(prev => {
      const updated = prev.map(s =>
        s.id === activeSessionId
          ? { ...s, messages, chatHistory, updatedAt: Date.now(), title: messages[0]?.content.slice(0, 20) || '新对话' }
          : s
      )
      saveSessions(updated)
      return updated
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  // 新建对话
  const handleNewChat = () => {
    const newSession: ChatSession = {
      id: genId(),
      title: '新对话',
      messages: [],
      chatHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const updated = [newSession, ...sessions]
    setSessions(updated)
    saveSessions(updated)
    setActiveSessionId(newSession.id)
    setMessages([])
    setChatHistory([])
  }

  // 切换对话
  const handleSwitchSession = (session: ChatSession) => {
    setActiveSessionId(session.id)
    setMessages(session.messages)
    setChatHistory(session.chatHistory)
    setShowSidebar(false)
  }

  // 删除对话
  const handleDeleteSession = (id: string) => {
    const updated = sessions.filter(s => s.id !== id)
    setSessions(updated)
    saveSessions(updated)
    if (activeSessionId === id) {
      setActiveSessionId(null)
      setMessages([])
      setChatHistory([])
    }
  }

  // 发送消息 → 调用 LLM（流式）
  const executeSearch = useCallback(async (query: string, searchMode: SearchMode) => {
    if (!query.trim()) return

    // 如果没有活跃会话，自动创建一个
    if (!activeSessionId) {
      const newSession: ChatSession = {
        id: genId(),
        title: query.slice(0, 20),
        messages: [],
        chatHistory: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      setSessions(prev => {
        const updated = [newSession, ...prev]
        saveSessions(updated)
        return updated
      })
      setActiveSessionId(newSession.id)
    }

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

    // 创建占位的助手消息（逐步填充）
    const assistantId = genId()
    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      mode: searchMode,
      results: [],
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, assistantMsg])

    try {
      let fullContent = ''
      let results: ResultItem[] = []

      await chatWithDocsStream(
        newHistory,
        searchMode === 'all' ? undefined : searchMode,
        (event: StreamEvent) => {
          if (event.type === 'token') {
            fullContent += event.text || ''
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, content: fullContent } : m
            ))
          } else if (event.type === 'results') {
            results = event.data || []
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, results } : m
            ))
          } else if (event.type === 'status') {
            // 显示状态在 content 中（如果还没有实际内容）
            if (!fullContent) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: `_${event.text}_` } : m
              ))
            }
          }
        }
      )

      // 流结束，确保最终状态正确
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: fullContent || '(无回复)', results } : m
      ))
      setChatHistory(prev => [...prev, { role: 'assistant', content: fullContent }])
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: t('search.failed'), error: err.message } : m
      ))
    } finally {
      setLoading(false)
    }
  }, [chatHistory, activeSessionId])

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
    <div className="h-full flex">
      {/* 侧边栏 - 聊天记录 */}
      {showSidebar && (
        <div className={`w-64 flex-shrink-0 border-r flex flex-col ${
          isDark ? 'border-white/10 bg-[#1C1C1E]/80' : 'border-black/5 bg-white/60'
        } backdrop-blur-xl`}>
          <div className="p-3 flex items-center justify-between">
            <span className={`text-xs font-semibold ${isDark ? 'text-white/50' : 'text-black/50'}`}>聊天记录</span>
            <button
              onClick={() => setShowSidebar(false)}
              className={`w-6 h-6 rounded flex items-center justify-center text-xs ${
                isDark ? 'hover:bg-white/10 text-white/50' : 'hover:bg-black/5 text-black/50'
              }`}
            >✕</button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 space-y-1">
            {sessions.map(s => (
              <div
                key={s.id}
                onClick={() => handleSwitchSession(s)}
                className={`group px-3 py-2 rounded-lg cursor-pointer flex items-center justify-between ${
                  s.id === activeSessionId
                    ? isDark ? 'bg-white/10' : 'bg-black/5'
                    : isDark ? 'hover:bg-white/5' : 'hover:bg-black/[0.02]'
                }`}
              >
                <span className={`text-xs truncate flex-1 ${
                  isDark ? 'text-white/70' : 'text-black/70'
                }`}>{s.title || '新对话'}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id) }}
                  className={`w-5 h-5 rounded flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity ${
                    isDark ? 'hover:bg-white/10 text-white/40' : 'hover:bg-black/5 text-black/40'
                  }`}
                >✕</button>
              </div>
            ))}
            {sessions.length === 0 && (
              <p className={`text-xs text-center py-4 ${isDark ? 'text-white/30' : 'text-black/30'}`}>暂无记录</p>
            )}
          </div>
        </div>
      )}

      {/* 主区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 顶部标题 */}
        <div className={`flex-shrink-0 px-6 py-4 border-b ${
          isDark ? 'border-white/10' : 'border-black/5'
        }`}>
          <div className="max-w-3xl mx-auto flex items-center">
            {/* 左侧：侧边栏按钮 + 新建 */}
            <div className="flex items-center gap-2 mr-4">
              <button
                onClick={() => setShowSidebar(v => !v)}
                title="聊天记录"
                className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${
                  isDark ? 'hover:bg-white/10 text-white/50' : 'hover:bg-black/5 text-black/50'
                }`}
              >☰</button>
              <button
                onClick={handleNewChat}
                title="新对话"
                className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${
                  isDark ? 'hover:bg-white/10 text-white/50' : 'hover:bg-black/5 text-black/50'
                }`}
              >+</button>
            </div>
            {/* 中间标题 */}
            <div className="flex-1 text-center">
              <h2 className={`text-lg font-semibold tracking-tight ${
                isDark ? 'text-white' : 'text-[#1D1D1F]'
              }`}>{t('search.title')}</h2>
              <p className={`text-xs mt-1 ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                {t('search.subtitle')}
                {ready && ` · ${t('search.loaded')} ${graphCount} ${t('search.graphs')} · ${docCount} ${t('search.docs')}`}
              </p>
            </div>
            {/* 右侧占位平衡 */}
            <div className="w-20" />
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
                      <CollapsibleResults results={msg.results} isDark={isDark} onNavigate={onNavigateToGraph} />
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
    </div>
  )
}

// 可折叠的文档结果列表
function CollapsibleResults({ results, isDark, onNavigate }: {
  results: ResultItem[]
  isDark: boolean
  onNavigate?: (graphName: string, docId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const displayCount = expanded ? Math.min(results.length, 15) : 0

  return (
    <div className={`rounded-xl border overflow-hidden ${
      isDark ? 'border-white/10' : 'border-black/5'
    }`}>
      {/* 折叠头 */}
      <button
        onClick={() => setExpanded(v => !v)}
        className={`w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium transition-colors ${
          isDark
            ? 'bg-white/5 hover:bg-white/8 text-white/60'
            : 'bg-black/[0.02] hover:bg-black/[0.04] text-black/50'
        }`}
      >
        <span>📎 {results.length} 个相关文档</span>
        <span className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {/* 展开的文档列表 */}
      {expanded && (
        <div className="space-y-1 p-2">
          {results.slice(0, displayCount).map(r => (
            <div
              key={r.id}
              onClick={() => onNavigate?.(r.graphName, r.docId)}
              className={`px-3 py-2 rounded-lg cursor-pointer transition-all ${
                isDark
                  ? 'hover:bg-white/8'
                  : 'hover:bg-black/[0.03]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm flex-shrink-0">{r.icon}</span>
                <span className={`text-xs font-medium truncate flex-1 ${
                  isDark ? 'text-white/80' : 'text-[#1D1D1F]'
                }`}>{r.title}</span>
                <span className={`text-[10px] flex-shrink-0 px-1.5 py-0.5 rounded ${
                  isDark ? 'bg-white/10 text-white/30' : 'bg-black/5 text-black/30'
                }`}>{r.graphName}</span>
              </div>
            </div>
          ))}
          {results.length > 15 && (
            <p className={`text-[10px] text-center py-1 ${isDark ? 'text-white/30' : 'text-black/30'}`}>
              +{results.length - 15} more
            </p>
          )}
        </div>
      )}
    </div>
  )
}
