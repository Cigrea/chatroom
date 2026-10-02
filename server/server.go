package main

import (
	"fmt"
	"net"
)

type Server struct {
	Ip   string
	Port int
}

// 构造Server
func NewServer(ip string, port int) *Server {
	return &Server{Ip: ip, Port: port}
}

func (this *Server) Handler(conn net.Conn) {
	fmt.Println("链接建立成功")
}

// 启动服务器接口
func (this *Server) Start() {
	// socket listen
	listener, err := net.Listen("tcp", fmt.Sprintf("%v:%v", this.Ip, this.Port))
	if err != nil {
		fmt.Println("net,Listener err:", err)
		return
	}
	defer listener.Close() // close listen

	for {
		// accept
		conn, err := listener.Accept()
		if err != nil {
			fmt.Println("Listener accept err:", err)
			continue
		}
		// do handler
		go this.Handler(conn)
	}
}
