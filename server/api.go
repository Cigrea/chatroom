package main

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// ============================================================
// HTTP 层：路由、CORS、WebSocket 升级
// ============================================================

// extraAllowedOrigins 是"除了同源之外还额外允许"的来源清单，
// 从环境变量 CHATROOM_ALLOWED_ORIGINS 读，逗号分隔。
//
// 留空表示**只允许同源**——这是部署时的默认行为，也是最安全的。
var extraAllowedOrigins = parseOriginList(os.Getenv("CHATROOM_ALLOWED_ORIGINS"))

// parseOriginList 把 "a,b,c" 解析成一个集合，顺便丢掉空白项。
func parseOriginList(raw string) map[string]bool {
	out := make(map[string]bool)
	for _, item := range strings.Split(raw, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out[item] = true
		}
	}
	return out
}

// upgrader 负责把一条 HTTP 连接"升级"成 WebSocket 连接。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     checkOrigin,
}

// checkOrigin 决定要不要接受这次 WebSocket 握手。
//
// ★ 为什么必须认真查：浏览器的同源策略对 WebSocket 的保护**比普通请求弱得多**——
// 任何网页都能发起一个到任意地址的 WebSocket 连接，请求照样发出去，
// 服务端不主动拒绝的话握手就成功了。
// 所以别人写一个页面，就能让你的用户连到你的聊天室上来。
// CORS 拦不住它，那是给普通 HTTP 请求用的另一套机制。
//
// 三条规则：
//
//  1. **没有 Origin 头 → 放行。** 那不是浏览器发起的（curl、我们的自检脚本）。
//     而且这类客户端本来就能随便伪造 Origin，拦它没有意义。
//
//  2. **Origin 和请求的 Host 一致 → 放行。** 这正是部署时的形态：
//     前端打包后由同一个 Go 进程伺服，两个地址完全一样。
//
//  3. **其余看额外白名单。** 开发时前端在 5173、后端在 8080，
//     Host 对不上，所以需要把前端地址加进去：
//
//     $env:CHATROOM_ALLOWED_ORIGINS="http://localhost:5173"
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // 规则 1
	}

	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true // 规则 2：同源
	}

	return extraAllowedOrigins[origin] || extraAllowedOrigins[u.Host] // 规则 3
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

	// 前端静态文件（可选，见函数说明）。
	mountFrontend(r)

	return r
}

// mountFrontend 把打包好的前端挂在根路径下，让前后端跑在**同一个端口**上。
//
// 为什么部署时一定要这么做：
//
//	开发阶段前端跑在 vite dev server(5173)、后端在 8080，
//	靠 vite 的代理把请求转过去，浏览器眼里是同源的。
//	但部署到服务器上时，如果再起一个静态文件服务，就变成两个端口两个源，
//	又得回头去处理跨域；而且 WebSocket 的握手还要单独配 CheckOrigin。
//
//	把它挂到同一个 Go 进程上之后：一个端口、一个源，
//	CORS 和 CheckOrigin 全都自动成立，跟开发时靠代理达到的效果一样。
//
// ★ 这里用 NoRoute 而不是 r.Static("/", dir)，是因为后者会注册成
//
//	  `/*filepath` 通配路由，而 gin **不允许**它和已有的 `/api` 顶层路由共存，
//	  启动时直接 panic：
//
//		catch-all wildcard '*filepath' conflicts with existing path segment 'api'
//
//	  NoRoute 是"所有路由都没匹配上时的兜底处理函数"，不在路由树里，
//	  所以不会有冲突。
//
// 目录里没有 index.html 时只是打条日志跳过，不报错——
// 因为开发时根本不打包，这个目录本来就不存在。
func mountFrontend(r *gin.Engine) {
	dir := os.Getenv("CHATROOM_WEB_DIR")
	if dir == "" {
		// 默认值相对于**启动目录**：在 server/ 下执行 go run . 时正好指向打包产物
		dir = "../web/dist"
	}

	indexPath := filepath.Join(dir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		log.Printf("没找到前端打包产物（%s），本次只提供 API 和 WebSocket", indexPath)
		log.Printf("  想一起托管前端的话：先 cd web && npm run build，或用 CHATROOM_WEB_DIR 指定目录")
		return
	}

	// http.FileServer 自己会处理路径安全（不允许 .. 跳出目录）、
	// 目录请求自动找 index.html、以及 MIME 类型。
	fileServer := http.FileServer(http.Dir(dir))

	r.NoRoute(func(c *gin.Context) {
		p := c.Request.URL.Path

		// 拼错的接口路径要老老实实报 404。
		// 如果也回退到 index.html，调用方会拿到一坨 HTML，
		// 而解析 JSON 时只会得到一个莫名其妙的语法错误。
		if p == "/api" || strings.HasPrefix(p, "/api/") || p == "/ws" {
			c.JSON(http.StatusNotFound, gin.H{"error": "接口不存在"})
			return
		}

		fileServer.ServeHTTP(c.Writer, c.Request)
	})

	log.Printf("已托管前端静态文件: %s", dir)
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
