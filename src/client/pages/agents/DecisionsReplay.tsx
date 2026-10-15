import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button } from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

interface ReplayCount {
  conversations: string[];
  ticks: number;
}
interface ReplayReport {
  window: number;
  ticksUsed: number;
  ticksNotComparable: number;
  ticksStoredBlock: number;
  questionsChanged: boolean;
  rules: { rule: number; would: ReplayCount }[];
  stored: { rule: number; acted: ReplayCount }[];
}

// How many conversation links one rule lists before "and N more".
const LINKS_SHOWN = 8;

// The questions and rules on screen, saved or not, replayed over the answers this agent's latest
// decisions recorded (docs/decisions.md, "Trying a block"): per rule, how often it would act beside
// how often it did. Reads only; the result is dropped as soon as the block on screen changes.
export function DecisionsReplay({
  agentId,
  block,
  blocked,
  ruleLabel,
  ruleOrigin,
}: {
  agentId: string;
  // The questions and rules a save would write.
  block: { questions: unknown[]; rules: unknown[] };
  // The block has a problem to fix first: the server would refuse it.
  blocked: boolean;
  ruleLabel: (rule: number) => string;
  // The rule's index in the stored block, or null for a rule added on screen: what a rule did is
  // reported by that index, which a reorder on screen does not change.
  ruleOrigin: (rule: number) => number | null;
}) {
  const { t } = useTranslation();
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sent = JSON.stringify(block);
  const [reportFor, setReportFor] = useState<string | null>(null);

  useEffect(() => {
    if (reportFor !== null && reportFor !== sent) {
      setReport(null);
      setReportFor(null);
    }
  }, [sent, reportFor]);

  async function run() {
    setRunning(true);
    setFailure(null);
    const asked = sent;
    try {
      const { data, error } = await api.api.v1
        .agents({ id: agentId })
        .decisions.replay.post(block);
      if (error || !data) {
        setFailure(
          apiErrorMessage(error) ||
            t("editor.decisionsReplayFailed", "Could not replay the rules."),
        );
        return;
      }
      setReport(data.replay);
      setReportFor(asked);
    } catch (e) {
      setFailure(
        apiErrorMessage(e) ||
          t("editor.decisionsReplayFailed", "Could not replay the rules."),
      );
    } finally {
      setRunning(false);
    }
  }

  const actedText = (rule: number): string => {
    const origin = ruleOrigin(rule);
    const acted =
      origin === null
        ? undefined
        : report?.stored.find((s) => s.rule === origin)?.acted;
    if (!acted) {
      return t(
        "editor.decisionsReplayNew",
        "It is not saved yet, so it has not acted.",
      );
    }
    return t(
      "editor.decisionsReplayActed",
      "As saved, it acted on {{conversations}} conversations, {{ticks}} times.",
      { conversations: acted.conversations.length, ticks: acted.ticks },
    );
  };

  const links = (ids: string[]) => (
    <span className="inline-flex flex-wrap gap-x-2">
      {ids.slice(0, LINKS_SHOWN).map((id) => (
        <Link
          key={id}
          to={`/conversations/${id}`}
          className="text-accent hover:underline"
        >
          {`#${id}`}
        </Link>
      ))}
      {ids.length > LINKS_SHOWN && (
        <span className="text-text-muted">
          {t("editor.decisionsReplayMore", "and {{n}} more", {
            n: ids.length - LINKS_SHOWN,
          })}
        </span>
      )}
    </span>
  );

  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      aria-labelledby="decisions-replay-title"
      data-testid="decisions-replay"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4
            id="decisions-replay-title"
            className="font-medium text-sm text-text-primary"
          >
            {t("editor.decisionsReplayTitle", "Try on recent conversations")}
          </h4>
          <p className="text-text-muted text-xs">
            {t(
              "editor.decisionsReplayHint",
              "Runs the rules on screen, saved or not, over the answers this agent's latest decisions recorded. No API call, and nothing is changed in the conversations.",
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={run}
          loading={running}
          disabled={blocked || running}
        >
          {t("editor.decisionsReplayRun", "Try")}
        </Button>
      </div>
      {blocked && (
        <p className="text-text-muted text-xs">
          {t(
            "editor.decisionsReplayBlocked",
            "Fix the problems marked below to try these rules.",
          )}
        </p>
      )}
      {failure && (
        <p className="text-error text-xs" role="alert">
          {failure}
        </p>
      )}
      {report && (
        <div
          className="flex flex-col gap-2"
          data-testid="decisions-replay-result"
        >
          <p className="text-text-secondary text-xs">
            {t(
              "editor.decisionsReplayUsed",
              "{{used}} of the latest {{window}} decisions answered these questions and were replayed.",
              { used: report.ticksUsed, window: report.window },
            )}{" "}
            {report.ticksNotComparable > 0 &&
              t(
                "editor.decisionsReplayNotComparable",
                "Left out, answered with other questions: {{n}}.",
                { n: report.ticksNotComparable },
              )}
          </p>
          {report.questionsChanged && (
            <p className="text-warning text-xs" role="status">
              {t(
                "editor.decisionsReplayQuestionsChanged",
                "A question is new or worded differently from the saved one, so no decision has an answer to it yet. Only asking the classifier again shows what it would answer.",
              )}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {report.rules.map((r) => (
              <li
                key={r.rule}
                className="flex flex-col gap-0.5 text-xs"
                data-testid="decisions-replay-rule"
              >
                <span className="font-medium text-text-primary">
                  {ruleLabel(r.rule)}
                </span>
                <span className="text-text-secondary">
                  {t(
                    "editor.decisionsReplayWould",
                    "Would act on {{conversations}} conversations, {{ticks}} times.",
                    {
                      conversations: r.would.conversations.length,
                      ticks: r.would.ticks,
                    },
                  )}{" "}
                  {actedText(r.rule)}
                </span>
                {r.would.conversations.length > 0 &&
                  links(r.would.conversations)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
