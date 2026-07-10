import type { Visibility } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import { workClassPriority, type KoedWorkClass } from "@koed/shared";

interface ProjectedMemoryEventScope {
  eventId: string;
  visibility: Visibility;
  includeInEmbedding: boolean;
  includeInLcm: boolean;
  workClass: KoedWorkClass;
}

interface ProjectionJobSchedulerConfig {
  embeddingDispatchKey: string;
  enqueueLcmCompaction(
    requesterContext: { userId: string },
    visibility: Visibility,
    dispatchKey: string,
    workClass: KoedWorkClass
  ): Promise<unknown>;
  enqueueSourceEmbedding(
    sourceType: "memory_event",
    sourceId: string,
    dispatchKey: string,
    workClass: KoedWorkClass
  ): Promise<unknown>;
  repository: MemorySourceRepository;
}

const preferredWorkClass = (
  current: KoedWorkClass | undefined,
  candidate: KoedWorkClass
): KoedWorkClass =>
  !current || workClassPriority(candidate) < workClassPriority(current)
    ? candidate
    : current;

const lcmScopeClasses = (
  scopes: ProjectedMemoryEventScope[]
): Map<Visibility, KoedWorkClass> => {
  const classes = new Map<Visibility, KoedWorkClass>();
  for (const scope of scopes) {
    if (!scope.includeInLcm) {
      continue;
    }
    classes.set(
      scope.visibility,
      preferredWorkClass(classes.get(scope.visibility), scope.workClass)
    );
  }
  return classes;
};

export const createProjectionJobScheduler =
  (config: ProjectionJobSchedulerConfig) =>
  async (
    actor: { userId: string },
    scopes: ProjectedMemoryEventScope[]
  ): Promise<void> => {
    await Promise.all(
      scopes
        .filter((scope) => scope.includeInEmbedding)
        .map((scope) =>
          config.enqueueSourceEmbedding(
            "memory_event",
            scope.eventId,
            config.embeddingDispatchKey,
            scope.workClass
          )
        )
    );
    const pendingLcmScopes =
      await config.repository.listPendingLcmDispatchScopes({
        limit: 1,
        ownerUserId: actor.userId
      });
    const dispatchByVisibility = new Map(
      pendingLcmScopes.map((scope) => [scope.visibility, scope.dispatchKey])
    );
    await Promise.all(
      [...lcmScopeClasses(scopes)].flatMap(([visibility, workClass]) => {
        const dispatchKey = dispatchByVisibility.get(visibility);
        return dispatchKey
          ? [
              config.enqueueLcmCompaction(
                actor,
                visibility,
                dispatchKey,
                workClass
              )
            ]
          : [];
      })
    );
  };
