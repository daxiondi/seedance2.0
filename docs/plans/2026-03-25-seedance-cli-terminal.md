# Seedance Terminal CLI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a terminal-first CLI that lets end users create Seedance video generation tasks, poll task status, and download finished videos against the Ark-compatible Seedance endpoint described in the requirement doc.

**Architecture:** Add a standalone publishable CLI package under this repo instead of reusing the current browser-only `jimeng` flow. The CLI will call the Ark-compatible HTTP API directly, accept user-supplied API keys, validate local media against the documented constraints, convert eligible local files into request-safe payloads, and expose explicit `create/get/wait/download` commands.

**Tech Stack:** Node.js 20+, native `fetch`, ESM, `commander`, built-in `node:test`, existing repo docs structure

---

## Recommended Product Direction

### Option A: Direct Ark-compatible CLI (Recommended)

- End user installs `seedance-cli` with `npm i -g` or runs it with `npx`.
- User provides `SEEDANCE_API_KEY` or `--api-key`.
- CLI sends requests directly to `http://123.57.80.82/seedance/api/v3`.
- Best fit for terminal users because it removes browser login, cookie extraction, and Playwright runtime.

### Option B: CLI wrapper around current `seedance2.0` Express server

- Reuse existing `/api/generate-video` and `/api/task/:id`.
- Lower short-term code reuse, but terminal users still need local server boot, SessionID, and the `jimeng` anti-bot path.
- Not recommended because the requirement doc already provides a cleaner API surface.

### Option C: Full-screen TUI

- Better UX, but slower delivery and higher maintenance cost.
- Use only after the command-line flow is stable.

## Product / Commercial / Compliance Constraints

- Do not embed a shared production API key in the published CLI. End users must supply their own key or receive a scoped internal key.
- Treat custom virtual human upload as an offline/manual process. The doc explicitly says self-owned avatar material submission requires contacting sales.
- CLI should support existing `asset://...` URIs and public asset usage, but should not promise avatar onboarding automation in v1.
- Validate file limits before sending requests to reduce paid request failures:
  - Images: `< 30 MB`, request body `<= 64 MB`
  - Videos: `< 50 MB`, `2-15s`, max 3 videos, total video duration `<= 15s`
  - Ratio and duration must match documented limits
- Generated video links expire after 24 hours, so `wait --download` should be a first-class flow.

## User-Facing CLI Shape

### Primary commands

- `seedance create`
- `seedance task get <taskId>`
- `seedance task wait <taskId>`
- `seedance download <taskId>`
- `seedance doctor`

### Example commands

```bash
SEEDANCE_API_KEY=sk-xxx seedance create \
  --model doubao-seedance-2-0-260128 \
  --prompt "第一人称果茶广告，首帧使用图片1，尾帧定格图片2" \
  --image ./assets/pic1.jpg \
  --image ./assets/pic2.jpg \
  --audio ./assets/bgm.mp3 \
  --ratio 16:9 \
  --duration 11 \
  --generate-audio \
  --wait \
  --output ./output/tea.mp4

seedance task get cgt-20260325-xxxx
seedance task wait cgt-20260325-xxxx --output ./output/result.mp4
seedance doctor
```

### Input rules

- `--image`, `--video`, `--audio` accept local files, remote `http(s)` URLs, or `asset://...` URIs.
- Local files smaller than the request-body ceiling are converted into `data:` URLs only when safe.
- Oversized local files fail fast with a clear message telling the user to provide a remote URL or pre-uploaded `asset://` URI.
- `--web-search` maps to `tools: [{ type: "web_search" }]`.
- `--watermark`, `--generate-audio`, `--json`, `--wait`, and `--output` are explicit flags.

## Repository Layout

### Task 1: Scaffold publishable CLI package

**Files:**
- Create: `packages/seedance-cli/package.json`
- Create: `packages/seedance-cli/bin/seedance.js`
- Create: `packages/seedance-cli/src/index.js`
- Create: `packages/seedance-cli/src/config.js`
- Modify: `package.json`
- Modify: `README.md`

**Step 1: Write the failing package smoke test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildCli } from "../src/index.js";

test("cli exposes create and task commands", () => {
  const program = buildCli();
  const commandNames = program.commands.map((command) => command.name());
  assert.deepEqual(commandNames, ["create", "task", "download", "doctor"]);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test packages/seedance-cli/test/cli-structure.test.js`
Expected: FAIL with module or export missing

**Step 3: Write minimal implementation**

- Add a standalone package with a `bin` entry.
- Expose a `buildCli()` function from `src/index.js`.
- Register top-level commands with `commander`.
- Keep CLI publishable without changing the current web app package privacy rules.

**Step 4: Run test to verify it passes**

Run: `node --test packages/seedance-cli/test/cli-structure.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json README.md packages/seedance-cli/package.json packages/seedance-cli/bin/seedance.js packages/seedance-cli/src/index.js packages/seedance-cli/src/config.js packages/seedance-cli/test/cli-structure.test.js
git commit -m "feat: scaffold seedance terminal cli"
```

### Task 2: Implement config loading and doctor command

**Files:**
- Modify: `packages/seedance-cli/src/config.js`
- Create: `packages/seedance-cli/src/commands/doctor.js`
- Create: `packages/seedance-cli/test/doctor.test.js`

**Step 1: Write the failing test**

```js
test("doctor reports missing API key", async () => {
  const result = await runCli(["doctor"], { env: { SEEDANCE_API_KEY: "" } });
  assert.match(result.stderr, /SEEDANCE_API_KEY/);
  assert.equal(result.exitCode, 1);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test packages/seedance-cli/test/doctor.test.js`
Expected: FAIL because `doctor` is not implemented

**Step 3: Write minimal implementation**

- Read configuration from env vars and flags.
- Support:
  - `SEEDANCE_BASE_URL` default `http://123.57.80.82/seedance/api/v3`
  - `SEEDANCE_API_KEY`
  - `SEEDANCE_MODEL`
  - `SEEDANCE_TIMEOUT_MS`
- `doctor` checks URL shape, API key presence, writable output directory, and local file readability.

**Step 4: Run test to verify it passes**

Run: `node --test packages/seedance-cli/test/doctor.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/seedance-cli/src/config.js packages/seedance-cli/src/commands/doctor.js packages/seedance-cli/test/doctor.test.js
git commit -m "feat: add cli config and doctor command"
```

### Task 3: Build request payload assembly and media validation

**Files:**
- Create: `packages/seedance-cli/src/media.js`
- Create: `packages/seedance-cli/src/payload.js`
- Create: `packages/seedance-cli/test/payload.test.js`

**Step 1: Write the failing test**

```js
test("buildCreatePayload maps prompt, images, and web search tool", async () => {
  const payload = await buildCreatePayload({
    prompt: "test",
    images: ["https://example.com/a.jpg"],
    webSearch: true,
    ratio: "16:9",
    duration: 11,
  });

  assert.equal(payload.content[0].type, "text");
  assert.equal(payload.content[1].role, "reference_image");
  assert.deepEqual(payload.tools, [{ type: "web_search" }]);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test packages/seedance-cli/test/payload.test.js`
Expected: FAIL because payload builders do not exist

**Step 3: Write minimal implementation**

- Validate:
  - duration in `[4,15]` or `-1`
  - ratio in `21:9|16:9|4:3|1:1|3:4|9:16`
  - local image/video/audio size limits
- Convert local small files to `data:` URLs.
- Preserve remote URLs and `asset://` URIs as-is.
- Map media to Ark-compatible `content` objects:
  - `text`
  - `image_url` + `role: "reference_image"`
  - `video_url` + `role: "reference_video"`
  - `audio_url` + `role: "reference_audio"`

**Step 4: Run test to verify it passes**

Run: `node --test packages/seedance-cli/test/payload.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/seedance-cli/src/media.js packages/seedance-cli/src/payload.js packages/seedance-cli/test/payload.test.js
git commit -m "feat: add cli payload builder and validators"
```

### Task 4: Implement HTTP client and create command

**Files:**
- Create: `packages/seedance-cli/src/client.js`
- Create: `packages/seedance-cli/src/commands/create.js`
- Create: `packages/seedance-cli/test/create.test.js`

**Step 1: Write the failing test**

```js
test("create sends task request to generations/tasks", async () => {
  const server = await startFakeServer((req, res) => {
    assert.equal(req.url, "/contents/generations/tasks");
    assert.equal(req.method, "POST");
    res.end(JSON.stringify({ id: "cgt-test", status: "submitted" }));
  });

  const result = await runCli(["create", "--prompt", "x"], {
    env: {
      SEEDANCE_API_KEY: "sk-test",
      SEEDANCE_BASE_URL: server.baseUrl,
    },
  });

  assert.match(result.stdout, /cgt-test/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test packages/seedance-cli/test/create.test.js`
Expected: FAIL because no request is issued

**Step 3: Write minimal implementation**

- Add a thin HTTP client around native `fetch`.
- POST to `/contents/generations/tasks`.
- Send `Authorization: Bearer <key>` and JSON body.
- Support `--json` for machine-readable output.
- Print task id, model, and next suggested command for interactive terminal users.

**Step 4: Run test to verify it passes**

Run: `node --test packages/seedance-cli/test/create.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/seedance-cli/src/client.js packages/seedance-cli/src/commands/create.js packages/seedance-cli/test/create.test.js
git commit -m "feat: add cli create command"
```

### Task 5: Implement task get, wait, and download flows

**Files:**
- Create: `packages/seedance-cli/src/commands/task-get.js`
- Create: `packages/seedance-cli/src/commands/task-wait.js`
- Create: `packages/seedance-cli/src/commands/download.js`
- Create: `packages/seedance-cli/src/download.js`
- Create: `packages/seedance-cli/test/task-flow.test.js`

**Step 1: Write the failing test**

```js
test("wait polls until succeeded and downloads output", async () => {
  const server = await startPollingServer([
    { status: "running" },
    { status: "succeeded", content: [{ type: "video", video_url: { url: "http://127.0.0.1:0/file.mp4" } }] },
  ]);

  const result = await runCli(["task", "wait", "cgt-test", "--output", "tmp/out.mp4"], {
    env: {
      SEEDANCE_API_KEY: "sk-test",
      SEEDANCE_BASE_URL: server.baseUrl,
    },
  });

  assert.match(result.stdout, /out.mp4/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test packages/seedance-cli/test/task-flow.test.js`
Expected: FAIL because polling is missing

**Step 3: Write minimal implementation**

- `task get` sends GET `/contents/generations/tasks/:taskId`.
- `task wait` polls until `succeeded` or `failed`, with configurable interval and timeout.
- `download` fetches the first returned video URL and writes it atomically to disk.
- `create --wait --output file.mp4` reuses the same code path.
- Warn when the result is complete but no downloadable video URL is present.

**Step 4: Run test to verify it passes**

Run: `node --test packages/seedance-cli/test/task-flow.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/seedance-cli/src/commands/task-get.js packages/seedance-cli/src/commands/task-wait.js packages/seedance-cli/src/commands/download.js packages/seedance-cli/src/download.js packages/seedance-cli/test/task-flow.test.js
git commit -m "feat: add cli task polling and download"
```

### Task 6: Improve terminal UX and failure messages

**Files:**
- Modify: `packages/seedance-cli/src/index.js`
- Modify: `packages/seedance-cli/src/commands/create.js`
- Modify: `packages/seedance-cli/src/commands/task-wait.js`
- Create: `packages/seedance-cli/test/error-output.test.js`

**Step 1: Write the failing test**

```js
test("oversized local video fails with actionable guidance", async () => {
  const result = await runCli(["create", "--video", "fixtures/large.mov"], {
    env: { SEEDANCE_API_KEY: "sk-test" },
  });

  assert.match(result.stderr, /50 MB/);
  assert.match(result.stderr, /remote URL|asset:\/\//);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test packages/seedance-cli/test/error-output.test.js`
Expected: FAIL because validation messages are generic or absent

**Step 3: Write minimal implementation**

- Normalize exit codes:
  - `1` validation/config error
  - `2` API error
  - `3` timeout or incomplete result
- Human output defaults to concise progress lines.
- `--json` disables spinners and logs structured results only.
- Error text must explicitly tell the user what to do next.

**Step 4: Run test to verify it passes**

Run: `node --test packages/seedance-cli/test/error-output.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/seedance-cli/src/index.js packages/seedance-cli/src/commands/create.js packages/seedance-cli/src/commands/task-wait.js packages/seedance-cli/test/error-output.test.js
git commit -m "feat: improve cli terminal experience"
```

### Task 7: Documentation, packaging, and end-to-end verification

**Files:**
- Create: `packages/seedance-cli/README.md`
- Modify: `README.md`
- Modify: `packages/seedance-cli/package.json`

**Step 1: Write the failing verification checklist**

```md
- `seedance doctor` shows config status
- `seedance create --help` prints examples
- `seedance task wait --help` prints output behavior
- README includes install, auth, limits, and examples
```

**Step 2: Run package verification to confirm current gaps**

Run: `npm --prefix packages/seedance-cli pack --dry-run`
Expected: FAIL or show missing publishable files before packaging is finalized

**Step 3: Write minimal implementation**

- Add installation docs:
  - `npm i -g seedance-cli`
  - `npx seedance-cli@latest ...`
- Add env var docs and examples for:
  - text-to-video
  - image + audio
  - public virtual human via `asset://`
- Document unsupported v1 scope:
  - self-owned virtual human onboarding
  - browser login/session-based flow

**Step 4: Run full verification**

Run: `node --test packages/seedance-cli/test/*.test.js`
Expected: PASS

Run: `npm --prefix packages/seedance-cli pack --dry-run`
Expected: PASS with expected files only

Run: `SEEDANCE_API_KEY=placeholder node packages/seedance-cli/bin/seedance.js create --help`
Expected: PASS with help output

**Step 5: Commit**

```bash
git add README.md packages/seedance-cli/README.md packages/seedance-cli/package.json
git commit -m "docs: prepare seedance cli for terminal users"
```

## Final Acceptance Checklist

- Terminal users can install the CLI without starting the current web app.
- Users can create tasks with text, image, video, audio, URL, or `asset://` references within documented limits.
- Users can poll task status and download the resulting video from the terminal.
- Secrets are never hardcoded into the package.
- Error messages explain next steps for validation, auth, timeout, and expired result links.
- README makes the product usable without reading the original WPS doc.

## Notes For Implementation

- Prefer plain JavaScript ESM in the CLI package to avoid adding another TypeScript toolchain.
- Keep the CLI isolated under `packages/seedance-cli` so the existing React + Express app can evolve independently.
- Do not add a dependency on the current `jimeng` SessionID flow unless the requirement changes.
- If the business later requires a shared internal billing layer, add a proxy service behind the CLI instead of distributing a team-wide API key.
