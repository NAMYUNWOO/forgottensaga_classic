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

  // IndexedDB 별도 DB ('love2d_user_saves') 의 모든 entries read — async helper.
  function _readUserSavesDB() {
    return new Promise(function(res) {
      try {
        var req = indexedDB.open('love2d_user_saves', 1);
        req.onupgradeneeded = function(e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves');
        };
        req.onsuccess = function(e) {
          var db = e.target.result;
          try {
            if (!db.objectStoreNames.contains('saves')) { db.close(); res({}); return; }
            var tx = db.transaction(['saves'], 'readonly');
            var store = tx.objectStore('saves');
            var allReq = store.getAll();
            var keysReq = store.getAllKeys();
            var map = {};
            tx.oncomplete = function() {
              for (var i = 0; i < keysReq.result.length; i++) {
                try { map[keysReq.result[i]] = JSON.parse(allReq.result[i]); } catch (e) {}
              }
              db.close();
              res(map);
            };
            tx.onerror = function() { db.close(); res({}); };
          } catch (er) { db.close(); res({}); }
        };
        req.onerror = function() { res({}); };
        setTimeout(function() { res({}); }, 3000);
      } catch (e) { res({}); }
    });
  }

  async function readSlotMeta(slotIdx) {
    // panel slot 1-based, SLOT_FILES 0-based — expectedFname 으로 path 매칭.
    // (옛 매핑: key 가 0-based filename digit, 새 매핑: key 가 1-based slotIdx.
    //  path 기반 lookup 이면 둘 다 호환.)
    const expectedFname = SLOT_FILES[slotIdx - 1];
    // 1순위: IndexedDB 'love2d_user_saves' (게임 안 자동저장 + 모바일 호환)
    try {
      const userSaves = await _readUserSavesDB();
      for (const k in userSaves) {
        const item = userSaves[k];
        if (!item || !item.b64) continue;
        const fname = (item.path || '').split('/').pop();
        if (fname === expectedFname) {
          const size = atob(item.b64).length;
          return { exists: true, size: size, name: '(자동저장)', mtime: '', source: 'user_saves_db' };
        }
      }
    } catch (e) {}
    // 2순위: localStorage 의 사용자 업로드 sav (Safari 도 호환).
    try {
      if (typeof localStorage !== 'undefined') {
        for (let i = 0; i <= 6; i++) {
          const raw = localStorage.getItem('love2d_upload_slot_' + i);
          if (!raw) continue;
          try {
            const item = JSON.parse(raw);
            const fname = (item.path || '').split('/').pop();
            if (fname === expectedFname) {
              const size = atob(item.b64).length;
              return { exists: true, size: size, name: '(업로드)', mtime: '', source: 'localStorage' };
            }
          } catch (er) {}
        }
      }
    } catch (e) {}
    // 2순위: IDBFS read (게임 sav, syncfs 가 됐어야 함)
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
      if (entry.timestamp instanceof Date) date = entry.timestamp.toLocaleString();
      else if (typeof entry.timestamp === 'number') date = new Date(entry.timestamp).toLocaleString();
      return { exists: true, size: data.length, name: name || '(이름 없음)', mtime: date, source: 'IDBFS' };
    } catch (e) {
      return { exists: false };
    }
  }

  async function downloadSlot(slotIdx) {
    // 3-tier path:
    //   1순위: localStorage 의 사용자 업로드 sav (Safari/Chrome 모두 즉시 가능).
    //   2순위: Lua → JS bridge (F-key dispatch). 게임 진행 중 MEMFS read.
    //   3순위 (5초 timeout 후): IndexedDB direct read. game 종료 syncfs 후 stale.

    function _bin2u8(b64) {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    const filename0 = SLOT_FILES[slotIdx - 1] || ('saga0' + slotIdx + '.sav');

    // 1순위 — IndexedDB 'love2d_user_saves' (path 기반: 옛/새 key 매핑 모두 호환)
    try {
      const userSaves = await _readUserSavesDB();
      for (const k in userSaves) {
        const item = userSaves[k];
        if (!item || !item.b64) continue;
        const fname = (item.path || '').split('/').pop();
        if (fname === filename0) {
          const u8 = _bin2u8(item.b64);
          triggerBlobDownload(new Blob([u8], { type: 'application/octet-stream' }), filename0);
          status(`Slot ${slotIdx} (자동저장): 다운로드 (${u8.length} byte)`, 'success');
          return;
        }
      }
    } catch (e) { console.warn('[downloadSlot] user_saves IDB error:', e); }

    // 2순위 — localStorage (사용자가 직접 업로드한 sav, path 기반)
    try {
      if (typeof localStorage !== 'undefined') {
        for (let i = 0; i <= 6; i++) {
          const raw = localStorage.getItem('love2d_upload_slot_' + i);
          if (!raw) continue;
          try {
            const item = JSON.parse(raw);
            const fname = (item.path || '').split('/').pop();
            if (fname === filename0) {
              const u8 = _bin2u8(item.b64);
              triggerBlobDownload(new Blob([u8], { type: 'application/octet-stream' }), filename0);
              status(`Slot ${slotIdx} (업로드본): 다운로드 (${u8.length} byte)`, 'success');
              return;
            }
          } catch (er) {}
        }
      }
    } catch (e) { console.warn('[downloadSlot] localStorage error:', e); }

    // 2순위 — emscripten 의 노출된 internal sync API 시도. game 이 자동 sync 안 함.
    // Module 의 다양한 가능 export 시도 (빌드 옵션마다 노출 함수 다름).
    try {
      const M = window.Module;
      if (M) {
        // Lua bridge 전 — 혹시 노출된 syncfs 있으면 force sync
        if (typeof M.FS_syncfs === 'function') {
          await new Promise((res) => {
            try { M.FS_syncfs(false, function() { res(); }); }
            catch (e) { res(); }
          });
        } else if (M.FS && typeof M.FS.syncfs === 'function') {
          await new Promise((res) => {
            try { M.FS.syncfs(false, function() { res(); }); }
            catch (e) { res(); }
          });
        }
        // 또는 ccall 으로 emscripten C function 호출
        try {
          if (typeof M.ccall === 'function') {
            // emscripten 의 자동 sync — 일부 빌드에 노출
            try { M.ccall('emscripten_idbfs_save', null, [], []); } catch (e) {}
          }
        } catch (e) {}
      }
    } catch (e) { console.warn('[downloadSlot] sync attempt fail:', e); }

    // 2순위/3순위 — Lua bridge + IDBFS fallback (이하 기존 코드)
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

    // window.__savDl (index.html 의 print handler 가 set/clear) 가 sentinel 받으면
    // dl.slot 에 slotIdx string 저장. 5초 후 그것 확인 — 못 받았으면 fallback.
    const dispatchTime = Date.now();
    window.__savDlExpected = String(slotIdx);
    window.__savDlTime = dispatchTime;

    status(`Slot ${slotIdx}: 게임에서 sav 읽는 중...`, '');

    // Lua bridge dispatch
    const canvas = document.getElementById('canvas');
    if (canvas) {
      try { canvas.focus(); } catch (e) {}
      const targets = [canvas, document, window];
      for (const target of targets) {
        try {
          const evd = new KeyboardEvent('keydown', {
            key: def.key, code: def.code, keyCode: def.keyCode, which: def.keyCode,
            bubbles: true, cancelable: true,
          });
          target.dispatchEvent(evd);
        } catch (e) {}
      }
      setTimeout(function() {
        for (const target of targets) {
          try {
            const evu = new KeyboardEvent('keyup', {
              key: def.key, code: def.code, keyCode: def.keyCode, which: def.keyCode,
              bubbles: true, cancelable: true,
            });
            target.dispatchEvent(evu);
          } catch (e) {}
        }
      }, 50);
      console.log('[SaveControls] Lua bridge dispatch:', def.key, 'for slot', slotIdx);
    }

    // 5초 후 — Lua bridge 가 안 받았으면 IndexedDB fallback
    setTimeout(async function() {
      // sentinel 도착 = window.__savDlExpected 가 이미 다른 값이거나 지워졌으면 OK
      if (window.__savDlReceivedAt && window.__savDlReceivedAt >= dispatchTime) {
        return;  // Lua bridge 성공
      }
      console.warn('[SaveControls] Lua bridge timeout — IndexedDB fallback 시도');
      const dir = getSaveDir();
      if (!dir) { status(`Slot ${slotIdx}: save dir 미검출 + Lua bridge timeout`, 'error'); return; }
      if (!await detectDB()) {
        status(`Slot ${slotIdx}: 게임에서 저장 후 페이지 새로고침 → 다시 시도`, 'error');
        return;
      }
      try {
        const filename = SLOT_FILES[slotIdx - 1] || ('saga0' + slotIdx + '.sav');
        const path = dir + '/' + filename;
        const entry = await idbRead(path);
        if (!entry || !entry.contents) {
          status(`Slot ${slotIdx}: 게임에서 저장 후 페이지 새로고침 → 다시 시도`, 'error');
          return;
        }
        const blob = new Blob([entry.contents], { type: 'application/octet-stream' });
        triggerBlobDownload(blob, filename);
        status(`Slot ${slotIdx}: 다운로드 (IndexedDB, ${entry.contents.length} byte)`, 'success');
      } catch (e) {
        status(`Slot ${slotIdx}: ${e.message || 'fallback fail'}`, 'error');
      }
    }, 5000);
  }

  // Blob 다운로드 helper — navigator.share 우선 (iOS Safari 호환), <a download> fallback.
  function triggerBlobDownload(blob, filename) {
    try {
      const file = new File([blob], filename, { type: 'application/octet-stream' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: '포가튼사가 세이브' })
          .catch(function(e) { console.warn('share fail:', e); fallbackA(); });
        return;
      }
    } catch (e) {}
    fallbackA();
    function fallbackA() {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function() {
        try { a.remove(); URL.revokeObjectURL(url); } catch (e) {}
      }, 1000);
    }
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

    // IDBFS DB 검출 — 못 찾아도 panel 은 표시 (다운로드는 Lua bridge 로 동작).
    const idbAvailable = !!(await detectDB());
    if (!idbAvailable) {
      console.log('[SaveControls] IDBFS 검출 X — panel 은 표시 (다운로드는 Lua bridge)');
    }

    container.innerHTML = '';
    if (!idbAvailable) {
      const note = document.createElement('div');
      note.style.cssText = 'color:#aaa;font-size:11px;margin-bottom:10px;padding:8px;background:rgba(60,60,80,0.4);border-radius:6px';
      note.innerHTML = '⚠ 슬롯 정보 미표시 (IDBFS 미동기). 다운로드/업로드는 정상 동작. 게임 안 저장 후 즉시 다운로드 가능.';
      container.appendChild(note);
    }
    for (let i = 1; i <= 5; i++) {
      const meta = idbAvailable ? await readSlotMeta(i) : { exists: false };
      // IDBFS 검출 실패 시에도 다운로드 버튼 활성 — Lua bridge 가 sav 존재 여부 확인.
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
          <button data-slot="${i}" data-act="download">⬇ 다운</button>
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

  // === 탭 전환 + 개발자로그 렌더 ===
  function getActiveTab() {
    const active = document.querySelector('#save-panel .tab-btn.tab-active');
    return active ? active.getAttribute('data-tab') : 'saves';
  }

  function setActiveTab(tabId) {
    document.querySelectorAll('#save-panel .tab-btn').forEach((b) => {
      b.classList.toggle('tab-active', b.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('#save-panel .tab-pane').forEach((p) => {
      p.classList.toggle('tab-active', p.getAttribute('data-pane') === tabId);
    });
    if (tabId === 'saves') renderSlots();
    else if (tabId === 'log') renderLog();
  }

  function renderLog() {
    const out = document.getElementById('log-output');
    const cnt = document.getElementById('log-count');
    if (!out) return;
    const buf = (window.__logBuffer && window.__logBuffer.length) ? window.__logBuffer : null;
    if (buf) {
      out.textContent = buf.join('\n');
      out.scrollTop = out.scrollHeight;
    } else {
      out.textContent = '(아직 로그 없음)';
    }
    if (cnt) cnt.textContent = (buf ? buf.length : 0) + ' 줄';
  }

  function installLogControls() {
    const clearBtn = document.getElementById('log-clear');
    const copyBtn = document.getElementById('log-copy');
    if (clearBtn) {
      clearBtn.onclick = () => {
        if (window.__logBuffer) window.__logBuffer.length = 0;
        renderLog();
      };
    }
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const buf = window.__logBuffer || [];
        const txt = buf.join('\n');
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(txt);
          } else {
            const ta = document.createElement('textarea');
            ta.value = txt;
            ta.style.cssText = 'position:fixed;top:-100px;left:-100px;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
          copyBtn.textContent = '복사됨';
          setTimeout(() => { copyBtn.textContent = '복사'; }, 1500);
        } catch (e) {
          copyBtn.textContent = '복사 실패';
          setTimeout(() => { copyBtn.textContent = '복사'; }, 1500);
        }
      };
    }
  }

  function install() {
    const toggle = document.getElementById('btn-save')
                || document.getElementById('save-panel-toggle');  // 구버전 ID 호환
    const panel = document.getElementById('save-panel');
    const close = document.querySelector('#save-panel .close-btn');
    if (toggle && panel) {
      toggle.onclick = () => {
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
          // 패널 열림 — 현재 활성 탭 기준으로 렌더 (default: saves)
          setActiveTab(getActiveTab());
        }
      };
    }
    if (close && panel) close.onclick = () => panel.classList.add('hidden');

    // 탭 nav 클릭 핸들러
    document.querySelectorAll('#save-panel .tab-btn').forEach((b) => {
      b.onclick = () => setActiveTab(b.getAttribute('data-tab'));
    });

    // 모달 외부 클릭 — 닫기 (단 panel 자체나 토글 버튼 클릭은 제외)
    document.addEventListener('click', (e) => {
      if (!panel || panel.classList.contains('hidden')) return;
      if (panel.contains(e.target)) return;
      if (toggle && toggle.contains(e.target)) return;
      panel.classList.add('hidden');
    });

    // ESC 키 — 닫기
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel && !panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
      }
    });

    installLogControls();

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
