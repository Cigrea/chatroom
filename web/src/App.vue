<script setup lang="ts">
/**
 * 聊天室界面。
 *
 * 这个组件**只负责显示**：所有连接、重连、消息状态的逻辑都在 useChat.ts 里。
 * 想改网络行为去改那个文件，想改长相改这里。
 *
 * 也没有拆子组件——一个页面而已，拆开只会让答辩时多一个文件要解释。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useChat } from './useChat'

/**
 * 调一次 useChat，把里面的响应式变量解构出来。
 *
 * 这里有个 Vue 的规则值得记一下：
 *   useChat 返回的是一堆 ref（响应式引用），直接解构出来的是 ref 本身，
 *   但在**模板**里 Vue 会自动帮我们解包，所以模板里写 `nickname` 而不是 `nickname.value`；
 *   在 **script 里**就没有这个待遇，必须老老实实写 `.value`。
 *
 * 之所以不用 `const chat = useChat()` 再写 chat.nickname.value，
 * 是因为那样在模板里又长又容易看错，而解构是 Vue 的常见写法。
 */
const { nickname, joined, items, members, state, errorText, join, send } = useChat()

// 输入框里正在打的内容
const draft = ref('')

// 消息列表那个滚动容器的引用，用来滚到底部
const listEl = ref<HTMLElement | null>(null)

/** 连接状态对应的中文提示 */
const stateLabel = computed(() => {
  switch (state.value) {
    case 'connecting':
      return '连接中…'
    case 'open':
      return '已连接'
    case 'closed':
      return '已断开，正在重连…'
  }
})

/**
 * 把服务端的 RFC3339 时间串格式化成 HH:MM。
 *
 * 多一层 isNaN 判断是因为 createdAt 是从网络来的字符串，
 * 万一格式不对，toLocaleTimeString 会显示 "Invalid Date"，
 * 不如直接显示空字符串。
 */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 判断某条消息是不是自己发的（决定靠左还是靠右） */
function isMine(sender: string): boolean {
  return sender === nickname.value
}

/**
 * 提交发送。
 *
 * 挂在表单的 @submit 上，所以按回车和点按钮走的是同一条路径，
 * 不用单独监听 keydown——这是用 <form> 包住输入框的原因。
 */
function onSubmit(): void {
  if (send(draft.value)) {
    draft.value = ''
  }
}

/** 进入聊天室 */
function onJoin(): void {
  join()
}

/**
 * 自动滚到底部。
 *
 * 监听的是"列表条数"而不是整个数组：整个数组每次变化引用都会变，
 * 而条数只在真的有新消息时才变，触发更精确。
 *
 * 已知小问题：不管用户是不是正在往上翻历史，都会强制滚到底部。
 * 更好的做法是先判断"用户当前是否在底部附近"再决定要不要滚。
 * 这条写进了 README 的已知问题。
 */
watch(
  () => items.value.length,
  async () => {
    await nextTick() // 等 Vue 把新消息渲染进 DOM，否则滚动用的是旧高度
    if (listEl.value) {
      listEl.value.scrollTop = listEl.value.scrollHeight
    }
  },
)
</script>

<template>
  <!-- ============ 未进入：昵称输入 ============ -->
  <div v-if="!joined" class="gate">
    <div class="gate-card">
      <h1>轻量聊天室</h1>
      <p class="muted">输入一个昵称就可以开始。昵称会保存在本地，下次自动填上。</p>

      <!-- 用 form 包住，回车提交和点按钮走的是同一条路径 -->
      <form class="gate-form" @submit.prevent="onJoin">
        <input v-model="nickname" maxlength="20" placeholder="你的昵称" />
        <button type="submit">进入</button>
      </form>

      <p v-if="errorText" class="error">{{ errorText }}</p>
    </div>
  </div>

  <!-- ============ 已进入：聊天界面 ============ -->
  <div v-else class="app">
    <!-- 左侧：在线成员 -->
    <aside class="sidebar">
      <h2>在线成员</h2>
      <p class="muted small">{{ members.length }} 人在线</p>
      <ul class="member-list">
        <li v-for="name in members" :key="name" :class="{ me: name === nickname }">
          <span class="dot"></span>{{ name }}
          <span v-if="name === nickname" class="tag">我</span>
        </li>
      </ul>
    </aside>

    <!-- 右侧：消息区 -->
    <main class="chat">
      <header class="chat-head">
        <strong>大厅</strong>
        <span class="state" :class="state">
          <span class="dot"></span>{{ stateLabel }}
        </span>
      </header>

      <div ref="listEl" class="messages">
        <p v-if="items.length === 0" class="muted empty">还没有消息，说点什么吧。</p>

        <!--
          这里遍历的是 ChatItem（可辨识联合）。
          :key 要保证唯一：聊天消息用服务端 ID，系统提示用自增序号。
        -->
        <template
          v-for="item in items"
          :key="item.kind === 'chat' ? `m-${item.message.id}` : `s-${item.seq}`"
        >
          <!-- 系统提示：灰色居中一行 -->
          <p v-if="item.kind === 'system'" class="system">{{ item.text }}</p>

          <!-- 聊天消息：气泡 -->
          <div v-else class="row" :class="{ mine: isMine(item.message.sender) }">
            <div class="bubble">
              <div class="meta">
                <span class="sender">{{ item.message.sender }}</span>
                <span class="time">{{ formatTime(item.message.createdAt) }}</span>
              </div>
              <div class="content">{{ item.message.content }}</div>
            </div>
          </div>
        </template>
      </div>

      <p v-if="errorText" class="error bar">{{ errorText }}</p>

      <form class="composer" @submit.prevent="onSubmit">
        <input v-model="draft" maxlength="2000" placeholder="说点什么…（回车发送）" />
        <!-- 没连上服务器或输入为空时禁用发送 -->
        <button type="submit" :disabled="!draft.trim() || state !== 'open'">发送</button>
      </form>
    </main>
  </div>
</template>

<style scoped>
/* scoped 表示这些样式只作用于本组件，不会影响到别的地方。 */

.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  height: 100vh;
}

/* ---- 左侧成员栏 ---- */
.sidebar {
  background: #f7f9fb;
  border-right: 1px solid #e3e8ee;
  padding: 18px 16px;
  overflow-y: auto;
}
.sidebar h2 {
  font-size: 14px;
  margin: 0 0 4px;
}
.member-list {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
}
.member-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 14px;
}
.member-list li.me {
  font-weight: 600;
}
.tag {
  font-size: 11px;
  color: #5b6b7c;
  background: #e3e8ee;
  border-radius: 4px;
  padding: 1px 5px;
}

/* ---- 右侧聊天区 ---- */
.chat {
  display: flex;
  flex-direction: column;
  min-width: 0; /* 不加这行的话，长消息会把网格撑破 */
}
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid #e3e8ee;
}

/* 连接状态：小圆点 + 文字 */
.state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #8b98a5;
}
.state .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #8b98a5;
}
.state.open {
  color: #1a7f37;
}
.state.open .dot {
  background: #34c759;
}
.state.connecting {
  color: #9a6700;
}
.state.connecting .dot {
  background: #e3b341;
}
.state.closed {
  color: #b42318;
}
.state.closed .dot {
  background: #d93025;
}

/* ---- 消息列表 ---- */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 自己的消息靠右：flex 容器里给单个子元素 justify-content 就能推到最右 */
.row.mine {
  display: flex;
  justify-content: flex-end;
}
.bubble {
  max-width: 70%;
  background: #fff;
  border: 1px solid #e3e8ee;
  border-radius: 10px;
  padding: 8px 12px;
}
.row.mine .bubble {
  background: #e8f2ff;
  border-color: #cfe3ff;
}
.meta {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 3px;
}
.sender {
  font-size: 12px;
  font-weight: 600;
  color: #2b3a4a;
}
.time {
  font-size: 11px;
  color: #8b98a5;
}
.content {
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap; /* 保留用户输入的换行，同时自动折行 */
  word-break: break-word;
}
/* 系统提示 */
.system {
  text-align: center;
  font-size: 12px;
  color: #98a4b0;
  margin: 2px 0;
}

/* ---- 输入区 ---- */
.composer {
  display: flex;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid #e3e8ee;
}
.composer input {
  flex: 1;
}

/* ---- 昵称输入页 ---- */
.gate {
  display: grid;
  place-items: center;
  height: 100vh;
}
.gate-card {
  width: 340px;
  background: #fff;
  border: 1px solid #e3e8ee;
  border-radius: 14px;
  padding: 26px;
  box-shadow: 0 6px 24px rgba(20, 40, 60, 0.06);
}
.gate-card h1 {
  font-size: 20px;
  margin: 0 0 6px;
}
.gate-form {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.gate-form input {
  flex: 1;
}

/* ---- 通用 ---- */
.muted {
  color: #8b98a5;
}
.small {
  font-size: 12px;
}
.empty {
  text-align: center;
  margin-top: 40px;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34c759;
  flex: none;
}
.error {
  color: #d93025;
  font-size: 13px;
  margin: 8px 0 0;
}
.bar {
  margin: 0;
  padding: 8px 20px;
  background: #fdecea;
}
</style>
