import type { GenerateVideoRequest, VideoGenerationResponse } from '../types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(
  /\/+$/,
  ''
);
const POLL_TIMEOUT_MS = Number(
  import.meta.env.VITE_TASK_POLL_TIMEOUT_MS || 45 * 60 * 1000
);

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function previewBody(text: string, maxLength = 120): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

async function parseJsonResponse<T>(response: Response, scene: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${scene}失败：服务返回非JSON (HTTP ${response.status})，响应片段：${previewBody(text)}`
    );
  }
}

export async function generateVideo(
  request: GenerateVideoRequest,
  onProgress?: (message: string) => void
): Promise<VideoGenerationResponse> {
  const formData = new FormData();
  formData.append('prompt', request.prompt);
  formData.append('model', request.model);
  formData.append('ratio', request.ratio);
  formData.append('duration', String(request.duration));
  if (request.platform) {
    formData.append('platform', request.platform);
  }

  if (request.sessionId) {
    formData.append('sessionId', request.sessionId);
  }

  for (const file of request.files) {
    formData.append('files', file);
  }

  // 第1步: 提交任务
  onProgress?.('正在提交视频生成请求...');
  const submitRes = await fetch(apiUrl('/generate-video'), {
    method: 'POST',
    body: formData,
  });

  const submitData = await parseJsonResponse<{ taskId?: string; error?: string }>(
    submitRes,
    '提交任务'
  );
  if (!submitRes.ok) {
    throw new Error(submitData.error || `提交失败 (HTTP ${submitRes.status})`);
  }

  const { taskId } = submitData;
  if (!taskId) {
    throw new Error('服务器未返回任务ID');
  }

  // 第2步: 轮询获取结果
  onProgress?.('已提交，等待AI生成视频...');

  const pollInterval = 3000; // 3 秒
  const startTime = Date.now();

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const pollRes = await fetch(apiUrl(`/task/${taskId}`));
    const pollData = await parseJsonResponse<{
      status?: string;
      result?: VideoGenerationResponse;
      error?: string;
      progress?: string;
    }>(pollRes, '轮询任务');

    if (pollData.status === 'done') {
      const result = pollData.result;
      if (result?.data?.[0]?.url) {
        return result;
      }
      throw new Error('未获取到视频结果');
    }

    if (pollData.status === 'error') {
      throw new Error(pollData.error || '视频生成失败');
    }

    // 仍在处理中，更新进度
    if (pollData.progress) {
      onProgress?.(pollData.progress);
    }
  }

  const timeoutMinutes = Math.ceil(POLL_TIMEOUT_MS / 60000);
  throw new Error(`视频生成超时 (约${timeoutMinutes}分钟)，请稍后重试`);
}
