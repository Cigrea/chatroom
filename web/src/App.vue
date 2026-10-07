<script setup lang="ts">
/**
 * 聊天室界面。
 *
 * 这个组件**只负责显示**：所有连接、重连、消息状态的逻辑都在 useChat.ts 里。
 * 想改网络行为去改那个文件，想改长相改这里。
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

/** 昵称配色的数量，和 style.css 里 --name-1 ~ --name-8 对应 */
const NAME_COLOR_COUNT = 8

/**
 * 按昵称算出一个稳定的颜色，用来给气泡左上角的昵称上色。
 *
 * 为什么需要它：一个聊天室里有好几个人时，光看昵称文字很难一眼分清谁是谁，
 * 上了色之后扫一眼就能区分。
 *
 * 两条规则：
 *   1. **同一个昵称永远得到同一个颜色。** 靠的是"哈希"——
 *      把昵称的每个字符揉成一个数，只要昵称不变，算出来的数就不变，
 *      所以刷新页面、断线重连之后颜色都还是那个。
 *   2. 不同昵称尽量落到不同颜色上。
 *
 * 注意这里返回的是 `var(--name-N)` 而不是具体色值。
 * 因为亮色和暗色需要不同深浅的同一色相，把"具体是什么颜色"交给 CSS 变量决定，
 * 换主题时名字颜色会自动跟着变，这个函数完全不用知道当前是亮还是暗。
 */
function nameColor(sender: string): string {
  /*
   * 第一步：FNV-1a 哈希，把昵称揉成一个 32 位整数。
   *
   * 乘数 16777619 和初值 2166136261 是 FNV-1a 的标准参数，
   * 它比"hash * 31 + 字符"那种写法分散得更均匀。
   * Math.imul 是 32 位整数乘法（普通 * 会在超过 2^53 后丢精度）。
   */
  let hash = 2166136261
  for (let i = 0; i < sender.length; i++) {
    hash ^= sender.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }

  /*
   * 第二步：雪崩混洗（murmur3 的收尾步骤）。
   *
   * ★ 这一步不能省，而且是有原因的：
   *
   *   哈希的最后往往要"对颜色数量取余"，而**取余只看低位**。
   *   可是上面算出来的低位，主要由输入的最后几个字符决定——
   *   昵称都是"某某"这种两三个汉字时，低位的变化范围很窄，
   *   结果就是好几个人撞到同一个颜色上。
   *
   *   （改之前实测：5 个昵称只用到 2 种颜色，3 个人同色。）
   *
   *   这几次"异或 + 乘法"的作用是让**输入的每一位都影响到输出的低位**，
   *   也就是所谓雪崩效应：输入改一个字符，整个哈希看起来完全不同。
   *
   * ★★ 每一行末尾的 `>>> 0` 不是可有可无的：
   *
   *   JavaScript 的位运算（`^`、`<<`、`>>`）操作的是**带符号** 32 位整数，
   *   结果可能是负数。而负数取余也是负数，比如 -3 % 8 = -3，
   *   于是会拼出 `var(--name--3)` 这种根本不存在的变量名，
   *   颜色就回落到兜底值——表现出来就是"好几个人的名字都是灰的"。
   *
   *   `>>> 0` 是无符号右移 0 位，作用是把它转回 0 ~ 2^32-1 的无符号整数。
   */
  hash = (hash ^ (hash >>> 16)) >>> 0
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash = (hash ^ (hash >>> 13)) >>> 0
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0
  hash = (hash ^ (hash >>> 16)) >>> 0

  return `var(--name-${(hash % NAME_COLOR_COUNT) + 1})`
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
 * 判定"已经滚到底部"的容差（像素）。
 *
 * 留一点余量而不是要求"完全到底"：用户滚动有惯性，差几个像素就判定成
 * "离开了底部"的话，正常看消息也会不停弹提示。
 */
const NEAR_BOTTOM_PX = 60

/** 用户现在是不是在消息区底部附近 */
const isNearBottom = ref(true)

/**
 * 未读消息的起点：它在 items 数组里的下标。
 *
 * null 表示"没有未读"。有新消息而用户又不在底部时，把它记成"来新消息之前
 * 的条数"，也就是第一条新消息的下标。
 */
const unreadAnchor = ref<number | null>(null)

/** 未读条数 = 总条数 - 未读起点 */
const unreadCount = computed(() =>
  unreadAnchor.value === null ? 0 : Math.max(0, items.value.length - unreadAnchor.value),
)

/** 滚到底部 */
function scrollToBottom(smooth = false): void {
  const el = listEl.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

/**
 * 用户滚动时更新"是否在底部"。
 *
 * 如果用户自己滚回底部了，新消息提示就该消失——因为已经看到了。
 */
function onMessagesScroll(): void {
  const el = listEl.value
  if (!el) return

  // 距离底部还有多少像素
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  isNearBottom.value = distance <= NEAR_BOTTOM_PX

  if (isNearBottom.value) unreadAnchor.value = null
}

/** 跳到第一条新消息 */
function jumpToFirstUnread(): void {
  if (unreadAnchor.value === null) return

  // 模板上给"第一条未读"那个元素打了 data-unread-anchor 标记，
  // 所以这里直接按属性找它，不用自己维护一堆元素引用。
  const target = listEl.value?.querySelector<HTMLElement>('[data-unread-anchor]')
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' })

  // 立刻清掉提示。滚动结束后 onMessagesScroll 会重新判断位置，
  // 如果跳过去之后又不在底部了，来新消息会重新记一次起点。
  unreadAnchor.value = null
}

/**
 * 有新消息时的滚动策略。
 *
 * ★ 不再"一律滚到底"，而是分两种情况：
 *
 *   - 用户本来就在底部 → 照常滚到底（最常见的场景，不用打断）
 *   - 用户正在往上翻历史 → **不打断他**，只在右下角弹出"N 条新消息"，
 *     由用户自己决定什么时候跳过去
 *
 * 这是聊天软件的通行做法：强行把用户从正在看的地方拽走是很糟糕的体验。
 *
 * 监听"列表条数"而不是整个数组，是因为整个数组每次变化引用都会变，
 * 而条数只在真的有新消息时才变，触发更精确。
 */
watch(
  () => items.value.length,
  async (newLen, oldLen) => {
    const before = oldLen ?? 0
    const added = newLen - before
    if (added <= 0) return

    await nextTick() // 等 Vue 把新消息渲染进 DOM，否则算出来的高度是旧的

    if (isNearBottom.value) {
      scrollToBottom()
      unreadAnchor.value = null
    } else if (unreadAnchor.value === null) {
      // 只在第一次离开底部时记录起点，之后来的消息都算同一批未读
      unreadAnchor.value = before
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

      <!-- @scroll 用来随时判断用户有没有滚到底部 -->
      <div ref="listEl" class="messages" @scroll.passive="onMessagesScroll">
        <p v-if="items.length === 0" class="muted empty">还没有消息，说点什么吧。</p>

        <!--
          这里遍历的是 ChatItem（可辨识联合）。
          :key 要保证唯一：聊天消息用服务端 ID，系统提示用自增序号。
        -->
        <template
          v-for="(item, index) in items"
          :key="item.kind === 'chat' ? `m-${item.message.id}` : `s-${item.seq}`"
        >
          <!--
            系统提示：灰色居中一行。
            注意 data-unread-anchor：只有"第一条未读"那个元素会带上这个属性，
            点"新消息"提示时按它找到目标，滚过去。
          -->
          <p
            v-if="item.kind === 'system'"
            class="system"
            :data-unread-anchor="index === unreadAnchor ? '' : undefined"
          >
            {{ item.text }}
          </p>

          <!-- 聊天消息：气泡 -->
          <div
            v-else
            class="row"
            :class="{ mine: isMine(item.message.sender) }"
            :data-unread-anchor="index === unreadAnchor ? '' : undefined"
          >
            <div class="bubble">
              <!-- 昵称在最上面一行，按昵称哈希上色，方便区分不同的人 -->
              <div class="sender" :style="{ color: nameColor(item.message.sender) }">
                {{ item.message.sender }}
              </div>

              <!--
                正文 + 时间。

                时间**故意**写在正文里面、紧跟正文之后，而不是单独一个 div。
                因为 CSS 的 float 是「放在它出现的位置所在的那一行」——
                写在正文后面，它就会贴在**最后一行**的右端；
                如果单独占一行，那就变成"在文本下一行"了（那是上一版的写法）。
              -->
              <div class="content">
                <span class="text">{{ item.message.content }}</span>
                <span class="time">{{ formatTime(item.message.createdAt) }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <p v-if="errorText" class="error bar">{{ errorText }}</p>

      <!--
        输入区外面包一层，是为了给"新消息"提示当定位基准。
        提示用 position:absolute + bottom:100% 贴在输入区正上方，
        这样不用去硬编码输入框的高度——它变高变矮（比如手机上多了安全区留白），
        提示都会自己跟着走。
      -->
      <div class="composer-area">
        <!--
          有新消息、而且用户没在底部时才出现。
          点一下跳到第一条新消息，而不是直接跳到最后——这样用户能从"开始没看到的地方"接着看。
        -->
        <button
          v-if="unreadCount > 0"
          class="new-msg-hint"
          type="button"
          @click="jumpToFirstUnread"
        >
          {{ unreadCount }} 条新消息
          <span class="arrow">↓</span>
        </button>

        <form class="composer" @submit.prevent="onSubmit">
          <input v-model="draft" maxlength="2000" placeholder="说点什么…" />
          <!-- 没连上服务器或输入为空时禁用发送 -->
          <button type="submit" :disabled="!draft.trim() || state !== 'open'">发送</button>
        </form>
      </div>
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
/*
 * 侧栏标题「在线成员」。
 *
 * h2 默认就是粗体，但 14px 太小、在侧栏里看着像普通文字。
 * 调到 15px + 明确写 700 字重，让它一眼看上去就是个"区块标题"。
 */
.sidebar h2 {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.2px;
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
  border-radius: var(--radius-sm);
  padding: 1px 6px;
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
  border-radius: var(--radius-md);
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

/*
 * 大厅标题「大厅」。
 *
 * 它是用 <strong> 包着的，默认就是粗体，但字号继承自 body（16px），
 * 放在顶栏里不够像"标题"。这里调大到 18px 并把字重写实，
 * 让它和下面的消息正文明显区分开。
 */
.chat-head strong {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.2px;
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
  border-radius: var(--radius-md);
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
/*
 * 每一行消息。
 *
 * ★ 这里**两个**状态都必须是 flex，不能只给 .mine 加。
 *
 *   气泡要"跟着文字长短自适应宽度"，前提是它得是一个 flex 子项——
 *   flex 子项的宽度默认是 fit-content（收缩到内容宽度，再被 max-width 夹住）。
 *
 *   如果 .row 是普通块级元素，里面的 .bubble 就是块级 div，宽度 auto
 *   会直接撑满整行（最后顶到 max-width:70%），
 *   于是不管发言多短，气泡都是一样宽——这就是之前那个 bug。
 */
.row {
  display: flex;
}

/* 自己的消息靠右（默认是 flex-start，也就是靠左） */
.row.mine {
  justify-content: flex-end;
}
.bubble {
  max-width: 70%;
  background: var(--bg-bubble);
  /*
   * 用专门的气泡描边色，而不是通用的 --border。
   * 因为气泡需要比普通分隔线更"实"一点的描边，
   * 才能和页面背景拉开区分度；而 --border 是给顶栏底栏那些细线用的。
   */
  border: 1px solid var(--border-bubble);
  /*
   * 气泡用最大的那档圆角。
   * 这里走变量而不是写死数值，是为了「整体再圆一点」时只改 style.css 一处。
   */
  border-radius: var(--radius-lg);
  /* 上下留白对称，因为时间已经并进正文那一行了，不再是独立的一行 */
  padding: 9px 14px;
}
.row.mine .bubble {
  background: var(--bg-bubble-mine);
}

/*
 * 昵称：气泡里的第一行，小一号、加粗。
 *
 * 颜色不在这里写死——模板上绑定了 :style="{ color: nameColor(...) }"，
 * 按昵称哈希出一个 --name-N 变量。
 * 下面这行只是兜底：万一样式绑定没生效，也不会变成难看的默认黑色。
 */
.sender {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-sender);
  margin-bottom: 2px;
}

/*
 * 正文容器。
 *
 * 行高写成**固定的 21px**（= 14px × 1.5），而不是 line-height: 1.5。
 * 因为下面那个浮动的时间要"和正文最后一行处在同一个行盒里"，
 * 它必须用一个**可比较的**行高值。写死一个像素值，
 * 时间那边就能写同样一个值，两边的行盒高度一致，基线自然对齐。
 */
.content {
  font-size: 14px;
  line-height: 21px;
}

/* 真正的消息文本 */
.text {
  white-space: pre-wrap; /* 保留用户输入的换行 */
  /*
   * 一串没有空格的超长字符串（比如一条长链接）会把气泡撑破，
   * 甚至让整个页面出现横向滚动条——这就是指南里说的"字会不会溢出"。
   * overflow-wrap:anywhere 允许在任意位置断行。
   */
  overflow-wrap: anywhere;
}

/*
 * 时间。
 *
 * ★ 用 float:right，而不是 text-align:right。
 *
 *   关键在**它写在正文后面**（见模板）：块级元素上的 float 会"浮在
 *   它出现位置所在的那一行"，所以它会贴在**正文最后一行的右端**，
 *   而不是另起一行——这正是"和文本下部对齐"的效果。
 *
 *   如果把它写成独立的 div（上一版的做法），它就必然占一整行，
 *   看起来就是"时间在文本下一行"。
 *
 *   line-height 和上面 .content 保持一致，是为了让它和正文处在同一个
 *   行盒里、基线对齐；不然它会贴到行盒顶部，比正文偏高。
 *
 *   字号比正文更小、颜色更淡——它属于"元信息"，不该跟正文抢注意力。
 */
.time {
  float: right;
  margin-left: 12px;
  font-size: 11px;
  line-height: 21px;
  color: var(--text-muted);
  /* 不让时间被拆成两行（比如 "12:34" 断成 "12:" 和 "34"） */
  white-space: nowrap;
}
/* 系统提示 */
.system {
  text-align: center;
  font-size: 12px;
  color: var(--text-faint);
  margin: 2px 0;
}

/* ---- 输入区 ---- */

/*
 * 输入区外面这层只是用来给"新消息"提示当定位基准。
 * position:relative 之后，提示就可以用 absolute + bottom:100% 贴在它正上方，
 * 不用去硬编码输入框的高度。
 */
.composer-area {
  position: relative;
}

/*
 * "N 条新消息"提示。
 *
 * 定位技巧：bottom:100% 表示"我的底边贴到父元素的上边"，
 * 于是它永远悬在输入区正上方。再配一个 margin-bottom 留点间距。
 * 这样输入框因为安全区、字号、换行变高变矮时，提示都会自己跟着走。
 */
.new-msg-hint {
  position: absolute;
  left: 50%;
  /* left:50% 把它推到水平中线，再往回挪自身宽度的一半才是真正居中 */
  transform: translateX(-50%);
  bottom: 100%;
  margin-bottom: 10px;
  z-index: 5;

  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;

  font-size: 13px;
  /* 药丸形：两端是半圆 */
  border-radius: var(--radius-pill);
  color: var(--accent-fg);
  background: var(--accent);
  /* 悬浮在消息上方，加一层阴影才能和下面的内容分开 */
  box-shadow: 0 4px 14px rgba(20, 40, 60, 0.25);
  /* 不让"12 条新消息 ↓"被拆成两行 */
  white-space: nowrap;
  cursor: pointer;
}

.new-msg-hint:hover {
  /* 用 filter 提亮，比再定义一个 hover 色变量省事 */
  filter: brightness(1.08);
}

/* 那个向下的小箭头 */
.new-msg-hint .arrow {
  font-size: 12px;
  line-height: 1;
}

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
  border-radius: var(--radius-lg);
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
