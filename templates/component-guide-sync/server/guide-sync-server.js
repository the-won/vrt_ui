// 컴포넌트 가이드 자동 동기화 — 포터블 트리거 서버 템플릿
//
// deploy-server.js와 동일한 패턴(순수 http, 외부 의존성 없음, 127.0.0.1 전용)으로,
// git 명령 대신 "claude -p" 헤드리스 실행으로 component-guide-sync 스킬을 호출한다.
//
// 사용 전 아래 "설정" 블록을 실제 프로젝트에 맞게 채우세요.
"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// ── 설정 (저장소 루트 = guide/, resources/ 컨벤션 기준 기본값. 실제 폴더명이 다르면 수정하세요) ──
const GUIDE_PAGE_PATH = "guide"; // 가이드 페이지가 들어있는 폴더(또는 특정 파일 경로)
const WATCHED_PATHS = ["resources"]; // 감지 대상 리소스 폴더(스타일·스크립트·마크업 템플릿 등)
const STATE_FILE = path.join(__dirname, ".guide-sync-state.json");
const PORT = 4100;
const HOST = "127.0.0.1";
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5501",
  "http://127.0.0.1:5501",
  // 가이드 페이지를 서빙하는 실제 포트를 추가하세요.
]);
// ────────────────────────────────────────────────────────────────────

function isConfigured() {
  const placeholder = /</;
  return (
    !placeholder.test(GUIDE_PAGE_PATH) &&
    WATCHED_PATHS.length > 0 &&
    WATCHED_PATHS.every((p) => !placeholder.test(p))
  );
}

// 이 서버 파일이 저장소 어디에 있든(depth 무관) 실제 git 루트를 물어봐서 캐싱한다.
// __dirname 기준 상대경로 계산(path.resolve(__dirname, "..") 등)에 의존하지 않는다.
let repoRootPromise = null;
function getRepoRoot() {
  if (!repoRootPromise) {
    repoRootPromise = execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: __dirname }).then(
      (r) => path.normalize(r.stdout.trim())
    );
  }
  return repoRootPromise;
}

async function git(args) {
  const repoRoot = await getRepoRoot();
  return execFileAsync("git", args, { cwd: repoRoot });
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return { lastSyncSha: null };
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function detectDrift() {
  const state = await readState();
  const { stdout: headOut } = await git(["rev-parse", "--short", "HEAD"]);
  const headSha = headOut.trim();

  if (!state.lastSyncSha) {
    return { hasDrift: true, files: WATCHED_PATHS.slice(), headSha, reason: "no-baseline" };
  }

  if (state.lastSyncSha === headSha) {
    return { hasDrift: false, files: [], headSha };
  }

  const { stdout } = await git([
    "diff",
    "--name-only",
    state.lastSyncSha,
    headSha,
    "--",
    ...WATCHED_PATHS,
  ]);
  const files = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return { hasDrift: files.length > 0, files, headSha };
}

async function handleCheck() {
  if (!isConfigured()) {
    return {
      status: "error",
      message: "guide-sync-server.js 상단의 GUIDE_PAGE_PATH / WATCHED_PATHS를 먼저 채워주세요.",
    };
  }
  const drift = await detectDrift();
  return { status: "ok", ...drift };
}

async function handleSync() {
  if (!isConfigured()) {
    return {
      status: "error",
      message: "guide-sync-server.js 상단의 GUIDE_PAGE_PATH / WATCHED_PATHS를 먼저 채워주세요.",
    };
  }

  const drift = await detectDrift();
  if (!drift.hasDrift) {
    return { status: "no-changes" };
  }

  const prompt =
    `/component-guide-sync 다음 파일이 변경되었습니다:\n` +
    drift.files.map((f) => `- ${f}`).join("\n") +
    `\n가이드 페이지(${GUIDE_PAGE_PATH})에서 관련 예시를 위 변경사항에 맞게 갱신해줘.`;

  let stdout;
  try {
    const repoRoot = await getRepoRoot();
    // 주의: --allowedTools는 가변 인자(variadic)라서 prompt보다 뒤에 둬야 한다.
    // prompt를 뒤에 두면 --allowedTools가 prompt까지 자기 값으로 삼켜버려 "prompt 없음" 에러가 난다.
    const result = await execFileAsync(
      "claude",
      [
        "-p",
        prompt,
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read",
        "Edit",
        "Grep",
        "Glob",
      ],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024, timeout: 5 * 60 * 1000 }
    );
    stdout = result.stdout;
  } catch (err) {
    return {
      status: "error",
      message: err.stderr ? err.stderr.toString() : err.message,
    };
  }

  await writeState({ lastSyncSha: drift.headSha });

  return { status: "synced", summary: stdout.trim(), files: drift.files };
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
  "/api/guide/check": handleCheck,
  "/api/guide/sync": handleSync,
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
  console.log(`[guide-sync-server] http://${HOST}:${PORT} 에서 대기 중`);
  if (!isConfigured()) {
    console.log("  ⚠ 아직 설정이 채워지지 않았습니다 (GUIDE_PAGE_PATH / WATCHED_PATHS).");
  }
});
