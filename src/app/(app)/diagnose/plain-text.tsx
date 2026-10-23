import { textBlocks } from "@/lib/diagnose-rules";

// Claude's text as plain paragraphs and lists. React escapes every string,
// and nothing here is ever HTML, so whatever the model writes shows as text.
export function PlainText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`space-y-2 text-sm leading-6 text-ink ${className}`}>
      {textBlocks(text).map((block, index) =>
        block.kind === "paragraph" ? (
          <p key={index} className="break-words whitespace-pre-line">
            {block.text}
          </p>
        ) : block.ordered ? (
          <ol key={index} className="list-decimal space-y-1 pl-5 break-words">
            {block.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ol>
        ) : (
          <ul key={index} className="list-disc space-y-1 pl-5 break-words">
            {block.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
