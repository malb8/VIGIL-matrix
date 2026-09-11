import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";

const source = readFileSync(new URL("../src/popup.js", import.meta.url), "utf8");
const functionSource = source.match(/^async function scanCurrentPage\(tabId\) \{[\s\S]*?^\}/m)[0];

test("page scan returns observed resources while the document is still loading", async () => {
  let finishLoading;
  const documentIdle = new Promise((resolve) => { finishLoading = resolve; });
  const scanCurrentPage = runInNewContext(`(${functionSource})`, {
    chrome: {
      scripting: {
        executeScript: async ({ injectImmediately }) => {
          if (!injectImmediately) await documentIdle;
          return [{ result: {
            pageUrl: "https://www.teslarati.com/",
            frameHost: "www.teslarati.com",
            isTop: true,
            resources: [{ host: "www.teslarati.com", type: "script", count: 1, samples: [], sources: ["dom"] }]
          } }];
        }
      }
    }
  });

  try {
    const result = await Promise.race([scanCurrentPage(1), setImmediate(null)]);
    assert.ok(result, "scan must not wait for document_idle before returning visible resources");
    assert.equal(result.sourceDomain, "www.teslarati.com");
    assert.equal(result.frameCount, 1);
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].host, "www.teslarati.com");
    assert.equal(result.resources[0].type, "script");
    assert.equal(result.resources[0].count, 1);
  } finally {
    finishLoading();
  }
});
