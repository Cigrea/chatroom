// WebSocket 后端接口自检。
//
// 覆盖：探活、历史推送、成员列表、系统提示、消息广播、增量补发、REST 历史接口、离线通知。
//
// 用法：先在 server/ 里 `go run .` 起服务，然后
//   node scripts/ws-check.mjs
const PORT = process.env.CHATROOM_PORT || '8080';
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一个测试用客户端：连上后把所有收到的消息存进 inbox，方便断言。
function openWS({ nickname, since = 0 } = {}) {
  const url = `${WS}?nickname=${encodeURIComponent(nickname)}&since=${since}`;
  const ws = new WebSocket(url);
  const inbox = [];
  ws.addEventListener('message', (e) => {
    try {
      inbox.push(JSON.parse(e.data));
    } catch (err) {
      inbox.push({ type: 'UNPARSEABLE', raw: e.data });
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({ ws, inbox, nickname }));
    ws.addEventListener('error', () => reject(new Error(`WebSocket 连接失败: ${url}`)));
    setTimeout(() => reject(new Error('连接超时')), 5000);
  });
}

// 等 inbox 里出现满足条件的消息
async function waitFor(inbox, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = inbox.find(predicate);
    if (hit) return hit;
    await sleep(30);
  }
  return null;
}

const typesOf = (inbox) => inbox.map((m) => m.type).join(',');

// ============================================================
console.log('--- 1. 探活接口 ---');
{
  const res = await fetch(`${HTTP}/api/ping`);
  const json = await res.json();
  check('GET /api/ping 返回 200', res.status === 200, `status=${res.status}`);
  check('返回 pong', json?.message === 'pong', JSON.stringify(json));
}

console.log('--- 2. 第一个客户端连上：应收到 history / members / system ---');
const a = await openWS({ nickname: '小明' });
await sleep(300);

check('收到了 history', !!a.inbox.find((m) => m.type === 'history'), `实际收到: ${typesOf(a.inbox)}`);
check('收到了 members', !!a.inbox.find((m) => m.type === 'members'), `实际收到: ${typesOf(a.inbox)}`);
check('收到了 system 上线提示', !!a.inbox.find((m) => m.type === 'system'), `实际收到: ${typesOf(a.inbox)}`);

const hist0 = a.inbox.find((m) => m.type === 'history');
check('首次连接 history 是空数组', Array.isArray(hist0?.messages) && hist0.messages.length === 0, JSON.stringify(hist0));

console.log('--- 3. 第二个客户端连上：第一个应看到成员变化 ---');
const b = await openWS({ nickname: '小红' });
await sleep(400);

const membersMsg = await waitFor(a.inbox, (m) => m.type === 'members' && m.members?.length === 2);
check('小明 收到了含 2 人的成员列表', !!membersMsg, `成员消息: ${JSON.stringify(a.inbox.filter((m) => m.type === 'members'))}`);
check('成员列表里有小明和小红', membersMsg?.members?.includes('小明') && membersMsg?.members?.includes('小红'), JSON.stringify(membersMsg?.members));
check('成员列表已排序', JSON.stringify(membersMsg?.members) === JSON.stringify([...membersMsg.members].sort()), JSON.stringify(membersMsg?.members));

console.log('--- 4. 广播：小明发消息，两边都应收到 ---');
a.ws.send(JSON.stringify({ type: 'chat', content: '大家好' }));
const msgA = await waitFor(a.inbox, (m) => m.type === 'message');
const msgB = await waitFor(b.inbox, (m) => m.type === 'message');
check('发送者自己收到了这条消息', !!msgA, `inbox: ${typesOf(a.inbox)}`);
check('另一个客户端也收到了（广播生效）', !!msgB, `inbox: ${typesOf(b.inbox)}`);
check('服务端分配了自增 ID', msgA?.message?.id === 1, `id=${msgA?.message?.id}`);
check('发送者昵称正确', msgA?.message?.sender === '小明', `sender=${msgA?.message?.sender}`);
check('正文正确', msgA?.message?.content === '大家好', `content=${msgA?.message?.content}`);
check('带服务端盖章的时间', typeof msgA?.message?.createdAt === 'string', `createdAt=${msgA?.message?.createdAt}`);

console.log('--- 5. 两条消息后检查历史 ---');
b.ws.send(JSON.stringify({ type: 'chat', content: '你好呀' }));
await waitFor(b.inbox, (m) => m.type === 'message' && m.message?.id === 2);
await sleep(200);

{
  const res = await fetch(`${HTTP}/api/messages`);
  const json = await res.json();
  check('GET /api/messages 返回 200', res.status === 200, `status=${res.status}`);
  check('历史里有 2 条', json?.messages?.length === 2, `len=${json?.messages?.length}`);
  check('按 ID 升序', json?.messages?.[0]?.id === 1 && json?.messages?.[1]?.id === 2, JSON.stringify(json?.messages?.map((m) => m.id)));
}

console.log('--- 6. 断线重连：带 since 只补新消息 ---');
{
  const c = await openWS({ nickname: '小明', since: 1 });
  await sleep(400);
  const hist = c.inbox.find((m) => m.type === 'history');
  check('since=1 时历史只有 1 条', hist?.messages?.length === 1, `len=${hist?.messages?.length}`);
  check('补的确实是 ID=2', hist?.messages?.[0]?.id === 2, `id=${hist?.messages?.[0]?.id}`);
  c.ws.close();
  await sleep(300);
}

console.log('--- 7. 空消息不该入库 ---');
{
  const before = (await (await fetch(`${HTTP}/api/messages`)).json()).messages.length;
  b.ws.send(JSON.stringify({ type: 'chat', content: '   ' }));
  await sleep(400);
  const after = (await (await fetch(`${HTTP}/api/messages`)).json()).messages.length;
  check('空白消息被丢弃，历史条数没变', before === after, `${before} -> ${after}`);
}

console.log('--- 8. 畸形 JSON 不该断开连接 ---');
{
  b.ws.send('这不是 JSON');
  await sleep(300);
  b.ws.send(JSON.stringify({ type: 'chat', content: 'still-alive' }));
  const alive = await waitFor(b.inbox, (m) => m.message?.content === 'still-alive');
  check('发了畸形数据后连接仍然可用', !!alive, '连接似乎已断开');
}

console.log('--- 9. 断开后应广播下线并更新成员 ---');
{
  const beforeClose = a.inbox.length;
  b.ws.close();
  await sleep(700);
  const afterClose = a.inbox.slice(beforeClose);
  const left = afterClose.find((m) => m.type === 'system' && m.text?.includes('离开'));
  const members1 = afterClose.find((m) => m.type === 'members');
  check('小明 收到了"离开"的系统提示', !!left, `新消息: ${typesOf(afterClose)}`);
  check('成员列表更新为 1 人', members1?.members?.length === 1, JSON.stringify(members1?.members));
}

a.ws.close();
await sleep(300);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
