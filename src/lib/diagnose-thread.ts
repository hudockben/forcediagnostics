import { openingRows, type TurnView } from "@/lib/diagnose-rules";

// How the conversation folds, so a tech never scrolls past the symptoms to
// reach Claude's current answer: the latest exchange open, each earlier one
// one line ("Mike: Misfires under load" · "Claude: 4 causes, top: Ignition
// coil breakdown") that opens on a tap. Pure, for the chat and the tests.

type TurnLike = Pick<TurnView, "id" | "seq" | "status" | "techText" | "reply" | "error">;

// Summaries are cut to this many characters (the screen cuts them shorter
// still, to one line).
export const SUMMARY_LENGTH = 120;

function cut(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…` : line;
}

// The tech's message in one line: the complaint of the opening form, else
// the first line that isn't a quote of one of Claude's questions (the
// answer), else the first quote.
export function techSummary(turn: Pick<TurnView, "seq" | "techText">): string {
  const text = String(turn.techText ?? "");
  const opening = turn.seq === 1 ? openingRows(text) : null;
  if (opening) {
    const complaint = opening.rows.find((row) => row.label === "Complaint")?.value;
    const codes = opening.rows.find((row) => row.label === "Fault codes")?.value;
    const first = complaint ?? opening.more.split("\n").find((line) => line.trim()) ?? codes ?? opening.rows[0].value;
    return cut(complaint && codes ? `${complaint} (${codes})` : first);
  }
  const lines = text.split("\n").filter((line) => line.trim());
  const answer = lines.find((line) => !line.startsWith("> "));
  return cut(answer ?? lines[0]?.replace(/^> /, "") ?? "");
}

// Claude's reply in one line: how many causes and the likeliest, or what
// happened to the message.
export function claudeSummary(turn: Pick<TurnView, "status" | "reply">): string {
  if (turn.status === "running") return "working on it…";
  if (turn.status === "stopped") return "stopped";
  if (turn.status !== "done" || !turn.reply) return "didn't go through";
  const causes = turn.reply.likelyCauses;
  const asks = turn.reply.questions.length;
  const questions = asks > 0 ? `, asks ${asks === 1 ? "a question" : `${asks} questions`}` : "";
  if (causes.length === 0) return cut(`no causes yet${questions}`);
  return cut(`${causes.length} ${causes.length === 1 ? "cause" : "causes"}, top: ${causes[0].title}${questions}`);
}

// The turns shown open to begin with: the latest, and when it has no
// answer yet (it's running, failed or was stopped), the latest that has
// one, so the current answer is always in sight.
export function openTurnIds(turns: TurnLike[]): Set<string> {
  const open = new Set<string>();
  const last = turns.at(-1);
  if (!last) return open;
  open.add(last.id);
  if (!(last.status === "done" && last.reply)) {
    const answered = turns.findLast((turn) => turn.status === "done" && turn.reply);
    if (answered) open.add(answered.id);
  }
  return open;
}
