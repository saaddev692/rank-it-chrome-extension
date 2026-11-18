import { describe, expect, it } from "vitest";
import {
  ORDER_SEARCH_QUERY,
  buildOrderSearchQuery,
  detectRetailer,
  isAllowedOrderEmail,
} from "./retailers.ts";

describe("detectRetailer", () => {
  it.each([
    ["Mytheresa <noreply@mytheresa.com>", "Mytheresa"],
    ["orders@selfridges.com", "Selfridges"],
    ["REVOLVE <Orders@Email.REVOLVE.com>", "Revolve"],
    ["service@uk.mytheresa.com", "Mytheresa"],
  ])("maps %s to %s", (from, expected) => {
    expect(detectRetailer(from)).toBe(expected);
  });

  it.each([
    ["phish <orders@revolve.com.evil.io>"],
    ["notrevolve.com <a@notrevolve.com>"],
    ["no address here"],
    [""],
    ["someone@example.com"],
  ])("returns null for %s", (from) => {
    expect(detectRetailer(from)).toBeNull();
  });
});

describe("buildOrderSearchQuery", () => {
  it("includes every retailer domain and the age filter", () => {
    const q = buildOrderSearchQuery("6m");
    expect(q).toContain("mytheresa.com");
    expect(q).toContain("selfridges.com");
    expect(q).toContain("revolve.com");
    expect(q).toContain("newer_than:6m");
  });

  it("defaults to two years", () => {
    expect(buildOrderSearchQuery()).toContain("newer_than:2y");
  });

  it("also matches mock emails tagged by the send script (OR group)", () => {
    expect(ORDER_SEARCH_QUERY).toMatch(/^\{from:\([^)]+\) subject:"\[TEST ORDER\]"\} /);
    expect(ORDER_SEARCH_QUERY).toBe(buildOrderSearchQuery());
  });
});

describe("isAllowedOrderEmail", () => {
  it.each([
    ["MYTHERESA <noreply@mytheresa.com>", "Your order confirmation MYT-1"],
    ["REVOLVE <orders@email.revolve.com>", "anything at all"],
    ["MYTHERESA <me@gmail.com>", "Your order confirmation MYT-1 [TEST ORDER]"],
    ["Selfridges <sender@outlook.com>", "[TEST ORDER] Thanks for your order"],
  ])("allows %s / %s", (from, subject) => {
    expect(isAllowedOrderEmail({ from, subject })).toBe(true);
  });

  it.each([
    // What Gmail's punctuation-insensitive search lets through:
    ["GitHub <notifications@github.com>", "Re: [org/repo] Fix test order in CI (#42)"],
    ["GitHub <notifications@github.com>", "TEST ORDER"],
    ["someone <me@gmail.com>", "[test order] lowercase tag"],
    ["someone <me@gmail.com>", "[TEST  ORDER] double space"],
    ["Shop <orders@revolve.com.evil.io>", "Your order is confirmed"],
    ["Mytheresa (mytheresa.com) <promo@spam.example>", "Your order confirmation"],
  ])("rejects %s / %s", (from, subject) => {
    expect(isAllowedOrderEmail({ from, subject })).toBe(false);
  });
});
