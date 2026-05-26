// API 调用封装
// Electron 打包后前端是本地文件，需要用完整 URL 访问后端
const BASE = typeof window !== 'undefined' && window.location.protocol === 'file:'
  ? 'http://localhost:8000/api'
  : '/api'

export interface GraphSummary {
  name: string
  doc_count: number
  relation_count: number
}

export interface Doc {
  id: string
  name: string
  rel_path: string
  ext: string
  size: number
  char_count: number
  category?: string
  keywords?: string[]
  summary?: string
  people?: string[]
  phase?: string
  preview?: string
  metrics?: { name: string; value: string; unit?: string; context?: string }[]
  timeline?: { date: string; event: string }[]
  entities?: { name: string; type: string }[]
  citations?: { source: string; context?: string }[]
}

export interface RelatedDoc {
  doc_id: string
  doc_name: string
  category?: string
  summary?: string
  score: number
  reasons: { type: string; detail: any; weight: number }[]
}

export interface Relation {
  from: string
  to: string
  type: string
  confidence: number
  reason?: string
  directional?: boolean
}

export interface DocGroup {
  type: string  // 同一批次 / 同一项目
  doc_ids: string[]
  topic: string
}

export interface Phase {
  id: string
  name: string
  path_pattern: string
  doc_ids: string[]
  order: number
  summary?: string
  objective?: string
  outputs?: string[]
  key_findings?: string[]
  auto_score?: number
  doc_count?: number
  rationale?: string
  children?: Phase[]
  level?: number
}

export interface PhaseFlowNode {
  id: string
  label: string
  role?: string
}
export interface PhaseFlowEdge {
  from: string
  to: string
  label?: string
  type?: string  // feeds | derives | concludes | references
}
export interface PhaseFlow {
  nodes: PhaseFlowNode[]
  edges: PhaseFlowEdge[]
  insight?: string
  generated_at?: number
}

export interface GraphData {
  name: string
  docs: Doc[]
  relations: Relation[]
  groups?: DocGroup[]
  phases?: Phase[]
  phase_flow?: PhaseFlow
  folder?: string
}

export interface TaskStatus {
  running: boolean
  progress: number
  total: number
  current: string
  result: any
}

export async function fetchGraphs(): Promise<GraphSummary[]> {
  const res = await fetch(`${BASE}/graphs`)
  const data = await res.json()
  return data.graphs
}

export async function fetchGraph(name: string): Promise<GraphData> {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`图谱不存在: ${name}`)
  return res.json()
}

export async function scanFolder(folder: string, name: string, schemaId?: string) {
  const res = await fetch(`${BASE}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, name, schema: schemaId }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '扫描失败')
  }
  return res.json()
}

export async function scanFromFiles(name: string, files: string[], commonRoot?: string, schemaId?: string) {
  const res = await fetch(`${BASE}/scan/from-files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, files, common_root: commonRoot, schema: schemaId }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '创建图谱失败')
  }
  return res.json()
}

export interface SchemaInfo {
  id: string
  name: string
  description: string
  relation_count: number
  relations: string[]
  relation_details: Array<{ type: string; directional: boolean; desc: string }>
}

export async function listSchemas(): Promise<{ schemas: SchemaInfo[] }> {
  const res = await fetch(`${BASE}/schemas`)
  if (!res.ok) throw new Error('获取关系库列表失败')
  return res.json()
}

export async function setGraphSchema(graphName: string, schemaId: string) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: schemaId }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '切换关系库失败')
  }
  return res.json()
}

export async function startClassify(graphName: string, model?: string, mode?: string) {
  const res = await fetch(`${BASE}/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph_name: graphName, model, mode: mode || 'standard' }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '启动失败')
  }
  return res.json()
}

export async function startRelations(graphName: string, model?: string, mode?: string) {
  const res = await fetch(`${BASE}/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph_name: graphName, model, mode: mode || 'standard' }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '启动失败')
  }
  return res.json()
}

export interface UpdatePreview {
  folder: string
  added: Array<{ id: string; name: string; rel_path: string; size?: number; mtime?: number }>
  modified: Array<{ id: string; name: string; rel_path: string; size?: number; mtime?: number }>
  deleted: Array<{ id: string; name: string; rel_path: string; size?: number; mtime?: number }>
  unchanged_count: number
}

export async function previewUpdate(graphName: string, folder?: string): Promise<UpdatePreview> {
  const res = await fetch(`${BASE}/update/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph_name: graphName, folder }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '预览失败')
  }
  return res.json()
}

export async function startUpdate(graphName: string, mode = 'standard', folder?: string, skipRelations = false) {
  const res = await fetch(`${BASE}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph_name: graphName, folder, mode, skip_relations: skipRelations }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '启动失败')
  }
  return res.json()
}

export async function fetchTaskStatus(taskName: string): Promise<TaskStatus> {
  const res = await fetch(`${BASE}/task/${encodeURIComponent(taskName)}`)
  if (!res.ok) throw new Error(`查询任务状态失败: ${taskName}`)
  return res.json()
}

export async function deleteRelation(graphName: string, index: number, rel?: { from: string; to: string; type: string }) {
  // 优先用精确匹配（from+to+type），防止并发时索引偏移删错关系
  const params = rel ? `?src=${encodeURIComponent(rel.from)}&dst=${encodeURIComponent(rel.to)}&rel_type=${encodeURIComponent(rel.type)}` : ''
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/relations/${index}${params}`, {
    method: 'DELETE',
  })
  return res.json()
}

export async function buildNumberIndex(graphName: string) {
  const res = await fetch(`${BASE}/number/build-index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph_name: graphName }),
  })
  if (!res.ok) throw new Error('构建数字索引失败')
  return res.json()
}

export async function searchNumber(graphName: string, query: string, tolerance: number, useLlm: boolean) {
  const res = await fetch(`${BASE}/number/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph_name: graphName, query, tolerance, use_llm: useLlm }),
  })
  if (!res.ok) throw new Error('搜索失败')
  return res.json()
}

export async function fetchRelated(graphName: string, docId: string, topN = 6, signal?: AbortSignal): Promise<RelatedDoc[]> {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/related/${encodeURIComponent(docId)}?top_n=${topN}`, { signal })
  if (!res.ok) return []
  const data = await res.json()
  return data.related || []
}

export async function deleteGraph(name: string) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '删除失败')
  }
  return res.json()
}

export async function renameGraph(name: string, newName: string): Promise<{ name: string }> {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(name)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_name: newName }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '重命名失败')
  }
  return res.json()
}

export interface DocMetaUpdate {
  category?: string
  keywords?: string[]
  summary?: string
  phase?: string
  people?: string[]
  metrics?: { name: string; value: string; unit?: string; context?: string }[]
}

export async function updateDocMeta(graphName: string, docId: string, update: DocMetaUpdate) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/docs/${encodeURIComponent(docId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '更新失败')
  }
  return res.json()
}

// ============ 分类管理 ============

export async function listCategories(graphName: string) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/categories`)
  if (!res.ok) throw new Error('获取分类失败')
  return res.json() as Promise<{ categories: { name: string; count: number }[] }>
}

export async function mergeCategories(graphName: string, mapping: Record<string, string>) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/categories/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapping }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '合并失败')
  }
  return res.json()
}

export async function renameCategory(graphName: string, oldName: string, newName: string) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/categories/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_name: oldName, new_name: newName }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '重命名失败')
  }
  return res.json()
}


// ============ 阶段（Phase）API ============

export async function proposePhases(graphName: string, refine = true): Promise<{
  candidates: Phase[]
  uncategorized_doc_ids: string[]
  total_docs: number
}> {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/phases/propose?refine=${refine}`)
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '提议阶段失败')
  }
  return res.json()
}

export async function confirmPhases(graphName: string, phases: Phase[], generateSummaries = true) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/phases/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph_name: graphName, phases, generate_summaries: generateSummaries }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '确认阶段失败')
  }
  return res.json()
}

export async function clearPhases(graphName: string) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/phases`, { method: 'DELETE' })
  if (!res.ok) throw new Error('清除失败')
  return res.json()
}

// 直接保存编辑后的阶段树（拖拽完成后用，不重新生成总结）
export async function savePhases(graphName: string, phases: Phase[]) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/phases`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phases }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '保存失败')
  }
  return res.json()
}

// 自动更新：基于目录结构合并新文档到已有阶段（保留手动调整）
export async function autoUpdatePhases(graphName: string, generateSummariesForNew = true) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/phases/auto-update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generate_summaries_for_new: generateSummariesForNew }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '自动更新失败')
  }
  return res.json()
}

// 触发流程图分析
export async function analyzePhaseFlow(graphName: string) {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/phases/flow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '流程分析失败')
  }
  return res.json()
}

// 直接读取已生成的流程图
export async function fetchPhaseFlow(graphName: string): Promise<PhaseFlow | null> {
  const res = await fetch(`${BASE}/graphs/${encodeURIComponent(graphName)}/phases/flow`)
  if (!res.ok) return null
  const data = await res.json()
  return data.flow || null
}

// ========== 全量扫描 ==========
export interface FullScanRoot {
  label: string
  path: string
  exists: boolean
}

export interface SubdirInfo {
  name: string
  path: string
  file_count: number
  total_bytes: number
  is_dir: boolean
}

export interface LooseFile {
  name: string
  path: string
  size: number
  mtime: number
}

export interface ScanRootListing {
  root: string
  exists: boolean
  subdirs: SubdirInfo[]
  loose_files: LooseFile[]
}

export interface FileInClusterMeta {
  path: string
  name: string
  ext: string
  size: number
  mtime: number
  rel_dir: string
  scan_root: string
}

export interface ScanCluster {
  id: string
  kind: string
  llm_kind?: string
  label: string
  root_path: string
  scan_root: string
  files: FileInClusterMeta[]
  file_count: number
  total_bytes: number
  ext_distribution: Record<string, number>
  info_score: number
  redundant: boolean
  split_hint: string[]
  parent_id?: string | null
  child_ids?: string[]
}

export interface CrossLink {
  source_cluster_id: string
  target_cluster_id: string
  source_file: string
  source_name: string
  target_file: string
  target_name: string
  link_type: string
  detail: string
  confidence: number
  reason?: string
}

export interface FullScanResult {
  id?: string
  name?: string
  scan_paths: string[]
  file_count: number
  cluster_count: number
  clusters: ScanCluster[]
  cross_links?: CrossLink[]
  scanned_at: number
  elapsed_sec: number
  llm_used?: boolean
  llm_review_count?: number
}

export interface FullScanHistoryItem {
  id: string
  name: string
  scan_paths: string[]
  file_count: number
  cluster_count: number
  scanned_at: number
  elapsed_sec: number
  llm_used: boolean
}

export interface FullScanStatus {
  running: boolean
  phase: string
  message: string
  progress: number
  error: string | null
  started_at: number | null
  has_result: boolean
}

export async function fetchFullScanDefaults(): Promise<{ roots: FullScanRoot[] }> {
  const res = await fetch(`${BASE}/fullscan/defaults`)
  if (!res.ok) throw new Error('获取默认目录失败')
  return res.json()
}

export async function fetchFullScanList(roots: string[]): Promise<{ items: ScanRootListing[] }> {
  const res = await fetch(`${BASE}/fullscan/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roots }),
  })
  if (!res.ok) throw new Error('列出子目录失败')
  return res.json()
}

export async function startFullScan(paths: string[], useLlm = true, name?: string, deepExplore = false): Promise<{ started: boolean; id: string; name: string }> {
  const res = await fetch(`${BASE}/fullscan/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, use_llm: useLlm, name, deep_explore: deepExplore }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.detail || '启动扫描失败')
  }
  return res.json()
}

export async function fetchFullScanHistory(): Promise<{ items: FullScanHistoryItem[] }> {
  const res = await fetch(`${BASE}/fullscan/history`)
  return res.json()
}

export async function loadFullScanHistory(id: string): Promise<FullScanResult> {
  const res = await fetch(`${BASE}/fullscan/history/${id}`)
  if (!res.ok) throw new Error('加载历史扫描失败')
  return res.json()
}

export async function deleteFullScanHistory(id: string): Promise<void> {
  const res = await fetch(`${BASE}/fullscan/history/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('删除失败')
}

export async function renameFullScanHistory(id: string, name: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${BASE}/fullscan/history/${id}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '重命名失败')
  }
  return res.json()
}

// ---------- 群结构编辑 ----------

export async function updateCluster(scanId: string, clusterId: string, patch: {
  label?: string
  llm_kind?: string
  redundant?: boolean
  info_score?: number
}): Promise<ScanCluster> {
  const res = await fetch(`${BASE}/fullscan/history/${scanId}/clusters/${clusterId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '更新群失败')
  }
  return res.json()
}

export async function deleteCluster(scanId: string, clusterId: string): Promise<{ deleted: string[] }> {
  const res = await fetch(`${BASE}/fullscan/history/${scanId}/clusters/${clusterId}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '删除群失败')
  }
  return res.json()
}

export async function mergeClusters(scanId: string, body: {
  cluster_ids: string[]
  new_label?: string
  new_kind?: string
}): Promise<ScanCluster> {
  const res = await fetch(`${BASE}/fullscan/history/${scanId}/clusters/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '合并失败')
  }
  return res.json()
}

export async function splitCluster(scanId: string, clusterId: string, body: {
  file_paths: string[]
  new_label: string
  new_kind?: string
}): Promise<ScanCluster> {
  const res = await fetch(`${BASE}/fullscan/history/${scanId}/clusters/${clusterId}/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '拆分失败')
  }
  return res.json()
}

export async function applyCrossLinks(scanId: string, linkIndexes: number[]): Promise<{
  total: number
  applied: number
  results: { link_idx: number; applied: boolean; graphs?: string[]; reason?: string }[]
}> {
  const res = await fetch(`${BASE}/fullscan/history/${scanId}/cross-links/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_indexes: linkIndexes }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '同步失败')
  }
  return res.json()
}

export async function fetchFullScanStatus(): Promise<FullScanStatus> {
  const res = await fetch(`${BASE}/fullscan/status`)
  if (!res.ok) throw new Error('查询扫描状态失败')
  return res.json()
}

export async function fetchFullScanResult(): Promise<FullScanResult | null> {
  const res = await fetch(`${BASE}/fullscan/result`)
  if (!res.ok) return null
  return res.json()
}

// ========== 超级搜索对话 ==========

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatResult {
  id: string
  docId: string
  title: string
  preview: string
  graphName: string
  icon: string
}

export interface ChatResponse {
  reply: string
  results: ChatResult[]
  tokens_used: number
}

export async function chatWithDocs(messages: ChatMessage[], mode?: string): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, mode }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '对话失败')
  }
  return res.json()
}

export interface StreamEvent {
  type: 'status' | 'token' | 'results' | 'done'
  text?: string
  data?: ChatResult[]
}

export async function chatWithDocsStream(
  messages: ChatMessage[],
  mode: string | undefined,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, mode }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '对话失败')
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('无法读取流')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const event = JSON.parse(line.slice(6)) as StreamEvent
          onEvent(event)
        } catch { /* skip malformed */ }
      }
    }
  }
}
