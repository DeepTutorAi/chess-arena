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
