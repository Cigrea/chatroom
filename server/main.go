package main

import "github.com/gin-gonic/gin"

func main() {
	gin.SetMode("release")
	r := gin.Default()
	r.GET("/api/ping", func(ctx *gin.Context) {
		ctx.JSON(200, gin.H{
			"code": 101,
			"data": "pong",
		})
	})
	r.Run("127.0.0.1:8888")
}
