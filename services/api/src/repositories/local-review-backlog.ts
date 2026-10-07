import { type FacilityDb, storyEvidenceEvents, turnGitEvidence } from "@facility/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  LOCAL_CHECK_COMPLETED,
  LOCAL_REVIEW_TYPES,
  type LocalReviewSummary,
  localReviewSummary,
} from "./local-review-rules.js";

/**
 * Backlog review state for every story in a local project. Local stories have
 * no pull request; their review state comes from the story branch head recorded
 * after the latest turn and the review and check evidence.
 */
export async function localReviewSummaries(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  workspaceByStory: Map<string, { sourceRevisions: Record<string, { revision: string }> }>,
) {
  const [heads, events] = await Promise.all([
    // The newest recorded head per story, not every turn's.
    db
      .selectDistinctOn([turnGitEvidence.storyId], {
        storyId: turnGitEvidence.storyId,
        sha: turnGitEvidence.finalSha,
        dirty: turnGitEvidence.dirty,
      })
      .from(turnGitEvidence)
      .where(
        and(
          eq(turnGitEvidence.orgId, orgId),
          eq(turnGitEvidence.projectId, projectId),
          isNotNull(turnGitEvidence.finalSha),
        ),
      )
      .orderBy(turnGitEvidence.storyId, desc(turnGitEvidence.completedAt)),
    db
      .select({
        storyId: storyEvidenceEvents.storyId,
        type: storyEvidenceEvents.type,
        data: storyEvidenceEvents.data,
      })
      .from(storyEvidenceEvents)
      .where(
        and(
          eq(storyEvidenceEvents.orgId, orgId),
          eq(storyEvidenceEvents.projectId, projectId),
          inArray(storyEvidenceEvents.type, [...LOCAL_REVIEW_TYPES, LOCAL_CHECK_COMPLETED]),
        ),
      )
      .orderBy(desc(storyEvidenceEvents.occurredAt), desc(storyEvidenceEvents.observedAt)),
  ]);
  const headByStory = new Map<string, { sha: string; dirty: boolean }>();
  for (const head of heads) {
    if (head.sha) headByStory.set(head.storyId, { sha: head.sha, dirty: head.dirty });
  }
  const eventsByStory = new Map<string, typeof events>();
  for (const event of events) {
    const list = eventsByStory.get(event.storyId) ?? [];
    list.push(event);
    eventsByStory.set(event.storyId, list);
  }
  const summaries = new Map<string, LocalReviewSummary | null>();
  for (const [storyId, head] of headByStory) {
    summaries.set(
      storyId,
      localReviewSummary({
        head,
        imported: Object.values(workspaceByStory.get(storyId)?.sourceRevisions ?? {}).map(
          (entry) => entry.revision,
        ),
        events: eventsByStory.get(storyId) ?? [],
      }),
    );
  }
  return summaries;
}
