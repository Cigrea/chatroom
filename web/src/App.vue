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
import { useTheme } from './useTheme'

/**
 * 调两个组合式函数，把里面的响应式变量解构出来。
 *
 * 这里有个 Vue 的规则值得记一下：
 *   它们返回的是一堆 ref（响应式引用），直接解构出来的是 ref 本身，
 *   但在**模板**里 Vue 会自动帮我们解包，所以模板里写 `nickname` 而不是 `nickname.value`；
 *   在 **script 里**就没有这个待遇，必须老老实实写 `.value`。
 *
 * 之所以不用 `const chat = useChat()` 再写 chat.nickname.value，
 * 是因为那样在模板里又长又容易看错，而解构是 Vue 的常见写法。
 */
const { nickname, joined, items, members, state, errorText, join, leaveChat, send } = useChat()

// 主题（亮色 / 暗色）
const { theme, toggleTheme } = useTheme()

// 输入框里正在打的内容
const draft = ref('')

// 消息列表那个滚动容器的引用，用来滚到底部
const listEl = ref<HTMLElement | null>(null)

/**
 * 窄屏时左侧成员栏是不是展开的。
 *
 * 桌面端这个值不起作用（侧栏常驻），只在窄屏的抽屉模式里有意义。
 *
 * 为什么必须做这个：220px 的侧栏在 375px 宽的手机上会吃掉一大半宽度，
 * 剩下的空间连输入框都放不下。指南里专门提醒过"列表能不能收起、输入框会不会被挤没"。
 */
const sidebarOpen = ref(false)

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

/** 主题按钮上显示的图标：当前是暗色就显示太阳（点了变亮） */
const themeIcon = computed(() => (theme.value === 'dark' ? '☀' : '☾'))

/** 主题按钮的提示文字 */
const themeLabel = computed(() => (theme.value === 'dark' ? '切换到亮色' : '切换到暗色'))

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

/** 切换昵称：顺手把窄屏的抽屉收起来，免得挡住输入框 */
function onLeave(): void {
  sidebarOpen.value = false
  leaveChat()
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

      <!-- 昵称输入页也给个主题开关：有人一进来就想用暗色 -->
      <button class="gate-theme" type="button" :title="themeLabel" @click="toggleTheme">
        {{ themeIcon }} {{ themeLabel }}
      </button>
    </div>
  </div>

  <!-- ============ 已进入：聊天界面 ============ -->
  <div v-else class="app">
    <!--
      窄屏抽屉的遮罩：只在抽屉打开时出现，点它关闭抽屉。
      桌面端 CSS 里是 display:none，完全不影响桌面布局。
    -->
    <div v-if="sidebarOpen" class="backdrop" @click="sidebarOpen = false"></div>

    <!-- 左侧：在线成员（窄屏时变成可收起的抽屉） -->
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <h2>在线成员</h2>
      <p class="muted small">{{ members.length }} 人在线</p>
      <ul class="member-list">
        <li v-for="name in members" :key="name" :class="{ me: name === nickname }">
          <span class="dot"></span>{{ name }}
          <span v-if="name === nickname" class="tag">我</span>
        </li>
      </ul>

      <!--
        为什么需要这个按钮：因为刷新后会自动进入聊天室，
        所以得有个出口才能换一个昵称进来（演示时要开两个窗口互相聊天）。
      -->
      <button class="leave-btn" type="button" @click="onLeave">切换昵称</button>
    </aside>

    <!-- 右侧：消息区 -->
    <main class="chat">
      <header class="chat-head">
        <div class="head-left">
          <!-- 只在窄屏显示：拉开成员列表抽屉 -->
          <button
            class="icon-btn menu-btn"
            type="button"
            aria-label="显示在线成员"
            @click="sidebarOpen = !sidebarOpen"
          >
            ☰
          </button>
          <strong>大厅</strong>
        </div>
        <div class="head-right">
          <span class="state" :class="state">
            <span class="dot"></span>{{ stateLabel }}
          </span>
          <button
            class="icon-btn"
            type="button"
            :title="themeLabel"
            :aria-label="themeLabel"
            @click="toggleTheme"
          >
            {{ themeIcon }}
          </button>
        </div>
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
/*
 * scoped 表示这些样式只作用于本组件，不会影响到别的地方。
 *
 * ★ 一条纪律：这里**不出现任何写死的颜色**，一律用 var(--xxx)。
 *   颜色定义都在全局 style.css 里，按亮色/暗色两套给出。
 *   所以这个文件不需要知道"暗色模式"的存在，它照样是暗的。
 */
.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  /*
   * 网格只有一行，高度正好是视口高度。
   *
   * ★ minmax(0, 1fr) 里的那个 0 是关键。
   *   网格行默认是 minmax(auto, 1fr)，而 auto 当最小值的意思是
   *   "这一行不能比它的内容更矮"——消息一多整行就被撑高，
   *   结果变成整个页面滚动，顶栏和输入框全被滚出屏幕。
   *   写成 minmax(0, 1fr) 才允许这一行被压到视口高度以内。
   *
   *   这是 min-height:0 在 grid 里的等价写法。
   */
  grid-template-rows: minmax(0, 1fr);
  /*
   * 高度用 dvh 而不是 vh。
   *
   * vh 在手机浏览器里等于"地址栏收起时"的高度，比实际可见区域高，
   * 结果页面底部的输入框会被顶到屏幕外——这正是指南里说的"输入框被挤没"。
   * dvh（dynamic viewport height）会跟着地址栏的显示/隐藏变化，是移动端的正解。
   *
   * 先写一行 vh 是给不认 dvh 的老浏览器兜底，认得的浏览器会用后一行覆盖它。
   */
  height: 100vh;
  height: 100dvh;
}

/* ---- 左侧成员栏 ---- */
.sidebar {
  /* 纵向 flex：成员列表在中间占满，标题在上面、按钮在下面 */
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  padding: 18px 16px;
  /*
   * ★ 这里是 hidden 而不是 auto：**侧栏自己不许滚动**。
   *
   *   滚动交给里面的 .member-list。如果让侧栏整体滚动，
   *   人多的时候"切换昵称"按钮就会被滚出可视区域，用户找不着。
   *   让侧栏本身不滚、列表自己滚，按钮才能永远钉在底部。
   */
  overflow: hidden;
}
.sidebar h2 {
  font-size: 14px;
  margin: 0 0 4px;
}
.member-list {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  /*
   * flex:1 让它吃掉剩余高度（从而把下面的按钮顶到底部），
   * min-height:0 让它**真的能被压缩**——
   * 不加的话它不肯比自己的内容矮，人数一多就把侧栏撑高，
   * 连"切换昵称"一起被推到可视区域之外。
   *
   * 加上 min-height:0 之后，超出的部分在列表自己内部滚动。
   */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
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
  color: var(--tag-text);
  background: var(--tag-bg);
  border-radius: 4px;
  padding: 1px 5px;
}
/* 切换昵称：低调的文字按钮，不跟在线列表抢注意力 */
.leave-btn {
  /* flex:none 保证它不参与伸缩，永远保持自己的高度待在底部 */
  flex: none;
  margin-top: 14px;
  padding: 8px;
  font-size: 13px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
}
.leave-btn:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

/* ---- 右侧聊天区 ---- */
.chat {
  display: flex;
  flex-direction: column;
  min-width: 0; /* 不加这行的话，长消息会把网格撑破 */
  /*
   * min-height:0 是给 flex 纵向布局用的，作用和上面的 min-width:0 对称：
   * 不加的话这个容器不肯比自己的内容矮，里面的消息列表就压不下去，
   * 于是整页被撑高、顶栏和输入框被滚走。
   */
  min-height: 0;
}
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}

/* 左上角：菜单按钮（只有窄屏才显示）+ 大厅标题 */
.head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 右上角：连接状态 + 主题按钮 */
.head-right {
  display: flex;
  align-items: center;
  gap: 14px;
}

/* 连接状态：小圆点 + 文字 */
.state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.state .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
}
.state.open {
  color: var(--ok-text);
}
.state.open .dot {
  background: var(--ok);
}
.state.connecting {
  color: var(--warn-text);
}
.state.connecting .dot {
  background: var(--warn);
}
.state.closed {
  color: var(--danger-text);
}
.state.closed .dot {
  background: var(--danger);
}

/* 主题切换：一个方形图标按钮 */
.icon-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.icon-btn:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

/* ---- 消息列表 ---- */
.messages {
  flex: 1;
  /*
   * ★★★ 这一行是"顶栏和输入框会不会被滚走"的关键。 ★★★
   *
   * flex 子项默认的 min-height 是 auto，含义是"我不肯缩到比自己的内容还矮"。
   * 于是消息一多，这个容器就跟着内容一起长高 →
   * 撑破 .chat → 撑破 .app → **滚动条跑到整个页面上去了**，
   * 顶栏和输入框都被滚出屏幕，用户在长对话里根本找不到输入框。
   *
   * 而且注意：下面那行 overflow-y:auto 在没加 min-height:0 时是**不生效的**——
   * 容器从来没被限制过高度，自然没什么可滚的，滚动全发生在 body 上。
   *
   * 改成 0 之后它才会被限制在剩余空间内，overflow-y:auto 才真正起作用
   * （滚动发生在它自己内部），顶栏和输入框就永远待在原位。
   *
   * 这和之前修输入框横向被挤用的 min-width:0 是同一类问题，
   * 只不过一个作用在横轴、一个作用在纵轴。
   */
  min-height: 0;
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
  background: var(--bg-bubble);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px;
}
.row.mine .bubble {
  background: var(--bg-bubble-mine);
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
  color: var(--text);
}
.time {
  font-size: 11px;
  color: var(--text-muted);
}
.content {
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap; /* 保留用户输入的换行 */
  /*
   * 一串没有空格的超长字符串（比如一条长链接）会把气泡撑破，
   * 甚至让整个页面出现横向滚动条——这就是指南里说的"字会不会溢出"。
   * overflow-wrap:anywhere 允许在任意位置断行。
   */
  overflow-wrap: anywhere;
}
/* 系统提示 */
.system {
  text-align: center;
  font-size: 12px;
  color: var(--text-faint);
  margin: 2px 0;
}

/* ---- 输入区 ---- */
.composer {
  display: flex;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  /*
   * 全面屏手机底部有一条手势横条，会盖住输入框。
   * env(safe-area-inset-bottom) 是系统给出的"安全区"高度，
   * 取它和 14px 里更大的那个当底部内边距。
   *
   * 注意这行必须写在 padding 简写**之后**才生效。
   * 另外它需要 index.html 的 viewport 里带 viewport-fit=cover，否则这个值恒为 0。
   */
  padding-bottom: max(14px, env(safe-area-inset-bottom));
}
.composer input {
  flex: 1;
  /*
   * ★ 这一行是修"输入框被截断"的关键。
   *
   * flex 子项默认的 min-width 是 auto，含义是"我不肯缩到比自己的最小内容宽度还窄"。
   * 而 input 的固有宽度大约相当于 20 个字符，所以在窄屏上它会撑破容器，
   * 把右边的发送按钮挤出可视区域——看起来就是"输入框被截断了"。
   * 改成 0 才允许它自由收缩。
   *
   * 这是 flexbox 最经典的溢出坑：flex:1 只决定"怎么长大"，不决定"能不能缩小"。
   */
  min-width: 0;
}

/* ---- 昵称输入页 ---- */
.gate {
  display: grid;
  place-items: center;
  height: 100vh;
  height: 100dvh; /* 同上：躲开手机地址栏，否则卡片会被顶偏 */
  padding: 20px; /* 窄屏时让卡片离屏幕边缘有点距离 */
}
.gate-card {
  /* 用 min() 让卡片在窄屏上自动缩窄，而不是固定 340px 顶出屏幕 */
  width: min(340px, 100%);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 26px;
  box-shadow: var(--shadow);
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
/* 昵称页底部的主题开关 */
.gate-theme {
  margin-top: 14px;
  padding: 0;
  font-size: 12px;
  color: var(--text-muted);
  background: transparent;
  border: none;
}
.gate-theme:hover {
  color: var(--text);
}

/* ---- 通用 ---- */
.muted {
  color: var(--text-muted);
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
  background: var(--ok);
  flex: none;
}
.error {
  color: var(--danger);
  font-size: 13px;
  margin: 8px 0 0;
}
.bar {
  margin: 0;
  padding: 8px 20px;
  background: var(--bg-danger);
}

/* ============================================================
   移动端适配
   ============================================================

   桌面端：左侧成员栏常驻 220px，右边是聊天区。
   窄屏：  成员栏变成抽屉，默认藏在屏幕外，由左上角 ☰ 按钮拉开。

   为什么必须做：220px 的侧栏在 375px 宽的手机上会吃掉一大半宽度，
   剩下的空间连输入框都放不下。
   指南里专门提醒过"列表能不能收起、输入框会不会被挤没、字会不会溢出"。

   断点选 768px：这是一般认为的"平板竖屏"宽度，
   也是绝大多数 CSS 框架的默认移动端断点，不需要自己发明一个。
   ============================================================ */

/* 菜单按钮和遮罩默认隐藏，只在窄屏出现 */
.menu-btn,
.backdrop {
  display: none;
}

@media (max-width: 768px) {
  /* 只剩一列：侧栏脱离文档流变成浮层，聊天区独占整个宽度 */
  .app {
    grid-template-columns: 1fr;
  }

  .menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* 侧栏：固定在屏幕左侧，默认整体滑出屏幕外 */
  .sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 20;
    width: 240px;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    box-shadow: var(--shadow);
  }
  /* 挂上 .open 就滑进来。用 transform 做动画而不是 left，
     因为 transform 由 GPU 合成，不会触发重排，手机上更顺。 */
  .sidebar.open {
    transform: translateX(0);
  }

  /* 遮罩：盖住聊天区，点一下关闭抽屉 */
  .backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 10;
    background: rgba(0, 0, 0, 0.45);
  }

  /* 触屏上按钮要够大手指才点得准，一般建议不小于 40px */
  .icon-btn {
    width: 40px;
    height: 40px;
    font-size: 18px;
  }

  /* 窄屏左右留白收窄，把空间让给正文 */
  .chat-head,
  .messages,
  .composer {
    padding-left: 12px;
    padding-right: 12px;
  }

  /* 气泡在窄屏上可以更宽，70% 显得太局促 */
  .bubble {
    max-width: 85%;
  }
}
</style>
