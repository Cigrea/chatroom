import { createApp } from 'vue'
import App from './App.vue'

// 全局基础样式。放在组件样式之前引入，方便组件里的 scoped 样式覆盖它。
import './style.css'

createApp(App).mount('#app')
