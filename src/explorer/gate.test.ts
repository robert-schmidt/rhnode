import { test } from "node:test";
import assert from "node:assert/strict";
import { claim, CODE_PREFIX, REPO_NAME } from "./gate.ts";

test("claim: a comment with the code works for someone who opened an issue before, not for someone who didn't", async () => {
  const code = "00112233aabbccdd";
  const api: Record<string, unknown> = {
    [`/repos/${REPO_NAME}/issues?state=all&sort=created&direction=desc&per_page=100`]: [{ title: "Explorer access", body: `${CODE_PREFIX}ffffffffffffffff`, user: { login: "Old" } }],
    [`/repos/${REPO_NAME}/issues/comments?sort=created&direction=desc&per_page=100`]: [
      { body: `again: ${CODE_PREFIX}${code}`, user: { login: "Old" } }, { body: `${CODE_PREFIX}1111111111111111`, user: { login: "stranger" } }],
    [`/repos/${REPO_NAME}/issues?state=all&creator=Old&per_page=1`]: [{}],
    [`/repos/${REPO_NAME}/issues?state=all&creator=stranger&per_page=1`]: [],
    "/users/old/starred?sort=created&direction=desc&per_page=100&page=1": [{ full_name: REPO_NAME }],
  };
  globalThis.fetch = (async (u: string) => {
    const body = api[String(u).replace("https://api.github.com", "")];
    return new Response(JSON.stringify(body ?? []), { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;
  assert.deepEqual(await claim(code), { login: "old" });
  assert.match(String((await claim("1111111111111111") as { error: string }).error), /no issue of yours/);
  assert.match(String((await claim("2222222222222222") as { error: string }).error), /No issue or comment/);
});
