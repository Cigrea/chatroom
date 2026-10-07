import { createApp } from 'vue'
import App from './App.vue'

// 全局基础样式。放在组件样式之前引入，方便组件里的 scoped 样式覆盖它。
import './style.css'

/*
 * 把"应用高度"同步成浏览器此刻真正可见的高度，写进 CSS 变量 --app-height。
 * App.vue 里 .app 用的是 height: var(--app-height, 100dvh)。
 *
 * ── 为什么光靠 CSS 的 100dvh 不够？ ──
 *
 * dvh 跟着的是"地址栏显示/隐藏"这种浏览器自己的 UI 变化，
 * **它并不保证跟手机软键盘联动**。微信内置浏览器就是典型：
 * 键盘弹出来时 dvh 一动不动，于是贴在底部的输入框正好被键盘盖住——
 * 也就是"输入法把消息挡住了"的那个现象。
 *
 * visualViewport.height 才是"用户此刻真正能看见的高度"，
 * 键盘弹出时它一定会变小，而且各浏览器行为一致（iOS Safari 上也是这个套路）。
 * 把它写进 --app-height，布局就会跟着缩：
 * 输入框永远贴在可见区域底部，消息列表在剩下的空间里自己滚。
 *
 * ── 为什么还要监听 scroll？ ──
 *
 * iOS 上键盘弹出时，整个页面会被顶上去，visualViewport 的 offsetTop 跟着变。
 * 不重算的话高度会算错，所以 resize 和 scroll 都听一遍。
 */
function syncAppHeight(): void {
  const vv = window.visualViewport
  const height = vv ? vv.height : window.innerHeight

  // 取整是为了避免出现 512.3999px 这种值，免得每帧都触发一次无意义的样式重算
  document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`)
}

syncAppHeight()

const viewport = window.visualViewport
if (viewport) {
  viewport.addEventListener('resize', syncAppHeight)
  viewport.addEventListener('scroll', syncAppHeight)
} else {
  // 很老的浏览器没有 visualViewport，退回监听窗口尺寸，至少比什么都不做强
  window.addEventListener('resize', syncAppHeight)
}

createApp(App).mount('#app')
