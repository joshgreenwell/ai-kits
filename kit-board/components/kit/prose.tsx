import * as React from "react";
import { cn } from "cn";

/**
 * Report bodies arrive as markdown when a producer publishes no rendered HTML.
 * Parsing to elements rather than a string keeps producer text out of innerHTML.
 */

type Block =
  | { kind: "heading"; level: 2 | 3 | 4; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "rule" }
  | { kind: "paragraph"; lines: string[] };

const inlinePattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(inlinePattern).filter(Boolean).map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (/^(\*\*|__).+(\*\*|__)$/.test(token))
      return <strong key={key} className="text-foreground font-semibold">{token.slice(2, -2)}</strong>;
    if (/^\*[^*]+\*$/.test(token)) return <em key={key}>{token.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(token))
      return <code key={key} className="bg-muted text-foreground rounded-[var(--radius-sm)] px-1.5 py-0.5 font-mono text-[0.85em]">{token.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
    if (link)
      return (
        <a key={key} href={link[2]} rel="noreferrer noopener" target="_blank"
          className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary">
          {link[1]}
        </a>
      );
    return <React.Fragment key={key}>{token}</React.Fragment>;
  });
}

function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let fence: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      if (fence) { out.push({ kind: "code", lines: fence }); fence = null; }
      else fence = [];
      continue;
    }
    if (fence) { fence.push(line); continue; }

    if (!line.trim()) continue;
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push({ kind: "rule" }); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // A report's own H1 is its title; the page already shows it above the body.
      const level = Math.min(4, Math.max(2, heading[1].length + 1)) as 2 | 3 | 4;
      out.push({ kind: "heading", level, text: heading[2].trim() });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const last = out.at(-1);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push((bullet ?? numbered)![1]);
      else out.push({ kind: "list", ordered, items: [(bullet ?? numbered)![1]] });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const last = out.at(-1);
      if (last?.kind === "quote") last.lines.push(quote[1]);
      else out.push({ kind: "quote", lines: [quote[1]] });
      continue;
    }

    // A bare line directly under a heading starts its own paragraph; otherwise it
    // continues the previous one, so wrapped source lines do not become stray rows.
    const last = out.at(-1);
    if (last?.kind === "paragraph" && lines[i - 1]?.trim()) last.lines.push(line.trim());
    else out.push({ kind: "paragraph", lines: [line.trim()] });
  }
  if (fence) out.push({ kind: "code", lines: fence });
  return out;
}

const headingClass = {
  2: "text-foreground mt-2 text-lg font-semibold tracking-tight first:mt-0",
  3: "text-foreground mt-1 text-base font-semibold tracking-tight first:mt-0",
  4: "text-muted-foreground mt-1 font-mono text-xs font-medium tracking-wide uppercase first:mt-0",
} as const;

export function Prose({ markdown, className, ...props }: React.ComponentProps<"div"> & { markdown: string }) {
  const parsed = blocks(markdown);
  if (!parsed.length) return null;

  return (
    <div className={cn("grid max-w-[70ch] gap-4 text-sm leading-relaxed", className)} {...props}>
      {parsed.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case "heading": {
            const Tag = `h${block.level}` as "h2" | "h3" | "h4";
            return <Tag key={key} className={headingClass[block.level]}>{inline(block.text, key)}</Tag>;
          }
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={key} className="grid gap-2 ps-1">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} className="text-muted-foreground grid grid-cols-[1.25rem_1fr] items-baseline">
                    <span aria-hidden="true" className={cn("text-primary font-mono text-xs", block.ordered && "tabular-nums")}>
                      {block.ordered ? `${itemIndex + 1}.` : "—"}
                    </span>
                    <span>{inline(item, `${key}-${itemIndex}`)}</span>
                  </li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={key} className="border-primary/40 text-muted-foreground border-l-2 ps-4 italic">
                {inline(block.lines.join(" "), key)}
              </blockquote>
            );
          case "code":
            return (
              <pre key={key} className="bg-muted text-foreground overflow-x-auto rounded-[var(--radius-control)] p-3 font-mono text-xs leading-relaxed">
                <code>{block.lines.join("\n")}</code>
              </pre>
            );
          case "rule":
            return <hr key={key} className="border-border my-1" />;
          default:
            return <p key={key} className="text-muted-foreground">{inline(block.lines.join(" "), key)}</p>;
        }
      })}
    </div>
  );
}
