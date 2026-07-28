/* ==========================================================================
   테마 전환 — 다크/라이트 토글, 저장, 시스템 테마 추종
   FOUC 방지용 초기 세팅 스크립트는 각 HTML <head>에 인라인으로 별도 존재.
   이 파일은 토글 버튼 바인딩과 이후 상태 동기화만 담당한다.
   ========================================================================== */

(function () {
	"use strict";

	var STORAGE_KEY = "dashboard-theme";

	function readStoredTheme() {
		try {
			return localStorage.getItem(STORAGE_KEY);
		} catch (err) {
			return null;
		}
	}

	function storeTheme(theme) {
		try {
			localStorage.setItem(STORAGE_KEY, theme);
		} catch (err) {
			/* file:// 등 접근 불가 환경에서는 조용히 무시하고 세션 내에서만 유지 */
		}
	}

	function applyTheme(theme) {
		document.documentElement.setAttribute("data-theme", theme);
	}

	function currentTheme() {
		return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
	}

	function toggleTheme() {
		var next = currentTheme() === "dark" ? "light" : "dark";
		applyTheme(next);
		storeTheme(next);
	}

	document.addEventListener("DOMContentLoaded", function () {
		var toggles = document.querySelectorAll("[data-theme-toggle]");
		toggles.forEach(function (btn) {
			btn.addEventListener("click", toggleTheme);
		});

		/* 저장된 선택이 없을 때만 시스템 테마 변경에 실시간으로 따라간다 */
		if (!readStoredTheme() && window.matchMedia) {
			var media = window.matchMedia("(prefers-color-scheme: dark)");
			var onChange = function (e) {
				applyTheme(e.matches ? "dark" : "light");
			};
			if (media.addEventListener) {
				media.addEventListener("change", onChange);
			}
		}
	});
})();
