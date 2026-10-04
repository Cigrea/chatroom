package main

import "time"

// ============================================================
// 消息历史的存储
// ============================================================

// historyLimit 是内存里最多保留多少条历史消息。
//
// 内存实现不能无限增长，而聊天室本来也只关心"最近发生了什么"。
// 超出上限时丢掉最老的。
const historyLimit = 200

// Store 是消息历史的存储抽象。
//
// 定义成接口，是为了让"消息存在哪里"变成可以替换的细节：
// 现在是内存实现，以后换成 SQLite 时，只要新写一个满足这个接口的类型，
// Hub 和 HTTP 层一行都不用改。
//
// ★ 重要：本项目的 Store 只会被 Hub 的 Run 那一个 goroutine 调用。
//
// 所以实现里**不需要任何锁**。这不是偷懒，而是整个项目设计的延伸：
// 我们不让多个 goroutine 共享这份数据，而是让唯一有权的那个 goroutine
// 独占它、别人通过 channel 找它办事——不共享，自然就不用锁。
//
// 如果你以后要在这里加一个"从 HTTP 处理函数直接查历史"的方法，
// 那就会打破这个前提，必须重新考虑加锁（或者像 api.go 里那样，
// 把查询请求发给 Hub 去执行）。
type Store interface {
	// Append 追加一条消息，返回带上了服务端 ID 和时间的副本。
	// 注意是由实现来分配 ID 和时间，调用方不需要关心。
	Append(sender, content string) Message

	// Since 返回 ID 大于 afterID 的消息，按 ID 升序。
	//
	// afterID 传 0 表示"给我最近的 limit 条"——新客户端刚连上时要的。
	// afterID 大于 0 表示"给我比它新的"——断线重连时要的，避免重传整个历史。
	//
	// 为什么用 ID 而不是时间戳当游标？因为同一毫秒可能产生两条消息，
	// 时间戳会重复；而自增 ID 严格递增，不会漏也不会重。
	Since(afterID int64, limit int) []Message
}

// MemoryStore 是基于切片的内存实现。
//
// 它的数据活在进程内存里：**服务端一重启就全没了**。
// 这满足了题目"刷新页面或断线重连后消息还在"的要求（只要服务没重启），
// 但"重启丢失"是已知限制，要在 README 的已知问题里如实写明。
type MemoryStore struct {
	// nextID 是下一个要分配的编号。从 1 开始递增。
	nextID int64

	// messages 按 ID 升序保存所有历史消息。
	messages []Message
}

// NewMemoryStore 创建一个空的内存存储。
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

// Append 实现 Store 接口。
func (s *MemoryStore) Append(sender, content string) Message {
	s.nextID++

	msg := Message{
		ID:        s.nextID,
		Sender:    sender,
		Content:   content,
		CreatedAt: time.Now(), // 时间由服务端盖章
	}
	s.messages = append(s.messages, msg)

	// 超过上限就砍掉最老的那些，防止内存无限增长。
	// 切片截取 s.messages[n:] 只是移动了起点，不会复制底层数组；
	// 被丢掉的部分会被垃圾回收掉。
	if len(s.messages) > historyLimit {
		s.messages = s.messages[len(s.messages)-historyLimit:]
	}

	return msg
}

// Since 实现 Store 接口。
func (s *MemoryStore) Since(afterID int64, limit int) []Message {
	if limit <= 0 {
		limit = historyLimit
	}

	// ---- 情况一：新客户端，afterID 是 0，要给最近的 limit 条 ----
	if afterID <= 0 {
		start := 0
		if len(s.messages) > limit {
			start = len(s.messages) - limit // 只取尾部
		}

		// 复制一份再返回，而不是直接返回 s.messages[start:]。
		// 因为切片共享底层数组，直接返回的话调用方看到的内容会随着后续 Append 变化，
		// 那就等于把内部状态泄露出去了。
		out := make([]Message, len(s.messages)-start)
		copy(out, s.messages[start:])
		return out
	}

	// ---- 情况二：断线重连，只给 ID 大于 afterID 的 ----
	out := make([]Message, 0, 16)
	for _, m := range s.messages {
		if m.ID > afterID {
			out = append(out, m)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}
