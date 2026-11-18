import { ParsedOrderSchema, detectRetailer } from "@oep/shared";
import { describe, expect, it } from "vitest";
import { compactAmount, dateDotted, dateLong, dateUs, fullAmount, total } from "./format.ts";
import { escapeHtml, html, raw, toHtmlString } from "./html.ts";
import {
  TEMPLATE_NAMES,
  expectedOrder,
  fixture,
  freshOrder,
  isTemplateName,
  loadOrder,
  renderEmail,
} from "./index.ts";

describe("html tagged template", () => {
  it("escapes interpolated strings but not SafeHtml", () => {
    const name = `<script>alert("x")</script> & 'co'`;
    const br = raw("<br>");
    const out = toHtmlString(html`<p>${name}</p>${br}`);
    expect(out).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;</p><br>",
    );
  });

  it("joins arrays of SafeHtml and skips null", () => {
    expect(toHtmlString(html`${[raw("a"), raw("b")]}${null}${undefined}${3}`)).toBe("ab3");
  });

  it("escapeHtml handles every special character", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("formatters", () => {
  it.each([
    [3900, "3,900"],
    [61.6, "61.60"],
    [0, "0"],
  ])("compactAmount(%d) = %s", (n, s) => expect(compactAmount(n)).toBe(s));

  it("fullAmount always has two decimals", () => {
    expect(fullAmount(1250)).toBe("1,250.00");
  });

  it("formats dates per locale", () => {
    expect(dateDotted("2026-10-02")).toBe("02.10.2026");
    expect(dateLong("2026-09-14")).toBe("14 September 2026");
    expect(dateUs("2026-10-27")).toBe("10/27/2026");
  });
});

describe.each(TEMPLATE_NAMES)("%s template", (name) => {
  const order = loadOrder(name);
  const rendered = renderEmail(name, order);

  it("contains every value the parser must find", () => {
    const text = rendered.html;
    expect(text).toContain(order.orderNumber);
    for (const item of order.items) {
      expect(text).toContain(item.name);
      expect(text).toContain(item.imageUrl);
      expect(text.toLowerCase()).toContain(item.brand.toLowerCase());
      expect(text.toLowerCase()).toContain(item.colour.toLowerCase());
      expect(text).toContain(item.size);
    }
  });

  it("has a plain-text alternative and a retailer-looking sender", () => {
    expect(rendered.text).toContain(order.orderNumber);
    expect(detectRetailer(`x <${rendered.retailerAddress}>`)).toBe(order.retailer);
  });

  it("produces an expected order that satisfies the parser schema", () => {
    expect(ParsedOrderSchema.safeParse(expectedOrder(order)).success).toBe(true);
  });

  it("escapes hostile order data", () => {
    const hostile = { ...order, customerName: `<img src=x onerror=alert(1)>` };
    expect(renderEmail(name, hostile).html).not.toContain("<img src=x");
  });

  it("builds a fixture with the real retailer sender", () => {
    const f = fixture(name);
    expect(detectRetailer(f.email.from)).toBe(order.retailer);
    expect(f.expected).toEqual(expectedOrder(order));
  });
});

describe("expectedOrder", () => {
  it("computes totals from items, shipping and tax", () => {
    expect(total(loadOrder("mytheresa"))).toBe(5550);
    expect(total(loadOrder("selfridges"))).toBe(2040);
    expect(total(loadOrder("revolve"))).toBe(317.11);
  });

  it("uses the sale price, not the original price", () => {
    const sandal = expectedOrder(loadOrder("revolve")).items[1]!;
    expect(sandal.price).toBe(61.6);
  });
});

describe("freshOrder", () => {
  it("assigns a new order number in the retailer's format and today's date", () => {
    const now = new Date("2026-11-18T10:00:00Z");
    const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    let i = 0;
    const random = () => seq[i++ % seq.length]!;
    expect(freshOrder("mytheresa", loadOrder("mytheresa"), now, random).orderNumber).toMatch(
      /^MYT-\d{8}$/,
    );
    expect(freshOrder("selfridges", loadOrder("selfridges"), now, random).orderNumber).toMatch(
      /^6\d{8}$/,
    );
    const r = freshOrder("revolve", loadOrder("revolve"), now, random);
    expect(r.orderNumber).toMatch(/^RV\d{7}$/);
    expect(r.orderDate).toBe("2026-11-18");
  });

  it("does not mutate the source order", () => {
    const original = loadOrder("revolve");
    freshOrder("revolve", original);
    expect(original.orderNumber).toBe("RV7781234");
  });
});

describe("isTemplateName", () => {
  it("accepts known names only", () => {
    expect(isTemplateName("revolve")).toBe(true);
    expect(isTemplateName("harrods")).toBe(false);
    expect(isTemplateName("toString")).toBe(false);
  });
});
