import { useState, useEffect, useRef } from 'react'
import GraphFeature from './features/GraphFeature'
import FullScanFeature from './features/FullScanFeature'
import SuperSearchFeature from './features/SuperSearchFeature'
import SegmentedControl from './components/SegmentedControl'
import SettingsModal from './components/SettingsModal'
import NotificationBell from './components/NotificationBell'
import { API_BASE } from './api'
import { useLocale } from './locale'

type Feature = 'graph' | 'fullscan' | 'search'

export interface PendingImport {
  suggestedName: string
  files: string[]          // 绝对路径列表
  commonRoot?: string
  source: string           // 展示用，来源描述
}

// Interface for passing selected document from search to graph
export interface SelectedDocument {
  graphName: string
  docId: string
}

const FEATURES: { key: Feature; label: string }[] = [
  { key: 'graph', label: '文档图谱' },
  { key: 'fullscan', label: '全量扫描' },
  { key: 'search', label: '超级搜索' },
]

export default function App() {
  const { t } = useLocale()
  const [activeFeature, setActiveFeature] = useState<Feature>('graph')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<SelectedDocument | null>(null)
  const [showSplash, setShowSplash] = useState(true)
  const [splashFading, setSplashFading] = useState(false)
  const splashStart = useRef(Date.now())
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  // 开屏动画：至少 1 秒，等后端就绪后淡出
  useEffect(() => {
    const checkBackend = async () => {
      try {
        await fetch(`${API_BASE}/graphs`)
      } catch { /* 后端未就绪也继续 */ }

      // 保证至少显示 1 秒
      const elapsed = Date.now() - splashStart.current
      const remaining = Math.max(0, 1000 - elapsed)
      setTimeout(() => {
        setSplashFading(true)
        setTimeout(() => setShowSplash(false), 400) // 淡出动画 400ms
      }, remaining)
    }
    checkBackend()
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  const handleNavigateToGraph = (graphName: string, docId: string) => {
    setSelectedDocument({ graphName, docId })
    setActiveFeature('graph')
  }

  const handleConsumeSelectedDocument = () => {
    setSelectedDocument(null)
  }

  // 开屏动画
  if (showSplash) {
    return (
      <div className={`h-screen flex items-center justify-center transition-opacity duration-400 ${
        splashFading ? 'opacity-0' : 'opacity-100'
      } ${isDark ? 'bg-black' : 'bg-[#F5F5F7]'}`}>
        <div className="text-center">
          <div className="relative w-16 h-16 mx-auto mb-5">
            <div className={`absolute inset-0 rounded-full border-2 border-t-transparent animate-spin`} style={{ borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)', borderTopColor: '#007AFF' }} />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className={`w-3 h-3 rounded-full ${isDark ? 'bg-white/50' : 'bg-black/30'}`} />
            </div>
          </div>
          <h1 className={`text-2xl font-bold tracking-tight ${
            isDark ? 'text-white' : 'text-[#1D1D1F]'
          }`}>DocGraph</h1>
        </div>
      </div>
    )
  }

  return (
    <div className={`h-screen flex flex-col transition-colors duration-300 ${
      isDark ? 'bg-black text-white' : 'bg-[#F5F5F7] text-[#1D1D1F]'
    }`}>
      {/* 全局顶栏（可拖动窗口） */}
      <header
        className={`flex-shrink-0 px-4 py-3 flex items-center gap-4 glass-panel ${
          isDark ? 'glass-panel-dark' : 'glass-panel-light'
        }`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* 左侧占位（为 macOS 红绿灯让出空间） */}
        <div className="w-16 flex-shrink-0" />

        {/* 中央三段控制 */}
        <div className="flex-1 flex justify-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <SegmentedControl
            items={[
              { key: 'graph', label: t('nav.graph') },
              { key: 'fullscan', label: t('nav.fullscan') },
              { key: 'search', label: t('nav.search') },
            ]}
            value={activeFeature}
            onChange={setActiveFeature}
            isDark={isDark}
            size="lg"
          />
        </div>

        {/* 右侧：通知 + 设置 + 主题切换 */}
        <div className="flex items-center gap-1 flex-shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <NotificationBell isDark={isDark} />
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="设置"
            className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${
              isDark
                ? 'hover:bg-white/10 text-white/70 hover:text-white'
                : 'hover:bg-black/5 text-black/60 hover:text-black'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <button
            onClick={() => setIsDark(d => !d)}
            aria-label={isDark ? '切换亮色' : '切换暗色'}
            title={isDark ? '切换亮色' : '切换暗色'}
            className={`w-9 h-9 rounded-full flex items-center justify-center text-base transition-all ${
              isDark
                ? 'hover:bg-white/10 text-white/70 hover:text-white'
                : 'hover:bg-black/5 text-black/60 hover:text-black'
            }`}
          >
            {isDark ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {/* Feature 切换 */}
      <div className="flex-1 overflow-hidden">
        {activeFeature === 'graph' && (
          <GraphFeature
            isDark={isDark}
            onToggleTheme={() => setIsDark(d => !d)}
            pendingImport={pendingImport}
            onConsumePendingImport={() => setPendingImport(null)}
            selectedDocument={selectedDocument}
            onConsumeSelectedDocument={handleConsumeSelectedDocument}
          />
        )}
        {activeFeature === 'fullscan' && (
          <FullScanFeature
            isDark={isDark}
            onRequestBuildGraph={(req) => {
              setPendingImport(req)
              setActiveFeature('graph')
            }}
          />
        )}
        {activeFeature === 'search' && (
          <SuperSearchFeature
            isDark={isDark}
            onToggleTheme={() => setIsDark(d => !d)}
            onNavigateToGraph={handleNavigateToGraph}
          />
        )}
      </div>

      {/* 设置弹窗 */}
      {settingsOpen && (
        <SettingsModal
          isDark={isDark}
          onClose={() => setSettingsOpen(false)}
          onToggleTheme={() => setIsDark(d => !d)}
        />
      )}
    </div>
  )
}
