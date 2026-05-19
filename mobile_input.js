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

  // 환경 감지 — PC (마우스/물리 키보드) vs 모바일 (touch).
  // PC: mobile-ime 항상 focus 유지 → OS IME 활성 → 한/영 키로 한국어 모드.
  // 모바일: btn-ime 클릭 토글 (항상 focus 시 가상 키보드 늘 떠 있어 게임 가림).
  const _isPCEnv = window.matchMedia
    && window.matchMedia('(pointer: fine)').matches
    && !/Mobi|Android|iPhone|iPad|Tablet/i.test(navigator.userAgent || '');

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
      // 3순위: InputEvent dispatch (iOS Safari fallback — 기존 npm love.js 호환).
      // 단일 dispatch + bubbles: true 로 중첩 호출 방지.
      try {
        const ev = new InputEvent('textinput', { data: ch, bubbles: true });
        document.dispatchEvent(ev);
        if (!_fwdMethodLogged) {
          _fwdMethodLogged = true;
          _dbg('[fwd] using inputEvent (custom love.js 미적용?)');
        }
      } catch (e) {}
    }
    function forwardBackspace() {
      // 단일 dispatch + bubbles: true → SDL2 listener (document/window 어디든) 1번
      // 호출. 이전 multi-target dispatch (canvas + document + window) 은 bubble
      // 과 중첩되어 SDL2 가 2번 받음 → 한국어 syllable update 시 이전 syllable 도
      // 지워지는 덮어쓰기 버그 원인.
      for (const type of ['keydown', 'keyup']) {
        const ev = new KeyboardEvent(type, {
          key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8,
          bubbles: true, cancelable: true,
        });
        try { document.dispatchEvent(ev); } catch (e) {}
      }
    }
    function forwardEnter() {
      for (const type of ['keydown', 'keyup']) {
        const ev = new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        });
        try { document.dispatchEvent(ev); } catch (e) {}
      }
    }

    // IME composition — compositionupdate 로 실시간 partial forward.
    // compositionupdate 마다 이전 partial 을 backspace 로 취소하고 새 partial 을
    // forward → 사용자가 game 에서 실시간으로 조합 중인 한국어 syllable 볼 수 있음.
    // compositionend 가 일어날 때까지 (스페이스/엔터/새 syllable) 기다리면 사용자
    // 입장에서 입력이 안 되는 것처럼 보임.
    let _composingData = '';
    ime.addEventListener('compositionstart', () => {
      composing = true;
      _composingData = '';
    });
    ime.addEventListener('compositionupdate', (ev) => {
      const newData = ev.data || '';
      // 이전 partial char 들 게임에서 backspace 로 제거
      for (let i = 0; i < _composingData.length; i++) {
        forwardBackspace();
      }
      // 새 partial char forward
      for (const ch of newData) forwardChar(ch);
      _composingData = newData;
    });
    ime.addEventListener('compositionend', (ev) => {
      composing = false;
      const data = ev.data || '';
      // compositionupdate 가 마지막 partial 도 처리했으면 추가 변경 없음.
      // compositionupdate 가 발생 안 한 환경 / final 값이 다른 경우만 보정.
      if (_composingData !== data) {
        for (let i = 0; i < _composingData.length; i++) {
          forwardBackspace();
        }
        for (const ch of data) forwardChar(ch);
      }
      _composingData = '';
    });

    // input event — composition 외 일반 입력 + delete
    ime.addEventListener('input', (ev) => {
      const it = ev.inputType || '';
      if (it === 'insertCompositionText' || composing) return;
      if (it.startsWith('delete')) {
        forwardBackspace();
        return;
      }
      // Android 가상 키보드 Enter: input event inputType='insertLineBreak'
      // (keydown event 안 보내는 환경). PC 물리 키보드 Enter 는 별도 keydown
      // listener 가 처리.
      if (it === 'insertLineBreak' || it === 'insertParagraph') {
        forwardEnter();
        return;
      }
      // insertText: 영문 / 일반 char — composition 안 거치는 입력 path
      if (ev.data) {
        // data 가 newline (\n) 이면 enter
        if (ev.data === '\n' || ev.data === '\r' || ev.data === '\r\n') {
          forwardEnter();
          return;
        }
        for (const ch of ev.data) forwardChar(ch);
      }
    });

    // PC 물리 키보드 Enter / Backspace 는 keydown event 가 bubble 로 SDL2 listener
    // 에 도달 → 자동 처리. 우리가 별도 dispatch 하면 중복 호출 회귀 (Enter 2번
    // forward). Android 가상 키보드는 keydown 안 옴 → input event 의 insertLineBreak
    // / insertParagraph 분기로 처리 (위).

    // visible-to-OS pattern: input value 정리 불필요. native input 처럼 자연스럽게
    // 동작 — IME composition / backspace 모두 native 흐름. value 가 누적되면 100자
    // 마다 reset (메모리 위생).
    let _resetCounter = 0;
    ime.addEventListener('input', () => {
      _resetCounter++;
      if (_resetCounter > 100) {
        _resetCounter = 0;
        // composition 중이 아닐 때만 reset (composition 깨짐 방지)
        if (!composing) ime.value = '';
      }
    });

    // textbox blur 시 imeBtn active state 해제
    ime.addEventListener('blur', () => {
      const imeBtn = document.getElementById('btn-ime');
      if (imeBtn) imeBtn.classList.remove('active');
    });

    // PC: 항상 focus 유지. visible-to-OS pattern + pointer-events: none 이라
    // canvas / UI click 영향 없음. JS focus() 만으로 IME context 활성.
    // preventScroll: true — focus 시 brouwser 의 scrollIntoView 자동 동작 차단
    // (viewport 가 ime 위치로 점프하는 버그 회피).
    if (_isPCEnv) {
      const ensureFocus = () => {
        try { ime.focus({ preventScroll: true }); } catch (e) {}
      };
      ensureFocus();
      setTimeout(ensureFocus, 500);
      setTimeout(ensureFocus, 2000);

      // 모든 mouse / touch / keyboard event 후 focus 복귀 시도 — input/textarea/
      // button/select 가 focus 면 양보 (그 element 의 정상 동작 보장).
      const refocusIfFree = () => {
        const ae = document.activeElement;
        if (!ae || ae === ime) return;
        const tag = ae.tagName;
        // 사용자 input element 는 양보 — save panel 의 textbox 등
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        // BUTTON click 직후엔 button 이 focus — 잠시 후 복귀
        if (tag === 'BUTTON' || (ae.closest && ae.closest('button'))) {
          setTimeout(ensureFocus, 100);
          return;
        }
        ensureFocus();
      };

      ime.addEventListener('blur', () => {
        setTimeout(refocusIfFree, 0);
      });
      document.addEventListener('mousedown', () => {
        setTimeout(refocusIfFree, 0);
      });
      document.addEventListener('click', () => {
        setTimeout(refocusIfFree, 0);
      });
      // 첫 keydown 시 focus 점검 — 사용자가 한/영 키 누른 순간 focus 보장
      document.addEventListener('keydown', () => {
        if (document.activeElement !== ime) refocusIfFree();
      }, true);
    }

    // 모바일: 키보드 밖 터치 → blur → 가상 키보드 닫힘 (기존 btn-ime path)
    if (!_isPCEnv) {
      const dismissIfOutside = (e) => {
        if (document.activeElement !== ime) return;
        const imeBtn = document.getElementById('btn-ime');
        if (e.target === ime || e.target === imeBtn || (imeBtn && imeBtn.contains(e.target))) return;
        ime.blur();
      };
      document.addEventListener('touchstart', dismissIfOutside, { passive: true });
      document.addEventListener('mousedown', dismissIfOutside);
    }
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
          // preventScroll: true — focus 시 viewport scroll/zoom 발동 차단.
          ime.focus({ preventScroll: true });
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
