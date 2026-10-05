package main

import (
	"encoding/json"
	"log"
	"sort"
)

// ============================================================
// Hub：聊天室的中枢
// ============================================================

// map[*Client]bool 和 store 都只被 Run 这一个 goroutine 读写。
// Run 里的 select 保证同时只有一处在读写上面两个数据
//
// 其它 goroutine 想影响它们时，
// 都要把请求发到下面的 channel 上，由 Run 排队串行处理。
//
// 正如 Go 的那句谚语：
//
//	不要通过共享内存来通讯，而要通过通讯来共享内存。
//	(Do not communicate by sharing memory; instead, share memory by communicating.)
//
// 对比之前用互斥锁的版本，完全不用反复权衡锁的范围，不会死锁，也没有竞态
type Hub struct {
	// 用 map[*Client]bool 是惯例写法，符合“集合”数据唯一的特性，查询也快
	clients map[*Client]bool

	// store 是消息历史。
	store Store

	// ---------- 下面四个是外部 goroutine 用来"请求 Run 干活"的通道 ----------
	// 它们都是无缓冲的：发送方会一直阻塞到 Run 收到为止。
	// 这是一种天然的背压机制——Run 忙不过来时，外面的请求会自动排队等待。

	// register 负责新连接建立时请求加入在线列表。
	register chan *Client

	// unregister 负责有连接断开时请求移出在线列表。
	unregister chan *Client

	// chat 负责处理客户端的消息，存历史并广播出去。
	chat chan chatRequest

	// HTTP 接口要查历史消息。
	// 它自带一个 reply 通道，Run 处理完把结果塞回去—，
	// 这样查询逻辑依然只在 Run 里执行。
	historyQuery chan historyRequest
}

// chatRequest 处理客户端发送的消息
type chatRequest struct {
	client  *Client
	content string
}

// historyRequest 查询历史消息并返回
type historyRequest struct {
	afterID int64          // 只要 ID 大于它的
	limit   int            // 最多几条
	reply   chan []Message // 结果从这里送回去
}

// NewHub 创建 Hub 并初始化所有字段。
func NewHub(store Store) *Hub {
	return &Hub{
		clients:      make(map[*Client]bool),
		store:        store,
		register:     make(chan *Client),
		unregister:   make(chan *Client),
		chat:         make(chan chatRequest),
		historyQuery: make(chan historyRequest),
	}
}

// ============================================================
// Run —— 主循环
// ============================================================

// Run 是 Hub 的主循环，也是整个服务端唯一有权改动共享状态的地方。
//
// 它会永远阻塞在这个 for + select 里，等待四类事件中的任意一个发生，
// 然后串行地处理它。因为它一次只处理一件事，所以不需要锁。
func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.addClient(c)

		case c := <-h.unregister:
			h.removeClient(c)

		case req := <-h.chat:
			h.handleChat(req)

		case req := <-h.historyQuery:
			// 直接查 store 并把结果送回去。
			// reply 通道有 1 个缓冲，所以这里不会阻塞——
			// 万一查询方已经超时走人了，也能立刻脱身。
			req.reply <- h.store.Since(req.afterID, req.limit)
		}
	}
}

// 下面这些方法都只被 Run 调用，所以它们可以随意读写 h.clients 和 h.store，不需要任何同步措施。

// addClient 处理新连接。
func (h *Hub) addClient(c *Client) {
	h.clients[c] = true

	// ---- 推送历史消息 ----

	// 历史是一条消息（里面装一个数组），只占用 send 队列的一个位置。
	// 在刷新、断线重连的情况下，只推送since之后的消息，相当于更新
	history := h.store.Since(c.since, historyPushLimit)

	// 序列化再交给 send。
	if payload, err := json.Marshal(outbound{Type: TypeHistory, Messages: history}); err != nil {
		log.Println("序列化历史消息失败:", err)
	} else {
		h.send(c, payload)
	}

	// ---- 告诉所有人现在谁在线 ----
	h.broadcast(outbound{Type: TypeMembers, Members: h.nicknames()})

	// ---- 广播上线提示 ----
	h.broadcast(outbound{Type: TypeSystem, Text: c.nickname + " 加入了聊天室"})

	log.Printf("用户 %s 已连接，当前在线 %d 人", c.nickname, len(h.clients))
}

// removeClient 处理连接断开
//
// 只通过 readPump 的 defer 走到这里
// 只有一条清理路径，就不会出现某条退出路径忘了清理的问题
func (h *Hub) removeClient(c *Client) {
	// 应该先判断 client 还在不在，否则关闭已经关闭的通道会导致 panic
	if _, ok := h.clients[c]; !ok {
		return
	}

	delete(h.clients, c)

	// 关闭 send 队列后，writePump 会发送关闭帧给客户端
	close(c.send)

	// 推送新的用户列表和用户离开的广播
	h.broadcast(outbound{Type: TypeMembers, Members: h.nicknames()})
	h.broadcast(outbound{Type: TypeSystem, Text: c.nickname + " 离开了聊天室"})

	log.Printf("用户 %s 已断开，当前在线 %d 人", c.nickname, len(h.clients))
}

// handleChat 处理客户端的信息。
func (h *Hub) handleChat(req chatRequest) {
	msg := h.store.Append(req.client.nickname, req.content)

	// 广播给自己是要拿到服务端分配的 时间 和 ID
	h.broadcast(outbound{Type: TypeMessage, Message: &msg})
}

// broadcast 把一条消息序列化后发给所有在线客户端。
func (h *Hub) broadcast(msg outbound) {
	payload, err := json.Marshal(msg)
	if err != nil {
		// 理论上不会序列化失败
		log.Println("序列化消息失败:", err)
		return
	}

	// 遍历发送
	for c := range h.clients {
		h.send(c, payload)
	}
}

// send 尝试把一份已经序列化好的数据放进某个客户端的待发送队列。
func (h *Hub) send(c *Client, payload []byte) {
	select {
	case c.send <- payload:

	default:
		// 队列满了，这个客户端跟不上了。
		//
		// 关闭连接让 readPump 自己走删除在线用户的路径，保持路径唯一性，
		// 否则就可能需要在遍历 map 时修改 map，失去了对 map 的保护。
		// gorilla/websocket 明确说明 Close 方法可以和其它方法并发调用，所以从 Hub 这里关连接是安全的。
		log.Printf("用户 %s 发送队列已满（积压 %d 条），主动断开", c.nickname, sendBufferSize)
		c.conn.Close()
	}
}

// nicknames 返回当前在线的昵称列表。
func (h *Hub) nicknames() []string {
	// 用 seen 去重：多人用同一个昵称时成员列表里只显示一个。
	seen := make(map[string]bool, len(h.clients))
	names := make([]string, 0, len(h.clients))
	for c := range h.clients {
		if !seen[c.nickname] {
			seen[c.nickname] = true
			names = append(names, c.nickname)
		}
	}

	// map 的遍历顺序在 Go 里是随机的，需要排序，
	// 保证前端每次收到的成员列表顺序稳定，界面上的人名不会乱跳。
	sort.Strings(names)
	return names
}
