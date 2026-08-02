// VRT 콘솔 "Jenkins 배포" 버튼용 로컬 git 자동화 서버
// vrt-results/ 폴더의 신규·변경 파일을 감지해 커밋하고, push는 별도 확인 후에만 실행한다.
"use strict";

const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "..");
const TARGET_DIR = "vrt-results";
const REMOTE = "origin";
const BRANCH = "master";
const PORT = 4000;
const HOST = "127.0.0.1";
const ALLOWED_ORIGINS = new Set(["http://localhost:5501", "http://127.0.0.1:5501"]);

function git(args) {
  return execFileAsync("git", args, { cwd: REPO_ROOT });
}

// 이 서버가 마지막으로 만든 자동 커밋 상태. 서버 재시작 시 초기화되며,
// 그 경우 되돌리기는 "되돌릴 커밋 없음"으로 처리된다.
let lastCommit = null;

// `git status --porcelain` 출력에서 상태 코드(앞 2자리)를 제외한 경로만 추출한다.
// rename의 경우 "R  old -> new" 형태이므로 "->" 뒤의 새 경로를 사용한다.
function parseChangedFiles(porcelainOutput) {
  return porcelainOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(3);
      const arrowIndex = rest.indexOf("->");
      return arrowIndex === -1 ? rest.trim() : rest.slice(arrowIndex + 2).trim();
    });
}

async function handleCommit() {
  const { stdout } = await git(["status", "--porcelain", "--untracked-files=all", "--", TARGET_DIR]);
  const files = parseChangedFiles(stdout);

  if (files.length === 0) {
    return { status: "no-changes", files: [] };
  }

  await git(["add", "--", TARGET_DIR]);

  const timestamp = new Date().toISOString();
  const message = `VRT 결과 자동 커밋: ${files.length}개 파일 (${TARGET_DIR}) - ${timestamp}`;
  await git(["commit", "-m", message]);

  const { stdout: shaOut } = await git(["rev-parse", "--short", "HEAD"]);
  const sha = shaOut.trim();
  lastCommit = { sha, pushed: false };

  return { status: "committed", files, sha, message };
}

async function handlePush() {
  await git(["push", REMOTE, BRANCH]);
  if (lastCommit) lastCommit.pushed = true;
  return { status: "pushed", remote: REMOTE, branch: BRANCH };
}

async function handleRevert() {
  if (!lastCommit) {
    return { status: "error", message: "되돌릴 커밋이 없습니다" };
  }

  const { stdout: headOut } = await git(["rev-parse", "--short", "HEAD"]);
  if (headOut.trim() !== lastCommit.sha) {
    return {
      status: "error",
      message: "HEAD가 예상과 다릅니다. 다른 변경이 있었을 수 있습니다",
    };
  }

  if (!lastCommit.pushed) {
    await git(["reset", "--mixed", "HEAD~1"]);
    lastCommit = null;
    return { status: "reverted", mode: "reset" };
  }

  await git(["revert", "--no-edit", lastCommit.sha]);
  const { stdout: newShaOut } = await git(["rev-parse", "--short", "HEAD"]);
  const sha = newShaOut.trim();
  lastCommit = { sha, pushed: false };

  return { status: "reverted", mode: "revert-commit", sha };
}

function withCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const routes = {
  "/api/deploy/commit": handleCommit,
  "/api/deploy/push": handlePush,
  "/api/deploy/revert": handleRevert,
};

const server = http.createServer(async (req, res) => {
  withCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const handler = req.method === "POST" ? routes[req.url] : undefined;

  if (!handler) {
    sendJson(res, 404, { status: "error", message: "not found" });
    return;
  }

  try {
    const result = await handler();
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, {
      status: "error",
      message: err.stderr ? err.stderr.toString() : err.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[deploy-server] http://${HOST}:${PORT} 에서 대기 중 (대상 폴더: ${TARGET_DIR})`);
});
