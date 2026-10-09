import { expect, test } from "vitest";
import { escapeHtml } from "./html";

test("escapeHtml makes names and titles safe to put in the page's HTML or a double-quoted attribute", () => {
  expect(escapeHtml(`<img src=x onerror="alert(1)"> & co`)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; co");
  expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  expect(escapeHtml("it's fine · ✓")).toBe("it's fine · ✓");
  expect(escapeHtml("")).toBe("");
});
