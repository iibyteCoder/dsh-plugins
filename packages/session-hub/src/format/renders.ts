/**
 * Pure renderers for tool results.
 *
 * Tools own validation and host calls; every user-visible string is built
 * here so text changes are reviewable in one place.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { ErrorCode, SessionEventKind, WaitOutcome } from '../shared/enums.js'
import { sessionHubError } from '../shared/errors.js'
import { MAX_RECENT_MESSAGE_CHARS, MAX_REPLY_CHARS, SEARCH_SNIPPET_CHARS } from '../shared/limits.js'
import type {
  CreatedSessionView,
  ModelChangeView,
  ModelSelection,
  SearchView,
  SessionDetail,
  SessionListView,
  SessionMessageView,
  TitleChangeView,
  UpdatedSessionView,
} from '../shared/types.js'
import { formatTable, formatTime, truncateText } from './text.js'

const LIST_HEADER = ['ID', 'TITLE', 'WORKSPACE', 'CWD', 'STATUS', 'MODEL', 'OWNER', 'UPDATED']

const SEARCH_HEADER = ['ID', 'TITLE', 'SNIPPET']

/** The output projection shared by every tool: the result string as text. */
export function renderText(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: String(value ?? '') }]
}

/** Render the `session_list` result. */
export function renderSessionList(view: SessionListView): string {
  if (view.total === 0) return '未找到匹配的会话。'

  const rows = view.rows.map((row) => [
    row.id,
    row.title === '' ? '-' : row.title,
    row.workspace,
    row.cwd === '' ? '-' : row.cwd,
    row.status,
    row.model === '' ? '-' : row.model,
    row.owner,
    formatTime(row.updatedAt),
  ])
  const table = formatTable([LIST_HEADER, ...rows])
  return `${table}\n\n共 ${view.total} 个会话（显示 ${view.rows.length} 个）`
}

/** Render the `session_search` result. */
export function renderSearchResults(view: SearchView): string {
  if (view.hits.length === 0) return '没有匹配的会话。'

  const rows = view.hits.map((hit) => [
    hit.sessionId,
    hit.title === '' ? '-' : hit.title,
    truncateText(hit.snippet, SEARCH_SNIPPET_CHARS),
  ])
  // `total` counts the raw host hits, `view.hits` is already collapsed to one
  // row per session, and `shown` is how many rows the table actually renders.
  const sessions = view.hits.length
  const shown = rows.length
  const lines = [
    formatTable([SEARCH_HEADER, ...rows]),
    '',
    `共 ${view.total} 条命中，涉及 ${sessions} 个会话（显示 ${shown} 个）`,
  ]
  if (view.hasMore) lines.push('（还有更多结果，请缩小查询）')
  return lines.join('\n')
}

/** Render the `session_get` result. */
export function renderSessionDetail(detail: SessionDetail): string {
  const lines = [
    `会话 ${detail.id}`,
    `- id: ${detail.id}`,
    `- createdAt: ${formatTime(detail.createdAt)}`,
    `- cwd: ${displayValue(detail.cwd)}`,
    `- parentSession: ${displayValue(detail.parentSession)}`,
    `- origin: ${displayValue(detail.origin)}`,
    `- agentPreset: ${displayValue(detail.agentPreset)}`,
    `- status: ${detail.status}`,
    `- owner: ${detail.owner}`,
  ]

  if (detail.recentMessages.length > 0) {
    lines.push('', '最近消息：')
    detail.recentMessages.forEach((message, index) => {
      lines.push(`${index + 1}. ${renderRecentMessage(message)}`)
    })
  }

  return lines.join('\n')
}

function renderRecentMessage(message: SessionMessageView): string {
  const role = message.type === SessionEventKind.UserMessage ? 'user' : 'assistant'
  const label = role === 'user' && message.kind !== '' ? `${role}:${message.kind}` : role
  const text = truncateText(message.text, MAX_RECENT_MESSAGE_CHARS)
  return `[${label}] ${text === '' ? '(无文本内容)' : text}`
}

/** Render the `session_wait` result. */
export function renderWait(
  sessionId: string,
  outcome: WaitOutcome,
  timeoutMs: number,
  reply: string,
): string {
  if (outcome === WaitOutcome.Archived) return `会话 ${sessionId} 已归档，不会运行`
  if (outcome === WaitOutcome.Cold) return `会话 ${sessionId} 空闲（未加载）`
  if (outcome === WaitOutcome.Timeout) {
    return sessionHubError(
      ErrorCode.WaitTimeout,
      `session "${sessionId}" did not become idle within ${timeoutMs}ms`,
    )
  }

  const idle = `会话 ${sessionId} 已空闲`
  const text = truncateText(reply, MAX_REPLY_CHARS)
  return text === '' ? idle : `${idle}\n- reply: ${text}`
}

/** Render the `session_close` result. */
export function renderClosed(sessionId: string): string {
  return `已关闭会话 ${sessionId}（已归档，可用 session_open 恢复）`
}

/** Render the `session_open` result. */
export function renderOpened(sessionId: string): string {
  return `已恢复会话 ${sessionId}`
}

/** Render the selected model, including the reasoning effort when set. */
export function renderModelSelection(selection: ModelSelection): string {
  const base = `${selection.provider}/${selection.model}`
  return selection.reasoningEffort === undefined ? base : `${base} (${selection.reasoningEffort})`
}

/** Render the `session_create` result. */
export function renderCreated(view: CreatedSessionView): string {
  const lines = [
    `已创建会话 ${view.sessionId}`,
    `- workspace: ${view.workspace}`,
    `- cwd: ${view.cwd}`,
    `- agentPreset: ${view.agentPreset}`,
    `- owner: ${view.owner}`,
  ]
  appendTitle(lines, view.title)
  appendModel(lines, view.model, (error) => `失败（${error}）`)
  lines.push(`- started: ${view.started}`)
  return lines.join('\n')
}

/** Render the `session_update` result. */
export function renderUpdated(view: UpdatedSessionView): string {
  const lines = [`已更新会话 ${view.sessionId}`]
  appendTitle(lines, view.title)
  appendModel(lines, view.model, (error) => `失败（${error}）`)
  return lines.join('\n')
}

function appendTitle(lines: string[], change: TitleChangeView | undefined): void {
  if (change === undefined) return
  if (change.value !== undefined) {
    lines.push(`- title: ${change.value}`)
    return
  }
  if (change.error !== undefined) lines.push(`- title: 设置失败（${change.error}）`)
}

function appendModel(
  lines: string[],
  change: ModelChangeView | undefined,
  failure: (error: string) => string,
): void {
  if (change === undefined) return
  if (change.value !== undefined) {
    lines.push(`- model: ${change.value}`)
    return
  }
  if (change.error !== undefined) lines.push(`- model: ${failure(change.error)}`)
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'object') {
    const record = value as { readonly id?: unknown; readonly kind?: unknown }
    if (typeof record.id === 'string') return record.id
    if (typeof record.kind === 'string') return record.kind
    return '-'
  }
  return '-'
}
