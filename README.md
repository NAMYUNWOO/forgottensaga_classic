# 포가튼사가 (Forgotten Saga) — Web Build

1997 한국 DOS RPG "포가튼사가" 의 Love2D 재구현 web build.

**Play**: https://namyunwoo.github.io/forgottensaga_classic/

원본 source: https://github.com/NAMYUNWOO/forgottensaga-love2d

## 구조

- `index.html` — 게임 entry. love.js loader + 모바일 컨트롤러 + Save controls.
- `game.data` (~88 MB) — Love2D 자산 (sprite, BGM, SCP, FAM 등) preloaded.
- `game.js` / `love.js` / `love.wasm` / `love.worker.js` — emscripten port of LÖVE 11.5.
- `coi-serviceworker.js` — COOP/COEP 헤더 inject (SharedArrayBuffer 활성, GitHub Pages 한계 우회).
- `mobile_input.{css,js}` — 모바일 가상 조이스틱 + 버튼 + 한국어 IME.
- `save_controls.{css,js}` — sav 다운로드/업로드 (IndexedDB direct).
- `theme/` — love.js 의 splash CSS.

## 컨트롤

- **PC**: 방향키 / Enter / Space / ESC. 한국어 입력은 OS IME (Cmd+Space 등).
- **모바일**: 좌하단 4방향 조이스틱 + 우하단 esc/space/enter. 키보드 버튼 클릭 시 textbox 등장.

## 한계

- love.js 의 emscripten Lua 5.1 환경 (LuaJIT 미사용) — 데스크톱 빌드 대비 약간 느림 (체감 적음).
- 첫 진입 시 game.data 88 MB 다운로드. 이후 IndexedDB cache.
- 사운드 audio context 는 첫 사용자 입력 (키 / 터치) 후 활성 (브라우저 정책).

## 라이선스

원본 게임 자산 저작권은 원 권리자에게. 본 web build 는 역공학 / 연구 / 보존 목적.
