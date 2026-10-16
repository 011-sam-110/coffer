// The Markdown subset for notes (SPEC 4): headings, lists, bold, italic, code,
// links. It builds React elements from text, never HTML: no raw HTML, no
// dangerouslySetInnerHTML (SPEC 3.7). Links are shown, not opened: the UI
// never opens a URL that is not an item's website.
import type { ReactNode } from "react";

type Inline = ReactNode;

function inline(text: string, key: string): Inline[] {
  const out: Inline[] = [];
  // Order matters: code first (its content is literal), then links, bold, italic.
  const re = /(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*\s][^*]*)\*)|(_([^_\s][^_]*)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k} className="rounded-sm bg-muted px-1 font-mono text-xs">{m[1].slice(1, -1)}</code>);
    else if (m[2])
      out.push(
        <span key={k}>
          <span className="underline decoration-muted-foreground underline-offset-2">{m[3]}</span>{" "}
          <span className="text-xs text-muted-foreground">({m[4]})</span>
        </span>,
      );
    else if (m[5]) out.push(<strong key={k} className="font-semibold">{inline(m[6], k)}</strong>);
    else if (m[7]) out.push(<strong key={k} className="font-semibold">{inline(m[8], k)}</strong>);
    else if (m[9]) out.push(<em key={k}>{inline(m[10], k)}</em>);
    else if (m[11]) out.push(<em key={k}>{inline(m[12], k)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${b++}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key} className="overflow-x-auto rounded-sm bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? "text-md font-semibold" : level === 2 ? "text-base font-semibold" : "text-sm font-semibold";
      const content = inline(h[2], key);
      blocks.push(level === 1 ? <h4 key={key} className={cls}>{content}</h4> : level === 2 ? <h5 key={key} className={cls}>{content}</h5> : <h6 key={key} className={cls}>{content}</h6>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(<li key={i}>{inline(lines[i].replace(/^\s*[-*]\s+/, ""), `${key}-${i}`)}</li>);
        i++;
      }
      blocks.push(<ul key={key} className="list-disc space-y-0.5 pl-5">{items}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(<li key={i}>{inline(lines[i].replace(/^\s*\d+[.)]\s+/, ""), `${key}-${i}`)}</li>);
        i++;
      }
      blocks.push(<ol key={key} className="list-decimal space-y-0.5 pl-5">{items}</ol>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={key} className="whitespace-pre-wrap">
        {inline(para.join("\n"), key)}
      </p>,
    );
  }
  return <div className="flex flex-col gap-2 text-sm leading-relaxed" data-selectable>{blocks}</div>;
}
