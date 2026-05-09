/* Save 컨트롤 (love.js + Emscripten IDBFS, IndexedDB 직접 access)
 *
 * Davidobot/love.js 빌드의 EXPORTED_RUNTIME_METHODS 에 FS 누락 →
 * Module.FS 직접 사용 불가능. 우회로 IndexedDB API 직접 사용.
 *
 * Emscripten IDBFS layout:
 *   - DB name : mountpoint string (예: '/home/web_user/love')
 *   - Object store : _storeName
 *   - Key  : 절대 path (예: '/home/web_user/love/game/savefiles/saga01.sav')
 *   - Value: { contents: Uint8Array, mode, timestamp }
 *
 * Sync timing 주의: Lua love.filesystem.write 후 IDBFS 에 즉시 반영 안 됨 →
 * love.js 가 자동 syncfs (interval 또는 unmount). 사용자 page reload 후 우리가
 * IDBFS 에서 read 가능. Upload 후엔 page reload 필요.
 */

const SaveControls = (() => {
  const SLOT_FILES = [
    'saga00.sav', 'saga01.sav', 'saga02.sav', 'saga03.sav', 'saga04.sav',
  ];

  // Mount path (Lua 가 sentinel 으로 통보) — read/write 의 key prefix.
  let _saveDir = null;
  // IDBFS 의 IndexedDB DB name (mountpoint) — _saveDir 의 ancestor.
  let _dbName  = null;
  // IDBFS object store name — emscripten 버전마다 다름 (_storeName or 'FILES').
  let _storeName = null;

  function setSaveDir(p) {
    _saveDir = p;
    console.log('[SaveControls] save dir set:', p);
  }
  function getSaveDir() {
    if (_saveDir) return _saveDir;
    if (window.LOVE2D_SAVE_DIR) { _saveDir = window.LOVE2D_SAVE_DIR; return _saveDir; }
    return null;
  }

  // === IndexedDB 직접 access ===

  // DB name 자동 검출 — emscripten IDBFS 의 DB name 은 mountpoint.
  // 우리 saveDir = /home/web_user/love/game/savefiles → mountpoint 후보:
  //   /home/web_user/love, /home/web_user, /home, ...
  async function detectDB() {
    if (_dbName) return _dbName;
    const dir = getSaveDir();
    const candidates = [];
    if (dir) {
      // saveDir 의 모든 ancestor 추가
      const parts = dir.split('/').filter(s => s.length > 0);
      for (let i = parts.length; i > 0; i--) {
        candidates.push('/' + parts.slice(0, i).join('/'));
      }
    }
    // 일반적 후보
    candidates.push('/home/web_user/love', '/home/web_user', '/love', '/save');

    // 1. indexedDB.databases() 사용 가능하면 (Chrome 71+) — 직접 list
    let allDbs = null;
    if (indexedDB.databases) {
      try {
        allDbs = await indexedDB.databases();
        console.log('[SaveControls] IndexedDB DB list:', allDbs);
        for (const info of allDbs) {
          if (!info.name) continue;
          // mountpoint 같은 이름 (slash 시작) 우선
          if (info.name.startsWith('/')) {
            const r = await checkDB(info.name);
            if (r.has) { _dbName = info.name; _storeName = r.storeName; return _dbName; }
          }
        }
        // slash 없는 이름도 시도
        for (const info of allDbs) {
          if (!info.name) continue;
          if (info.name === 'EM_PRELOAD_CACHE') continue;  // emscripten preload, 우리 target 아님
          const r = await checkDB(info.name);
          if (r.has) { _dbName = info.name; _storeName = r.storeName; return _dbName; }
        }
      } catch (e) { console.warn('databases() 실패:', e); }
    }
    // 2. candidates brute-force
    for (const name of candidates) {
      const r = await checkDB(name);
      if (r.has) { _dbName = name; _storeName = r.storeName; return _dbName; }
    }
    console.warn('[SaveControls] IDBFS DB 검출 실패. 후보:', candidates, 'allDbs:', allDbs);
    return null;
  }

  function checkDB(name) {
    return new Promise((resolve) => {
      let resolved = false;
      const req = indexedDB.open(name);
      req.onupgradeneeded = (e) => {
        // 미존재 DB → indexedDB.open 자동 생성 차단. 빈 DB 만들지 않음.
        try { e.target.transaction.abort(); } catch (er) {}
      };
      req.onsuccess = () => {
        if (resolved) return; resolved = true;
        const db = req.result;
        const stores = Array.from(db.objectStoreNames);
        // emscripten IDBFS store name 후보 (버전마다 다름).
        const STORE_CANDIDATES = ['FILE_DATA', 'FILES'];
        let store = null;
        for (const c of STORE_CANDIDATES) { if (stores.includes(c)) { store = c; break; } }
        db.close();
        if (stores.length > 0) {
          console.log('[checkDB]', name, '- stores:', stores, store ? '(MATCH ' + store + ')' : '(no match)');
        }
        resolve({ has: !!store, storeName: store, allStores: stores });
      };
      req.onerror = () => { if (!resolved) { resolved = true; resolve({ has: false }); } };
      setTimeout(() => { if (!resolved) { resolved = true; resolve({ has: false }); } }, 3000);
    });
  }

  function openIDBFS() {
    return new Promise((resolve, reject) => {
      if (!_dbName) { reject(new Error('IDBFS DB 미검출')); return; }
      const req = indexedDB.open(_dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbRead(path) {
    const db = await openIDBFS();
    return new Promise((res, rej) => {
      const tx = db.transaction([_storeName], 'readonly');
      const store = tx.objectStore(_storeName);
      const r = store.get(path);
      r.onsuccess = () => { db.close(); res(r.result); };
      r.onerror   = () => { db.close(); rej(r.error); };
    });
  }

  // IDBFS 직접 write — 호환성 issue (모바일 Chrome 에서 reconcile 차단 또는
  // throw) 로 사용 안 함. 아래 함수는 keep 하지만 uploadSlot 에서 호출 안 함.
  // 영속 저장은 localStorage (preRun MEMFS inject) 사용.
  async function idbWrite(path, u8) {
    const db = await openIDBFS();
    return new Promise((res, rej) => {
      const tx = db.transaction([_storeName], 'readwrite');
      const store = tx.objectStore(_storeName);
      const value = { contents: u8, mode: 33188, timestamp: new Date() };
      const r = store.put(value, path);
      r.onsuccess = () => { db.close(); res(); };
      r.onerror   = () => { db.close(); rej(r.error); };
    });
  }

  async function idbDelete(path) {
    const db = await openIDBFS();
    return new Promise((res, rej) => {
      const tx = db.transaction([_storeName], 'readwrite');
      const store = tx.objectStore(_storeName);
      const r = store.delete(path);
      r.onsuccess = () => { db.close(); res(); };
      r.onerror   = () => { db.close(); rej(r.error); };
    });
  }

  // === UI ===

  function status(msg, kind) {
    const el = document.getElementById('save-status');
    if (!el) return;
    el.textContent = msg;
    el.className = kind || '';
  }

  async function readSlotMeta(slotIdx) {
    const dir = getSaveDir();
    if (!dir) return { exists: false };
    const path = dir + '/' + SLOT_FILES[slotIdx - 1];
    try {
      const entry = await idbRead(path);
      if (!entry || !entry.contents) return { exists: false };
      const data = entry.contents;
      let name = '';
      for (let i = 4; i < 0x28 && i < data.length; i++) {
        if (data[i] === 0) break;
        name += String.fromCharCode(data[i]);
      }
      let date = '';
      if (entry.timestamp instanceof Date) {
        date = entry.timestamp.toLocaleString();
      } else if (typeof entry.timestamp === 'number') {
        date = new Date(entry.timestamp).toLocaleString();
      }
      return { exists: true, size: data.length, name: name || '(이름 없음)', mtime: date };
    } catch (e) {
      return { exists: false };
    }
  }

  async function downloadSlot(slotIdx) {
    // Lua → JS bridge — F2-F6 (slot 1-5) 또는 F7 (slot 0=seed) 키 dispatch.
    // Lua 가 받아 sav 를 base64 print → index.html 의 Module.print 가 blob 으로 download.
    const FN_KEY_MAP = {
      0: { key: 'F7',  code: 'F7',  keyCode: 118 },
      1: { key: 'F2',  code: 'F2',  keyCode: 113 },
      2: { key: 'F3',  code: 'F3',  keyCode: 114 },
      3: { key: 'F4',  code: 'F4',  keyCode: 115 },
      4: { key: 'F5',  code: 'F5',  keyCode: 116 },
      5: { key: 'F6',  code: 'F6',  keyCode: 117 },
    };
    const def = FN_KEY_MAP[slotIdx];
    if (!def) { status(`Slot ${slotIdx}: 미지원 slot`, 'error'); return; }
    status(`Slot ${slotIdx}: 다운로드 준비 중... (게임에서 sav read)`, '');
    const canvas = document.getElementById('canvas');
    if (!canvas) { status('canvas 없음', 'error'); return; }
    // 1. canvas focus — SDL2 keyboard listener 가 canvas focus 요구하는 빌드 호환.
    try { canvas.focus(); } catch (e) {}
    // 2. dispatch 를 다양한 target 에 — canvas / document / window. love.js fork 마다
    //    listener 위치 달라 모두에 dispatch (bubbles:true 라 ancestor 도 받지만 일부
    //    빌드는 capture phase 만 listen — 직접 dispatch 가 안전).
    const targets = [canvas, document, window];
    for (const target of targets) {
      const evd = new KeyboardEvent('keydown', {
        key: def.key, code: def.code, keyCode: def.keyCode, which: def.keyCode,
        bubbles: true, cancelable: true,
      });
      target.dispatchEvent(evd);
    }
    // keyup 도 동일하게
    setTimeout(function() {
      for (const target of targets) {
        const evu = new KeyboardEvent('keyup', {
          key: def.key, code: def.code, keyCode: def.keyCode, which: def.keyCode,
          bubbles: true, cancelable: true,
        });
        target.dispatchEvent(evu);
      }
    }, 50);
    console.log('[SaveControls] download dispatch:', def.key, 'for slot', slotIdx);
  }

  // SessionStorage key — page reload 시 Module.preRun 가 읽음.
  const PENDING_UPLOAD_KEY = 'love2d_pending_uploads';

  function uint8ToBase64(u8) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  async function uploadSlot(slotIdx, file) {
    const dir = getSaveDir();
    if (!dir) { status('save dir 미검출', 'error'); return; }
    const filename = SLOT_FILES[slotIdx - 1];
    const path = dir + '/' + filename;
    try {
      const buf = await file.arrayBuffer();
      const u8  = new Uint8Array(buf);
      // 영속 저장 — localStorage 에 base64. 매 page reload 시 preRun 이 읽어
      // MEMFS 에 inject. localStorage 는 영구 (브라우저 수동 clear 까지).
      // Per-slot key 으로 저장 → 같은 slot 재업로드 시 overwrite, 다른 slot 별도 보존.
      const lskey = 'love2d_upload_slot_' + slotIdx;
      const b64 = uint8ToBase64(u8);
      try {
        localStorage.setItem(lskey, JSON.stringify({ path: path, b64: b64 }));
      } catch (e) {
        status(`Slot ${slotIdx} 업로드 실패 (storage 한계): ${e.message}`, 'error');
        return;
      }
      // SessionStorage 도 동일하게 저장 (같은 page 의 다음 reload 우선 inject)
      try {
        const pending = JSON.parse(sessionStorage.getItem(PENDING_UPLOAD_KEY) || '[]');
        pending.push({ path: path, b64: b64 });
        sessionStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify(pending));
      } catch (e) { /* quota exceed — localStorage 가 main path */ }
      status(`Slot ${slotIdx}: 업로드 완료 (${u8.length} byte). 페이지 새로고침 후 게임에서 ${slotIdx}번 슬롯 사용. 영속 저장 OK.`, 'success');
      await renderSlots();
    } catch (e) {
      status(`Slot ${slotIdx} 업로드 실패: ${e.message}`, 'error');
    }
  }

  async function deleteSlot(slotIdx) {
    if (!confirm(`Slot ${slotIdx} sav 를 삭제 하시겠습니까?`)) return;
    const dir = getSaveDir();
    if (!dir) { status('save dir 미검출', 'error'); return; }
    if (!await detectDB()) { status('IDBFS DB 미검출', 'error'); return; }
    const filename = SLOT_FILES[slotIdx - 1];
    const path = dir + '/' + filename;
    try {
      await idbDelete(path);
      status(`Slot ${slotIdx} 삭제 완료. 페이지 새로고침으로 반영`, 'success');
      await renderSlots();
    } catch (e) {
      status(`Slot ${slotIdx} 삭제 실패: ${e.message}`, 'error');
    }
  }

  async function renderSlots() {
    const container = document.getElementById('save-slots');
    if (!container) return;
    container.innerHTML = '<div style="color:#888;font-size:12px">로딩 중...</div>';

    if (!await detectDB()) {
      container.innerHTML = '<div style="color:#ff8080;font-size:12px">IDBFS DB 검출 실패. 게임을 한 번 실행한 후 다시 시도하세요.</div>';
      return;
    }

    container.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const meta = await readSlotMeta(i);
      const exists = meta && meta.exists;
      const div = document.createElement('div');
      div.className = 'slot';
      div.innerHTML = `
        <div class="slot-title">
          <span>Slot ${i}</span>
          <span style="font-size:10px;color:${exists ? '#80ff80' : '#888'}">${exists ? 'OK' : '비어있음'}</span>
        </div>
        <div class="slot-meta">
          ${exists
            ? `${SLOT_FILES[i-1]} · ${meta.size} byte<br>저장: ${meta.mtime}`
            : SLOT_FILES[i-1]}
        </div>
        <div class="slot-actions">
          <button data-slot="${i}" data-act="download" ${exists ? '' : 'disabled'}>⬇ 다운</button>
          <label>
            ⬆ 업로드
            <input type="file" data-slot="${i}" data-act="upload" accept=".sav,.SAV">
          </label>
          <button class="delete" data-slot="${i}" data-act="delete" ${exists ? '' : 'disabled'}>✕</button>
        </div>
      `;
      container.appendChild(div);
    }
    container.querySelectorAll('button[data-act]').forEach(btn => {
      const slot = parseInt(btn.dataset.slot);
      const act = btn.dataset.act;
      btn.onclick = () => {
        if (act === 'download') downloadSlot(slot);
        else if (act === 'delete') deleteSlot(slot);
      };
    });
    container.querySelectorAll('input[type="file"]').forEach(inp => {
      const slot = parseInt(inp.dataset.slot);
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (f) uploadSlot(slot, f);
        inp.value = '';
      };
    });
  }

  function install() {
    const toggle = document.getElementById('btn-save')
                || document.getElementById('save-panel-toggle');  // 구버전 ID 호환
    const panel = document.getElementById('save-panel');
    const close = document.querySelector('#save-panel .close-btn');
    if (toggle && panel) {
      toggle.onclick = () => {
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) renderSlots();
      };
    }
    if (close && panel) close.onclick = () => panel.classList.add('hidden');
    console.log('[SaveControls] installed (IndexedDB direct access)');
    // 백그라운드 DB detection (panel 열기 전 미리)
    setTimeout(() => detectDB().then(name => {
      if (name) console.log('[SaveControls] IDBFS DB:', name);
      else console.warn('[SaveControls] IDBFS DB 미검출');
    }), 3000);
  }

  return { install, renderSlots, downloadSlot, uploadSlot, deleteSlot, setSaveDir, detectDB, setStatus: status };
})();

window.SaveControls = SaveControls;
