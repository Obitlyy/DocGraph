import { useEffect, useRef, useState } from 'react'

export interface SegmentedItem<T extends string> {
  key: T
  label: React.ReactNode
}

interface Props<T extends string> {
  items: ReadonlyArray<SegmentedItem<T>>
  value: T
  onChange: (value: T) => void
  isDark: boolean
  /** 整体尺寸: sm 紧凑(顶栏小工具栏), md 默认(主导航) */
  size?: 'sm' | 'md' | 'lg'
  /** flex 布局：'auto' 按内容宽度，'equal' 等分占满父容器 */
  fill?: 'auto' | 'equal'
  className?: string
}

/**
 * 通用滑块/分段控件（segmented control）
 * - 用 absolute 定位的 thumb 实现滑动动画
 * - 通过测量按钮的 offsetLeft / offsetWidth 计算指示器位置
 */
export default function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  isDark,
  size = 'md',
  fill = 'auto',
  className = '',
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [thumb, setThumb] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  })

  // 计算 thumb 位置
  const updateThumb = () => {
    const btn = btnRefs.current[value]
    const wrap = containerRef.current
    if (!btn || !wrap) return
    const wrapRect = wrap.getBoundingClientRect()
    const btnRect = btn.getBoundingClientRect()
    setThumb({
      left: btnRect.left - wrapRect.left,
      width: btnRect.width,
      ready: true,
    })
  }

  useEffect(() => {
    updateThumb()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, items.length, size, fill])

  // 容器尺寸变化时重新计算（窗口 resize / 字体变化等）
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => updateThumb())
    ro.observe(containerRef.current)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 尺寸样式映射
  const padOuter = size === 'lg' ? 'p-1' : 'p-0.5'
  const radiusOuter = size === 'lg' ? 'rounded-2xl' : (size === 'sm' ? 'rounded-md' : 'rounded-lg')
  const radiusThumb = size === 'lg' ? 'rounded-xl' : (size === 'sm' ? 'rounded' : 'rounded-md')
  const padBtn = size === 'lg' ? 'px-7 py-2' : (size === 'sm' ? 'px-2.5 py-1' : 'px-4 py-1.5')
  const fontSize = size === 'lg' ? 'text-sm font-semibold' : (size === 'sm' ? 'text-[10px]' : 'text-sm')

  const wrapBg = isDark ? 'bg-white/10' : 'bg-black/5'
  const thumbBg = isDark ? 'bg-white/20' : 'bg-white shadow-sm'

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex ${padOuter} ${radiusOuter} ${wrapBg} ${className}`}
      style={{ isolation: 'isolate' }}
    >
      {/* 滑动指示器 */}
      <span
        aria-hidden
        className={`absolute top-0.5 bottom-0.5 ${radiusThumb} ${thumbBg}`}
        style={{
          left: thumb.left,
          width: thumb.width,
          opacity: thumb.ready ? 1 : 0,
          transition: thumb.ready
            ? 'left 360ms cubic-bezier(0.32, 0.72, 0, 1), width 360ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms ease'
            : 'opacity 200ms ease',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      {items.map(item => {
        const active = item.key === value
        const activeText = isDark ? 'text-white' : 'text-[#1D1D1F]'
        const inactiveText = isDark ? 'text-white/45 hover:text-white/70' : 'text-black/40 hover:text-black/60'
        return (
          <button
            key={item.key}
            ref={el => { btnRefs.current[item.key] = el }}
            onClick={() => onChange(item.key)}
            className={`${padBtn} ${radiusThumb} ${fontSize} font-medium relative z-10 transition-colors duration-200 ${
              fill === 'equal' ? 'flex-1' : ''
            } ${active ? activeText : inactiveText}`}
            style={{ background: 'transparent' }}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
