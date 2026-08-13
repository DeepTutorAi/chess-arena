# ♞ Chess Arena — สนามหมากรุกสากล vs AI

สนามหมากรุกสากลที่รันบนเบราว์เซอร์ พร้อมห้องผู้เล่นออนไลน์แบบ server-authoritative:

- **เล่น vs AI** — สู้กับเอนจิน **Stockfish 18** (ตัวที่ chess.com ใช้) ระดับปรับได้ 1–8
- **AI vs AI** — เปิดชม Stockfish ปะทะ Stockfish เอง
- **เล่นออนไลน์** — สร้างห้อง ส่งลิงก์ให้ผู้เล่นอีกคน และให้ Cloudflare Durable Object ตรวจตาเดินทุกครั้ง
- **ต่อสู้ Remote Agent (Legacy)** — AI ภายนอกยังใช้โปรโตคอล Gist ผ่านสคริปต์ใน `scripts/` ได้ตาม `docs/agent-battle.md`; player UI ไม่ขอ GitHub Token แล้ว
- **วิเคราะห์** — กระดานฝึกเดินเล่นเองทั้งสองสี

## เทคโนโลยี

| ชิ้นส่วน | ไลบรารี | หมายเหตุ |
| --- | --- | --- |
| กระดาน + หมาก + แอนิเมชัน | [chessground](https://github.com/lichess-org/chessground) 9.2 | UI ตัวเดียวกับ lichess |
| กติกาหมากรุก | [chess.js](https://github.com/jhlywa/chess.js) 1.4 | SAN, FEN, ตรวจผลเสมอ/แพ้ชนะ |
| เอนจิน | [stockfish](https://github.com/nmrugg/stockfish.js) 18 (lite single) | รันในเบราว์เซอร์ **ไม่ต้องใช้ header พิเศษ** — ใช้กับ GitHub Pages ได้ |
| Build | Vite 7 | Static SPA, `base: './'` รองรับ subpath |
| ห้องผู้เล่นออนไลน์ | Cloudflare Workers + SQLite Durable Objects | WebSocket, one-time invite, server-authoritative chess.js |

## รัน

```bash
npm install
npm run dev        # เล่นในเครื่อง
npm run build      # build ไป dist/
npm run deploy     # build + push ขึ้น GitHub Pages (gh-pages branch)
```

## ห้องผู้เล่นออนไลน์แบบฟรี

รัน Worker และ Vite แยกกัน:

```bash
npx wrangler dev --port 8787
```

อีก PowerShell terminal:

```powershell
$env:VITE_ONLINE_API_URL="http://localhost:8787"
npm run dev
```

เปิดเว็บ กด **CREATE GAME → Play Online** ใส่ชื่อและสร้างห้อง จากนั้นส่งลิงก์เชิญให้ผู้เล่นอีกคน ลิงก์มี invite capability อยู่หลัง `#invite=` และใช้ claim ที่นั่ง guest ได้ครั้งเดียว หลัง join แล้วแต่ละ browser จะเก็บ session capability เฉพาะห้องนั้นเพื่อ reconnect

ถ้า deploy frontend และ Worker ที่ origin เดียวกันตาม `wrangler.jsonc` ปัจจุบัน ไม่ต้องเพิ่ม production origin ใน `ALLOWED_ORIGINS` เพราะ Worker อนุญาต same-origin โดยตรง หากแยก frontend ไปอยู่อีกโดเมนจึงค่อยเพิ่ม origin นั้น แล้วรัน:

```bash
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` จะส่งทั้ง Worker และไฟล์หน้าเว็บใน `dist/` ขึ้น origin เดียวกัน หน้า production จึงใช้ URL ปัจจุบันเป็น API ได้ทันทีโดยไม่ต้องตั้ง `VITE_ONLINE_API_URL` ตัวแปรนี้ยังใช้สำหรับ local dev หรือกรณีที่แยก frontend/backend คนละ origin เท่านั้น ไม่มี Cloudflare credential หรือ session/invite capability ใดถูกกำหนดเป็น `VITE_*`

คำสั่งตรวจสอบ:

```bash
npm test
npm run build
npx wrangler deploy --dry-run
```

## เล่น vs AI ระดับ 1–8

ระดับ 1–3 = เหมาะสำหรับมือใหม่, 4–6 = ผู้เล่นทั่วไป, 7–8 = ระดับทัวร์นาเมนต์
(ระดับปรับผ่าน UCI `Skill Level` + จำกัดความลึกและเวลา — เอนจินยังเป็นตัวจริง 100%)

## ต่อสู้ Remote Agent แบบเดิม (AI ตัวนอก)

โปรโตคอล Gist ยังคงอยู่เพื่อความเข้ากันได้ของ terminal AI clients แต่ไม่ได้แสดงใน player-facing UI ดูวิธีใช้และ trust model ใน `docs/agent-battle.md`

### รันเอนจินสนามจากเทอร์มินัล (ไม่ต้องเปิด tab ทิ้งไว้)

```bash
node scripts/arena-host.mjs <gistId> <token> <w|b> [movetimeMs]
```

โหลด Stockfish 18 ใน Node แล้ว poll ห้องทุก 2.5 วิ — เมื่อถึงตาฝ่ายสนามจะคำนวณและเขียนท่าลงห้องให้อัตโนมัติ (ใช้ CAS เดียวกับ agent-client ป้องกันชนกัน)

> หมายเหตุ: GitHub API ไม่คิดค่าใช้จ่าย แต่ poll บ่อยๆ จะติด rate limit (60 ครั้ง/ชม. แบบไม่ล็อกอิน) — ถ้าเป็นห้องสาธารณะที่ไม่มี token แนะนำ poll ≥ 2.5 วินาที (ค่าเริ่มต้น)

## โครงสร้าง

```
public/engine/        เอนจิน Stockfish (js + wasm) — คัดลอกจาก node_modules โดย scripts/copy-engine.mjs
src/config.js         ค่าคงที่: ระดับ, ความเร็ว, ชื่อ
src/engine.js         UCI client (Worker wrapper)
src/controller.js     state machine ของทุกโหมด
src/online.js         client ห้องผู้เล่นออนไลน์ (HTTP + WebSocket)
worker/               Worker router, Durable Object, authoritative chess domain
wrangler.jsonc        Cloudflare Worker/SQLite Durable Object configuration
src/remote.js         โปรโตคอล Remote Agent เดิม (GitHub Gist)
src/ui.js             DOM helper
src/main.js           bootstrap + ไดอะลอก
scripts/copy-engine.mjs   คัดลอกเอนจินเข้า public/
scripts/agent-client.mjs  client ตัวอย่างสำหรับ AI ภายนอก
scripts/arena-host.mjs    รันเอนจินสนามจากเทอร์มินัล (ไม่ต้องเปิด tab)
docs/agent-battle.md      โปรโตคอลการประลอง (สำหรับ AI คู่แข่ง)
```

## เปลี่ยนเอนจินเป็นตัวเต็ม (แข็งกว่า แต่ใหญ่กว่า)

```bash
node scripts/copy-engine.mjs full-single   # ~40MB
```

แล้วแก้ `ENGINE_WORKER_URL` ใน `src/config.js` เป็น `./engine/stockfish-18-single.js`

## License

โค้ดของสนามนี้ MIT — เอนจิน Stockfish ตัวที่รวมมาคือ GPLv3 (ดู `node_modules/stockfish/Copying.txt`), chess.js MIT, chessground GPLv3
