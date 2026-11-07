import { cn } from 'cn'
import { ArrowRight, Check, ChevronDown, ExternalLink, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { documentFileUrl, type LibraryDocument, type ModelInfo, streamMessage } from '@/lib/api'
import { CITATION } from '@/lib/citations'

const MAX_MESSAGE_CHARS = 8000
// Skills reach the agent as read_skill_file calls (pre-reads included) with args.path = '<name>/SKILL.md'.
const READ_SKILL_FILE = 'read_skill_file'
const SKILL_FILE_SUFFIX = /\/SKILL\.md$/
// Link target that marks a rewritten citation; never navigated to.
const CITE_HREF = '#cite'
// Backend services/chat.py: SESSION_BUSY_CODE, another tab is answering this session.
const SESSION_BUSY_CODE = 'session_busy'
const CHIP =
  'mx-0.5 inline-flex items-baseline gap-1 border bg-card px-1.5 text-xs leading-5 whitespace-nowrap'
const NOT_STORED_TITLE = 'Original not stored. Delete and upload again to open it.'
const NOT_IN_LIBRARY_TITLE = 'This document is no longer in the library.'

export interface ToolStep {
  id: string
  name: string
  ok?: boolean
  args?: Record<string, unknown>
}

export interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: ToolStep[]
  skills: string[]
  error?: string
}

interface Props {
  sessionId: string
  turns: Turn[]
  onTurns: (update: (turns: Turn[]) => Turn[]) => void
  documents: LibraryDocument[]
  models: ModelInfo[]
  modelId: string
  onModelChange: (id: string) => void
  onTurnEnded: () => void
}

export function Chat({
  sessionId,
  turns,
  onTurns,
  documents,
  models,
  modelId,
  onModelChange,
  onTurnEnded,
}: Props) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  async function send() {
    const text = input.trim()
    if (!text || busy || !modelId) return
    setInput('')
    setBusy(true)
    const questionId = crypto.randomUUID()
    const answerId = crypto.randomUUID()
    onTurns((t) => [
      ...t,
      { id: questionId, role: 'user', text, tools: [], skills: [] },
      { id: answerId, role: 'assistant', text: '', tools: [], skills: [] },
    ])
    const patch = (fn: (turn: Turn) => Turn) =>
      onTurns((t) => t.map((x) => (x.id === answerId ? fn(x) : x)))
    try {
      for await (const e of streamMessage(sessionId, text, modelId)) {
        if (e.type === 'token') patch((x) => ({ ...x, text: x.text + e.text }))
        else if (e.type === 'tool_start')
          patch((x) => ({
            ...x,
            tools: [...x.tools, { id: e.id, name: e.name, args: e.args }],
            skills: e.name === READ_SKILL_FILE ? addSkill(x.skills, e.args.path) : x.skills,
          }))
        else if (e.type === 'tool_end')
          patch((x) => ({ ...x, tools: x.tools.map((s) => (s.id === e.id ? { ...s, ok: e.ok } : s)) }))
        else if (e.type === 'error' && e.code === SESSION_BUSY_CODE) {
          // The backend saved nothing for this turn, so the view drops it too and the text returns.
          onTurns((t) => t.filter((x) => x.id !== questionId && x.id !== answerId))
          setInput(text)
          toast.error(e.message)
        } else if (e.type === 'error') patch((x) => ({ ...x, error: e.message }))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection lost'
      patch((x) => ({ ...x, error: message }))
      toast.error(message)
    } finally {
      setBusy(false)
      onTurnEnded()
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[736px] flex-col gap-2.5 px-4 py-7 md:px-7" aria-live="polite">
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Your library is empty. Upload PDFs in Library to ask questions about them.
            </p>
          ) : (
            turns.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Ask a question about your documents. Answers cite the pages they come from.
              </p>
            )
          )}
          {turns.map((t) =>
            t.role === 'user' ? (
              <Question key={t.id} turn={t} />
            ) : (
              <Answer key={t.id} turn={t} documents={documents} />
            ),
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="px-4 pt-3 pb-5 md:px-7">
        <form
          className="mx-auto max-w-[680px] border border-input bg-card transition-shadow focus-within:border-primary focus-within:ring-3 focus-within:ring-accent"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Ask about your documents"
            aria-label="Question"
            maxLength={MAX_MESSAGE_CHARS}
            className="max-h-48 min-h-12 resize-none border-0 bg-transparent px-3.5 pt-3 focus-visible:ring-0 dark:bg-transparent"
            rows={1}
          />
          <div className="flex items-center gap-2.5 px-2 pt-1 pb-2">
            <ModelPicker models={models} modelId={modelId} onChange={onModelChange} disabled={busy} />
            <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
              Enter to send · Shift+Enter for a new line
            </span>
            <Button
              type="submit"
              className="ml-auto font-semibold sm:ml-0"
              disabled={busy || !modelId || !input.trim()}
            >
              Send <ArrowRight />
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

function providerLabel(provider: string): string {
  return provider === 'groq' ? 'Groq' : 'Google'
}

function ModelPicker({
  models,
  modelId,
  onChange,
  disabled,
}: {
  models: ModelInfo[]
  modelId: string
  onChange: (id: string) => void
  disabled: boolean
}) {
  const current = models.find((m) => m.id === modelId)
  if (!current) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="xs" disabled={disabled} aria-label="Choose model">
          {current.id}
          <span className="text-muted-foreground">{providerLabel(current.provider)}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={modelId} onValueChange={onChange}>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id}>
              {m.id}
              <span className="ml-auto pl-4 text-xs text-muted-foreground">
                {providerLabel(m.provider)}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function addSkill(skills: string[], path: unknown): string[] {
  const name = String(path ?? '').trim().replace(SKILL_FILE_SUFFIX, '')
  return !name || skills.includes(name) ? skills : [...skills, name]
}

function Question({ turn }: { turn: Turn }) {
  return (
    <h2 className="mt-4 border-t pt-6 text-[15.5px] leading-snug font-semibold tracking-[-0.005em] whitespace-pre-wrap first:mt-0 first:border-t-0 first:pt-0">
      {turn.text}
    </h2>
  )
}

/** Rewrites "(file.pdf, p. N)" as a markdown link the renderer turns into a page chip; this also
 * catches citations whose filename the model wrapped in backticks. */
function markCitations(text: string): string {
  return text.replace(CITATION, (_, file: string, pages: string) => {
    const list = pages.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ')
    return `[${file.trim()}](${CITE_HREF} "${list}")`
  })
}

function CitationChip({
  file,
  pages,
  documents,
}: {
  file: string
  pages: string
  documents: LibraryDocument[]
}) {
  // shortcut: matches by filename, first match; two library PDFs with the same name → cite by document id
  const doc = documents.find((d) => d.status === 'ready' && d.filename === file)
  // The chip shows only the file name; the cited pages are in its title and the Sources panel.
  const cited = `${/[-–,]/.test(pages) ? 'pp.' : 'p.'} ${pages}`
  if (!doc?.has_file)
    return (
      <span
        className={cn(CHIP, 'text-muted-foreground')}
        title={`${cited} · ${doc ? NOT_STORED_TITLE : NOT_IN_LIBRARY_TITLE}`}
      >
        {file}
      </span>
    )
  const page = Number.parseInt(pages, 10)
  return (
    <a
      href={documentFileUrl(doc.id, page)}
      target="_blank"
      rel="noreferrer"
      title={`Open ${file} at page ${page}`}
      aria-label={`Open ${file} at page ${page} (new tab)`}
      className={cn(CHIP, 'border-input text-foreground! no-underline! hover:border-primary')}
    >
      {file}
      <ExternalLink className="size-2.75 self-center text-primary" aria-hidden="true" />
    </a>
  )
}

function Answer({ turn, documents }: { turn: Turn; documents: LibraryDocument[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {turn.text && (
        <div className="max-w-[66ch] space-y-3 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:bg-muted [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5">
          <Markdown
            skipHtml
            components={{
              a: ({ href, title, children }) =>
                href === CITE_HREF ? (
                  <CitationChip file={[children].flat().join('')} pages={title ?? ''} documents={documents} />
                ) : (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
            }}
          >
            {markCitations(turn.text)}
          </Markdown>
        </div>
      )}
      {turn.error && <p className="text-sm text-destructive">{turn.error}</p>}
      {!turn.text && !turn.error && (
        <p className="text-sm text-muted-foreground motion-safe:animate-pulse">Thinking…</p>
      )}
      <Trace skills={turn.skills} tools={turn.tools.filter((s) => s.name !== READ_SKILL_FILE)} />
    </div>
  )
}

function StepState({ ok }: { ok?: boolean }) {
  if (ok === undefined)
    return <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-label="running" />
  return ok ? (
    <Check className="size-3.5 text-success" aria-label="succeeded" />
  ) : (
    <X className="size-3.5 text-destructive" aria-label="failed" />
  )
}

function Trace({ skills, tools }: { skills: string[]; tools: ToolStep[] }) {
  if (skills.length === 0 && tools.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {skills.map((name) => (
        <span key={name}>
          Skill <code className="font-mono text-[11.5px] text-foreground/75">{name}</code>
        </span>
      ))}
      {tools.map((s) => {
        // The query or city, so repeated calls of one tool read as different searches.
        const input = Object.values(s.args ?? {})
          .filter((v) => typeof v === 'string')
          .join(', ')
        return (
          <span key={s.id} className="inline-flex min-w-0 items-center gap-1">
            Tool <code className="font-mono text-[11.5px] text-foreground/75">{s.name}</code>
            {input && (
              <span className="max-w-[40ch] truncate" title={input}>
                “{input}”
              </span>
            )}
            <StepState ok={s.ok} />
          </span>
        )
      })}
    </div>
  )
}
