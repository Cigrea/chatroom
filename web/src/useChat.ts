/**
 * 聊天室的前端逻辑，全部集中在这一个文件里。
 *
 * 它把"连接、重连、消息状态"这些和网络打交道的活都包了起来，
 * App.vue 只负责把返回的响应式变量渲染出来。
 *
 * 这是一个普通的函数（Vue 里叫**组合式函数** composable）：
 * 你在组件的 setup 里调它一次，它返回一堆响应式变量和方法。
 * 和"连接逻辑散落在组件的生命周期钩子里"相比，这样更容易读、也更容易讲清楚。
 *
 * 对应到后端：这份文件 ≈ client.go（连接生命周期），App.vue ≈ 界面层。
 */

import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ChatItem, ChatMessage, ClientEvent, ConnectionState, ServerEvent } from './types'

/** 昵称存在 localStorage 里的 key */
const NICKNAME_KEY = 'chatroom-nickname'

/** 重连延迟的起始值（毫秒）。第一次断开后等 1 秒就重试 */
const RECONNECT_BASE_DELAY = 1000

/**
 * 重连延迟的上限（毫秒）。
 *
 * 为什么要退避、为什么要设上限，见 scheduleReconnect 里的说明。
 */
const RECONNECT_MAX_DELAY = 10000

export function useChat() {
  // ============================================================
  // 响应式状态：这些一变，界面就会自动重绘
  // ============================================================

  /** 昵称。初始值从 localStorage 读，实现"下次打开自动填上" */
  const nickname = ref(localStorage.getItem(NICKNAME_KEY) ?? '')

  /** 是否已经进入聊天室（false 时显示昵称输入卡片） */
  const joined = ref(false)

  /** 消息列表（聊天消息 + 系统提示，按到达顺序混排） */
  const items = ref<ChatItem[]>([])

  /** 在线成员昵称列表 */
  const members = ref<string[]>([])

  /** 连接状态，用来在界面上显示提示 */
  const state = ref<ConnectionState>('connecting')

  /** 最近一次错误信息，用来在界面上显示一条红条 */
  const errorText = ref('')

  // ============================================================
  // 非响应式的内部变量：它们的变化不需要触发界面重绘
  // ============================================================

  /** 当前的 WebSocket 连接（还没连上或已断开时是 null） */
  let ws: WebSocket | null = null

  /** 重连定时器的 id，用来取消它 */
  let reconnectTimer: number | null = null

  /** 当前的重连延迟，每次失败后翻倍 */
  let reconnectDelay = RECONNECT_BASE_DELAY

  /** 系统提示的自增序号，只用来给模板提供唯一的 :key */
  let systemSeq = 0

  /** 是不是我们主动断开的（组件卸载时）。是的话就不再重连了 */
  let closedByUs = false

  // ============================================================
  // 计算属性
  // ============================================================

  /**
   * 本地已有的最大消息 ID，也就是下次重连时要带的 `since`。
   *
   * 这是"断线重连后消息还在"的**关键**：
   * 断线期间别人发的消息不会丢，重连时服务端按这个 ID 把新的补回来。
   *
   * 用循环取最大值而不是取数组最后一个，有两个原因：
   *   1. items 里混着系统提示，它们没有 id
   *   2. noUncheckedIndexedAccess 打开后 arr[i] 的类型是 T | undefined，
   *      写 arr[arr.length - 1]!.id 要加非空断言，不如循环干净
   */
  function currentLastId(): number {
    let max = 0
    for (const item of items.value) {
      if (item.kind === 'chat' && item.message.id > max) {
        max = item.message.id
      }
    }
    return max
  }

  // ============================================================
  // 消息处理
  // ============================================================

  /**
   * 把一批聊天消息追加进列表，按 id 去重。
   *
   * 为什么必须去重：服务端会推两类消息（history 和 message），
   * 而且"自己刚发的那条"是通过 message 类型回来的。
   * 极端情况下同一条可能来两次，不去重界面上就会出现两条一样的。
   */
  function appendMessages(incoming: ChatMessage[]): void {
    // 先收集已经存在的 id，避免每次都在整个数组里扫一遍
    const seen = new Set<number>()
    for (const item of items.value) {
      if (item.kind === 'chat') seen.add(item.message.id)
    }

    for (const message of incoming) {
      if (seen.has(message.id)) continue
      items.value.push({ kind: 'chat', message })
      seen.add(message.id)
    }
  }

  /** 追加一条系统提示 */
  function appendSystem(text: string): void {
    systemSeq += 1
    items.value.push({ kind: 'system', seq: systemSeq, text })
  }

  /**
   * 处理服务端推来的一条消息。
   *
   * switch 里的每个分支都对应协议里的一种 type，
   * 详见后端 server/model.go 里 Type* 常量的定义。
   */
  function handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'history':
        // 连接建立时推来的历史消息（首次是最近 100 条，重连时只补新的）
        appendMessages(event.messages ?? [])
        break

      case 'message':
        // 一条新的聊天消息
        if (event.message) appendMessages([event.message])
        break

      case 'members':
        // 在线成员列表有变化
        members.value = event.members ?? []
        break

      case 'system':
        // 服务端发的提示，比如"小明 加入了聊天室"
        if (event.text) appendSystem(event.text)
        break

      case 'error':
        errorText.value = event.text ?? '服务端返回了一个错误'
        break
    }
  }

  // ============================================================
  // 连接与重连
  // ============================================================

  /** 建立（或重建）WebSocket 连接 */
  function connect(): void {
    state.value = 'connecting'

    // ★ 用「当前页面的地址」拼 WebSocket 地址，而不是写死 localhost:8080。
    //
    // 这样同一份代码在两种环境下都能用：
    //   开发时  页面在 5173，vite 的 proxy 把 /ws 转发到后端的 8080
    //   上线时  前端打包后和后端同源部署，直接就是同一个 host
    //
    // 写死地址的话，一换环境就得改代码，而且很容易忘。
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url =
      `${protocol}//${location.host}/ws` +
      `?nickname=${encodeURIComponent(nickname.value)}` +
      `&since=${currentLastId()}`

    ws = new WebSocket(url)

    ws.onopen = () => {
      state.value = 'open'
      errorText.value = ''
      // 连上了就把重连延迟重置回起点，
      // 否则下次断开时会接着用上次退避到的大延迟。
      reconnectDelay = RECONNECT_BASE_DELAY
    }

    ws.onmessage = (ev: MessageEvent) => {
      let event: ServerEvent
      try {
        // JSON.parse 返回 any，这里断言成 ServerEvent。
        // 强调一遍：这是"我们相信后端会按约定发"，不是运行时校验。
        event = JSON.parse(ev.data as string) as ServerEvent
      } catch {
        // 收到非 JSON 数据不该让整个页面崩，记一笔跳过就行
        console.warn('[chat] 收到无法解析的数据:', ev.data)
        return
      }
      handleEvent(event)
    }

    // onerror 之后浏览器一定会紧跟着触发 onclose，
    // 所以这里不用做任何事——重连统一交给 onclose 处理，避免重复重连。
    ws.onerror = () => {
      /* 交给 onclose */
    }

    ws.onclose = () => {
      state.value = 'closed'
      scheduleReconnect()
    }
  }

  /**
   * 安排一次重连。
   *
   * ★ 这里用的是**指数退避**：每次失败后等待时间翻倍，上限 10 秒。
   *
   * 为什么不能固定每秒重试一次？因为那样会造成"重连风暴"：
   * 假设服务端刚崩，100 个客户端每 1 秒齐刷刷重连一次，
   * 服务端刚启动就被这波请求打垮，然后又崩，如此循环，永远起不来。
   *
   * 翻倍能让重试间隔逐渐拉开（1s → 2s → 4s → 8s → 10s → 10s…），
   * 给服务端留出恢复的时间。这是所有可靠客户端都会做的事。
   */
  function scheduleReconnect(): void {
    if (closedByUs) return

    reconnectTimer = window.setTimeout(() => {
      connect()
    }, reconnectDelay)

    // 注意：这里先安排、再翻倍。
    // 如果连上了，onopen 里会把它重置回起点。
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY)
  }

  /** 主动断开（组件卸载时用），并阻止后续重连 */
  function disconnect(): void {
    closedByUs = true

    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    ws?.close()
    ws = null
  }

  // ============================================================
  // 对外的方法
  // ============================================================

  /**
   * 用当前 nickname 里的昵称进入聊天室。
   * 昵称合法返回 true，否则返回 false（界面上会显示错误提示）。
   */
  function join(): boolean {
    const name = nickname.value.trim()
    if (!name) {
      errorText.value = '请先输入一个昵称'
      return false
    }

    nickname.value = name
    localStorage.setItem(NICKNAME_KEY, name)
    joined.value = true
    errorText.value = ''
    connect()
    return true
  }

  /**
   * 发一条消息。发送成功返回 true。
   *
   * 注意这里**不**把消息直接推进 items——而是等服务端把带 ID 和时间的版本推回来。
   * 这样做的好处是：本地显示的内容和重连后拉到的历史完全一致，
   * 也不会出现"本地一条、服务端一条"的重复。
   */
  function send(content: string): boolean {
    const text = content.trim()
    if (!text) return false

    // 连接没就绪时不要发，否则 ws.send 会抛异常
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      errorText.value = '还没连上服务器，稍等一下再发'
      return false
    }

    const event: ClientEvent = { type: 'chat', content: text }
    ws.send(JSON.stringify(event))
    return true
  }

  // ============================================================
  // 生命周期
  // ============================================================

  // 组件每次挂载时都保证 closedByUs 是 false
  // （热更新时组件会重新挂载，而模块级变量和 let 变量的值会被保留）。
  onMounted(() => {
    closedByUs = false
  })

  // 组件卸载（页面关闭、或热更新替换组件）时主动断开，
  // 否则重连定时器会一直跑，页面都关了还在尝试连接——这就是内存泄漏。
  onBeforeUnmount(disconnect)

  return {
    // 状态
    nickname,
    joined,
    items,
    members,
    state,
    errorText,
    // 方法
    join,
    send,
    disconnect,
  }
}
