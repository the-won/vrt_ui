/* ==========================================================================
   Jenkins 배포 버튼 — 로컬 deploy-server를 호출해 vrt-results/ 변경분을 커밋·푸시·되돌리기
   서버가 꺼져 있으면(fetch 실패) 안내 메시지만 표시하고 조용히 무시한다.
   ========================================================================== */

(function () {
	"use strict";

	var API_BASE = "http://127.0.0.1:4000";

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
		var deployBtn = document.getElementById("btn-jenkins-deploy");
		var pushBtn = document.getElementById("btn-jenkins-push");
		var revertBtn = document.getElementById("btn-jenkins-revert");
		var statusEl = document.getElementById("deploy-status");

		if (!deployBtn || !pushBtn || !revertBtn || !statusEl) return;

		setStatus(statusEl, "");

		// 서버의 lastCommit 상태를 그대로 반영하는 클라이언트 측 미러.
		// hasCommit: 되돌릴 수 있는 커밋이 남아있는지, isPushed: 그 커밋이 이미 push됐는지.
		var hasCommit = false;
		var isPushed = false;

		function syncButtons() {
			pushBtn.disabled = !(hasCommit && !isPushed);
			revertBtn.disabled = !hasCommit;
		}

		function setBusy(busy) {
			deployBtn.disabled = busy;
			if (busy) {
				pushBtn.disabled = true;
				revertBtn.disabled = true;
			} else {
				syncButtons();
			}
		}

		deployBtn.addEventListener("click", function () {
			setBusy(true);
			setStatus(statusEl, "커밋 중…");

			requestJson("/api/deploy/commit")
				.then(function (result) {
					if (result.status === "no-changes") {
						setStatus(statusEl, "변경 없음");
						return;
					}
					hasCommit = true;
					isPushed = false;
					setStatus(statusEl, result.files.length + "개 파일 커밋됨 (" + result.sha + ")", "success");
				})
				.catch(function (err) {
					setStatus(statusEl, "커밋 실패: " + err.message, "danger");
				})
				.finally(function () {
					setBusy(false);
				});
		});

		pushBtn.addEventListener("click", function () {
			var ok = window.confirm("origin/master로 push 하시겠습니까?");
			if (!ok) return;

			setBusy(true);
			setStatus(statusEl, "push 중…");

			requestJson("/api/deploy/push")
				.then(function (result) {
					isPushed = true;
					setStatus(statusEl, "push 완료 (" + result.remote + "/" + result.branch + ")", "success");
				})
				.catch(function (err) {
					setStatus(statusEl, "push 실패: " + err.message, "danger");
				})
				.finally(function () {
					setBusy(false);
				});
		});

		revertBtn.addEventListener("click", function () {
			var ok = window.confirm(
				"마지막 자동 커밋을 되돌릴까요?\n(아직 push 전이면 로컬에서 취소되고, 이미 push된 경우 되돌리는 새 커밋이 생성됩니다)"
			);
			if (!ok) return;

			setBusy(true);
			setStatus(statusEl, "되돌리는 중…");

			requestJson("/api/deploy/revert")
				.then(function (result) {
					if (result.status === "error") {
						setStatus(statusEl, "되돌리기 실패: " + result.message, "danger");
						return;
					}
					if (result.mode === "reset") {
						hasCommit = false;
						isPushed = false;
						setStatus(statusEl, "되돌리기 완료 (로컬 커밋 취소됨)", "success");
						return;
					}
					hasCommit = true;
					isPushed = false;
					setStatus(statusEl, "되돌리기 완료 (revert 커밋 " + result.sha + ", push 필요)", "success");
				})
				.catch(function (err) {
					setStatus(statusEl, "되돌리기 실패: " + err.message, "danger");
				})
				.finally(function () {
					setBusy(false);
				});
		});
	});
})();
