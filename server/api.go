package main

import (
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// ============================================================
// HTTP 层：路由、CORS、WebSocket 升级
// ============================================================

// upgrader 负责把一条 HTTP 连接"升级"成 WebSocket 连接。
//
// ★ CheckOrigin 必须自己配置，这是第一个新手必踩的坑。
//
// gorilla 的默认实现会检查请求里的 Origin 头，一旦发现来源和 Host 不一致
// 就直接拒绝升级。我们开发时前端在 5173、后端在 8080，属于跨域，
// **用默认配置必然连不上**，而且报错信息不明显，很容易以为是别的问题。
//
// 顺便分清它和 CORS 的区别（这是两套独立机制，面试常问）：
//
//	CORS         管的是普通 HTTP 请求：浏览器发请求前先问服务器同不同意
//	CheckOrigin  管的是 WebSocket 握手：服务器决定要不要接受这次升级
//
// 所以"后端配了 CORS"不等于"WebSocket 就能连上"，两处都得处理。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,

	CheckOrigin: func(r *http.Request) bool {
		// 学习项目里放开所有来源，方便前后端分离开发。
		// 生产环境应该在这里校验 r.Header.Get("Origin") 是否在允许名单里，
		// 否则任何网站都能连你的聊天室。
		return true
	},
}

// newRouter 组装所有路由，返回配置好的 gin 引擎。
//
// 把路由集中在这一个函数里，好处是答辩时一眼就能说清
// "这个后端对外提供了哪几个接口"。
func newRouter(hub *Hub) *gin.Engine {
	r := gin.Default()

	// 全局中间件：每个请求都先过 CORS，再进业务处理函数。
	r.Use(corsMiddleware())

	// 所有接口挂在 /api 前缀下（WebSocket 的 /ws 除外，它更像一个长连接通道）。
	api := r.Group("/api")
	{
		// 探活接口：不碰任何数据，只用来确认服务活着、链路通。
		api.GET("/ping", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"message": "pong"})
		})

		// 历史消息查询接口。
		//
		// ★ 注意这里绕了一圈：没有直接调 hub.store，而是走 channel 问 Hub。
		//
		// 为什么？因为 gin 的处理函数跑在**另一个 goroutine** 里，
		// 而 store 只允许 Hub 的 Run 访问。直接调就变成了并发访问共享状态——
		// 我们花了力气把锁去掉，不能在这里破功。
		//
		// 所以走 historyQuery 通道：把请求交给 Run 执行，
		// 再用 reply 通道把结果拿回来。这就是"通过通讯共享内存"
		// 在 HTTP 层的具体应用。
		api.GET("/messages", func(c *gin.Context) {
			afterID, _ := strconv.ParseInt(c.DefaultQuery("since", "0"), 10, 64)

			limit := 100
			if v, err := strconv.Atoi(c.DefaultQuery("limit", "100")); err == nil && v > 0 && v <= historyLimit {
				limit = v
			}

			// reply 给 1 个缓冲：保证 Run 发完就能立刻走，
			// 不会被我们这边的调度延迟拖住。
			reply := make(chan []Message, 1)
			hub.historyQuery <- historyRequest{afterID: afterID, limit: limit, reply: reply}
			msgs := <-reply

			// 包一层对象而不是直接返回数组，方便以后加字段
			// （比如 hasMore）而不破坏前端已有的解析逻辑。
			c.JSON(http.StatusOK, gin.H{"messages": msgs})
		})
	}

	// WebSocket 端点。注意它不在 /api 下面——
	// 它不是一个"一问一答"的接口，而是一条长连接通道。
	r.GET("/ws", func(c *gin.Context) {
		serveWS(hub, c)
	})

	return r
}

// serveWS 处理 GET /ws：把 HTTP 连接升级成 WebSocket，然后交给 Hub 管理。
//
// 参数通过 URL 查询字符串传：
//
//	nickname  昵称。空的话给个默认值。
//	since     可选。前端本地已有的最大消息 ID，断线重连时带上，只补新消息。
//
// 例如：ws://localhost:8080/ws?nickname=小明&since=42
func serveWS(hub *Hub, c *gin.Context) {
	nickname := strings.TrimSpace(c.Query("nickname"))
	if nickname == "" {
		nickname = "匿名用户"
	}

	since, _ := strconv.ParseInt(c.DefaultQuery("since", "0"), 10, 64)

	// ★ 关键一步：升级。
	//
	// 升级成功后，c.Writer 底下那条 TCP 连接就归 conn 管了，
	// 之后**绝对不要**再对 c 调用 c.JSON() / c.String() 之类——
	// 那相当于往一条已经变成 WebSocket 的连接里写 HTTP 响应，会把数据写坏。
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// 升级失败说明这压根不是一个合法的 WebSocket 请求（缺少 Upgrade 头等）。
		// 这时连接还是普通 HTTP，可以正常返回错误。
		log.Println("WebSocket 升级失败:", err)
		return
	}

	client := &Client{
		hub:      hub,
		conn:     conn,
		send:     make(chan []byte, sendBufferSize),
		nickname: nickname,
		since:    since,
	}

	// ★ 顺序很重要：先启动 writePump，再向 Hub 注册。
	//
	// 因为注册时 Hub 会立刻把历史消息推进 send 队列。
	// 如果这时候没人在队列另一头取，100 条历史会瞬间塞满 32 个槽位，
	// 这个刚进来的客户端就会被自己的欢迎消息挤掉——很荒唐但确实会发生。
	go client.writePump()

	// 把"我要加入"交给 Hub。这里会阻塞到 Hub 收到为止，
	// 之后 Hub 就会推送历史消息、更新成员列表、广播上线提示。
	hub.register <- client

	// readPump 放在注册之后启动：这样它一旦退出，
	// 发出去的 unregister 一定能对应上一个已经注册过的 client，
	// 不会出现"注销了一个从未注册过的连接"这种怪事。
	go client.readPump()
}

// corsMiddleware 给每个响应补上跨域响应头。
//
// 背景：浏览器有同源策略。前端在 5173、后端在 8080，端口不同就算跨域，
// 浏览器会拦掉这个请求。这几个响应头就是服务端在表态
// "我允许这个跨域请求"，浏览器看到之后才放行。
func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")

		// 浏览器在发真正的 POST 之前，会先自动发一个 OPTIONS 请求试探（叫预检）。
		// 它没有业务含义，直接回 204 结束，不进业务处理函数。
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		// 交给后面的处理函数。
		c.Next()
	}
}
