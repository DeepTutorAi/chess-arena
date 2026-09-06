# Firebase Realtime Architecture & Deployment Roadmap (Token-Free Online & Time Controls)

> **สถานะ: HISTORICAL / ไม่ได้ใช้งาน** — เป้าหมาย "Token-Free Online" ของเอกสารนี้
> เสร็จสิ้นแล้วด้วยสถาปัตยกรรมปัจจุบัน (Cloudflare Workers + Durable Objects,
> capability tokens) ตามที่อธิบายใน README สคีมาและแผน Firebase ด้านล่างไม่ตรงกับ
> โค้ดที่ implement จริง เก็บไว้เป็นข้อมูลอ้างอิงทางเลือกเท่านั้น

This document outlines the architecture, database schema, and migration roadmap for moving **Chess Arena** to **Firebase Realtime Database** and **Firebase Hosting**.

---

## 1. Key Objectives & UX Upgrades

1. **Token-Free Online Matchmaking**:
   - Users no longer need to generate or paste GitHub Personal Access Tokens.
   - Rooms are created anonymously via Firebase Auth (`signInAnonymously()`) with zero friction.
2. **Real-time Synchronization (< 50ms Latency)**:
   - WebSocket push listeners (`onValue`) replace HTTP polling for instant move updates and real-time clock countdowns.
3. **Dynamic Time Controls & Custom FEN Setup**:
   - Supports 1 min Bullet, 3 min Blitz, 5 min, 10 min Rapid, and Unlimited time controls.
   - Preserves custom FEN setups configured in **Sandbox mode**.
4. **Firebase Hosting Deployment**:
   - Production SSL deployment via single command `npx firebase-tools deploy --only hosting`.

---

## 2. Firebase Realtime Database Schema

```json
{
  "rooms": {
    "$roomId": {
      "title": "ANKIDUN Dares You: Respect the Gambit",
      "createdAt": 1785871600000,
      "status": "WAITING",
      "host": {
        "uid": "user_anon_123",
        "name": "คุณ",
        "avatar": "👤",
        "color": "w"
      },
      "guest": {
        "uid": "user_anon_789",
        "name": "Guest Opponent",
        "avatar": "🔥",
        "color": "b"
      },
      "gameState": {
        "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
        "pgn": "1. e4",
        "turn": "b",
        "lastMove": { "from": "e2", "to": "e4" },
        "clocks": {
          "w": 300000,
          "b": 300000,
          "lastUpdated": 1785871605000
        }
      },
      "settings": {
        "timeControlId": "rapid_10_0",
        "initialMs": 600000,
        "incMs": 0,
        "customFen": ""
      }
    }
  }
}
```

---

## 3. Firebase Integration & Anonymous Auth Setup

### Install Dependencies
```bash
npm install firebase
```

### SDK Initializer (`src/firebase.js`)
```javascript
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue, set, update, push } from 'firebase/database';
import { getAuth, signInAnonymously } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "chess-arena-app.firebaseapp.com",
  databaseURL: "https://chess-arena-app-default-rtdb.firebaseio.com",
  projectId: "chess-arena-app"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

// Authenticate user token-free
export async function ensureAuth() {
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
  return auth.currentUser;
}
```

---

## 4. Hosting Deployment Guide

### Project Initialization
```bash
npx firebase-tools login
npx firebase-tools init hosting
# Select dist directory and single-page app
```

### Production Build & Deploy
```bash
npm run build
npx firebase-tools deploy --only hosting
```
