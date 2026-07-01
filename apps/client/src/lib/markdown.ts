import DOMPurify from "dompurify";
import { marked } from "marked";

export function renderMarkdown(markdown: string): string {
  const rendered = marked.parse(escapeRawHtml(markdown), {
    async: false,
    breaks: true,
    gfm: true
  });

  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "style"]
  });
}

function escapeRawHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
