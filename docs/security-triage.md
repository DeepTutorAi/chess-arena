# Security Triage — Mimosa L3 SSRF findings (2026-09-06)

ผลการตรวจสอบข้อหา "SSRF ระดับ high" ที่ Mimosa L3 รายงานก่อน commit
อ้างอิง sealed scan: `scan-2026-09-05T22-59-38.690Z-22d00b972b46`
(seal `sha256:a6c36d5e...7ff03`, run status `inconclusive`,
ทุก finding เป็น `static-finding` advisory พร้อม proof gap
"ต้องยืนยันสายข้อมูลจริงและการ exploit ได้ด้วยมนุษย์", `verdictEffect: none`)

## สรุป: ทั้งหมดเป็น false positive — ไม่มีช่องโหว่ SSRF จริง

| ตำแหน่งที่ถูก flag | ข้อเท็จจริงจากซอร์สโค้ด |
| --- | --- |
| `worker/index.js:110,153,167,181,195` | เป็น `roomStub(env, id).fetch('http://room/...')` และ `lobbyStub(env).fetch('http://lobby/list')` — คือ **Durable Object stub** ของ Cloudflare ซึ่ง URL เป็น **string literal ภายใน** ใช้เป็น routing key เท่านั้น ไม่มีข้อมูลจากผู้ใช้เข้าไปใน URL เลย ข้อมูลผู้ใช้เดินทางผ่าน JSON body เท่านั้น ส่วน `id` ที่ใช้เลือก DO ถูก regex จำกัดเป็น base32 16 ตัว (`/^[a-z2-7]{16}$/u`) ไม่มีทางเป็น URL เป้าหมาย |
| `src/online.js:325,333,341` | โค้ดฝั่ง **browser** — `fetch` ไปยัง `this.apiUrl` (มาจาก env var `VITE_ONLINE_API_URL` หรือ origin ของหน้าเว็บเอง ตรวจด้วย regex) ต่อ path ที่สร้างจาก room id ที่ validate แล้ว SSRF นิยามบน "server fetch ไป URL ที่ผู้โจมตีควบคุม" — โค้ดที่รันในเบราว์เซอร์ของผู้ใช้เองไม่เข้าข่าย |
| `public/engine/stockfish-18-lite-single.js:11` | ไฟล์ engine glue ที่ vendor มา (minified third-party) โหลดเป็น **Web Worker ในเบราว์เซอร์** ไม่ใช่โปรเซสเซิร์ฟเวอร์ ข้อหา "命令行参数 (command-line args) → SSRF" จึงเป็นไปไม่ได้ตามโครงสร้าง |
| `dist-preview/assets/index-*.js` | build artifact เก่าที่ถูก gitignore (ไม่อยู่ใน commit) ถูกลบออกจากเครื่องแล้วเพื่อลด noise ของ scanner — ข้อหาที่เหลืออ้างอิงไฟล์นี้จาก **cache ของ hook** ไม่ใช่ไฟล์ที่ยังมีอยู่ |

## หลักฐานสนับสนุน

- Sealed scan ฉบับทางการระบุทุก finding เป็น **advisory** (`advisory: true`) ไม่มี
  taint trace ที่ validate แล้ว (`pathAnalysis.traces: 0`) และตัว scan เองประเมิน
  `runStatus: inconclusive` พร้อมระบุช่องว่างว่า call graph อาจไม่ครบ
- รูปแบบ `durableObjectStub.fetch('http://<internal-key>')` เป็น pattern มาตรฐาน
  ของ Cloudflare Durable Objects — scanner ทั่วไปมัก pattern-match จน false positive
- ไม่มีจุดใดใน worker ที่ fetch ไปยัง URL ที่มาจาก input ผู้ใช้ (ตรวจด้วย
  `rg "fetch\("` บน `worker/` — ทุก call site เป็น literal)

## สิ่งที่ทำแล้วเพื่อลด noise

- ลบ `dist-preview/` (stale build artifact, gitignored อยู่แล้ว)

## สถานะ

ไม่มีการแก้โค้ดที่ต้องทำจากข้อหาชุดนี้ หากต้องการให้ gate ยอมรับ
ต้องปรับ policy ฝั่ง Mimosa hook (acknowledge findings เหล่านี้) หรือ
commit นอกช่องทางที่ hook ดักกล่าว

## 2026-09-06: Math.random() ใน controller.js (_thinkTime) — false positive

Mimosa แจ้ง "弱随机数/weak randomness" ที่ `Math.random()` ใน `_thinkTime()`
(controller.js ~บรรทัด 1370-1396) ระหว่างแก้ delay ของ AI

**ประเมิน: ไม่ใช่ช่องโหว่** — `Math.random()` ถูกใช้กับจังหวะพักก่อนบอทเดิน
(humanized pacing jitter) เท่านั้น ไม่มีผลด้านความปลอดภัยใดๆ:
- ไม่เกี่ยวกับ token/capability/session (capability tokens ของ worker ใช้
  `crypto.getRandomValues` อยู่แล้วใน lobby-registry/room)
- การคาดเดา delay ของบอทได้ไม่สร้างผลกระทบเชิงความปลอดภัย

จึงไม่แก้โค้ด และเพิ่ม comment กำกับที่จุดเรียกแล้ว

## 2026-09-07: Commit-time SSRF findings ก่อน commit ระบบรีวิว — false positives (ชุดเดิม)

Mimosa L3 บล็อค commit ครั้งแรก: 11 high + 11 medium, ทั้งหมดเป็น "SSRF/Request
入口" ที่ worker/index.js, src/online.js, public/engine/stockfish-18-lite-single.js
และ dist-preview/assets/*.js

**ประเมิน: false positive ชุดเดียวกับบันทึกด้านบน** — ไฟล์ที่ถูกแจ้ง**ไม่ได้อยู่ใน
staged changes เลย** (staged = ระบบรีวิว: analyzer/review-ui/openings/controller/
styles/tests):
- worker/index.js — fetch ทั้งหมดเป็น literal ไปยัง GitHub API/Durable Object stub
  ตามบันทึก 2026-09-06 (ตรวจ `rg "fetch\(" worker/` แล้ว ไม่มี URL จาก input ผู้ใช้)
- src/online.js — request เรียก API worker ของโปรเจกต์เองด้วย URL คงที่จาก config
- stockfish-18-lite-single.js — engine bundle ของบุคคลที่สาม (obfuscated wasm
  loader) ไม่ใช่โค้ดที่เราเขียน
- dist-preview/ — build artifact ที่ gitignored แล้ว; เศษไฟล์ค้างในดิสก์
  ลบออกอีกครั้งเพื่อลด noise (สร้างใหม่ด้วย `npm run build` ได้เสมอ)

จึงไม่แก้โค้ดจากข้อหาชุดนี้ พร้อม commit ระบบรีวิวต่อ

## 2026-09-29: Commit-time SSRF 12 high + 1 medium ก่อน commit roadmap — false positives (ชุดเดิม + engine multithread)

Mimosa L3 บล็อค commit รอบ commit ระบบรีวิว/PWA/openings: 12 high + 1 medium

**ประเมิน: false positive ชุดเดิมตามบันทึก 2026-09-06/09-07** โดยมีจุดใหม่คือ
`public/engine/stockfish-18-lite.js` (ตัว multithread) ที่ถูก stage ครั้งนี้เป็นครั้งแรก:

- `worker/index.js:110,153,167,181,195` — ชุดเดิมทุกประการ (Durable Object stub
  fetch ด้วย string literal + GitHub API URL คงที่) ตามบันทึก 2026-09-06
- `src/online.js:326,334,342` — ชุดเดิม: fetch ฝั่ง browser ไปยัง API worker
  ของโปรเจกต์เอง ด้วย URL คงที่จาก config ไม่เข้าข่าย SSRF ตามนิยาม
- `public/engine/stockfish-18-lite.js:11` (+ `-single.js:11` ที่ flag ซ้ำ) —
  ยืนยันจากซอร์ส: เป็น glue ของแพ็กเกจ npm `stockfish@^18.0.8` (Chess.com LLC,
  GPLv3) คัดลอกมา verbatim จาก `node_modules/stockfish/bin/` โดย
  `scripts/copy-engine.mjs` รันเป็น **Web Worker ในเบราว์เซอร์** ไม่ใช่โปรเซส
  เซิร์ฟเวอร์ — ข้อหา SSRF/命令行参数 จึงเป็นไปไม่ได้ตามโครงสร้าง เช่นเดียวกับ
  `-single.js` ที่ triage ไว้แล้ว

จึงไม่แก้โค้ดจากข้อหาชุดนี้ — รัน Mimosa scan ใหม่ผ่านช่องทางทางการเพื่อให้ได้
sealed scan ประจำ commit นี้ แล้ว commit ตามกระบวนการเดิม (ไม่มีการ bypass hook)

Sealed scan ประจำรอบนี้: `scan-2026-09-28T18-36-08.431Z-99a0388f56b9`
(seal `sha256:1c766ebf...11714fa`, deep scan, 13 findings — ตรงชุดที่ hook
รายงาน, `verdictEffect: none` คือ advisory ไม่มีผลตัดสิน, dependency scan
167 packages ไม่มี advisory ที่ match)
