package main

import "time"

// ============================================================
// 数据结构与通讯协议
//
// 这个文件定义"前后端之间说什么话"。改这里的任何字段名，
// 前端都必须跟着改，所以它相当于前后端之间的一份合同。
// ============================================================

// Message 是一条聊天消息。
//
// 它是整个项目的"共同语言"：服务端存它、序列化成 JSON 发给前端、
// 前端渲染出来的也是它。
type Message struct {
	// ID 是服务端分配的自增编号。前端拿它做两件事：
	//   1. 消息去重（防止"自己发的"和"轮询/推送回来的"重复上屏）
	//   2. 断线重连时告诉服务端"我手上最大的是多少"，只要更新的
	ID int64 `json:"id"`

	// Sender 是发送者的昵称。
	Sender string `json:"sender"`

	// Content 是消息正文。
	Content string `json:"content"`

	// CreatedAt 由服务端盖章，不接受前端传上来的时间。
	// 因为客户端时钟可能不准（快十分钟或慢十分钟），
	// 用它排序会导致消息顺序错乱——而这个错误在本地测试时永远复现不出来。
	CreatedAt time.Time `json:"createdAt"`
}

// 前后端约定的消息类型，放在 JSON 的 type 字段里。
//
// 用一个"统一外壳 + type 字段"的方式来区分消息种类，
// 而不是每种消息一个独立格式，好处是前端只需要写一处分发逻辑：
//
//	switch (msg.type) {
//	  case 'history': ...
//	  case 'message': ...
//	}
const (
	// ---------- 客户端 → 服务端 ----------

	// TypeChat：客户端发一条聊天消息。
	TypeChat = "chat"

	// ---------- 服务端 → 客户端 ----------

	// TypeMessage：一条新的聊天消息。
	TypeMessage = "message"

	// TypeHistory：连接建立时推送的历史消息（一个数组）。
	TypeHistory = "history"

	// TypeMembers：在线成员列表发生了变化（有人上来了或下去了）。
	TypeMembers = "members"

	// TypeSystem：系统提示，比如"小明 加入了聊天室"。
	TypeSystem = "system"

	// TypeError：服务端告诉客户端哪里不对。
	TypeError = "error"
)

// inbound 是客户端发过来的消息。
//
// 现在只有 chat 一种类型，但依然保留 type 字段——
// 以后要加"撤回消息""正在输入"这类新功能时，
// 只需要新增一个类型常量，协议本身不用动。
type inbound struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// outbound 是服务端发出去的消息。
//
// 用一个统一的外壳，里面放各种可选的 payload。
// 后面的 `omitempty` 表示"这个字段是空的时候就别出现在 JSON 里"，
// 这样报文不会带着一堆 null，前端调试时也干净。
type outbound struct {
	Type string `json:"type"` // 消息类型，见上面的常量

	// ★ Messages 故意**没有** omitempty，这是一个踩过的坑：
	//
	// omitempty 的语义是"零值就省略"，而长度为 0 的切片也算零值。
	// 所以历史上没有任何消息时，这个字段会被整个省略掉，
	// 前端收到的历史消息变成 {"type":"history"}，messages 是 undefined，
	// 一调 .map() 就崩。
	//
	// 去掉 omitempty 之后，这个字段永远存在：
	// 有消息时是 [...], 没消息时是 []。
	// 代价是别的消息类型里会多一个 "messages":null，无害。
	Messages []Message `json:"messages"`

	Message *Message `json:"message,omitempty"` // TypeMessage 用：单条消息
	Members []string `json:"members,omitempty"` // TypeMembers 用：在线昵称列表
	Text    string   `json:"text,omitempty"`    // TypeSystem / TypeError 用：一句提示
}
