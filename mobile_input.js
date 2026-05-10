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

  function installIME() {
    const ime = document.getElementById('mobile-ime');
    if (!ime) return;
    // 사용자 시각 확인용 별도 누적 buffer — textbox value 가 환경별로 누적/clear
    // 동작이 달라서 (특히 iOS Safari + 한글 IME) 우리가 직접 buffer 관리 + textbox.value
    // 에 강제 write 하여 사용자 시각에 반드시 보이게.
    let visBuf = '';
    let composing = false;
    ime._resetForwardState = () => { visBuf = ''; ime.value = ''; };

    function forwardChar(ch) {
      if (!ch) return;
      const canvas = document.getElementById('canvas') || window;
      const ev = new InputEvent('textinput', { data: ch, bubbles: true });
      canvas.dispatchEvent(ev);
      if (window.Module && window.Module.ccall) {
        try {
          window.Module.ccall('emscripten_text_input', null, ['string'], [ch]);
        } catch (e) { /* ignore — fork 마다 다름 */ }
      }
    }
    function appendVisible(text) {
      if (!text) return;
      visBuf += text;
      // 너무 길면 끝에서 30 자만 유지 (textbox UX)
      if (visBuf.length > 30) visBuf = visBuf.slice(-30);
      ime.value = visBuf;
    }

    ime.addEventListener('compositionstart', () => { composing = true; });
    ime.addEventListener('compositionend', (ev) => {
      composing = false;
      // 조합 완료 — ev.data 가 최종 한글 (예 "각"). game 으로 forward + textbox 누적.
      const data = ev.data || '';
      for (const ch of data) forwardChar(ch);
      appendVisible(data);
    });
    ime.addEventListener('input', (ev) => {
      // input event 의 inputType 으로 종류 구분.
      const it = ev.inputType || '';
      if (it === 'insertCompositionText' || composing) {
        // 조합 중 — visBuf 는 그대로, 단 textbox 에 조합 중간 결과 보이도록
        // ime.value = visBuf + ev.data 로 set (compositionend 시 final 로 덮어씀).
        ime.value = visBuf + (ev.data || '');
        return;
      }
      if (it.startsWith('delete')) {
        // textbox backspace — visBuf 한 글자 줄임 (시각만, 게임엔 backspace 안 보냄)
        visBuf = visBuf.slice(0, -1);
        ime.value = visBuf;
        return;
      }
      // 일반 영문/숫자 직접 입력 — ev.data 의 char forward + 누적 visible
      const data = ev.data;
      if (!data) return;
      for (const ch of data) forwardChar(ch);
      appendVisible(data);
    });
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
    // 키보드 토글 — PC 에서도 visible textbox 띄워서 한국어 입력 (OS IME) 가능.
    // Mobile: focus 만 해도 가상 키보드 자동. PC: visible textbox 가 user 입력 확인.
    const imeBtn = document.getElementById('btn-ime');
    if (imeBtn) {
      imeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const ime = document.getElementById('mobile-ime');
        if (!ime) return;
        if (ime.classList.contains('visible')) {
          ime.classList.remove('visible');
          imeBtn.classList.remove('active');
          ime.blur();
        } else {
          ime.classList.add('visible');
          imeBtn.classList.add('active');
          ime.value = '';
          if (ime._resetForwardState) ime._resetForwardState();
          // small delay → CSS transition 적용 후 focus (mobile 가상 키보드 trigger)
          setTimeout(() => ime.focus(), 30);
        }
      });
      // ime input 외부 클릭 시 자동 hide (UX) — 단 ime 자체와 button 클릭은 제외.
      document.addEventListener('mousedown', (e) => {
        const ime = document.getElementById('mobile-ime');
        if (!ime || !ime.classList.contains('visible')) return;
        if (e.target === ime || e.target === imeBtn) return;
        ime.classList.remove('visible');
        imeBtn.classList.remove('active');
        ime.blur();
      });
    }
    installIME();
    console.log('[MobileInput] installed');
  }

  return { install, dispatchKey };
})();

window.MobileInput = MobileInput;
