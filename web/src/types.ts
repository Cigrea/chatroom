/**
 * 前后端之间的通讯协议。
 *
 * ★ 这里的类型必须和后端 server/model.go 里的结构体一一对应。
 *   后端字段名改了，这里也要跟着改，否则前端会静默地拿到 undefined
 *   （TypeScript 不会报错，因为运行时它管不着）。
 *
 * ★ 另一个必须记住的事实：TypeScript 的类型只在**编译期**存在，运行时会被完全擦掉。
 *   从 WebSocket 收到的 JSON 到底是什么形状，编译器一无所知——
 *   JSON.parse() 的返回值类型就是 any。
 *
 *   所以下面这些类型是"我和后端的约定"，不是"运行时会被检查的东西"。
 *   真正严谨的做法是再做一次运行时校验（比如用 zod），
 *   但这个项目里我们靠 `??` 兜底，加上前后端都是自己写的，够用了。
 */

/** 一条聊天消息，对应后端 model.Message */
export interface ChatMessage {
  /** 服务端分配的自增编号。前端用它做去重和"断线重连后要补哪些"的游标 */
  id: number
  /** 发送者昵称 */
  sender: string
  /** 消息正文 */
  content: string
  /** 服务端盖章的时间，RFC3339 字符串，例如 "2026-10-05T14:11:02.479+08:00" */
  createdAt: string
}

/** 服务端可能推来的消息类型 */
export type ServerEventType = 'history' | 'message' | 'members' | 'system' | 'error'

/**
 * 服务端推来的一条消息。
 *
 * 后端用的是"统一外壳 + type 字段"的格式：不同类型的 payload 放在不同字段里。
 *
 * 注意 `messages` 字段后端设成了**永远存在**（那是后端有意为之，见 model.go 的注释），
 * 所以别的类型推过来时它是 null。下面全部标成可选，读的时候一律用 `?? []` 兜底，
 * 这样不管后端怎么变都不会崩。
 */
export interface ServerEvent {
  type: ServerEventType
  /** type === 'message' 时有值 */
  message?: ChatMessage | null
  /** type === 'history' 时有值；其它类型是 null */
  messages?: ChatMessage[] | null
  /** type === 'members' 时有值 */
  members?: string[] | null
  /** type === 'system' / 'error' 时有值 */
  text?: string | null
}

/** 客户端发给服务端的消息 */
export interface ClientEvent {
  type: 'chat'
  content: string
}

/**
 * 连接状态，用来在界面上给用户提示。
 *
 * 定义成联合类型而不是随便一个 string，好处是写错单词编译器立刻报错，
 * 而且 switch 的时候 TypeScript 知道只有这三种可能。
 */
export type ConnectionState = 'connecting' | 'open' | 'closed'

/**
 * 消息列表里的一项。
 *
 * ★ 这是一个**可辨识联合**（discriminated union）：两个分支都带一个 kind 字段，
 *   TypeScript 只要判断了 kind，就自动知道该分支有哪些字段。
 *
 *   好处是聊天消息和系统提示能按**到达顺序**混在同一个列表里显示，
 *   而模板里访问 item.message 时不会报"这个字段可能不存在"。
 */
export type ChatItem =
  | { kind: 'chat'; message: ChatMessage }
  | { kind: 'system'; seq: number; text: string }
