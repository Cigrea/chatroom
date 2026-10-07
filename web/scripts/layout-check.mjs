// 移动端布局自动化检查：用真实浏览器在多种宽度下渲染页面、测量元素位置。
//
// 为什么需要它：类型检查和打包检查都查不出"布局塌了"这类问题——
// 元素溢出、输入框被挤没、侧边栏收不起来、消息一多顶栏和输入框被滚走，
// 只有真的渲染一遍才能发现。指南里专门提醒过"窗口拉到手机宽度时页面会不会塌"。
//
// 用法：
//   1. 起后端：  cd server && go run .
//   2. 起前端：  cd web && npm run dev
//   3. 装驱动：  cd web && npm i -D puppeteer-core
//   4. 跑检查：  cd web && node scripts/layout-check.mjs
//
// 它会用系统里已经装好的 Chrome 或 Edge（不额外下载浏览器），
// 在 375 / 320 / 500 / 1280 四种宽度下跑 50+ 项检查，
// 并把截图存到 docs/screenshots/。
//
// 环境变量（都可选）：
//   APP_URL     前端地址，默认 http://127.0.0.1:5173
//   SHOTS_DIR   截图输出目录，默认 <仓库>/docs/screenshots
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 自动在常见位置找 Chrome / Edge */
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const CHROME = BROWSER_CANDIDATES.find((p) => fs.existsSync(p))
if (!CHROME) {
  console.error('没找到 Chrome 或 Edge，请修改脚本顶部的 BROWSER_CANDIDATES')
  process.exit(1)
}

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5173'

// 截图默认存到仓库的 docs/screenshots。
// 用相对本文件的位置算出来而不是写死绝对路径，这样换台电脑也能跑。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = process.env.SHOTS_DIR ?? path.resolve(HERE, '../../docs/screenshots')

fs.mkdirSync(SHOTS, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})

/** 量一次页面上所有关心的元素 */
async function measure(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const box = (s) => {
      const el = q(s)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        width: Math.round(r.width),
        height: Math.round(r.height),
        display: cs.display,
      }
    }
    return {
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: window.innerHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      input: box('.composer input'),
      sendBtn: box('.composer button'),
      composer: box('.composer'),
      sidebar: box('.sidebar'),
      menuBtn: box('.menu-btn'),
      themeBtn: box('.chat-head .icon-btn:not(.menu-btn)'),
      bubble: box('.bubble'),
    }
  })
}

/** 打开页面、输入昵称、进入聊天室 */
async function enter(page, nickname) {
  // ★ 明确把"系统主题偏好"设成亮色。
  //   不设的话，初始主题取决于 headless Chrome 的默认值，
  //   而且上一轮测试留在 localStorage 里的偏好也会串进来——
  //   断言必须建立在确定的前提上。
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])

  await page.goto(APP, { waitUntil: 'domcontentloaded' })

  // ★ 必须先清掉 localStorage 再刷新。
  //   因为浏览器同一个 origin 共享存储，上一条用例存过昵称之后，
  //   新页面会直接自动进入聊天室，根本不会出现昵称输入页。
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })

  await page.waitForSelector('.gate-card input', { timeout: 8000 })
  await page.click('.gate-card input')
  await page.type('.gate-card input', nickname)
  await page.click('.gate-form button[type="submit"]')
  await page.waitForSelector('.app', { timeout: 8000 })
  // 等 WebSocket 连上，状态变成"已连接"
  await page.waitForFunction(
    () => document.querySelector('.state')?.textContent?.includes('已连接'),
    { timeout: 8000 },
  )
  await sleep(300)
}

// ============================================================
console.log('=== A. 手机竖屏 375 x 667 ===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await enter(page, '手机用户')

  const m = await measure(page)
  console.log('  实测:', JSON.stringify({
    vw: m.viewportWidth, docScrollW: m.docScrollWidth,
    input: m.input, sendBtn: m.sendBtn, sidebar: m.sidebar, menuBtn: m.menuBtn,
  }, null, 0))

  check('页面没有横向溢出', m.docScrollWidth <= m.viewportWidth + 1, `scrollWidth=${m.docScrollWidth} > ${m.viewportWidth}`)
  check('输入框没被挤没（宽度 > 120px）', m.input && m.input.width > 120, `width=${m.input?.width}`)
  check('输入框左边缘没有跑到屏幕外', m.input && m.input.left >= 0, `left=${m.input?.left}`)
  check('发送按钮在视口内（没被挤出去）', m.sendBtn && m.sendBtn.right <= m.viewportWidth, `right=${m.sendBtn?.right} vw=${m.viewportWidth}`)
  check('输入框和发送按钮在同一行', m.input && m.sendBtn && Math.abs(m.input.top - m.sendBtn.top) < 10, `input.top=${m.input?.top} btn.top=${m.sendBtn?.top}`)
  check('侧边栏默认收起（藏在屏幕外）', m.sidebar && m.sidebar.right <= 0, `sidebar.right=${m.sidebar?.right}`)
  check('☰ 菜单按钮在窄屏可见', m.menuBtn && m.menuBtn.display !== 'none', `display=${m.menuBtn?.display}`)
  check('☰ 按钮够大（触屏可点，≥40px）', m.menuBtn && m.menuBtn.width >= 40 && m.menuBtn.height >= 40, `${m.menuBtn?.width}x${m.menuBtn?.height}`)
  check('底部输入区在视口内（没被顶出屏幕）', m.composer && m.composer.bottom <= m.viewportHeight + 1, `composer.bottom=${m.composer?.bottom} vh=${m.viewportHeight}`)
  check('气泡没超出可视宽度', !m.bubble || m.bubble.right <= m.viewportWidth, `bubble.right=${m.bubble?.right}`)

  await page.screenshot({ path: `${SHOTS}/mobile-light-chat.png` })

  // 点开抽屉
  await page.click('.menu-btn')
  await sleep(450)
  const m2 = await measure(page)
  check('点 ☰ 后侧边栏滑入（左边缘 >= 0）', m2.sidebar && m2.sidebar.left >= 0, `sidebar.left=${m2.sidebar?.left}`)
  check('抽屉打开后仍然没有横向溢出', m2.docScrollWidth <= m2.viewportWidth + 1, `scrollWidth=${m2.docScrollWidth}`)
  await page.screenshot({ path: `${SHOTS}/mobile-drawer-open.png` })

  // 点遮罩关闭。
  // ★ 不能用 page.click('.backdrop')：遮罩是 inset:0 铺满全屏，
  //   puppeteer 会点它的几何中心，而那个位置正好被 240px 宽的抽屉盖住，
  //   结果点到了抽屉上。真实用户点的是抽屉右边那块，所以这里直接指定坐标。
  await page.mouse.click(330, 340)
  await sleep(450)
  const m3 = await measure(page)
  check('点遮罩后侧边栏收起', m3.sidebar && m3.sidebar.right <= 0, `sidebar.right=${m3.sidebar?.right}`)

  // 窄屏用**真实触摸点击**（真实用户在手机上就是这么点的）
  const btnBox = await page.evaluate(() => {
    const el = document.querySelector('.chat-head .icon-btn:not(.menu-btn)')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      cx: Math.round(r.left + r.width / 2),
      cy: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
    }
  })
  console.log('  主题按钮:', JSON.stringify(btnBox))

  // ★ 断言"变化"，不要断言"等于某个值"。
  //
  //   这里之前写的是 check(theme === 'dark')，结果误报失败：
  //   因为点击前主题本来就是 dark（上一轮测试留下的偏好），
  //   点一下就正确变成了 light。
  //
  //   教训：测试里凡是"操作会引起状态变化"，就先记下操作前的值，
  //   再断言前后不同。断言绝对状态等于把测试和被测量的初始条件绑死。
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme)
  await page.touchscreen.tap(btnBox.cx, btnBox.cy)
  await sleep(400)
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme)
  check(
    '窄屏触摸点击能切换主题',
    themeBefore !== themeAfter,
    `${themeBefore} -> ${themeAfter}（没有变化）`,
  )

  // 截图前确保是暗色
  await page.evaluate(() => {
    if (document.documentElement.dataset.theme !== 'dark') {
      document.querySelector('.chat-head .icon-btn:not(.menu-btn)')?.click()
    }
  })
  await sleep(300)
  const themeForShot = await page.evaluate(() => document.documentElement.dataset.theme)
  check('截图时确实是暗色', themeForShot === 'dark', `theme=${themeForShot}`)
  await page.screenshot({ path: `${SHOTS}/mobile-dark-chat.png` })

  await page.close()
}

console.log('=== B. 手机竖屏 320 x 568（更极端，iPhone SE 一代）===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await enter(page, '小屏用户')
  const m = await measure(page)
  check('320px 宽也没有横向溢出', m.docScrollWidth <= m.viewportWidth + 1, `scrollWidth=${m.docScrollWidth}`)
  check('320px 下输入框仍可用（>100px）', m.input && m.input.width > 100, `width=${m.input?.width}`)
  check('320px 下发送按钮仍在视口内', m.sendBtn && m.sendBtn.right <= m.viewportWidth, `right=${m.sendBtn?.right}`)
  await page.screenshot({ path: `${SHOTS}/mobile-320.png` })
  await page.close()
}

console.log('=== C. 窄窗口 500 x 700（部长拖窄浏览器窗口）===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 500, height: 700 })
  await enter(page, '窄窗口')
  const m = await measure(page)
  check('500px 宽没有横向溢出', m.docScrollWidth <= m.viewportWidth + 1, `scrollWidth=${m.docScrollWidth}`)
  check('500px 宽输入框可用', m.input && m.input.width > 200, `width=${m.input?.width}`)
  await page.close()
}

console.log('=== D. 桌面 1280 x 800（确认没改坏桌面布局）===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await enter(page, '桌面用户')
  const m = await measure(page)
  check('桌面端没有横向溢出', m.docScrollWidth <= m.viewportWidth + 1, `scrollWidth=${m.docScrollWidth}`)
  check('桌面端侧边栏常驻可见', m.sidebar && m.sidebar.left === 0 && m.sidebar.width === 220, `left=${m.sidebar?.left} width=${m.sidebar?.width}`)
  check('桌面端不显示 ☰ 菜单按钮', m.menuBtn && m.menuBtn.display === 'none', `display=${m.menuBtn?.display}`)
  check('桌面端输入框很宽', m.input && m.input.width > 600, `width=${m.input?.width}`)

  // 桌面端没有触摸模拟，用真实鼠标点击验证主题按钮。
  // 这一步是为了区分：窄屏那次鼠标点击失效到底是
  // "按钮/逻辑有问题" 还是 "puppeteer 触摸模拟的命中测试问题"。
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme)
  await page.click('.chat-head .icon-btn:not(.menu-btn)')
  await sleep(400)
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme)
  check(
    '桌面端鼠标点击能切换主题',
    themeBefore !== themeAfter,
    `${themeBefore} -> ${themeAfter}`,
  )
  await page.screenshot({ path: `${SHOTS}/desktop-dark.png` })

  await page.screenshot({ path: `${SHOTS}/desktop-chat.png` })
  await page.close()
}

console.log('=== E. 昵称输入页的小屏表现 ===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.gate-card', { timeout: 8000 })
  const g = await page.evaluate(() => {
    const card = document.querySelector('.gate-card').getBoundingClientRect()
    return {
      vw: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      card: { left: Math.round(card.left), right: Math.round(card.right), width: Math.round(card.width) },
    }
  })
  check('昵称卡片没超出屏幕', g.card.left >= 0 && g.card.right <= g.vw, JSON.stringify(g.card))
  check('昵称页没有横向溢出', g.scrollW <= g.vw + 1, `scrollWidth=${g.scrollW}`)
  await page.screenshot({ path: `${SHOTS}/mobile-gate.png` })
  await page.close()
}

console.log('=== F. 刷新后自动进入（就是这次修的那个昵称问题）===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })

  // 首次访问：必须出现昵称输入页
  await page.waitForSelector('.gate-card input', { timeout: 8000 })
  check('首次访问显示昵称输入页', true)

  await page.click('.gate-card input')
  await page.type('.gate-card input', '刷新测试')
  await page.click('.gate-form button[type="submit"]')
  await page.waitForSelector('.app', { timeout: 8000 })
  await sleep(400)

  // ★ 刷新：应该直接回到聊天室，不再要求输昵称
  await page.reload({ waitUntil: 'domcontentloaded' })
  const gateAfterRefresh = await page.$('.gate-card')
  check('刷新后不再出现昵称输入页', gateAfterRefresh === null, '仍然显示了输入页')
  await page.waitForSelector('.app', { timeout: 5000 })
  check('刷新后直接回到聊天室', true)

  // 自动重连
  await page.waitForFunction(
    () => document.querySelector('.state')?.textContent?.includes('已连接'),
    { timeout: 8000 },
  )
  check('刷新后自动重连成功', true)

  // 昵称还是本人：成员列表里应该有自己的「我」标记
  const hasMe = await page.evaluate(() => !!document.querySelector('.member-list .tag'))
  check('刷新后昵称仍然是本人', hasMe, '成员列表里没找到「我」标记')

  // 「切换昵称」能回到输入页。
  // ★ 注意它住在侧边栏里，而窄屏下侧边栏默认是收起的（在屏幕外点不到），
  //   所以必须先点 ☰ 把抽屉拉开——这本身也验证了抽屉是正常工作的。
  await page.click('.menu-btn')
  await sleep(450)
  await page.click('.leave-btn')
  await sleep(450)
  const gateBack = await page.$('.gate-card')
  check('点「切换昵称」能回到输入页', gateBack !== null, '没有回到输入页')

  // 回到输入页后，输入框里的昵称应该已被清掉
  const cleared = await page.evaluate(() => document.querySelector('.gate-card input')?.value ?? null)
  check('切换昵称后输入框已清空', cleared === '', `value=${JSON.stringify(cleared)}`)

  await page.screenshot({ path: `${SHOTS}/mobile-after-refresh.png` })
  await page.close()
}

console.log('=== G. 主题真的改变了"画出来的颜色"吗 ===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await enter(page, '配色检查')

  /** 直接写死主题偏好再刷新，避免依赖点击顺序 */
  async function setTheme(t) {
    await page.evaluate((v) => localStorage.setItem('chatroom-theme', v), t)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app', { timeout: 8000 })
    await sleep(400)
  }

  /** 读出几个关键元素实际渲染出来的颜色 */
  const readColors = () =>
    page.evaluate(() => {
      const bg = (sel) => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el).backgroundColor : null
      }
      return {
        theme: document.documentElement.dataset.theme,
        body: getComputedStyle(document.body).backgroundColor,
        bodyText: getComputedStyle(document.body).color,
        sidebar: bg('.sidebar'),
        bubble: bg('.bubble'),
      }
    })

  /** 把 "rgb(r, g, b)" 换算成感知亮度，用来判断"到底暗不暗" */
  const lum = (rgb) => {
    const m = rgb.match(/\d+/g)
    if (!m) return -1
    const [r, g, b] = m.map(Number)
    return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
  }

  await setTheme('light')
  const light = await readColors()
  await setTheme('dark')
  const dark = await readColors()

  console.log('  亮色:', JSON.stringify(light))
  console.log('  暗色:', JSON.stringify(dark))

  check('切到 dark 后 data-theme 确实是 dark', dark.theme === 'dark', `theme=${dark.theme}`)
  check(
    '亮暗两套配色确实不同（说明 CSS 变量被应用了，不是只改了属性）',
    light.body !== dark.body,
    `light.body=${light.body} dark.body=${dark.body}`,
  )
  check('亮色下页面背景确实亮（亮度 > 200）', lum(light.body) > 200, `亮度=${lum(light.body)}`)
  check('暗色下页面背景确实暗（亮度 < 80）', lum(dark.body) < 80, `亮度=${lum(dark.body)}`)
  check('暗色下侧边栏也跟着变暗', lum(dark.sidebar) < lum(light.sidebar), `${lum(light.sidebar)} -> ${lum(dark.sidebar)}`)
  check('暗色下文字颜色的亮度高于背景（保证可读）', lum(dark.bodyText) > lum(dark.body) + 40, `文字=${lum(dark.bodyText)} 背景=${lum(dark.body)}`)
  check('亮色下文字颜色的亮度低于背景（保证可读）', lum(light.bodyText) < lum(light.body) - 40, `文字=${lum(light.bodyText)} 背景=${lum(light.body)}`)

  await page.close()
}

// ============================================================
// 下面两个用例是补上之前测试的覆盖漏洞。
//
// 之前的用例都只发了几条消息、只有一两个成员，
// 页面上根本没有内容需要滚动，所以"消息一多顶栏和输入框被滚走"
// 这个 bug 完全没被触发。这提醒一件事：
// **布局测试必须构造出"内容溢出"的状态**，否则等于没测。
// ============================================================

/** 用一个独立的 WebSocket 连接灌消息，浏览器那个页面会通过广播收到 */
async function spam(wsUrl, nickname, count) {
  const ws = new WebSocket(
    `${wsUrl}/ws?nickname=${encodeURIComponent(nickname)}&since=0`,
  )
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('灌水连接失败')))
    setTimeout(() => rej(new Error('连接超时')), 6000)
  })
  for (let i = 1; i <= count; i++) {
    ws.send(
      JSON.stringify({
        type: 'chat',
        content: `第 ${i} 条灌水消息 —— 这句特意写长一点，用来把消息区撑出滚动条`,
      }),
    )
    await sleep(12)
  }
  await sleep(600)
  return ws
}

console.log('=== H. 消息很多时，顶栏和输入框会不会被滚走 ===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await enter(page, '长对话用户')

  const spammer = await spam(
    APP.replace(/^http/, 'ws').replace(/\/$/, ''),
    '灌水机',
    45,
  )
  await sleep(1200)

  const measureScroll = () =>
    page.evaluate(() => {
      const box = (s) => {
        const el = document.querySelector(s)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) }
      }
      const list = document.querySelector('.messages')
      return {
        viewportH: window.innerHeight,
        docScrollH: document.documentElement.scrollHeight,
        bodyScrollH: document.body.scrollHeight,
        list: {
          scrollTop: Math.round(list.scrollTop),
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
        },
        head: box('.chat-head'),
        composer: box('.composer'),
      }
    })

  const m = await measureScroll()
  console.log('  实测:', JSON.stringify(m))

  check(
    '消息确实多到需要滚动（构造出了溢出状态）',
    m.list.scrollHeight > m.list.clientHeight + 50,
    `内容高=${m.list.scrollHeight} 容器高=${m.list.clientHeight}`,
  )
  check(
    '★ 页面本身没有被撑高（不会整页滚动）',
    m.docScrollH <= m.viewportH + 1,
    `docScrollH=${m.docScrollH} > 视口高=${m.viewportH}`,
  )
  check('★ 顶栏仍在视口内', m.head && m.head.top >= 0 && m.head.bottom <= m.viewportH, JSON.stringify(m.head))
  check(
    '★ 输入框仍在视口内',
    m.composer && m.composer.top >= 0 && m.composer.bottom <= m.viewportH + 1,
    JSON.stringify(m.composer),
  )
  check('滚动发生在消息列表自己内部', m.list.scrollTop > 0, `scrollTop=${m.list.scrollTop}`)

  // 再把列表滚到最上面，顶栏和输入框依然不该动
  await page.evaluate(() => {
    document.querySelector('.messages').scrollTop = 0
  })
  await sleep(300)
  const m2 = await measureScroll()
  check('把消息滚到顶后，顶栏位置没变', m2.head?.top === m.head?.top, `${m.head?.top} -> ${m2.head?.top}`)
  check('把消息滚到顶后，输入框位置没变', m2.composer?.bottom === m.composer?.bottom, `${m.composer?.bottom} -> ${m2.composer?.bottom}`)
  check('滚到顶后页面依然没有整页滚动', m2.docScrollH <= m2.viewportH + 1, `docScrollH=${m2.docScrollH}`)

  await page.screenshot({ path: `${SHOTS}/mobile-long-conversation.png` })
  spammer.close()
  await page.close()
}

console.log('=== I. 在线成员很多时，侧栏的「切换昵称」会不会被挤走 ===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await enter(page, '人多测试')

  // 另外开 30 个连接，把在线成员列表堆到**一定**超出可视高度。
  //
  // 之前只开 15 个，17 个成员约 630px 刚好塞进 638px 的可用高度，
  // 列表压根没溢出，断言"列表自己出滚动条"自然不成立。
  // 教训同上：构造溢出状态要构造够，否则这个测试是空的。
  const extras = []
  for (let i = 1; i <= 30; i++) {
    const ws = new WebSocket(`${APP.replace(/^http/, 'ws')}/ws?nickname=${encodeURIComponent('路人' + i)}&since=0`)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', () => rej(new Error('连接失败')))
      setTimeout(() => rej(new Error('超时')), 6000)
    })
    extras.push(ws)
  }
  await sleep(2000)

  const m = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar')
    const list = document.querySelector('.member-list')
    const btn = document.querySelector('.leave-btn')
    const br = btn.getBoundingClientRect()
    return {
      viewportH: window.innerHeight,
      docScrollH: document.documentElement.scrollHeight,
      memberCount: document.querySelectorAll('.member-list li').length,
      list: { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight },
      sidebar: { scrollHeight: sidebar.scrollHeight, clientHeight: sidebar.clientHeight },
      leaveBtn: { top: Math.round(br.top), bottom: Math.round(br.bottom) },
    }
  })
  console.log('  实测:', JSON.stringify(m))

  check('在线成员确实很多（构造出了溢出状态）', m.memberCount >= 31, `成员数=${m.memberCount}`)
  check('成员列表自己出了滚动条', m.list.scrollHeight > m.list.clientHeight + 5, `内容高=${m.list.scrollHeight} 容器高=${m.list.clientHeight}`)
  check(
    '★ 侧栏本身不滚动（滚动只发生在列表内部）',
    m.sidebar.scrollHeight <= m.sidebar.clientHeight + 1,
    `侧栏内容高=${m.sidebar.scrollHeight} 容器高=${m.sidebar.clientHeight}`,
  )
  check(
    '★「切换昵称」按钮仍固定在视口底部可见',
    m.leaveBtn.top >= 0 && m.leaveBtn.bottom <= m.viewportH + 1,
    JSON.stringify(m.leaveBtn),
  )
  check('页面没有被成员列表撑高', m.docScrollH <= m.viewportH + 1, `docScrollH=${m.docScrollH}`)

  await page.screenshot({ path: `${SHOTS}/desktop-many-members.png` })
  extras.forEach((ws) => ws.close())
  await page.close()
}

console.log('=== J. 界面细节：圆角、时间位置、气泡对比度、标题字号 ===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await enter(page, '细节检查')

  // 用一个外部连接发消息。
  // 发两条：一条是"别人"的（细节甲），一条是"自己"的（昵称和页面一样，
  // isMine 判断的是昵称相同，所以它会渲染成靠右的"我的气泡"）。
  const site = await page.evaluate(() => location.origin)
  async function connect(nickname) {
    const ws = new WebSocket(`${site.replace(/^http/, 'ws')}/ws?nickname=${encodeURIComponent(nickname)}&since=0`)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', () => rej(new Error('连接失败')))
      setTimeout(() => rej(new Error('超时')), 6000)
    })
    return ws
  }

  const other = await connect('细节甲')
  const mine = await connect('细节检查')

  // 别人的消息：带一个显式换行，最后一行很短
  // ——这样就能验证时间落在**第二行**，而不是另起第三行
  other.send(
    JSON.stringify({
      type: 'chat',
      content: '这是第一行，故意写得长一点用来占满整行看看换行效果如何\n第二行短',
    }),
  )
  await sleep(500)
  // 自己的消息：单行，验证时间贴在同一行右端
  mine.send(JSON.stringify({ type: 'chat', content: '好的' }))
  await sleep(900)

  const m = await page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect()
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
    }
    /**
     * 取一个元素里**每一行**的矩形。
     * Range.getClientRects() 会按行盒返回，所以数组最后一个就是最后一行。
     * 这是判断"时间到底在第几行"的关键工具。
     */
    const linesOf = (el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return [...range.getClientRects()].map((r) => ({
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
      }))
    }
    const lum = (rgb) => {
      const n = rgb.match(/\d+/g)
      if (!n) return -1
      const [r, g, b] = n.map(Number)
      return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    }

    const bubbles = [...document.querySelectorAll('.bubble')]

    /*
     * ★ 不能假设"第 0 个气泡"就是刚发的那条。
     *   页面加载时会收到历史消息，服务端数据库里可能有很久以前的记录，
     *   所以必须**按内容**把目标气泡找出来。
     *   （这正是之前那次误报的原因：量到了一条老消息，它只有一行。）
     */
    const findBubble = (needle) =>
      bubbles.find((b) => b.querySelector('.text')?.textContent?.includes(needle))

    const otherBubble = findBubble('第二行短')
    const mineBubble = bubbles[bubbles.length - 1]

    const otherText = otherBubble.querySelector('.text')
    const otherLines = linesOf(otherText)

    return {
      bubble: box(otherBubble),
      mineBubble: box(mineBubble),
      sender: box(otherBubble.querySelector('.sender')),
      text: box(otherText),
      time: box(otherBubble.querySelector('.time')),
      mineTime: box(mineBubble.querySelector('.time')),
      // 正文每一行的位置
      lineCount: otherLines.length,
      lastLine: otherLines[otherLines.length - 1],
      firstLine: otherLines[0],

      bubbleRadius: getComputedStyle(otherBubble).borderTopLeftRadius,
      inputRadius: getComputedStyle(document.querySelector('.composer input')).borderTopLeftRadius,
      buttonRadius: getComputedStyle(document.querySelector('.composer button')).borderTopLeftRadius,

      // 颜色：页面底色 / 别人的气泡 / 自己的气泡
      pageBg: getComputedStyle(document.body).backgroundColor,
      bubbleBg: getComputedStyle(otherBubble).backgroundColor,
      mineBg: getComputedStyle(mineBubble).backgroundColor,
      bubbleBorder: getComputedStyle(otherBubble).borderTopColor,
      lumPage: lum(getComputedStyle(document.body).backgroundColor),
      lumBubble: lum(getComputedStyle(otherBubble).backgroundColor),
      lumMine: lum(getComputedStyle(mineBubble).backgroundColor),

      h2Font: getComputedStyle(document.querySelector('.sidebar h2')).fontSize,
      h2Weight: getComputedStyle(document.querySelector('.sidebar h2')).fontWeight,
      lobbyFont: getComputedStyle(document.querySelector('.chat-head strong')).fontSize,
      lobbyWeight: getComputedStyle(document.querySelector('.chat-head strong')).fontWeight,
      contentFont: getComputedStyle(otherText).fontSize,
    }
  })
  console.log('  实测:', JSON.stringify(m))

  const px = (s) => parseFloat(s)

  // ---- 圆角 ----
  check('气泡圆角足够大（≥ 18px）', px(m.bubbleRadius) >= 18, `border-radius=${m.bubbleRadius}`)
  check('输入框圆角足够大（≥ 12px）', px(m.inputRadius) >= 12, `border-radius=${m.inputRadius}`)
  check(
    '按钮圆角和输入框一致（说明用了同一个令牌）',
    m.buttonRadius === m.inputRadius,
    `input=${m.inputRadius} button=${m.buttonRadius}`,
  )

  // ---- 时间位置：必须在正文最后一行，而不是下一行 ----
  check('那条消息确实换行了（验证多行场景）', m.lineCount >= 2, `行数=${m.lineCount}`)

  const timeCenter = (m.time.top + m.time.bottom) / 2
  const lastLineCenter = (m.lastLine.top + m.lastLine.bottom) / 2
  check(
    '★ 时间和正文**最后一行**在同一行（垂直位置重合）',
    m.time.top < m.lastLine.bottom && m.time.bottom > m.lastLine.top,
    `时间 ${m.time.top}~${m.time.bottom}，最后一行 ${m.lastLine.top}~${m.lastLine.bottom}`,
  )
  check(
    '★ 时间没有跑到最后一行**下面**',
    m.time.bottom <= m.lastLine.bottom + 2,
    `时间底部=${m.time.bottom} 最后一行底部=${m.lastLine.bottom}`,
  )
  check(
    '时间和最后一行垂直居中对齐（不是偏上或偏下）',
    Math.abs(timeCenter - lastLineCenter) <= 6,
    `时间中心=${Math.round(timeCenter)} 行中心=${Math.round(lastLineCenter)}`,
  )
  check(
    '时间**没有**落在第一行（说明它跟着最后一行走，不是浮在第一行）',
    m.time.top >= m.firstLine.bottom - 2,
    `时间顶部=${m.time.top} 第一行底部=${m.firstLine.bottom}`,
  )
  check(
    '时间靠右（右边缘贴近气泡内边）',
    m.bubble.right - m.time.right < 20,
    `距右边 ${m.bubble.right - m.time.right}px`,
  )
  check('昵称在正文上方', m.sender.bottom <= m.text.top + 2, `sender.bottom=${m.sender.bottom} text.top=${m.text.top}`)

  // 单行的"我的"消息：时间也应该在同一行
  const mineTimeCenter = (m.mineTime.top + m.mineTime.bottom) / 2
  const mineBubbleCenter = (m.mineBubble.top + m.mineBubble.bottom) / 2
  check(
    '单行消息里时间也在正文那一行（贴近气泡下半部）',
    mineTimeCenter > mineBubbleCenter,
    `时间中心=${Math.round(mineTimeCenter)} 气泡中心=${Math.round(mineBubbleCenter)}`,
  )

  // ---- 气泡与背景的对比度 ----
  const dPageBubble = Math.abs(m.lumPage - m.lumBubble)
  const dBubbleMine = Math.abs(m.lumBubble - m.lumMine)
  console.log(`  亮度: 页面=${m.lumPage} 别人的气泡=${m.lumBubble} 自己的气泡=${m.lumMine}`)
  check(
    '★ 气泡和页面底色有明显的亮度差（≥ 8，不再"糊在一起"）',
    dPageBubble >= 8,
    `亮度差只有 ${dPageBubble}`,
  )
  check(
    '★ 自己的气泡和别人的气泡也能区分（亮度差 ≥ 6）',
    dBubbleMine >= 6,
    `亮度差只有 ${dBubbleMine}`,
  )
  check('气泡有可见的描边', m.bubbleBorder !== 'rgba(0, 0, 0, 0)' && m.bubbleBorder !== 'transparent', `border-color=${m.bubbleBorder}`)

  // ---- 标题字号字重 ----
  check('「在线成员」字号足够大（≥ 15px）', px(m.h2Font) >= 15, `font-size=${m.h2Font}`)
  check('「在线成员」是加粗的', Number(m.h2Weight) >= 700, `font-weight=${m.h2Weight}`)
  check('「大厅」字号足够大（≥ 18px）', px(m.lobbyFont) >= 18, `font-size=${m.lobbyFont}`)
  check('「大厅」是加粗的', Number(m.lobbyWeight) >= 700, `font-weight=${m.lobbyWeight}`)
  check(
    '「大厅」明显大于消息正文（区分出信息层级）',
    px(m.lobbyFont) > px(m.contentFont) + 2,
    `大厅=${m.lobbyFont} 正文=${m.contentFont}`,
  )

  await page.screenshot({ path: `${SHOTS}/desktop-bubble-detail.png` })

  // ---- 暗色下也量一遍对比度 ----
  await page.evaluate(() => localStorage.setItem('chatroom-theme', 'dark'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app', { timeout: 8000 })
  await sleep(900)
  const d = await page.evaluate(() => {
    const lum = (rgb) => {
      const n = rgb.match(/\d+/g)
      if (!n) return -1
      const [r, g, b] = n.map(Number)
      return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    }
    const bs = [...document.querySelectorAll('.bubble')]
    return {
      lumPage: lum(getComputedStyle(document.body).backgroundColor),
      lumBubble: lum(getComputedStyle(bs[0]).backgroundColor),
      lumMine: lum(getComputedStyle(bs[bs.length - 1]).backgroundColor),
    }
  })
  console.log(`  暗色亮度: 页面=${d.lumPage} 别人的气泡=${d.lumBubble} 自己的气泡=${d.lumMine}`)
  check(
    '暗色下气泡和页面也有亮度差（≥ 8）',
    Math.abs(d.lumPage - d.lumBubble) >= 8,
    `亮度差只有 ${Math.abs(d.lumPage - d.lumBubble)}`,
  )
  check(
    '暗色下自己的气泡也能区分（≥ 8）',
    Math.abs(d.lumBubble - d.lumMine) >= 8,
    `亮度差只有 ${Math.abs(d.lumBubble - d.lumMine)}`,
  )
  await page.screenshot({ path: `${SHOTS}/desktop-bubble-detail-dark.png` })

  other.close()
  mine.close()
  await page.close()
}

console.log('=== K. 气泡宽度自适应 + 昵称按规则配色 ===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await enter(page, '宽度检查')

  const site = await page.evaluate(() => location.origin)
  async function open(nickname) {
    const ws = new WebSocket(
      `${site.replace(/^http/, 'ws')}/ws?nickname=${encodeURIComponent(nickname)}&since=0`,
    )
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', () => rej(new Error('连接失败')))
      setTimeout(() => rej(new Error('超时')), 6000)
    })
    return ws
  }

  // 用【X】做标记，方便按内容精确找到目标气泡
  // （页面会加载历史消息，不能靠下标定位）
  const people = ['甲某', '乙某', '丙某', '丁某', '戊某']
  const sockets = []
  for (const p of people) sockets.push(await open(p))

  sockets[0].send(JSON.stringify({ type: 'chat', content: '【A1】短' }))
  await sleep(300)
  sockets[1].send(JSON.stringify({ type: 'chat', content: '【B1】' + '这是一条很长的消息'.repeat(6) }))
  await sleep(300)
  sockets[0].send(JSON.stringify({ type: 'chat', content: '【A2】同一个人再发一条' }))
  await sleep(300)
  sockets[2].send(JSON.stringify({ type: 'chat', content: '【C1】三个人' }))
  await sleep(300)
  sockets[3].send(JSON.stringify({ type: 'chat', content: '【D1】四个人' }))
  await sleep(300)
  sockets[4].send(JSON.stringify({ type: 'chat', content: '【E1】五个人' }))
  await sleep(900)

  const m = await page.evaluate((names) => {
    const bubbles = [...document.querySelectorAll('.bubble')]
    const find = (needle) =>
      bubbles.find((b) => b.querySelector('.text')?.textContent?.includes(needle))

    /** 取一个元素的宽度、昵称文字和昵称颜色（计算后的 rgb） */
    const info = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      const senderEl = el.querySelector('.sender')
      return {
        width: Math.round(r.width),
        sender: senderEl?.textContent?.trim(),
        color: senderEl ? getComputedStyle(senderEl).color : null,
      }
    }

    /**
     * 在页面里**复现**前端的哈希规则，用来验证"颜色确实是按这个规则算出来的"，
     * 而不只是"颜色看起来有区别"。
     *
     * ★ 这段必须和 App.vue 里的 nameColor 保持一致。
     *   改了那边就要改这边，否则测试会失败——这其实是好事，
     *   等于强迫两边同步。
     */
    const hashIndex = (name) => {
      // FNV-1a
      let hash = 2166136261
      for (let i = 0; i < name.length; i++) {
        hash ^= name.charCodeAt(i)
        hash = Math.imul(hash, 16777619) >>> 0
      }
      // murmur3 雪崩混洗。
      // 每步末尾的 >>> 0 不能漏：JS 的 ^ 返回带符号整数，
      // 漏了的话哈希可能是负数，取余也是负数，会拼出不存在的变量名。
      hash = (hash ^ (hash >>> 16)) >>> 0
      hash = Math.imul(hash, 0x85ebca6b) >>> 0
      hash = (hash ^ (hash >>> 13)) >>> 0
      hash = Math.imul(hash, 0xc2b2ae35) >>> 0
      hash = (hash ^ (hash >>> 16)) >>> 0
      return hash % 8
    }

    const expectedColor = (name) => {
      const index = hashIndex(name) + 1
      // 把 var(--name-N) 借一个临时元素解析成实际的 rgb，方便和计算样式比较
      const tmp = document.createElement('div')
      tmp.style.color = `var(--name-${index})`
      document.body.appendChild(tmp)
      const rgb = getComputedStyle(tmp).color
      tmp.remove()
      return { index, rgb }
    }

    /*
     * 分散度检验：用一批合成昵称看哈希能不能铺满 8 个色号。
     *
     * 为什么要单独测这个：**光看"5 个人有 2 种颜色"是不够的**——
     * 那可能只是碰巧，也可能说明哈希质量真的差。
     * 之前用 `hash*31+字符` 那种写法时，5 个昵称有 3 个撞在同一个色号上，
     * 就是因为低位没混匀。铺满度能直接把这个质量问题量出来。
     */
    const spread = (() => {
      const used = new Set()
      const outOfRange = []
      const add = (name) => {
        const i = hashIndex(name)
        used.add(i)
        // 独立检查"索引有没有越界"。
        // 这一条不能靠"复现实现的测试"来发现——因为两边会一样错。
        // 之前 `^` 漏了 >>> 0 导致哈希为负、索引变成 -3，
        // 就是靠把越界情况收集出来才定位到的。
        if (!Number.isInteger(i) || i < 0 || i >= 8) outOfRange.push({ name, i })
      }

      // 常见姓氏的单字昵称
      for (const c of '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜') {
        add(c)
      }
      // "某某"式两字昵称
      for (const c of '赵钱孙李周吴郑王冯陈褚卫蒋沈韩') add(c + '某')
      // "用户N"式昵称
      for (let i = 0; i < 60; i++) add('用户' + i)

      return { distinct: used.size, outOfRange }
    })()

    const chatWidth = Math.round(document.querySelector('.chat').getBoundingClientRect().width)

    return {
      chatWidth,
      spread,
      short: info(find('【A1】')),
      long: info(find('【B1】')),
      shortAgain: info(find('【A2】')),
      others: ['【C1】', '【D1】', '【E1】'].map((k) => info(find(k))),
      expected: Object.fromEntries(names.map((n) => [n, expectedColor(n)])),
    }
  }, people)

  console.log('  实测:', JSON.stringify(m, null, 0))

  // ---- 气泡宽度自适应 ----
  check('短消息的气泡明显更窄', m.short && m.short.width < m.long.width * 0.5, `短=${m.short?.width} 长=${m.long?.width}`)
  check('短消息气泡没有被撑到最宽', m.short && m.short.width < m.chatWidth * 0.5, `短=${m.short?.width} 聊天区宽=${m.chatWidth}`)
  check('长消息气泡被 max-width 夹住（不超过聊天区的 72%）', m.long && m.long.width <= m.chatWidth * 0.72, `长=${m.long?.width} 聊天区宽=${m.chatWidth}`)
  check('短消息气泡没有退化到挤不下内容（> 30px）', m.short && m.short.width > 30, `短=${m.short?.width}`)

  // ---- 昵称配色 ----
  const expectedOf = (name) => m.expected[name]?.rgb

  check(
    '★ 哈希索引没有越界（都在 0~7 范围内）',
    m.spread.outOfRange.length === 0,
    `越界的: ${JSON.stringify(m.spread.outOfRange.slice(0, 5))}`,
  )
  check(
    '★ 哈希能铺满全部 8 个色号（分散度够，昵称不会扎堆同色）',
    m.spread.distinct === 8,
    `只用到 ${m.spread.distinct} 个色号`,
  )

  check(
    '★ 昵称的颜色和哈希规则算出来的一致（甲某）',
    m.short?.color === expectedOf('甲某'),
    `实际=${m.short?.color} 规则算出=${expectedOf('甲某')}`,
  )
  check(
    '★ 同一个昵称再发一条，颜色不变（色号稳定）',
    m.shortAgain?.color === m.short?.color,
    `第一条=${m.short?.color} 第二条=${m.shortAgain?.color}`,
  )
  check(
    '★ 五个不同昵称至少用到 2 种颜色（能区分不同的人）',
    new Set([m.short?.color, m.long?.color, ...m.others.map((o) => o?.color)]).size >= 2,
    `用到的颜色: ${JSON.stringify([m.short?.color, m.long?.color, ...m.others.map((o) => o?.color)])}`,
  )

  // 逐个核对每个昵称的颜色
  const pairs = [
    ['乙某', m.long],
    ['丙某', m.others[0]],
    ['丁某', m.others[1]],
    ['戊某', m.others[2]],
  ]
  for (const [name, got] of pairs) {
    check(
      `昵称「${name}」的颜色符合哈希规则`,
      got?.color === expectedOf(name),
      `实际=${got?.color} 规则算出=${expectedOf(name)}`,
    )
  }

  // ---- 暗色下也核对一遍（颜色应该跟着主题变） ----
  await page.evaluate(() => localStorage.setItem('chatroom-theme', 'dark'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app', { timeout: 8000 })
  await sleep(1000)
  const dark = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.bubble')].find((b) =>
      b.querySelector('.text')?.textContent?.includes('【A1】'),
    )
    const s = el?.querySelector('.sender')
    return { color: s ? getComputedStyle(s).color : null }
  })
  check(
    '暗色下昵称换了另一套颜色（说明颜色交给了 CSS 变量管）',
    dark.color !== null && dark.color !== m.short?.color,
    `亮色=${m.short?.color} 暗色=${dark.color}`,
  )

  await page.screenshot({ path: `${SHOTS}/desktop-name-colors.png` })

  sockets.forEach((s) => s.close())
  await page.close()
}

console.log('=== L. 新消息提示（不打断正在翻历史的用户）===')
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await enter(page, '新消息检查')

  const site = await page.evaluate(() => location.origin)
  const talker = new WebSocket(
    `${site.replace(/^http/, 'ws')}/ws?nickname=${encodeURIComponent('另一个人')}&since=0`,
  )
  await new Promise((res, rej) => {
    talker.addEventListener('open', res)
    talker.addEventListener('error', () => rej(new Error('连接失败')))
    setTimeout(() => rej(new Error('超时')), 6000)
  })

  // 先灌够消息，让列表能滚动起来
  for (let i = 1; i <= 30; i++) {
    talker.send(JSON.stringify({ type: 'chat', content: `铺垫消息 ${i}` }))
    await sleep(15)
  }
  await sleep(900)

  const readState = () =>
    page.evaluate(() => {
      const list = document.querySelector('.messages')
      const hintEl = document.querySelector('.new-msg-hint')
      return {
        scrollTop: Math.round(list.scrollTop),
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        hint: hintEl ? hintEl.textContent.replace(/\s+/g, ' ').trim() : null,
      }
    })

  const base = await readState()
  console.log('  铺垫完成:', JSON.stringify(base))
  check(
    '列表已经可以滚动（构造出滚动场景）',
    base.scrollHeight > base.clientHeight + 100,
    `内容高=${base.scrollHeight} 容器高=${base.clientHeight}`,
  )
  check(
    '刚进聊天室时停在底部',
    base.scrollTop > base.scrollHeight - base.clientHeight - 80,
    `scrollTop=${base.scrollTop}`,
  )
  check('此时没有新消息提示', base.hint === null, `提示=${base.hint}`)

  // ★ 模拟"用户正在往上翻历史"：滚到最上面
  await page.evaluate(() => {
    document.querySelector('.messages').scrollTop = 0
  })
  await sleep(300)
  const scrolledUp = await readState()
  check('滚到顶部后没有提示', scrolledUp.hint === null, `提示=${scrolledUp.hint}`)

  // 这时候来一条新消息：**不应该**把用户拽到底部
  // 注意这条和后面那批用**不同的标记**（【首条】/【批N】）。
  // 上一版两条都叫【新1】，按内容查找时匹配到了错的那条，
  // 结果断言"跳到了第一条未读"是假通过的——教训：测试里的标记必须唯一。
  talker.send(JSON.stringify({ type: 'chat', content: '【首条】这是第一条新消息' }))
  await sleep(700)
  const afterFirst = await readState()
  console.log('  第一条新消息后:', JSON.stringify(afterFirst))

  check('★ 出现了新消息提示', afterFirst.hint !== null, `提示=${afterFirst.hint}`)
  check('★ 提示写的是「1 条新消息」', afterFirst.hint?.includes('1 条新消息') ?? false, `提示=${afterFirst.hint}`)
  check(
    '★ 没有把用户拽到底部（滚动位置基本没变）',
    Math.abs(afterFirst.scrollTop - scrolledUp.scrollTop) < 5,
    `之前=${scrolledUp.scrollTop} 现在=${afterFirst.scrollTop}`,
  )

  // ★ 关键：让"第一条未读"下面**有足够多的消息**，否则"跳到第一条"和"跳到底部"
  //   结果是一样的——浏览器碰到"内容不够滚"时会把滚动位置夹到最大值。
  const NEW_COUNT = 20
  for (let i = 1; i <= NEW_COUNT; i++) {
    talker.send(JSON.stringify({ type: 'chat', content: `【批${i}】第 ${i} 条新消息` }))
    await sleep(20)
  }
  await sleep(1000)

  const afterBatch = await readState()
  const TOTAL_UNREAD = NEW_COUNT + 1 // 别忘了前面那条【首条】
  check(
    `★ 提示累加成「${TOTAL_UNREAD} 条新消息」`,
    afterBatch.hint?.includes(`${TOTAL_UNREAD} 条新消息`) ?? false,
    `提示=${afterBatch.hint}`,
  )
  check('依然没有拽到底部', Math.abs(afterBatch.scrollTop - scrolledUp.scrollTop) < 5, `scrollTop=${afterBatch.scrollTop}`)

  // 点击前先确认"锚点"到底是哪一条——不然断言可能匹配到别的元素还显示通过
  const anchorText = await page.evaluate(() => {
    const el = document.querySelector('[data-unread-anchor]')
    return el?.querySelector('.text')?.textContent ?? null
  })
  check('★ 未读锚点就是第一条新消息（不是后面那批）', anchorText?.includes('【首条】') ?? false, `锚点内容=${anchorText}`)

  // 点提示：应该跳到**第一条**未读，而不是最后一条
  const hintBox = await page.evaluate(() => {
    const el = document.querySelector('.new-msg-hint')
    const r = el.getBoundingClientRect()
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }
  })
  await page.mouse.click(hintBox.cx, hintBox.cy)
  await sleep(1600) // 平滑滚动需要一点时间

  const afterJump = await page.evaluate((total) => {
    const list = document.querySelector('.messages')
    const listTop = list.getBoundingClientRect().top
    const listBottom = list.getBoundingClientRect().bottom
    /** 找含指定文字的那条消息，返回它相对消息区顶部的位置 */
    const posOf = (needle) => {
      const bubble = [...document.querySelectorAll('.bubble')].find((b) =>
        b.querySelector('.text')?.textContent?.includes(needle),
      )
      return bubble ? Math.round(bubble.getBoundingClientRect().top - listTop) : null
    }
    return {
      scrollTop: Math.round(list.scrollTop),
      listHeight: Math.round(listBottom - listTop),
      firstUnreadPos: posOf('【首条】'),
      middleUnreadPos: posOf(`【批${Math.floor(total / 2)}】`),
      lastUnreadPos: posOf(`【批${total}】`),
      hint: document.querySelector('.new-msg-hint')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    }
  }, NEW_COUNT)
  console.log('  点击提示后:', JSON.stringify(afterJump))

  check(
    '★ 跳到了第一条未读（它出现在消息区顶部附近）',
    afterJump.firstUnreadPos !== null && afterJump.firstUnreadPos >= -10 && afterJump.firstUnreadPos < 90,
    `第一条未读距消息区顶部 ${afterJump.firstUnreadPos}px`,
  )
  check(
    '★ 不是跳到最底部（最后一条新消息还在屏幕外）',
    afterJump.lastUnreadPos !== null && afterJump.lastUnreadPos > afterJump.listHeight,
    `最后一条距顶部 ${afterJump.lastUnreadPos}px，消息区高 ${afterJump.listHeight}px`,
  )
  check(
    '中间那些新消息排在第一条后面',
    afterJump.middleUnreadPos !== null &&
      afterJump.firstUnreadPos !== null &&
      afterJump.middleUnreadPos > afterJump.firstUnreadPos,
    `第一条=${afterJump.firstUnreadPos} 中间那条=${afterJump.middleUnreadPos}`,
  )
  check('点完之后提示消失了', afterJump.hint === null, `提示=${afterJump.hint}`)

  // 用户自己滚回底部，提示也应该自动消失
  await page.evaluate(() => {
    document.querySelector('.messages').scrollTop = 0
  })
  await sleep(300)
  talker.send(JSON.stringify({ type: 'chat', content: '【新3】第三条' }))
  await sleep(700)
  const beforeBack = await readState()
  check('再次离开底部后提示又出现了', beforeBack.hint !== null, `提示=${beforeBack.hint}`)

  await page.evaluate(() => {
    const list = document.querySelector('.messages')
    list.scrollTop = list.scrollHeight
  })
  await sleep(500)
  const afterBack = await readState()
  check('★ 用户自己滚回底部后，提示自动消失（不用点）', afterBack.hint === null, `提示=${afterBack.hint}`)

  await page.screenshot({ path: `${SHOTS}/desktop-new-message-hint.png` })

  talker.close()
  await page.close()
}

await browser.close()
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
console.log(`截图已保存到 ${SHOTS}`)
process.exit(fail === 0 ? 0 : 1)
