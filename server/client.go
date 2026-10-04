package main

import (
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// ============================================================
// Client —— 一条 WebSocket 连接
// ============================================================

const (
	// sendBufferSize 是每个客户端的待发送队列长度。
	//
	// 这个"缓冲"是慢客户端问题的核心解法：
	// 有缓冲意味着发送方把消息放进队列就能立刻返回，不必等对方真的收到。
	// 只有 32 个位置全满，才说明这个客户端是真的跟不上了。
	sendBufferSize = 32

	// historyPushLimit 是新客户端连上时，最多推送多少条历史消息。
	// 比 historyLimit（内存里存的条数）小，是因为一次推太多会让页面加载变慢，
	// 而且用户也不会往上翻那么远。
	historyPushLimit = 100

	// ---------- 心跳与超时 ----------
	//
	// 这几个参数解决的是"客户端异常掉线时服务端不知道"的问题：
	// 如果客户端是拔网线、合盖休眠、进程被强杀，它不会发 TCP 的 FIN，
	// 服务端的读操作会一直阻塞，永远不知道对方已经走了。
	// （TCP 自带的 keepalive 默认要 2 小时才探测，等于没有。）

	// pongWait 表示"多久收不到客户端的 pong 就认为它死了"。
	pongWait = 60 * time.Second

	// pingPeriod 是服务端主动发 ping 的间隔。
	// 必须比 pongWait 小，否则会在对方还活着的时候就误判超时。
	// 取 9/10 是业界惯例，留出一轮的网络往返余量。
	pingPeriod = (pongWait * 9) / 10

	// writeWait 是一次写操作最多等多久。
	// 防止对方不读数据时，我们的写操作永远卡在那里。
	writeWait = 10 * time.Second

	// maxMessageSize 是单条消息的最大字节数。
	// 防止有人塞一个超大报文把服务打爆。超长时 ReadMessage 会直接报错。
	maxMessageSize = 4096
)

// Client 代表一条 WebSocket 连接。
//
// 它和我们之前 TCP 版本的 User 是一回事，只是底层从裸 TCP 换成了 WebSocket。
// 之前那套"连接生命周期管理"的思路完全保留：
//   - 一个连接一个 goroutine 负责读（readPump）
//   - 一个连接一个 goroutine 负责写（writePump）
//   - 断开时统一走一条清理路径
type Client struct {
	// hub 是所属的中枢。它不直接改任何共享状态，
	// 而是通过 hub 的 channel 把自己的请求交出去。
	hub *Hub

	// conn 是底层的 WebSocket 连接。
	conn *websocket.Conn

	// send 是这个客户端的待发送队列。
	//
	// ★ 只有 writePump 这一个 goroutine 会从它读取并真正写网卡，
	//   其它地方（Hub）只会往里放。
	//
	//   这满足 gorilla/websocket 的硬性要求：
	//   一个连接同时只能有一个写操作，多个 goroutine 同时写会串帧。
	//   我们这个"一个 writePump 独占写"的设计天然满足它。
	send chan []byte

	// nickname 是客户端自己报上来的昵称。
	nickname string

	// since 是"我手上已经有哪些消息了"（本地最大消息 ID）。
	// 断线重连时前端把它带上来，服务端就只补新的，
	// 不用把整个历史重传一遍。首次连接传 0。
	since int64
}

// ============================================================
// readPump —— 唯一的读循环
// ============================================================

// readPump 阻塞在 ReadMessage 上，把客户端发来的数据解析后交给 Hub。
//
// 每个连接有且只有一个 readPump —— 这是 gorilla 的要求（同时只能有一个读操作）。
// 这个方法应该用 `go client.readPump()` 启动。
func (c *Client) readPump() {
	// ★ 函数退出时（不管是正常关闭还是出错），做两件事：
	//   1. 向 Hub 请求把自己移出在线列表
	//   2. 关闭底层连接
	//
	// 用 defer 保证这两件事一定会执行——无论从哪条路径退出。
	// 这是"资源的释放要和获取对称"的具体体现，也是我们之前踩过坑之后
	// 定下来的做法（那时候 err != nil 分支忘了清理，留下了僵尸用户）。
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	// 限制单条消息大小。超过这个长度 ReadMessage 会报错并关闭连接。
	c.conn.SetReadLimit(maxMessageSize)

	// 设置读超时：pongWait 时间内没收到任何东西（包括 pong），就认为连接死了。
	c.conn.SetReadDeadline(time.Now().Add(pongWait))

	// 注册 pong 的处理函数：每收到一次 pong，就把读超时往后推一轮。
	// 所以只要客户端还活着并正常回 pong，这个超时就永远不会触发。
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		// ReadMessage 会一直阻塞，直到收到一条**完整的**消息。
		//
		// 这里和我们 TCP 版本最大的区别：不用再自己处理"粘包"了。
		// WebSocket 有帧边界，一次 ReadMessage 就是一条完整消息，
		// 所以那句 `string(buf[:n-1]) // 去掉换行符` 可以彻底扔掉。
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			// 走到这里的原因可能是：客户端正常关闭、网络断了、
			// ping 超时被判定死亡、或者发了超过大小限制的报文。
			//
			// IsUnexpectedCloseError 用来过滤掉"正常关闭"这类预期内的情况，
			// 只把真正的异常打出来，避免日志里全是噪音。
			//
			// 这里列出的状态码都算"正常关闭"，不算异常：
			//   1000 正常关闭
			//   1001 页面被关掉或跳转走了
			//   1005 对方发了关闭帧但没带状态码——很多客户端就是这么干的，
			//        不把它排除掉的话，日志里每次正常退出都会多一行"连接异常"，
			//        演示时看着像出错了。
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
				websocket.CloseNoStatusReceived,
			) {
				log.Printf("用户 %s 连接异常: %v", c.nickname, err)
			}
			return // defer 会完成清理
		}

		// 解析客户端发来的 JSON。
		var in inbound
		if err := json.Unmarshal(data, &in); err != nil {
			// 单条消息格式不对，不该断开整个连接——记一笔然后跳过。
			// 客户端可能只是发了个畸形数据，或者版本不匹配。
			log.Printf("用户 %s 发来无法解析的数据: %v", c.nickname, err)
			continue
		}

		// 目前只处理 chat 类型。其它类型直接忽略，
		// 这样以后前端升级加了新类型，老服务端也不会崩。
		if in.Type != TypeChat {
			continue
		}

		// 服务端必须自己校验，不能信任客户端送来的东西。
		content := strings.TrimSpace(in.Content)
		if content == "" {
			continue // 空消息直接丢弃，不入库也不广播
		}

		// ★ 交给 Hub 处理：存历史 + 广播。
		//
		// 注意这里**没有**直接去改任何共享状态，而是"通过通讯"
		// 把活交给唯一有权处理它的那个 goroutine。
		// c.hub.chat 是无缓冲通道，所以这里会阻塞到 Hub 收到为止——
		// 这也是天然的背压：Hub 忙不过来时，读循环会自动慢下来。
		c.hub.chat <- chatRequest{client: c, content: content}
	}
}

// ============================================================
// writePump —— 唯一的写循环
// ============================================================

// writePump 从 send 队列里取消息写进连接，另外定期发 ping 探测对方是否还活着。
//
// 每个连接有且只有一个 writePump —— 保证同一时刻只有一个写操作。
// 这个方法应该用 `go client.writePump()` 启动。
func (c *Client) writePump() {
	// 定时器：每隔 pingPeriod 触发一次。
	ticker := time.NewTicker(pingPeriod)

	// 退出时停掉定时器，否则它会一直在后台跑——这是资源泄漏。
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case payload, ok := <-c.send:
			// ok == false 表示 send 通道被关闭了，
			// 也就是说 Hub 已经把这个客户端移出了在线列表（removeClient 里 close 的）。
			if !ok {
				// 发一个正常的关闭帧告诉对方"我要关了"，让它知道不是网络故障。
				c.conn.SetWriteDeadline(time.Now().Add(writeWait))
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			// 设写超时：对方不读数据时，不让我们的写操作永远卡住。
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))

			// WriteMessage 把数据打包成一个 WebSocket 文本帧发出去。
			if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				log.Printf("用户 %s 写入失败: %v", c.nickname, err)
				return
			}

		case <-ticker.C:
			// 到点了，主动发一个 ping。
			//
			// 对方收到 ping 会自动回一个 pong，我们的读循环里
			// SetPongHandler 会把读超时往后推。如果对方已经死了，
			// pong 不会来，读超时最终触发，readPump 报错退出并完成清理。
			//
			// 这就是"服务端主动探测客户端死没死"的完整闭环。
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
