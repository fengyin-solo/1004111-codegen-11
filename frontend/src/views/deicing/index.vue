<template>
  <section class="page" data-module="deicing">
    <header class="page-head">
      <div>
        <h2>除冰作业管理</h2>
        <p class="page-desc">
          围绕除冰编号、关联航班、除冰液类型、预计用量与实际用量做用量校核、完成判定与取消归档；
          完成口径全系统统一，航班保障台账共用本页结论。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记除冰记录</button>
        <button class="btn" type="button" @click="exportRows">导出除冰作业清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 用量校核台：只受理在途且未校核的作业，提交后首次即锁定，重复提交不生效。 -->
    <section class="verify-panel">
      <h3>用量校核台</h3>
      <p class="page-desc">
        预计用量与实际用量偏差 ±{{ tolerancePercent }}% 内判为用量正常；提交校核即登记实际用量并判定完成，
        取消作业保留原用量并归档。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>除冰编号</th>
            <th>关联航班</th>
            <th>除冰液类型</th>
            <th>预计用量</th>
            <th>当前状态</th>
            <th>实际用量（L）</th>
            <th>校核预览</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in workbenchRows" :key="`verify-${String(row.id)}`">
            <td>{{ row['除冰编号'] }}</td>
            <td>{{ row['关联航班'] }}</td>
            <td>{{ row['除冰液类型'] }}</td>
            <td>{{ row['预计用量'] }}</td>
            <td>{{ row.status }}</td>
            <td>
              <input
                v-model="drafts[Number(row.id)]"
                type="number"
                min="0"
                step="1"
                placeholder="填写实际用量"
              />
            </td>
            <td>{{ previewOf(row) }}</td>
            <td>
              <button class="link" type="button" @click="submitUsage(row)">提交校核</button>
            </td>
          </tr>
          <tr v-if="!workbenchRows.length">
            <td colspan="8" class="empty-state">没有待校核的在途除冰作业</td>
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
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>用量校核结论</th>
          <th>统一完成判定</th>
          <th>归档</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>{{ conclusionOf(row).checkText }}</td>
          <td>{{ conclusionOf(row).completed ? '已完成' : '未完成' }}</td>
          <td>{{ conclusionOf(row).archived ? '已归档' : '在档' }}</td>
          <td>{{ conclusionOf(row).label }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 5" class="empty-state">暂无除冰作业数据，可先登记除冰记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条除冰作业记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
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
  submitDeicingUsage,
} from '@/api/local-service'
import {
  DEICING_FIELDS,
  DEICING_STATUSES,
  USAGE_TOLERANCE,
  availableDeicingActions,
  buildDeicingConclusion,
  classifyUsage,
  fieldText,
  isArchivedDeicing,
  isUsageLocked,
  normalizeUsageInput,
} from '@/domain/deicing'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('deicing')
const columns = [...DEICING_FIELDS]
const tolerancePercent = USAGE_TOLERANCE * 100

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const drafts = reactive<Record<number, string>>({})

const statusSummary = computed(() =>
  [...DEICING_STATUSES].map((status) => ({
    status: status === '已取消' ? '已取消归档' : status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const statCards = computed(() => [
  { label: '待除冰航班', value: rows.value.filter((row) => row.status === '待除冰').length },
  { label: '作业中航班', value: rows.value.filter((row) => row.status === '作业中').length },
  { label: '已完成除冰', value: rows.value.filter((row) => buildDeicingConclusion(row).completed).length },
  { label: '已取消归档', value: rows.value.filter((row) => isArchivedDeicing(row)).length },
])

// 校核台只受理已开工（作业中）且用量未锁定的作业；待除冰先执行「开始除冰」。
const workbenchRows = computed(() =>
  rows.value.filter((row) => row.status === '作业中' && !isUsageLocked(row)),
)

function conclusionOf(row: EntryRow) {
  return buildDeicingConclusion(row)
}

function availableActions(row: EntryRow): string[] {
  return availableDeicingActions(row)
}

function previewOf(row: EntryRow): string {
  const draft = drafts[Number(row.id)]?.trim() ?? ''
  if (!draft) {
    return '待填写'
  }
  if (!normalizeUsageInput(draft)) {
    return '用量需为大于 0 的数字'
  }
  return classifyUsage(fieldText(row, '预计用量'), normalizeUsageInput(draft) ?? '').text
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '除冰记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function submitUsage(row: EntryRow) {
  errorMessage.value = ''
  const draft = drafts[Number(row.id)] ?? ''
  const result = submitDeicingUsage(Number(row.id), draft)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  delete drafts[Number(row.id)]
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '除冰作业列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.verify-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.verify-panel h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.verify-panel input {
  width: 110px;
  padding: 4px 6px;
}
.muted-text {
  color: var(--muted);
}
</style>
