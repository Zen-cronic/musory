// Listens to a room screen in a browser through a few track changes and checks the players:
// after each crossfade exactly one track is playing, at full level, with its filter fully open.
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:4377";
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.goto(`${BASE}/room/copper`);
await page.click("#start-room");
let bad = 0;
for (let i = 0; i < Number(process.env.CHECKS || 6); i++) {
  await page.waitForTimeout(5000);
  const s = (await page.evaluate("window.__roomAudio()")) as { paused: boolean; gain: number; filter: string; src: string }[];
  const playing = s.filter((x) => !x.paused);
  const ok = playing.length === 1 && playing[0].gain > 0.95 && /lowpass 2[0-9]{4}/.test(playing[0].filter);
  if (!ok) bad++;
  console.log(ok ? "ok  " : "BAD ", JSON.stringify(s));
}
await browser.close();
console.log(bad ? `${bad} bad samples` : "all samples clean");
process.exit(bad ? 1 : 0);
