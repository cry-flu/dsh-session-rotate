/**
 * 什么时候该换会话 —— 纯函数，方便单测（不走宿主、不发消息）。
 *
 * 背景：steps 只在 turn/end 时刷新，插件在轮内看不到步数增长。
 * 所以「越限判定」天然滞后一轮，滞后量 = 下一轮自己跑掉的步数（实测 34 → 58）。
 * 预判就是拿「下一轮大概会跑几步」当估计，在 turn 边界提前换。
 *
 * v2（2026-11-07）：预判值从「上一轮增量」改成「近 3 轮增量的滑动平均 + 1 步余量」。
 * 单轮增量容易被一次超长轮带偏（早换）或被一次空轮带偏（晚换），三窗均值稳一些；
 * 再 +1 步余量兜住「下一轮比平均稍微多跑一点」。
 *
 * 只有真正首轮（历史窗口为空）才退回保守上界：把本轮累计 steps 当作下一轮增量上界
 * （下一轮不可能比「首轮从 0 跑到 steps」跑得更猛），判据退化成 steps + steps >= limit，
 * 即 steps >= ceil(limit / 2) 就在本轮末换 —— 这是已知偏保守的代价。
 * v3（2026-11-07）：recentDeltas 改为由调用方喂「工作区维度」的跨会话历史（state.json），
 * 新会话首轮也有先验，上述保守上界只对「这个工作区从来没换过」的第一次生效。
 *
 * 保护闸：minSteps 是硬下限。累计步数 < minSteps 时，不论越限还是预判，一律不换
 * （越限也压住，避免 limit 配得比 minSteps 还小时来回抖动；等步数涨过 minSteps 再按越限处理）。
 *
 * @param {object} input
 * @param {number} input.steps     本轮结束时的累计步数
 * @param {number} input.limit     该工作区的上限
 * @param {number|null|undefined} input.prevSteps 上一轮结束时的累计步数（首轮为 undefined）
 * @param {number[]} [input.recentDeltas] 之前各轮的实测增量，取最后 3 个进窗口
 * @param {number} [input.minSteps] 硬下限（<=0 或非数字 = 关掉这道闸）
 * @returns {{
 *   steps:number, limit:number, minSteps:number, delta:number|null, measured:number|null,
 *   avg:number|null, window:number[], estimated:boolean, belowMin:boolean,
 *   over:boolean, predicted:boolean, shouldRotate:boolean,
 *   blocked:'minSteps'|null, reason:string|null
 * }}
 */
const WINDOW = 3
const MARGIN = 1

export function decideRotate({ steps, limit, prevSteps, recentDeltas, minSteps }) {
  const stepNum = Number(steps)
  const limitNum = Number(limit)
  const finite = Number.isFinite(stepNum) && Number.isFinite(limitNum)

  const measured =
    Number.isFinite(prevSteps) && Number.isFinite(stepNum) && stepNum >= prevSteps ? stepNum - prevSteps : null

  // 历史窗口：之前各轮的实测增量（取最后 3 个）+ 本轮实测
  const hist = Array.isArray(recentDeltas)
    ? recentDeltas.filter((n) => Number.isFinite(n) && n >= 0)
    : []
  if (measured !== null && measured >= 0) hist.push(measured)
  const window = hist.slice(-WINDOW)

  const avg = window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : null

  // 有历史 → 滑动平均 + 余量；没历史（真首轮）→ 保守上界 steps
  const estimated = window.length === 0
  const delta = estimated
    ? Number.isFinite(stepNum) && stepNum > 0
      ? stepNum
      : null
    : Math.round(avg) + MARGIN

  const min = Number.isFinite(minSteps) && minSteps > 0 ? minSteps : 0
  const belowMin = Number.isFinite(stepNum) && stepNum < min

  const over = finite && stepNum >= limitNum
  /** 不看 minSteps 时会怎么判 —— 用来在日志里说明「本来该换，但被最小步数压住了」 */
  const wouldPredict = delta !== null && delta > 0 && Number.isFinite(stepNum) && stepNum + delta >= limitNum
  const predicted = !over && !belowMin && wouldPredict

  const shouldRotate = finite && !belowMin && (over || wouldPredict)
  const blocked = !shouldRotate && belowMin && (over || wouldPredict) ? 'minSteps' : null

  return {
    steps: stepNum,
    limit: limitNum,
    minSteps: min,
    delta,
    measured,
    avg,
    window,
    estimated,
    belowMin,
    over,
    predicted,
    shouldRotate,
    blocked,
    reason: over
      ? `越限：steps=${stepNum} >= limit=${limitNum}`
      : predicted && estimated
        ? `首轮预判：steps=${stepNum} + 估计增量 ${delta} = ${stepNum + delta} >= limit=${limitNum}（无历史，用本轮累计当上界）`
        : predicted
          ? `预判：steps=${stepNum} + 近${window.length}轮均值${avg.toFixed(1)}+${MARGIN} 步=${delta} → ${stepNum + delta} >= limit=${limitNum}（窗口 [${window.join(',')}]）`
          : null,
  }
}
