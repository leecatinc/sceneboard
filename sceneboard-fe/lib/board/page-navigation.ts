import {
  adaptLegacySceneToDocumentV2,
  type BoardDocumentV2,
  type BoardSnapshot,
  type PageId,
} from '@sceneboard/board-schema';

export type PageNavigationCommandV1 = 'previous' | 'next' | 'first' | 'last';

export type PageNavigationElementFactsV1 = Readonly<{
  tagName: string | null;
  role: string | null;
  isContentEditable: boolean;
}>;

export type PageNavigationAdmissionV1 = Readonly<{
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: PageNavigationElementFactsV1 | null;
  composedPath: readonly PageNavigationElementFactsV1[];
  hitlInteractionActive: boolean;
  artifactCaptureActive: boolean;
  moveCaptureActive: boolean;
}>;

const COMMAND_BY_KEY: Readonly<Record<string, PageNavigationCommandV1>> = {
  ArrowLeft: 'previous',
  ArrowRight: 'next',
  PageUp: 'previous',
  PageDown: 'next',
  Home: 'first',
  End: 'last',
};
const FORM_TAGS = new Set(['BUTTON', 'INPUT', 'OPTION', 'SELECT', 'TEXTAREA']);
const EDITABLE_ROLES = new Set(['combobox', 'slider', 'spinbutton', 'textbox']);
const EXCLUDED_ROLES = new Set(['dialog', 'listbox', 'menu']);

const isEditingFact = (fact: PageNavigationElementFactsV1): boolean =>
  fact.isContentEditable ||
  (fact.tagName !== null && FORM_TAGS.has(fact.tagName)) ||
  (fact.role !== null && EDITABLE_ROLES.has(fact.role));

const isExcludedContainer = (fact: PageNavigationElementFactsV1): boolean =>
  fact.role !== null && EXCLUDED_ROLES.has(fact.role);

export const pageNavigationElementFactsV1 = (
  target: EventTarget | null,
): PageNavigationElementFactsV1 | null => {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  return {
    tagName: target.tagName,
    role: target.getAttribute('role'),
    isContentEditable: target instanceof HTMLElement && target.isContentEditable,
  };
};

export const admitPageNavigationKeyV1 = (
  input: PageNavigationAdmissionV1,
): PageNavigationCommandV1 | null => {
  const command = COMMAND_BY_KEY[input.key] ?? null;
  if (
    command === null ||
    input.defaultPrevented ||
    input.isComposing ||
    input.altKey ||
    input.ctrlKey ||
    input.metaKey ||
    input.hitlInteractionActive ||
    input.artifactCaptureActive ||
    input.moveCaptureActive ||
    (input.target !== null && isEditingFact(input.target)) ||
    input.composedPath.some((fact) => isEditingFact(fact) || isExcludedContainer(fact))
  )
    return null;
  return command;
};

export const documentForPageNavigationV1 = (snapshot: BoardSnapshot): BoardDocumentV2 =>
  'document' in snapshot
    ? snapshot.document
    : adaptLegacySceneToDocumentV2({ boardId: snapshot.boardId, scene: snapshot.scene });

export const resolveSelectedPageIdV1 = (
  document: BoardDocumentV2,
  selectedPageId: PageId | null,
): PageId => {
  if (selectedPageId !== null && document.pages.some((page) => page.pageId === selectedPageId))
    return selectedPageId;
  if (document.pages.some((page) => page.pageId === document.defaultPageId))
    return document.defaultPageId;
  const first = document.pages[0];
  if (first === undefined) throw new TypeError('document has no selectable page');
  return first.pageId;
};

export const navigatePageIdV1 = (
  document: BoardDocumentV2,
  selectedPageId: PageId,
  command: PageNavigationCommandV1,
): PageId => {
  const currentIndex = document.pages.findIndex((page) => page.pageId === selectedPageId);
  if (currentIndex < 0) throw new TypeError('selected page is not present');
  const targetIndex =
    command === 'first'
      ? 0
      : command === 'last'
        ? document.pages.length - 1
        : command === 'previous'
          ? Math.max(0, currentIndex - 1)
          : Math.min(document.pages.length - 1, currentIndex + 1);
  return document.pages[targetIndex]?.pageId ?? selectedPageId;
};
