import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { KNOWN_FACTS, factsReferenced } from "../packages/core/src/index.ts";
import { loadPack, runCases, validatePack } from "../packages/rules/src/index.ts";

const legal = new URL("../packages/packs/legal/", import.meta.url).pathname;
const core = new URL("../packages/packs/core/", import.meta.url).pathname;

test("every legal pack validates, its cases pass, and enabled rules only use known facts", async () => {
  const known = new Set<string>(KNOWN_FACTS);
  for (const dir of [core, ...(await readdir(legal)).map((name) => join(legal, name))]) {
    const pack = await loadPack(dir);
    assert.deepEqual(validatePack(pack), [], dir);
    for (const result of runCases(pack)) assert.equal(result.actual, result.expected, `${dir} ${result.id}`);
    for (const rule of pack.rules.filter((item) => item.enabled)) {
      const facts = factsReferenced(rule.appliesWhen);
      factsReferenced(rule.evaluate.pass, facts);
      factsReferenced(rule.evaluate.fail, facts);
      for (const fact of facts) assert.ok(known.has(fact), `${rule.id} uses unknown fact ${fact}`);
      assert.ok(rule.source.url.startsWith("https://"), rule.id);
      assert.equal(rule.verification.status, "verified", rule.id);
    }
  }
});

test("GDPR, accessibility, and Apple Kids packs ship enabled rules", async () => {
  for (const name of ["gdpr", "accessibility", "apple-kids"]) {
    const pack = await loadPack(join(legal, name));
    assert.ok(pack.rules.filter((rule) => rule.enabled).length >= 2, name);
  }
});
