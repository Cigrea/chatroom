package main

import (
	"database/sql"
	"log"
	"time"

	// 匿名导入（前面的下划线）
	//
	// 它的含义是：只执行这个包的 init() 函数，但不引入任何名字供本文件使用。
	//
	// 那为什么要导入一个"用不到"的包？因为 database/sql 只是一套**接口**，
	// 它自己不知道怎么写 SQLite。真正的驱动要在 init() 里调用
	// sql.Register("sqlite", ...) 把自己登记进去，
	// 之后 sql.Open("sqlite", ...) 才找得到驱动。
	//
	// 这就是 Go 里"驱动是插件"的机制：标准库定协议，第三方包来插。
	// 换成 MySQL 只需要把这一行换成 _ "github.com/go-sql-driver/mysql"，
	// 其余代码一行不动。
	//
	// 用 modernc.org/sqlite 而不是更出名的 mattn/go-sqlite3，
	// 是因为它是**纯 Go 实现**：不需要 C 编译器、不需要开 CGO，
	// 编译出一个二进制就能跑，部署最省心。
	_ "modernc.org/sqlite"
)

// createTableSQL 是建表语句。
//
// CREATE TABLE IF NOT EXISTS 只新建一次表
// id 自增且为主键
// 其余都不能为空
const createTableSQL = `
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender     TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);`

// SQLiteStore 把消息存进一个 SQLite 数据库文件里。
type SQLiteStore struct {
	db *sql.DB
}

// NewSQLiteStore 打开（或新建）数据库文件，建好表，返回可用的 Store。
func NewSQLiteStore(path string) (*SQLiteStore, error) {
	// sql.Open 不会真的去连数据库，是懒加载，可能不会报错，错误靠后面的 Ping 才能发现。
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}

	// 把连接池上限设成 1。
	//
	// 本来我们只在 Hub 一个 goroutine 里访问数据库，并发度天然是 1，
	// 这里显式限制一下有两个好处：
	//  - 彻底避免 SQLite 的 "database is locked" —— 多个连接同时写会互相争锁
	//  - 避免"刚写进去的数据在另一个连接里读不到"这类事务隔离问题
	db.SetMaxOpenConns(1)

	// 开启 WAL（Write-Ahead Logging）日志预写。
	// 好处是写操作不再阻塞读操作，是 SQLite 推荐的日常模式。
	// 开启失败并不影响功能，可以继续往下。
	var journalMode string
	// 用 QueryRow 可以返回结果再用 Scan 返回错误
	if err := db.QueryRow("PRAGMA journal_mode = WAL").Scan(&journalMode); err != nil {
		log.Println("启用 WAL 模式失败（不影响功能）:", err)
	}

	// 建表
	if _, err := db.Exec(createTableSQL); err != nil {
		db.Close()
		return nil, err
	}

	// Ping 才是真的连一次数据库
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}

	return &SQLiteStore{db: db}, nil
}

// Append 实现 Store 接口：往 messages 表插一行。
func (s *SQLiteStore) Append(sender, content string) (Message, error) {
	createdAt := time.Now()

	// 用 ? 占位符，不能把用户输入直接拼进 SQL 字符串，防止 SQL 注入。
	res, err := s.db.Exec(
		`INSERT INTO messages (sender, content, created_at) VALUES (?, ?, ?)`,
		sender, content, createdAt.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Message{}, err
	}

	// 拿数据库分配的自增 ID。
	id, err := res.LastInsertId()
	if err != nil {
		return Message{}, err
	}

	return Message{
		ID:        id,
		Sender:    sender,
		Content:   content,
		CreatedAt: createdAt,
	}, nil
}

// Since 实现 Store 接口，语义和 MemoryStore 完全一致。
func (s *SQLiteStore) Since(afterID int64, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = historyLimit
	}

	if afterID <= 0 {
		// ---- 新客户端：要最近的 limit 条。----
		//
		// 这里套了一层子查询，因为既要取最新的（倒序），又要按正序返回，
		// 所以内层按 id 倒序取 limit 条，外层再正序排回来。
		rows, err := s.db.Query(`
			SELECT id, sender, content, created_at FROM (
				SELECT id, sender, content, created_at
				FROM messages ORDER BY id DESC LIMIT ?
			) ORDER BY id ASC`, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close() // 必须关，否则连接不会还给连接池
		return scanMessages(rows)
	}

	// ---- 断线重连：只要 ID 大于 afterID 的。----
	//
	// id 是主键，天然带索引，所以这个 WHERE 走索引，不会全表扫描。
	rows, err := s.db.Query(`
		SELECT id, sender, content, created_at
		FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

// scanMessages 把查询结果逐行读成 []Message。
func scanMessages(rows *sql.Rows) ([]Message, error) {
	// 用 make(..., 0, 16) 而不是 var out []Message：
	// 前者返回的是非 nil 的空切片，序列化成 JSON 是 []；
	// 后者是 nil 切片，会变成 null，前端又得处理一次。
	out := make([]Message, 0, 16)

	for rows.Next() {
		var (
			m         Message
			createdAt string // 时间在 SQLite 里是文本
		)
		if err := rows.Scan(&m.ID, &m.Sender, &m.Content, &createdAt); err != nil {
			return nil, err
		}

		// 解析时间文本
		t, err := time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return nil, err
		}
		m.CreatedAt = t

		out = append(out, m)
	}

	// 检查 rows.Err()。
	//
	// 遍历中途如果出错，rows.Next() 只会返回 false。不检查的话，只会得到一份看起来正常但少了几行的结果。
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return out, nil
}
