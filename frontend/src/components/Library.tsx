import { cn } from 'cn'
import { Trash2, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api, type DocumentStatus, type LibraryDocument } from '@/lib/api'

interface Props {
  documents: LibraryDocument[]
  onChanged: () => void
}

/** A file on its way to the library; `fraction` is null while it waits its turn. */
interface UploadRow {
  key: string
  name: string
  fraction: number | null
  error?: string
}

const STATUS: Record<DocumentStatus, { label: string; text: string; dot: string }> = {
  ready: { label: 'Ready', text: 'text-success', dot: 'bg-success' },
  pending: { label: 'Processing', text: 'text-warning', dot: 'bg-warning motion-safe:animate-pulse' },
  failed: { label: 'Failed', text: 'text-destructive', dot: 'bg-destructive' },
}

const ADDED_FORMAT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'failed')

export function Library({ documents, onChanged }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [uploads, setUploads] = useState<UploadRow[]>([])
  // Files go up one at a time, across drops too: bounded server memory and meaningful progress.
  const queue = useRef<Promise<void>>(Promise.resolve())

  function upload(files: FileList | null) {
    if (!files) return
    const batch = [...files].map((file) => ({ file, key: crypto.randomUUID() }))
    setUploads((u) => [...u, ...batch.map(({ file, key }) => ({ key, name: file.name, fraction: null }))])
    const patch = (key: string, change: Partial<UploadRow>) =>
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...change } : x)))
    queue.current = queue.current.then(async () => {
      for (const { file, key } of batch) {
        try {
          patch(key, { fraction: 0 })
          await api.uploadDocument(file, (fraction) => patch(key, { fraction }))
          setUploads((u) => u.filter((x) => x.key !== key))
          onChanged()
        } catch (e) {
          patch(key, { error: errorText(e) })
        }
      }
    })
  }

  async function remove(d: LibraryDocument) {
    try {
      await api.deleteDocument(d.id)
    } catch (e) {
      toast.error(`${d.filename}: ${errorText(e)}`)
    }
    onChanged()
  }

  const ready = documents.filter((d) => d.status === 'ready').length
  const pending = documents.filter((d) => d.status === 'pending').length

  return (
    <div className="mx-auto flex max-w-[936px] flex-col gap-5 px-4 py-6 md:px-7">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          upload(e.dataTransfer.files)
        }}
        className={cn(
          'flex flex-wrap items-center gap-3.5 border border-dashed border-input bg-muted px-5 py-4.5 text-sm text-muted-foreground',
          over && 'border-primary bg-accent',
        )}
      >
        <Upload className="size-5 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <b className="font-semibold text-foreground">Drop PDFs here</b> to add them to your library.
          Pages are indexed on this machine.
        </span>
        <Button className="font-semibold" onClick={() => input.current?.click()}>
          <Upload /> Choose files
        </Button>
      </div>
      <input
        ref={input}
        type="file"
        accept="application/pdf"
        multiple
        hidden
        onChange={(e) => {
          upload(e.target.files)
          e.target.value = ''
        }}
      />
      {uploads.length > 0 && (
        <ul aria-label="Uploads" className="flex flex-col border bg-card">
          {uploads.map((u) => (
            <li key={u.key} className="flex flex-col gap-2 px-3.5 py-2.5 not-first:border-t">
              <div className="flex items-start gap-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium" title={u.name}>
                    {u.name}
                  </span>
                  {u.error && (
                    <span role="alert" className="text-[12.5px] text-destructive">
                      {u.error}
                    </span>
                  )}
                </span>
                {u.error ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-mt-1 -mr-1.5 text-muted-foreground"
                    aria-label={`Dismiss ${u.name}`}
                    onClick={() => setUploads((all) => all.filter((x) => x.key !== u.key))}
                  >
                    <X />
                  </Button>
                ) : (
                  <span className="text-[12.5px] text-muted-foreground tabular-nums">
                    {u.fraction === null
                      ? 'Queued'
                      : u.fraction < 1
                        ? `${Math.round(u.fraction * 100)}%`
                        : 'Processing…'}
                  </span>
                )}
              </div>
              {!u.error && u.fraction !== null && u.fraction < 1 && (
                <Progress value={u.fraction * 100} aria-label={`Uploading ${u.name}`} />
              )}
            </li>
          ))}
        </ul>
      )}
      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No documents yet. Add a PDF to start asking questions about it.
        </p>
      ) : (
        <>
          <Table className="tabular-nums">
            <TableHeader>
              <TableRow className="border-input hover:bg-transparent">
                <TableHead className="text-xs font-semibold text-muted-foreground">File</TableHead>
                <TableHead className="text-right text-xs font-semibold text-muted-foreground">Pages</TableHead>
                <TableHead className="hidden text-xs font-semibold text-muted-foreground sm:table-cell">Added</TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground">Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((d) => {
                const s = STATUS[d.status]
                return (
                  <TableRow key={d.id} className="hover:bg-transparent">
                    <TableCell className="max-w-80 py-2.5 align-top whitespace-normal">
                      <span className="block truncate font-medium" title={d.filename}>
                        {d.filename}
                      </span>
                      {d.status === 'failed' && d.error && (
                        <span className="mt-0.5 block text-[12.5px] text-destructive">{d.error}</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2.5 text-right align-top">{d.page_count ?? '—'}</TableCell>
                    <TableCell className="hidden py-2.5 align-top text-muted-foreground sm:table-cell">
                      {new Date(d.created_at).toLocaleString(undefined, ADDED_FORMAT)}
                    </TableCell>
                    <TableCell className={cn('py-2.5 align-top', s.text)}>
                      <span className={cn('mr-1.5 inline-block size-1.75 rounded-full align-[1px]', s.dot)} />
                      {s.label}
                    </TableCell>
                    <TableCell className="py-1.5 text-right align-top">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        aria-label={`Delete ${d.filename}`}
                        onClick={() => void remove(d)}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <p className="text-[13px] text-muted-foreground tabular-nums">
            Questions search the {ready} ready {ready === 1 ? 'document' : 'documents'}.
            {pending > 0 && ` ${pending} still processing.`}
          </p>
        </>
      )}
    </div>
  )
}
