import type { EntryRow } from '@/data/types'

/**
 * 除冰作业的同一份规则：字段口径、状态动作、用量校核与完成判定都只在这里写一遍，
 * 动作提交、页面列表、CSV 导出以及别的模块（航班保障台账）统一从这里取结论。
 */

export const DEICING_KEY = 'deicing'

// 五个核心字段：原先散在动作、列表、导出里各写一遍，现在收拢到这里。
export const DEICING_CODE_FIELD = '除冰编号'
export const DEICING_FLIGHT_FIELD = '关联航班'
export const DEICING_FLUID_FIELD = '除冰液类型'
export const DEICING_PLANNED_FIELD = '预计用量'
export const DEICING_ACTUAL_FIELD = '实际用量'

export const DEICING_CORE_FIELDS = [
  DEICING_CODE_FIELD,
  DEICING_FLIGHT_FIELD,
  DEICING_FLUID_FIELD,
  DEICING_PLANNED_FIELD,
  DEICING_ACTUAL_FIELD,
] as const

export const DEICING_TIME_FIELDS = ['开始时间', '结束时间'] as const

/** 列表与导出共用的列口径，谁都不许再手抄一遍。 */
export const DEICING_LEDGER_FIELDS = [...DEICING_CORE_FIELDS, ...DEICING_TIME_FIELDS]

export const DEICING_STATUS = {
  pending: '待除冰',
  working: '作业中',
  done: '已完成',
  canceled: '已取消',
} as const

export const DEICING_STATUSES = [
  DEICING_STATUS.pending,
  DEICING_STATUS.working,
  DEICING_STATUS.done,
  DEICING_STATUS.canceled,
] as const

export const DEICING_ACTION = {
  start: '开始除冰',
  complete: '确认完成',
  cancel: '取消作业',
} as const

export const DEICING_ACTION_TARGETS: Record<string, string> = {
  [DEICING_ACTION.start]: DEICING_STATUS.working,
  [DEICING_ACTION.complete]: DEICING_STATUS.done,
  [DEICING_ACTION.cancel]: DEICING_STATUS.canceled,
}

/** 实际用量相对预计用量允许的偏差带；超出即校核不通过，不允许确认完成。 */
export const DEICING_USAGE_TOLERANCE = 0.2

const ARCHIVED_FLAG = 'archived'
const MIGRATED_FLAG = '兼容迁移'

export type UsageCheckLevel = 'unfilled' | 'pass' | 'fail'

export type UsageCheck = {
  level: UsageCheckLevel
  expected: number | null
  actual: number | null
  /** 相对预计用量的偏差比例，无法核算时为 null。 */
  deviation: number | null
  /** 一句话结论，列表、导出、台账共用这一种写法。 */
  summary: string
  /** 不通过时的原因，动作拦截直接用。 */
  reason: string
}

/**
 * 从「100升 / 100 L / 约100升」这类写法里取出数字。
 * 只有整体像「数字（可带单位）」才算有效用量，避免从说明性文字里误抠数字。
 */
export function parseUsage(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null
  }
  const text = String(raw).trim()
  if (!text) {
    return null
  }
  const matched = text.match(/^(?:约|大约)?\s*(\d+(?:\.\d+)?)\s*(?:升|公升|L|l)?$/)
  if (!matched) {
    return null
  }
  const value = Number(matched[1])
  return Number.isFinite(value) ? value : null
}

/** 用量的统一写法：数字规整后统一带「升」，取不到数字时原样返回（含空串）。 */
export function formatUsage(raw: unknown): string {
  const text = raw === null || raw === undefined ? '' : String(raw).trim()
  if (!text) {
    return ''
  }
  const value = parseUsage(text)
  if (value === null) {
    return text
  }
  const normalized = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${normalized}升`
}

function deviationText(deviation: number): string {
  const percent = Math.round(deviation * 100)
  return `${percent >= 0 ? '+' : ''}${percent}%`
}

/** 用量校核：同一条判定，动作能不能完成、列表显示什么、导出写什么都取自这里。 */
export function checkDeicingUsage(row: EntryRow): UsageCheck {
  const expected = parseUsage(row[DEICING_PLANNED_FIELD])
  const actualText = String(row[DEICING_ACTUAL_FIELD] ?? '').trim()
  const actual = parseUsage(actualText)

  if (!actualText || actual === null || actual <= 0) {
    return {
      level: 'unfilled',
      expected,
      actual: null,
      deviation: null,
      summary: '实际用量未填报',
      reason: '实际用量未填报，无法确认完成',
    }
  }
  if (expected === null || expected <= 0) {
    return {
      level: 'fail',
      expected: null,
      actual,
      deviation: null,
      summary: '预计用量无效，无法校核',
      reason: '预计用量缺失或不是有效数字，无法完成用量校核',
    }
  }

  const deviation = (actual - expected) / expected
  if (Math.abs(deviation) <= DEICING_USAGE_TOLERANCE) {
    return {
      level: 'pass',
      expected,
      actual,
      deviation,
      summary: `校核通过（偏差${deviationText(deviation)}）`,
      reason: '',
    }
  }
  return {
    level: 'fail',
    expected,
    actual,
    deviation,
    summary: `校核超差（偏差${deviationText(deviation)}，允许±${DEICING_USAGE_TOLERANCE * 100}%）`,
    reason: `实际用量${formatUsage(actualText)}超出预计${formatUsage(row[DEICING_PLANNED_FIELD])}的±${
      DEICING_USAGE_TOLERANCE * 100
    }%校核范围`,
  }
}

/** 完成判定收拢：用量校核通过是确认完成的唯一口径。 */
export function canCompleteDeicing(row: EntryRow): boolean {
  return checkDeicingUsage(row).level === 'pass'
}

export function isArchivedDeicing(row: EntryRow): boolean {
  return String(row.status) === DEICING_STATUS.canceled || row[ARCHIVED_FLAG] === true
}

/** 按当前状态给出可执行动作；终态不再挂动作，重复提交由动作层再兜一道幂等。 */
export function allowedDeicingActions(status: string): string[] {
  switch (status) {
    case DEICING_STATUS.pending:
      return [DEICING_ACTION.start, DEICING_ACTION.cancel]
    case DEICING_STATUS.working:
      return [DEICING_ACTION.complete, DEICING_ACTION.cancel]
    default:
      return []
  }
}

/** 除冰结论的统一写法，航班保障台账共用这一行字。 */
export function describeDeicing(row: EntryRow): string {
  const fluid = String(row[DEICING_FLUID_FIELD] ?? '').trim() || '未登记除冰液'
  const expected = formatUsage(row[DEICING_PLANNED_FIELD]) || '未登记'
  const actualText = String(row[DEICING_ACTUAL_FIELD] ?? '').trim()
  const actual = actualText ? formatUsage(actualText) : '未登记'

  if (isArchivedDeicing(row)) {
    return `已取消·已归档｜${fluid}｜预计${expected}｜实际${actual}（原用量已封存）`
  }
  return `${String(row.status)}｜${fluid}｜预计${expected}/实际${actual}｜${checkDeicingUsage(row).summary}`
}

export type DeicingOpResult = {
  ok: boolean
  message: string
  rows: EntryRow[]
  changed: boolean
}

function findRow(rows: EntryRow[], id: number): { row: EntryRow; index: number } | null {
  const index = rows.findIndex((item) => Number(item.id) === id)
  return index < 0 ? null : { row: rows[index], index }
}

function replaceRow(
  rows: EntryRow[],
  index: number,
  patch: Record<string, string | number | boolean>,
): EntryRow[] {
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  return next
}

export function startDeicing(rows: EntryRow[], id: number): DeicingOpResult {
  const found = findRow(rows, id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的除冰记录`, rows, changed: false }
  }
  const status = String(found.row.status)
  if (status === DEICING_STATUS.working) {
    return { ok: true, message: '除冰已经在作业中，重复提交只生效一次', rows, changed: false }
  }
  if (status === DEICING_STATUS.done || status === DEICING_STATUS.canceled) {
    const tail = status === DEICING_STATUS.done ? '完成' : '取消并归档'
    return { ok: false, message: `作业已${tail}，不能再开始除冰`, rows, changed: false }
  }
  return {
    ok: true,
    message: '除冰已开始，当前状态「作业中」',
    rows: replaceRow(rows, found.index, { status: DEICING_STATUS.working, pending: true, abnormal: false }),
    changed: true,
  }
}

export function submitDeicingUsage(rows: EntryRow[], id: number, rawInput: string): DeicingOpResult {
  const found = findRow(rows, id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的除冰记录`, rows, changed: false }
  }
  const status = String(found.row.status)
  if (status === DEICING_STATUS.canceled) {
    return { ok: false, message: '作业已取消并归档，用量已封存，不能再登记', rows, changed: false }
  }
  if (status === DEICING_STATUS.done) {
    return { ok: false, message: '作业已完成，实际用量已锁定', rows, changed: false }
  }
  const value = parseUsage(rawInput)
  if (value === null || value <= 0) {
    return { ok: false, message: '实际用量需为大于 0 的数字（单位：升）', rows, changed: false }
  }
  const candidate = formatUsage(value)
  if (String(found.row[DEICING_ACTUAL_FIELD] ?? '').trim() === candidate) {
    return { ok: true, message: '实际用量未变化，重复提交只生效一次', rows, changed: false }
  }
  const next = replaceRow(rows, found.index, { [DEICING_ACTUAL_FIELD]: candidate })
  return {
    ok: true,
    message: `实际用量已登记：${candidate}，${checkDeicingUsage(next[found.index]).summary}`,
    rows: next,
    changed: true,
  }
}

export function confirmDeicing(rows: EntryRow[], id: number): DeicingOpResult {
  const found = findRow(rows, id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的除冰记录`, rows, changed: false }
  }
  const status = String(found.row.status)
  if (status === DEICING_STATUS.done) {
    return { ok: true, message: '除冰已完成，重复提交只生效一次', rows, changed: false }
  }
  if (status === DEICING_STATUS.canceled) {
    return { ok: false, message: '作业已取消并归档，不能再确认完成', rows, changed: false }
  }
  const check = checkDeicingUsage(found.row)
  if (check.level !== 'pass') {
    return { ok: false, message: check.reason, rows, changed: false }
  }
  return {
    ok: true,
    message: `用量${check.summary}，除冰已确认完成`,
    rows: replaceRow(rows, found.index, {
      status: DEICING_STATUS.done,
      pending: false,
      abnormal: false,
    }),
    changed: true,
  }
}

export function cancelDeicing(rows: EntryRow[], id: number): DeicingOpResult {
  const found = findRow(rows, id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的除冰记录`, rows, changed: false }
  }
  const status = String(found.row.status)
  if (status === DEICING_STATUS.canceled) {
    return { ok: true, message: '作业已取消并归档，重复提交只生效一次', rows, changed: false }
  }
  if (status === DEICING_STATUS.done) {
    return { ok: false, message: '作业已完成，不能取消', rows, changed: false }
  }
  // 取消只改状态与归档标记，预计/实际用量等原字段原样保留，供归档查阅与导出。
  return {
    ok: true,
    message: '作业已取消，原用量已保留并归档',
    rows: replaceRow(rows, found.index, {
      status: DEICING_STATUS.canceled,
      pending: false,
      abnormal: false,
      [ARCHIVED_FLAG]: true,
    }),
    changed: true,
  }
}

/**
 * 存量兼容迁移（幂等）：
 * - 已是「已完成」却缺实际用量的作业，按预计用量补登记，绝不动取消记录；
 * - 「已取消」记录只补归档标记，状态和用量都不回写；
 * - 其余作业维持原状，等正常作业流程登记实际用量。
 */
export function migrateDeicingRows(rawRows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const rows = rawRows.map((row) => {
    if (row[MIGRATED_FLAG] === true) {
      return row
    }
    if (String(row.status) === DEICING_STATUS.canceled) {
      if (row[ARCHIVED_FLAG] === true && row.pending === false) {
        return row
      }
      changed = true
      return { ...row, pending: false, [ARCHIVED_FLAG]: true, [MIGRATED_FLAG]: true }
    }
    if (String(row.status) === DEICING_STATUS.done) {
      const actual = parseUsage(row[DEICING_ACTUAL_FIELD])
      const expected = parseUsage(row[DEICING_PLANNED_FIELD])
      // 存量已完成记录缺实际用量（空着或填的是说明性文字）：按预计用量补齐，保持完成态。
      if ((actual === null || actual <= 0) && expected !== null && expected > 0) {
        changed = true
        return {
          ...row,
          [DEICING_ACTUAL_FIELD]: formatUsage(row[DEICING_PLANNED_FIELD]),
          pending: false,
          [MIGRATED_FLAG]: true,
        }
      }
      if (row.pending !== false) {
        changed = true
        return { ...row, pending: false, [MIGRATED_FLAG]: true }
      }
    }
    return row
  })
  return { rows, changed }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出口径与列表同源：同一套字段、同一套校核写法，归档记录带标注但不丢弃。 */
export function buildDeicingCsv(rows: EntryRow[]): string {
  const header = [...DEICING_LEDGER_FIELDS, '用量校核', '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    const cells = DEICING_LEDGER_FIELDS.map((field) => {
      if (field === DEICING_PLANNED_FIELD || field === DEICING_ACTUAL_FIELD) {
        return csvCell(formatUsage(row[field]))
      }
      return csvCell(row[field])
    })
    const check = isArchivedDeicing(row) ? '已归档（原用量已封存）' : checkDeicingUsage(row).summary
    lines.push([...cells, csvCell(check), csvCell(row.status)].join(','))
  }
  return '\uFEFF' + lines.join('\n')
}

/**
 * 供航班保障台账共用：按关联航班汇总出一条除冰结论。
 * 在办作业优先于已归档；在办里完成态优先，避免一条航班挂多条除冰时结论打架。
 */
export function deicingConclusionByFlight(rows: EntryRow[]): Record<string, string> {
  const activeRank: Record<string, number> = {
    [DEICING_STATUS.done]: 0,
    [DEICING_STATUS.working]: 1,
    [DEICING_STATUS.pending]: 2,
  }
  const result: Record<string, EntryRow> = {}
  for (const row of rows) {
    const flight = String(row[DEICING_FLIGHT_FIELD] ?? '').trim()
    if (!flight) {
      continue
    }
    const previous = result[flight]
    if (!previous) {
      result[flight] = row
      continue
    }
    const prevArchived = isArchivedDeicing(previous)
    const rowArchived = isArchivedDeicing(row)
    if (prevArchived && !rowArchived) {
      result[flight] = row
    } else if (prevArchived === rowArchived) {
      const prevRank = activeRank[String(previous.status)] ?? 9
      const rowRank = activeRank[String(row.status)] ?? 9
      if (rowRank < prevRank) {
        result[flight] = row
      }
    }
  }
  return Object.fromEntries(Object.entries(result).map(([flight, row]) => [flight, describeDeicing(row)]))
}
