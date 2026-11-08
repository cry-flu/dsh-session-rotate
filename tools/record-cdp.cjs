// 录 dsh-session-rotate 设置页演示 GIF（CDP 截图，无屏幕抓取、无 npm 依赖）
// 画面只来自一个全新 DSH_HOME + headless Chrome，天然不含真实工作区名/会话标题。
//
// 直接用：node tools/record-cdp.cjs --url <带 token 的 url> --home <DSH_HOME> [--out demo.gif]
// 全自动：pwsh -File tools/record-cdp.ps1
//
// 参数：
//   --url <u>        要录的页面（dsh web 打出来的 http://127.0.0.1:PORT/?token=...）
//   --home <dir>     录之前把 <dir>/session-rotate/config.json 重置成初始态
//   --out <file>     输出 GIF（默认 docs\img\demo.gif）
//   --frames <dir>   中间帧目录（默认 <out 目录>\.frames）
//   --cdp-port <n>   连哪個 CDP 端口（默认 9222，也可用环境变量 CDP_PORT）
//   --fps <n>        抓帧帧率（默认 14；输出按实测 fps 压，慢机器不会变快进）
//   --clip x,y,w,h   截图区域（默认 200,50,800,800，适配 1200x900 视口）
//   --ffmpeg <path>  ffmpeg 路径（默认依次试 PATH、D:\tools\ffmpeg\bin）
//   --keep           保留中间帧
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { connect } = require('./cdp.cjs')

const args = process.argv.slice(2)
const val = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const has = (name) => args.includes(name)

const OUT = path.resolve(val('--out', path.join('docs', 'img', 'demo.gif')))
const HOME = val('--home', '')
const FRAMES = path.resolve(val('--frames', path.join(path.dirname(OUT), '.frames')))
const CDP_PORT = Number(val('--cdp-port', process.env.CDP_PORT || 9222))
const FPS = Number(val('--fps', 14))
const CLIP = (() => {
  const p = val('--clip', '200,50,800,800').split(',').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) throw new Error('--clip 要写成 x,y,w,h')
  return { x: p[0], y: p[1], width: p[2], height: p[3], scale: 1 }
})()
const KEEP = has('--keep')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findFfmpeg() {
  const cands = [
    val('--ffmpeg', ''),
    process.env.FFMPEG || '',
    'ffmpeg',
    'D:\\tools\\ffmpeg\\bin\\ffmpeg.exe',
  ].filter(Boolean)
  for (const c of cands) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' })
      return c
    } catch {}
  }
  throw new Error('找不到 ffmpeg：用 --ffmpeg <路径> 指定，或把 ffmpeg 放进 PATH')
}

// 光标 + 点击涟漪 + 顶部字幕（全部 DOM 注入，不依赖真实鼠标）
const OVERLAY = `(()=>{
  const add=(html,css)=>{const d=document.createElement('div');d.className='gifov';d.style.cssText=css;if(html)d.innerHTML=html;(document.body||document.documentElement).appendChild(d);return d}
  const cur=add('<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2 L3 18.5 L7.6 14.2 L10.7 21 L13.9 19.5 L10.8 12.9 L17 12.5 Z" fill="#101828" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate3d(320px,700px,0);transition:transform 500ms cubic-bezier(.2,.7,.3,1);filter:drop-shadow(0 1px 3px rgba(0,0,0,.35))')
  const cap=add('',
    'position:fixed;left:50%;top:57px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;font:600 16px/1.45 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#fff;background:rgba(16,24,40,.92);padding:7px 16px;border-radius:999px;white-space:nowrap;opacity:0;transition:opacity 260ms ease;box-shadow:0 4px 14px rgba(16,24,40,.28)')
  const ring=document.createElement('div');ring.className='gifov'
  ring.style.cssText='position:fixed;left:0;top:0;width:48px;height:48px;border-radius:50%;background:rgba(37,99,235,.42);z-index:2147483646;pointer-events:none;opacity:0;transform:translate(-50%,-50%)'
  document.body.appendChild(ring)
  window.__cur=(x,y,ms)=>{cur.style.transitionDuration=(ms||450)+'ms';cur.style.transform='translate3d('+(x-2)+'px,'+(y-2)+'px,0)'}
  window.__cap=(t)=>{cap.textContent=t;cap.style.opacity=t?'1':'0'}
  window.__ring=(x,y)=>{ring.style.left=x+'px';ring.style.top=y+'px';ring.animate([{opacity:.9,transform:'translate(-50%,-50%) scale(.25)'},{opacity:0,transform:'translate(-50%,-50%) scale(1.45)'}],{duration:520,easing:'ease-out'})}
  return 'ok'
})()`

function resetConfig() {
  if (!HOME) {
    console.log('[skip] 没给 --home，保留现有 config.json（上一轮的状态会让"勾选"变成"取消勾选"）')
    return
  }
  const SR = path.join(HOME, 'session-rotate')
  fs.mkdirSync(SR, { recursive: true })
  fs.writeFileSync(
    path.join(SR, 'config.json'),
    JSON.stringify({
      defaultMaxSteps: 40,
      workspaces: [{ name: 'demo-app', maxSteps: null }],
      minSteps: 10,
      cooldownMinutes: 10,
      maxRotations: 3,
      dryRun: false,
      // 分镜需要一个可复现的初态：「归档前先留」已经是 1 分钟，
      // 这样取消「换新后自动跳到新会话」时，「归档到点时自动跳到新会话」才会立刻冒出来
      // （1.4.1 的显示条件是 autoSwitch || !(deferArchiveMinutes > 0)）。
      archiveOnRotate: true,
      autoSwitch: true,
      switchOnArchive: true,
      deferArchiveMinutes: 1,
    }, null, 2) + '\n',
    'utf8',
  )
  fs.rmSync(path.join(SR, 'debug.log'), { force: true })
  console.log('config reset:', path.join(SR, 'config.json'))
}

async function main() {
  const ffmpeg = findFfmpeg()
  resetConfig()

  const cdp = await connect(CDP_PORT)
  const ev = (js) => cdp.eval(js)
  const rect = async (js) => {
    const r = await ev(js)
    if (!r) throw new Error('element not found: ' + js.slice(0, 70))
    return r
  }
  const clickText = async (text, wait = 400) => {
    const r = await ev(`(()=>{const c=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.textContent||'').trim()===${JSON.stringify(text)});const vis=c.filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0});if(!vis.length)return null;const e=vis.reduce((a,b)=>b.getBoundingClientRect().y>a.getBoundingClientRect().y?b:a);const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    if (!r) throw new Error('no text element: ' + text + '（界面语言/版本变了？）')
    await cdp.click(r.x, r.y)
    await sleep(wait)
    return r
  }
  const nearInput = (name, kind) => `(()=>{
    const cand=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.textContent||'').trim()===${JSON.stringify(name)}&&e.getBoundingClientRect().width>0);
    if(!cand.length) return null;
    const leaf=cand.reduce((a,b)=>b.getBoundingClientRect().y>a.getBoundingClientRect().y?b:a);
    const ly=leaf.getBoundingClientRect().y;
    const sel=${kind === 'checkbox' ? `'input[type=checkbox]'` : `'input[type=text],input:not([type=checkbox])'`};
    const items=[...document.querySelectorAll(sel)].filter(c=>{const r=c.getBoundingClientRect();return r.width>0&&r.height>0}).map(c=>{const r=c.getBoundingClientRect();return {el:c,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),top:r.y,checked:c.checked,val:c.value}});
    if(!items.length) return null;
    const best=items.reduce((a,b)=>Math.abs(b.top-ly)<Math.abs(a.top-ly)?b:a);
    /* 打个标记，外面的 scroll/点击可以按标记重新取一次坐标（面板下半部分可能在首屏之外） */
    document.querySelectorAll('[data-gif]').forEach(e=>{delete e.dataset.gif});
    best.el.dataset.gif='1';
    return {x:best.x,y:best.y,checked:best.checked,val:best.val};
  })()`
  const cbFor = (n) => nearInput(n, 'checkbox')
  const inputFor = (n) => nearInput(n, 'input')

  const pointAt = async (sel, moveMs = 600) => {
    const r = await rect(sel)
    await ev(`window.__cur(${r.x},${r.y},${moveMs})`)
    await sleep(moveMs + 120)
    return r
  }
  const clickOn = async (sel, moveMs = 600, holdAfter = 500) => {
    const r = await pointAt(sel, moveMs)
    await cdp.click(r.x, r.y)
    await ev(`window.__ring(${r.x},${r.y})`)
    await sleep(holdAfter)
    return r
  }

  /**
   * 把 nearInput 刚标记的元素滚到视口中间，再取一次坐标。
   * 设置面板比视口长，开关区在首屏之外：直接按首屏坐标点会打在视口外，React 收不到事件。
   */
  const scrollToMarked = async (smooth = true) => {
    const probe = `(()=>{const el=document.querySelector('[data-gif="1"]');if(!el)return null;const b=el.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),checked:el.checked,val:el.value}})()`
    const at = await ev(probe)
    if (!at) return null
    /* 已经在可视区中间就不要再滚：多余的 scrollIntoView 会让画面在点击前抖一下 */
    if (at.y > 110 && at.y < 800) {
      await sleep(250)
      return at
    }
    await ev(`(()=>{const el=document.querySelector('[data-gif="1"]');if(el)el.scrollIntoView({block:'center',behavior:'${smooth ? 'smooth' : 'instant'}'});return el?'ok':'no'})()`)
    await sleep(smooth ? 1000 : 400)
    return ev(probe)
  }
  const clickEl = async (expr, moveMs = 600, holdAfter = 500) => {
    const found = await ev(expr)
    if (!found) throw new Error('element not found: ' + expr.slice(0, 60))
    const r = await scrollToMarked(true)
    if (!r) throw new Error('标记元素已丢失: ' + expr.slice(0, 60))
    if (r.y < 60 || r.y > 880) console.log(`warn: target y=${r.y} 可能不在可视区`)
    await pointAt(`({x:${r.x},y:${r.y}})`, moveMs)
    await cdp.click(r.x, r.y)
    await ev(`window.__ring(${r.x},${r.y})`)
    await sleep(holdAfter)
    return r
  }

  const url = val('--url', '')
  if (url) {
    await cdp.send('Page.navigate', { url })
    await sleep(4000)
  }
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(2800)
  // 关掉启动提示层：全新 HOME 会弹「预览版说明 → 继续」，老 HOME 可能只有「关闭」
  for (let i = 0; i < 3; i++) {
    const hit = await ev(`(()=>{
      const want=['继续','关闭','知道了','跳过','开始使用']
      const b=[...document.querySelectorAll('button')].find(e=>{
        const t=(e.getAttribute('aria-label')||'').trim()
        const x=(e.textContent||'').trim()
        return want.includes(t)||want.includes(x)
      })
      if(!b) return ''
      b.click(); return (b.getAttribute('aria-label')||b.textContent||'').trim()
    })()`)
    if (!hit) break
    console.log('dismissed dialog:', hit)
    await sleep(600)
  }

  // 设置 → 会话换新
  await clickText('更多', 800)
  await clickText('设置', 1200)
  await clickText('会话换新', 1000)

  const SCROLL_SEL = `[...document.querySelectorAll('*')].find(d=>d.scrollHeight>d.clientHeight+40&&/默认步数上限/.test(d.textContent||''))`
  await ev(`(()=>{const sc=${SCROLL_SEL};if(sc)sc.scrollTop=0;return 'ok'})()`)
  await sleep(600)

  await ev(OVERLAY)

  // ---- 开录 ----
  fs.rmSync(FRAMES, { recursive: true, force: true })
  fs.mkdirSync(FRAMES, { recursive: true })
  let recording = true
  let n = 0
  const t0 = Date.now()
  /** 字幕挂上的帧号与秒数，最后写进 demo.timeline.json —— 文档里的秒数由此复算 */
  const caps = []
  const cap = async (text) => {
    caps.push({ frame: n, at: +((Date.now() - t0) / 1000).toFixed(2), text })
    await ev(`window.__cap(${JSON.stringify(text)})`)
  }
  const loop = (async () => {
    while (recording) {
      const target = t0 + n * (1000 / FPS)
      const wait = target - Date.now()
      if (wait > 0) await sleep(wait)
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: CLIP, captureBeyondViewport: false })
      fs.writeFileSync(path.join(FRAMES, `${String(n + 1).padStart(6, '0')}.png`), Buffer.from(r.data, 'base64'))
      n++
    }
  })()

  // 首帧先稳住：顶部（默认步数上限 + 工作区名单）
  await cap('① 设置 → 会话换新')
  await sleep(1600)

  // 开关区在首屏之外：先平滑滚过去（这段滚动本身也在画面里）
  await ev(`(()=>{const o=${cbFor('换新后自动跳到新会话')};if(!o)return null;const el=document.querySelector('[data-gif="1"]');if(el)el.scrollIntoView({block:'center',behavior:'smooth'});return 'ok'})()`)
  await sleep(1200)

  // 1) 取消「换新后自动跳到新会话」
  await cap('② 取消「换新后自动跳到新会话」')
  await sleep(500)
  const autoSwitch = await ev(cbFor('换新后自动跳到新会话'))
  if (!autoSwitch) throw new Error('找不到「换新后自动跳到新会话」勾选框（界面文案变了？）')
  console.log('autoSwitch before:', JSON.stringify(autoSwitch), '| defer:', JSON.stringify(await ev(inputFor('归档前先留（分钟）'))))
  if (autoSwitch.checked) await clickEl(cbFor('换新后自动跳到新会话'), 650, 500)
  await sleep(600)

  // 2) 面板这时才多出「归档到点时自动跳到新会话」
  await cap('③ 于是多出「归档到点时自动跳到新会话」')
  await sleep(900)
  const switchOnArchive = await ev(cbFor('归档到点时自动跳到新会话'))
  if (!switchOnArchive) throw new Error('取消 autoSwitch 后没出现「归档到点时自动跳到新会话」：初态 deferArchiveMinutes 必须 > 0（见 resetConfig）')
  if (!switchOnArchive.checked) await clickEl(cbFor('归档到点时自动跳到新会话'), 600, 400)
  await sleep(700)

  // 3) 「归档前先留」填 1 分钟
  await cap('④ 「归档前先留」填 1 分钟')
  await sleep(450)
  await clickEl(inputFor('归档前先留（分钟）'), 550, 200)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await sleep(150)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await sleep(300)
  await cdp.send('Input.insertText', { text: '1' })
  await sleep(700)

  // 4) 平滑滚到底部（保存按钮 + 最近日志）
  await ev(`new Promise(r=>{const sc=${SCROLL_SEL};if(!sc){r(0);return}const to=sc.scrollHeight-sc.clientHeight,from=sc.scrollTop,t=performance.now(),dur=1000;
    (function step(){const p=Math.min(1,(performance.now()-t)/dur),e=1-Math.pow(1-p,3);sc.scrollTop=from+(to-from)*e;p<1?requestAnimationFrame(step):r(1)})()})`)
  await sleep(700)
  await cap('⑤ 保存即生效，不用重启')
  await sleep(400)

  // 5) 保存，确认出现「已保存」
  await clickOn(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='保存');if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`, 550, 900)
  await sleep(600)
  const savedHit = await ev(`(()=>[...document.querySelectorAll('*')].some(e=>e.children.length===0&&(e.textContent||'').trim()==='已保存')?'已保存':'')()`)
  console.log('save note:', savedHit || '(画面里没读到「已保存」，检查保存是否成功)')

  // 6) 最近日志确认写入
  await sleep(500)
  await cap('⑥ 最近日志确认写入')
  await sleep(2400)

  recording = false
  await loop
  const total = n
  const realMs = Date.now() - t0
  const realFps = +(total / (realMs / 1000)).toFixed(2)
  console.log(`frames: ${total} (${(total / FPS).toFixed(1)}s @ 设定 ${FPS}fps, 实际 ${(realMs / 1000).toFixed(1)}s → ${realFps}fps)`)

  // 输出按实测 fps 压，保证播放速度跟真实操作一致
  const palette = path.join(FRAMES, 'palette.png')
  const vf = `scale=${CLIP.width}:-1:flags=lanczos`
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(realFps), '-i', path.join(FRAMES, '%06d.png'), '-vf', `${vf},palettegen=stats_mode=diff`, palette])
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(realFps), '-i', path.join(FRAMES, '%06d.png'), '-i', palette,
    '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', OUT])
  const mb = fs.statSync(OUT).size / 1024 / 1024
  console.log(`gif: ${OUT} (${mb.toFixed(2)} MB, ${total} 帧, ${(total / realFps).toFixed(1)}s)`)

  const timeline = {
    gif: path.basename(OUT),
    width: CLIP.width,
    height: CLIP.height,
    frames: total,
    fps: realFps,
    seconds: +(total / realFps).toFixed(2),
    shots: caps.map((c) => ({ ...c, seconds: +(c.frame / realFps).toFixed(2) })),
  }
  const tlFile = path.join(path.dirname(OUT), 'demo.timeline.json')
  fs.writeFileSync(tlFile, JSON.stringify(timeline, null, 2) + '\n', 'utf8')
  console.log('timeline:', tlFile)

  if (!KEEP) fs.rmSync(FRAMES, { recursive: true, force: true })
  else console.log('frames kept:', FRAMES)
  cdp.ws.close()
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exitCode = 1
})
