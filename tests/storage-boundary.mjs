import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const syncDefaults = source.match(/const SYNC_DEFAULTS = \{([\s\S]*?)\n\};/)?.[1] ?? "";
const localDefaults = source.match(/const LOCAL_DEFAULTS = \{([\s\S]*?)\n\};/)?.[1] ?? "";

assert.match(syncDefaults, /piiApiUrl/);
assert.doesNotMatch(syncDefaults, /piiApiKey/);
assert.match(localDefaults, /piiApiKey/);
assert.match(source, /chrome\.storage\.local\.set\(\{ piiApiKey \}\)/);
assert.match(source, /chrome\.storage\.sync\.remove\('piiApiKey'\)/);

console.log("storage_boundary_ok");
