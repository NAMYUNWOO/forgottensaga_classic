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
    let composing = false;
    ime.addEventListener('compositionstart', () => { composing = true; });
    ime.addEventListener('compositionend', () => {
      composing = false;
      flushIme();
    });
    ime.addEventListener('input', () => {
      if (composing) return;  // IME 조합 중엔 대기
      flushIme();
    });
    function flushIme() {
      const value = ime.value;
      if (!value) return;
      const canvas = document.getElementById('canvas') || window;
      // love2d 의 love.textinput callback 으로 forward.
      // SDL Emscripten 가 InputEvent type 'textinput' 을 listen.
      for (const ch of value) {
        const ev = new InputEvent('textinput', { data: ch, bubbles: true });
        canvas.dispatchEvent(ev);
        // backup: love.js fork 에 따라 Module.SDL_TextInput 호출 필요할 수도
        if (window.Module && window.Module.ccall) {
          try {
            window.Module.ccall('emscripten_text_input', null, ['string'], [ch]);
          } catch (e) { /* ignore — fork 마다 다름 */ }
        }
      }
      ime.value = '';
    }
  }

  // === Joystick — 4방향 키보드 입력 emulation ===
  // touch / mouse drag 위치 → angle 으로 4 방향 (up/down/left/right) 중 하나만
  // dispatch. 즉 키보드 한 번에 한 방향만 누른 것과 동일 (연속 vector 아님).
  // deadzone 안에선 모든 방향 release. 다른 방향으로 변경 시 이전 keyup → 새 keydown.
  // hold 시 OS 키보드처럼 키 repeat 자동 발생 (delay 후 interval).
  function installJoystick() {
    const stick = document.getElementById('joystick');
    const knob  = document.getElementById('joystick-knob');
    if (!stick || !knob) return;

    const KNOB_HALF = 32;        // knob 64x64 의 반
    const MAX_DIST  = 50;        // knob 이 base 안에서 이동 가능한 max radius (px)
    // Hysteresis: 끝부분에서 hold 해야 활성, 한번 활성 후엔 작은 버퍼까지 유지.
    // 이전 deadzone 14 는 너무 예민해서 살짝 건드려도 keydown 발생.
    const ACTIVATE_DIST = 38;    // 활성화 임계 (MAX_DIST 의 ~76%)
    const RELEASE_DIST  = 22;    // 활성 후 release 임계 (~44%) — jitter 방지
    const REPEAT_DELAY    = 400; // 첫 keydown 후 repeat 시작까지 (ms)
    const REPEAT_INTERVAL = 110; // repeat 간격 (ms) — 메뉴 cursor 가 너무 빠르게 흐르지
                                 // 않도록 OS keyrepeat (~30ms) 보다 낮춤. 약 9 Hz.

    let active   = false;
    let centerX  = 0, centerY = 0;
    let curDir   = null;
    let repeatTimer = null;
    let repeatInterval = null;
    const canvas = document.getElementById('canvas') || window;

    function clearRepeat() {
      if (repeatTimer)    { clearTimeout(repeatTimer);   repeatTimer = null; }
      if (repeatInterval) { clearInterval(repeatInterval); repeatInterval = null; }
    }
    function startRepeat(dir) {
      clearRepeat();
      // OS keyrepeat 동작: 첫 keydown 후 delay → interval 마다 keydown 반복.
      // KeyboardEvent.repeat=true 로 dispatch (love.js / SDL 의 isrepeat 매핑).
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

    function update(dx, dy) {
      const dist = Math.sqrt(dx*dx + dy*dy);
      // knob 위치: max 까지 clamp
      let kx = dx, ky = dy;
      if (dist > MAX_DIST) {
        kx = dx * MAX_DIST / dist;
        ky = dy * MAX_DIST / dist;
      }
      knob.style.transform = `translate(${kx}px, ${ky}px)`;

      // Hysteresis threshold: 활성 안 됐으면 ACTIVATE 까지, 활성 됐으면 RELEASE 까지
      // 유지. 끝까지 밀어야 처음 활성, 한번 활성 후엔 22 까지 풀려도 유지 → jitter X.
      const threshold = curDir ? RELEASE_DIST : ACTIVATE_DIST;
      if (dist < threshold) { setDir(null); return; }
      // 4-way: angle 으로 가장 가까운 방향. atan2 의 좌표는 화면 (y 아래 양수).
      //   right: -π/4 ~ π/4
      //   down:  π/4 ~ 3π/4
      //   left:  3π/4 ~ π or -π ~ -3π/4
      //   up:    -3π/4 ~ -π/4
      const a = Math.atan2(dy, dx);
      const PI = Math.PI;
      let dir;
      if (a >= -PI/4 && a < PI/4)        dir = 'right';
      else if (a >= PI/4 && a < 3*PI/4)  dir = 'down';
      else if (a >= -3*PI/4 && a < -PI/4) dir = 'up';
      else                                dir = 'left';
      setDir(dir);
    }

    function start(ev) {
      ev.preventDefault();
      const t = ev.touches ? ev.touches[0] : ev;
      const rect = stick.getBoundingClientRect();
      centerX = rect.left + rect.width / 2;
      centerY = rect.top  + rect.height / 2;
      active  = true;
      stick.classList.add('active');
      update(t.clientX - centerX, t.clientY - centerY);
    }
    function move(ev) {
      if (!active) return;
      ev.preventDefault();
      const t = ev.touches ? ev.touches[0] : ev;
      update(t.clientX - centerX, t.clientY - centerY);
    }
    function end(ev) {
      if (!active) return;
      if (ev && ev.preventDefault) ev.preventDefault();
      active = false;
      stick.classList.remove('active');
      knob.style.transform = '';
      setDir(null);
    }

    // touch 우선
    stick.addEventListener('touchstart',  start, { passive: false });
    stick.addEventListener('touchmove',   move,  { passive: false });
    stick.addEventListener('touchend',    end,   { passive: false });
    stick.addEventListener('touchcancel', end,   { passive: false });
    // 데스크톱 디버그용 mouse
    stick.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup',   end);
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
