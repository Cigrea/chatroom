package main

import (
	"fmt"
	"net"
	"sync"
)

type User struct {
	Name string
	Addr string
	C    chan string // 接受信息通道
	conn net.Conn
	done chan struct{} // 关闭连接通道，不传数据
	once sync.Once     // 保证只关闭一次
}

// 构造User
func NewUser(conn net.Conn) *User {
	userAddr := conn.RemoteAddr().String()
	user := &User{
		Name: userAddr, // 暂时用地址作用户名
		Addr: userAddr,
		C:    make(chan string, 16),
		conn: conn,
		done: make(chan struct{}),
	}
	go user.ListenMessage() // 启动监听当前User channel消息的go程
	return user
}

// 监听User.C，接受并发送信息至客户端
func (u *User) ListenMessage() {
	for {
		select {
		case msg := <-u.C:
			_, err := u.conn.Write([]byte(msg + "\n"))
			if err != nil {
				fmt.Println("Conn write err:", err)
				return
			}
		case <-u.done:
			return
		}
	}
}

func (u *User) CloseConn() {
	var err error
	u.once.Do(func() {
		close(u.done)
		err = u.conn.Close()
	})
	if err != nil {
		fmt.Println("Conn close err:", err)
	}

}
