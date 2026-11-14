// Renders docs/architecture.html to docs/architecture.png (1600x1000).
import { chromium } from "playwright";
import path from "node:path";
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("file://" + path.resolve("docs/architecture.html"));
await page.waitForTimeout(1200);
await page.screenshot({ path: "docs/architecture.png" });
await browser.close();
console.log("docs/architecture.png");
