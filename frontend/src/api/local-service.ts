import {
  DEICING_ACTION_CANCEL,
  DEICING_ACTION_COMPLETE,
  DEICING_ACTION_START,
  DEICING_KEY,
  DEICING_STATUS_CANCELLED,
  DEICING_STATUS_DONE,
  DEICING_STATUS_WORKING,
  FIELD_ARCHIVED_AT,
  FLAG_ARCHIVED,
  FLAG_USAGE_LOCKED,
  availableDeicingActions,
  buildDeicingConclusion,
  buildDeicingLedger,
  deicingStatus,
  fieldText,
  hasActualUsage,
  isArchivedDeicing,
  isUsageLocked,
  normalizeUsageInput,
} from '@/domain/deicing'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import type { DeicingConclusion } from '@/domain/deicing'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  if (key === DEICING_KEY) {
    return applyDeicingAction(rows, index, action)
  }
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function persistDeicing(rows: EntryRow[], index: number, updated: EntryRow): ActionResult {
  const next = [...rows]
  next[index] = updated
  saveRows(DEICING_KEY, next)
  return { ok: true, message: `除冰记录已更新，当前状态「${String(updated.status)}」` }
}

/**
 * 除冰动作唯一入口：开始 / 确认完成 / 取消都走统一规则。
 * - 确认完成必须已有实际用量（由用量校核台登记），否则拒绝；
 * - 取消原样保留预计/实际用量，只打归档标记，归档后任何动作都不再生效；
 * - 终态重复提交一律拒绝，只生效一次。
 */
function applyDeicingAction(rows: EntryRow[], index: number, action: string): ActionResult {
  const row = rows[index]
  const current = deicingStatus(row)
  const code = fieldText(row, '除冰编号') || `#${row.id}`

  if (isArchivedDeicing(row)) {
    return { ok: false, message: `除冰记录 ${code} 已取消归档，不能再执行「${action}」` }
  }
  if (!availableDeicingActions(row).includes(action)) {
    return { ok: false, message: `除冰记录 ${code} 当前为「${current}」，不能执行「${action}」` }
  }

  if (action === DEICING_ACTION_START) {
    return persistDeicing(rows, index, {
      ...row,
      status: DEICING_STATUS_WORKING,
      pending: true,
    })
  }

  if (action === DEICING_ACTION_COMPLETE) {
    if (!hasActualUsage(row)) {
      return { ok: false, message: `除冰记录 ${code} 尚未登记实际用量，请先在用量校核台校核后再确认完成` }
    }
    return persistDeicing(rows, index, {
      ...row,
      status: DEICING_STATUS_DONE,
      pending: false,
      abnormal: false,
    })
  }

  if (action === DEICING_ACTION_CANCEL) {
    // 取消不改预计/实际用量，只做归档；重复取消会被上面的归档拦截挡掉。
    return persistDeicing(rows, index, {
      ...row,
      status: DEICING_STATUS_CANCELLED,
      pending: false,
      abnormal: false,
      [FLAG_ARCHIVED]: true,
      [FIELD_ARCHIVED_AT]: new Date().toISOString(),
    })
  }

  return { ok: false, message: `除冰记录没有登记「${action}」这个动作` }
}

/**
 * 用量校核台提交：登记实际用量并完成判定，首次提交即锁定。
 * 已经锁定（或已取消归档）的记录再提交不会改动任何数据，只返回提示，保证重复提交只生效一次。
 */
export function submitDeicingUsage(id: number, rawUsage: string): ActionResult {
  const rows = listRows(DEICING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的除冰记录` }
  }
  const row = rows[index]
  const code = fieldText(row, '除冰编号') || `#${id}`

  if (isArchivedDeicing(row)) {
    return { ok: false, message: `除冰记录 ${code} 已取消归档，不再受理用量校核` }
  }
  if (isUsageLocked(row)) {
    const conclusion = buildDeicingConclusion(row)
    return {
      ok: true,
      message: `除冰记录 ${code} 的用量已校核（${conclusion.actualText}），重复提交不生效，以首次提交为准`,
    }
  }
  const usage = normalizeUsageInput(rawUsage)
  if (!usage) {
    return { ok: false, message: '请填写大于 0 的实际用量数字' }
  }
  if (deicingStatus(row) === '待除冰') {
    return { ok: false, message: `除冰记录 ${code} 尚未开始除冰，请先执行「开始除冰」后再提交用量校核` }
  }

  const preview: EntryRow = { ...row, '实际用量': usage }
  const conclusion = buildDeicingConclusion(preview)
  const updated: EntryRow = {
    ...row,
    '实际用量': usage,
    status: DEICING_STATUS_DONE,
    pending: false,
    abnormal: false,
    [FLAG_USAGE_LOCKED]: true,
  }
  persistDeicing(rows, index, updated)
  return {
    ok: true,
    message: `除冰记录 ${code} 用量校核完成：${conclusion.checkText}，作业判定为已完成`,
  }
}

/** 航班保障台账共用的除冰结论：按航班号取该航班最新一条除冰作业。 */
export function deicingLedgerForFlight(flight: string): DeicingConclusion | null {
  return buildDeicingLedger(listRows(DEICING_KEY)).get(flight.trim()) ?? null
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === DEICING_KEY) {
    // 导出与页面动作、台账共用同一份完成判定与校核结论。
    const deicingHeader = ['编号', ...meta.fields, '当前状态', '用量校核结论', '用量对照', '是否归档']
    const deicingLines = [deicingHeader.join(',')]
    for (const row of listRows(key)) {
      const conclusion = buildDeicingConclusion(row)
      deicingLines.push(
        [
          row.id,
          ...meta.fields.map((field) => row[field] ?? ''),
          conclusion.label,
          conclusion.checkText,
          conclusion.usageText,
          conclusion.archived ? '已归档' : '在档',
        ]
          .map(csvCell)
          .join(','),
      )
    }
    return { filename: `${meta.name}-清单.csv`, content: `﻿${deicingLines.join('\n')}` }
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
