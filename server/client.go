package main

import (
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// ============================================================
// Client：一条 WebSocket 连接
// ============================================================

const (
	// sendBufferSize 是每个客户端的待发送队列长度。
	//
	// 32 个位置的缓冲留给慢客户端反应时间
	sendBufferSize = 32

	// historyPushLimit 是新客户端连上时，最多推送多少条历史消息。
	historyPushLimit = 100

	// ---- 心跳与超时 ----

	// pongWait 是等待 pong 的时间。
	pongWait = 60 * time.Second

	// pingPeriod 是服务端主动发 ping 的间隔。
	// 取 9/10 的 pongWait 是业界惯例，留出一轮的网络往返余量。
	pingPeriod = (pongWait * 9) / 10

	// writeWait 是一次写操作的最长等待时间。
	writeWait = 10 * time.Second

	// maxMessageSize 是单条消息的最大字节数。
	// 防止有人塞一个超大报文把服务打爆。超长时 ReadMessage 会直接报错。
	maxMessageSize = 4096
)

// Client 代表一条 WebSocket 连接。
type Client struct {
	// hub 是所属的中枢，通过 hub 的通道传递信息。
	hub *Hub

	// conn 是底层的 WebSocket 连接。
	conn *websocket.Conn

	// send 是这个客户端的待发送队列。
	send chan []byte

	// nickname 是客户端自己报上来的昵称。
	nickname string

	// since 是本地最大消息 ID
	// 断线重连时前端把它带上来，服务端就只补新的，
	// 不用把整个历史重传一遍。首次连接传 0。
	since int64
}

// readPump 阻塞在 ReadMessage 上，把客户端发来的数据解析后交给 Hub。
//
// readPump 也负责删除在线用户，其它 goroutine 关闭连接就可以触发。
//
// 每个连接有且只有一个 readPump —— 这是 gorilla 的要求：同时只能有一个读操作。
func (c *Client) readPump() {
	// 函数退出时（不管是正常关闭还是出错）：
	//  - 向 Hub 请求把自己移出在线列表（只能从这里执行该操作）
	//  - 关闭连接
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	// 限制单条消息大小。超过这个长度 ReadMessage 会报错并关闭连接
	c.conn.SetReadLimit(maxMessageSize)

	// 设置读超时：pongWait 时间内没收到任何东西（包括 pong），就认为连接死了
	// 发送ping在 writePump 里
	c.conn.SetReadDeadline(time.Now().Add(pongWait))

	// 注册 pong 的处理函数：每收到一次 pong，就把读超时往后推一轮。
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		// ReadMessage 会一直阻塞，直到收到一条完整的消息。
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			// 走到这里的原因可能是：客户端正常关闭、网络断了、
			// ping 超时被判定死亡、或者发了超过大小限制的报文。

			// IsUnexpectedCloseError 用来过滤掉"正常关闭"的情况，只把真正的异常打出来。
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseNormalClosure,    //   1000 正常关闭
				websocket.CloseGoingAway,        //   1001 页面被关掉或跳转走了
				websocket.CloseNoStatusReceived, //   1005 对方发了关闭帧但没带状态码
			) {
				log.Printf("用户 %s 连接异常: %v", c.nickname, err)
			}
			return
		}

		// 解析客户端发来的 JSON
		var in inbound
		if err := json.Unmarshal(data, &in); err != nil {
			// 单条消息格式不对，不该断开整个连接——记一笔然后跳过。
			// 客户端可能只是发了个畸形数据，或者版本不匹配。
			log.Printf("用户 %s 发来无法解析的数据: %v", c.nickname, err)
			continue
		}

		// 先只处理 chat 类型。其它类型直接忽略，
		if in.Type != TypeChat {
			continue
		}

		// 服务端必须自己校验，不能信任客户端送来的东西。
		content := strings.TrimSpace(in.Content)
		if content == "" {
			continue // 空消息直接丢弃，不入库也不广播
		}

		// 交给 Hub 处理：存历史 + 广播
		c.hub.chat <- chatRequest{client: c, content: content}
	}
}

// writePump 从 send 队列里取消息写进连接，另外定期发 ping 探测对方是否还活着。
//
// 删除在线用户时，writePump 负责发送关闭帧。
//
// 每个连接有且只有一个 writePump —— 保证同一时刻只有一个写操作。
func (c *Client) writePump() {
	// 定时器：每隔 pingPeriod 触发一次。
	ticker := time.NewTicker(pingPeriod)

	// 退出时要停掉定时器。
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case payload, ok := <-c.send:
			if !ok {
				// send 被关闭了，说明这个客户端被移出了在线列表
				// 发送关闭帧
				c.conn.SetWriteDeadline(time.Now().Add(writeWait)) // 写前都应该设写超时
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			// 向客户端发送信息
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				log.Printf("用户 %s 写入失败: %v", c.nickname, err)
				return
			}

		case <-ticker.C:
			// 到点了，主动发一个 ping
			// readPump 里会接受 pong 并做处理
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
