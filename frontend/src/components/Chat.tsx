import { ArrowRight, Check, ChevronDown, LoaderCircle, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
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
import { type ModelInfo, streamMessage } from '@/lib/api'
import { CITATION } from '@/lib/citations'

const MAX_MESSAGE_CHARS = 8000
// Skills reach the agent as read_skill_file calls (pre-reads included) with args.path = '<name>/SKILL.md'.
const READ_SKILL_FILE = 'read_skill_file'
const SKILL_FILE_SUFFIX = /\/SKILL\.md$/
// Link target that marks a rewritten citation; never navigated to.
const CITE_HREF = '#cite'

export interface ToolStep {
  id: string
  name: string
  ok?: boolean
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
  libraryEmpty: boolean
  models: ModelInfo[]
  modelId: string
  onModelChange: (id: string) => void
  onTurnEnded: () => void
}

export function Chat({
  sessionId,
  turns,
  onTurns,
  libraryEmpty,
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
    const answerId = crypto.randomUUID()
    onTurns((t) => [
      ...t,
      { id: crypto.randomUUID(), role: 'user', text, tools: [], skills: [] },
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
            tools: [...x.tools, { id: e.id, name: e.name }],
            skills: e.name === READ_SKILL_FILE ? addSkill(x.skills, e.args.path) : x.skills,
          }))
        else if (e.type === 'tool_end')
          patch((x) => ({ ...x, tools: x.tools.map((s) => (s.id === e.id ? { ...s, ok: e.ok } : s)) }))
        else if (e.type === 'error') patch((x) => ({ ...x, error: e.message }))
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
          {libraryEmpty ? (
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
            t.role === 'user' ? <Question key={t.id} turn={t} /> : <Answer key={t.id} turn={t} />,
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

function CitationChip({ file, pages }: { file: ReactNode; pages: string }) {
  return (
    <span className="mx-0.5 inline-flex items-baseline gap-1 border bg-card px-1.5 text-xs leading-5 whitespace-nowrap text-muted-foreground">
      {file}
      <b className="font-semibold text-primary">
        {/[-–,]/.test(pages) ? 'pp.' : 'p.'} {pages}
      </b>
    </span>
  )
}

function Answer({ turn }: { turn: Turn }) {
  return (
    <div className="flex flex-col gap-2.5">
      {turn.text && (
        <div className="max-w-[66ch] space-y-3 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:bg-muted [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5">
          <Markdown
            skipHtml
            components={{
              a: ({ href, title, children }) =>
                href === CITE_HREF ? (
                  <CitationChip file={children} pages={title ?? ''} />
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
      {tools.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1">
          Tool <code className="font-mono text-[11.5px] text-foreground/75">{s.name}</code>
          <StepState ok={s.ok} />
        </span>
      ))}
    </div>
  )
}
