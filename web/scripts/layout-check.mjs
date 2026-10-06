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

await browser.close()
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
console.log(`截图已保存到 ${SHOTS}`)
process.exit(fail === 0 ? 0 : 1)
