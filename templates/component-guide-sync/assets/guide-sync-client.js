/* ==========================================================================
   컴포넌트 가이드 동기화 — 포터블 클라이언트 스니펫 템플릿
   assets/js/deploy.js와 동일한 패턴. guide-sync-server.js를 호출한다.

   가이드 페이지에 아래 마크업을 넣고 이 스크립트를 로드하세요:
     <span id="guide-sync-status" class="stat-chip"></span>
     <button id="btn-guide-check" class="btn">가이드 상태 확인</button>
     <button id="btn-guide-sync" class="btn btn--primary" disabled>가이드 동기화</button>
   ========================================================================== */

(function () {
	"use strict";

	var API_BASE = "http://127.0.0.1:4100"; // guide-sync-server.js의 PORT와 맞추세요.

	function setStatus(el, text, tone) {
		el.textContent = text;
		el.style.display = text ? "inline-flex" : "none";
		el.classList.remove("stat-chip--danger", "stat-chip--success");
		if (tone === "danger") el.classList.add("stat-chip--danger");
		if (tone === "success") el.classList.add("stat-chip--success");
	}

	function requestJson(path) {
		return fetch(API_BASE + path, { method: "POST" }).then(function (res) {
			return res.json().then(function (body) {
				if (!res.ok) throw new Error(body.message || "요청 실패");
				return body;
			});
		});
	}

	document.addEventListener("DOMContentLoaded", function () {
		var checkBtn = document.getElementById("btn-guide-check");
		var syncBtn = document.getElementById("btn-guide-sync");
		var statusEl = document.getElementById("guide-sync-status");

		if (!checkBtn || !syncBtn || !statusEl) return;

		setStatus(statusEl, "");

		function setBusy(busy) {
			checkBtn.disabled = busy;
			syncBtn.disabled = busy ? true : syncBtn.disabled;
		}

		checkBtn.addEventListener("click", function () {
			setBusy(true);
			setStatus(statusEl, "변경 확인 중…");

			requestJson("/api/guide/check")
				.then(function (result) {
					if (result.status === "error") {
						setStatus(statusEl, result.message, "danger");
						syncBtn.disabled = true;
						return;
					}
					if (!result.hasDrift) {
						setStatus(statusEl, "최신 상태 (변경 없음)", "success");
						syncBtn.disabled = true;
						return;
					}
					setStatus(statusEl, result.files.length + "개 파일 변경됨 — 동기화 필요", "danger");
					syncBtn.disabled = false;
				})
				.catch(function (err) {
					setStatus(statusEl, "확인 실패: " + err.message, "danger");
				})
				.finally(function () {
					checkBtn.disabled = false;
				});
		});

		syncBtn.addEventListener("click", function () {
			var ok = window.confirm(
				"Claude가 변경된 컴포넌트 소스(스타일/스크립트/마크업 템플릿)를 바탕으로 가이드 페이지 예시를 직접 수정합니다.\n" +
					"커밋은 하지 않으니, 완료 후 diff를 직접 검토·커밋해주세요. 계속할까요?"
			);
			if (!ok) return;

			setBusy(true);
			setStatus(statusEl, "가이드 동기화 중… (Claude 실행)");

			requestJson("/api/guide/sync")
				.then(function (result) {
					if (result.status === "error") {
						setStatus(statusEl, "동기화 실패: " + result.message, "danger");
						return;
					}
					if (result.status === "no-changes") {
						setStatus(statusEl, "변경 없음", "success");
						syncBtn.disabled = true;
						return;
					}
					setStatus(statusEl, "동기화 완료 — 콘솔 로그에서 요약을 확인하세요", "success");
					// eslint-disable-next-line no-console
					console.log("[guide-sync] " + result.summary);
					syncBtn.disabled = true;
				})
				.catch(function (err) {
					setStatus(statusEl, "동기화 실패: " + err.message, "danger");
				})
				.finally(function () {
					checkBtn.disabled = false;
				});
		});
	});
})();
