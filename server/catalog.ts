// The catalogue: 21 instrumental clips we generated with ElevenLabs Music (15 s each).
// Titles are fictional. Each description is the prompt the clip was generated from:
// genre, tempo and texture only, never an artist, title or label name.
export type Track = {
  _id: string;
  title: string;
  genre: string;
  bpm: number;
  energy: number; // 0..1, used by the time-of-night filter
  descriptor: string;
  audio: string;
};

const t = (n: number, title: string, genre: string, bpm: number, energy: number, descriptor: string): Track => {
  const id = `t${String(n).padStart(2, "0")}`;
  return { _id: id, title, genre, bpm, energy, descriptor, audio: `/audio/${id}.mp3` };
};

export const TRACKS: Track[] = [
  t(1, "Copper Wire", "house", 124, 0.72, "Upbeat melodic house, 124 BPM, warm pads, rolling bassline, crisp hi-hats, festival energy"),
  t(2, "Second Room", "house", 124, 0.7, "Upbeat melodic house, 124 BPM, warm pads, rolling bassline, crisp hi-hats, festival energy, a looser groove"),
  t(3, "Cloakroom 14", "house", 124, 0.7, "Melodic house, 124 BPM, warm pads, rolling bassline, crisp hi-hats, open and bright"),
  t(4, "Upstairs Bar", "house", 124, 0.68, "Melodic house, 124 BPM, soft pads, round rolling bassline, crisp hi-hats, friendly early-night energy"),
  t(5, "Smoke Machine", "deep house", 120, 0.5, "Deep house, 120 BPM, smoky Rhodes chords, round warm bassline, soft shuffled hi-hats, late-night lounge"),
  t(6, "Hand Stamp", "afro house", 122, 0.7, "Afro house, 122 BPM, warm melodic pads, layered afro-house percussion, congas, shakers, talking drum and log drum groove"),
  t(7, "Door Opens", "afro house", 124, 0.72, "Melodic house that turns into afro house percussion halfway: congas, shakers, talking drum, log drum"),
  t(8, "Marimba Steps", "afro house", 120, 0.62, "Deep afro house, 120 BPM, marimba melody, layered hand percussion and shakers, warm sub bass, hypnotic and soulful"),
  t(9, "Mirror Ball Shift", "disco", 116, 0.66, "Upbeat nu-disco, 116 BPM, funky slap bass, bright rhythm guitar chops, four-on-the-floor kick, sparkling strings"),
  t(10, "Rooftop Strings", "disco", 120, 0.66, "Disco house, 120 BPM, filtered funky string loop, chopped disco guitar, bouncy bassline, sunny rooftop party"),
  t(11, "Steel Floor", "techno", 132, 0.86, "Dark driving techno, 132 BPM, pounding four-on-the-floor kick, hypnotic synth stabs, rumbling sub bass, warehouse atmosphere"),
  t(12, "Gaffer Tape", "techno", 128, 0.78, "Melodic techno, 128 BPM, warm pads over a darker driving kick and rolling sub bass, hypnotic arpeggio, uplifting but tough"),
  t(13, "Low Ceiling", "techno", 128, 0.78, "Hypnotic minimal techno, 128 BPM, tight rolling kick, looping metallic percussion, filtered acid line, late-night club"),
  t(14, "Fire Exit", "techno", 138, 0.95, "Peak-time hard techno, 138 BPM, distorted pounding kick, industrial stabs, relentless energy, strobe-lit warehouse"),
  t(15, "Arms Up at Six", "trance", 138, 0.9, "Uplifting trance, 138 BPM, bright supersaw chords, driving offbeat bassline, euphoric build and release"),
  t(16, "Long Hallway", "trance", 132, 0.76, "Progressive trance, 132 BPM, slowly evolving arpeggio, rolling bassline, dreamy pads, steady hypnotic build"),
  t(17, "Night Tram", "drum & bass", 174, 0.82, "Liquid drum and bass, 174 BPM, fast rolling breakbeats, warm deep sub bass, airy pads and soft piano chords, uplifting"),
  t(18, "Cold Hands", "drum & bass", 172, 0.9, "Rolling dark drum and bass, 172 BPM, punchy chopped breaks, growling reese bass, tense and energetic"),
  t(19, "Skip a Step", "uk garage", 132, 0.72, "UK garage two-step, 132 BPM, shuffled skippy drums, chopped organ stabs, bouncy sub bass, playful and swung"),
  t(20, "Coat Check", "downtempo", 80, 0.22, "Chill lo-fi, 80 BPM, soft electric piano keys, dusty swung drums, vinyl crackle, relaxed cafe mood"),
  t(21, "Warm Up", "downtempo", 108, 0.42, "Downtempo organic house, 108 BPM, soft electric piano keys and hand percussion, shakers and congas, mellow and warm"),
];

export const GENRES = [...new Set(TRACKS.map((x) => x.genre))];
export const byId = new Map(TRACKS.map((x) => [x._id, x]));
export const embedText = (x: Track) => `${x.genre}. ${x.descriptor}`;
