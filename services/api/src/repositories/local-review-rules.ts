import { z } from "zod";

/**
 * Rules over persisted local review evidence, shared by the review surface and
 * the backlog phase. Both read the same events and must agree on which review
 * and which check results apply to a commit.
 */

export const LOCAL_REVIEW_APPROVED = "local_review.approved";
export const LOCAL_REVIEW_CHANGES_REQUESTED = "local_review.changes_requested";
export const LOCAL_CHECK_COMPLETED = "local_check.completed";
export const LOCAL_REVIEW_TYPES = [LOCAL_REVIEW_APPROVED, LOCAL_REVIEW_CHANGES_REQUESTED];

const ReviewData = z
  .object({
    commitSha: z.string().optional(),
    note: z.string().nullish(),
    reviewer: z.unknown().optional(),
  })
  .passthrough();

const CheckData = z
  .object({
    name: z.string().min(1),
    commitSha: z.string(),
    exitCode: z.number().optional(),
    dirty: z.boolean().optional(),
    commitChanged: z.boolean().optional(),
  })
  .passthrough();

export type LocalCheckData = z.infer<typeof CheckData>;

/** One evidence row; `events` arguments are always newest first. */
export type LocalEvidence<Row = object> = Row & { type: string; data: unknown };

/** The newest review decision, whichever commit it was made on. */
export function latestReview<Row>(events: Array<LocalEvidence<Row>>) {
  const event = events.find((candidate) => LOCAL_REVIEW_TYPES.includes(candidate.type));
  if (!event) return undefined;
  const data: z.infer<typeof ReviewData> = ReviewData.safeParse(event.data).data ?? {};
  return { event, approved: event.type === LOCAL_REVIEW_APPROVED, data };
}

/**
 * The newest result of each named check that ran against exactly `commitSha`
 * with a clean tree that the check itself did not move.
 */
export function currentChecks<Row>(events: Array<LocalEvidence<Row>>, commitSha: string) {
  const checks = new Map<string, { event: LocalEvidence<Row>; data: LocalCheckData }>();
  for (const event of events) {
    if (event.type !== LOCAL_CHECK_COMPLETED) continue;
    const parsed = CheckData.safeParse(event.data);
    if (!parsed.success) continue;
    const data = parsed.data;
    if (data.dirty || data.commitChanged || data.commitSha !== commitSha) continue;
    if (!checks.has(data.name)) checks.set(data.name, { event, data });
  }
  return checks;
}

/** Review of a local-repository story: the counterpart of an open pull request. */
export type LocalReviewSummary = {
  status: "awaiting_review" | "approved" | "changes_requested";
  checksFailing: boolean;
};

/**
 * Summarizes local review from persisted evidence only. `head` is the story
 * branch after its latest turn; `imported` are the source commits the workspace
 * imported. A story whose head is still an imported commit, or that has
 * uncommitted work, has nothing to review yet.
 */
export function localReviewSummary(input: {
  head: { sha: string; dirty: boolean } | null;
  imported: string[];
  events: LocalEvidence[];
}): LocalReviewSummary | null {
  const head = input.head;
  if (!head || head.dirty || input.imported.includes(head.sha)) return null;
  const review = latestReview(input.events);
  const status =
    review?.data.commitSha !== head.sha
      ? "awaiting_review"
      : review.approved
        ? "approved"
        : "changes_requested";
  const checks = [...currentChecks(input.events, head.sha).values()];
  return { status, checksFailing: checks.some(({ data }) => data.exitCode !== 0) };
}
