/* ==========================================================================
   레이어팝업 매니저 — 외부 의존성 없음 (jQuery 유무와 무관하게 동작)

   코어 동작은 하나다: 페이지 안에 이미 존재하는 [data-pop] 영역을
   안 보이게 두었다가, 보이게 한다. 파일을 가져오지(fetch) 않는다.

   공개 API
     Popup.open(name, options)   options: { dim, type, side, drawer, size, origin, sheet, esc, scroll, trigger }
     Popup.close(name, result)   name 생략 시 최상단 팝업
     Popup.closeAll()
     Popup.isOpen(name)
     Popup.toggle(name, options)

   옵션 기본값
     dim     "true"      (true | false | static) — push·squeeze 드로어는 "false"
     type    "layer"     (layer | full | drawer)
     side    "left"      (left | right)                       — drawer일 때만
     drawer  "overlay"   (overlay | float | push | squeeze)   — drawer일 때만
                         push·squeeze는 [data-pop-push-target] 감싸개가 필요하고,
                         기본이 비모달(딤·스크롤잠금 없음)이다
     size    없음        (sm | md | lg — 선언했을 때만 폭 제한)
     origin  "center"    (center | trigger)
     sheet   없음        (mobile | always)
     esc     "true"
     scroll  dim이 false면 "false", 아니면 "true"

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

	// 이름에 따옴표·대괄호 등이 섞여도 속성 선택자가 깨지지 않게 이스케이프
	function escapeName(name) {
		return global.CSS && CSS.escape ? CSS.escape(name) : String(name).replace(/["\\]/g, "\\$&");
	}

	function resolve(name) {
		if (!name) return null;
		if (typeof name !== "string") return name; // 요소를 직접 넘긴 경우
		return document.querySelector('[data-pop="' + escapeName(name) + '"]');
	}

	/* 이 팝업을 여는 버튼들에 열림 상태를 알린다 (aria-expanded).
	   햄버거 메뉴처럼 같은 버튼이 "지금 펼쳐져 있다"는 걸 스크린리더에 전해야 할 때 필요하다. */
	function syncExpanded(el, opened) {
		var name = el.getAttribute("data-pop");
		if (!name) return;
		var btns = document.querySelectorAll('[data-pop-open="' + escapeName(name) + '"]');
		for (var i = 0; i < btns.length; i++) btns[i].setAttribute("aria-expanded", opened ? "true" : "false");
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

	/* 처음 포커스를 줄 요소.
	   [autofocus] → 닫기 버튼을 제외한 첫 포커서블 → 패널 자체.
	   헤더의 X 버튼이 먼저 잡히면 키보드로 연 직후 Enter 한 번에 닫혀 버린다. */
	function initialFocus(panel) {
		var auto = panel.querySelector("[autofocus]");
		if (auto) return auto;

		var list = focusables(panel);
		for (var i = 0; i < list.length; i++) {
			if (!list[i].closest("[data-pop-close]")) return list[i];
		}
		return panel;
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

	// 잠금 동안 덮어쓰는 body 인라인 속성. 원래 인라인 값을 기억했다가 그대로 되돌린다.
	var LOCK_PROPS = ["height", "top", "padding-right"];
	var savedInline = null;

	function lockScroll() {
		if (document.body.hasAttribute("data-pop-locked")) return;

		var bs = document.body.style;
		savedScrollY = global.scrollY || global.pageYOffset || 0;

		savedInline = {};
		LOCK_PROPS.forEach(function (p) {
			savedInline[p] = [bs.getPropertyValue(p), bs.getPropertyPriority(p)];
		});

		/* 스크롤바가 사라지면서 생기는 레이아웃 점프 보정 (PC).
		   기존 body에 padding-right가 있었을 수 있으므로 "대체"가 아니라 "더한다".
		   --pop-sbw는 고정(fixed) 헤더 등 body 밖 요소가 같은 보정을 할 때 쓰라고 노출한다. */
		var sbw = global.innerWidth - document.documentElement.clientWidth;
		document.documentElement.style.setProperty("--pop-sbw", sbw > 0 ? sbw + "px" : "0px");
		if (sbw > 0) {
			var pr = parseFloat(global.getComputedStyle(document.body).paddingRight) || 0;
			bs.setProperty("padding-right", pr + sbw + "px", "important");
		}

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
		bs.setProperty("height", "auto", "important");
		bs.setProperty("top", "-" + savedScrollY + "px", "important");
		document.body.setAttribute("data-pop-locked", "");
	}

	function unlockScroll() {
		if (!document.body.hasAttribute("data-pop-locked")) return;

		var bs = document.body.style;
		document.body.removeAttribute("data-pop-locked");

		LOCK_PROPS.forEach(function (p) {
			var v = savedInline && savedInline[p];
			if (v && v[0]) bs.setProperty(p, v[0], v[1]);
			else bs.removeProperty(p);
		});
		savedInline = null;

		/* 위치 복원 (iOS에서 특히 중요).
		   기존 페이지가 html { scroll-behavior: smooth }면 복원이 애니메이션으로
		   보여 맨 위에서부터 스르륵 내려간다. 복원하는 순간만 즉시 이동으로 바꾼다. */
		var html = document.documentElement;
		var prevBehavior = html.style.scrollBehavior;
		html.style.scrollBehavior = "auto";
		global.scrollTo(0, savedScrollY);
		html.style.scrollBehavior = prevBehavior;
	}

	/* ----------------------------------------------------------------------
	   드로어 본문 밀기 (data-pop-drawer="push" | "squeeze")

	   push    : 본문 감싸개를 패널 폭만큼 transform으로 옆으로 민다 (일부가 화면 밖으로)
	   squeeze : 본문 감싸개의 안쪽 여백을 패널 폭만큼 늘려 폭을 줄인다 (다시 배치됨)
	             좁은 화면(640px 이하)에서는 본문이 너무 좁아지므로 push로 바꾼다.

	   squeeze의 여백은 기존 값을 "대체"하지 않고 "더한다". 감싸개에 원래 padding이
	   있을 수 있어서, 원래 인라인 값을 기억했다가 닫을 때 그대로 되돌린다.
	   ---------------------------------------------------------------------- */

	var SQUEEZE_MIN_W = 641;

	function applyPush(item) {
		var target = item.pushTarget;
		var w = item.panel.offsetWidth;
		var right = item.side === "right";
		var mode = item.drawer === "squeeze" && global.innerWidth >= SQUEEZE_MIN_W ? "squeeze" : "push";

		if (mode === "squeeze") {
			var prop = right ? "padding-right" : "padding-left";
			var base = parseFloat(global.getComputedStyle(target)[right ? "paddingRight" : "paddingLeft"]) || 0;
			item.pushSaved = [prop, target.style.getPropertyValue(prop), target.style.getPropertyPriority(prop)];
			target.style.setProperty(prop, base + w + "px", "important");
		} else {
			target.style.setProperty("--pop-push", w + "px");
		}

		target.setAttribute("data-pop-pushed", right ? "right" : "left");
		target.setAttribute("data-pop-push-mode", mode);
		target.setAttribute("data-pop-push-owner", item.el.getAttribute("data-pop") || "");
		document.documentElement.setAttribute("data-pop-pushing", "");
	}

	function releasePush(item) {
		var target = item.pushTarget;
		if (!target) return;

		// 그 사이 다른 드로어가 본문을 밀었다면 그쪽 상태를 지우지 않는다
		if (target.getAttribute("data-pop-push-owner") !== (item.el.getAttribute("data-pop") || "")) return;

		target.removeAttribute("data-pop-pushed");
		target.removeAttribute("data-pop-push-mode");
		target.removeAttribute("data-pop-push-owner");
		target.style.removeProperty("--pop-push");

		if (item.pushSaved) {
			var s = item.pushSaved;
			if (s[1]) target.style.setProperty(s[0], s[1], s[2]);
			else target.style.removeProperty(s[0]);
			item.pushSaved = null;
		}
	}

	// 본문이 원위치로 돌아오는 동안까지는 가로 스크롤바를 막아둔다
	function syncPushing() {
		for (var i = 0; i < stack.length; i++) {
			if (stack[i].pushTarget) return;
		}
		document.documentElement.removeAttribute("data-pop-pushing");
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
		var w = panel.offsetWidth;
		var h = panel.offsetHeight;
		if (!w || !h) return;

		/* getBoundingClientRect는 scale이 적용된 크기라 그대로 쓰면 오차가 난다.
		   transform-origin이 기본(중앙)인 상태에서 재므로 중심점은 변형 전과 같다.
		   중심점에서 변형 전 크기(offsetWidth/Height)로 원래 박스를 역산한다. */
		var left = p.left + p.width / 2 - w / 2;
		var top = p.top + p.height / 2 - h / 2;

		var ox = ((t.left + t.width / 2 - left) / w) * 100;
		var oy = ((t.top + t.height / 2 - top) / h) * 100;

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
		var type = pick(options.type, tds.popType, eds.popType, "layer");
		var isDrawer = type === "drawer";
		var side = isDrawer ? pick(options.side, tds.popSide, eds.popSide, "left") : "";
		var drawer = isDrawer ? pick(options.drawer, tds.popDrawer, eds.popDrawer, "overlay") : "";

		// 본문을 미는 드로어는 밀려날 감싸개가 있어야 한다. 없으면 경고하고 덮는 방식으로 띄운다.
		var pushTarget = null;
		if (drawer === "push" || drawer === "squeeze") {
			pushTarget = document.querySelector("[data-pop-push-target]");
			if (!pushTarget || pushTarget === document.body) {
				console.warn("[popup] data-pop-push-target 감싸개가 없어(또는 body라서) overlay로 엽니다:", name);
				pushTarget = null;
				drawer = "overlay";
			}
		}

		// 본문을 미는 드로어는 본문을 계속 쓰라고 여는 것이므로 기본이 비모달(딤 없음)이다
		var dim = pick(options.dim, tds.popDim, eds.popDim, pushTarget ? "false" : "true");
		// 크기는 기본값을 강제하지 않는다. 기존 팝업이 자기 폭(예: 600px)을 갖고 있으면 그대로 둔다.
		var size = pick(options.size, tds.popSize, eds.popSize, "");
		var origin = pick(options.origin, tds.popOrigin, eds.popOrigin, "center");
		var sheet = pick(options.sheet, tds.popSheet, eds.popSheet, "");
		var esc = pick(options.esc, tds.popEsc, eds.popEsc, "true");
		// 딤이 없는 팝업은 뒤 페이지를 계속 쓰는 비모달이므로 기본적으로 스크롤도 잠그지 않는다.
		var scroll = pick(options.scroll, tds.popScroll, eds.popScroll, dim === "false" ? "false" : "true");

		// 클릭 위치 효과는 중앙 박스에서만 의미가 있다 (전체화면·시트는 화면 가장자리에 붙으므로 제외)
		var fromTrigger = origin === "trigger" && !!trigger && type === "layer" && !sheet;

		// 팝업 영역이 선언한 원래 값. 닫을 때 그대로 되돌려 저자 선언을 보존한다.
		var snapshot = {
			dim: el.getAttribute("data-pop-dim"),
			type: el.getAttribute("data-pop-type"),
			size: el.getAttribute("data-pop-size"),
			sheet: el.getAttribute("data-pop-sheet"),
			origin: el.getAttribute("data-pop-origin"),
			side: el.getAttribute("data-pop-side"),
			drawer: el.getAttribute("data-pop-drawer")
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
		if (size) setAttr(el, "data-pop-size", size);
		if (sheet) setAttr(el, "data-pop-sheet", sheet);
		if (isDrawer) {
			setAttr(el, "data-pop-side", side);
			setAttr(el, "data-pop-drawer", drawer);
		}
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
			side: side,
			drawer: drawer,
			pushTarget: pushTarget,
			pushSaved: null,
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

		/* 클릭 위치에서 열기: 기준점은 transform-origin이 중앙인 상태에서 먼저 재고,
		   그 다음 data-pop-origin="trigger"를 붙여 시작 크기를 작게(scale 0.5) 만든다.
		   순서를 바꾸면 이미 작아진 박스를 재게 되어 기준점이 틀어진다. */
		panel.style.transformOrigin = "";
		if (fromTrigger) applyOrigin(panel, trigger);
		setAttr(el, "data-pop-origin", fromTrigger ? "trigger" : "center");

		void el.offsetWidth;
		el.setAttribute("data-pop-state", "open");

		// 패널과 같은 프레임에서 본문도 밀기 시작해야 둘이 함께 움직인다
		if (pushTarget) applyPush(item);
		syncExpanded(el, true);

		syncScrollLock();
		syncLayers();

		if (stack.length === 1) document.addEventListener("keydown", onKeydown, true);

		initialFocus(panel).focus({ preventScroll: true });

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

		// 본문은 패널이 들어가는 것과 동시에 원위치로 돌아오기 시작한다
		releasePush(item);
		syncExpanded(el, false);

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
			setAttr(el, "data-pop-origin", item.snapshot.origin);
			setAttr(el, "data-pop-side", item.snapshot.side);
			setAttr(el, "data-pop-drawer", item.snapshot.drawer);
			syncPushing();

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

		// 한글 등 IME 조합 중의 키 입력은 무시한다. 조합 중 Esc로 팝업이 닫히면 입력이 날아간다.
		if (e.isComposing || e.keyCode === 229) return;

		if (e.key === "Escape" || e.key === "Esc") {
			if (top.esc === "false") return;
			e.preventDefault();
			close(top.el);
			return;
		}

		if (e.key !== "Tab") return;

		// 딤 없는 팝업은 비모달이다. 뒤 페이지를 쓸 수 있으므로 Tab도 가두지 않는다.
		if (top.dim === "false") return;

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
				/* 이미 열려 있으면 닫는다. 모달 팝업은 딤이 버튼을 덮어 이 경우가 생기지 않고,
				   본문을 쓰면서 열어두는 드로어(햄버거 메뉴)는 같은 버튼으로 다시 접는다. */
				if (isOpen(name)) close(name);
				else open(name, { trigger: opener });
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
