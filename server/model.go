package main

import "time"

// ============================================================
// 数据结构与通讯协议
// ============================================================

// Message 是一条聊天消息。
type Message struct {
	// ID 是服务端分配的自增编号，前端拿它做两件事：
	ID int64 `json:"id"`

	// Sender 是发送者的昵称。
	Sender string `json:"sender"`

	// Content 是消息正文。
	Content string `json:"content"`

	// CreatedAt 是消息发送的时间，由服务端决定。
	CreatedAt time.Time `json:"createdAt"`
}

// 前后端约定的消息类型，放在 JSON 的 type 字段里。
const (
	// ---- 客户端 -> 服务端 ----

	// TypeChat：客户端发一条聊天消息。
	TypeChat = "chat"

	// ---- 服务端 -> 客户端 ----

	// TypeMessage：一条新的聊天消息。
	TypeMessage = "message"

	// TypeHistory：连接建立时推送的历史消息。
	TypeHistory = "history"

	// TypeMembers：在线成员列表发生了变化。
	TypeMembers = "members"

	// TypeSystem：系统提示。
	TypeSystem = "system"

	// TypeError：服务端告诉客户端哪里不对。
	TypeError = "error"
)

// inbound 是客户端发过来的消息。
//
// 目前只有 chat 一种类型。
type inbound struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// outbound 是服务端发出去的消息。
type outbound struct {
	// 消息类型，见上面的常量
	Type string `json:"type"`

	// 历史消息记录，TypeHistory 使用
	//
	// 这里没有用 omitempty，因为 omitempty 的语义是"零值就省略"，而长度为 0 的切片也算零值，
	// 所以历史上没有任何消息时，这个字段会被整个省略掉，
	// 前端收到的历史消息变成 {"type":"history"}，messages 是 undefined，一调 .map() 就崩。
	Messages []Message `json:"messages"`

	// 单条消息，TypeMessage 使用。
	//
	// 这里必须用指针，因为 omitempty 并不会把任何结构体值当作空值，
	// 就算里面什么也没有，omitempty 照样会把它序列化出去，
	// 导致发其它类型的信息时附带一个无用的 Message
	Message *Message `json:"message,omitempty"`

	// 在线昵称列表，TypeMembers 使用
	Members []string `json:"members,omitempty"`

	// 一句提示，TypeSystem/TypeError 使用
	Text string `json:"text,omitempty"`
}
