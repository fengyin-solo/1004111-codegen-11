import type { EntryRow } from '@/data/types'

/**
 * 除冰作业唯一规则源：
 * 字段、状态、动作、用量校核、完成判定、取消归档、存量迁移都收拢在这里，
 * 页面动作、列表展示、CSV 导出以及航班保障台账共用同一份结论，不再各写一遍。
 * 本文件只放纯规则，不做任何持久化；写操作统一在 local-service.ts 里调用。
 */

export const DEICING_KEY = 'deicing'

// 登记字段：除冰编号、关联航班、除冰液类型、预计用量、实际用量在全系统只在这里定义一次。
export const DEICING_FIELDS = [
  '除冰编号',
  '关联航班',
  '除冰液类型',
  '预计用量',
  '实际用量',
  '开始时间',
  '结束时间',
  '作业状态',
] as const
export type DeicingFieldName = (typeof DEICING_FIELDS)[number]

export const DEICING_STATUSES = ['待除冰', '作业中', '已完成', '已取消'] as const
export const DEICING_STATUS_PENDING = '待除冰'
export const DEICING_STATUS_WORKING = '作业中'
export const DEICING_STATUS_DONE = '已完成'
export const DEICING_STATUS_CANCELLED = '已取消'

export const DEICING_ACTIONS = ['开始除冰', '确认完成', '取消作业'] as const
export const DEICING_ACTION_START = '开始除冰'
export const DEICING_ACTION_COMPLETE = '确认完成'
export const DEICING_ACTION_CANCEL = '取消作业'

export const DEICING_ACTION_TARGETS: Record<string, string> = {
  [DEICING_ACTION_START]: DEICING_STATUS_WORKING,
  [DEICING_ACTION_COMPLETE]: DEICING_STATUS_DONE,
  [DEICING_ACTION_CANCEL]: DEICING_STATUS_CANCELLED,
}

// 校核台相关的内部标记，挂在 EntryRow 上，随 localStorage 一起持久化。
export const DEICING_SCHEMA_VERSION = 2
export const FLAG_SCHEMA_VERSION = '_deicingSchemaVersion'
export const FLAG_ARCHIVED = 'archived'
export const FLAG_USAGE_LOCKED = '用量校核锁定'
export const FIELD_ARCHIVED_AT = '归档时间'
export const FIELD_MIGRATION_NOTE = '迁移备注'

/** 用量偏差允许范围：实际用量与预计用量相差 ±10% 内算用量正常。 */
export const USAGE_TOLERANCE = 0.1
export const USAGE_UNIT = 'L'

export type UsageCheckKind =
  | '用量正常'
  | '用量超耗'
  | '用量偏低'
  | '缺登记'
  | '无法校核'

export type DeicingConclusion = {
  /** 主结论：待除冰 / 作业中 / 已完成 / 已取消归档 */
  label: string
  completed: boolean
  cancelled: boolean
  archived: boolean
  /** 实际用量是否已经在用量校核台提交锁定 */
  checked: boolean
  expectedAmount: number | null
  actualAmount: number | null
  expectedText: string
  actualText: string
  /** 预计与实际的偏差百分比，缺数字时为 null */
  deviationPercent: number | null
  usageKind: UsageCheckKind
  /** 给列表、导出、台账共用的校核结论文案，例如「用量正常（偏差 +2.5%）」 */
  checkText: string
  /** 给台账用的用量对照文案，例如「800 L → 820 L」 */
  usageText: string
}

export function deicingStatus(row: EntryRow): string {
  return String(row.status ?? '')
}

export function fieldText(row: EntryRow, field: DeicingFieldName): string {
  return String(row[field] ?? '').trim()
}

/** 从「800 L」「820升」这类文案里取出首个数字，取不到返回 null。 */
export function parseAmount(text: string): number | null {
  const matched = text.match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return null
  }
  const value = Number(matched[0])
  return Number.isFinite(value) ? value : null
}

export function isCancelledDeicing(row: EntryRow): boolean {
  return deicingStatus(row) === DEICING_STATUS_CANCELLED
}

export function isArchivedDeicing(row: EntryRow): boolean {
  return Boolean(row[FLAG_ARCHIVED]) || isCancelledDeicing(row)
}

/** 实际用量已登记（校核台只会写入合法数字，这里以非空作为登记口径）。 */
export function hasActualUsage(row: EntryRow): boolean {
  return fieldText(row, '实际用量') !== ''
}

/**
 * 统一完成判定（动作、列表、导出、台账共用这一处）：
 * 状态是「已完成」且实际用量已登记才算完成；缺实际用量一律不算。
 */
export function isCompletedDeicing(row: EntryRow): boolean {
  return deicingStatus(row) === DEICING_STATUS_DONE && hasActualUsage(row)
}

export function isUsageLocked(row: EntryRow): boolean {
  return Boolean(row[FLAG_USAGE_LOCKED])
}

/** 校核台输入归一：数字补统一单位，非法输入返回 null 由调用方拒绝。 */
export function normalizeUsageInput(raw: string): string | null {
  const matched = raw.trim().match(/-?\d+(\.\d+)?/)
  if (!matched || Number(matched[0]) <= 0) {
    return null
  }
  return `${matched[0]} ${USAGE_UNIT}`
}

/** 预计/实际用量的校核分级与偏差，供校核台实时预览和结论汇总共用。 */
export function classifyUsage(expectedText: string, actualText: string): {
  kind: UsageCheckKind
  deviationPercent: number | null
  text: string
} {
  const expected = parseAmount(expectedText)
  const actual = parseAmount(actualText)
  if (actualText.trim() === '') {
    return { kind: '缺登记', deviationPercent: null, text: '实际用量未登记' }
  }
  if (expected === null || actual === null) {
    return { kind: '无法校核', deviationPercent: null, text: '用量不是可校核的数字' }
  }
  if (expected === 0) {
    return { kind: '无法校核', deviationPercent: null, text: '预计用量为 0，无法校核偏差' }
  }
  const deviationPercent = ((actual - expected) / expected) * 100
  const sign = deviationPercent > 0 ? '+' : ''
  const ratioText = `偏差 ${sign}${deviationPercent.toFixed(1)}%`
  let kind: UsageCheckKind
  if (Math.abs(deviationPercent) <= USAGE_TOLERANCE * 100) {
    kind = '用量正常'
  } else if (deviationPercent > 0) {
    kind = '用量超耗'
  } else {
    kind = '用量偏低'
  }
  return { kind, deviationPercent, text: `${kind}（${ratioText}）` }
}

/** 当前状态下允许出现的动作按钮，归档/终态一律收敛为空。 */
export function availableDeicingActions(row: EntryRow): string[] {
  if (isArchivedDeicing(row)) {
    return []
  }
  switch (deicingStatus(row)) {
    case DEICING_STATUS_PENDING:
      return [DEICING_ACTION_START, DEICING_ACTION_CANCEL]
    case DEICING_STATUS_WORKING:
      // 没有实际用量不能确认完成，先去用量校核台登记。
      return hasActualUsage(row)
        ? [DEICING_ACTION_COMPLETE, DEICING_ACTION_CANCEL]
        : [DEICING_ACTION_CANCEL]
    default:
      return []
  }
}

/** 计算一条除冰作业的统一结论，列表、导出、航班保障台账都消费这份结果。 */
export function buildDeicingConclusion(row: EntryRow): DeicingConclusion {
  const expectedText = fieldText(row, '预计用量')
  const actualText = fieldText(row, '实际用量')
  const expectedAmount = parseAmount(expectedText)
  const actualAmount = parseAmount(actualText)
  const cancelled = isCancelledDeicing(row)
  const archived = isArchivedDeicing(row)
  const completed = isCompletedDeicing(row)
  const checked = isUsageLocked(row) && hasActualUsage(row)

  const usage = classifyUsage(expectedText, actualText)
  const checkText = cancelled
    ? '已归档，用量不再校核'
    : actualText === ''
      ? '实际用量未登记'
      : usage.text
  const usageText =
    expectedText || actualText
      ? `${expectedText || '—'} → ${actualText || '未登记'}`
      : '—'

  let label: string
  if (cancelled || archived) {
    label = '已取消归档'
  } else if (completed) {
    label = DEICING_STATUS_DONE
  } else if (deicingStatus(row) === DEICING_STATUS_WORKING) {
    label = DEICING_STATUS_WORKING
  } else if (deicingStatus(row) === DEICING_STATUS_PENDING) {
    label = DEICING_STATUS_PENDING
  } else {
    label = deicingStatus(row) || '未知状态'
  }

  return {
    label,
    completed,
    cancelled,
    archived,
    checked,
    expectedAmount,
    actualAmount,
    expectedText,
    actualText,
    deviationPercent: usage.deviationPercent,
    usageKind: actualText === '' ? '缺登记' : usage.kind,
    checkText,
    usageText,
  }
}

/**
 * 按关联航班汇总除冰结论，供航班保障台账等外部模块共用。
 * 同一航班存在多条除冰作业时，取编号最大（最新登记）的一条作为台账结论。
 */
export function buildDeicingLedger(rows: EntryRow[]): Map<string, DeicingConclusion> {
  const ledger = new Map<string, DeicingConclusion>()
  const latestId = new Map<string, number>()
  for (const row of rows) {
    const flight = fieldText(row, '关联航班')
    if (!flight) {
      continue
    }
    const currentId = latestId.get(flight)
    if (currentId !== undefined && currentId > Number(row.id)) {
      continue
    }
    latestId.set(flight, Number(row.id))
    ledger.set(flight, buildDeicingConclusion(row))
  }
  return ledger
}

export type DeicingMigrationResult = {
  rows: EntryRow[]
  changed: boolean
  notes: string[]
}

/**
 * 存量数据兼容迁移（按 schema 版本只执行一次，幂等）：
 * - 已取消作业：只补归档标记并原样保留用量，绝不写回「已完成」；
 * - 已完成但缺实际用量：按兼容口径用预计用量补录实际用量，使其仍满足新的完成判定；
 * - 其余在途作业不动，等待用量校核台登记。
 */
export function migrateDeicingRows(rows: EntryRow[]): DeicingMigrationResult {
  const notes: string[] = []
  let changed = false
  const next = rows.map((row) => {
    if (Number(row[FLAG_SCHEMA_VERSION]) >= DEICING_SCHEMA_VERSION) {
      return row
    }
    const migrated: EntryRow = { ...row }
    const status = deicingStatus(row)

    if (status === DEICING_STATUS_CANCELLED) {
      // 红线：已取消记录只做归档，不碰状态、不碰用量，更不能写回完成。
      migrated[FLAG_ARCHIVED] = true
      if (!migrated[FIELD_MIGRATION_NOTE]) {
        migrated[FIELD_MIGRATION_NOTE] = '存量已取消作业，迁移时原样归档'
      }
      notes.push(`除冰记录 ${fieldText(row, '除冰编号') || row.id} 已取消，按原用量归档`)
    } else if (status === DEICING_STATUS_DONE && !hasActualUsage(row)) {
      const expected = fieldText(row, '预计用量')
      if (expected) {
        migrated['实际用量'] = expected
        migrated[FLAG_USAGE_LOCKED] = true
        migrated[FIELD_MIGRATION_NOTE] = '存量数据缺实际用量，按预计用量兼容补录'
        notes.push(`除冰记录 ${fieldText(row, '除冰编号') || row.id} 缺实际用量，按预计用量兼容补录`)
      }
    }

    migrated[FLAG_SCHEMA_VERSION] = DEICING_SCHEMA_VERSION
    changed = true
    return migrated
  })
  return { rows: next, changed, notes }
}
