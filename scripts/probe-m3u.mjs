// IPTV.m3u 链接探活
// 默认 DRY_RUN：只生成报告 probe-report.md、不修改 IPTV.m3u。
// DRY_RUN=0 时才写回（仅保留存活 + rtmp），并带「存活比例过低则不写回」的安全阀。
// 失败会重试（默认 3 次），任一次通即判活、连续都失败才判死，过滤临时抖动、减少误判误删。
//
// ⚠️ 务必在「真实使用网络」下运行：无外网环境会把外网源判失效（属预期）；
//    在有外网的机器上跑则外网源会「假活」，删除判断会偏乐观。
//
// 用法:
//   node scripts/probe-m3u.mjs              # 只报告、不改文件
//   DRY_RUN=0 node scripts/probe-m3u.mjs    # 探活并直接删除死链（带安全阀）
//   RETRIES=5 TIMEOUT_MS=10000 node scripts/probe-m3u.mjs   # 调参
//
// 仅用 Node 内置能力（node:fs + 全局 fetch），无需 npm 依赖。Node 18+ 即可。
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = process.env.M3U_FILE || 'IPTV.m3u'
const DRY_RUN = process.env.DRY_RUN !== '0' // 默认 dry-run
const CONCURRENCY = Number(process.env.CONCURRENCY || 16)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000)
const RETRIES = Math.max(1, Number(process.env.RETRIES || 3))    // 每个链接最多尝试次数
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 600) // 重试间隔
const MIN_KEEP_RATIO = Number(process.env.MIN_KEEP_RATIO || 0.5) // 写回安全阀
const UA = process.env.PROBE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const raw = readFileSync(FILE, 'utf-8')
const lines = raw.split(/\r?\n/)

// 解析 (extinf 行号, url 行号, 频道名, url)
const items = []
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('#EXTINF')) continue
  let j = i + 1
  while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith('#'))) j++
  if (j >= lines.length) continue
  items.push({
    extinfIdx: i,
    urlIdx: j,
    name: (lines[i].split(',').pop() || '').trim(),
    url: lines[j].trim(),
  })
}

async function probeOnce(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA },
    })
    res.body?.cancel?.().catch(() => {}) // 不下载流体，拿到状态即可
    const alive = res.status >= 200 && res.status < 400
    return { status: alive ? 'alive' : 'dead', code: res.status }
  } catch (e) {
    return { status: 'dead', code: e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.code || 'error') }
  } finally {
    clearTimeout(timer)
  }
}

// 带重试：任一次成功即判活；连续 RETRIES 次都失败才判死（过滤临时抖动）
async function probe(url) {
  if (/^rtmp:/i.test(url)) return { status: 'skip', code: 'rtmp' }
  let last
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    last = await probeOnce(url)
    if (last.status === 'alive') return last
    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS)
  }
  return last
}

// 简易并发池
async function runPool(arr, n, fn) {
  const out = new Array(arr.length)
  let idx = 0
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (idx < arr.length) {
      const cur = idx++
      out[cur] = await fn(arr[cur])
    }
  }))
  return out
}

const results = await runPool(items, CONCURRENCY, async (it) => ({ ...it, ...(await probe(it.url)) }))
const alive = results.filter((r) => r.status === 'alive')
const dead = results.filter((r) => r.status === 'dead')
const skip = results.filter((r) => r.status === 'skip')

const ts = new Date().toISOString()
const md = []
md.push(`# IPTV.m3u 探活报告（${DRY_RUN ? 'dry-run · 未修改文件' : '已剔除死链'}）`)
md.push('')
md.push(`- 运行时间(UTC): ${ts}`)
md.push(`- 运行环境: ${process.env.GITHUB_ACTIONS ? 'GitHub Actions runner（海外）' : '本地'}`)
md.push(`- 重试次数: ${RETRIES}（任一次通即判活）`)
md.push(`- 总频道: **${items.length}**`)
md.push(`- ✅ 存活: **${alive.length}**`)
md.push(`- ❌ 失效: **${dead.length}**`)
md.push(`- ⏭️ 跳过(rtmp，无法 HTTP 探测，保留不删): **${skip.length}**`)
md.push('')
md.push('> ⚠️ 务必在「真实使用网络」下探活：无外网环境会把外网源判失效（属预期）；在有外网的机器上跑则外网源会「假活」、删除判断偏乐观。')
md.push('')
md.push('## ❌ 失效明细')
for (const d of dead) md.push(`- \`[${d.code}]\` ${d.name} — ${d.url}`)
if (!dead.length) md.push('- （无）')
md.push('')
md.push('## ⏭️ 跳过 (rtmp)')
for (const s of skip) md.push(`- ${s.name} — ${s.url}`)
if (!skip.length) md.push('- （无）')
md.push('')

const report = md.join('\n')
writeFileSync('probe-report.md', report + '\n')
console.log(report)
console.log(`\nSUMMARY: total=${items.length} alive=${alive.length} dead=${dead.length} skip=${skip.length}`)

if (!DRY_RUN) {
  const keep = alive.length + skip.length
  if (keep < items.length * MIN_KEEP_RATIO) {
    console.error(`⚠️ 存活比例过低 (${keep}/${items.length})，疑似探活环境异常（如断网 / 探错了网络），跳过写回以免误删`)
    process.exit(2)
  }
  const drop = new Set()
  for (const d of dead) { drop.add(d.extinfIdx); drop.add(d.urlIdx) }
  const kept = lines.filter((_, i) => !drop.has(i))
  // 折叠删除后可能产生的连续空行
  const clean = []
  for (const l of kept) {
    if (l.trim() === '' && clean.length && clean[clean.length - 1].trim() === '') continue
    clean.push(l)
  }
  writeFileSync(FILE, clean.join('\n').replace(/\n+$/, '\n'))
  console.log(`已写回 ${FILE}：剔除 ${dead.length} 个死链，保留 ${keep} 个（含 ${skip.length} 个 rtmp）`)
}
