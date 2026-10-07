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
// gorilla 的默认实现会检查请求里的 Origin 头，一旦发现来源和 Host 不一致
// 就直接拒绝升级。开发时前端在 5173、后端在 8080，属于跨域，所以要放开。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,

	CheckOrigin: func(r *http.Request) bool {
		// 放开所有来源，方便前后端分离开发。
		return true
	},
}

// newRouter 组装所有路由，返回配置好的 gin 引擎。
func newRouter(hub *Hub) *gin.Engine {
	r := gin.Default()

	// 全局中间件：每个请求都先过 CORS，再进业务处理函数。
	r.Use(corsMiddleware())

	// 所有接口挂在 /api 前缀下（WebSocket 的 /ws 除外）。
	api := r.Group("/api")
	{
		// 探活接口
		api.GET("/ping", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"message": "pong"})
		})

		// 历史消息查询接口
		//
		// 两个方向：
		//	since=<id>   往后查，返回 ID 大于它的（断线重连补消息）
		//	before=<id>  往前查，返回 ID 小于它的（用户向上滚翻历史）
		// 同时传的话以 before 为准。
		api.GET("/messages", func(c *gin.Context) {
			afterID, _ := strconv.ParseInt(c.DefaultQuery("since", "0"), 10, 64)
			beforeID, _ := strconv.ParseInt(c.DefaultQuery("before", "0"), 10, 64)

			limit := 100
			if v, err := strconv.Atoi(c.DefaultQuery("limit", "100")); err == nil && v > 0 && v <= historyLimit {
				limit = v
			}

			// reply 给 1 个缓冲，保证 Run 不会被拖住。
			reply := make(chan historyResult, 1)
			hub.historyQuery <- historyRequest{
				afterID:  afterID,
				beforeID: beforeID,
				limit:    limit,
				reply:    reply,
			}
			result := <-reply

			// 查询失败报错
			if result.err != nil {
				log.Println("查询历史消息失败:", result.err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "读取历史消息失败"})
				return
			}

			// 包一层对象而不是直接返回数组，方便以后加字段。
			c.JSON(http.StatusOK, gin.H{"messages": result.messages})
		})
	}

	// WebSocket 端点，不在 /api 下面。
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
func serveWS(hub *Hub, c *gin.Context) {
	nickname := strings.TrimSpace(c.Query("nickname"))
	if nickname == "" {
		nickname = "匿名用户"
	}

	since, _ := strconv.ParseInt(c.DefaultQuery("since", "0"), 10, 64)

	// 升级之后不能再写http响应。
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

	// 先启动writePump，才能成功读到注册后推送的消息。
	go client.writePump()

	// 把"我要加入"交给 Hub。这里会阻塞到 Hub 收到为止，
	// 之后 Hub 就会推送历史消息、更新成员列表、广播上线提示。
	hub.register <- client

	// readPump 放在注册之后启动：这样它一旦退出，
	// 发出去的 unregister 一定能对应上一个已经注册过的 client。
	go client.readPump()
}

// corsMiddleware 给每个响应补上跨域响应头。
//
// 浏览器有同源策略。前端在 5173、后端在 8080，端口不同就算跨域，
// 浏览器会拦掉这个请求。这几个响应头就是服务端在表态
// "我允许这个跨域请求"，浏览器看到之后才放行。
func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 简单请求
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")

		// 浏览器在发真正的 POST 之前，会先自动发一个 OPTIONS 请求试探（叫预检）
		// 它没有业务含义，直接回 204 结束，不进业务处理函数
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		// 交给后面的处理函数
		c.Next()
	}
}
