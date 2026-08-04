# ♞ Chess Arena — สนามหมากรุกสากล vs AI

สนามหมากรุกสากลคุณภาพระดับ lichess ที่รันบนเบราว์เซอร์ได้เลย (GitHub Pages 100%):

- **เล่น vs AI** — สู้กับเอนจิน **Stockfish 18** (ตัวที่ chess.com ใช้) ระดับปรับได้ 1–8
- **AI vs AI** — เปิดชม Stockfish ปะทะ Stockfish เอง
- **ต่อสู้ Remote** — สนามนี้เล่นกับ **AI ตัวอื่นที่อยู่นอกสนาม** ผ่านโปรโตคอล Gist (ดู `docs/agent-battle.md`) — สร้างห้อง ส่ง URL ให้ AI คู่แข่ง แล้วสู้กันจริง
- **วิเคราะห์** — กระดานฝึกเดินเล่นเองทั้งสองสี

## เทคโนโลยี

| ชิ้นส่วน | ไลบรารี | หมายเหตุ |
| --- | --- | --- |
| กระดาน + หมาก + แอนิเมชัน | [chessground](https://github.com/lichess-org/chessground) 9.2 | UI ตัวเดียวกับ lichess |
| กติกาหมากรุก | [chess.js](https://github.com/jhlywa/chess.js) 1.4 | SAN, FEN, ตรวจผลเสมอ/แพ้ชนะ |
| เอนจิน | [stockfish](https://github.com/nmrugg/stockfish.js) 18 (lite single) | รันในเบราว์เซอร์ **ไม่ต้องใช้ header พิเศษ** — ใช้กับ GitHub Pages ได้ |
| Build | Vite 7 | Static SPA, `base: './'` รองรับ subpath |

## รัน

```bash
npm install
npm run dev        # เล่นในเครื่อง
npm run build      # build ไป dist/
npm run deploy     # build + push ขึ้น GitHub Pages (gh-pages branch)
```

## เล่น vs AI ระดับ 1–8

ระดับ 1–3 = เหมาะสำหรับมือใหม่, 4–6 = ผู้เล่นทั่วไป, 7–8 = ระดับทัวร์นาเมนต์
(ระดับปรับผ่าน UCI `Skill Level` + จำกัดความลึกและเวลา — เอนจินยังเป็นตัวจริง 100%)

## ต่อสู้ Remote (AI ตัวนอก)

1. เปิดโหมด **ต่อสู้ Remote** → **สร้างห้อง**
2. ใส่ GitHub Token ของคุณ (scope `gist` — เก็บเฉพาะใน localStorage ของเบราว์เซอร์)
3. เลือกว่าสนามนี้เล่นเป็นฝ่ายขาว/ดำ/สุ่ม แล้วสร้างห้อง
4. ระบบจะคัดลอก URL ห้องให้ — **ส่ง URL นี้ให้ AI คู่แข่ง**
5. คู่แข่งใช้โปรโตคอลใน `docs/agent-battle.md` (มี client ตัวอย่าง `scripts/agent-client.mjs`) อ่านห้องและเดิน
6. สนามจะ poll ห้องทุก 2.5 วินาที ซิงก์กระดานอัตโนมัติ และเอนจินจะตอบกลับ

> หมายเหตุ: GitHub API ไม่คิดค่าใช้จ่าย แต่ poll บ่อยๆ จะติด rate limit (60 ครั้ง/ชม. แบบไม่ล็อกอิน) — ถ้าเป็นห้องสาธารณะที่ไม่มี token แนะนำ poll ≥ 2.5 วินาที (ค่าเริ่มต้น)

## โครงสร้าง

```
public/engine/        เอนจิน Stockfish (js + wasm) — คัดลอกจาก node_modules โดย scripts/copy-engine.mjs
src/config.js         ค่าคงที่: ระดับ, ความเร็ว, ชื่อ
src/engine.js         UCI client (Worker wrapper)
src/controller.js     state machine ของทุกโหมด
src/remote.js         โปรโตคอลห้องประลอง (GitHub Gist)
src/ui.js             DOM helper
src/main.js           bootstrap + ไดอะลอก
scripts/copy-engine.mjs   คัดลอกเอนจินเข้า public/
scripts/agent-client.mjs  client ตัวอย่างสำหรับ AI ภายนอก
docs/agent-battle.md      โปรโตคอลการประลอง (สำหรับ AI คู่แข่ง)
```

## เปลี่ยนเอนจินเป็นตัวเต็ม (แข็งกว่า แต่ใหญ่กว่า)

```bash
node scripts/copy-engine.mjs full-single   # ~40MB
```

แล้วแก้ `ENGINE_WORKER_URL` ใน `src/config.js` เป็น `./engine/stockfish-18-single.js`

## License

โค้ดของสนามนี้ MIT — เอนจิน Stockfish ตัวที่รวมมาคือ GPLv3 (ดู `node_modules/stockfish/Copying.txt`), chess.js MIT, chessground GPLv3
