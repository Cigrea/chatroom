import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 开发时把请求转发给本地 Go 服务（8080）。
    //
    // 为什么需要它：浏览器有同源策略，前端在 5173、后端在 8080，
    // 端口不同就算跨域。加了这层代理之后，浏览器眼里前后端都在 5173，
    // 跨域问题从根上消失，前端代码里也不用手写后端地址。
    //
    // 后端那层 CORS 和 CheckOrigin 并没有白写——它们是给
    // "前端打包后部署到别的域名"准备的，那时没有 vite 代理，只能靠响应头放行。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      // ★ WebSocket 也要代理。
      //   ws: true 这个选项千万不能漏——漏了的话握手会失败，
      //   而且浏览器只报一个很含糊的错误，很难定位。
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
      },
    },
  },
})
