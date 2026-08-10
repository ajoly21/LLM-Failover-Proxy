/**
 * The default catalogue: which providers and which models a fresh install
 * starts with, in failover order.
 *
 * It lives in `defaults/catalog.json` rather than in this file so it can be
 * reviewed, edited and diffed without touching code. `defaults/` sits next to
 * `src/` and next to `dist/`, so the same relative path works when running from
 * source and from the published bundle.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { newId } from "./config.js";
import { envValue } from "./env.js";

export const CATALOG_FILE = fileURLToPath(new URL("../defaults/catalog.json", import.meta.url));

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeProvider(raw, index) {
  if (!raw?.name) throw new Error(`catalog provider #${index + 1} has no name`);
  if (!raw?.baseUrl) throw new Error(`catalog provider "${raw.name}" has no baseUrl`);
  return {
    name: String(raw.name).trim(),
    type: raw.type === "anthropic" ? "anthropic" : "openai",
    baseUrl: String(raw.baseUrl).replace(/\/+$/, ""),
    // null = the provider needs no key (a local runtime, typically).
    envVar: raw.envVar ? String(raw.envVar).trim() : null,
    keyUrl: raw.keyUrl ? String(raw.keyUrl) : null,
    note: raw.note ? String(raw.note) : null,
    headers: isPlainObject(raw.headers) ? { ...raw.headers } : {},
  };
}

/** Reads and validates the catalogue. Throws with a readable message. */
export function loadCatalog(file = CATALOG_FILE) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read the default catalogue (${file}): ${err.message}`);
  }

  const providers = (Array.isArray(raw.providers) ? raw.providers : []).map(normalizeProvider);
  const byName = new Map(providers.map((provider) => [provider.name.toLowerCase(), provider]));

  const models = (Array.isArray(raw.models) ? raw.models : []).map((entry, index) => {
    if (!entry?.model) throw new Error(`catalog model #${index + 1} has no model id`);
    const provider = byName.get(String(entry.provider ?? "").toLowerCase());
    if (!provider) throw new Error(`catalog model "${entry.model}" points at unknown provider "${entry.provider}"`);
    return {
      provider: provider.name,
      model: String(entry.model).trim(),
      alias: (entry.alias || entry.model).trim(),
      kind: entry.kind === "embedding" ? "embedding" : "chat",
      params: isPlainObject(entry.params) ? { ...entry.params } : {},
    };
  });

  return { file, providers, models };
}

/** Providers of the catalogue that need a key, with what is known about them. */
export function catalogKeys(catalog) {
  return catalog.providers
    .filter((provider) => provider.envVar)
    .map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      envVar: provider.envVar,
      keyUrl: provider.keyUrl,
      note: provider.note,
      models: catalog.models.filter((entry) => entry.provider === provider.name).map((entry) => entry.model),
      set: Boolean(envValue(provider.envVar)),
    }));
}

/**
 * Merges the catalogue into a config, in place. Idempotent: providers are
 * matched by name and models by provider + model id, so running it twice, or
 * on top of a config the user has edited, adds nothing and overwrites nothing.
 * An API key already stored by hand is left alone.
 */
export function applyCatalog(config, catalog) {
  const added = { providers: [], models: [] };

  for (const source of catalog.providers) {
    const existing = config.providers.find((provider) => provider.name.toLowerCase() === source.name.toLowerCase());
    if (!existing) {
      config.providers.push({
        id: newId("prov"),
        name: source.name,
        type: source.type,
        baseUrl: source.baseUrl,
        apiKey: source.envVar ? `env:${source.envVar}` : null,
        headers: { ...source.headers },
        enabled: true,
      });
      added.providers.push(source.name);
    } else if (!existing.apiKey && source.envVar) {
      existing.apiKey = `env:${source.envVar}`;
    }
  }

  const byName = new Map(config.providers.map((provider) => [provider.name.toLowerCase(), provider]));
  for (const source of catalog.models) {
    const provider = byName.get(source.provider.toLowerCase());
    if (!provider) continue;
    const duplicate = config.models.some((entry) => entry.providerId === provider.id && entry.model === source.model);
    if (duplicate) continue;
    config.models.push({
      id: newId("mdl"),
      providerId: provider.id,
      model: source.model,
      alias: source.alias,
      kind: source.kind,
      enabled: true,
      params: { ...source.params },
    });
    added.models.push(source.model);
  }

  return added;
}

/** The `.env.example` shipped with the package, generated, never hand-edited. */
export function renderEnvExample(catalog) {
  const lines = [
    "# llm-failover-proxy, API keys",
    "#",
    "# Copy this file to `.env` and paste in the keys you have. The proxy reads it",
    "# from the working directory and from the folder holding its config.json, so",
    "# either location works. A real environment variable always wins over the file.",
    "#",
    "# Leave a line empty to skip that provider: the failover chain steps over it",
    "# and moves on to the next model.",
    "#",
    "# The configuration JSON only stores `env:NAME` references, never a key, so",
    "# it is safe to commit or share. This file is not.",
    "#",
    "# Generated from defaults/catalog.json.",
    "",
  ];

  for (const entry of catalogKeys(catalog)) {
    lines.push(`# ${entry.name} · ${entry.baseUrl}`);
    if (entry.note) lines.push(`#   ${entry.note}`);
    if (entry.keyUrl) lines.push(`#   get a key: ${entry.keyUrl}`);
    if (entry.models.length) lines.push(`#   models: ${entry.models.join(", ")}`);
    lines.push(`${entry.envVar}=`, "");
  }

  lines.push(
    "# Optional, require a key from the clients of the proxy itself. Set",
    '# "apiKey": "env:LLM_PROXY_API_KEY" in config.json (or the Settings screen)',
    "# to switch it on.",
    "#LLM_PROXY_API_KEY=",
    "",
    "# Optional, point the proxy at another config file.",
    "#LLM_PROXY_CONFIG=/path/to/config.json",
  );

  return `${lines.join("\n")}\n`;
}
