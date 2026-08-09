#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SceneRecipeError,
  compileSceneRecipe,
  compileSceneRecipeReplaceInput,
  parseSceneRecipeJson,
  stringifyCanonicalSceneRecipeJson,
} from "./scene-recipe-core.mjs";

const MAX_BYTES = 1_048_576;
const PRESET_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "visual-presets",
);
const USAGE = `Usage:
  scene-recipe.mjs validate [FILE|-]
  scene-recipe.mjs compile [FILE|-] [--output scene|scene-replace-input]
    [--board-id ID --expected-revision-id ID --idempotency-key KEY]
  scene-recipe.mjs preset-list
  scene-recipe.mjs preset-compile NAME [--output scene|scene-replace-input]
    [--board-id ID --expected-revision-id ID --idempotency-key KEY]
  scene-recipe.mjs --help
`;

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
const readHandle = async (handle) => {
  const stat = await handle.stat();
  if (!stat.isFile())
    throw new CliError(
      "UNSAFE_PRESET",
      "Preset entry is not a safe regular file.",
      ["preset"],
    );
  if (stat.size > MAX_BYTES)
    throw new SceneRecipeError("PAYLOAD_TOO_LARGE", []);
  const buffer = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
};

const readStream = async () => {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BYTES) throw new SceneRecipeError("PAYLOAD_TOO_LARGE", []);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const openSafe = async (path, preset = false) => {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    if (preset)
      throw new CliError(
        "UNSAFE_PRESET",
        "Preset entry is not a safe regular file.",
        ["preset"],
      );
    throw new CliError(
      "LOCAL_IO_ERROR",
      "Local input/output operation failed.",
      [],
      1,
    );
  }
  try {
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      return await readHandle(handle);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof CliError || error instanceof SceneRecipeError)
      throw error;
    if (error?.code === "ENOENT")
      throw new CliError(
        preset ? "PRESET_NOT_FOUND" : "INPUT_NOT_FOUND",
        preset ? "Preset was not found." : "Input file was not found.",
        preset ? ["preset"] : [],
      );
    if (error?.code === "ELOOP" && preset)
      throw new CliError(
        "UNSAFE_PRESET",
        "Preset entry is not a safe regular file.",
        ["preset"],
      );
    throw new CliError(
      "LOCAL_IO_ERROR",
      "Local input/output operation failed.",
      [],
      1,
    );
  }
};

const parseFlags = (args, positionalMax) => {
  const values = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const names = {
      "--output": "output",
      "--board-id": "boardId",
      "--expected-revision-id": "expectedRevisionId",
      "--idempotency-key": "idempotencyKey",
    };
    const name = names[arg];
    if (
      !name ||
      values[name] !== undefined ||
      index + 1 >= args.length ||
      args[index + 1].startsWith("--")
    )
      usage();
    values[name] = args[++index];
  }
  if (positional.length > positionalMax) usage();
  values.output ??= "scene";
  if (!["scene", "scene-replace-input"].includes(values.output)) usage();
  const bindingCount = [
    "boardId",
    "expectedRevisionId",
    "idempotencyKey",
  ].filter((name) => values[name] !== undefined).length;
  if (
    (values.output === "scene" && bindingCount !== 0) ||
    (values.output === "scene-replace-input" && bindingCount !== 3)
  )
    usage();
  return { values, positional };
};

const outputFor = (recipe, values) => {
  if (values.output === "scene") return compileSceneRecipe(recipe);
  const { boardId, expectedRevisionId, idempotencyKey } = values;
  return compileSceneRecipeReplaceInput(recipe, {
    boardId,
    expectedRevisionId,
    idempotencyKey,
  });
};

const listPresets = async () => {
  const names = [];
  let directory;
  try {
    directory = await opendir(PRESET_DIR);
  } catch (error) {
    if (error?.code === "ENOENT") return names;
    throw new CliError(
      "LOCAL_IO_ERROR",
      "Local input/output operation failed.",
      [],
      1,
    );
  }
  for await (const entry of directory) {
    if (entry.isFile() && /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(entry.name))
      names.push(entry.name.slice(0, -5));
  }
  return names.sort();
};

const main = async (args) => {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const command = args[0];
  if (command === "preset-list") {
    if (args.length !== 1) usage();
    process.stdout.write(
      `${stringifyCanonicalSceneRecipeJson({ presets: await listPresets() })}\n`,
    );
    return;
  }
  if (command === "validate" || command === "compile") {
    const { values, positional } = parseFlags(args.slice(1), 1);
    if (
      command === "validate" &&
      (values.output !== "scene" || Object.keys(values).length !== 1)
    )
      usage();
    const file = positional[0] ?? "-";
    const recipe = parseSceneRecipeJson(
      file === "-" ? await readStream() : await openSafe(file),
    );
    const scene = compileSceneRecipe(recipe);
    if (command === "validate") {
      let nodeCount = 0;
      const visit = (node) => {
        if (!node) return;
        nodeCount += 1;
        if (node.children) node.children.forEach((item) => visit(item.node));
        if (node.tabs) node.tabs.forEach((item) => visit(item.node));
      };
      visit(scene.root);
      process.stdout.write(
        `${stringifyCanonicalSceneRecipeJson({ ok: true, recipeVersion: 1, nodeCount })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${stringifyCanonicalSceneRecipeJson(outputFor(recipe, values))}\n`,
    );
    return;
  }
  if (command === "preset-compile") {
    const { values, positional } = parseFlags(args.slice(1), 1);
    const name = positional[0];
    if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) usage();
    const recipe = parseSceneRecipeJson(
      await openSafe(join(PRESET_DIR, `${name}.json`), true),
    );
    process.stdout.write(
      `${stringifyCanonicalSceneRecipeJson(outputFor(recipe, values))}\n`,
    );
    return;
  }
  usage();
};

try {
  await main(process.argv.slice(2));
} catch (error) {
  const known = error instanceof SceneRecipeError || error instanceof CliError;
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
