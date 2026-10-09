import { expect, test } from "vitest";
import { fetchInstalled, fileName, INSTALLED_URL, readInstalled } from "./installed";

const answer = {
  dir: "/home/me/.config/kauak/appearances",
  packages: [
    { file: "/home/me/.config/kauak/appearances/harbor.json", package: { id: "example.harbor" } },
    { file: "/home/me/.config/kauak/appearances/broken.json", error: "not valid JSON" },
  ],
};

test("the bridge's answer is read as it is: each file's JSON, or its error", () => {
  expect(readInstalled(answer)).toEqual(answer);
  expect(readInstalled({ dir: "/x", packages: [] })).toEqual({ dir: "/x", packages: [] });
});

test("anything that is not the bridge's answer is null", () => {
  for (const v of [null, undefined, "", 1, [], {}, { dir: 1, packages: [] }, { dir: "/x" }, { dir: "/x", packages: {} }])
    expect(readInstalled(v)).toBeNull();
  expect(readInstalled({ dir: "/x", packages: [{ package: {} }] })).toBeNull();
  expect(readInstalled({ dir: "/x", packages: [null] })).toBeNull();
});

/** A fetch that answers `status` with `body`, as `type`. */
function answering(status: number, body: string, type = "application/json"): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe(INSTALLED_URL);
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(body, { status, headers: { "content-type": type } });
  }) as typeof fetch;
}

test("fetchInstalled: the bridge's JSON answer, and null for no bridge, another page or a network error", async () => {
  expect(await fetchInstalled(answering(200, JSON.stringify(answer)))).toEqual(answer);
  // The static demo site has no bridge: its server answers 404, or with its index page.
  expect(await fetchInstalled(answering(404, "Not found", "text/plain"))).toBeNull();
  expect(await fetchInstalled(answering(200, "<!doctype html>", "text/html"))).toBeNull();
  expect(await fetchInstalled(answering(200, "{ not json"))).toBeNull();
  expect(await fetchInstalled(answering(200, "[]"))).toBeNull();
  expect(
    await fetchInstalled((async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch),
  ).toBeNull();
});

test("fetchInstalled gives up on a bridge that does not answer, so the office still opens", async () => {
  // Answers only by failing when the request is aborted: without the timeout, this would never end.
  const silent = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
  expect(await fetchInstalled(silent, 20)).toBeNull();
});

test("a file is listed by its name", () => {
  expect(fileName("/home/me/.config/kauak/appearances/harbor.json")).toBe("harbor.json");
  expect(fileName("C:\\Users\\me\\harbor.json")).toBe("harbor.json");
  expect(fileName("harbor.json")).toBe("harbor.json");
});
