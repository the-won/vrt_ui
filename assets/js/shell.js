/* ==========================================================================
   레이아웃 셸 인터랙션 — 사이드바 접기 / 인스펙터 드로어 / 필터 탭
   세 변형이 공유하되, 각 페이지에는 해당하는 요소만 존재하므로
   요소가 없으면 조용히 건너뛴다.
   ========================================================================== */

(function () {
	"use strict";

	document.addEventListener("DOMContentLoaded", function () {
		autoCloseDrawerOnNarrowViewport();
		bindSidebarCollapse();
		bindDrawerToggle();
		bindTabs();
		bindMobileNavToggle();
		bindStickyHeaderShadow();
		bindDatePicker();
	});

	/* ---- 변형 C : 1200px 미만 진입 시 인스펙터를 기본적으로 닫아둔다 ---- */
	function autoCloseDrawerOnNarrowViewport() {
		var shell = document.querySelector("[data-app-shell]");
		if (!shell || !shell.hasAttribute("data-drawer-state")) return;
		if (window.innerWidth < 1200) {
			shell.setAttribute("data-drawer-state", "closed");
		}
	}

	/* ---- 변형 A : 사이드바 260px ↔ 72px 아이콘 레일 ---- */
	function bindSidebarCollapse() {
		var btn = document.querySelector("[data-sidebar-collapse]");
		var shell = document.querySelector("[data-app-shell]");
		if (!btn || !shell) return;

		btn.addEventListener("click", function () {
			var collapsed = shell.getAttribute("data-sidebar-state") === "collapsed";
			shell.setAttribute("data-sidebar-state", collapsed ? "expanded" : "collapsed");
		});
	}

	/* ---- 변형 C : 인스펙터 드로어 열고 닫기 (톱바 토글 + 인스펙터 내부 닫기 버튼 둘 다 바인딩) ---- */
	function bindDrawerToggle() {
		var btns = document.querySelectorAll("[data-drawer-toggle]");
		var shell = document.querySelector("[data-app-shell]");
		if (!btns.length || !shell) return;

		btns.forEach(function (btn) {
			btn.addEventListener("click", function () {
				var open = shell.getAttribute("data-drawer-state") !== "closed";
				shell.setAttribute("data-drawer-state", open ? "closed" : "open");
			});
		});
	}

	/* ---- 공용 : 필터바/헤더 탭 활성 상태 전환 ---- */
	function bindTabs() {
		var groups = document.querySelectorAll("[data-tab-group]");
		groups.forEach(function (group) {
			var tabs = group.querySelectorAll("[data-tab]");
			tabs.forEach(function (tab) {
				tab.addEventListener("click", function () {
					tabs.forEach(function (t) {
						t.classList.remove("is-active");
					});
					tab.classList.add("is-active");
				});
			});
		});
	}

	/* ---- 공용 : 스크롤 시 sticky 헤더에 경계선 표시 ---- */
	function bindStickyHeaderShadow() {
		var scrollRegions = document.querySelectorAll("[data-scroll-shadow-root]");
		scrollRegions.forEach(function (root) {
			var header = root.querySelector("[data-sticky-header]");
			if (!header) return;
			root.addEventListener("scroll", function () {
				header.classList.toggle("is-scrolled", root.scrollTop > 4);
			});
		});
	}

	/* ---- 공용 : 날짜 칩 클릭 시 월간 캘린더 팝오버 ---- */
	function bindDatePicker() {
		var pickers = document.querySelectorAll(".date-picker");

		pickers.forEach(function (picker) {
			var toggle = picker.querySelector("[data-date-picker-toggle]");
			var panel = picker.querySelector("[data-date-picker-panel]");
			var label = picker.querySelector("[data-date-picker-label]");
			var title = picker.querySelector("[data-date-picker-title]");
			var grid = picker.querySelector("[data-date-picker-grid]");
			var prevBtn = picker.querySelector("[data-date-picker-prev]");
			var nextBtn = picker.querySelector("[data-date-picker-next]");
			if (!toggle || !panel || !grid) return;

			var today = new Date();
			var selected = null;
			var viewYear = today.getFullYear();
			var viewMonth = today.getMonth();

			function isSameDate(a, b) {
				return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
			}

			function formatDate(d) {
				return (d.getMonth() + 1) + "월 " + d.getDate() + "일";
			}

			function makeDayButton(dayNum, dateObj) {
				var el = document.createElement("button");
				el.type = "button";
				el.className = "date-picker__day";
				el.textContent = String(dayNum);

				if (!dateObj) {
					el.classList.add("date-picker__day--muted");
					el.disabled = true;
					return el;
				}

				if (isSameDate(dateObj, today)) el.classList.add("date-picker__day--today");
				if (selected && isSameDate(dateObj, selected)) el.classList.add("date-picker__day--selected");

				el.addEventListener("click", function () {
					selected = dateObj;
					if (label) label.textContent = formatDate(dateObj);
					closePanel();
				});

				return el;
			}

			function render() {
				if (title) title.textContent = viewYear + "년 " + (viewMonth + 1) + "월";
				grid.innerHTML = "";

				var firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
				var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
				var totalCells = firstWeekday + daysInMonth;
				var trailing = (7 - (totalCells % 7)) % 7;

				for (var i = 0; i < firstWeekday; i++) {
					grid.appendChild(makeDayButton("", null));
				}
				for (var day = 1; day <= daysInMonth; day++) {
					grid.appendChild(makeDayButton(day, new Date(viewYear, viewMonth, day)));
				}
				for (var t = 0; t < trailing; t++) {
					grid.appendChild(makeDayButton("", null));
				}
			}

			function onOutsideClick(e) {
				if (!picker.contains(e.target)) closePanel();
			}

			function onKeydown(e) {
				if (e.key === "Escape") closePanel();
			}

			function openPanel() {
				panel.hidden = false;
				toggle.setAttribute("aria-expanded", "true");
				render();
				document.addEventListener("click", onOutsideClick);
				document.addEventListener("keydown", onKeydown);
			}

			function closePanel() {
				panel.hidden = true;
				toggle.setAttribute("aria-expanded", "false");
				document.removeEventListener("click", onOutsideClick);
				document.removeEventListener("keydown", onKeydown);
			}

			toggle.addEventListener("click", function (e) {
				e.stopPropagation();
				if (panel.hidden) {
					openPanel();
				} else {
					closePanel();
				}
			});

			if (prevBtn) {
				prevBtn.addEventListener("click", function () {
					viewMonth -= 1;
					if (viewMonth < 0) {
						viewMonth = 11;
						viewYear -= 1;
					}
					render();
				});
			}

			if (nextBtn) {
				nextBtn.addEventListener("click", function () {
					viewMonth += 1;
					if (viewMonth > 11) {
						viewMonth = 0;
						viewYear += 1;
					}
					render();
				});
			}
		});
	}

	/* ---- 공용 : 태블릿 폭에서 사이드바/레일을 오버레이로 여닫기 ---- */
	function bindMobileNavToggle() {
		var btn = document.querySelector("[data-mobile-nav-toggle]");
		var shell = document.querySelector("[data-app-shell]");
		if (!btn || !shell) return;

		btn.addEventListener("click", function () {
			var open = shell.getAttribute("data-mobile-nav") === "open";
			shell.setAttribute("data-mobile-nav", open ? "closed" : "open");
		});
	}
})();
