# Musory

**After "forget me", 0 records about the guest are left at either venue, and each room plays exactly the track it said it would play without them.** `GET /api/number` recomputes this live, and `pnpm smoke` checks it end to end.

Tap what you like. The room plays it next. Say forget me, and every venue forgets you.

Your taps feed every room's crowd memory, which you never wrote. Forget me removes your share everywhere, and each room plays exactly what it said it would play without you.

![Architecture](docs/architecture.png)

## What it does

- **A guest** scans the venue's QR code, checks in, and says yes or no to two things: "use my taste here while I'm checked in" and "add my taps to this venue's crowd memory". Then they tap **I like this**, **Not for me** or **Bored of this** on whatever is playing. No mic, no listening, no guessing at mood: only explicit taps.
- **The room** (a laptop or screen at the venue) plays the next track picked from the people in the room, the venue's own crowd memory and the current track. It shows the pick next to the pick it would make with no memory at all.
- **Your night** on the guest page lists what the room played while you were checked in, from the room's own play log: no microphone, no song recognition.
- **Your taste is yours.** It goes with you to any venue you check into, so there's no cold start, and a venue uses it only while you're there.
- **Each venue's crowd memory is private.** Copper Room can't read Basement 2's, and neither can read your raw taps. Atlas refuses (error 13).
- **Forget me** deletes your taste, your taps, your check-ins, and your share of every venue's crowd memory, in one transaction. The receipt shows the count going to 0, and both rooms re-pick and play the track they said they'd play without you.
- **The room makes a new track when the crowd moves it.** When guests' taps change a room's leading sound, the room asks ElevenLabs Music for a new 15-second track at its current tempo (a composition plan that eases from the current sound into the new one) and crossfades into it over about 3 seconds, with filter sweeps. The screen says "Making a new track for the N people…", then "Made just now for this room". If the new track takes more than 10 seconds, the room plays the closest track from its catalogue and says so.

Venues (Copper Room, Basement 2), guests and track titles are fictional. The music is 19 instrumental clips we generated with ElevenLabs Music from descriptions of genre, tempo and sound only.

## How the next track is picked

No model picks the track. The server blends three layers of memory into one query vector and runs Atlas Vector Search over Voyage embeddings of each clip's description:

| Layer | What it is | Owner | Weight in the query |
|---|---|---|---|
| Guests' taste | Each checked-in guest's taste vector, built only from their own taps. Anyone who just checked in or tapped in the last 2 minutes counts 3 times | The guest | 60% |
| Crowd memory | This venue's reactions from guests who agreed, as one aggregate of 3 or more people, with no names or ids | The venue | 25% |
| The current track | Keeps the set moving smoothly | | 15% |

The search is exact (`$vectorSearch` with `exact: true`), pre-filtered on the hour's energy and a BPM range around the current track, and skips anything played recently. Every pick is stored with the pick the same search makes with no memory (the current track alone), so "memory changed the pick" is computed, not claimed.

## The three questions, answered by the database

| Question | Rule | Enforced by | Proof (live) |
|---|---|---|---|
| How do you keep one client's memory from leaking into another's? | Each venue reads its own crowd memory through its own database login and View. Venue logins can't read guests' taps or taste | Atlas database users with `read` on one View each | Basement 2's login reading Copper Room's View: **13 Unauthorized**. A venue login reading `taps`: **13** |
| How does the agent fix or drop a memory that is wrong or expired? | **Bored of this** marks your likes of the current sound `superseded` (kept, with who and when; Undo restores them). **Tonight only** keeps taps out of your long-term taste unless you tap "Keep this one". **Forget me** removes everything | A transaction for bored and undo; a `constraint`-level validator on taste; one transaction with `$graphLookup` for forget me | A tonight-only tap written into long-term taste: **121**. Forget me: **N → 0** |
| How do you prove memory changed behavior? | Each pick is logged next to the no-memory pick. Before forget me, the guest's page shows what each room will play without them, from the same function forget me is checked against | Decisions in `derived`; the headline number | After forget me, each room's now-playing equals the promised "without you" track |

Other rules the database enforces (`validationLevel: "constraint"`, error 121 otherwise):
- A venue's crowd memory needs at least 3 different people. With fewer, only the pick is kept.
- A guest's taste can be built only from that guest's own taps.
- Venue memory (crowd memory, decisions, notes) can't hold a guest's id.
- One reaction per guest per track (unique index, E11000).
- Taps live at most 180 days (TTL index); check-ins and tonight-only sessions expire too.

## How fast it is (measured on the Atlas sandbox, 2026-11-14)

- A guest checks in and their taste changes the room: the room plays a track made for it about 4 seconds later (ElevenLabs takes about 2.5 seconds of that).
- Five simulated guests tap a new sound: a new track made for the room is playing about 6 seconds later.
- Forget me: the room crossfades to the track it promised without the guest about 2.3 seconds after the request, and the full receipt arrives about a second later, once the pick has been recomputed from what is left in the database. With the durable forget job on, add about 1.5 seconds.

## How forget me reaches every copy

Crowd memory holds no identities, so how does forget me find your share? Each crowd memory document lists the tap ids it was built from (`derivedFrom`), and taps belong to the guest. Forget me starts at your taps and runs `$graphLookup` over `derivedFrom`: depth 0 finds your taste and every venue's crowd memory you fed; depth 1 finds the decisions built from those. In one transaction it deletes your taps, taste, check-ins, consents, tonight sessions and bored records, rebuilds each crowd memory from the taps that remain (removing it if fewer than 3 people are left), unlinks your taste from past decisions, and writes a text-free receipt (an HMAC of your id plus counts). Then both rooms re-pick and play the new pick at once.

## Sponsor technology

| Product | What it does here |
|---|---|
| MongoDB Atlas (Cluster0, MongoDB 9.0) | The system of record: taps, taste, crowd memory, decisions, plays |
| Atlas change streams | Drive the room screens: a new play or decision in the database is what moves the screen and the music |
| Atlas Vector Search | Picks every next track: `$vectorSearch` (exact) with the blended memory as the query and energy and BPM pre-filters |
| Atlas transactions + `$graphLookup` | Forget me, bored of this and undo, across every venue in one commit |
| Atlas schema validation (`constraint`), unique and TTL indexes | The 121 and E11000 refusals; expiry of taps, check-ins and tonight sessions |
| Atlas database users + Views | One login per venue; the 13 refusals |
| Voyage AI (`voyage-4`) | Embeds each clip's text description (genre, tempo, energy, sound) |
| ElevenLabs Music | Generated the 19-clip catalogue (`music_v2`), and composes new tracks live (`music_v2_5`, composition plan) when the crowd's taps move a room to a new sound |

## Run it

```bash
pnpm install
cp .env.example .env      # fill in the Atlas host, logins, Voyage and ElevenLabs keys
pnpm setup:db             # collections, validators, indexes, Views, track embeddings
pnpm setup:vector         # Vector Search index on tracks
pnpm start                # http://localhost:4377/
pnpm smoke                # end-to-end checks against the running server
```

- **Start here:** `http://localhost:4377/` lists the steps. Rooms: `/room/copper`, `/room/basement`. Guest page: `/join/copper`. Proofs: `/proof`.
- **Phones on the same Wi-Fi:** `pnpm lan` serves on the laptop's LAN address and puts it in the QR codes. Some guest Wi-Fi blocks phone-to-laptop traffic; then open `/p/<guest>` tabs on the laptop.
- **Database users** are created in Atlas (UI, CLI or Admin API), not by the driver: the app user with `readWrite` and `dbAdmin` on `edmRoom`, and one user per venue with `read` on that venue's View only.
- **Reset:** `POST /api/reset` (regulars from last weekend), or `POST /api/film/reset` (adds Jess, a guest with techno taste who hasn't checked in yet, and four quiet guests in Copper Room).
- **Live music:** start with `MUSIC_LIVE=1 pnpm start`. Without it, rooms play the catalogue only.
- **Room controls** (reset, skip, simulated guests, proofs) work only from the laptop itself; through a tunnel or from another device they return 403.

## What's simulated and what isn't

- **Real:** every database rule, refusal, transaction, change stream and vector search above runs live on Atlas. The clips are real ElevenLabs Music generations. The embeddings are real Voyage calls (cached on disk so a reset doesn't spend the rate limit).
- **Simulated:** the venues, their regulars from "last weekend" and the guests are seeded. A **Simulated guests** button makes five seeded guests like two samples of one sound, so the room can be shown without phones; it is labelled as simulated on screen. The time of night is a demo clock ("Next hour"). Clips are 15 seconds, so a room's set moves fast. "Tonight only" lasts 2 minutes in the demo.
- **Not built:** real venue sound systems or DJ software; the room plays clips in a browser. Transitions are crossfades (1 second between catalogue tracks, about 3 seconds with filter sweeps into a new track), not beat-matched mixing.
- **Limits we know about:** Atlas backups and the oplog keep data for their own retention windows; the validator checks what the server writes onto a document (it trusts the copied owner ids). TTL expiry runs about once a minute, not instantly. A pick reveals a little about who is in the room. Live composition sends ElevenLabs only genre, tempo and texture words from the room's blend, never anything about a guest. A composed track's record keeps the room's mix, the number of people behind it (3 or more) and the tap ids it was built from, so forget me deletes it and its file; copies ElevenLabs keeps under its own terms are outside this app's reach. Live composition is capped at 60 tracks a day and one per room every 20 seconds.

## Prior art

- Rockbot already remembers guests' favourite songs across its venues, and TouchTunes and Rockbot let guests vote on what plays. Carrying taste between venues is not new; consent per venue, private crowd memory and forget-me across every venue are what this adds.
- Spotify's "exclude from your taste profile" and Taste Profile controls change recommendations "within 48 hours" or "a few hours", for one listener.
- Taste APIs such as Qloo model taste across domains; Musory keeps taste with the person and lets them take it back.

## License

MIT. See [LICENSE](LICENSE).
