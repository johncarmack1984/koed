import type { Visibility } from "@koed/core";
import {
  workClassPriority,
  type KoedJobQueue,
  type KoedWorkClass
} from "@koed/shared";
import type { EmbeddingQueueJobData } from "./job-workflows.js";

export interface ProjectionCompactionJobData {
  userId: string;
  visibility: Visibility;
  workClass: KoedWorkClass;
}

interface ProjectionJobSchedulerConfig {
  compactionQueue: KoedJobQueue<ProjectionCompactionJobData>;
  embeddingQueue: KoedJobQueue<EmbeddingQueueJobData>;
}

const queueOptions = (workClass: KoedWorkClass) => ({
  priority: workClassPriority(workClass),
  attempts: 5,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000
});

const preferredWorkClass = (
  current: KoedWorkClass | undefined,
  candidate: KoedWorkClass
): KoedWorkClass =>
  !current || workClassPriority(candidate) < workClassPriority(current)
    ? candidate
    : current;

export const createProjectionJobScheduler =
  (config: ProjectionJobSchedulerConfig) =>
  async (
    actor: { userId: string },
    scopes: Array<{
      eventId: string;
      visibility: Visibility;
      workClass: KoedWorkClass;
    }>
  ): Promise<void> => {
    await Promise.all(
      scopes.map((scope) =>
        config.embeddingQueue.add(
          "embed-source",
          {
            sourceType: "memory_event",
            sourceId: scope.eventId,
            workClass: scope.workClass
          },
          queueOptions(scope.workClass)
        )
      )
    );
    const scopeClasses = new Map<Visibility, KoedWorkClass>();
    for (const scope of scopes) {
      scopeClasses.set(
        scope.visibility,
        preferredWorkClass(scopeClasses.get(scope.visibility), scope.workClass)
      );
    }
    await Promise.all(
      [...scopeClasses].map(([visibility, workClass]) =>
        config.compactionQueue.add(
          "compact-scope",
          { userId: actor.userId, visibility, workClass },
          queueOptions(workClass)
        )
      )
    );
  };
