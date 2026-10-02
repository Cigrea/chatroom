package main

import (
	"fmt"
	"net"
	"sync"
)

// Server 结构体
type Server struct {
	Ip          string
	Port        int
	OnlineUsers map[string]*User
	mapLock     sync.RWMutex
	Message     chan string
}

// 构造Server
func NewServer(ip string, port int) *Server {
	server := &Server{
		Ip:          ip,
		Port:        port,
		OnlineUsers: make(map[string]*User),
		Message:     make(chan string),
	}
	return server
}

// 监听Message，发送消息给所有在线User
func (s *Server) ListenMessage() {
	for message := range s.Message {
		s.mapLock.Lock()
		for _, user := range s.OnlineUsers {
			user.C <- message
		}
		s.mapLock.Unlock()
	}
}

// 广播消息
func (s *Server) BroadCast(user *User, msg string) {
	sendMsg := "[" + user.Addr + "]" + user.Name + ":" + msg // [地址]用户名:消息内容
	s.Message <- sendMsg
}

// 处理连接业务
func (s *Server) Handler(conn net.Conn) {
	// 先锁定map
	s.mapLock.Lock()
	// 创建一个User并加入到OnlineUsers中
	user := NewUser(conn)
	s.OnlineUsers[user.Name] = user
	s.mapLock.Unlock()
	s.BroadCast(user, "用户上线")
}

// 启动服务器接口
func (s *Server) Start() {
	// socket listen
	listener, err := net.Listen("tcp", fmt.Sprintf("%v:%v", s.Ip, s.Port))
	if err != nil {
		fmt.Println("net.Listener err:", err)
		return
	}
	defer listener.Close() // close listen

	// 启动监听Message的go
	go s.ListenMessage()

	// 监听新连接
	for {
		// accept
		conn, err := listener.Accept()
		if err != nil {
			fmt.Println("Listener accept err:", err)
			continue
		}
		// do handler
		go s.Handler(conn)
	}
}
