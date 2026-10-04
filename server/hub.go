package main

import (
	"encoding/json"
	"log"
	"sort"
)

// ============================================================
// Hub —— 聊天室的中枢
// ============================================================

// Hub 持有"谁在线"这个唯一的真相，并负责把消息分发给所有人。
//
// ★★★ 这个文件是整个项目的设计核心，请务必读懂下面这段话 ★★★
//
// clients 这个 map 和 store 都**只被 Run 这一个 goroutine 读写**。
//
// 其它 goroutine（每个连接的 readPump、gin 的 HTTP 处理函数）想影响它们时，
// 不直接动手，而是把请求发到下面的 channel 上，由 Run 排队串行处理。
//
// 这就是 Go 的那句谚语：
//
//	不要通过共享内存来通讯，而要通过通讯来共享内存。
//	(Do not communicate by sharing memory; instead, share memory by communicating.)
//
// 对比一下我们之前用互斥锁的版本，好处非常明显：
//
//	用锁的版本                          用 channel 的版本（现在）
//	--------------------------------    ----------------------------------
//	锁的范围要反复权衡（大了阻塞，小了没保护）  没有锁，不存在范围问题
//	可能忘了解锁                       不存在
//	可能死锁（持锁时做阻塞操作）          不存在
//	可能锁的粒度和业务不匹配             不存在
//	出问题靠 -race 才发现               从结构上就不可能发生
//
// 代价是：所有并发访问都被串行化了，理论上吞吐不如细粒度锁。
// 但对一个聊天室来说，Run 里做的都是"往 channel 里塞一下"这种极快的操作，
// 完全不是瓶颈——真正的瓶颈在网络 I/O，而那部分被分摊到了每个连接自己的
// readPump / writePump 里，是并行的。
type Hub struct {
	// clients 是"谁在线"的唯一真相。
	//
	// 用 map[*Client]bool 而不是 map[string]*Client：
	// key 直接用连接指针最简单，也允许两个同名的人同时在线
	// （重名问题见 README 的已知问题）。bool 的值没有意义，只用来占位。
	//
	// ★ 只被 Run 访问，所以不需要任何锁。
	clients map[*Client]bool

	// store 是消息历史。★ 同样只被 Run 访问。
	store Store

	// ---------- 下面四个是外部 goroutine 用来"请求 Run 干活"的通道 ----------
	// 它们都是无缓冲的：发送方会一直阻塞到 Run 收到为止。
	// 这是一种天然的背压机制——Run 忙不过来时，外面的请求会自动排队等待。

	// register：有新连接建立，请求加入在线列表。
	register chan *Client

	// unregister：有连接断开，请求移出在线列表。
	unregister chan *Client

	// chat：有客户端说了句话，请求存历史并广播出去。
	chat chan chatRequest

	// historyQuery：HTTP 接口要查历史消息。
	// 它自带一个 reply 通道，Run 处理完把结果塞回去——
	// 这样查询逻辑也在 Run 里执行，store 依然只被一个 goroutine 碰。
	historyQuery chan historyRequest
}

// chatRequest 表示"某个客户端说了一句话"。
type chatRequest struct {
	client  *Client
	content string
}

// historyRequest 表示"帮我查一下历史消息"。
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
// 然后串行地处理它。因为它一次只处理一件事，所以**不需要锁**。
//
// 调用方应该用 `go hub.Run()` 让它在后台跑。
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
			// 万一查询方已经超时走人了（比如 HTTP 客户端断开），我们也能立刻脱身。
			req.reply <- h.store.Since(req.afterID, req.limit)
		}
	}
}

// ============================================================
// 下面这些方法都只被 Run 调用（也就是只在那个 goroutine 里执行），
// 所以它们可以随意读写 h.clients 和 h.store，不需要任何同步措施。
// ============================================================

// addClient 处理"来了一个新连接"。
func (h *Hub) addClient(c *Client) {
	h.clients[c] = true

	// ---- 1. 先把历史消息推给它 ----
	//
	// 这是"刷新页面后消息还在"这条要求的落地点：
	// 页面刷新会重新建立 WebSocket 连接，连上就立刻收到历史，于是记录看起来还在。
	//
	// 注意历史是**一条**消息（里面装一个数组），而不是 N 条独立消息。
	// 这样它只占用 send 队列的一个位置，不会因为一次推 100 条把缓冲区挤爆。
	//
	// c.since 是前端带上来的"我手上最大的消息 ID"：
	//   首次打开 → 0 → 服务端给最近 historyPushLimit 条
	//   断线重连 → 具体数字 → 服务端只补新的，不重传整个历史
	history := h.store.Since(c.since, historyPushLimit)

	// 先自己序列化成 []byte 再交给 send。
	// 因为 send 只负责"投递字节"，不关心内容是什么——
	// 这样它既能用在 broadcast（序列化一次、多人复用），
	// 也能用在这种"只发给一个人"的场景。
	if payload, err := json.Marshal(outbound{Type: TypeHistory, Messages: history}); err != nil {
		log.Println("序列化历史消息失败:", err)
	} else {
		h.send(c, payload)
	}

	// ---- 2. 告诉所有人现在谁在线 ----
	// 包括刚进来的这位自己，这样它一进来就能看到成员列表。
	h.broadcast(outbound{Type: TypeMembers, Members: h.nicknames()})

	// ---- 3. 广播上线提示 ----
	h.broadcast(outbound{Type: TypeSystem, Text: c.nickname + " 加入了聊天室"})

	log.Printf("用户 %s 已连接，当前在线 %d 人", c.nickname, len(h.clients))
}

// removeClient 处理"某个连接断开了"。
//
// ★ 这是**唯一**的移除路径。
//
// 不管是客户端自己关掉的、网络断了、ping 超时了，还是因为太慢被服务端踢了，
// 最终都会通过 readPump 的 defer 走到这里。
// 只有一条清理路径，就不会出现"某条退出路径忘了清理"的问题——
// 这正是之前 DeleteUser 那处 bug 的教训。
func (h *Hub) removeClient(c *Client) {
	// 先判断还在不在。可能已经被移除过了（比如太慢被踢之后，
	// readPump 又走了一次正常的退出流程），重复移除要直接返回——
	// 否则会 close 一个已经关闭的 channel，直接 panic。
	if _, ok := h.clients[c]; !ok {
		return
	}

	delete(h.clients, c)

	// 关闭 send 队列。
	// writePump 里的 `case payload, ok := <-c.send` 会收到 ok == false，
	// 于是它发一个正常的关闭帧给客户端，然后退出那个 goroutine。
	//
	// 这里 close 是安全的：c 已经从 clients 里删掉了，
	// 而所有往 send 里写的地方都只遍历 clients，所以不可能再有人写它。
	close(c.send)

	h.broadcast(outbound{Type: TypeMembers, Members: h.nicknames()})
	h.broadcast(outbound{Type: TypeSystem, Text: c.nickname + " 离开了聊天室"})

	log.Printf("用户 %s 已断开，当前在线 %d 人", c.nickname, len(h.clients))
}

// handleChat 处理"某个客户端说了一句话"。
func (h *Hub) handleChat(req chatRequest) {
	// 先落进历史。因为只有 Run 碰 store，所以它内部不用加锁。
	msg := h.store.Append(req.client.nickname, req.content)

	// 再广播给所有人（包括发送者自己）。
	//
	// 为什么要把消息回送给发送者？
	// 因为前端拿到的这条消息带着**服务端分配的 ID 和时间**，
	// 用它上屏才能和之后收到的历史完全一致，做去重也不会出问题。
	h.broadcast(outbound{Type: TypeMessage, Message: &msg})
}

// ============================================================
// 工具方法（同样只被 Run 调用）
// ============================================================

// broadcast 把一条消息序列化后发给所有在线客户端。
//
// 它在 Run 的 goroutine 里跑，所以可以安全地遍历 h.clients。
func (h *Hub) broadcast(msg outbound) {
	payload, err := json.Marshal(msg)
	if err != nil {
		// 理论上不会发生（我们的结构体都是可序列化的），
		// 但 Go 要求你处理每一个 error，这里记下来就好，不能让服务崩。
		log.Println("序列化消息失败:", err)
		return
	}

	for c := range h.clients {
		h.send(c, payload)
	}
}

// send 尝试把一份已经序列化好的数据放进某个客户端的待发送队列。
//
// ★ 这是"慢客户端不会拖垮整个服务"的关键，也是我们前几轮踩坑的地方。
//
// select + default 的含义是**不等待**：
//   - 队列有空位 → 放进队列，立刻返回
//   - 队列满了   → 立刻走 default
//
// 用有缓冲的 channel（sendBufferSize = 32）意味着"放进队列"这个动作
// 不需要等对方真的把数据写上网卡。所以一个短暂卡顿的客户端
// （比如浏览器标签页被切到后台、被系统节流）不会阻塞广播。
//
// 只有当 32 个位置全满——也就是这个客户端积压了 32 条消息还没读走——
// 才说明它是真的跟不上了，这时把它踢掉。
func (h *Hub) send(c *Client, payload []byte) {
	select {
	case c.send <- payload:
		// 成功放进队列，正常返回。

	default:
		// 队列满了，这个客户端跟不上了。
		//
		// 关键设计：这里**不直接删 map**，而是关掉底层连接。
		// 连接一关，那个客户端自己的 readPump 里的 ReadMessage 就会报错返回，
		// 它的 defer 会把 unregister 请求发给 Hub，
		// 于是走 removeClient 那条**唯一的清理路径**。
		//
		// 这样做有两个好处：
		//   1. 移除逻辑只有一份，不会漏掉任何清理动作
		//   2. 不需要在"正遍历 clients"的过程中删 map，逻辑更清楚
		//
		// 顺带一提：gorilla/websocket 明确说明 Close 方法可以和其它方法并发调用，
		// 所以从 Hub 这里关连接是安全的。
		log.Printf("用户 %s 发送队列已满（积压 %d 条），主动断开", c.nickname, sendBufferSize)
		c.conn.Close()
	}
}

// nicknames 返回当前在线的昵称列表。
func (h *Hub) nicknames() []string {
	// 用 seen 去重：允许多人用同一个昵称，但成员列表里只显示一个。
	seen := make(map[string]bool, len(h.clients))
	names := make([]string, 0, len(h.clients))
	for c := range h.clients {
		if !seen[c.nickname] {
			seen[c.nickname] = true
			names = append(names, c.nickname)
		}
	}

	// map 的遍历顺序在 Go 里是随机的。排序一下，
	// 前端每次收到的成员列表顺序才稳定，界面上的人名不会乱跳。
	sort.Strings(names)
	return names
}
