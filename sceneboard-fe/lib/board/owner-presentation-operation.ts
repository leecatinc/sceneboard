export type OwnerPresentationAdmissionIdentityV1 = Readonly<{
  mounted: boolean;
  boardId: string;
  revisionId: string | null;
  allowed: boolean;
}>;

export const ownerPresentationOperationIsCurrentV1 = (input: {
  operationEpoch: number;
  currentOperationEpoch: number;
  expected: Pick<OwnerPresentationAdmissionIdentityV1, 'boardId' | 'revisionId'>;
  current: OwnerPresentationAdmissionIdentityV1;
}): boolean =>
  input.operationEpoch === input.currentOperationEpoch &&
  input.current.mounted &&
  input.current.allowed &&
  input.current.boardId === input.expected.boardId &&
  input.current.revisionId === input.expected.revisionId;
