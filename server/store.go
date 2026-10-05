package main

import "time"

// ============================================================
// 消息历史的存储
// ============================================================

// historyLimit 是内存里最多保留多少条历史消息。
//
// 内存实现不能无限增长，所以超出上限时丢掉最老的。
const historyLimit = 200

// Store 是消息历史的存储抽象（接口）。
//
// 本项目现在有两个实现，它们满足同一个接口：
//
//	MemoryStore  存在内存里（store.go）
//	SQLiteStore  存在数据库文件里（store_sqlite.go）
//
// Store 只会被 Hub 的 Run 那一个 goroutine 调用。
type Store interface {
	// Append 追加一条消息，返回带上了服务端 ID 和时间的副本。
	// ID 和时间都由服务端分配，调用方不需要关心。
	//
	// 内存实现里，Append 理应不会失败，但数据库会，所以也要加上 error
	Append(sender, content string) (Message, error)

	// Since 返回 ID 大于 afterID 的消息，按 ID 升序。
	//
	// 用 ID 而不是时间排序是因为时间有可能重复。
	Since(afterID int64, limit int) ([]Message, error)
}

// MemoryStore 是基于切片的内存实现。
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
//
// 它永远返回 nil 错误，因为没有 error 可供返回。
func (s *MemoryStore) Append(sender, content string) (Message, error) {
	s.nextID++

	msg := Message{
		ID:        s.nextID,
		Sender:    sender,
		Content:   content,
		CreatedAt: time.Now(), // 时间由服务端决定
	}
	s.messages = append(s.messages, msg)

	// 超过上限就砍掉最老的那些，防止内存无限增长。
	// 切片截取 s.messages[n:] 只是移动了起点，不会复制底层数组。
	// 被丢掉的部分会被 GC 清理掉。
	if len(s.messages) > historyLimit {
		s.messages = s.messages[len(s.messages)-historyLimit:]
	}

	return msg, nil
}

// Since 实现 Store 接口。
//
// 与 Append 一样永远返回 nil 错误。
func (s *MemoryStore) Since(afterID int64, limit int) ([]Message, error) {
	// 输入不合法采用默认值
	if limit <= 0 {
		limit = historyLimit
	}

	// ---- 新客户端：afterID 是 0，要给最近的 limit 条 ----
	if afterID <= 0 {
		start := 0
		if len(s.messages) > limit {
			start = len(s.messages) - limit // 只取尾部
		}

		// 复制一份再返回，而不是直接返回。
		// 因为切片本质指针，直接返回的话调用方看到的内容会随着后续 Append 变化，那就等于把内部状态泄露出去了。
		out := make([]Message, len(s.messages)-start)
		copy(out, s.messages[start:])
		return out, nil
	}

	// ---- 断线重连：只给 ID 大于 afterID 的 ----
	out := make([]Message, 0, 16)
	for _, m := range s.messages {
		if m.ID > afterID {
			out = append(out, m)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}
