import { useState, useEffect } from 'react'
import { useLocale } from '../locale'
import type { Lang } from '../locale'

interface Props {
  isDark: boolean
  onClose: () => void
  onToggleTheme: () => void
}

interface Settings {
  language: string
  deepseek_api_key: string
  deepseek_model: string
  vision_api_key: string
  vision_model: string
}

export default function SettingsModal({ isDark, onClose, onToggleTheme }: Props) {
  const { t, lang: currentLang, setLang: setGlobalLang } = useLocale()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  // 表单状态
  const [language, setLanguage] = useState<Lang>(currentLang)
  const [deepseekKey, setDeepseekKey] = useState('')
  const [deepseekModel, setDeepseekModel] = useState('deepseek-v4-flash')
  const [visionKey, setVisionKey] = useState('')
  const [visionModel, setVisionModel] = useState('doubao-seed-1-6-250615')

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        setSettings(data)
        setLanguage(data.language || 'zh')
        setDeepseekKey(data.deepseek_api_key || '')
        setDeepseekModel(data.deepseek_model || 'deepseek-v4-flash')
        setVisionKey(data.vision_api_key || '')
        setVisionModel(data.vision_model || '')
      })
      .catch(() => setMessage(t('settings.loadFailed')))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setMessage('')
    try {
      const body: Record<string, string> = { language }
      // 只有用户修改了 key 才提交（不是 mask 的）
      if (!deepseekKey.endsWith('***')) body.deepseek_api_key = deepseekKey
      if (!visionKey.endsWith('***')) body.vision_api_key = visionKey
      body.deepseek_model = deepseekModel
      body.vision_model = visionModel

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('保存失败')
      // 同步语言到全局 context
      setGlobalLang(language)
      setMessage(t('settings.saved'))
      setTimeout(() => setMessage(''), 2000)
    } catch (e: any) {
      setMessage(`❌ ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const labelClass = `block text-xs font-medium mb-1.5 ${isDark ? 'text-white/60' : 'text-black/60'}`
  const inputClass = `w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors ${
    isDark
      ? 'bg-white/5 border border-white/10 focus:border-blue-500/50 text-white placeholder-white/30'
      : 'bg-black/[0.03] border border-black/10 focus:border-blue-500/50 text-[#1D1D1F] placeholder-black/30'
  }`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(20px)' }}
      onClick={onClose}
    >
      <div
        className={`w-full max-w-lg rounded-3xl p-8 backdrop-blur-2xl border shadow-2xl max-h-[85vh] overflow-y-auto ${
          isDark ? 'bg-[#1C1C1E]/90 border-white/10 text-white' : 'bg-white/90 border-black/5 text-[#1D1D1F]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold tracking-tight">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
            }`}
          >✕</button>
        </div>

        <div className="space-y-6">
          {/* 语言 */}
          <section>
            <SectionTitle isDark={isDark}>{t('settings.language')}</SectionTitle>
            <div className="flex gap-2">
              {([['zh', '中文'], ['en', 'English']] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setLanguage(key as Lang)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    language === key
                      ? isDark ? 'bg-blue-500/30 text-blue-200 border border-blue-500/40' : 'bg-blue-50 text-blue-700 border border-blue-200'
                      : isDark ? 'bg-white/5 text-white/60 border border-white/10' : 'bg-black/[0.03] text-black/60 border border-black/10'
                  }`}
                >{label}</button>
              ))}
            </div>
          </section>

          {/* DeepSeek API */}
          <section>
            <SectionTitle isDark={isDark}>{t('settings.deepseek')}</SectionTitle>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>API Key</label>
                <input
                  type="password"
                  value={deepseekKey}
                  onChange={e => setDeepseekKey(e.target.value)}
                  placeholder="sk-..."
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>模型</label>
                <select
                  value={deepseekModel}
                  onChange={e => setDeepseekModel(e.target.value)}
                  className={inputClass}
                >
                  <option value="deepseek-v4-flash">deepseek-v4-flash（推荐）</option>
                  <option value="deepseek-chat">deepseek-chat</option>
                  <option value="deepseek-reasoner">deepseek-reasoner（深度思考）</option>
                </select>
              </div>
            </div>
          </section>

          {/* 火山方舟豆包 API */}
          <section>
            <SectionTitle isDark={isDark}>{t('settings.vision')}</SectionTitle>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>API Key</label>
                <input
                  type="password"
                  value={visionKey}
                  onChange={e => setVisionKey(e.target.value)}
                  placeholder="ark-..."
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>模型</label>
                <input
                  type="text"
                  value={visionModel}
                  onChange={e => setVisionModel(e.target.value)}
                  placeholder="doubao-seed-1-6-250615"
                  className={inputClass}
                />
              </div>
            </div>
          </section>

          {/* 主题 */}
          <section>
            <SectionTitle isDark={isDark}>{t('settings.appearance')}</SectionTitle>
            <button
              onClick={onToggleTheme}
              className={`w-full py-2.5 rounded-xl text-sm font-medium transition-all ${
                isDark ? 'bg-white/5 border border-white/10 text-white/80 hover:bg-white/10' : 'bg-black/[0.03] border border-black/10 text-black/70 hover:bg-black/[0.06]'
              }`}
            >
              {t('settings.current')}：{isDark ? t('settings.darkMode') + ' 🌙' : t('settings.lightMode') + ' ☀️'}　{t('settings.clickToggle')}
            </button>
          </section>
        </div>

        {/* 底部操作 */}
        <div className="mt-8 flex items-center justify-between">
          <span className={`text-xs ${isDark ? 'text-white/40' : 'text-black/40'}`}>
            {message || 'DocGraph v0.3'}
          </span>
          <button
            onClick={handleSave}
            disabled={saving}
            className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              saving
                ? isDark ? 'bg-white/10 text-white/30' : 'bg-black/10 text-black/30'
                : isDark ? 'bg-blue-500 hover:bg-blue-600 text-white' : 'bg-[#007AFF] hover:bg-[#006AE0] text-white'
            }`}
          >{saving ? t('settings.saving') : t('settings.save')}</button>
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children, isDark }: { children: React.ReactNode; isDark: boolean }) {
  return (
    <h3 className={`text-xs font-semibold uppercase tracking-wider mb-3 ${
      isDark ? 'text-white/40' : 'text-black/40'
    }`}>{children}</h3>
  )
}
