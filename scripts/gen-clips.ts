// Generates the instrumental clips the rooms play, with ElevenLabs Music.
// Prompts describe genre, tempo and texture only: no artist, title or label names.
import "dotenv/config";
import { existsSync, writeFileSync } from "node:fs";

export const CLIP_PROMPTS: Record<string, string> = {
  "20_techno_hypnotic": "Hypnotic minimal techno, 128 BPM, tight rolling kick, looping metallic percussion, filtered acid line, late-night club, instrumental",
  "21_techno_peak": "Peak-time hard techno, 138 BPM, distorted pounding kick, industrial stabs, relentless energy, strobe-lit warehouse, instrumental",
  "22_dnb_liquid": "Liquid drum and bass, 174 BPM, fast rolling breakbeats, warm deep sub bass, airy pads and soft piano chords, uplifting, instrumental",
  "23_dnb_rolling": "Rolling dark drum and bass, 172 BPM, punchy chopped breaks, growling reese bass, tense and energetic, instrumental",
  "24_disco_house": "Disco house, 120 BPM, filtered funky string loop, chopped disco guitar, bouncy bassline, sunny rooftop party, instrumental",
  "25_afro_deep": "Deep afro house, 120 BPM, marimba melody, layered hand percussion and shakers, warm sub bass, hypnotic and soulful, instrumental",
  "26_trance_uplifting": "Uplifting trance, 138 BPM, bright supersaw chords, driving offbeat bassline, euphoric build and release, instrumental",
  "27_trance_progressive": "Progressive trance, 132 BPM, slowly evolving arpeggio, rolling bassline, dreamy pads, steady hypnotic build, instrumental",
  "28_deep_house": "Deep house, 120 BPM, smoky Rhodes chords, round warm bassline, soft shuffled hi-hats, late-night lounge, instrumental",
  "29_ukg_2step": "UK garage two-step, 132 BPM, shuffled skippy drums, chopped organ stabs, bouncy sub bass, playful and swung, instrumental",
};

async function gen(id: string, prompt: string) {
  const out = `public/audio/${id}.mp3`;
  if (existsSync(out)) return console.log(id, "exists");
  const t0 = Date.now();
  const r = await fetch("https://api.elevenlabs.io/v1/music", {
    method: "POST",
    headers: { "xi-api-key": String(process.env.ELEVENLABS_API_KEY), "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ prompt, music_length_ms: 15000, model_id: "music_v2_5", force_instrumental: true }),
  });
  if (!r.ok) return console.log(id, "failed HTTP", r.status, (await r.text()).slice(0, 200));
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log(id, "ok", ((Date.now() - t0) / 1000).toFixed(1), "s");
}

const entries = Object.entries(CLIP_PROMPTS);
async function worker() {
  while (entries.length) {
    const [id, p] = entries.shift()!;
    await gen(id, p).catch((e) => console.log(id, "error", (e as Error).message));
  }
}
await Promise.all([worker(), worker()]);
