/* ==========================================================================
   컴포넌트 가이드 — 문서 페이지 인터랙션
   목차 스크롤 스파이 / 코드 토글·복사 / 상태 강제 재현 / 프리뷰 배경 전환
   ========================================================================== */

(function () {
	"use strict";

	/* ---- 목차 스크롤 스파이 --------------------------------------------- */

	function bindScrollSpy() {
		var links = Array.prototype.slice.call(document.querySelectorAll("[data-toc] a"));
		if (!links.length) return;

		var sections = links
			.map(function (link) {
				return document.querySelector(link.getAttribute("href"));
			})
			.filter(Boolean);

		if (!sections.length) return;

		function setActive(id) {
			links.forEach(function (link) {
				link.classList.toggle("is-active", link.getAttribute("href") === "#" + id);
			});
		}

		/* 화면 상단(고정 톱바 아래)을 지나는 섹션 중 가장 마지막 것을 현재 위치로 본다 */
		var observer = new IntersectionObserver(
			function () {
				var current = sections[0];
				sections.forEach(function (section) {
					if (section.getBoundingClientRect().top <= 120) current = section;
				});
				setActive(current.id);
			},
			{ rootMargin: "-120px 0px -70% 0px", threshold: [0, 1] }
		);

		sections.forEach(function (section) {
			observer.observe(section);
		});

		setActive(sections[0].id);
	}

	/* ---- 톱바 : 스크롤 시 경계선 노출 ----------------------------------- */

	function bindStickyTopbar() {
		var topbar = document.querySelector("[data-topbar]");
		if (!topbar) return;

		var onScroll = function () {
			topbar.classList.toggle("is-stuck", window.scrollY > 8);
		};

		window.addEventListener("scroll", onScroll, { passive: true });
		onScroll();
	}

	/* ---- 코드 토글 ------------------------------------------------------- */

	function bindCodeToggle() {
		document.querySelectorAll("[data-code-toggle]").forEach(function (btn) {
			btn.addEventListener("click", function () {
				var example = btn.closest(".example");
				if (!example) return;

				var code = example.querySelector(".example__code");
				if (!code) return;

				var willOpen = code.hidden;
				code.hidden = !willOpen;
				btn.setAttribute("aria-expanded", String(willOpen));
				btn.textContent = willOpen ? "코드 닫기" : "코드";
			});
		});
	}

	/* ---- 코드 복사 ------------------------------------------------------- */

	function copyText(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text);
		}
		/* file:// 등 클립보드 API를 못 쓰는 환경 대비 */
		return new Promise(function (resolve, reject) {
			var area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			try {
				document.execCommand("copy") ? resolve() : reject(new Error("복사 실패"));
			} catch (err) {
				reject(err);
			} finally {
				document.body.removeChild(area);
			}
		});
	}

	function bindCopy() {
		document.querySelectorAll("[data-copy]").forEach(function (btn) {
			btn.addEventListener("click", function () {
				var example = btn.closest(".example");
				var code = example && example.querySelector(".example__code code");
				if (!code) return;

				var original = btn.textContent;
				copyText(code.textContent.trim())
					.then(function () {
						btn.textContent = "복사됨";
						btn.classList.add("is-copied");
					})
					.catch(function () {
						btn.textContent = "복사 실패";
					})
					.then(function () {
						window.setTimeout(function () {
							btn.textContent = original;
							btn.classList.remove("is-copied");
						}, 1400);
					});
			});
		});
	}

	/* ---- 코드 문법강조 -----------------------------------------------------
	   이 페이지의 <pre><code>는 전부 우리가 직접 쓴 정적 예시 마크업이라
	   범용 HTML 파서가 아니어도 된다. 원문을 먼저 엔티티로 이스케이프한 뒤
	   그 위에서 태그/속성/문자열/주석 패턴만 정규식으로 찾아 span을 씌운다 —
	   정규식이 못 찾더라도 이스케이프된 텍스트만 남으므로 마크업이 새어 나갈
	   위험은 없다(하이라이팅이 덜 되는 정도로 안전하게 실패한다).
	   -------------------------------------------------------------------- */

	function escapeHtml(str) {
		return str
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function highlightHtml(raw) {
		var out = escapeHtml(raw);

		/* 주석 */
		out = out.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-comment">$1</span>');

		/* 속성: name="value" */
		out = out.replace(
			/([a-zA-Z-]+)(=)(&quot;[^&]*?&quot;)/g,
			'<span class="tok-attr">$1</span><span class="tok-punct">$2</span><span class="tok-string">$3</span>'
		);

		/* 여는/닫는 태그 punctuation + 태그명 */
		out = out.replace(
			/(&lt;\/?)([a-zA-Z][\w-]*)/g,
			'<span class="tok-punct">$1</span><span class="tok-tag">$2</span>'
		);

		/* 남은 > */
		out = out.replace(/(&gt;)/g, '<span class="tok-punct">$1</span>');

		return out;
	}

	function bindCodeHighlight() {
		document.querySelectorAll(".example__code code").forEach(function (code) {
			code.innerHTML = highlightHtml(code.textContent);
		});
	}

	/* ---- 상태 강제 재현 --------------------------------------------------
	   :hover / :focus-visible 같은 의사 클래스는 스크린샷으로 남기기 어렵다.
	   components.css에 같은 스타일을 공유하는 .is-* 미러 클래스를 두고,
	   여기서 그 클래스를 갈아끼워 상태를 고정해 보여준다.
	   -------------------------------------------------------------------- */

	var STATE_CLASSES = ["is-hover", "is-focus", "is-active", "is-disabled", "is-loading"];

	function bindStateSwitcher() {
		var group = document.querySelector("[data-state-switch]");
		if (!group) return;

		var targets = document.querySelectorAll("[data-state-target] .btn");

		group.querySelectorAll("button").forEach(function (btn) {
			btn.addEventListener("click", function () {
				group.querySelectorAll("button").forEach(function (other) {
					other.classList.toggle("is-selected", other === btn);
					other.setAttribute("aria-pressed", String(other === btn));
				});

				var state = btn.getAttribute("data-state");
				targets.forEach(function (target) {
					STATE_CLASSES.forEach(function (cls) {
						target.classList.remove(cls);
					});
					if (state) target.classList.add(state);
				});
			});
		});
	}

	/* ---- 프리뷰 배경 전환 ------------------------------------------------ */

	function bindStageBackground() {
		var group = document.querySelector("[data-stage-switch]");
		if (!group) return;

		group.querySelectorAll("button").forEach(function (btn) {
			btn.addEventListener("click", function () {
				group.querySelectorAll("button").forEach(function (other) {
					other.classList.toggle("is-selected", other === btn);
					other.setAttribute("aria-pressed", String(other === btn));
				});
				document.body.setAttribute("data-stage-bg", btn.getAttribute("data-stage") || "surface");
			});
		});
	}

	document.addEventListener("DOMContentLoaded", function () {
		bindScrollSpy();
		bindStickyTopbar();
		bindCodeToggle();
		bindCodeHighlight();
		bindCopy();
		bindStateSwitcher();
		bindStageBackground();
	});
})();
