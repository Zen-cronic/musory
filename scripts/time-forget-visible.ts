// Forget me as a person sees it: from tapping "Yes, forget me" on the guest's phone to the room
// screen's NOW title changing. Assumes the demo guest is checked in at Copper Bar (run after a reset,
// warm-up and a check-in, the way the live demo runs).
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:4377";
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome" });
const room = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await room.goto(`${BASE}/room/copper?film=1`);
const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
await phone.goto(`${BASE}/p/g-jess?venue=copper`);
await phone.waitForTimeout(2500);
const before = await room.textContent("#now-title");
await phone.click("#forget");
const t0 = Date.now();
await phone.click("#forget-yes");
await room.waitForFunction((b) => document.querySelector("#now-title")?.textContent !== b, before, { timeout: 20000, polling: 50 });
const visible = Date.now() - t0;
await phone.waitForSelector("#receipt:not(.hidden)", { timeout: 20000 });
const receipt = Date.now() - t0;
console.log(`room NOW changed ${visible} ms after the tap (from "${before}" to "${await room.textContent("#now-title")}"); phone receipt at ${receipt} ms`);
await browser.close();
process.exit(0);
