# Chess Arena — Roadmap ถัดไป (2026-09-07)

คัดจากไอเดียที่ผู้ใช้เลือก: 2 (puzzle run), 3 (opening names), 4 (critical moments),
6 (rematch), 7 (live eval ตอนชม), 9 (PWA), 10 (Stockfish หลายเธรด)
เรียงตามคำแนะนำ: **เก็บชุดรีวิวก่อน → protocol → spectator → infra**
หลักการเดิม: ทุกงาน client-side ก่อนเท่าที่ทำได้, ไม่เพิ่ม dependency ถ้า stdlib พอ,
ทุกชุดต้องมีเทส + build ผ่านก่อนขึ้น, ผู้ใช้ commit เอง (Mimosa gate)

---

## ระลอก A — ธีมรีวิว (pure client, ต่อจาก retry ที่เพิ่งแก้)

### A1. Critical Moments บน advantage graph ✅ เสร็จ 2026-09-07
- [x] คำนวณตอน build ผลรีวิว (analyzer.js): หาจุดที่ `whiteWinProb` แกว่ง ≥ 15 ระหว่างตำแหน่งติดกัน
      เลือก local-maxima ไม่เกิน 3 จุด (dedupe ตำแหน่งที่อยู่ติดกัน) → `analysis.criticalMoments`
      (export `findCriticalMoments(positions, plies, {threshold, maxMoments})`, moment = {ply, san, lost, swingPct})
- [x] UI: จุดสีส้มบนกราฟ (`.adv-cm-dot` + tooltip native "จังหวะชี้ขาด: <san>") กดกระโดดไปตานั้น
- [x] การ์ดสรุป: แถว "CRITICAL MOMENTS · จังหวะชี้ขาด" ปุ่ม "ตา N · san (เสีย/ได้ x%)" สีแดง/เขียว
- เทส: analyzer.test.js (+6 unit/integration) + review-critical.test.js (+3 DOM) → domain 99/99 + build ผ่าน
- หมายเหตุ: E2E บนเบราว์เซอร์ข้าม (ผู้ใช้กำลังใช้เครื่อง) — ครอบด้วยเทส DOM แทน
- ขนาด: **S**

### A2. Opening names (ECO) ✅ เสร็จ 2026-09-07
- [x] สคริปต์ `scripts/build-openings.mjs` (`npm run openings`): ดึงชุด openings จาก
      lichess-org/chess-openings (CC0) — fetch ก่อน fallback `gh api` — trim → `public/assets/openings.json`
      **3,208 lines ~337KB** (รูปแบบ `{ moves: "e4 c5", eco: "B20", name: "Sicilian Defense" }` เรียงตาม moves,
      strip +/#, ตัดแถว SAN แปลก ๆ และเส้นยาวเกิน 14 ตา)
- [x] `src/openings.js`: `OpeningBook.lookup(sanMoves)` — หาเส้นที่ยาวที่สุดที่เป็น prefix ของเกม
      (normalize +/# สองฝั่ง) → `{eco, name, plies}`; `getOpeningBook()` lazy fetch + cache, ล้มเหลว = null
- [x] analyzer: `GameReviewAnalyzer({openingBook})` → `analyzeGame` lookup จาก SAN →
      `buildAnalysisResult(..., opening)`; tier "Book" อิง matched line จริง (plies < opening.plies),
      หลุดเส้นแล้วเกรดปกติ; ไม่ match → fallback เกณฑ์ ply ≤ 10 เดิม; payload มี `analysis.opening`
- [x] UI: summary modal + stepper overview โชว์ "📖 C60 · Ruy Lopez" (`.review-opening`)
- [x] controller `startReview`: `getOpeningBook()` ก่อน `analyzeGame` (ไม่ block/ไม่พังถ้าโหลดไม่ได้)
- เทส: openings.test.js (+5 lookup) + analyzer (+1 Book rule: ในเส้น=book เกินเส้น=best/blunder,
  fallback ยังเดิม) + review-opening.test.js (+4 DOM) → **domain 109/109 + build ผ่าน + dist copy ยืนยัน**
- smoke ข้อมูลจริง: e4 c5 Nf3 d6 → B50 Sicilian: Modern Variations, e4 e5 Nf3 Nc6 Bb5 → C60 Ruy Lopez,
  แม้แต่ 1.a3 → A00 Anderssen's Opening
- หมายเหตุ: browser E2E ถูกขัดจังหวะ (ผู้ใช้เริ่มใช้เบราว์เซอร์เอง) — เล่นถึง 1.e4 c5 2.Nf3 d6 3.d4 Nf6
  ก่อนหยุด; ครอบด้วยเทส DOM แทน
- ขนาด: **M**

### A3. Puzzle Run — "ท้าทาย: แก้ทุกตาพลาดของเกมนี้" ✅ เสร็จ 2026-09-07
- [x] รวบรวม plies ที่ tier ∈ {inaccuracy, mistake, blunder, miss} + bestMove เป็นชุดปริศนา
- [x] `startPuzzleRun()` ใน review panel: เล่นไล่ทีละข้อจากตำแหน่งก่อนตาพลาด — reuse เครื่องจักร
      retry-sim ทั้งหมด (`_setRetryBoard`/`_onRetryMove`/`_onSimBestMove`, engine worker 1 ตัวต่อ run,
      token guard, promotion flow เดิม): ถูก = +1 คะแนนไปข้อถัดไปทันที, ผิด = ดำตอบบนกระดาน
      → เฉลย + "ข้อถัดไป →"; มี ข้ามข้อ / จบการฝึก (ทุกเส้นทางผ่าน `_stopSimLine`)
- [x] สรุปท้าย run: x/y, สตรีคยาวสุด, สตรีคสูงสุดต่อเกมใน localStorage
      (`chess-arena:puzzle-best:<initialFen>#<plies>` ผ่าน window.localStorage + try/catch)
- [x] จุดเข้า: ปุ่ม summary modal "🎯 ฝึกแก้ตาพลาด (x ตา)" (ซ่อนเมื่อ 0 ตา) →
      controller `enterBoardStepper(0)` + `startPuzzleRun()`
- Guards: run ล็อก stepper/autoplay/keyboard เหมือน retry; flip/exit review ยกเลิก run สะอาด
- เทส: `test/review-puzzle.test.js` (+6 happy-dom/FakeWorker: run 3 ข้อ ถูก-ผิด-ถูก,
  คะแนน+สตรีค+localStorage, skip, จบก่อนเวลา, cleanup ตอน exit) → **domain 115/115 + build ผ่าน**
- ขนาด: **L**

**DoD ระลอก A:** test:domain ผ่านทั้งหมด + build ผ่าน + E2E เบราว์เซอร์ (เกมสั้น → รีวิว:
จุด critical กดได้, ชื่อแผนโชว์, puzzle run ครบ loop) — รีวิวยังเข้ากับเกมที่ไม่มี opening
match และไม่มี blunder ได้ปกติ

---

## ระลอก B — Rematch ออนไลน์จริง (งาน protocol/Worker) ✅ เสร็จ 2026-09-07

### B1. Rematch action
- [x] protocol เพิ่ม 3 ข้อความ: `rematch-request` / `rematch-accept` / `rematch-decline`
      (ล้วนมี `expectedRevision`); server ตรวจ: เฉพาะเมื่อ `status === 'finished'`, เฉพาะผู้เล่น,
      accept ได้เฉพาะฝ่ายตรงข้ามของผู้เสนอ (`no_rematch_offer`/`rematch_pending` ปฏิเสธพร้อมข้อความ)
- [x] `resetForRematch` (game-state.js): เริ่มเกมใหม่ทันที — **สลับสี** (hostColor↔guestColor,
      players map สลับ role คงชื่อ/อวตาร), ล้าง moves/result/reason, รีเซ็ตนาฬิกา+AFK,
      revision+1, ห้อง/visibility/expiresAt คงเดิม; `toPublicState` ส่ง `rematch` + `hostColor`
- [x] room.js: หลัง accept สำเร็จ อัปเดต serializeAttachment สีของ live sockets ทั้งสองฝั่ง
      (ไม่งั้น move ถัดไปใช้สีเก่าจะโดนปฏิเสธ) — public ห้องกลับเข้า Lobby ผ่าน queueRegistrySync เดิม
- [x] Client: `online.js` requestRematch/acceptRematch/declineRematch; controller
      `_onlineRematchActions()` → game-over card มี "ขอรีเมตช์" (กดแล้ว disabled)/"ยอมรับรีเมตช์"+
      "ปฏิเสธ"; `_onOnlineState` รับ reset (finished→active 0 ตา) = ปิดการ์ดจบเกม, ล้าง clock
      snapshots/รีวิวค้าง, สลับ `onlineSide`+orientation ตาม `state.hostColor` (ส่ง hostColor ใน
      public state แล้ว); toast แจ้งคำขอรีเมตช์ระหว่างรีวิว (`_maybeNotifyReviewRematch`)
- เทส: protocol.test.js (+2) + worker.integration (+2: handshake สลับสีแล้วเล่นต่อได้จริง /
  decline + accept-หลัง-decline-reject) + online-controller.test.js (+2: reset+swap, actions)
- ข้อค้นพบระหว่างเทส: vitest-pool-workers **ทิ้ง server send ก่อน client accept()** — เทส
  connect แล้วต้องส่ง `sync` (browser client ทำอยู่แล้ว)
- ขนาด: **L** — worker 21/21 + domain 119/119 + build ผ่าน

---

## ระลอก C — Live eval ตอนชมแข่ง (spectator / AI Arena) ✅ เสร็จ 2026-09-07

### C1. Spectator eval bar + best-move arrow
- [x] `src/spectator-eval.js` (ใหม่): `SpectatorEval` — เอนจิน 1 ตัวต่อผู้ชม, depth จำกัด 10,
      ค้น "ตำแหน่งปัจจุบันเสมอ": เปลี่ยนตำแหน่งกลางค้น → stop แล้วค้นใหม่เอง; hidden tab → pause,
      กลับมามองเห็น → ค้นต่อ (visibilitychange); disable = พัก (เก็บ worker ไว้ reuse), destroy = quit
- [x] UI: ปุ่ม "ประเมิน" (#btn-analysis, iconTrendingUp) ใน action strip — แสดงเฉพาะโหมดชม
      (aiva + online spectator) ผ่าน `setActionStrip({liveAnalysis})`; toggle = eval bar โชว์
      + ลูกศรเขียว best move บนกระดาน + label "+0.3 · d10"
- [x] Controller: `_syncBoard` ส่ง notifyPosition ทุกครั้งที่ตำแหน่งเปลี่ยน (ทั้ง aiva และ
      online broadcast), score แปลงเป็นมุมมองฝ่ายขาว, dispose ปิดเอนจินสะอาด
- ข้อจำกัดที่รับไว้: eval ผู้ชมตามหลังจังหวะจริง ≤ 1 ครั้งค้น — แสดง "· dN" กำกับความลึกล่าสุด
- เทส: `test/spectator-analysis.test.js` (+4: spawn/ค้น, ตำแหน่งเปลี่ยนกลางค้น→stop+restart,
  hidden→pause/visible→resume, disable=reuse + destroy=quit) + online-controller (+1:
  spectator มี toggle/ผู้เล่นไม่มี) → **domain 120/120 + build ผ่าน**
- ขนาด: **M**

---

## ระลอก D — Infra ✅ เสร็จ 2026-09-07

### D1. PWA (ติดตั้งได้ + offline สำหรับ vs bot/รีวิว)
- [x] `public/manifest.webmanifest` + `public/assets/icons/icon.svg` / `icon-maskable.svg`
      (SVG icons — ไม่เพิ่มไฟล์ binary) + index.html: `<link rel="manifest">` + `theme-color`
- [x] `public/sw.js` เขียนเอง: static (assets/engine/icons/manifest) = cache-first,
      navigation = network-first fallback cache (รับ deploy ใหม่รอบถัดไป),
      **`/api/` + cross-origin = network เท่านั้น**, activate ลบ cache เวอร์ชันเก่า,
      skipWaiting + clients.claim
- [x] main.js: register เฉพาะ non-localhost (dev ไม่โดนแทรก)
- เทส: `test/pwa.test.js` (+3 static guards: manifest ใช้ได้/asset ครบ, index link,
  sw มี api-guard ก่อน cache logic + version cleanup) → smoke ผ่าน vite preview
  (/, sw.js, manifest, icons, engine ทุก route 200)
- ขนาด: **M**

### D2. Stockfish หลายเทรดแบบเลือกได้
- [x] `scripts/copy-engine.mjs` เพิ่ม variant `lite-multi`
      (stockfish-18-lite.js/.wasm ~6.9MB) — คัดลอกเข้า public/engine แล้ว
- [x] config.js: `isCrossOriginIsolated()` + `resolveEngineWorkerUrl({strong})`
      (strong && isolated → lite-multi, อื่น ๆ → lite-single) + preference
      get/set ใน localStorage (try/catch)
- [x] controller `_engineUrl()` → เอนจินเกมจริง (hva/aiva ทั้งสองฝั่ง) ใช้ตาม preference;
      hint ใช้ multi เมื่อเปิดด้วย; spectator analysis / review / forecast คง single-build
      กันแย่งทรัพยากร; Options dialog มีแถว "เอนจินแรงสูง (Multi-thread)" — **ซ่อนเมื่อ host
      ไม่ตั้ง COOP/COEP** (GitHub Pages เห็นเท่าเดิม)
- เทส: `test/engine-config.test.js` (+4: gate true/false/default, preference roundtrip)
  → **domain 120/120 + build ผ่าน**
- หมายเหตุ deploy: ใช้งานจริงต้อง host ที่ตั้ง COOP/COEP (Cloudflare Pages `_headers`:
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`);
  smoke โหลดเอนจินจริงบน host นั้นยังไม่ทำ (ยังไม่มี host ดังกล่าว)
- ขนาด: **M**

---

## สรุปลำดับและขนาด

| ระลอก | งาน | ขนาดรวม | ลักษณะ |
|---|---|---|---|
| A | critical moments → opening names → puzzle run | S + M + L | ต่อยอดรีวิว, client ล้วน |
| B | rematch จริง | L | protocol + Worker + สอง client |
| C | live eval ผู้ชม | M | spectator + จัดการ engine/CPU |
| D | PWA → multithread SF | M + M-L | infra, ประโยชน์ยาว |

เริ่มระลอก A ได้ทันที (ไม่แตะออนไลน์เลย) — เสร็จแต่ละระลอกให้ commit ก่อนขึ้นระลอกถัดไป
ตามธรรมเนียม Mimosa gate

---

## 🔍 Debug pass 2026-09-07 (bugbot deep review — ทุกข้อแก้แล้ว + เทสคลุม)

| # | ระดับ | จุด | สิ่งที่แก้ |
|---|---|---|---|
| 1 | HIGH | controller rematch side-swap ตั้ง orientation = 'b' (chessground ต้องการ 'black') | แปลงเป็น 'black'/'white' + แก้เทสอุปถัมภ์ |
| 2 | HIGH | การ์ดจบเกมย่อเป็น pill แล้วปุ่มรีเมตช์หาย | pill เพิ่ม rematch/onRestore — restore เรียก _reshowGameOver() ที่ derive action สด |
| 3 | HIGH | การ์ดจบเกมไม่รีเฟรชเมื่อคำขอรีเมตช์มาทีหลัง (ปุ่ม stale revision) | _rematchStateKey() (revision:requestedBy) — key เปลี่ยน = close+reshow; key เดิมไม่ re-render |
| 4 | MED | rematch reset ขณะเปิดสรุปรีวิว → โมดัลค้าง | reset block ปิด summary/progress modal ด้วย |
| 5 | MED | spectator analysis ทับ eval bar/ลูกศรของรีวิว | startReview pause + render guard _reviewActive + resume ตอน _finishReviewSession |
| 6 | MED | เอนจิน sim ล่ม → การ์ดค้าง / นับผิดว่าผู้เล่นเดินผิด | phase sim-error "ไม่นับเป็นการเดินผิด" + ลองคำนวณใหม่ (respawn worker) / ข้ามแบบไม่นับ (run) |
| 7 | LOW | openings fetch ล้มครั้งแรก → แคช null ตลอดหน้า | ล้าง cached promise เมื่อ fail → review ถัดไป retry |
| 8 | LOW | sw install fail ถาวรเมื่อออฟไลน์ครั้งแรก | precache shell เป็น best-effort (try/catch) |
| 9 | LOW | spectator worker error หนึ่งครั้ง → เงียบจนกด toggle | notifyPosition respawn worker + ล้าง searchedFen เพื่อค้นซ้ำ |

บัคที่ซ่อนแล้วจับได้จากการเขียนเทสใหม่: _ensureSimEngine/_ensureEngine sync-ready gap
(FakeWorker ตอบภายใน constructor → search แรกหลุด) — แก้ re-bind instance + _runSimSearch
guard ready + ล้าง searchedFen หลัง abort/error ทั้งสองคลาส

**สถานะหลัง debug pass: domain 131/131 + worker 21/21 + build ผ่าน**
