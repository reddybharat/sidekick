// Hand-written mirror of the backend schemas (backend/app/api/schemas, domain/models.py).
// shortcut: no codegen (openapi-typescript needs TypeScript 5); generate types if the API grows.
import type { Turn } from '@/components/Chat'

const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export interface Session {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export interface ModelInfo {
  id: string
  provider: string
  model_name: string
  supports_tools: boolean
}

export type DocumentStatus = 'pending' | 'ready' | 'failed'

export interface LibraryDocument {
  id: string
  filename: string
  page_count: number | null
  status: DocumentStatus
  error: string | null
  created_at: string
  has_file: boolean
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; ok: boolean }
  | { type: 'done'; input_tokens: number; output_tokens: number; latency_ms: number }
  | { type: 'error'; code: string; message: string }

export class ApiError extends Error {}

/** The backend's `{"error": {code, message}}` message (core/errors.py), else the status. */
function errorMessage(status: number, body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return typeof message === 'string' ? message : `Request failed (${status})`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init)
  if (!res.ok) throw new ApiError(errorMessage(res.status, await res.json().catch(() => null)))
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

/** The stored original PDF, opened by the browser's viewer at `page`. */
export function documentFileUrl(id: string, page: number): string {
  return `${API_URL}/documents/${id}/file#page=${page}`
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  listSessions: () => request<Session[]>('/sessions'),
  createSession: () => request<Session>('/sessions', json('POST', {})),
  renameSession: (id: string, title: string) =>
    request<Session>(`/sessions/${id}`, json('PATCH', { title })),
  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  listTurns: (id: string) => request<Turn[]>(`/sessions/${id}/messages`),
  // The first model is the backend's default.
  listModels: () => request<ModelInfo[]>('/models'),
  listDocuments: () => request<LibraryDocument[]>('/documents'),
  // XMLHttpRequest, because fetch reports no upload progress.
  uploadDocument: (file: File, onProgress: (fraction: number) => void) =>
    new Promise<LibraryDocument>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${API_URL}/documents`)
      xhr.responseType = 'json'
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total)
      }
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve(xhr.response as LibraryDocument)
          : reject(new ApiError(errorMessage(xhr.status, xhr.response)))
      xhr.onerror = () => reject(new ApiError('Network error'))
      const form = new FormData()
      form.append('file', file)
      xhr.send(form)
    }),
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: 'DELETE' }),
}

/** POSTs a message and yields the SSE events (EventSource cannot POST). */
export async function* streamMessage(
  sessionId: string,
  text: string,
  modelId: string,
): AsyncGenerator<ChatEvent> {
  const res = await fetch(
    `${API_URL}/sessions/${sessionId}/messages`,
    json('POST', { text, model_id: modelId }),
  )
  if (!res.ok || !res.body)
    throw new ApiError(errorMessage(res.status, await res.json().catch(() => null)))
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += value.replace(/\r\n/g, '\n')
    let end: number
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const lines = buffer.slice(0, end).split('\n')
      buffer = buffer.slice(end + 2)
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim()
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (event && data) yield { type: event, ...(JSON.parse(data) as object) } as ChatEvent
    }
  }
}
