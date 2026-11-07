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
    const items=[...document.querySelectorAll(sel)].filter(c=>{const r=c.getBoundingClientRect();return r.width>0&&r.height>0}).map(c=>{const r=c.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),top:r.y,checked:c.checked,val:c.value}});
    if(!items.length) return null;
    const best=items.reduce((a,b)=>Math.abs(b.top-ly)<Math.abs(a.top-ly)?b:a);
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
  await ev(`window.__cap('① 设置 → 会话换新')`)

  // ---- 开录 ----
  fs.rmSync(FRAMES, { recursive: true, force: true })
  fs.mkdirSync(FRAMES, { recursive: true })
  let recording = true
  let n = 0
  const t0 = Date.now()
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

  await sleep(600)
  // 1) 勾 landing-page
  await ev(`window.__cap('② 勾选要自动换新的工作区')`)
  await sleep(500)
  await clickOn(cbFor('landing-page'), 650, 500)
  await sleep(700)

  // 2) 填自己的上限 30
  await ev(`window.__cap('③ 单个工作区可以单独设上限，留空就跟默认')`)
  await sleep(450)
  await clickOn(inputFor('landing-page'), 550, 200)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await sleep(150)
  await cdp.send('Input.insertText', { text: '30' })
  await sleep(650)

  // 3) 再勾 sdk-samples
  await clickOn(cbFor('sdk-samples'), 550, 400)
  await ev(`window.__cap('④ 保存即生效，不用重启')`)
  await sleep(700)

  // 4) 平滑滚到底部（保存按钮 + 最近日志）
  await ev(`new Promise(r=>{const sc=${SCROLL_SEL};if(!sc){r(0);return}const to=sc.scrollHeight-sc.clientHeight,from=sc.scrollTop,t=performance.now(),dur=1000;
    (function step(){const p=Math.min(1,(performance.now()-t)/dur),e=1-Math.pow(1-p,3);sc.scrollTop=from+(to-from)*e;p<1?requestAnimationFrame(step):r(1)})()})`)
  await sleep(700)

  // 5) 保存
  await clickOn(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='保存');if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`, 550, 900)
  await ev(`window.__cap('⑤ 最近日志确认写入')`)
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

  if (!KEEP) fs.rmSync(FRAMES, { recursive: true, force: true })
  else console.log('frames kept:', FRAMES)
  cdp.ws.close()
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exitCode = 1
})
