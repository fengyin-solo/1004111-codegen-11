<template>
  <section class="page" data-module="deicing">
    <header class="page-head">
      <div>
        <h2>除冰作业管理</h2>
        <p class="page-desc">
          围绕除冰编号、关联航班、除冰液类型、预计/实际用量做用量校核与状态流转；完成判定以校核通过为唯一口径。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记除冰记录</button>
        <button class="btn" type="button" @click="exportRows">导出除冰作业清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 用量校核台：实际用量在这里登记，校核结论与动作拦截、列表、导出同源 -->
    <section class="panel">
      <h3 class="panel-title">用量校核台</h3>
      <p class="panel-hint">
        实际用量与预计用量偏差在 ±{{ tolerancePercent }}% 内校核通过，方可确认完成；重复提交同一用量只生效一次。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>{{ CODE_FIELD }}</th>
            <th>{{ FLIGHT_FIELD }}</th>
            <th>{{ FLUID_FIELD }}</th>
            <th>{{ PLANNED_FIELD }}</th>
            <th>{{ ACTUAL_FIELD }}（升）</th>
            <th>校核结论</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in benchRows" :key="String(row.id)">
            <td>{{ row[CODE_FIELD] }}</td>
            <td>{{ row[FLIGHT_FIELD] }}</td>
            <td>{{ row[FLUID_FIELD] }}</td>
            <td>{{ displayUsage(row[PLANNED_FIELD]) || '—' }}</td>
            <td>
              <input
                v-if="String(row.status) !== STATUS.done"
                v-model="usageInputs[Number(row.id)]"
                class="usage-input"
                type="text"
                inputmode="decimal"
                placeholder="填写实际用量"
                @keyup.enter="submitUsage(row)"
              />
              <span v-else>{{ displayUsage(row[ACTUAL_FIELD]) }}</span>
            </td>
            <td>
              <span :class="['check-tag', `check-${checkOf(row).level}`]">{{ checkOf(row).summary }}</span>
            </td>
            <td class="row-actions">
              <button
                v-if="String(row.status) !== STATUS.done"
                class="link"
                type="button"
                @click="submitUsage(row)"
              >
                登记用量
              </button>
              <button
                v-if="String(row.status) === STATUS.working"
                :class="['link', { disabled: !canComplete(row) }]"
                type="button"
                :title="canComplete(row) ? '' : checkOf(row).reason"
                @click="runAction(ACTION.complete, row)"
              >
                {{ ACTION.complete }}
              </button>
            </td>
          </tr>
          <tr v-if="!benchRows.length">
            <td colspan="7" class="empty-state">暂无需要校核的在办除冰作业</td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      <label class="filter-item archive-toggle">
        <input v-model="showArchived" type="checkbox" @change="reload" />
        <span>显示已归档（已取消）记录</span>
      </label>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
          <th>用量校核</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visibleRows" :key="String(row.id)" :class="{ archived: isArchived(row) }">
          <td v-for="column in ledgerColumns" :key="column">
            <template v-if="column === PLANNED_FIELD || column === ACTUAL_FIELD">
              {{ displayUsage(row[column]) || '—' }}
            </template>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td>
            <span :class="['check-tag', `check-${checkOf(row).level}`]">
              {{ isArchived(row) ? '已归档（原用量已封存）' : checkOf(row).summary }}
            </span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsOf(row)"
              :key="action"
              :class="['link', { disabled: action === ACTION.complete && !canComplete(row) }]"
              type="button"
              :title="action === ACTION.complete && !canComplete(row) ? checkOf(row).reason : ''"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!actionsOf(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!visibleRows.length">
          <td :colspan="ledgerColumns.length + 3" class="empty-state">暂无符合条件的除冰作业数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条除冰作业记录，已归档 {{ archivedCount }} 条</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitDeicingActual,
} from '@/api/local-service'
import {
  allowedDeicingActions,
  canCompleteDeicing,
  checkDeicingUsage,
  DEICING_ACTION,
  DEICING_CORE_FIELDS,
  DEICING_LEDGER_FIELDS,
  DEICING_STATUS,
  DEICING_USAGE_TOLERANCE,
  formatUsage,
  isArchivedDeicing,
} from '@/domain/deicing'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('deicing')

const CODE_FIELD = DEICING_CORE_FIELDS[0]
const FLIGHT_FIELD = DEICING_CORE_FIELDS[1]
const FLUID_FIELD = DEICING_CORE_FIELDS[2]
const PLANNED_FIELD = DEICING_CORE_FIELDS[3]
const ACTUAL_FIELD = DEICING_CORE_FIELDS[4]
const STATUS = DEICING_STATUS
const ACTION = DEICING_ACTION

// 列口径与导出完全一致，不再在页面里另写一份字段名。
const ledgerColumns = [...DEICING_LEDGER_FIELDS]
const filterFields = [CODE_FIELD, FLIGHT_FIELD, FLUID_FIELD]
const tolerancePercent = DEICING_USAGE_TOLERANCE * 100

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const showArchived = ref(false)
const filters = ref<Record<string, string>>({})
const usageInputs = reactive<Record<number, string>>({})

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

const visibleRows = computed(() =>
  showArchived.value ? rows.value : rows.value.filter((row) => !isArchivedDeicing(row)),
)
const benchRows = computed(() =>
  rows.value.filter((row) => !isArchivedDeicing(row) && String(row.status) !== STATUS.done),
)
const archivedCount = computed(() => rows.value.filter((row) => isArchivedDeicing(row)).length)

const stats = computed(() => [
  { label: '待除冰航班', value: countByStatus(STATUS.pending) },
  { label: '作业中航班', value: countByStatus(STATUS.working) },
  { label: '已完成除冰', value: countByStatus(STATUS.done) },
])
const statusSummary = computed(() =>
  Object.values(STATUS).map((status) => ({ status, count: countByStatus(status) })),
)

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function checkOf(row: EntryRow) {
  return checkDeicingUsage(row)
}

function canComplete(row: EntryRow): boolean {
  return canCompleteDeicing(row)
}

function isArchived(row: EntryRow): boolean {
  return isArchivedDeicing(row)
}

function actionsOf(row: EntryRow): string[] {
  return allowedDeicingActions(String(row.status))
}

function displayUsage(value: unknown): string {
  return formatUsage(value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  notify(false, '除冰记录登记入口尚未接入审批流')
}

function submitUsage(row: EntryRow) {
  const input = (usageInputs[Number(row.id)] ?? '').trim()
  if (!input) {
    notify(false, '请先填写实际用量')
    return
  }
  const result = submitDeicingActual(Number(row.id), input)
  notify(result.ok, result.message)
  reload()
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  notify(result.ok, result.message)
  reload()
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    for (const row of payload.items) {
      const current = usageInputs[Number(row.id)]
      if (current === undefined) {
        usageInputs[Number(row.id)] = String(row[ACTUAL_FIELD] ?? '')
      }
    }
  } catch (error) {
    notify(false, error instanceof Error ? error.message : '除冰作业列表读取失败')
  }
}

onMounted(reload)
</script>

<style scoped>
.panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.panel-title { margin: 0 0 4px; font-size: 15px; }
.panel-hint { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
.usage-input { width: 110px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; }
.check-tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; white-space: nowrap; }
.check-pass { background: #e7f6ec; color: #1a7f37; }
.check-fail { background: #fdecec; color: #b42318; }
.check-unfilled { background: #eef2f7; color: var(--muted); }
.archive-toggle { flex-direction: row; align-items: center; gap: 6px; }
.archived { background: #f8fafc; color: var(--muted); }
.muted-text { color: var(--muted); }
.ok-text { color: #1a7f37; }
.link.disabled { color: var(--muted); cursor: not-allowed; }
</style>
