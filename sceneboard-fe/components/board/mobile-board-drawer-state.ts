export type MobileBoardDrawerStateV1 = Readonly<{
  open: boolean;
  dialogEpoch: number;
  slotSignature: string;
}>;

export type MobileBoardDrawerEventV1 =
  | Readonly<{ type: 'open' }>
  | Readonly<{ type: 'close' }>
  | Readonly<{ type: 'slots-hydrated'; slotSignature: string }>;

export const mobileBoardDrawerSlotSignatureV1 = (slots: readonly unknown[]): string =>
  slots.map((slot) => (slot === null ? '0' : '1')).join('');

export const reduceMobileBoardDrawerV1 = (
  state: MobileBoardDrawerStateV1,
  event: MobileBoardDrawerEventV1,
): MobileBoardDrawerStateV1 => {
  if (event.type === 'open')
    return state.open ? state : { ...state, open: true, dialogEpoch: state.dialogEpoch + 1 };
  if (event.type === 'close') return state.open ? { ...state, open: false } : state;
  if (event.slotSignature === state.slotSignature) return state;
  return { ...state, slotSignature: event.slotSignature };
};
