// Rendered layout and interaction checks at phone and tablet widths
// (issue #284), in a real Chromium through Playwright, against a real test
// server holding fictional usage (fixture.js). Run with `npm run test:browser`
// after `npm run build`; CHROMIUM_PATH picks a local Chromium instead of
// Playwright's own (e.g. on NixOS).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixtureServer } from "./fixture.js";

const WIDTHS = [320, 390, 768];
const MARGIN = 8; // the tooltip's distance from the window's edges (tooltip.svelte.ts)
const SUBPIXEL = 0.5; // layout rounding (Geist's fractional widths)
const GUTTER_X = 2; // inside the page's 16 px side gutter: outside any card or tooltip
const SETTLE_MS = 150; // long enough for a wrongly reopened tooltip to show
const BOTTOM_GAP = 40; // how far above the window's bottom the flip test puts its trigger
// The caveats the fixture's conversations carry (fixture.js), as SessionValue words them.
const CAVEATS = [/Leaves out .* tokens/, /At least: some cache writes/, /predates its model's oldest published rate/];
const INFO = 'button[aria-label="About this API value"]';

let srv;
let browser;
before(async () => {
  srv = await fixtureServer();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});
after(async () => {
  await browser?.close();
  await srv?.stop();
});

async function open(width, { touch = false, height = 800 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce", timezoneId: "UTC",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto(`${srv.base}/u/admin`);
  await page.locator(INFO).first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, errors, close: () => context.close() };
}

/** The tooltip a trigger describes, once fully shown (opacity 1). */
async function shownTip(page, trigger) {
  const id = await trigger.getAttribute("aria-describedby");
  const tip = page.locator(`[id="${id}"]`);
  await page.waitForFunction((el) => getComputedStyle(el).opacity === "1" && getComputedStyle(el).visibility === "visible", await tip.elementHandle());
  return tip;
}

async function hidden(page, trigger) {
  const id = await trigger.getAttribute("aria-describedby");
  return page.locator(`[id="${id}"]`).evaluate((el) => getComputedStyle(el).visibility === "hidden");
}

/** Asserts the element lies inside the viewport, MARGIN px from each edge. */
async function assertInViewport(tip, what) {
  const box = await tip.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight };
  });
  assert.ok(box.left >= MARGIN - SUBPIXEL, `${what}: left edge ${box.left} outside the viewport`);
  assert.ok(box.right <= box.vw - MARGIN + SUBPIXEL, `${what}: right edge ${box.right} beyond ${box.vw}`);
  assert.ok(box.top >= 0, `${what}: top edge ${box.top} above the viewport`);
  assert.ok(box.bottom <= box.vh, `${what}: bottom edge ${box.bottom} below ${box.vh}`);
}

/** Tab until the trigger has focus (as a keyboard user would reach it). */
async function tabTo(page, trigger) {
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press("Tab");
    if (await trigger.evaluate((el) => el === document.activeElement)) return;
  }
  assert.fail("trigger never reached with Tab");
}

const openCodeCard = (page) => page.locator("article.card").filter({ hasText: "OpenCode" }).filter({ hasText: "Today" }).first();

for (const width of WIDTHS) {
  describe(`${width} px`, () => {
    test("OpenCode card: models readable in full, nothing outside the card", async () => {
      const { page, errors, close } = await open(width, { touch: true });
      try {
        const card = openCodeCard(page);
        const report = await card.evaluate((el, SUBPIXEL) => {
          const c = el.getBoundingClientRect();
          const inside = (e) => { const r = e.getBoundingClientRect(); return r.left >= c.left - SUBPIXEL && r.right <= c.right + SUBPIXEL; };
          return {
            models: [...el.querySelectorAll(".model")].map((m) => ({ text: m.textContent, clipped: m.scrollWidth > m.clientWidth + SUBPIXEL, inside: inside(m) })),
            parts: [...el.querySelectorAll(".status, .row .meta, .head .label")].map((e) => ({ text: e.textContent, inside: inside(e), clipped: e.scrollWidth > e.clientWidth + SUBPIXEL })),
          };
        }, SUBPIXEL);
        const gpt = report.models.find((m) => m.text === "openai/gpt-5.2");
        assert.ok(gpt, "the openai/gpt-5.2 conversation is listed");
        for (const m of report.models) {
          assert.equal(m.clipped, false, `model ${m.text} is cut`);
          assert.ok(m.inside, `model ${m.text} leaves the card`);
        }
        for (const p of report.parts) {
          assert.ok(p.inside, `"${p.text}" leaves the card`);
          assert.equal(p.clipped, false, `"${p.text}" is cut`);
        }
        // The long name nobody prices is shown whole too, wrapped.
        assert.ok(report.models.some((m) => m.text.endsWith("fictional-model-extended-preview-20991231")));
        assert.deepEqual(errors, [], "no error on the page");
      } finally { await close(); }
    });

    test("keyboard: Tab opens each API-value tooltip inside the viewport, Escape closes it and keeps focus", async () => {
      const { page, errors, close } = await open(width);
      try {
        const triggers = page.locator(INFO);
        const count = await triggers.count();
        assert.ok(count >= 2, "conversations with caveats show an info button");
        const texts = [];
        for (let i = 0; i < count; i++) {
          const trigger = triggers.nth(i);
          await tabTo(page, trigger);
          const tip = await shownTip(page, trigger);
          await assertInViewport(tip, `tooltip ${i}`);
          texts.push(await tip.textContent());
          await page.keyboard.press("Escape");
          assert.ok(await hidden(page, trigger), "Escape hides the tooltip");
          assert.ok(await trigger.evaluate((el) => el === document.activeElement), "focus stays on the trigger");
          await page.waitForTimeout(SETTLE_MS);
          assert.ok(await hidden(page, trigger), "it stays hidden while the trigger keeps focus");
          // A fresh interaction (focus coming back) opens it again.
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          await shownTip(page, trigger);
        }
        // Each caveat of the fixture is explained in some tooltip.
        for (const caveat of CAVEATS) assert.ok(texts.some((t) => caveat.test(t)), `a tooltip says ${caveat}`);
        assert.deepEqual(errors, [], "no error on the page");
      } finally { await close(); }
    });

    test("keyboard: the API value stat popover stays inside the viewport and closes on Escape", async () => {
      const { page, errors, close } = await open(width);
      try {
        const stat = page.locator(".stats button", { hasText: "API value" });
        await tabTo(page, stat);
        await assertInViewport(await shownTip(page, stat), "API value stat");
        await page.keyboard.press("Escape");
        assert.ok(await hidden(page, stat));
        assert.ok(await stat.evaluate((el) => el === document.activeElement));
        assert.deepEqual(errors, [], "no error on the page");
      } finally { await close(); }
    });

    test("mouse: hover opens a tooltip, Escape closes it until the pointer comes back", async () => {
      const { page, errors, close } = await open(width);
      try {
        const trigger = page.locator(INFO).first();
        await trigger.hover();
        await assertInViewport(await shownTip(page, trigger), "hovered tooltip");
        await page.keyboard.press("Escape");
        assert.ok(await hidden(page, trigger));
        const box = await trigger.boundingBox();
        await trigger.hover({ position: { x: box.width / 2 + 1, y: box.height / 2 + 1 } }); // still over it
        assert.ok(await hidden(page, trigger), "moving within the trigger does not reopen it");
        await page.mouse.move(1, 1);
        await trigger.hover();
        await shownTip(page, trigger);
        assert.deepEqual(errors, [], "no error on the page");
      } finally { await close(); }
    });

    test("touch: a tap opens a tooltip inside the viewport, a tap elsewhere or on it again closes it", async () => {
      const { page, errors, close } = await open(width, { touch: true });
      try {
        const triggers = page.locator(INFO);
        for (let i = 0; i < await triggers.count(); i++) {
          const trigger = triggers.nth(i);
          await trigger.scrollIntoViewIfNeeded();
          await trigger.tap();
          await assertInViewport(await shownTip(page, trigger), `tapped tooltip ${i}`);
          await page.touchscreen.tap(GUTTER_X, 300);
          assert.ok(await hidden(page, trigger), "a tap elsewhere closes it");
          await trigger.tap();
          await shownTip(page, trigger);
          await trigger.tap();
          assert.ok(await hidden(page, trigger), "a second tap closes it");
        }
        const stat = page.locator(".stats button", { hasText: "API value" });
        await stat.scrollIntoViewIfNeeded();
        await stat.tap();
        await assertInViewport(await shownTip(page, stat), "tapped API value stat");
        assert.deepEqual(errors, [], "no error on the page");
      } finally { await close(); }
    });

    test("touch: a swipe to scroll leaves an open tooltip open", async () => {
      const { page, errors, close } = await open(width, { touch: true });
      try {
        const trigger = page.locator(INFO).first();
        await trigger.scrollIntoViewIfNeeded();
        await trigger.tap();
        await shownTip(page, trigger);
        // A vertical swipe in the page's gutter, as raw touch events (Playwright only taps).
        const cdp = await page.context().newCDPSession(page);
        const touch = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: y === null ? [] : [{ x: GUTTER_X, y }] });
        await touch("touchStart", 500);
        for (const y of [480, 450, 420, 400]) await touch("touchMove", y);
        await touch("touchEnd", null);
        await page.waitForTimeout(SETTLE_MS);
        assert.equal(await hidden(page, trigger), false, "a swipe does not close it");
        assert.deepEqual(errors, [], "no error on the page");
      } finally { await close(); }
    });

    test("near the bottom of the window a tooltip opens above its trigger", async () => {
      const { page, errors, close } = await open(width, { touch: true, height: 640 });
      try {
        const trigger = page.locator(".list " + INFO).first();
        // Put the trigger BOTTOM_GAP px above the window's bottom edge.
        const gap = await trigger.evaluate((el, want) => {
          const r = el.getBoundingClientRect();
          window.scrollBy(0, r.bottom - (document.documentElement.clientHeight - want));
          return document.documentElement.clientHeight - el.getBoundingClientRect().bottom;
        }, BOTTOM_GAP);
        // The page may end before that (scrolling clamps): check the setup, not only the result.
        assert.ok(Math.abs(gap - BOTTOM_GAP) <= 1, `trigger ${gap} px above the bottom, wanted ${BOTTOM_GAP}`);
        await trigger.tap();
        const tip = await shownTip(page, trigger);
        await assertInViewport(tip, "tooltip near the bottom");
        const [t, b] = await Promise.all([tip.boundingBox(), trigger.boundingBox()]);
        assert.ok(t.y + t.height <= b.y, "shown above the trigger");
        assert.deepEqual(errors, [], "no error on the page");
      } finally { await close(); }
    });
  });
}
