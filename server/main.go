// 程序入口：装配依赖、启动服务。
//
// 这个文件刻意保持很薄——只做"组装"，不含任何业务逻辑。
// 想看清这个后端整体长什么样，读这一个文件就够了。
package main

import (
	"log"
	"os"
)

func main() {
	// ---- 1. 消息存储 ----
	//
	// 现在是内存实现：服务端一重启，历史消息就没了。
	// 因为它只符合 Store 接口，以后换 SQLite 时只需要改这一行，
	// Hub、Client、HTTP 层一行都不用动。
	store := NewMemoryStore()

	// ---- 2. Hub ----
	//
	// ★ 这个 goroutine 是"谁在线"和"消息历史"的唯一持有者。
	//   所有并发访问都通过 channel 汇聚到它这里排队执行，
	//   所以整个项目没有一把锁。
	//
	//   `go` 让它在后台跑，主 goroutine 继续往下走去起 HTTP 服务。
	//   它是个死循环，永远不会返回——等于一直活到进程结束。
	hub := NewHub(store)
	go hub.Run()

	// ---- 3. HTTP 服务 ----
	port := os.Getenv("CHATROOM_PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("聊天室服务启动，监听 :%s", port)
	log.Printf("  探活接口:   http://localhost:%s/api/ping", port)
	log.Printf("  历史消息:   http://localhost:%s/api/messages", port)
	log.Printf("  WebSocket:  ws://localhost:%s/ws?nickname=你的昵称", port)

	router := newRouter(hub)
	if err := router.Run(":" + port); err != nil {
		// 这里用 Fatalf 而不是 Println：服务起不来就没有继续的意义了。
		log.Fatalf("服务启动失败: %v", err)
	}
}
