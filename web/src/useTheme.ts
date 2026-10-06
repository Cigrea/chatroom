/**
 * 主题（亮色 / 暗色）的切换与持久化。
 *
 * 单独抽成一个组合式函数，和 useChat 并列：
 *   useChat  —— 管聊天（连接、消息）
 *   useTheme —— 管外观（亮色 / 暗色）
 *
 * 两者互不依赖。以后要再加"字体大小"之类的外观设置，另开一个函数就行，
 * 不会把任何一个改得越来越臃肿。
 */
import { ref, watchEffect } from 'vue'

/** 主题偏好存在 localStorage 里的 key */
const THEME_KEY = 'chatroom-theme'

export type Theme = 'light' | 'dark'

/**
 * 决定初始主题，两条规则：
 *   1. 本地存过用户明确的选择 → 用存的
 *   2. 没存过 → 跟随操作系统（prefers-color-scheme 媒体查询）
 *
 * 注意这里和 index.html 里那段内联脚本的逻辑必须保持一致，
 * 否则会出现"首帧按一种主题画、脚本跑起来又换成另一种"的闪烁。
 */
function resolveInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme() {
  const theme = ref<Theme>(resolveInitialTheme())

  /**
   * 把主题写到 <html> 的 data-theme 属性上。
   *
   * 组件样式里写的都是 var(--xxx)，而这些变量在
   * style.css 里按 [data-theme='light'] / [data-theme='dark'] 两套定义。
   * 所以这里改一个属性，整站的颜色就都换了，组件代码一行都不用动。
   *
   * 另外选 <html>（documentElement）而不是 body，是因为
   * 首帧渲染之前内联脚本就要能设上它——那时 body 还不存在。
   *
   * ★ 这里**只**改 DOM，不写 localStorage。
   *   如果在这里也持久化，那第一次访问就会把"跟随系统"的结果
   *   固化成明确偏好，以后用户改系统主题就再也不会跟着变了。
   *   持久化只应该发生在用户明确点按钮的时候（见 toggleTheme）。
   */
  watchEffect(() => {
    document.documentElement.dataset.theme = theme.value
  })

  /** 在亮色和暗色之间切换，并记住这次选择 */
  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    localStorage.setItem(THEME_KEY, theme.value)
  }

  return { theme, toggleTheme }
}
