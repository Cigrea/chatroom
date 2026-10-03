package main

import (
	"errors"
	"fmt"
	"io"
	"maps"
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
	for msg := range s.Message {
		s.mapLock.RLock()
		onlineUsers := make(map[string]*User) // 复制避免因阻塞持续占用锁，影响其它业务
		maps.Copy(onlineUsers, s.OnlineUsers)
		s.mapLock.RUnlock()
		// 广播消息
		for _, user := range onlineUsers {
			select {
			case user.C <- msg:
			default: // 缓冲区已满，用户长时间不读，断开连接
				fmt.Printf("用户 %s 缓冲区已满，已断开\n", user.Name)
				user.CloseConn()
			}
		}
	}
}

// 删除用户
func (s *Server) DeleteUser(user *User) {
	s.BroadCast(user, "已下线")
	s.mapLock.Lock()
	delete(s.OnlineUsers, user.Name) // 在map里删除用户
	fmt.Println("Users:", len(s.OnlineUsers))
	s.mapLock.Unlock()
}

// 广播消息
func (s *Server) BroadCast(user *User, msg string) {
	sendMsg := "[" + user.Addr + "]" + user.Name + ":" + msg // [地址]用户名:消息内容
	s.Message <- sendMsg
}

// 监听客户端消息并广播
func (s *Server) ReceiveMessage(user *User, conn net.Conn) {
	buf := make([]byte, 4096)
	defer s.DeleteUser(user) // 一定要把删除放在循环外，不然每次循环都会defer
	for {
		n, err := conn.Read(buf)
		if n == 0 || (err != nil && err != io.EOF) {
			if err != nil && err != io.EOF && !errors.Is(err, net.ErrClosed) {
				fmt.Println("Conn read err:", err)
			}
			return
		}
		msg := string(buf[:n-1]) // 去掉换行符
		s.BroadCast(user, msg)
	}
}

// 处理连接业务，一个用户一个Handler
func (s *Server) Handler(conn net.Conn) {
	// 先锁定map
	s.mapLock.Lock()
	// 创建一个User并加入到OnlineUsers中
	user := NewUser(conn)
	s.OnlineUsers[user.Name] = user
	s.mapLock.Unlock()
	fmt.Println("Users:", len(s.OnlineUsers))
	// 广播当前用户上线消息
	s.BroadCast(user, "已上线")
	// 接收客户端发送的消息
	s.ReceiveMessage(user, conn)
	// 关闭连接
	user.CloseConn()
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
		// 接受新连接
		conn, err := listener.Accept()
		if err != nil {
			fmt.Println("Listener accept err:", err)
			continue
		}
		// 处理新连接业务
		go s.Handler(conn)
	}
}
