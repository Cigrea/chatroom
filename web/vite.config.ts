import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

/**
 * 后端地址。默认是本机开发用的 8080。
 *
 * 需要指到别的机器或别的端口时，用环境变量覆盖，不用改这个文件：
 *   $env:VITE_BACKEND="http://192.168.1.200:9000"; npm run dev
 */
const backend = process.env.VITE_BACKEND ?? 'http://127.0.0.1:8080'
const backendWs = backend.replace(/^http/, 'ws')

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
    // 开发时把请求转发给 Go 服务。
    //
    // 为什么需要它：浏览器有同源策略，前端在 5173、后端在 8080，
    // 端口不同就算跨域。加了这层代理之后，浏览器眼里前后端都在 5173，
    // 跨域问题从根上消失，前端代码里也不用手写后端地址。
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
      },
      // ★ WebSocket 也要代理。
      //   ws: true 这个选项千万不能漏——漏了的话握手会失败，
      //   而且浏览器只报一个很含糊的错误，很难定位。
      //
      // ★ 注意这里**没有** changeOrigin，也就是默认的 false：
      //   代理会原样保留浏览器发来的 Host 头（localhost:5173）。
      //   这正好让后端的同源检查通过——因为浏览器发的 Origin 也是
      //   http://localhost:5173，两者一致。
      //   如果这里改成 changeOrigin: true，Host 会被改写成后端地址，
      //   和后端收到的 Origin 对不上，握手就会被拒绝（403）。
      '/ws': {
        target: backendWs,
        ws: true,
      },
    },
  },
})
