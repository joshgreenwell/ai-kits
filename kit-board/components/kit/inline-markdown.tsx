import * as React from "react"

/**
 * One line of producer markdown as React elements: links, bold, emphasis and code.
 * Only https URLs become anchors; any other scheme stays visible as literal text,
 * so a javascript: or http: link can never reach an href.
 */

// base.css resets `a { color: inherit; text-decoration: none }` outside any layer, which outranks every
// utility, so the link's colour and underline are marked important or an inline link reads as plain text.
export const inlineStyles = {
  strong: "text-foreground font-semibold",
  code: "bg-muted text-foreground rounded-[var(--radius-sm)] px-1.5 py-0.5 font-mono text-[0.85em]",
  link: "text-primary! underline! decoration-primary/40! underline-offset-4 hover:decoration-primary!",
} as const

export function httpsHref(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === "https:" ? parsed.href : null
  } catch {
    return null
  }
}

type Token = { index: number; end: number; node: (key: string) => React.ReactNode }
type Rule = (text: string, from: number, inLink: boolean) => Token | null

const exec = (pattern: RegExp, text: string, from: number) => {
  pattern.lastIndex = from
  return pattern.exec(text)
}

const anchor = (href: string, children: React.ReactNode, key: string) => (
  <a key={key} href={href} rel="noreferrer noopener" target="_blank" className={inlineStyles.link}>
    {children}
  </a>
)

const codePattern = /`([^`\n]+)`/g
const slackPattern = /<([a-z][a-z0-9+.-]*:[^|>\s]+)(?:\|([^>]+))?>/gi
const mentionPattern = /<([@#!])([\w.-]+)(?:\|([^>]+))?>/g
const labelPattern = /\[([^\]\n]+)\]\(/g
const boldPattern = /(\*\*|(?<![\w_])__)(?!\s)(.+?)(?<!\s)\1/g
const emPattern = /(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?![\s_])([^_\n]+?)(?<!\s)_(?![\w_])/g
const barePattern = /https:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/g

// Rules in priority order; the earliest match in the text wins and ties go to the first rule.
const rules: Rule[] = [
  (text, from) => {
    const match = exec(codePattern, text, from)
    return match && { index: match.index, end: codePattern.lastIndex, node: key => <code key={key} className={inlineStyles.code}>{match[1]}</code> }
  },
  (text, from, inLink) => {
    const match = exec(slackPattern, text, from)
    if (!match) return null
    const href = inLink ? null : httpsHref(match[1])
    const label = match[2] ?? match[1]
    return { index: match.index, end: slackPattern.lastIndex, node: key => href ? anchor(href, render(label, key, true), key) : match[0] }
  },
  (text, from) => {
    // Slack mentions (<@U123|Name>) read as the name they carry.
    const match = exec(mentionPattern, text, from)
    return match && { index: match.index, end: mentionPattern.lastIndex, node: () => match[3] ?? `${match[1] === "#" ? "#" : "@"}${match[2]}` }
  },
  (text, from, inLink) => {
    // [label](url), where the url may itself contain balanced parentheses.
    for (let match = exec(labelPattern, text, from); match; match = exec(labelPattern, text, match.index + 1)) {
      let depth = 1
      let cursor = labelPattern.lastIndex
      for (; cursor < text.length && depth; cursor++) {
        if (text[cursor] === "(") depth++
        else if (text[cursor] === ")") depth--
      }
      if (depth) continue
      const found = match
      const href = inLink ? null : httpsHref(text.slice(labelPattern.lastIndex, cursor - 1))
      const source = text.slice(found.index, cursor)
      return { index: found.index, end: cursor, node: key => href ? anchor(href, render(found[1], key, true), key) : source }
    }
    return null
  },
  (text, from, inLink) => {
    const match = exec(boldPattern, text, from)
    return match && { index: match.index, end: boldPattern.lastIndex, node: key => <strong key={key} className={inlineStyles.strong}>{render(match[2], key, inLink)}</strong> }
  },
  (text, from, inLink) => {
    const match = exec(emPattern, text, from)
    return match && { index: match.index, end: emPattern.lastIndex, node: key => <em key={key}>{render(match[1] ?? match[2], key, inLink)}</em> }
  },
  (text, from, inLink) => {
    if (inLink) return null
    const match = exec(barePattern, text, from)
    return match && { index: match.index, end: barePattern.lastIndex, node: key => anchor(match[0], match[0], key) }
  },
]

function render(text: string, prefix: string, inLink: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let cursor = 0
  while (cursor < text.length) {
    let best: Token | null = null
    for (const rule of rules) {
      const token = rule(text, cursor, inLink)
      if (token && (!best || token.index < best.index)) best = token
    }
    if (!best) break
    if (best.index > cursor) out.push(text.slice(cursor, best.index))
    out.push(<React.Fragment key={`${prefix}-${out.length}`}>{best.node(`${prefix}-${out.length}`)}</React.Fragment>)
    cursor = best.end
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

/** Inline-only: safe inside a <p>, a heading or a label, because it emits no block elements. */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{render(text, "md", false)}</>
}
