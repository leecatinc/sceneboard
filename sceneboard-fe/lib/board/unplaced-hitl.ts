import {
  adaptLegacySceneToDocumentV2,
  collectDocumentNodesV2,
  type BoardSnapshot,
  type HitlInteractionV1,
} from '@sceneboard/board-schema';

const placedHitlRequestIds = (snapshot: BoardSnapshot): ReadonlySet<string> => {
  const result = new Set<string>();
  const document =
    'document' in snapshot
      ? snapshot.document
      : adaptLegacySceneToDocumentV2({ boardId: snapshot.boardId, scene: snapshot.scene });
  for (const item of collectDocumentNodesV2(document))
    if (item.node.type === 'content.hitl') result.add(item.node.hitlRequestId);
  return result;
};

export const selectUnplacedOpenHitlV1 = (snapshot: BoardSnapshot): readonly HitlInteractionV1[] => {
  const placed = placedHitlRequestIds(snapshot);
  return snapshot.hitl.filter(
    (interaction) => interaction.state === 'open' && !placed.has(interaction.hitlRequestId),
  );
};
