import { cn } from 'cn'
import { PanelLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Chat, type Turn } from '@/components/Chat'
import { Library } from '@/components/Library'
import { Sources } from '@/components/Sources'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Toaster } from '@/components/ui/sonner'
import { api, type LibraryDocument, type ModelInfo, type Session } from '@/lib/api'

const POLL_MS = 2000
// Backend domain/models.py: MAX_TITLE_CHARS.
const MAX_TITLE_CHARS = 200
const MS_PER_DAY = 86_400_000
const DAY_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }

type View = 'chat' | 'library'

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Request failed')

function dayLabel(iso: string): string {
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / MS_PER_DAY,
  )
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return new Date(iso).toLocaleDateString(undefined, DAY_FORMAT)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [documents, setDocuments] = useState<LibraryDocument[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [view, setView] = useState<View>('chat')
  const [turns, setTurns] = useState<Record<string, Turn[]>>({})
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelId, setModelId] = useState('')
  const [railOpen, setRailOpen] = useState(false)
  // The session whose title is being edited, and where: its rail row or the header.
  const [renaming, setRenaming] = useState<{ id: string; place: 'rail' | 'header' } | null>(null)

  const refreshSessions = useCallback(
    () => api.listSessions().then(setSessions).catch((e: unknown) => toast.error(errorText(e))),
    [],
  )
  const refreshDocuments = useCallback(
    () => api.listDocuments().then(setDocuments).catch((e: unknown) => toast.error(errorText(e))),
    [],
  )

  useEffect(() => {
    void refreshSessions()
    void refreshDocuments()
    api
      .listModels()
      .then((list) => {
        setModels(list)
        setModelId(list[0]?.id ?? '')
      })
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [refreshSessions, refreshDocuments])

  const anyPending = documents.some((d) => d.status === 'pending')
  useEffect(() => {
    if (!anyPending) return
    const timer = setInterval(() => void refreshDocuments(), POLL_MS)
    return () => clearInterval(timer)
  }, [anyPending, refreshDocuments])

  // Turns are loaded from the backend once per page load; after that this tab's state is current.
  useEffect(() => {
    if (!active || turns[active]) return
    api
      .listTurns(active)
      .then((loaded) => setTurns((all) => ({ ...all, [active]: all[active] ?? loaded })))
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [active, turns])

  async function newSession() {
    try {
      const s = await api.createSession()
      setSessions((list) => [s, ...list])
      setTurns((all) => ({ ...all, [s.id]: [] }))
      setActive(s.id)
      setView('chat')
      setRailOpen(false)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  async function rename(s: Session, title: string | null) {
    setRenaming(null)
    if (title === null) return
    try {
      await api.renameSession(s.id, title)
      await refreshSessions()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  async function remove(s: Session) {
    if (!window.confirm(`Delete "${s.title}"?`)) return
    try {
      await api.deleteSession(s.id)
      if (active === s.id) setActive(null)
      await refreshSessions()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const session = sessions.find((s) => s.id === active)
  const activeTurns = active ? (turns[active] ?? []) : []
  const questions = activeTurns.filter((t) => t.role === 'user').length
  const pages = documents.reduce((n, d) => n + (d.page_count ?? 0), 0)
  const showChat = view === 'chat' && active !== null

  const rail = (
    <Rail
      view={view}
      sessions={sessions}
      active={active}
      documents={documents}
      onView={(v) => {
        setView(v)
        setRailOpen(false)
      }}
      onOpen={(id) => {
        setActive(id)
        setView('chat')
        setRailOpen(false)
      }}
      onNew={() => void newSession()}
      renamingId={renaming?.place === 'rail' ? renaming.id : null}
      onStartRename={(id) => setRenaming({ id, place: 'rail' })}
      onRename={(s, title) => void rename(s, title)}
      onDelete={(s) => void remove(s)}
    />
  )

  return (
    <div className="flex h-svh">
      <div className="hidden w-60 shrink-0 md:flex">{rail}</div>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-3 border-b px-4 md:px-7">
          <Sheet open={railOpen} onOpenChange={setRailOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="-ml-1.5 md:hidden" aria-label="Open sessions">
                <PanelLeft />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 gap-0 p-0">
              <SheetTitle className="sr-only">Sessions and library</SheetTitle>
              {rail}
            </SheetContent>
          </Sheet>
          {view === 'chat' && session && renaming?.id === session.id && renaming.place === 'header' ? (
            <TitleEditor
              title={session.title}
              onDone={(title) => void rename(session, title)}
              className="-ml-2.25 w-75 px-2 py-1 text-[15px] font-semibold"
            />
          ) : (
            <h1 className="min-w-0 truncate text-[15px] font-semibold">
              {view === 'library' ? (
                'Library'
              ) : session ? (
                <button
                  type="button"
                  title="Rename session"
                  onClick={() => setRenaming({ id: session.id, place: 'header' })}
                  className="-mx-1.5 max-w-full truncate px-1.5 py-0.5 outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {session.title}
                </button>
              ) : (
                'Agentic RAG'
              )}
            </h1>
          )}
          <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
            {view === 'library'
              ? `${plural(documents.length, 'document')} · ${plural(pages, 'page')}`
              : session && plural(questions, 'question')}
          </span>
          {view === 'chat' && session && (
            <span className="ml-auto flex shrink-0 gap-1 text-muted-foreground">
              <Button variant="ghost" size="icon-sm" aria-label="Delete session" onClick={() => void remove(session)}>
                <Trash2 />
              </Button>
            </span>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {view === 'library' ? (
            <Library documents={documents} onChanged={() => void refreshDocuments()} />
          ) : showChat ? (
            <Chat
              key={active}
              sessionId={active}
              turns={activeTurns}
              onTurns={(fn) => setTurns((all) => ({ ...all, [active]: fn(all[active] ?? []) }))}
              documents={documents}
              models={models}
              modelId={modelId}
              onModelChange={setModelId}
              onTurnEnded={() => void refreshSessions()}
            />
          ) : (
            <div className="mx-auto flex max-w-[736px] flex-col items-start gap-3 px-4 py-7 md:px-7">
              <p className="text-sm text-muted-foreground">
                Start a session to ask questions about your documents. Answers cite the pages they come from.
              </p>
              <Button className="font-semibold" onClick={() => void newSession()}>
                <Plus /> New session
              </Button>
            </div>
          )}
        </div>
      </main>
      {showChat && (
        <div className="hidden w-70 shrink-0 xl:flex">
          <Sources turns={activeTurns} documents={documents} />
        </div>
      )}
      <Toaster />
    </div>
  )
}

const DOC_STATES = [
  { status: 'ready', label: 'ready', dot: 'bg-success' },
  { status: 'pending', label: 'processing', dot: 'bg-warning' },
  { status: 'failed', label: 'failed', dot: 'bg-destructive' },
] as const

function Rail({
  view,
  sessions,
  active,
  documents,
  onView,
  onOpen,
  onNew,
  renamingId,
  onStartRename,
  onRename,
  onDelete,
}: {
  view: View
  sessions: Session[]
  active: string | null
  documents: LibraryDocument[]
  onView: (view: View) => void
  onOpen: (id: string) => void
  onNew: () => void
  renamingId: string | null
  onStartRename: (id: string) => void
  onRename: (session: Session, title: string | null) => void
  onDelete: (session: Session) => void
}) {
  const tabs: { id: View; label: string; count?: number }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'library', label: 'Library', count: documents.length },
  ]
  return (
    <nav className="flex w-full min-w-0 flex-col border-r bg-sidebar text-sidebar-foreground" aria-label="Main">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3.5 text-[15px] font-bold tracking-[-0.01em]">
        <span className="size-2.5 bg-primary" aria-hidden="true" />
        Agentic RAG
      </div>
      <div className="mx-3 grid grid-cols-2 border bg-background">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={view === t.id ? 'page' : undefined}
            onClick={() => onView(t.id)}
            className={cn(
              'py-1.5 text-[13px] font-medium text-muted-foreground outline-none not-first:border-l hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
              view === t.id && 'bg-card text-foreground shadow-[inset_0_-2px_0_var(--primary)]',
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="ml-1 text-xs text-muted-foreground tabular-nums">{t.count}</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between px-4 pt-4.5 pb-1.5">
        <span className="text-xs font-semibold text-muted-foreground">Sessions</span>
        <Button variant="ghost" size="xs" className="-mr-2 text-primary hover:text-primary" onClick={onNew}>
          <Plus /> New
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2">
        {sessions.length === 0 && (
          <p className="px-2 py-1.5 text-[13px] text-muted-foreground">No sessions yet.</p>
        )}
        {sessions.map((s) => {
          const on = view === 'chat' && active === s.id
          if (renamingId === s.id)
            return (
              <div key={s.id} className="px-1 py-0.75">
                <TitleEditor
                  title={s.title}
                  onDone={(title) => onRename(s, title)}
                  className="w-full px-1.5 py-1 text-sm"
                />
              </div>
            )
          // Rename and delete show on the active row, and on others while hovered or focused.
          return (
            <div
              key={s.id}
              className={cn('group flex items-center', on ? 'bg-accent font-semibold' : 'hover:bg-accent/60')}
            >
              <button
                type="button"
                aria-current={on ? 'page' : undefined}
                onClick={() => onOpen(s.id)}
                className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 px-2 py-1.75 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="truncate">{s.title}</span>
                <span
                  className={cn(
                    'text-xs font-normal text-muted-foreground tabular-nums',
                    on ? 'hidden' : 'group-focus-within:hidden group-hover:hidden',
                  )}
                >
                  {dayLabel(s.updated_at)}
                </span>
              </button>
              <span
                className={cn(
                  'shrink-0 pr-1 text-muted-foreground',
                  on ? 'flex' : 'hidden group-focus-within:flex group-hover:flex',
                )}
              >
                <Button variant="ghost" size="icon-xs" aria-label={`Rename ${s.title}`} onClick={() => onStartRename(s.id)}>
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon-xs" aria-label={`Delete ${s.title}`} onClick={() => onDelete(s)}>
                  <Trash2 />
                </Button>
              </span>
            </div>
          )
        })}
      </div>
      <div className="flex flex-col gap-1.5 border-t px-4 py-3 text-xs text-muted-foreground">
        <span>Library</span>
        {documents.length === 0 ? (
          <span>No documents yet</span>
        ) : (
          <span className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
            {DOC_STATES.map(({ status, label, dot }) => {
              const n = documents.filter((d) => d.status === status).length
              return (
                n > 0 && (
                  <span key={status}>
                    <span className={cn('mr-1.5 inline-block size-1.75 rounded-full align-[1px]', dot)} />
                    {n} {label}
                  </span>
                )
              )
            })}
          </span>
        )}
      </div>
    </nav>
  )
}

/** An inline session title box: Enter saves a changed, non-empty title; Esc or leaving it cancels. */
function TitleEditor({
  title,
  onDone,
  className,
}: {
  title: string
  onDone: (title: string | null) => void
  className: string
}) {
  const [value, setValue] = useState(title)
  // Enter then blur would otherwise report twice.
  const finished = useRef(false)

  function finish(save: boolean) {
    if (finished.current) return
    finished.current = true
    const next = value.trim()
    onDone(save && next && next !== title ? next : null)
  }

  return (
    <input
      autoFocus
      aria-label="Session title"
      value={value}
      maxLength={MAX_TITLE_CHARS}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          // Keeps the mobile rail sheet open.
          e.stopPropagation()
          finish(false)
        }
      }}
      onBlur={() => finish(false)}
      className={cn('min-w-0 border border-primary bg-card text-foreground ring-3 ring-accent outline-none', className)}
    />
  )
}
