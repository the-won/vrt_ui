/* ==========================================================================
   레이어팝업 매니저 — 외부 의존성 없음 (jQuery 유무와 무관하게 동작)

   코어 동작은 하나다: 페이지 안에 이미 존재하는 [data-pop] 영역을
   안 보이게 두었다가, 보이게 한다. 파일을 가져오지(fetch) 않는다.

   공개 API
     Popup.open(name, options)   options: { dim, type, size, origin, sheet, esc, scroll, trigger }
     Popup.close(name, result)   name 생략 시 최상단 팝업
     Popup.closeAll()
     Popup.isOpen(name)
     Popup.toggle(name, options)

   커스텀 이벤트 (버블링)
     pop:open   / pop:close (e.detail = close 시 전달한 result)
   ========================================================================== */

(function (global) {
	"use strict";

	/* ---- 설정 ---- */
	var Z_BASE = 1000; // 첫 팝업 z-index
	var Z_STEP = 10; // 중첩 단계마다 증가
	var TAIL_MS = 50; // transitionend 유실 대비 여유 시간

	/* ---- 상태 ---- */
	var stack = []; // 열린 팝업들. 마지막 항목이 최상단
	var savedScrollY = 0;
	var mountEl = null;
	var labelSeq = 0;
	var downOutside = false;

	/* 닫힘 트랜지션이 진행 중인 팝업. 트랜지션이 끝나기 전에 같은 팝업을 다시 열면
	   뒤늦게 실행되는 마무리 콜백이 방금 열린 팝업을 숨겨버리므로, 취소 수단과
	   원래 위치 정보(플레이스홀더)를 여기 들고 있다가 물려준다. */
	var closing = new WeakMap();

	var FOCUSABLE = [
		"a[href]",
		"area[href]",
		"input:not([disabled]):not([type='hidden'])",
		"select:not([disabled])",
		"textarea:not([disabled])",
		"button:not([disabled])",
		"iframe",
		"[contenteditable]",
		"[tabindex]:not([tabindex='-1'])"
	].join(",");

	/* ----------------------------------------------------------------------
	   유틸
	   ---------------------------------------------------------------------- */

	// 앞에서부터 처음으로 값이 있는 인수를 문자열로 반환 (옵션 우선순위 결정용)
	function pick() {
		for (var i = 0; i < arguments.length; i++) {
			var v = arguments[i];
			if (v !== undefined && v !== null && v !== "") return String(v);
		}
		return "";
	}

	function resolve(name) {
		if (!name) return null;
		if (typeof name !== "string") return name; // 요소를 직접 넘긴 경우
		return document.querySelector('[data-pop="' + name + '"]');
	}

	function indexOfEl(el) {
		for (var i = 0; i < stack.length; i++) {
			if (stack[i].el === el) return i;
		}
		return -1;
	}

	function mount() {
		if (!mountEl || !mountEl.parentNode) {
			mountEl = document.querySelector("[data-pop-mount]");
			if (!mountEl) {
				mountEl = document.createElement("div");
				mountEl.setAttribute("data-pop-mount", "");
				document.body.appendChild(mountEl);
			}
		}
		return mountEl;
	}

	function focusables(root) {
		var list = root.querySelectorAll(FOCUSABLE);
		var out = [];
		for (var i = 0; i < list.length; i++) {
			var n = list[i];
			// 화면에 실제로 보이는 것만 (display:none / visibility:hidden 제외)
			if (n.offsetWidth || n.offsetHeight || n.getClientRects().length) out.push(n);
		}
		return out;
	}

	function setAttr(el, name, value) {
		if (value === null || value === undefined) el.removeAttribute(name);
		else el.setAttribute(name, value);
	}

	// 트랜지션 총 길이(ms). 가상요소(딤)와 패널 중 긴 쪽을 기준으로 한다.
	function durationOf(el, pseudo) {
		var cs = global.getComputedStyle(el, pseudo || null);
		if (!cs) return 0;
		var dur = parseFloat(cs.transitionDuration) || 0;
		var delay = parseFloat(cs.transitionDelay) || 0;
		return (dur + delay) * 1000;
	}

	// 트랜지션이 끝난 뒤 콜백. 트랜지션이 없거나 이벤트가 유실돼도
	// 타임아웃 폴백으로 반드시 실행된다 (없으면 팝업이 화면에 남는다).
	function afterTransition(el, panel, fn) {
		var ms = Math.max(durationOf(el, "::before"), durationOf(panel));
		if (!ms) {
			fn();
			return;
		}

		var done = false;

		function finish() {
			if (done) return;
			done = true;
			el.removeEventListener("transitionend", onEnd);
			fn();
		}

		function onEnd(e) {
			// 자손의 트랜지션까지 받지 않도록 대상 확인
			if (e.target !== el && e.target !== panel) return;
			finish();
		}

		el.addEventListener("transitionend", onEnd);
		global.setTimeout(finish, ms + TAIL_MS);
	}

	/* ----------------------------------------------------------------------
	   스크롤 잠금 — 플래그가 아니라 스택 카운터로 관리한다.
	   플래그로 하면 2차 팝업만 닫아도 배경 스크롤이 풀린다.
	   ---------------------------------------------------------------------- */

	function lockScroll() {
		if (document.body.hasAttribute("data-pop-locked")) return;

		savedScrollY = global.scrollY || global.pageYOffset || 0;

		// 스크롤바가 사라지면서 생기는 레이아웃 점프 보정 (PC)
		var sbw = global.innerWidth - document.documentElement.clientWidth;
		document.documentElement.style.setProperty("--pop-sbw", sbw > 0 ? sbw + "px" : "0px");

		/* 이 매니저는 이미 운영 중인 레거시 페이지에 그대로 붙는다. 그런 페이지의
		   body에는 height: 100%, 100vh, 고정 px, 심지어 !important까지 어떤
		   규칙이 걸려 있을지 알 수 없다. popup.css의 스타일시트 규칙 하나로는
		   특정성 싸움에서 이길 보장이 없으므로, 인라인 + !important로 직접
		   강제한다. 인라인 !important는 다른 인라인 !important가 없는 한
		   어떤 스타일시트 규칙도 이긴다.

		   height를 auto로 강제하지 않으면: body가 (어떤 값이든) 고정된
		   한 뷰포트 높이로 묶인 채 position:fixed가 걸리고, 거기에
		   top:-scrollY로 밀어 올리면 박스 아래쪽이 뷰포트 바닥보다
		   scrollY만큼 위에서 끝난다. overflow:hidden이라 그 빈 구간은
		   "잘리는" 게 아니라 body 자체가 없어 아무것도 그려지지 않는다 —
		   스크롤을 내려서 열수록 하단이 비거나 내용이 엉뚱한 위치에
		   보이는 버그가 이것이다. */
		document.body.style.setProperty("height", "auto", "important");
		document.body.style.setProperty("top", "-" + savedScrollY + "px", "important");
		document.body.setAttribute("data-pop-locked", "");
	}

	function unlockScroll() {
		if (!document.body.hasAttribute("data-pop-locked")) return;

		document.body.removeAttribute("data-pop-locked");
		document.body.style.removeProperty("height");
		document.body.style.removeProperty("top");
		global.scrollTo(0, savedScrollY); // 위치 복원 (iOS에서 특히 중요)
	}

	// 스택에 스크롤을 잠가야 하는 팝업이 하나라도 있는지
	function anyLocking() {
		for (var i = 0; i < stack.length; i++) {
			if (stack[i].scroll !== "false") return true;
		}
		return false;
	}

	function syncScrollLock() {
		if (anyLocking()) lockScroll();
		else unlockScroll();
	}

	/* ----------------------------------------------------------------------
	   중첩 처리 — 최상단만 조작 가능하게 하고 나머지는 inert
	   ---------------------------------------------------------------------- */

	function syncLayers() {
		for (var i = 0; i < stack.length; i++) {
			var item = stack[i];
			var isTop = i === stack.length - 1;

			if (isTop) item.el.removeAttribute("inert");
			else item.el.setAttribute("inert", "");

			// 딤이 없는 팝업은 뒤 페이지를 계속 쓸 수 있으므로 모달이 아니다.
			// 모달이 아닌데 aria-modal="true"를 주면 스크린리더에 거짓 정보가 된다.
			var modal = isTop && item.dim !== "false";
			item.panel.setAttribute("aria-modal", modal ? "true" : "false");
		}
	}

	/* ----------------------------------------------------------------------
	   클릭한 위치에서 열기 — 절대좌표가 아니라 transform-origin으로 처리한다.
	   좁은 화면에서도 패널이 화면 밖으로 밀리지 않는다.
	   ---------------------------------------------------------------------- */

	function applyOrigin(panel, trigger) {
		var t = trigger.getBoundingClientRect();
		var p = panel.getBoundingClientRect();
		if (!p.width || !p.height) return;

		var ox = ((t.left + t.width / 2 - p.left) / p.width) * 100;
		var oy = ((t.top + t.height / 2 - p.top) / p.height) * 100;

		// 패널 밖으로 너무 멀리 나가면 모션이 과격해지므로 제한
		ox = Math.max(-50, Math.min(150, ox));
		oy = Math.max(-50, Math.min(150, oy));

		panel.style.transformOrigin = ox + "% " + oy + "%";
	}

	/* ----------------------------------------------------------------------
	   열기
	   ---------------------------------------------------------------------- */

	function open(name, options) {
		options = options || {};

		var el = resolve(name);
		if (!el) {
			console.warn("[popup] 대상을 찾을 수 없습니다:", name);
			return null;
		}
		if (indexOfEl(el) > -1) return el; // 이미 열려 있으면 무시

		var trigger = options.trigger || null;
		var tds = trigger ? trigger.dataset : {};
		var eds = el.dataset;

		// 옵션 우선순위: open() 인자 > 트리거 data-* > 팝업 영역 data-* > 기본값
		var dim = pick(options.dim, tds.popDim, eds.popDim, "true");
		var type = pick(options.type, tds.popType, eds.popType, "layer");
		var size = pick(options.size, tds.popSize, eds.popSize, "md");
		var origin = pick(options.origin, tds.popOrigin, eds.popOrigin, "center");
		var sheet = pick(options.sheet, tds.popSheet, eds.popSheet, "");
		var esc = pick(options.esc, tds.popEsc, eds.popEsc, "true");
		var scroll = pick(options.scroll, tds.popScroll, eds.popScroll, "true");

		// 팝업 영역이 선언한 원래 값. 닫을 때 그대로 되돌려 저자 선언을 보존한다.
		var snapshot = {
			dim: el.getAttribute("data-pop-dim"),
			type: el.getAttribute("data-pop-type"),
			size: el.getAttribute("data-pop-size"),
			sheet: el.getAttribute("data-pop-sheet")
		};

		/* 원래 자리에 주석을 남기고 <body> 끝으로 이동한다.
		   조상에 transform/overflow:hidden이 있으면 position:fixed가 깨지기 때문이다.

		   닫힘 트랜지션 중에 다시 열린 경우에는 새 플레이스홀더를 만들지 않는다.
		   그 시점의 el은 이미 마운트 안에 있어서 새로 만들면 "원래 자리"가
		   마운트로 덮어써지고, 다음에 닫을 때 제자리로 돌아가지 못한다. */
		var inflight = closing.get(el);
		var placeholder;

		if (inflight) {
			inflight.cancel();
			closing.delete(el);
			placeholder = inflight.placeholder; // 원래 위치 정보를 물려받는다
		} else {
			placeholder = document.createComment("pop:" + (eds.pop || ""));
			if (el.parentNode) el.parentNode.insertBefore(placeholder, el);
		}

		mount().appendChild(el);

		setAttr(el, "data-pop-dim", dim);
		setAttr(el, "data-pop-type", type);
		setAttr(el, "data-pop-size", size);
		if (sheet) setAttr(el, "data-pop-sheet", sheet);
		el.style.setProperty("--pop-z", String(Z_BASE + stack.length * Z_STEP));

		var panel = el.querySelector("[data-pop-panel]") || el.firstElementChild || el;

		// 접근성 속성
		panel.setAttribute("role", panel.getAttribute("role") || "dialog");
		if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");

		var label = el.querySelector("[data-pop-label]");
		if (label) {
			if (!label.id) label.id = "pop-label-" + ++labelSeq;
			panel.setAttribute("aria-labelledby", label.id);
		}

		var item = {
			el: el,
			panel: panel,
			trigger: trigger,
			placeholder: placeholder,
			snapshot: snapshot,
			esc: esc,
			scroll: scroll,
			dim: dim,
			// 프로그래밍 호출(트리거 없음)에서도 포커스를 되돌릴 수 있도록 현재 포커스를 기억
			returnTo: trigger || document.activeElement
		};
		stack.push(item);

		/* 표시 3단계. 순서가 핵심이다.
		   1) hidden 해제
		   2) state="closed"로 먼저 display를 flex로 만든다 (아직 opacity 0 / scale 0.96)
		   3) 강제 리플로우로 "시작 상태"를 확정한 뒤 state="open"

		   2단계 없이 display:none에서 바로 리플로우를 호출하면 그 시점엔 아직 렌더 박스가
		   없어서 시작 상태가 잡히지 않고, 결과적으로 애니메이션 없이 툭 나타난다. */
		el.hidden = false;
		el.setAttribute("data-pop-state", "closed");

		if (origin === "trigger" && trigger) applyOrigin(panel, trigger);
		else panel.style.transformOrigin = "";

		void el.offsetWidth;
		el.setAttribute("data-pop-state", "open");

		syncScrollLock();
		syncLayers();

		if (stack.length === 1) document.addEventListener("keydown", onKeydown, true);

		// 포커스 이동: 패널 안 첫 포커서블, 없으면 패널 자신
		var f = focusables(panel);
		(f.length ? f[0] : panel).focus({ preventScroll: true });

		el.dispatchEvent(new CustomEvent("pop:open", { bubbles: true }));
		return el;
	}

	/* ----------------------------------------------------------------------
	   닫기
	   ---------------------------------------------------------------------- */

	function close(name, result) {
		var idx;

		if (name === undefined || name === null) {
			idx = stack.length - 1; // 최상단
		} else {
			var target = resolve(name);
			idx = target ? indexOfEl(target) : -1;
		}
		if (idx < 0) return null;

		var item = stack[idx];
		stack.splice(idx, 1);

		var el = item.el;
		var panel = item.panel;

		el.setAttribute("data-pop-state", "closed");

		// 트랜지션이 끝나기 전에 다시 열릴 수 있으므로 취소 가능하게 등록해 둔다
		var canceled = false;
		closing.set(el, {
			placeholder: item.placeholder,
			cancel: function () {
				canceled = true;
			}
		});

		afterTransition(el, panel, function () {
			if (canceled) return; // 닫히는 중에 다시 열렸다. 아무것도 정리하지 않는다.
			closing.delete(el);

			el.hidden = true;
			el.removeAttribute("data-pop-state");
			el.removeAttribute("inert");
			el.style.removeProperty("--pop-z");
			panel.style.transformOrigin = "";
			panel.removeAttribute("aria-modal");

			// 팝업 영역이 선언했던 원래 속성값 복원
			setAttr(el, "data-pop-dim", item.snapshot.dim);
			setAttr(el, "data-pop-type", item.snapshot.type);
			setAttr(el, "data-pop-size", item.snapshot.size);
			setAttr(el, "data-pop-sheet", item.snapshot.sheet);

			// 원래 자리로 되돌린다. 자리가 사라졌으면 마운트에 남겨 둔다.
			var ph = item.placeholder;
			if (ph && ph.parentNode) {
				ph.parentNode.insertBefore(el, ph);
				ph.parentNode.removeChild(ph);
			}
		});

		syncScrollLock();
		syncLayers();

		if (stack.length === 0) document.removeEventListener("keydown", onKeydown, true);

		// 포커스 복귀 — 키보드 사용자가 길을 잃지 않도록
		var back = item.returnTo;
		if (back && document.contains(back) && typeof back.focus === "function") {
			back.focus({ preventScroll: true });
		}

		el.dispatchEvent(new CustomEvent("pop:close", { bubbles: true, detail: result }));
		return el;
	}

	function closeAll(result) {
		while (stack.length) close(stack[stack.length - 1].el, result);
	}

	function isOpen(name) {
		var el = resolve(name);
		return !!el && indexOfEl(el) > -1;
	}

	function toggle(name, options) {
		return isOpen(name) ? close(name) : open(name, options);
	}

	/* ----------------------------------------------------------------------
	   키보드 — Esc는 최상단 하나만 닫고, Tab은 최상단 패널 안에서 순환한다
	   ---------------------------------------------------------------------- */

	function onKeydown(e) {
		var top = stack[stack.length - 1];
		if (!top) return;

		if (e.key === "Escape" || e.key === "Esc") {
			if (top.esc === "false") return;
			e.preventDefault();
			close(top.el);
			return;
		}

		if (e.key !== "Tab") return;

		var items = focusables(top.panel);
		if (!items.length) {
			e.preventDefault();
			top.panel.focus({ preventScroll: true });
			return;
		}

		var first = items[0];
		var last = items[items.length - 1];
		var active = document.activeElement;
		var inside = top.panel.contains(active);

		if (e.shiftKey && (active === first || !inside)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !inside)) {
			e.preventDefault();
			first.focus();
		}
	}

	/* ----------------------------------------------------------------------
	   이벤트 위임 — document에 한 번만 걸어둔다.
	   인클루드로 나중에 주입되는 GNB/LNB 안의 버튼도 그대로 동작한다.
	   ---------------------------------------------------------------------- */

	document.addEventListener("click", function (e) {
		var opener = e.target.closest ? e.target.closest("[data-pop-open]") : null;
		if (opener) {
			var name = opener.getAttribute("data-pop-open");
			if (name) {
				// <a href>로 작성된 트리거의 기본 이동을 막는다 (JS 미동작 시 폴백으로 쓰라고 둔 것)
				if (opener.tagName === "A") e.preventDefault();
				open(name, { trigger: opener });
				return;
			}
		}

		var closer = e.target.closest ? e.target.closest("[data-pop-close]") : null;
		if (closer) {
			var target = closer.getAttribute("data-pop-close");
			if (target) {
				close(target);
			} else {
				var host = closer.closest("[data-pop]");
				if (host) close(host);
			}
		}
	});

	/* 딤(가상요소) 클릭으로 닫기.

	   가상요소는 이벤트 타겟이 될 수 없다. ::before 클릭은 호스트 요소의 클릭으로
	   잡히므로 "타겟이 패널 내부가 아니면 바깥"으로 판정한다.

	   pointerdown과 pointerup을 둘 다 확인하는 이유: 패널 안에서 텍스트를 드래그하다
	   딤에서 손을 떼는 순간 닫히면 작성 중이던 내용이 날아간다. */

	document.addEventListener("pointerdown", function (e) {
		downOutside = false;

		var top = stack[stack.length - 1];
		if (!top || top.el.getAttribute("data-pop-dim") !== "true") return;
		if (!top.el.contains(e.target)) return;
		if (e.target.closest("[data-pop-panel]")) return;

		downOutside = true;
	});

	document.addEventListener("pointerup", function (e) {
		if (!downOutside) return;
		downOutside = false;

		var top = stack[stack.length - 1];
		if (!top) return;
		if (e.target.closest && e.target.closest("[data-pop-panel]")) return; // 드래그로 빠져나온 경우
		if (!top.el.contains(e.target)) return;

		close(top.el);
	});

	/* ----------------------------------------------------------------------
	   공개
	   ---------------------------------------------------------------------- */

	global.Popup = {
		open: open,
		close: close,
		closeAll: closeAll,
		isOpen: isOpen,
		toggle: toggle
	};
})(window);
