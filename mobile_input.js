/* 모바일 가상 키패드 + IME — Forgotten Saga (love.js)
 *
 * 동작:
 *   D-pad / Action 버튼 → KeyboardEvent (keydown/keyup) dispatch.
 *     love.js 의 SDL keyboard 처리가 받음 → Lua love.keypressed / isDown 동작.
 *   IME 버튼 → hidden <input> focus → 모바일 가상 키보드 활성화 → 한국어 IME 조합
 *     완성 후 textinput 이벤트로 game canvas 에 forward.
 *
 * 사용:
 *   index.html 에서 mobile_input.css 와 이 파일을 로드 후
 *   window.addEventListener('load', () => MobileInput.install());
 */

const MobileInput = (() => {
  // SDL/love2d key mapping (love.keyboard.isDown 의 key name)
  const KEY_MAP = {
    up:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
    down:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
    left:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    space: { key: ' ',          code: 'Space',      keyCode: 32 },
    enter: { key: 'Enter',      code: 'Enter',      keyCode: 13 },
    esc:   { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  };

  function dispatchKey(target, type, k) {
    const def = KEY_MAP[k]; if (!def) return;
    const ev = new KeyboardEvent(type, {
      key: def.key, code: def.code, keyCode: def.keyCode, which: def.keyCode,
      bubbles: true, cancelable: true,
    });
    // canvas 에 dispatch — bubbles:true 라 ancestor (document, window) 의 listener 도
    // 한 번에 호출. 이전엔 canvas + window 양쪽에 dispatch 했지만 bubble path 와 겹쳐
    // listener 가 두 번 호출되는 race 발생 (title menu cursor 두 칸 이동 등).
    target.dispatchEvent(ev);
  }

  function bindButton(el, keyName) {
    const canvas = document.getElementById('canvas') || window;
    const press = (ev) => {
      ev.preventDefault();
      el.classList.add('pressed');
      dispatchKey(canvas, 'keydown', keyName);
    };
    const release = (ev) => {
      ev.preventDefault();
      el.classList.remove('pressed');
      dispatchKey(canvas, 'keyup', keyName);
    };
    // touch — passive:false 로 preventDefault 가능
    el.addEventListener('touchstart', press, { passive: false });
    el.addEventListener('touchend', release, { passive: false });
    el.addEventListener('touchcancel', release, { passive: false });
    // mouse — 데스크톱 디버그
    el.addEventListener('mousedown', press);
    el.addEventListener('mouseup', release);
    el.addEventListener('mouseleave', release);
  }

  // SDL2 textinput candidate — custom 빌드 love.js 가 _SDL_SendKeyboardText export.
  // 첫 호출 시 사용 method 1 회 log (디버그).
  let _fwdMethodLogged = false;
  function _dbg(msg) {
    try { console.log(msg); } catch (e) {}
    if (window.__logPush) {
      try { window.__logPush(msg, false); } catch (e) {}
    }
  }

  function installIME() {
    const ime = document.getElementById('mobile-ime');
    if (!ime) return;
    let composing = false;

    function forwardChar(ch) {
      if (!ch) return;
      const M = window.Module;
      // 1순위: ccall('SDL_SendKeyboardText') — custom 빌드 love.js 에 export 됨.
      // SDL2 의 internal API 로 textinput event 를 main thread 에 push → love.textinput.
      if (M && M.ccall) {
        try {
          M.ccall('SDL_SendKeyboardText', null, ['string'], [ch]);
          if (!_fwdMethodLogged) {
            _fwdMethodLogged = true;
            _dbg('[fwd] using ccall:SDL_SendKeyboardText');
          }
          return;
        } catch (e) { /* fall through */ }
      }
      // 2순위: Module._SDL_SendKeyboardText 직접 호출 (ccall 없으면)
      if (M && typeof M._SDL_SendKeyboardText === 'function' && M.allocateUTF8 && M._free) {
        try {
          const ptr = M.allocateUTF8(ch);
          M._SDL_SendKeyboardText(ptr);
          M._free(ptr);
          if (!_fwdMethodLogged) {
            _fwdMethodLogged = true;
            _dbg('[fwd] using direct:_SDL_SendKeyboardText');
          }
          return;
        } catch (e) { /* fall through */ }
      }
      // 3순위: 광범위 InputEvent dispatch (iOS Safari fallback — 기존 npm love.js 호환)
      const canvas = document.getElementById('canvas') || window;
      const targets = [canvas, document, window];
      try {
        const ev = new InputEvent('textinput', { data: ch, bubbles: true });
        for (const t of targets) { try { t.dispatchEvent(ev); } catch (e) {} }
        if (!_fwdMethodLogged) {
          _fwdMethodLogged = true;
          _dbg('[fwd] using inputEvent-broad (custom love.js 미적용?)');
        }
      } catch (e) {}
    }
    function forwardBackspace() {
      const canvas = document.getElementById('canvas') || window;
      const targets = [canvas, document, window];
      for (const type of ['keydown', 'keyup']) {
        const ev = new KeyboardEvent(type, {
          key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8,
          bubbles: true, cancelable: true,
        });
        for (const t of targets) { try { t.dispatchEvent(ev); } catch (e) {} }
      }
    }

    ime.addEventListener('compositionstart', () => { composing = true; });
    ime.addEventListener('compositionend', (ev) => {
      composing = false;
      const data = ev.data || '';
      for (const ch of data) forwardChar(ch);
      // input 비우기 — 다음 입력 시 ime.value 누적 방지
      ime.value = '';
    });
    ime.addEventListener('input', (ev) => {
      const it = ev.inputType || '';
      // composition 중간 결과 — compositionend 에서 처리되므로 여기선 skip
      if (it === 'insertCompositionText' || composing) return;
      // backspace — 게임에 KeyboardEvent backspace forward
      if (it.startsWith('delete')) {
        ime.value = '';
        forwardBackspace();
        return;
      }
      const data = ev.data;
      if (data) {
        for (const ch of data) forwardChar(ch);
      }
      // input 비우기 — buffer 누적 방지 (panel 표시 안 함, value 시각 표시 X)
      ime.value = '';
    });
    // textbox blur 시 imeBtn active state 해제
    ime.addEventListener('blur', () => {
      const imeBtn = document.getElementById('btn-ime');
      if (imeBtn) imeBtn.classList.remove('active');
    });

    // 키보드 밖 터치 / 클릭 → ime blur → 가상 키보드 자동 닫힘.
    // 가상 키보드 자체 터치는 browser native UI 라 page 의 touchstart event 발생 X — 안전.
    const dismissIfOutside = (e) => {
      if (document.activeElement !== ime) return;
      const imeBtn = document.getElementById('btn-ime');
      // imeBtn (토글) 과 ime 자체 클릭은 제외 — 토글로 처리
      if (e.target === ime || e.target === imeBtn || (imeBtn && imeBtn.contains(e.target))) return;
      ime.blur();
    };
    document.addEventListener('touchstart', dismissIfOutside, { passive: true });
    document.addEventListener('mousedown', dismissIfOutside);
  }

  // === Joystick — nipplejs 사용 (multi-touch / touchcancel / Pointer Events 검증된 lib) ===
  // hand-rolled touch handler 가 multi-touch / ghost touch / stuck 이슈 발생 → nipplejs 로 교체.
  // dir event 시 4 방향 keydown/keyup dispatch. hold 시 우리 repeat timer 로 OS keyrepeat 흉내.
  function installJoystick() {
    const zone = document.getElementById('joystick');
    if (!zone) return;
    if (typeof nipplejs === 'undefined') {
      console.warn('[MobileInput] nipplejs 미로드 — joystick 비활성');
      return;
    }
    const canvas = document.getElementById('canvas') || window;
    const REPEAT_DELAY    = 400;
    const REPEAT_INTERVAL = 110;

    let curDir = null;
    let repeatTimer = null;
    let repeatInterval = null;

    function clearRepeat() {
      if (repeatTimer)    { clearTimeout(repeatTimer);   repeatTimer = null; }
      if (repeatInterval) { clearInterval(repeatInterval); repeatInterval = null; }
    }
    function startRepeat(dir) {
      clearRepeat();
      repeatTimer = setTimeout(() => {
        repeatInterval = setInterval(() => {
          if (curDir !== dir) { clearRepeat(); return; }
          const def = KEY_MAP[dir]; if (!def) return;
          const ev = new KeyboardEvent('keydown', {
            key: def.key, code: def.code, keyCode: def.keyCode, which: def.keyCode,
            repeat: true, bubbles: true, cancelable: true,
          });
          canvas.dispatchEvent(ev);
        }, REPEAT_INTERVAL);
      }, REPEAT_DELAY);
    }

    function setDir(newDir) {
      if (newDir === curDir) return;
      if (curDir) {
        dispatchKey(canvas, 'keyup', curDir);
        clearRepeat();
      }
      if (newDir) {
        dispatchKey(canvas, 'keydown', newDir);
        startRepeat(newDir);
      }
      curDir = newDir;
    }

    const stick = nipplejs.create({
      zone: zone,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      size: 168,
      threshold: 0.45,        // knob 이 radius 의 45% 이상 이동 시 dir 활성 (jitter 방지)
      color: 'rgba(120, 160, 220, 0.75)',
      fadeTime: 100,
      restJoystick: true,     // touch 떼면 knob 가운데 복원
      restOpacity: 0.5,
    });

    stick.on('dir', (evt, data) => {
      // data.direction.angle: 'up' / 'down' / 'left' / 'right' (KEY_MAP 와 일치)
      const dir = data && data.direction && data.direction.angle;
      if (dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right') {
        setDir(dir);
      }
    });
    stick.on('end', () => { setDir(null); });

    // 페이지 hidden / blur 시 stuck 방지 — 모든 active 키 release
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) setDir(null);
    });
    window.addEventListener('blur', () => setDir(null));
  }

  function install() {
    // 좌하단 조이스틱 (D-pad 대체)
    installJoystick();
    // Action 버튼 (esc / space / enter)
    document.querySelectorAll('#mobile-input .actions .btn').forEach(el => {
      const k = el.dataset.key;
      if (k) bindButton(el, k);
    });
    // 키보드 토글 — invisible #mobile-ime 에 focus() 만 호출하여 OS 가상 키보드 trigger.
    // 별도 panel/textbox 표시 X. 사용자 입력 → input event → forwardChar → 게임 prompt.
    const imeBtn = document.getElementById('btn-ime');
    if (imeBtn) {
      imeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const ime = document.getElementById('mobile-ime');
        if (!ime) return;
        if (document.activeElement === ime) {
          ime.blur();
          imeBtn.classList.remove('active');
        } else {
          ime.value = '';  // 누적 buffer reset
          // user gesture 안에서 focus 호출 — iOS Safari / Android Chrome 가상 키보드 등장
          ime.focus();
          imeBtn.classList.add('active');
        }
      });
    }
    installIME();
    console.log('[MobileInput] installed');
  }

  return { install, dispatchKey };
})();

window.MobileInput = MobileInput;
