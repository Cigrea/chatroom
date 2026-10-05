package main

import (
	"log"
	"os"
)

// ============================================================
// 程序入口：装配依赖、启动服务
// ============================================================

func main() {
	// ---- 消息存储 ----
	//
	// 现在是内存实现：服务端一重启，历史消息就没了。
	// 因为它只符合 Store 接口，以后换 SQLite 时只需要改这一行，
	// Hub、Client、HTTP 层一行都不用动。
	store := NewMemoryStore()

	// ---- 启动 hub.Run ----
	hub := NewHub(store)
	go hub.Run()

	// ---- HTTP 服务 ----
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
		log.Fatalf("服务启动失败: %v", err) // Fatalf 会在 Printf 后自动调用 os.Exit(1)
	}
}
