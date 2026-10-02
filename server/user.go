package main

import (
	"net"
)

type User struct {
	Name string
	Addr string
	C    chan string
	conn net.Conn
}

// 构造User
func NewUser(conn net.Conn) *User {
	userAddr := conn.RemoteAddr().String()
	user := &User{
		Name: userAddr, // 暂时用地址作用户名
		Addr: userAddr,
		C:    make(chan string),
		conn: conn,
	}
	go user.ListenMessage() // 启动监听当前User channel消息的goroutine
	return user
}

// 监听User.C，接受并发送信息至客户端
func (u *User) ListenMessage() {
	for msg := range u.C {
		u.conn.Write([]byte(msg + "\n"))
	}
}
