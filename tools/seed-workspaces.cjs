// 给干净 DSH_HOME 造几个假工作区（演示用，名字与目录全部虚构）
// 用法：node tools/seed-workspaces.cjs --home <DSH_HOME> [--work <目录>] [--names a,b,c]
// 前提：<DSH_HOME>\storages\workspace.json 已存在（先让 dsh web 空跑启动一次即可生成）
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const args = process.argv.slice(2)
const val = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

const HOME = val('--home', process.env.DSH_HOME || '')
if (!HOME) {
  console.error('缺少 --home <DSH_HOME>（或设置 DSH_HOME）')
  process.exit(2)
}
const WORK = val('--work', path.join(HOME, '..', 'demo-work'))
const names = val('--names', 'demo-app,landing-page,sdk-samples').split(',').map((s) => s.trim()).filter(Boolean)
const file = path.join(HOME, 'storages', 'workspace.json')

if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}`)
  console.error('先让 dsh web 在这个 HOME 下启动一次（它会把 storages/ 建出来），再跑本脚本。')
  process.exit(2)
}

const j = JSON.parse(fs.readFileSync(file, 'utf8'))
const now = new Date().toISOString()

j.global.workspaceIds = []
j.tables.workspaces = {}
for (const name of names) {
  const id = crypto.randomUUID()
  j.global.workspaceIds.push(id)
  j.tables.workspaces[id] = {
    path: path.join(WORK, name),
    title: name,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  }
  fs.mkdirSync(path.join(WORK, name), { recursive: true })
  fs.writeFileSync(path.join(WORK, name, 'README.md'), `# ${name}\n\nDemo workspace.\n`)
}

fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8')
console.log('workspaces seeded:', names.join(', '))
console.log('work dir:', WORK)
console.log('ids:', j.global.workspaceIds.join('\n     '))
