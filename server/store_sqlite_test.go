package main

import (
	"fmt"
	"path/filepath"
	"testing"
)

// TestSQLiteStoreTrimsOldMessages 验证数据库不会无限增长。
//
// 做法是插入 maxStoredMessages+50 条，然后直接数库里还剩多少行。
// 之所以要"超过上限"再检查，是因为这个功能只有溢出时才看得出来——
// 只插几条的话，不管有没有清理逻辑，结果都一样。
func TestSQLiteStoreTrimsOldMessages(t *testing.T) {
	// 用临时目录里的数据库文件，测试完自动清掉，不影响真实数据
	dir := t.TempDir()
	store, err := NewSQLiteStore(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("打开数据库失败: %v", err)
	}
	// 一定要关：不关的话 Windows 上临时目录里的 .db 文件被占用，清理会失败。
	defer store.Close()

	const overflow = 50
	total := maxStoredMessages + overflow

	for i := 1; i <= total; i++ {
		if _, err := store.Append("测试者", fmt.Sprintf("第 %d 条", i)); err != nil {
			t.Fatalf("第 %d 条写入失败: %v", i, err)
		}
	}

	// 直接数行数——这是唯一能看出"到底留了多少条"的办法，
	// 因为 Since 接口本身带了 limit，看不全。
	var count int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&count); err != nil {
		t.Fatalf("统计行数失败: %v", err)
	}

	if count != maxStoredMessages {
		t.Errorf("插入 %d 条之后库里应该只剩 %d 条，实际有 %d 条", total, maxStoredMessages, count)
	}

	// 留下的应该是**最新的**那批：最老的 id 应当正好是 overflow+1
	var oldestID int64
	if err := store.db.QueryRow("SELECT MIN(id) FROM messages").Scan(&oldestID); err != nil {
		t.Fatalf("查询最小 ID 失败: %v", err)
	}
	wantOldest := int64(overflow + 1)
	if oldestID != wantOldest {
		t.Errorf("最老的 ID 应该是 %d（前 %d 条被删掉），实际是 %d", wantOldest, overflow, oldestID)
	}

	// 顺带确认留下的内容确实是最新的那条
	latest, err := store.Since(0, 1)
	if err != nil {
		t.Fatalf("读取最新消息失败: %v", err)
	}
	if len(latest) != 1 {
		t.Fatalf("应该读到 1 条最新消息，实际读到 %d 条", len(latest))
	}
	if want := fmt.Sprintf("第 %d 条", total); latest[0].Content != want {
		t.Errorf("最新一条内容应该是 %q，实际是 %q", want, latest[0].Content)
	}
}

// TestSQLiteStoreKeepsEverythingUnderLimit 确认没到上限时不会误删。
//
// 因为 trimSQL 里那句 `id < (子查询)` 在消息不足时会拿到 NULL，
// 而 `id < NULL` 恒为假。这个测试就是把这个行为钉死，
// 免得以后有人改 SQL 时不小心写成 `id <= NULL` 之类的形式。
func TestSQLiteStoreKeepsEverythingUnderLimit(t *testing.T) {
	dir := t.TempDir()
	store, err := NewSQLiteStore(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("打开数据库失败: %v", err)
	}
	// 一定要关：不关的话 Windows 上临时目录里的 .db 文件被占用，清理会失败。
	defer store.Close()

	const n = 20
	for i := 1; i <= n; i++ {
		if _, err := store.Append("测试者", fmt.Sprintf("第 %d 条", i)); err != nil {
			t.Fatalf("第 %d 条写入失败: %v", i, err)
		}
	}

	var count int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&count); err != nil {
		t.Fatalf("统计行数失败: %v", err)
	}
	if count != n {
		t.Errorf("没到上限时不应该删任何东西：插了 %d 条，库里剩 %d 条", n, count)
	}
}

// TestSQLiteStoreRejectsInjection 验证参数化查询挡住了 SQL 注入。
//
// 如果把内容拼进 SQL 字符串，这几条"恶意内容"会把表删掉或者把条件改成恒真。
func TestSQLiteStoreRejectsInjection(t *testing.T) {
	dir := t.TempDir()
	store, err := NewSQLiteStore(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("打开数据库失败: %v", err)
	}
	// 一定要关：不关的话 Windows 上临时目录里的 .db 文件被占用，清理会失败。
	defer store.Close()

	attacks := []string{
		"'); DROP TABLE messages; --",
		"' OR '1'='1",
		"'; DELETE FROM messages; --",
	}
	for i, a := range attacks {
		if _, err := store.Append("攻击者", a); err != nil {
			t.Fatalf("第 %d 条写入失败: %v", i+1, err)
		}
	}

	// 表还在，而且内容被原样当成了普通文本
	msgs, err := store.Since(0, 10)
	if err != nil {
		t.Fatalf("表可能已经被删掉了: %v", err)
	}
	if len(msgs) != len(attacks) {
		t.Fatalf("应该有 %d 条消息，实际 %d 条", len(attacks), len(msgs))
	}
	for i, a := range attacks {
		if msgs[i].Content != a {
			t.Errorf("第 %d 条内容应该被原样保存为 %q，实际是 %q", i+1, a, msgs[i].Content)
		}
	}
}
