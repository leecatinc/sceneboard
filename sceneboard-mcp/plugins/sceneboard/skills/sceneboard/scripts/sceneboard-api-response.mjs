import {
  ARTIFACT_CAPABILITIES,
  BOARD_ERROR_STATUS,
  BOARD_LIMITS,
  CURSOR_PATTERN,
  HITL_KINDS,
  validTimestamp,
} from './sceneboard-api-contract.mjs';
import { hasExactKeys, isRecord } from './sceneboard-api-json.mjs';
import {
  containsSecretValue,
  exactCatalog,
  hasContextualSecret,
  isSecretShaped,
  parseCapabilities,
  safeText,
  SENSITIVE_CONTEXT_PATTERN,
  validArtifactReference,
  validGlobalId,
  validLocalId,
} from './sceneboard-api-public.mjs';

export const publicJsonTree = (
  value,
  depth = 0,
  budget = { count: 0 },
  inheritedSensitiveContext = false,
) => {
  budget.count += 1;
  if (budget.count > 10_000 || depth > 64) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string')
    return (
      !(inheritedSensitiveContext && isSecretShaped(value)) &&
      !containsSecretValue(value) &&
      !/[\uD800-\uDFFF]/u.test(value)
    );
  if (Array.isArray(value)) {
    return value.every((item) =>
      publicJsonTree(item, depth + 1, budget, inheritedSensitiveContext),
    );
  }
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, item]) => {
      const sensitiveContext = inheritedSensitiveContext || SENSITIVE_CONTEXT_PATTERN.test(key);
      return (
        !(sensitiveContext && isSecretShaped(item)) &&
        publicJsonTree(item, depth + 1, budget, sensitiveContext)
      );
    })
  );
};

const projectRevisionSummary = (value) =>
  hasExactKeys(value, ['revisionId', 'revisionNumber', 'createdAt']) &&
  validGlobalId(value.revisionId) &&
  Number.isSafeInteger(value.revisionNumber) &&
  value.revisionNumber > 0 &&
  validTimestamp(value.createdAt)
    ? {
        revisionId: value.revisionId,
        revisionNumber: value.revisionNumber,
        createdAt: value.createdAt,
      }
    : null;

const projectBoardSummary = (value) => {
  const headRevision = projectRevisionSummary(value?.headRevision);
  if (
    !hasExactKeys(value, [
      'boardId',
      'title',
      'createdAt',
      'updatedAt',
      'archivedAt',
      'headRevision',
    ]) ||
    !validGlobalId(value.boardId) ||
    !safeText(value.title) ||
    containsSecretValue(value.title) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt) ||
    (value.archivedAt !== null && !validTimestamp(value.archivedAt)) ||
    headRevision === null
  )
    return null;
  return {
    boardId: value.boardId,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt,
    headRevision,
  };
};

const projectActor = (value) =>
  hasExactKeys(value, ['principalKind', 'principalId']) &&
  ['user', 'mcp_client', 'service'].includes(value.principalKind) &&
  validGlobalId(value.principalId)
    ? { principalKind: value.principalKind, principalId: value.principalId }
    : null;

const projectSnapshotRevision = (value) => {
  const actor = projectActor(value?.actor);
  if (
    actor === null ||
    !hasExactKeys(value, [
      'revisionId',
      'revisionNumber',
      'createdAt',
      'previousRevisionId',
      'originType',
      'sourceRevisionId',
      'actor',
    ]) ||
    !validGlobalId(value.revisionId) ||
    !Number.isSafeInteger(value.revisionNumber) ||
    value.revisionNumber < 1 ||
    !validTimestamp(value.createdAt) ||
    (value.previousRevisionId !== null && !validGlobalId(value.previousRevisionId)) ||
    !['board.create', 'scene.replace', 'scene.clear', 'scene.restore'].includes(value.originType) ||
    (value.sourceRevisionId !== null && !validGlobalId(value.sourceRevisionId))
  )
    return null;
  return {
    revisionId: value.revisionId,
    revisionNumber: value.revisionNumber,
    createdAt: value.createdAt,
    previousRevisionId: value.previousRevisionId,
    originType: value.originType,
    sourceRevisionId: value.sourceRevisionId,
    actor,
  };
};

const projectArtifactReference = (value) =>
  validArtifactReference(value)
    ? { artifactId: value.artifactId, versionId: value.versionId }
    : null;

const projectArtifactRuntime = (value) => {
  const artifact = projectArtifactReference(value?.artifact);
  if (
    !hasExactKeys(value, ['artifact', 'status', 'updatedAt', 'failure']) ||
    artifact === null ||
    !['ready', 'running', 'stopped', 'failed', 'blocked'].includes(value.status) ||
    !validTimestamp(value.updatedAt)
  )
    return null;
  const requiresFailure = ['failed', 'blocked'].includes(value.status);
  let failure = null;
  if (value.failure !== null) {
    if (
      !hasExactKeys(value.failure, ['code', 'message']) ||
      !Object.hasOwn(BOARD_ERROR_STATUS, value.failure.code) ||
      !safeText(value.failure.message) ||
      containsSecretValue(value.failure.message)
    )
      return null;
    failure = { code: value.failure.code, message: value.failure.message };
  }
  if (requiresFailure !== (failure !== null)) return null;
  return { artifact, status: value.status, updatedAt: value.updatedAt, failure };
};

const projectArtifactManifest = (value) => {
  const artifact = projectArtifactReference(value?.artifact);
  if (
    !hasExactKeys(value, [
      'protocolVersion',
      'type',
      'artifact',
      'entryPath',
      'resources',
      'requestedCapabilities',
    ]) ||
    value.protocolVersion !== 1 ||
    value.type !== 'artifact.manifest' ||
    artifact === null ||
    typeof value.entryPath !== 'string' ||
    value.entryPath.length < 1 ||
    value.entryPath.startsWith('/') ||
    value.entryPath.includes('\\') ||
    value.entryPath.includes('\0') ||
    value.entryPath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    !Array.isArray(value.resources) ||
    value.resources.length < 1 ||
    value.resources.length > BOARD_LIMITS.maxArtifactResources ||
    exactCatalog(value.requestedCapabilities, ARTIFACT_CAPABILITIES) === null
  )
    return null;
  const resources = [];
  const paths = new Set();
  let totalBytes = 0;
  for (const resource of value.resources) {
    if (
      !hasExactKeys(resource, ['path', 'mediaType', 'sha256', 'byteLength']) ||
      typeof resource.path !== 'string' ||
      resource.path.length < 1 ||
      resource.path.startsWith('/') ||
      resource.path.includes('\\') ||
      resource.path.includes('\0') ||
      resource.path
        .split('/')
        .some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
      paths.has(resource.path) ||
      typeof resource.mediaType !== 'string' ||
      !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]{1,127}$/u.test(resource.mediaType) ||
      typeof resource.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(resource.sha256) ||
      !Number.isSafeInteger(resource.byteLength) ||
      resource.byteLength < 0 ||
      resource.byteLength > BOARD_LIMITS.maxArtifactResourceBytes
    )
      return null;
    paths.add(resource.path);
    totalBytes += resource.byteLength;
    resources.push({
      path: resource.path,
      mediaType: resource.mediaType,
      sha256: resource.sha256,
      byteLength: resource.byteLength,
    });
  }
  if (!paths.has(value.entryPath) || totalBytes > BOARD_LIMITS.maxArtifactTotalBytes) return null;
  return {
    protocolVersion: 1,
    type: 'artifact.manifest',
    artifact,
    entryPath: value.entryPath,
    resources,
    requestedCapabilities: [...value.requestedCapabilities],
  };
};

const hasOptionalExactKeys = (value, required, optional = []) => {
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key))) return false;
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key));
};

const validContentText = (value, maximum) =>
  typeof value === 'string' &&
  [...value].length <= maximum &&
  !/[\uD800-\uDFFF]/u.test(value) &&
  !containsSecretValue(value);

const projectHitlOption = (value, parentContext) => {
  if (
    !hasOptionalExactKeys(value, ['id', 'label'], ['description']) ||
    !validLocalId(value.id) ||
    !safeText(value.label) ||
    containsSecretValue(value.label) ||
    (value.description !== undefined &&
      (!safeText(value.description) || containsSecretValue(value.description))) ||
    hasContextualSecret([parentContext, value.id], [value.id, value.label, value.description])
  )
    return null;
  return {
    id: value.id,
    label: value.label,
    ...(value.description === undefined ? {} : { description: value.description }),
  };
};

const projectHitlOptions = (value, parentContext) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > BOARD_LIMITS.maxHitlOptions)
    return null;
  const options = value.map((option) => projectHitlOption(option, parentContext));
  return options.some((option) => option === null) ||
    new Set(options.map((option) => option.id)).size !== options.length
    ? null
    : options;
};

const projectHitlField = (value) => {
  if (
    !isRecord(value) ||
    !validLocalId(value.id) ||
    !safeText(value.label) ||
    containsSecretValue(value.label) ||
    hasContextualSecret([value.id], [value.label]) ||
    typeof value.required !== 'boolean'
  )
    return null;
  if (value.type === 'text') {
    if (
      !hasExactKeys(value, [
        'id',
        'type',
        'label',
        'required',
        'defaultValue',
        'minLength',
        'maxLength',
      ]) ||
      !Number.isSafeInteger(value.minLength) ||
      value.minLength < 0 ||
      value.minLength > BOARD_LIMITS.maxHitlTextChars ||
      !Number.isSafeInteger(value.maxLength) ||
      value.maxLength < 1 ||
      value.maxLength > BOARD_LIMITS.maxHitlTextChars ||
      value.minLength > value.maxLength ||
      (value.defaultValue !== null &&
        (!validContentText(value.defaultValue, BOARD_LIMITS.maxHitlTextChars) ||
          [...value.defaultValue].length < value.minLength ||
          [...value.defaultValue].length > value.maxLength ||
          hasContextualSecret([value.id], [value.defaultValue])))
    )
      return null;
    return {
      id: value.id,
      type: 'text',
      label: value.label,
      required: value.required,
      defaultValue: value.defaultValue,
      minLength: value.minLength,
      maxLength: value.maxLength,
    };
  }
  if (value.type === 'number') {
    if (
      !hasExactKeys(value, ['id', 'type', 'label', 'required', 'defaultValue', 'min', 'max']) ||
      (value.defaultValue !== null &&
        (typeof value.defaultValue !== 'number' || !Number.isFinite(value.defaultValue))) ||
      (value.min !== null && (typeof value.min !== 'number' || !Number.isFinite(value.min))) ||
      (value.max !== null && (typeof value.max !== 'number' || !Number.isFinite(value.max))) ||
      (value.min !== null && value.max !== null && value.min > value.max) ||
      (value.defaultValue !== null &&
        ((value.min !== null && value.defaultValue < value.min) ||
          (value.max !== null && value.defaultValue > value.max)))
    )
      return null;
    return {
      id: value.id,
      type: 'number',
      label: value.label,
      required: value.required,
      defaultValue: value.defaultValue,
      min: value.min,
      max: value.max,
    };
  }
  if (value.type === 'boolean') {
    if (
      !hasExactKeys(value, ['id', 'type', 'label', 'required', 'defaultValue']) ||
      (value.defaultValue !== null && typeof value.defaultValue !== 'boolean')
    )
      return null;
    return {
      id: value.id,
      type: 'boolean',
      label: value.label,
      required: value.required,
      defaultValue: value.defaultValue,
    };
  }
  if (value.type === 'select') {
    const options = projectHitlOptions(value.options, value.id);
    if (
      !hasExactKeys(value, ['id', 'type', 'label', 'required', 'defaultValue', 'options']) ||
      options === null ||
      (value.defaultValue !== null &&
        (!validLocalId(value.defaultValue) ||
          !options.some((option) => option.id === value.defaultValue) ||
          hasContextualSecret([value.id], [value.defaultValue])))
    )
      return null;
    return {
      id: value.id,
      type: 'select',
      label: value.label,
      required: value.required,
      defaultValue: value.defaultValue,
      options,
    };
  }
  return null;
};

const projectHitlDefinition = (value) => {
  if (
    !isRecord(value) ||
    !HITL_KINDS.includes(value.kind) ||
    !safeText(value.title) ||
    containsSecretValue(value.title)
  )
    return null;
  let definition = null;
  if (value.kind === 'info') {
    if (
      hasExactKeys(value, ['kind', 'title', 'body', 'acknowledgeLabel']) &&
      validContentText(value.body, BOARD_LIMITS.maxMarkdownChars) &&
      safeText(value.acknowledgeLabel) &&
      !containsSecretValue(value.acknowledgeLabel)
    ) {
      definition = {
        kind: 'info',
        title: value.title,
        body: value.body,
        acknowledgeLabel: value.acknowledgeLabel,
      };
    }
  } else if (value.kind === 'choice') {
    const options = projectHitlOptions(value.options);
    if (
      hasOptionalExactKeys(
        value,
        ['kind', 'title', 'multiple', 'minSelections', 'maxSelections', 'options'],
        ['body'],
      ) &&
      (value.body === undefined || validContentText(value.body, BOARD_LIMITS.maxMarkdownChars)) &&
      typeof value.multiple === 'boolean' &&
      Number.isSafeInteger(value.minSelections) &&
      value.minSelections >= 1 &&
      Number.isSafeInteger(value.maxSelections) &&
      value.maxSelections >= 1 &&
      options !== null &&
      value.minSelections <= value.maxSelections &&
      value.maxSelections <= options.length &&
      (value.multiple || (value.minSelections === 1 && value.maxSelections === 1))
    ) {
      definition = {
        kind: 'choice',
        title: value.title,
        ...(value.body === undefined ? {} : { body: value.body }),
        multiple: value.multiple,
        minSelections: value.minSelections,
        maxSelections: value.maxSelections,
        options,
      };
    }
  } else if (value.kind === 'form') {
    const fields = Array.isArray(value.fields) ? value.fields.map(projectHitlField) : [];
    if (
      hasOptionalExactKeys(value, ['kind', 'title', 'fields', 'submitLabel'], ['body']) &&
      (value.body === undefined || validContentText(value.body, BOARD_LIMITS.maxMarkdownChars)) &&
      Array.isArray(value.fields) &&
      fields.length >= 1 &&
      fields.length <= BOARD_LIMITS.maxHitlFields &&
      !fields.some((field) => field === null) &&
      new Set(fields.map((field) => field.id)).size === fields.length &&
      safeText(value.submitLabel) &&
      !containsSecretValue(value.submitLabel)
    ) {
      definition = {
        kind: 'form',
        title: value.title,
        ...(value.body === undefined ? {} : { body: value.body }),
        fields,
        submitLabel: value.submitLabel,
      };
    }
  } else if (
    hasExactKeys(value, ['kind', 'title', 'body', 'impact', 'confirmLabel', 'cancelLabel']) &&
    validContentText(value.body, BOARD_LIMITS.maxMarkdownChars) &&
    ['standard', 'destructive'].includes(value.impact) &&
    safeText(value.confirmLabel) &&
    !containsSecretValue(value.confirmLabel) &&
    safeText(value.cancelLabel) &&
    !containsSecretValue(value.cancelLabel)
  ) {
    definition = {
      kind: 'confirmation',
      title: value.title,
      body: value.body,
      impact: value.impact,
      confirmLabel: value.confirmLabel,
      cancelLabel: value.cancelLabel,
    };
  }
  return definition !== null && publicJsonTree(definition) ? definition : null;
};

const projectHitlResponse = (value, definition) => {
  if (!isRecord(value) || value.kind !== definition.kind) return null;
  let response = null;
  if (value.kind === 'info') {
    if (hasExactKeys(value, ['kind', 'acknowledged']) && value.acknowledged === true)
      response = { kind: 'info', acknowledged: true };
  } else if (value.kind === 'choice') {
    const selected = value.selectedOptionIds;
    const known = new Set(definition.options.map((option) => option.id));
    if (
      hasExactKeys(value, ['kind', 'selectedOptionIds']) &&
      Array.isArray(selected) &&
      selected.length >= definition.minSelections &&
      selected.length <= definition.maxSelections &&
      selected.length <= BOARD_LIMITS.maxHitlOptions &&
      selected.every(validLocalId) &&
      new Set(selected).size === selected.length &&
      selected.every((id) => known.has(id))
    ) {
      response = { kind: 'choice', selectedOptionIds: [...selected] };
    }
  } else if (value.kind === 'form') {
    const values = value.values;
    const fields = new Map(definition.fields.map((field) => [field.id, field]));
    if (
      hasExactKeys(value, ['kind', 'values']) &&
      isRecord(values) &&
      Object.keys(values).length === fields.size &&
      Object.keys(values).every((key) => validLocalId(key) && fields.has(key))
    ) {
      let valid = true;
      const projected = {};
      for (const [id, field] of fields) {
        const item = values[id];
        if (item === null) valid = !field.required;
        else if (field.type === 'text')
          valid =
            validContentText(item, BOARD_LIMITS.maxHitlTextChars) &&
            [...item].length >= field.minLength &&
            [...item].length <= field.maxLength;
        else if (field.type === 'number')
          valid =
            typeof item === 'number' &&
            Number.isFinite(item) &&
            (field.min === null || item >= field.min) &&
            (field.max === null || item <= field.max);
        else if (field.type === 'boolean') valid = typeof item === 'boolean';
        else valid = validLocalId(item) && field.options.some((option) => option.id === item);
        if (!valid) break;
        projected[id] = item;
      }
      if (valid) response = { kind: 'form', values: projected };
    }
  } else if (hasExactKeys(value, ['kind', 'confirmed']) && typeof value.confirmed === 'boolean') {
    response = { kind: 'confirmation', confirmed: value.confirmed };
  }
  return response !== null && publicJsonTree(response) ? response : null;
};

const projectHitl = (value) => {
  const definition = projectHitlDefinition(value?.definition);
  if (
    !hasExactKeys(value, [
      'hitlRequestId',
      'definition',
      'state',
      'createdAt',
      'expiresAt',
      'stateUpdatedAt',
      'response',
      'answeredAt',
    ]) ||
    !validGlobalId(value.hitlRequestId) ||
    definition === null ||
    !['open', 'answered', 'superseded', 'expired', 'cancelled'].includes(value.state) ||
    !validTimestamp(value.createdAt) ||
    (value.expiresAt !== null && !validTimestamp(value.expiresAt)) ||
    !validTimestamp(value.stateUpdatedAt) ||
    (value.answeredAt !== null && !validTimestamp(value.answeredAt))
  )
    return null;
  const response = value.response === null ? null : projectHitlResponse(value.response, definition);
  if (value.response !== null && response === null) return null;
  const created = Date.parse(value.createdAt);
  const updated = Date.parse(value.stateUpdatedAt);
  const expires = value.expiresAt === null ? null : Date.parse(value.expiresAt);
  const answered = value.answeredAt === null ? null : Date.parse(value.answeredAt);
  if (expires !== null && expires <= created) return null;
  if (value.state === 'open') {
    if (response !== null || answered !== null || updated !== created) return null;
  } else if (value.state === 'answered') {
    if (
      response === null ||
      answered === null ||
      answered <= created ||
      updated !== answered ||
      (expires !== null && answered >= expires)
    )
      return null;
  } else if (value.state === 'expired') {
    if (response !== null || answered !== null || expires === null || updated < expires)
      return null;
  } else if (
    response !== null ||
    answered !== null ||
    updated <= created ||
    (expires !== null && updated >= expires)
  )
    return null;
  return {
    hitlRequestId: value.hitlRequestId,
    definition,
    state: value.state,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    stateUpdatedAt: value.stateUpdatedAt,
    response,
    answeredAt: value.answeredAt,
  };
};

const projectBoardSnapshot = (value) => {
  const revision = projectSnapshotRevision(value?.revision);
  const capabilities = parseCapabilities(value?.capabilities);
  if (
    !hasExactKeys(value, [
      'protocolVersion',
      'type',
      'boardId',
      'revision',
      'scene',
      'hitl',
      'artifacts',
      'capabilities',
      'lastEventSequence',
    ]) ||
    value.protocolVersion !== 1 ||
    value.type !== 'board.snapshot' ||
    !validGlobalId(value.boardId) ||
    revision === null ||
    !hasExactKeys(value.scene, ['protocolVersion', 'type', 'root']) ||
    value.scene.protocolVersion !== 1 ||
    value.scene.type !== 'scene' ||
    !publicJsonTree(value.scene.root) ||
    !Array.isArray(value.hitl) ||
    !Array.isArray(value.artifacts) ||
    capabilities === null ||
    !Number.isSafeInteger(value.lastEventSequence) ||
    value.lastEventSequence < 0
  )
    return null;
  const hitl = value.hitl.map(projectHitl);
  const artifacts = value.artifacts.map(projectArtifactRuntime);
  if (
    hitl.some((item) => item === null) ||
    artifacts.some((item) => item === null) ||
    new Set(hitl.map((item) => item.hitlRequestId)).size !== hitl.length ||
    new Set(artifacts.map((item) => `${item.artifact.artifactId}\0${item.artifact.versionId}`))
      .size !== artifacts.length
  )
    return null;
  return {
    protocolVersion: 1,
    type: 'board.snapshot',
    boardId: value.boardId,
    revision,
    scene: { protocolVersion: 1, type: 'scene', root: structuredClone(value.scene.root) },
    hitl,
    artifacts,
    capabilities,
    lastEventSequence: value.lastEventSequence,
  };
};

const projectHistoryEntry = (value) => {
  const revision = projectRevisionSummary(value?.revision);
  const actor = projectActor(value?.actor);
  if (
    !hasExactKeys(value, [
      'revision',
      'previousRevisionId',
      'originType',
      'sourceRevisionId',
      'actor',
    ]) ||
    revision === null ||
    actor === null ||
    (value.previousRevisionId !== null && !validGlobalId(value.previousRevisionId)) ||
    !['board.create', 'scene.replace', 'scene.clear', 'scene.restore'].includes(value.originType) ||
    (value.sourceRevisionId !== null && !validGlobalId(value.sourceRevisionId))
  )
    return null;
  return {
    revision,
    previousRevisionId: value.previousRevisionId,
    originType: value.originType,
    sourceRevisionId: value.sourceRevisionId,
    actor,
  };
};

const projectHistoryMetadata = (value) => {
  if (
    !hasExactKeys(value, ['protocolVersion', 'type', 'entries', 'navigation']) ||
    value.protocolVersion !== 1 ||
    value.type !== 'history.adapter-metadata' ||
    !Array.isArray(value.entries) ||
    value.entries.length > 100
  )
    return null;
  const entries = [];
  for (const entry of value.entries) {
    if (
      !hasExactKeys(entry, ['revisionId', 'label']) ||
      !validGlobalId(entry.revisionId) ||
      !safeText(entry.label) ||
      containsSecretValue(entry.label)
    )
      return null;
    entries.push({ revisionId: entry.revisionId, label: entry.label });
  }
  let navigation = null;
  if (value.navigation !== null) {
    if (
      !hasExactKeys(value.navigation, [
        'revisionId',
        'previousRevisionId',
        'nextRevisionId',
        'latestRevisionId',
      ]) ||
      !validGlobalId(value.navigation.revisionId) ||
      !validGlobalId(value.navigation.latestRevisionId) ||
      (value.navigation.previousRevisionId !== null &&
        !validGlobalId(value.navigation.previousRevisionId)) ||
      (value.navigation.nextRevisionId !== null && !validGlobalId(value.navigation.nextRevisionId))
    )
      return null;
    navigation = { ...value.navigation };
  }
  return { protocolVersion: 1, type: 'history.adapter-metadata', entries, navigation };
};

const projectResultData = (type, data, correlation) => {
  if (!isRecord(data) || data.type !== type || !publicJsonTree(data)) return null;
  if (type === 'board.list') {
    if (
      !hasExactKeys(data, ['type', 'boards', 'nextCursor']) ||
      !Array.isArray(data.boards) ||
      data.boards.length > 100 ||
      (data.nextCursor !== null &&
        (typeof data.nextCursor !== 'string' || !CURSOR_PATTERN.test(data.nextCursor)))
    )
      return null;
    const boards = data.boards.map(projectBoardSummary);
    return boards.some((item) => item === null)
      ? null
      : { type, boards, nextCursor: data.nextCursor };
  }
  if (type === 'board.get' || type === 'board.create') {
    const board = projectBoardSummary(data.board);
    const snapshot = projectBoardSnapshot(data.snapshot);
    if (
      !hasExactKeys(data, ['type', 'board', 'snapshot']) ||
      board === null ||
      snapshot === null ||
      board.boardId !== snapshot.boardId ||
      board.headRevision.revisionId !== snapshot.revision.revisionId ||
      (correlation?.boardId !== undefined && board.boardId !== correlation.boardId)
    )
      return null;
    if (
      type === 'board.create' &&
      (snapshot.revision.revisionNumber !== 1 || snapshot.scene.root !== null)
    )
      return null;
    return { type, board, snapshot };
  }
  if (type === 'board.archive') {
    const board = projectBoardSummary(data.board);
    return hasExactKeys(data, ['type', 'board']) &&
      board !== null &&
      (correlation?.boardId === undefined || board.boardId === correlation.boardId)
      ? { type, board }
      : null;
  }
  if (type === 'capabilities.get') {
    const capabilities = parseCapabilities(data.capabilities);
    return hasExactKeys(data, ['type', 'capabilities']) && capabilities !== null
      ? { type, capabilities }
      : null;
  }
  if (type === 'history.list') {
    if (
      !hasExactKeys(data, ['type', 'entries', 'nextCursor']) ||
      !Array.isArray(data.entries) ||
      data.entries.length > 100 ||
      (data.nextCursor !== null &&
        (typeof data.nextCursor !== 'string' || !CURSOR_PATTERN.test(data.nextCursor)))
    )
      return null;
    const entries = data.entries.map(projectHistoryEntry);
    return entries.some((item) => item === null)
      ? null
      : { type, entries, nextCursor: data.nextCursor };
  }
  if (type === 'history.get') {
    const entry = projectHistoryEntry(data.entry);
    const snapshot = projectBoardSnapshot(data.snapshot);
    return hasExactKeys(data, ['type', 'entry', 'snapshot']) &&
      entry !== null &&
      snapshot !== null &&
      entry.revision.revisionId === snapshot.revision.revisionId &&
      (correlation?.boardId === undefined || snapshot.boardId === correlation.boardId) &&
      (correlation?.revisionId === undefined ||
        entry.revision.revisionId === correlation.revisionId)
      ? { type, entry, snapshot }
      : null;
  }
  if (type === 'artifact.get') {
    const manifest = projectArtifactManifest(data.manifest);
    const runtime = projectArtifactRuntime(data.runtime);
    return hasExactKeys(data, ['type', 'manifest', 'runtime']) &&
      manifest !== null &&
      runtime !== null &&
      manifest.artifact.artifactId === runtime.artifact.artifactId &&
      manifest.artifact.versionId === runtime.artifact.versionId &&
      (correlation?.artifactId === undefined ||
        (manifest.artifact.artifactId === correlation.artifactId &&
          manifest.artifact.versionId === correlation.versionId))
      ? { type, manifest, runtime }
      : null;
  }
  if (type === 'hitl.read') {
    const hitl = projectHitl(data.hitl);
    return hasExactKeys(data, ['type', 'changed', 'hitl']) &&
      typeof data.changed === 'boolean' &&
      hitl !== null &&
      (correlation?.hitlRequestId === undefined || hitl.hitlRequestId === correlation.hitlRequestId)
      ? { type, changed: data.changed, hitl }
      : null;
  }
  if (type === 'scene.replace' || type === 'scene.clear') {
    const revision = projectRevisionSummary(data.revision);
    return hasExactKeys(data, ['type', 'revision']) && revision !== null
      ? { type, revision }
      : null;
  }
  if (type === 'scene.restore') {
    const revision = projectRevisionSummary(data.revision);
    return hasExactKeys(data, ['type', 'sourceRevisionId', 'revision']) &&
      validGlobalId(data.sourceRevisionId) &&
      revision !== null &&
      (correlation?.revisionId === undefined || data.sourceRevisionId === correlation.revisionId)
      ? { type, sourceRevisionId: data.sourceRevisionId, revision }
      : null;
  }
  if (type === 'hitl.request' || type === 'hitl.respond') {
    const hitl = projectHitl(data.hitl);
    return hasExactKeys(data, ['type', 'hitl']) &&
      hitl !== null &&
      hitl.state === (type === 'hitl.request' ? 'open' : 'answered') &&
      (correlation?.hitlRequestId === undefined || hitl.hitlRequestId === correlation.hitlRequestId)
      ? { type, hitl }
      : null;
  }
  if (type === 'artifact.publish' || type === 'artifact.stop') {
    const artifact = projectArtifactRuntime(data.artifact);
    return hasExactKeys(data, ['type', 'artifact']) &&
      artifact !== null &&
      (correlation?.artifactId === undefined ||
        (artifact.artifact.artifactId === correlation.artifactId &&
          (correlation.versionId === undefined ||
            artifact.artifact.versionId === correlation.versionId)))
      ? { type, artifact }
      : null;
  }
  return null;
};

export const projectBoardEnvelope = (parsed, { requestId, expectedType, status, correlation }) => {
  if (
    !hasExactKeys(parsed, ['protocolVersion', 'type', 'requestId', 'result', 'metadata']) ||
    parsed.protocolVersion !== 1 ||
    parsed.type !== 'board.http.success' ||
    parsed.requestId !== requestId ||
    !hasExactKeys(parsed.metadata, ['history']) ||
    !isRecord(parsed.result) ||
    parsed.result.protocolVersion !== 1 ||
    parsed.result.requestId !== requestId ||
    typeof parsed.result.replayed !== 'boolean'
  )
    return null;
  const source = parsed.result;
  let result;
  if (source.type === 'mutation.result') {
    if (
      !hasExactKeys(source, [
        'protocolVersion',
        'type',
        'requestId',
        'boardId',
        'replayed',
        'eventIds',
        'result',
      ]) ||
      correlation?.boardId === undefined ||
      source.boardId !== correlation.boardId ||
      !Array.isArray(source.eventIds) ||
      source.eventIds.some((id) => !validGlobalId(id)) ||
      new Set(source.eventIds).size !== source.eventIds.length
    )
      return null;
    const data = projectResultData(expectedType, source.result, correlation);
    if (data === null) return null;
    result = {
      protocolVersion: 1,
      type: 'mutation.result',
      requestId,
      boardId: source.boardId,
      replayed: source.replayed,
      eventIds: [...source.eventIds],
      result: data,
    };
  } else if (source.type === 'board.operation.result') {
    if (!hasExactKeys(source, ['protocolVersion', 'type', 'requestId', 'replayed', 'result']))
      return null;
    const data = projectResultData(expectedType, source.result, correlation);
    if (
      data === null ||
      (!['board.create', 'board.archive'].includes(expectedType) && source.replayed)
    )
      return null;
    result = {
      protocolVersion: 1,
      type: 'board.operation.result',
      requestId,
      replayed: source.replayed,
      result: data,
    };
  } else return null;
  const createdSuccess = [
    'board.create',
    'scene.replace',
    'scene.clear',
    'hitl.request',
    'hitl.respond',
    'artifact.stop',
  ].includes(expectedType);
  if (createdSuccess ? status !== (result.replayed ? 200 : 201) : status !== 200) return null;
  const historyValue = parsed.metadata.history;
  const history = historyValue === null ? null : projectHistoryMetadata(historyValue);
  if (historyValue !== null && history === null) return null;
  if (expectedType === 'history.list') {
    if (
      history === null ||
      history.navigation !== null ||
      history.entries.length !== result.result.entries.length ||
      result.result.entries.some(
        (entry, index) => entry.revision.revisionId !== history.entries[index]?.revisionId,
      )
    )
      return null;
  } else if (expectedType === 'history.get') {
    const revisionId = result.result.entry.revision.revisionId;
    if (
      history === null ||
      history.entries.length !== 1 ||
      history.entries[0]?.revisionId !== revisionId ||
      history.navigation?.revisionId !== revisionId
    )
      return null;
  } else if (history !== null) return null;
  return {
    protocolVersion: 1,
    type: 'board.http.success',
    requestId,
    result,
    metadata: { history },
  };
};
