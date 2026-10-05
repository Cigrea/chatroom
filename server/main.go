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
	// 本项目有两个实现，满足同一个 Store 接口：
	//
	//	SQLiteStore  默认。数据在数据库文件里。
	//	MemoryStore  内存实现，设 CHATROOM_STORE=memory 切换。

	// 因为写了 Store 接口，hub 无需关心是内存还是 SQLite 实现
	var store Store

	if os.Getenv("CHATROOM_STORE") == "memory" {
		store = NewMemoryStore()
		log.Println("消息存储: 内存")
	} else {
		dbPath := os.Getenv("CHATROOM_DB")
		if dbPath == "" {
			dbPath = "chatroom.db"
		}

		sqliteStore, err := NewSQLiteStore(dbPath)
		if err != nil {
			log.Fatalf("打开数据库失败: %v", err) // 打不开数据库直接退出程序
		}
		store = sqliteStore
		log.Printf("消息存储: SQLite (文件 %s) ", dbPath)
	}

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
