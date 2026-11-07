// The agent cites as "(filename, p. N)" (skills/retrieving-from-documents/SKILL.md). Models also
// write the filename in backticks and list pages ("p. 2, 3", "pp. 4-6"); all of those match.
// shortcut: one file per parenthesis; extend if models start citing "(a.pdf, p. 1; b.pdf, p. 2)".
export const CITATION = /\(\s*`?([^()`[\]]+?\.pdf)`?\s*,\s*pp?\.\s*(\d+(?:\s*[-–,]\s*\d+)*)\s*\)/gi

export interface Citation {
  filename: string
  pages: number[]
}

function parsePages(list: string): number[] {
  return list.split(',').flatMap((part) => {
    const [from, to = from] = part.split(/[-–]/).map(Number)
    return Array.from({ length: Math.max(to - from + 1, 1) }, (_, i) => from + i)
  })
}

export function parseCitations(text: string): Citation[] {
  return [...text.matchAll(CITATION)].map((m) => ({
    filename: m[1].trim(),
    pages: parsePages(m[2]),
  }))
}
