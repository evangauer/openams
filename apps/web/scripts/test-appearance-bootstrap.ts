import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { themeBootData, themeBootScript } from "../src/features/agency/appearance-bootstrap";
import { AGENCY_SCHEMES, DEFAULT_THEME } from "../src/features/agency/appearance-options";

function boot(search = "", saved: Record<string, string> = {}) {
  const values = new Map(Object.entries(saved));
  const dataset: Record<string, string> = { theme: DEFAULT_THEME };
  const context = {
    document: { currentScript: { dataset: { appearance: themeBootData } }, documentElement: { dataset } },
    location: { search }, URLSearchParams,
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    injected: false,
  };
  runInNewContext(themeBootScript, context);
  return { dataset, values, injected: context.injected };
}

assert.deepEqual(boot().dataset, { theme: DEFAULT_THEME, scheme: "saffron" });
for (const { id } of AGENCY_SCHEMES) {
  assert.equal(boot("", { "openams.scheme": id }).dataset.scheme, id);
  const result = boot(`?scheme=${id}`, { "openams.scheme": "invalid" });
  assert.equal(result.dataset.scheme, id);
  assert.equal(result.values.get("openams.scheme"), id);
}
const payload = '</script><script>injected=true</script>";injected=true;//';
const rejected = boot(`?scheme=${encodeURIComponent(payload)}&theme=relay`, {
  "openams.scheme": payload, "openams.theme": payload,
});
assert.deepEqual(rejected.dataset, { theme: DEFAULT_THEME, scheme: "saffron" });
assert.equal(rejected.injected, false);
assert.equal(boot("?scheme=invalid", { "openams.scheme": "dusk" }).dataset.scheme, "dusk");
console.log("Appearance bootstrap accepts known choices and rejects executable input.");
