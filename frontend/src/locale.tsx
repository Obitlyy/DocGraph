/**
 * 简易 i18n — 中/英文 UI 文本字典。
 * 使用：const t = useLocale() 获取翻译函数，t('key') 返回当前语言的文本。
 */
import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

export type Lang = 'zh' | 'en'

// ========== 字典 ==========
const dict: Record<string, { zh: string; en: string }> = {
  // App 顶部
  'nav.graph': { zh: '文档图谱', en: 'Doc Graph' },
  'nav.fullscan': { zh: '全量扫描', en: 'Full Scan' },
  'nav.search': { zh: '超级搜索', en: 'Super Search' },

  // 超级搜索
  'search.title': { zh: '文档超级搜索', en: 'Document Super Search' },
  'search.subtitle': { zh: '跨所有图谱搜索文档——关键词、数字追踪、分类、关联、阶段', en: 'Search across all graphs — keywords, numbers, categories, relations, phases' },
  'search.loaded': { zh: '已载入', en: 'Loaded' },
  'search.graphs': { zh: '个图谱', en: 'graphs' },
  'search.docs': { zh: '篇文档', en: 'docs' },
  'search.placeholder': { zh: '问点什么...', en: 'Ask anything...' },
  'search.connecting': { zh: '正在连接...', en: 'Connecting...' },
  'search.thinking': { zh: '搜索中...', en: 'Thinking...' },
  'search.failed': { zh: '请求失败', en: 'Request failed' },
  'search.welcome': { zh: '输入搜索内容开始', en: 'Type to start searching' },
  'search.more': { zh: '个结果未显示', en: 'more results' },

  // 搜索模式
  'mode.all': { zh: '智能', en: 'Smart' },
  'mode.keyword': { zh: '关键词', en: 'Keyword' },
  'mode.number': { zh: '数字追踪', en: 'Numbers' },
  'mode.category': { zh: '分类', en: 'Category' },
  'mode.relation': { zh: '关联', en: 'Related' },
  'mode.phase': { zh: '阶段', en: 'Phase' },
  'mode.all.desc': { zh: '自动判断搜索方式', en: 'Auto-detect search mode' },
  'mode.keyword.desc': { zh: '名称/摘要/关键词匹配', en: 'Match name/summary/keywords' },
  'mode.number.desc': { zh: '在文档中搜索数字', en: 'Search numbers in documents' },
  'mode.category.desc': { zh: '按分类筛选文档', en: 'Filter by category' },
  'mode.relation.desc': { zh: '查找关联文档', en: 'Find related documents' },
  'mode.phase.desc': { zh: '按阶段查找文档', en: 'Search by project phase' },

  // 设置
  'settings.title': { zh: '设置', en: 'Settings' },
  'settings.language': { zh: '语言 / Language', en: 'Language' },
  'settings.deepseek': { zh: 'DeepSeek API（文字分析）', en: 'DeepSeek API (Text Analysis)' },
  'settings.vision': { zh: '火山方舟豆包（图像多模态）', en: 'Volcengine Doubao (Vision)' },
  'settings.appearance': { zh: '外观', en: 'Appearance' },
  'settings.apikey': { zh: 'API Key', en: 'API Key' },
  'settings.model': { zh: '模型', en: 'Model' },
  'settings.darkMode': { zh: '深色模式', en: 'Dark mode' },
  'settings.lightMode': { zh: '浅色模式', en: 'Light mode' },
  'settings.clickToggle': { zh: '点击切换', en: 'Click to toggle' },
  'settings.save': { zh: '保存设置', en: 'Save' },
  'settings.saving': { zh: '保存中...', en: 'Saving...' },
  'settings.saved': { zh: '✅ 已保存', en: '✅ Saved' },
  'settings.loadFailed': { zh: '加载设置失败', en: 'Failed to load settings' },
  'settings.current': { zh: '当前', en: 'Current' },

  // 文档图谱
  'graph.title': { zh: '文档图谱', en: 'Document Graph' },
  'graph.selectOrCreate': { zh: '选择已有图谱，或创建新图谱。', en: 'Select an existing graph or create a new one.' },
  'graph.existing': { zh: '已有图谱', en: 'Existing Graphs' },
  'graph.new': { zh: '新建图谱', en: 'New Graph' },
  'graph.folderPath': { zh: '文件夹路径', en: 'Folder path' },
  'graph.name': { zh: '图谱名称', en: 'Graph name' },
  'graph.scanCreate': { zh: '扫描并创建', en: 'Scan & Create' },
  'graph.back': { zh: '← 返回', en: '← Back' },
  'graph.docs': { zh: '篇', en: 'docs' },
  'graph.relations': { zh: '关系', en: 'relations' },
  'graph.analyzing': { zh: '⏳ 分析中…', en: '⏳ Analyzing…' },
  'graph.aiAnalyze': { zh: '🤖 AI 分析', en: '🤖 AI Analyze' },
  'graph.classify': { zh: '文档分类', en: 'Classify' },
  'graph.inferRelations': { zh: '推断关系', en: 'Infer Relations' },
  'graph.incrementalUpdate': { zh: '增量更新', en: 'Incremental Update' },
  'graph.phasePartition': { zh: '阶段划分', en: 'Phase Partition' },
  'graph.delete': { zh: '确定删除图谱', en: 'Delete graph' },
  'graph.deleteConfirm': { zh: '此操作不可恢复。', en: 'This cannot be undone.' },
  'graph.rename': { zh: '重命名图谱', en: 'Rename graph' },

  // 标签页
  'tab.graph': { zh: '图谱', en: 'Graph' },
  'tab.docs': { zh: '文档', en: 'Docs' },
  'tab.relations': { zh: '关系', en: 'Relations' },
  'tab.phases': { zh: '阶段', en: 'Phases' },

  // 全量扫描
  'fullscan.title': { zh: '全量扫描', en: 'Full Scan' },
  'fullscan.pickRoots': { zh: '选择扫描根目录', en: 'Select scan roots' },
  'fullscan.pickSubdirs': { zh: '选择子目录', en: 'Select subdirectories' },
  'fullscan.scanning': { zh: '扫描中', en: 'Scanning' },
  'fullscan.result': { zh: '扫描结果', en: 'Results' },
  'fullscan.history': { zh: '扫描历史', en: 'History' },
  'fullscan.startScan': { zh: '开始扫描', en: 'Start Scan' },
  'fullscan.useLlm': { zh: 'LLM 重审', en: 'LLM Review' },
  'fullscan.deepExplore': { zh: '深度探索', en: 'Deep Explore' },

  // 通用
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.confirm': { zh: '确认', en: 'Confirm' },
  'common.delete': { zh: '删除', en: 'Delete' },
  'common.rename': { zh: '重命名', en: 'Rename' },
  'common.close': { zh: '关闭', en: 'Close' },
  'common.loading': { zh: '加载中...', en: 'Loading...' },
  'common.noData': { zh: '暂无数据', en: 'No data' },
}

// ========== Context ==========

interface LocaleContextType {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: string) => string
}

const LocaleContext = createContext<LocaleContextType>({
  lang: 'zh',
  setLang: () => {},
  t: (key) => key,
})

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>('zh')

  // 从后端加载语言设置
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        if (data.language === 'en' || data.language === 'zh') {
          setLang(data.language)
        }
      })
      .catch(() => {})
  }, [])

  const t = (key: string): string => {
    const entry = dict[key]
    if (!entry) return key
    return entry[lang] || entry.zh || key
  }

  return (
    <LocaleContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LocaleContext.Provider>
  )
}

export function useLocale() {
  return useContext(LocaleContext)
}
