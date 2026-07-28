import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import ts from 'typescript';
import {
  CertificationError,
  assertExactKeys,
  canonicalJson,
  canonicalJsonSha256,
  containsSecretLikeMaterial,
  readJson,
  resolveInside,
  safeResult,
  sha256,
} from './lib/certification/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = resolve(root, 'test/certification/contract-input-inventory.v1.json');
const manifestPath = resolve(root, 'test/certification/contract-manifest.v1.json');
const goldenManifestPath = resolve(
  root,
  'test/certification/fixtures/contract-manifest/golden.v1.json',
);
const manifestSchemaPath = resolve(root, 'test/certification/contract-manifest.schema.json');
const installedSkillPathPrefix = 'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/';
const installedSkillRoot = resolve(root, installedSkillPathPrefix);
const utf8 = new TextDecoder('utf-8', { fatal: true });

const entryKeys = [
  'id',
  'kind',
  'resources',
  'expectedCardinality',
  'canonicalization',
  'materializationPredecessor',
  'missingOrExtraResult',
];
const resourceKeys = [
  'resourceId',
  'owner',
  'path',
  'exportName',
  'exportKind',
  'projectionId',
  'selector',
];
const manifestKeys = [
  'schemaVersion',
  'evidenceSchemaVersion',
  'inventorySha256',
  'manifestSchemaSha256',
  'nodeNpmPolicy',
  'dependencyPolicy',
  'topology',
  'migrations',
  'toolRegistry',
  'corpus',
  'ownerPublishers',
  'schemaModel',
  'installedSkill',
  'resources',
];
const resultKeys = [
  'key',
  'owner',
  'canonicalPath',
  'exportName',
  'exportKind',
  'selectorSha256',
  'canonicalization',
  'fingerprintSha256',
];
const expectedGroups = new Map([
  ['D1-SCHEMA-ROOT', 24],
  ['D1-FACADES', 3],
  ['D1-CORPUS', 182],
  ['D2-AUTHZ', 8],
  ['D2-HTTP-CONFIG', 4],
  ['D3-PUBLISHER', 2],
  ['D3-PERSISTENCE', 10],
  ['D3-BOARD-SEAMS', 20],
  ['D4-SEAMS', 10],
  ['D2-D5-D7-D8-BROWSER-PUBLISHERS', 9],
  ['D5-BROWSER-API-SEAMS', 24],
  ['D5-UI-ROUTES', 11],
  ['D6-MCP-SDK', 10],
  ['D6-INSTALLED-SKILL', 42],
  ['D7-ARTIFACT-SEAM', 7],
  ['D8-HITL-SEAM', 6],
  ['MIGRATION-REGISTRY-ASSETS', 20],
  ['D2-MIGRATION-RUNNER', 5],
  ['RUNTIME-TOPOLOGY', 3],
  ['DEPENDENCY-EVIDENCE', 11],
  ['SCHEMA-MODEL-EVIDENCE', 7],
]);
const terminalToolNames = [
  'board_connection_status',
  'board_pair_request',
  'board_pair_status',
  'board_list',
  'board_get',
  'board_create',
  'board_archive',
  'board_capabilities_get',
  'board_scene_get',
  'board_scene_replace',
  'board_scene_patch',
  'board_scene_clear',
  'board_document_get',
  'board_document_replace',
  'board_page_add',
  'board_page_remove',
  'board_page_reorder',
  'board_page_update',
  'board_page_default_set',
  'board_artifact_get',
  'board_artifact_put',
  'board_artifact_stop',
  'board_history_list',
  'board_history_get',
  'board_history_restore',
  'board_interaction_request',
  'board_interaction_status',
  'board_interaction_respond',
];

const fail = (code, message = code) => {
  throw new CertificationError(code, message);
};
const equal = (left, right, code) => {
  if (canonicalJson(left) !== canonicalJson(right)) fail(code);
};
const lfText = (bytes) => {
  let value;
  try {
    value = utf8.decode(bytes);
  } catch {
    fail('CONTRACT_INPUT_DRIFT');
  }
  if (value.startsWith('\uFEFF') || /\r(?!\n)/u.test(value)) fail('CONTRACT_INPUT_DRIFT');
  return value.replaceAll('\r\n', '\n');
};
const compactSpace = (value) => value.replace(/\s+/gu, ' ').trim();
const isExported = (node) =>
  node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
const nameText = (node) => (node.name && ts.isIdentifier(node.name) ? node.name.text : null);

const canonicalResourcePath = async (inputPath) => {
  let absolute;
  let canonicalPath;
  if (inputPath.startsWith(`${installedSkillRoot}/`)) {
    if (inputPath.includes('\\') || resolve(inputPath) !== inputPath) fail('CONTRACT_PATH_ALIAS');
    absolute = inputPath;
    canonicalPath = inputPath;
  } else {
    if (
      inputPath.includes('\\') ||
      inputPath.includes('*') ||
      inputPath.includes('?') ||
      inputPath.includes('{') ||
      inputPath.includes('}')
    ) {
      fail('CONTRACT_PATH_ALIAS');
    }
    absolute = resolveInside(root, inputPath, 'CONTRACT_PATH_ALIAS');
    canonicalPath = relative(root, absolute).split(sep).join('/');
    if (canonicalPath !== inputPath) fail('CONTRACT_PATH_ALIAS');
  }
  let actual;
  try {
    const metadata = await stat(absolute);
    if (!metadata.isFile()) fail('CONTRACT_INPUT_DRIFT');
    actual = await realpath(absolute);
  } catch (error) {
    if (error instanceof CertificationError) throw error;
    fail('CONTRACT_INPUT_DRIFT');
  }
  if (actual !== absolute) fail('CONTRACT_PATH_ALIAS');
  return { absolute, canonicalPath };
};

const astProjection = (text, resource) => {
  const source = ts.createSourceFile(
    resource.path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  if (source.parseDiagnostics.length > 0) fail('CONTRACT_SELECTOR_INVALID');
  const classMethod =
    /^ClassDeclaration\[name=([A-Za-z_$][\w$]*)\]\/MethodDeclaration\[name=([A-Za-z_$][\w$]*)\]$/u.exec(
      resource.selector,
    );
  if (classMethod) {
    if (
      resource.exportKind !== 'class' ||
      resource.exportName !== classMethod[1] ||
      resource.projectionId === null
    ) {
      fail('CONTRACT_SELECTOR_INVALID');
    }
    const classes = source.statements.filter(
      (node) =>
        ts.isClassDeclaration(node) && nameText(node) === classMethod[1] && isExported(node),
    );
    if (classes.length !== 1) fail('CONTRACT_SELECTOR_INVALID');
    const methods = classes[0].members.filter(
      (node) => ts.isMethodDeclaration(node) && nameText(node) === classMethod[2],
    );
    if (methods.length !== 1 || !methods[0].body) fail('CONTRACT_SELECTOR_INVALID');
    const method = methods[0];
    const signature = compactSpace(
      text.slice(method.getStart(source), method.body.getStart(source)),
    );
    return {
      range: [method.getStart(source), method.end],
      fingerprint: canonicalJsonSha256({
        selector: resource.selector,
        exportName: resource.exportName,
        exportKind: resource.exportKind,
        signature,
      }),
      signature,
    };
  }
  const named = /^(type|interface) ([A-Za-z_$][\w$]*)$/u.exec(resource.selector);
  if (named) {
    if (
      resource.exportKind !== named[1] ||
      resource.exportName !== named[2] ||
      resource.projectionId !== null
    ) {
      fail('CONTRACT_SELECTOR_INVALID');
    }
    const nodes = source.statements.filter((node) => {
      if (named[1] === 'type' && !ts.isTypeAliasDeclaration(node)) return false;
      if (named[1] === 'interface' && !ts.isInterfaceDeclaration(node)) return false;
      return nameText(node) === named[2] && isExported(node);
    });
    if (nodes.length !== 1) fail('CONTRACT_SELECTOR_INVALID');
    const node = nodes[0];
    return {
      range: [node.getStart(source), node.end],
      fingerprint: canonicalJsonSha256({
        selector: resource.selector,
        exportName: resource.exportName,
        exportKind: resource.exportKind,
        declaration: compactSpace(text.slice(node.getStart(source), node.end)),
      }),
      signature: null,
    };
  }
  fail('CONTRACT_SELECTOR_INVALID');
};

const observeResource = async (entry, resource) => {
  const { absolute, canonicalPath } = await canonicalResourcePath(resource.path);
  const bytes = await readFile(absolute);
  const text = lfText(bytes);
  let fingerprintSha256;
  let range = null;
  let signature = null;
  if (resource.selector === 'whole-file') {
    if (
      resource.exportName !== null ||
      resource.exportKind !== null ||
      resource.projectionId !== null
    ) {
      fail('CONTRACT_SELECTOR_INVALID');
    }
    if (entry.canonicalization === 'canonical-json' && extname(resource.path) === '.json') {
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        fail('CONTRACT_INPUT_DRIFT');
      }
      fingerprintSha256 = canonicalJsonSha256(value);
    } else {
      fingerprintSha256 = sha256(text);
    }
  } else {
    const projection = astProjection(text, resource);
    fingerprintSha256 = projection.fingerprint;
    range = projection.range;
    signature = projection.signature;
  }
  if (
    (resource.path === `${installedSkillPathPrefix}SKILL.md` ||
      resource.path.startsWith(installedSkillPathPrefix)) &&
    containsSecretLikeMaterial(text)
  ) {
    fail('INSTALLED_SKILL_SECRET_MATERIAL');
  }
  const selectorSha256 = sha256(resource.selector);
  const key = canonicalJson([
    canonicalPath,
    resource.exportName,
    resource.exportKind,
    selectorSha256,
    entry.canonicalization,
  ]);
  return {
    resourceId: resource.resourceId,
    entryId: entry.id,
    projectionId: resource.projectionId,
    selector: resource.selector,
    signature,
    range,
    result: {
      key,
      owner: resource.owner,
      canonicalPath,
      exportName: resource.exportName,
      exportKind: resource.exportKind,
      selectorSha256,
      canonicalization: entry.canonicalization,
      fingerprintSha256,
    },
  };
};

const validateInventoryShape = (inventory) => {
  assertExactKeys(inventory, ['schemaVersion', 'entries'], 'CONTRACT_INVENTORY_SCHEMA_INVALID');
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.entries))
    fail('CONTRACT_INVENTORY_SCHEMA_INVALID');
  if (inventory.entries.length !== expectedGroups.size) fail('CONTRACT_INPUT_DRIFT');
  const entryIds = new Set();
  const resourceIds = new Set();
  for (const [index, entry] of inventory.entries.entries()) {
    assertExactKeys(entry, entryKeys, 'CONTRACT_INVENTORY_SCHEMA_INVALID');
    if (
      typeof entry.id !== 'string' ||
      entryIds.has(entry.id) ||
      expectedGroups.get(entry.id) !== entry.expectedCardinality ||
      !Array.isArray(entry.resources) ||
      entry.resources.length !== entry.expectedCardinality ||
      !['utf8-lf', 'canonical-json', 'typescript-ast'].includes(entry.canonicalization) ||
      entry.missingOrExtraResult !== 'CONTRACT_INPUT_DRIFT'
    ) {
      fail('CONTRACT_INPUT_DRIFT');
    }
    if (
      entry.materializationPredecessor !== null &&
      (typeof entry.materializationPredecessor !== 'string' ||
        !inventory.entries
          .slice(0, index)
          .some(({ id }) => id === entry.materializationPredecessor))
    ) {
      fail('CONTRACT_PREDECESSOR_INVALID');
    }
    entryIds.add(entry.id);
    for (const resource of entry.resources) {
      assertExactKeys(resource, resourceKeys, 'CONTRACT_INVENTORY_SCHEMA_INVALID');
      if (
        typeof resource.resourceId !== 'string' ||
        resourceIds.has(resource.resourceId) ||
        !/^D[1-9]$/u.test(resource.owner) ||
        typeof resource.path !== 'string' ||
        ![null, 'type', 'interface', 'class'].includes(resource.exportKind) ||
        !(resource.exportName === null || typeof resource.exportName === 'string') ||
        !(resource.projectionId === null || typeof resource.projectionId === 'string') ||
        typeof resource.selector !== 'string'
      ) {
        fail('CONTRACT_INVENTORY_SCHEMA_INVALID');
      }
      resourceIds.add(resource.resourceId);
    }
  }
  equal([...entryIds], [...expectedGroups.keys()], 'CONTRACT_INPUT_DRIFT');
};

const collectInstalledSkillPaths = async (directory = installedSkillRoot) => {
  const paths = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  )) {
    const absolute = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) fail('CONTRACT_PATH_ALIAS');
    if (entry.isDirectory()) paths.push(...(await collectInstalledSkillPaths(absolute)));
    else if (entry.isFile()) paths.push(relative(root, absolute).split(sep).join('/'));
    else fail('CONTRACT_INPUT_DRIFT');
  }
  return paths;
};

const validateInstalledSkillClosure = async (inventory) => {
  const entry = inventory.entries.find(({ id }) => id === 'D6-INSTALLED-SKILL');
  if (entry === undefined) fail('CONTRACT_INPUT_DRIFT');
  const expected = entry.resources
    .map(({ path }) => path)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const actual = (await collectInstalledSkillPaths()).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  equal(actual, expected, 'CONTRACT_INPUT_DRIFT');
};

const validateNoOverlap = (observed) => {
  const keys = new Set();
  const selectorAliases = new Set();
  const byPath = new Map();
  for (const item of observed) {
    if (keys.has(item.result.key)) fail('CONTRACT_GLOBAL_KEY_DUPLICATE');
    keys.add(item.result.key);
    const alias = `${item.result.canonicalPath}\0${item.result.selectorSha256}`;
    if (selectorAliases.has(alias)) fail('CONTRACT_SELECTOR_ALIAS');
    selectorAliases.add(alias);
    const siblings = byPath.get(item.result.canonicalPath) ?? [];
    siblings.push(item);
    byPath.set(item.result.canonicalPath, siblings);
  }
  for (const siblings of byPath.values()) {
    const whole = siblings.filter(({ selector }) => selector === 'whole-file');
    if (whole.length > 0 && siblings.length > 1) fail('CONTRACT_WHOLE_FILE_PROJECTION_OVERLAP');
    const ranged = siblings
      .filter(({ range }) => range !== null)
      .sort((a, b) => a.range[0] - b.range[0]);
    for (let index = 1; index < ranged.length; index += 1) {
      if (ranged[index].range[0] < ranged[index - 1].range[1]) fail('CONTRACT_PROJECTION_OVERLAP');
    }
  }
};

const parsePublisher = async (path) => {
  const { bytes, value } = await readJson(resolve(root, path));
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'owner',
      'resourcePath',
      'publisherTestPath',
      'contractIds',
      'selectors',
      'tupleListSha256',
    ],
    'CONTRACT_OWNER_PUBLISHER_STALE',
  );
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.contractIds) ||
    !Array.isArray(value.selectors) ||
    value.tupleListSha256 !== canonicalJsonSha256(value.selectors)
  ) {
    fail('CONTRACT_OWNER_PUBLISHER_STALE');
  }
  return { path, bytes, value };
};

const validatePublishers = async (observedById) => {
  const descriptors = [
    ['D2', 'sceneboard-fe/test/contracts/certification-handoffs/d2-board-api-tuples.v1.json'],
    ['D5', 'sceneboard-fe/test/contracts/certification-handoffs/d5-board-api-tuples.v1.json'],
    ['D7', 'sceneboard-fe/test/contracts/certification-handoffs/d7-board-api-tuples.v1.json'],
    ['D8', 'sceneboard-fe/test/contracts/certification-handoffs/d8-board-api-tuples.v1.json'],
    ['D3', 'sceneboard-be/test/contracts/certification-handoffs/d3-application-seams.v1.json'],
  ];
  const publishers = [];
  const publisherValues = [];
  const observedItems = [...observedById.values()];
  for (const [owner, path] of descriptors) {
    if (!existsSync(resolve(root, path))) fail('CONTRACT_OWNER_PUBLISHER_MISSING');
    const publisher = await parsePublisher(path);
    const publishedInput = observedItems.find(
      (item) => item.result.canonicalPath === path && item.selector === 'whole-file',
    );
    const publishedTest = observedItems.find(
      (item) =>
        item.result.canonicalPath === publisher.value.publisherTestPath &&
        item.selector === 'whole-file',
    );
    if (!publishedInput || !publishedTest) fail('CONTRACT_OWNER_PUBLISHER_MISSING');
    if (
      publisher.value.owner !== owner ||
      new Set(publisher.value.contractIds).size !== publisher.value.contractIds.length
    ) {
      fail('CONTRACT_OWNER_PUBLISHER_STALE');
    }
    for (const selector of publisher.value.selectors) {
      const expectedKeys =
        owner === 'D3'
          ? [
              'projectionId',
              'sourcePath',
              'exportName',
              'exportKind',
              'memberName',
              'memberKind',
              'signature',
              'selector',
              'contractIds',
            ]
          : [
              'projectionId',
              'exportName',
              'exportKind',
              'memberName',
              'memberKind',
              'signature',
              'selector',
              'contractId',
            ];
      assertExactKeys(selector, expectedKeys, 'CONTRACT_OWNER_PUBLISHER_STALE');
      const observed = observedById.get(selector.projectionId);
      const sourcePath = owner === 'D3' ? selector.sourcePath : publisher.value.resourcePath;
      if (
        !observed ||
        observed.result.owner !== owner ||
        observed.result.canonicalPath !== sourcePath ||
        observed.selector !== selector.selector ||
        observed.signature !== selector.signature ||
        observed.result.exportName !== selector.exportName ||
        observed.result.exportKind !== selector.exportKind
      ) {
        fail('CONTRACT_OWNER_PUBLISHER_STALE');
      }
    }
    publishers.push({
      owner,
      publisherPath: path,
      publisherSha256: sha256(publisher.bytes),
      tupleListSha256: publisher.value.tupleListSha256,
      contractIds: publisher.value.contractIds,
      selectorCount: publisher.value.selectors.length,
    });
    publisherValues.push(publisher.value);
  }
  const browser = publishers.filter(({ owner }) => owner !== 'D3');
  if (browser.reduce((count, publisher) => count + publisher.selectorCount, 0) !== 24)
    fail('CONTRACT_OWNER_PUBLISHER_STALE');
  const browserNames = (
    await Promise.all(
      descriptors.slice(0, 4).map(async ([, path]) => (await parsePublisher(path)).value),
    )
  ).flatMap(({ selectors }) => selectors.map(({ memberName }) => memberName));
  equal(
    browserNames,
    [
      'listActivePairings',
      'listGrants',
      'createPairing',
      'decidePairing',
      'cancelPairing',
      'revokeGrant',
      'rotateGrant',
      'listBoards',
      'createBoard',
      'getBoard',
      'archiveBoard',
      'renameBoard',
      'listHistory',
      'getHistoryRevision',
      'replaceDocument',
      'transformDocument',
      'getArtifact',
      'getArtifactPackage',
      'requestArtifactNetworkFetch',
      'requestInteraction',
      'respondToInteraction',
      'readInteraction',
      'cancelInteraction',
      'supersedeInteraction',
    ],
    'CONTRACT_OWNER_PUBLISHER_STALE',
  );
  const browserSource = lfText(await readFile(resolve(root, 'sceneboard-fe/lib/api/board-api.ts')));
  const browserAst = ts.createSourceFile(
    'board-api.ts',
    browserSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const browserClass = browserAst.statements.find(
    (node) => ts.isClassDeclaration(node) && nameText(node) === 'BoardApiClient',
  );
  if (!browserClass) fail('CONTRACT_OWNER_PUBLISHER_STALE');
  const publicBrowserMethods = browserClass.members
    .filter(
      (node) =>
        ts.isMethodDeclaration(node) &&
        !ts.isPrivateIdentifier(node.name) &&
        !node.modifiers?.some((modifier) =>
          [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(modifier.kind),
        ),
    )
    .map(nameText);
  equal(
    [...publicBrowserMethods].sort(),
    [...browserNames].sort(),
    'CONTRACT_OWNER_PUBLISHER_STALE',
  );
  const d3 = publisherValues.find(({ owner }) => owner === 'D3');
  const d3ByPath = new Map();
  for (const selector of d3.selectors) {
    const names = d3ByPath.get(selector.sourcePath) ?? [];
    names.push(selector.memberName);
    d3ByPath.set(selector.sourcePath, names);
  }
  if (d3ByPath.size !== 9 || d3.selectors.length !== 20) fail('CONTRACT_OWNER_PUBLISHER_STALE');
  for (const [path, memberNames] of d3ByPath) {
    const source = lfText(await readFile(resolve(root, path)));
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const className = d3.selectors.find((selector) => selector.sourcePath === path)?.exportName;
    const declaration = ast.statements.find(
      (node) => ts.isClassDeclaration(node) && nameText(node) === className,
    );
    if (!declaration) fail('CONTRACT_OWNER_PUBLISHER_STALE');
    const publicMethods = declaration.members
      .filter(
        (node) =>
          ts.isMethodDeclaration(node) &&
          !ts.isPrivateIdentifier(node.name) &&
          !node.modifiers?.some((modifier) =>
            [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(modifier.kind),
          ),
      )
      .map(nameText);
    equal(publicMethods, memberNames, 'CONTRACT_OWNER_PUBLISHER_STALE');
  }
  return publishers;
};

const stringArrayInitializer = (source, variableName) => {
  const file = ts.createSourceFile(
    'registry.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (nameText(declaration) !== variableName || !declaration.initializer) continue;
      let initializer = declaration.initializer;
      while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))
        initializer = initializer.expression;
      if (!ts.isArrayLiteralExpression(initializer)) fail('TOOL_REGISTRY_DRIFT');
      return initializer.elements.map((element) => {
        if (!ts.isStringLiteral(element)) fail('TOOL_REGISTRY_DRIFT');
        return element.text;
      });
    }
  }
  fail('TOOL_REGISTRY_DRIFT');
};

const observeToolRegistry = async () => {
  const source = lfText(
    await readFile(resolve(root, 'sceneboard-mcp/src/tools/register-tools.ts')),
  );
  const core = stringArrayInitializer(source, 'CORE_TOOL_NAMES_V1');
  const downstream = stringArrayInitializer(source, 'DOWNSTREAM_TOOL_NAMES_V1');
  const registered = [...source.matchAll(/\badd\(\s*'([^']+)'/gu)].map((match) => match[1]);
  equal(core.slice(0, 3), terminalToolNames.slice(0, 3), 'TOOL_REGISTRY_DRIFT');
  equal(
    core,
    [...terminalToolNames.slice(0, 19), ...terminalToolNames.slice(22, 25)],
    'TOOL_REGISTRY_DRIFT',
  );
  equal(
    downstream,
    [...terminalToolNames.slice(19, 22), ...terminalToolNames.slice(25)],
    'TOOL_REGISTRY_DRIFT',
  );
  equal(registered, terminalToolNames, 'TOOL_REGISTRY_DRIFT');
  return { preAuthCount: 3, coreCount: 22, finalCount: 28, terminalNames: terminalToolNames };
};

const observeMigrations = async (observedById) => {
  const source = lfText(
    await readFile(resolve(root, 'sceneboard-be/src/database/migrations/registry.ts')),
  );
  const versions = [...source.matchAll(/\bversion: '([^']+)'/gu)].map((match) => match[1]);
  const upAssets = [...source.matchAll(/\bupAsset: '([^']+)'/gu)].map((match) => match[1]);
  const downAssets = [...source.matchAll(/\bdownAsset: '([^']+)'/gu)].map((match) => match[1]);
  if (versions.length !== 16 || upAssets.length !== 16 || downAssets.length !== 3)
    fail('MIGRATION_REGISTRY_DRIFT');
  const assets = [...observedById.values()].filter(({ resourceId }) =>
    resourceId.startsWith('MIGRATION-ASSET-'),
  );
  const names = assets.map(({ result }) => result.canonicalPath.split('/').at(-1));
  equal([...upAssets, ...downAssets].sort(), names.sort(), 'MIGRATION_REGISTRY_DRIFT');
  return {
    entryCount: versions.length,
    sqlAssetCount: assets.length,
    versions,
    registrySha256: observedById.get('MIGRATION-REGISTRY')?.result.fingerprintSha256,
    assetSetSha256: canonicalJsonSha256(
      assets.map(({ result }) => ({
        path: result.canonicalPath,
        sha256: result.fingerprintSha256,
      })),
    ),
  };
};

const parseEnv = (text) =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const offset = line.indexOf('=');
        return [line.slice(0, offset), line.slice(offset + 1)];
      }),
  );

const observeTopology = async () => {
  const frontend = parseEnv(lfText(await readFile(resolve(root, 'sceneboard-fe/.env.example'))));
  const backend = parseEnv(lfText(await readFile(resolve(root, 'sceneboard-be/.env.example'))));
  const runtime = parseEnv(
    lfText(await readFile(resolve(root, 'packages/artifact-runtime/.env.example'))),
  );
  const topology = {
    appOrigin: backend.BOARD_ALLOWED_ORIGINS,
    apiOrigin: backend.BOARD_PUBLIC_API_ORIGIN,
    artifactRuntimeOrigin: runtime.ARTIFACT_RUNTIME_ORIGIN,
    mcpTransport: 'stdio',
    mysqlDatabase: backend.MYSQL_DATABASE,
    redisKeyPrefix: backend.REDIS_KEY_PREFIX,
    listeners: [
      { owner: 'D5', origin: backend.BOARD_ALLOWED_ORIGINS },
      { owner: 'D2', origin: backend.BOARD_PUBLIC_API_ORIGIN },
      { owner: 'D7', origin: runtime.ARTIFACT_RUNTIME_ORIGIN },
    ],
    writers: [
      { owner: 'D2', resource: 'mysql-migration-runner' },
      { owner: 'D3', resource: 'board-transaction' },
      { owner: 'D9', resource: 'certification-evidence' },
    ],
  };
  equal(
    [
      frontend.NEXT_PUBLIC_BOARD_API_URL,
      frontend.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN,
      runtime.ARTIFACT_RUNTIME_APP_ORIGIN,
      runtime.ARTIFACT_RUNTIME_API_ORIGIN,
      runtime.ARTIFACT_RUNTIME_ORIGIN,
      runtime.ARTIFACT_RUNTIME_LISTEN_HOST,
    ],
    [
      'http://127.0.0.1:3411',
      'http://127.0.0.2:3412',
      'http://127.0.0.1:3410',
      'http://127.0.0.1:3411',
      'http://127.0.0.2:3412',
      '127.0.0.2',
    ],
    'RUNTIME_TOPOLOGY_DRIFT',
  );
  equal(
    [topology.appOrigin, topology.apiOrigin, topology.artifactRuntimeOrigin],
    ['http://127.0.0.1:3410', 'http://127.0.0.1:3411', 'http://127.0.0.2:3412'],
    'RUNTIME_TOPOLOGY_DRIFT',
  );
  if (existsSync(resolve(root, 'test/certification/service-topology.v1.json')))
    fail('SECOND_TOPOLOGY_AUTHORITY');
  return topology;
};

const aggregateForEntry = (observed, entryId) =>
  canonicalJsonSha256(
    observed
      .filter((item) => item.entryId === entryId)
      .map(({ result }) => ({
        key: result.key,
        owner: result.owner,
        sha256: result.fingerprintSha256,
      })),
  );

export const observeContractInventory = async ({ inventoryValue, inventoryBytes } = {}) => {
  let inventory = inventoryValue;
  let bytes = inventoryBytes;
  if (!inventory) ({ value: inventory, bytes } = await readJson(inventoryPath));
  if (!bytes) bytes = Buffer.from(`${canonicalJson(inventory)}\n`);
  validateInventoryShape(inventory);
  await validateInstalledSkillClosure(inventory);
  const observed = [];
  for (const entry of inventory.entries) {
    for (const resource of entry.resources) observed.push(await observeResource(entry, resource));
  }
  validateNoOverlap(observed);
  const observedById = new Map(observed.map((item) => [item.resourceId, item]));
  const ownerPublishers = await validatePublishers(observedById);
  const dependencyInventory = await readJson(
    resolve(root, 'test/certification/dependency-inventory.v1.json'),
  );
  const lockfileBytes = await readFile(resolve(root, 'package-lock.json'));
  const schemaProjectionIds = [
    'SCHEMA-PROJECTION-02',
    'SCHEMA-PROJECTION-03',
    'SCHEMA-PROJECTION-04',
    'SCHEMA-PROJECTION-05',
    'SCHEMA-PROJECTION-06',
  ];
  const schemaModel = {
    contractSha256: observedById.get('SCHEMA-PROJECTION-01')?.result.fingerprintSha256,
    aggregateTestSha256: observedById.get('SCHEMA-PROJECTION-AGGREGATE-TEST')?.result
      .fingerprintSha256,
    ownerProjections: schemaProjectionIds.map((resourceId) => ({
      owner: observedById.get(resourceId)?.result.owner,
      sha256: observedById.get(resourceId)?.result.fingerprintSha256,
    })),
  };
  schemaModel.aggregateSha256 = canonicalJsonSha256(schemaModel.ownerProjections);
  const resources = observed
    .map(({ result }) => result)
    .sort((left, right) => left.key.localeCompare(right.key, 'en'));
  return {
    schemaVersion: 1,
    evidenceSchemaVersion: 1,
    inventorySha256: sha256(bytes),
    manifestSchemaSha256: sha256(await readFile(manifestSchemaPath)),
    nodeNpmPolicy: { node: '>=22', npm: '10.9.3' },
    dependencyPolicy: {
      registryHost: 'registry.npmjs.org',
      lockfileSha256: sha256(lockfileBytes),
      inventorySha256: sha256(dependencyInventory.bytes),
      dependencyCount: dependencyInventory.value.entries.length,
    },
    topology: await observeTopology(),
    migrations: await observeMigrations(observedById),
    toolRegistry: await observeToolRegistry(),
    corpus: {
      fixtureCount: expectedGroups.get('D1-CORPUS') - 1,
      catalogSha256: observedById.get('D1-CORPUS-001')?.result.fingerprintSha256,
      aggregateSha256: aggregateForEntry(observed, 'D1-CORPUS'),
    },
    ownerPublishers,
    schemaModel,
    installedSkill: {
      fileCount: expectedGroups.get('D6-INSTALLED-SKILL'),
      aggregateSha256: aggregateForEntry(observed, 'D6-INSTALLED-SKILL'),
    },
    resources,
  };
};

export const validateManifestShape = (manifest) => {
  if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
    if ('manifestSha256' in manifest) fail('CONTRACT_MANIFEST_SELF_REFERENCE');
    if (
      'certificationSourceCommit' in manifest ||
      'attemptId' in manifest ||
      'laneId' in manifest ||
      'observedInputHashes' in manifest ||
      'observedEvidenceHashes' in manifest
    ) {
      fail('CONTRACT_RUNTIME_FIELD_MISPLACED');
    }
  }
  assertExactKeys(manifest, manifestKeys, 'CONTRACT_MANIFEST_SCHEMA_INVALID');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.evidenceSchemaVersion !== 1 ||
    !Array.isArray(manifest.resources) ||
    !Array.isArray(manifest.ownerPublishers)
  ) {
    fail('CONTRACT_MANIFEST_SCHEMA_INVALID');
  }
  for (const result of manifest.resources)
    assertExactKeys(result, resultKeys, 'CONTRACT_MANIFEST_SCHEMA_INVALID');
};

export const verifyContractManifest = async ({
  manifestValue,
  manifestBytes,
  inventoryValue,
  inventoryBytes,
} = {}) => {
  let manifest = manifestValue;
  let bytes = manifestBytes;
  if (!manifest) ({ value: manifest, bytes } = await readJson(manifestPath));
  if (!bytes) bytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  validateManifestShape(manifest);
  const canonicalBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  if (!Buffer.from(bytes).equals(canonicalBytes)) fail('CONTRACT_MANIFEST_NON_CANONICAL');
  const observed = await observeContractInventory({ inventoryValue, inventoryBytes });
  equal(manifest, observed, 'CONTRACT_MANIFEST_DRIFT');
  return safeResult('PASS', {
    manifestSha256: sha256(canonicalBytes),
    inventorySha256: manifest.inventorySha256,
    ownerCount: new Set(manifest.resources.map(({ owner }) => owner)).size,
    resourceCount: manifest.resources.length,
    migrationCount: manifest.migrations.entryCount,
    sqlAssetCount: manifest.migrations.sqlAssetCount,
    finalToolCount: manifest.toolRegistry.finalCount,
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2);
    const observe = arguments_.includes('--observe');
    const write = arguments_.includes('--write');
    if (
      arguments_.some((argument) => !['--observe', '--write'].includes(argument)) ||
      (observe && write) ||
      arguments_.length > 1
    )
      fail('CONTRACT_MANIFEST_ARGUMENT_INVALID');
    if (observe) {
      process.stdout.write(`${canonicalJson(await observeContractInventory())}\n`);
    } else if (write) {
      const observed = await observeContractInventory();
      const canonicalBytes = `${canonicalJson(observed)}\n`;
      await writeFile(manifestPath, canonicalBytes, { mode: 0o644 });
      await writeFile(goldenManifestPath, canonicalBytes, { mode: 0o644 });
      process.stdout.write(
        `${JSON.stringify(
          safeResult('UPDATED', {
            manifestSha256: sha256(Buffer.from(canonicalBytes)),
            resourceCount: observed.resources.length,
          }),
        )}\n`,
      );
    } else {
      process.stdout.write(`${JSON.stringify(await verifyContractManifest())}\n`);
    }
  } catch (error) {
    const code = error instanceof CertificationError ? error.code : 'CONTRACT_CERTIFICATION_FAILED';
    process.stdout.write(`${JSON.stringify(safeResult('FAIL', { reason: code }))}\n`);
    process.exitCode = 1;
  }
}
