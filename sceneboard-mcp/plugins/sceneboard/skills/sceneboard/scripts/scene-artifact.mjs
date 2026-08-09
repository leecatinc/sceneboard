#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCENE_ARTIFACT_TEMPLATE_NAMES_V1,
  SceneArtifactError,
  compileSceneArtifactDraft,
  createSceneArtifactPlacement,
  parseSceneArtifactPlacementJson,
  parseSceneArtifactRecipeJson,
  stringifyCanonicalSceneArtifactJson,
  validateSceneArtifactTemplateDescriptor,
} from "./scene-artifact-core.mjs";

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "artifact-templates",
);
const USAGE =
  "Usage:\n  scene-artifact.mjs validate [FILE|-]\n  scene-artifact.mjs compile [FILE|-]\n  scene-artifact.mjs template-list\n  scene-artifact.mjs place [FILE|-]\n  scene-artifact.mjs --help\n";
class CliError extends Error {
  constructor(code, message, path = [], exitCode = 2) {
    super(message);
    this.code = code;
    this.path = path;
    this.exitCode = exitCode;
  }
}
const usage = () => {
  throw new CliError("CLI_USAGE", "Invalid command usage.");
};
const catalogError = () =>
  new CliError(
    "UNSAFE_TEMPLATE_CATALOG",
    "Artifact template catalog is unsafe.",
    ["template"],
  );

const readBoundedStream = async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > 65536) throw new SceneArtifactError("PAYLOAD_TOO_LARGE", []);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};
const readInput = async (path) => {
  if (path === "-") return readBoundedStream();
  if (typeof fsConstants.O_NOFOLLOW !== "number")
    throw new CliError("UNSAFE_INPUT", "Input is not a safe regular file.");
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new CliError("INPUT_NOT_FOUND", "Input file was not found.");
    if (error?.code === "ELOOP")
      throw new CliError("UNSAFE_INPUT", "Input is not a safe regular file.");
    throw new CliError(
      "LOCAL_IO_ERROR",
      "Local input/output operation failed.",
      [],
      1,
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new CliError("UNSAFE_INPUT", "Input is not a safe regular file.");
    if (stat.size > 65536)
      throw new SceneArtifactError("PAYLOAD_TOO_LARGE", []);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const loadCatalog = async () => {
  if (
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    typeof fsConstants.O_DIRECTORY !== "number"
  )
    throw catalogError();
  let directory;
  try {
    directory = await open(
      ROOT,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw catalogError();
  }
  try {
    const anchor = `/proc/self/fd/${directory.fd}`;
    const stat = await directory.stat();
    if (!stat.isDirectory()) throw catalogError();
    const names = (await readdir(anchor)).sort();
    const expected = SCENE_ARTIFACT_TEMPLATE_NAMES_V1.map(
      (name) => `${name}.json`,
    ).sort();
    if (JSON.stringify(names) !== JSON.stringify(expected))
      throw catalogError();
    const descriptors = new Map();
    for (const filename of names) {
      let handle;
      try {
        handle = await open(
          join(anchor, filename),
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
      } catch {
        throw catalogError();
      }
      try {
        const entry = await handle.stat();
        if (!entry.isFile() || entry.size > 4096) throw catalogError();
        const value = validateSceneArtifactTemplateDescriptor(
          JSON.parse((await handle.readFile()).toString("utf8")),
        );
        if (`${value.name}.json` !== filename) throw catalogError();
        descriptors.set(value.name, value);
      } catch {
        throw catalogError();
      } finally {
        await handle.close();
      }
    }
    return descriptors;
  } finally {
    await directory.close();
  }
};

const main = async (args) => {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const command = args[0];
  if (command === "template-list") {
    if (args.length !== 1) usage();
    await loadCatalog();
    process.stdout.write(
      `${stringifyCanonicalSceneArtifactJson({ templates: SCENE_ARTIFACT_TEMPLATE_NAMES_V1 })}\n`,
    );
    return;
  }
  if (
    !["validate", "compile", "place"].includes(command) ||
    args.length > 2 ||
    args[1]?.startsWith("--")
  )
    usage();
  const bytes = await readInput(args[1] ?? "-");
  if (command === "place") {
    process.stdout.write(
      `${stringifyCanonicalSceneArtifactJson(createSceneArtifactPlacement(parseSceneArtifactPlacementJson(bytes)))}\n`,
    );
    return;
  }
  const recipe = parseSceneArtifactRecipeJson(bytes);
  const catalog = await loadCatalog();
  const draft = compileSceneArtifactDraft(recipe, catalog.get(recipe.template));
  const output =
    command === "validate"
      ? {
          ok: true,
          artifactRecipeVersion: 1,
          template: recipe.template,
          motion: recipe.motion,
        }
      : draft;
  process.stdout.write(`${stringifyCanonicalSceneArtifactJson(output)}\n`);
};

try {
  await main(process.argv.slice(2));
} catch (error) {
  const known =
    error instanceof SceneArtifactError || error instanceof CliError;
  const payload = known
    ? {
        ok: false,
        error: { code: error.code, message: error.message, path: error.path },
      }
    : {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "Internal error.", path: [] },
      };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = known ? (error.exitCode ?? 2) : 1;
}
