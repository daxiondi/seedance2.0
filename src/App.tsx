import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  AspectRatio,
  Duration,
  ModelId,
  PlatformId,
  ReferenceMode,
  UploadedImage,
  GenerationState,
  GenerationHistoryItem,
} from './types';
import {
  RATIO_OPTIONS,
  DURATION_OPTIONS,
  REFERENCE_MODES,
  MODEL_OPTIONS,
  PLATFORM_LABEL_MAP,
} from './types';
import { submitVideoTask, pollVideoTask } from './services/videoService';
import VideoPlayer from './components/VideoPlayer';
import SettingsModal, { loadSettings } from './components/SettingsModal';
import { GearIcon, PlusIcon, CloseIcon, SparkleIcon } from './components/Icons';

let nextId = 0;
const HISTORY_COOKIE_KEY = 'seedance_history_v1';
const HISTORY_COOKIE_DAYS = 30;
const MAX_HISTORY_ITEMS = 5;
const PENDING_TASK_STORAGE_KEY = 'seedance_pending_task_v1';
const DEFAULT_PLATFORM: PlatformId = 'jimeng';
const EMPTY_SESSIONS: Record<PlatformId, string> = {
  jimeng: '',
  xyq: '',
};
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(
  /\/+$/,
  ''
);
type NotificationState = NotificationPermission | 'unsupported';
interface PendingTaskSnapshot {
  taskId: string;
  platform: PlatformId;
  model: ModelId;
  ratio: AspectRatio;
  duration: Duration;
  prompt: string;
  startedAt: number;
}

function getNotificationState(): NotificationState {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

function getEnvSessionId(platform: PlatformId): string {
  if (platform === 'xyq') {
    return String(import.meta.env.VITE_DEFAULT_XYQ_SESSION_ID || '').trim();
  }
  return String(import.meta.env.VITE_DEFAULT_SESSION_ID || '').trim();
}

function loadPendingTask(): PendingTaskSnapshot | null {
  try {
    const raw = localStorage.getItem(PENDING_TASK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.taskId !== 'string') return null;
    if (parsed.platform !== 'jimeng' && parsed.platform !== 'xyq') return null;
    return parsed as PendingTaskSnapshot;
  } catch {
    return null;
  }
}

function savePendingTask(task: PendingTaskSnapshot) {
  localStorage.setItem(PENDING_TASK_STORAGE_KEY, JSON.stringify(task));
}

function clearPendingTask() {
  localStorage.removeItem(PENDING_TASK_STORAGE_KEY);
}

function isRecoverableNetworkError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('网络') ||
    lower.includes('非json') ||
    lower.includes('视频生成超时')
  );
}

function getCookie(name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

function loadHistoryFromCookie(): GenerationHistoryItem[] {
  try {
    const raw = getCookie(HISTORY_COOKIE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): GenerationHistoryItem | null => {
        if (
          !item ||
          typeof item.id !== 'string' ||
          typeof item.createdAt !== 'number' ||
          typeof item.videoUrl !== 'string'
        ) {
          return null;
        }

        const rawPlatform = item.platform;
        const platform: PlatformId =
          rawPlatform === 'xyq' || rawPlatform === 'jimeng'
            ? rawPlatform
            : DEFAULT_PLATFORM;

        return {
          ...item,
          platform,
        };
      })
      .filter((item): item is GenerationHistoryItem => item !== null);
  } catch {
    return [];
  }
}

function saveHistoryToCookie(items: GenerationHistoryItem[]) {
  setCookie(HISTORY_COOKIE_KEY, JSON.stringify(items.slice(0, MAX_HISTORY_ITEMS)), HISTORY_COOKIE_DAYS);
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function buildProxyVideoUrl(
  rawVideoUrl: string,
  platform: PlatformId = DEFAULT_PLATFORM
): string {
  return `${API_BASE}/video-proxy?platform=${encodeURIComponent(platform)}&url=${encodeURIComponent(rawVideoUrl)}`;
}

export default function App() {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<ModelId>('seedance-2.0-fast');
  const [ratio, setRatio] = useState<AspectRatio>('16:9');
  const [duration, setDuration] = useState<Duration>(5);
  const [referenceMode, setReferenceMode] = useState<ReferenceMode>('全能参考');
  const [generation, setGeneration] = useState<GenerationState>({
    status: 'idle',
  });
  const [historyItems, setHistoryItems] = useState<GenerationHistoryItem[]>([]);
  const [platform, setPlatform] = useState<PlatformId>(DEFAULT_PLATFORM);
  const [sessions, setSessions] =
    useState<Record<PlatformId, string>>(EMPTY_SESSIONS);
  const [resultPlatform, setResultPlatform] = useState<PlatformId>(DEFAULT_PLATFORM);
  const [showSettings, setShowSettings] = useState(false);
  const [notificationState, setNotificationState] =
    useState<NotificationState>('unsupported');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitLockRef = useRef(false);
  const maxImages = 5;

  useEffect(() => {
    const saved = loadSettings();
    setPlatform(saved.platform);
    setSessions({
      ...EMPTY_SESSIONS,
      ...saved.sessions,
    });
    setHistoryItems(loadHistoryFromCookie());

    const initialSession =
      saved.sessions[saved.platform] || getEnvSessionId(saved.platform);
    if (!initialSession) {
      setShowSettings(true);
    }
  }, []);

  useEffect(() => {
    setNotificationState(getNotificationState());
  }, []);

  const addFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      const remaining = maxImages - images.length;
      if (remaining <= 0) return;

      const newFiles = Array.from(fileList).slice(0, remaining);
      const newImages: UploadedImage[] = newFiles.map((file, i) => ({
        id: `img-${++nextId}`,
        file,
        previewUrl: URL.createObjectURL(file),
        index: images.length + i + 1,
      }));

      setImages([...images, ...newImages]);
    },
    [images]
  );

  const removeImage = useCallback(
    (id: string) => {
      const removed = images.find((img) => img.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);

      const updated = images
        .filter((img) => img.id !== id)
        .map((img, i) => ({ ...img, index: i + 1 }));
      setImages(updated);
    },
    [images]
  );

  const clearAllImages = useCallback(() => {
    images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setImages([]);
  }, [images]);

  const notifyByBrowser = useCallback((title: string, body: string) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const notice = new Notification(title, { body });
    notice.onclick = () => window.focus();
  }, []);

  const ensureNotificationPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'default') {
      try {
        const permission = await Notification.requestPermission();
        setNotificationState(permission);
      } catch {
        // 忽略权限请求异常，不影响主流程
      }
      return;
    }
    setNotificationState(Notification.permission);
  }, []);

  const appendHistory = useCallback((item: GenerationHistoryItem) => {
    setHistoryItems((prev) => {
      const next = [item, ...prev].slice(0, MAX_HISTORY_ITEMS);
      saveHistoryToCookie(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistoryItems([]);
    saveHistoryToCookie([]);
  }, []);

  const restoreHistoryItem = useCallback((item: GenerationHistoryItem) => {
    setResultPlatform(item.platform);
    setGeneration({
      status: 'success',
      result: {
        created: Math.floor(item.createdAt / 1000),
        data: [
          {
            url: item.videoUrl,
            revised_prompt: item.revisedPrompt || item.prompt,
          },
        ],
      },
    });
  }, []);

  const handleGenerationSuccess = useCallback(
    (
      result: Awaited<ReturnType<typeof pollVideoTask>>,
      snapshot: {
        platform: PlatformId;
        model: ModelId;
        ratio: AspectRatio;
        duration: Duration;
        prompt: string;
      }
    ) => {
      if (!result.data || result.data.length === 0 || !result.data[0].url) {
        throw new Error('未获取到视频结果，请重试');
      }

      const historyItem: GenerationHistoryItem = {
        id: `history_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        createdAt: Date.now(),
        platform: snapshot.platform,
        model: snapshot.model,
        ratio: snapshot.ratio,
        duration: snapshot.duration,
        prompt: snapshot.prompt,
        revisedPrompt: result.data[0].revised_prompt || snapshot.prompt,
        videoUrl: result.data[0].url,
      };

      appendHistory(historyItem);
      setResultPlatform(snapshot.platform);
      setGeneration({ status: 'success', result });
      notifyByBrowser(
        'Seedance 视频已生成',
        '生成已完成，回到页面即可预览和下载。'
      );
    },
    [appendHistory, notifyByBrowser]
  );

  const resumePendingTask = useCallback(
    async (pending: PendingTaskSnapshot) => {
      if (submitLockRef.current) return;
      submitLockRef.current = true;
      setPlatform(pending.platform);
      setGeneration({
        status: 'generating',
        progress: '检测到未完成任务，正在恢复查询...',
      });

      try {
        const result = await pollVideoTask(pending.taskId, (progress) => {
          setGeneration((prev) => ({ ...prev, progress }));
        });
        handleGenerationSuccess(result, {
          platform: pending.platform,
          model: pending.model,
          ratio: pending.ratio,
          duration: pending.duration,
          prompt: pending.prompt,
        });
        clearPendingTask();
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        if (isRecoverableNetworkError(message)) {
          setGeneration({
            status: 'error',
            error:
              '任务仍在后台处理中（可能耗时较长）。稍后刷新页面会自动继续查询结果。',
          });
          return;
        }

        clearPendingTask();
        setGeneration({ status: 'error', error: message });
        notifyByBrowser('Seedance 生成失败', message);
      } finally {
        submitLockRef.current = false;
      }
    },
    [handleGenerationSuccess, notifyByBrowser]
  );

  useEffect(() => {
    const pending = loadPendingTask();
    if (!pending) return;
    void resumePendingTask(pending);
  }, [resumePendingTask]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() && images.length === 0) return;
    if (generation.status === 'generating' || submitLockRef.current) return;
    submitLockRef.current = true;
    const activeSessionId = sessions[platform] || getEnvSessionId(platform);

    void ensureNotificationPermission();
    setGeneration({
      status: 'generating',
      progress: '正在提交视频生成请求...',
    });

    const snapshot: PendingTaskSnapshot = {
      taskId: '',
      platform,
      model,
      ratio,
      duration,
      prompt,
      startedAt: Date.now(),
    };

    try {
      const taskId = await submitVideoTask(
        {
          prompt,
          model,
          ratio,
          duration,
          files: images.map((img) => img.file),
          platform,
          sessionId: activeSessionId || undefined,
        },
        (progress) => {
          setGeneration((prev) => ({ ...prev, progress }));
        }
      );
      snapshot.taskId = taskId;
      savePendingTask(snapshot);

      const result = await pollVideoTask(taskId, (progress) => {
        setGeneration((prev) => ({ ...prev, progress }));
      });
      handleGenerationSuccess(result, {
        platform,
        model,
        ratio,
        duration,
        prompt,
      });
      clearPendingTask();
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      if (isRecoverableNetworkError(message)) {
        setGeneration({
          status: 'error',
          error:
            '任务仍在后台处理中（可能耗时较长）。刷新页面后会自动继续查询结果。',
        });
        return;
      }

      clearPendingTask();
      setGeneration({
        status: 'error',
        error: message,
      });
      notifyByBrowser('Seedance 生成失败', message);
    } finally {
      submitLockRef.current = false;
    }
  }, [
    prompt,
    images,
    model,
    ratio,
    duration,
    platform,
    sessions,
    generation.status,
    handleGenerationSuccess,
    ensureNotificationPermission,
    notifyByBrowser,
  ]);

  const handleReset = () => {
    setPrompt('');
    clearAllImages();
    setGeneration({ status: 'idle' });
  };

  const videoUrl =
    generation.status === 'success' && generation.result?.data?.[0]?.url
      ? generation.result.data[0].url
      : null;

  const revisedPrompt =
    generation.status === 'success'
      ? generation.result?.data?.[0]?.revised_prompt
      : undefined;

  const isGenerating = generation.status === 'generating';
  const canGenerate = (prompt.trim() || images.length > 0) && !isGenerating;
  const selectedPlatformLabel = PLATFORM_LABEL_MAP[platform];

  return (
    <div className="h-screen flex flex-col md:flex-row overflow-hidden bg-[#0f111a] text-white">
      {/* Mobile Header */}
      <div className="md:hidden sticky top-0 z-40 bg-[#0f111a]/95 backdrop-blur-sm px-4 py-3 flex items-center justify-between border-b border-gray-800">
        <h1 className="text-lg font-bold">
          {(MODEL_OPTIONS.find((m) => m.value === model)?.label || 'Seedance 2.0') +
            ` · ${selectedPlatformLabel}`}
        </h1>
        <button
          onClick={() => setShowSettings(true)}
          className="p-2 rounded-lg hover:bg-gray-800 transition-colors"
        >
          <GearIcon className="w-5 h-5 text-gray-400" />
        </button>
      </div>

      {/* Left Panel — Configuration */}
      <div className="flex-1 md:w-[520px] md:max-w-[520px] md:flex-none md:border-r border-gray-800 overflow-y-auto custom-scrollbar p-4 md:p-6 bg-[#0f111a]">
        {/* Desktop header */}
        <div className="hidden md:flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold">
            {(MODEL_OPTIONS.find((m) => m.value === model)?.label || 'Seedance 2.0') +
              ` · ${selectedPlatformLabel}`} 视频配置
          </h2>
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg hover:bg-gray-800 transition-colors"
            title="设置"
          >
            <GearIcon className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <div className="space-y-5">
          {/* ── Reference Images ── */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm font-bold text-gray-300">
                参考图片 (全能参考)
              </label>
              {images.length > 0 && (
                <button
                  onClick={clearAllImages}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  清除全部
                </button>
              )}
            </div>

            {/* Thumbnails */}
            {images.length > 0 && (
              <div className="flex flex-wrap gap-3 mb-3">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="relative group w-20 h-20 flex-shrink-0"
                  >
                    <img
                      src={img.previewUrl}
                      alt={`参考图 ${img.index}`}
                      className="w-full h-full object-cover rounded-xl border border-gray-700"
                    />
                    <span className="absolute bottom-0 left-0 bg-black/70 text-[10px] text-purple-400 px-1.5 py-0.5 rounded-br-xl rounded-tl-xl font-medium">
                      @{img.index}
                    </span>
                    <button
                      onClick={() => removeImage(img.id)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-800 border border-gray-700 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 hover:border-red-600"
                    >
                      <CloseIcon className="w-3 h-3 text-white" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Upload zone */}
            {images.length < maxImages && (
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addFiles(e.dataTransfer.files);
                }}
                className={`w-full ${
                  images.length === 0 ? 'h-40 md:h-52' : 'h-24'
                } border border-dashed border-gray-700 rounded-2xl flex flex-col items-center justify-center bg-[#1c1f2e] cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d] transition-all`}
              >
                <div className="flex flex-col items-center gap-2">
                  <div className="p-2 bg-gray-800 rounded-lg text-gray-400">
                    <PlusIcon className="w-6 h-6" />
                  </div>
                  <span className="text-xs text-gray-500">
                    {images.length === 0
                      ? '点击或拖拽上传参考图（可选，最多5张）'
                      : `继续添加（${images.length}/${maxImages}）`}
                  </span>
                  {images.length === 0 && (
                    <span className="text-[10px] text-gray-600">
                      不上传则为纯文生视频
                    </span>
                  )}
                </div>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {/* ── Prompt ── */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="block text-sm font-bold mb-3 text-gray-300">
              提示词
            </label>
            <textarea
              className="w-full bg-transparent text-sm resize-none focus:outline-none min-h-[100px] placeholder-gray-600 text-gray-200 leading-relaxed"
              placeholder="描述你想要生成的视频场景。上传参考图后可使用 @1、@2 等引用图片，例如：@1作为首帧，@2作为尾帧，模仿@3的动作..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={5000}
              disabled={isGenerating}
            />
            <div className="text-right text-xs text-gray-500 mt-2">
              {prompt.length}/5000
            </div>
          </div>

          {/* ── Settings ── */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800 space-y-5">
            {/* Model Selection */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">
                选择模型
              </label>
              <div className="flex flex-col gap-2">
                {MODEL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setModel(opt.value)}
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                      model === opt.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                    }`}
                  >
                    <div className={`text-sm font-medium ${
                      model === opt.value ? 'text-purple-400' : 'text-gray-300'
                    }`}>
                      {opt.label}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{opt.description}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Reference Mode */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">
                参考模式
              </label>
              <div className="flex gap-2">
                {REFERENCE_MODES.map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setReferenceMode(mode)}
                    className={`flex-1 py-2.5 rounded-lg text-sm font-medium border transition-all ${
                      referenceMode === mode
                        ? 'border-purple-500 bg-purple-500/10 text-purple-400'
                        : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            {/* Aspect Ratio */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">
                画面比例
              </label>
              <div className="grid grid-cols-6 gap-2">
                {RATIO_OPTIONS.map((opt) => {
                  const isSelected = opt.value === ratio;
                  const maxDim = 24;
                  const scale =
                    maxDim / Math.max(opt.widthRatio, opt.heightRatio);
                  const w = Math.round(opt.widthRatio * scale);
                  const h = Math.round(opt.heightRatio * scale);
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setRatio(opt.value)}
                      className={`flex flex-col items-center gap-1.5 py-2 rounded-lg border transition-all ${
                        isSelected
                          ? 'border-purple-500 bg-purple-500/10'
                          : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                      }`}
                    >
                      <div className="flex items-center justify-center w-8 h-8">
                        <div
                          className={`rounded-sm border ${
                            isSelected
                              ? 'border-purple-400'
                              : 'border-gray-500'
                          }`}
                          style={{ width: `${w}px`, height: `${h}px` }}
                        />
                      </div>
                      <span
                        className={`text-[11px] ${
                          isSelected ? 'text-purple-400' : 'text-gray-400'
                        }`}
                      >
                        {opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Duration */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">
                视频时长
              </label>
              <div className="flex flex-wrap gap-2">
                {DURATION_OPTIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDuration(d)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                      duration === d
                        ? 'border-purple-500 bg-purple-500/10 text-purple-400'
                        : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {d}秒
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Generate Section ── */}
          <div className="pb-6 md:pb-4">
            <div className="mb-4 rounded-xl border border-gray-800 bg-[#161824] p-3">
              {notificationState === 'granted' ? (
                <p className="text-xs text-green-300">
                  已开启通知提醒：视频生成成功或失败时会自动通知，你可以切到其他页面处理别的事情。
                </p>
              ) : notificationState === 'default' ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-gray-300">
                    生成时间较长，建议开启浏览器通知，成功/失败会自动提醒。
                  </p>
                  <button
                    onClick={() => {
                      void ensureNotificationPermission();
                    }}
                    className="shrink-0 px-3 py-1.5 text-xs rounded-lg bg-purple-600/20 text-purple-300 hover:bg-purple-600/30 transition-colors"
                  >
                    开启提醒
                  </button>
                </div>
              ) : notificationState === 'denied' ? (
                <p className="text-xs text-yellow-300">
                  你已关闭通知权限。若需后台提醒，请在浏览器地址栏站点权限里开启“通知”。
                </p>
              ) : (
                <p className="text-xs text-gray-400">
                  当前浏览器不支持通知提醒，请保持页面打开查看进度。
                </p>
              )}
            </div>

            {/* Progress */}
            {isGenerating && (
              <div className="mb-4">
                <div className="flex justify-between text-xs text-gray-400 mb-1">
                  <span>{generation.progress || '处理中...'}</span>
                </div>
                <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-purple-600 to-indigo-600 rounded-full animate-progress" />
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  任务已在后台继续执行，无需一直停留在当前页面。
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-purple-900/20 flex items-center justify-center gap-2"
              >
                {isGenerating ? (
                  <>
                    <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    生成中...
                  </>
                ) : (
                  <>
                    <SparkleIcon className="w-4 h-4" />
                    生成视频
                  </>
                )}
              </button>
              <button
                onClick={handleReset}
                disabled={isGenerating}
                className="px-6 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-white font-bold py-3.5 rounded-xl transition-all"
              >
                重置
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel — Result */}
      <div className="flex-1 bg-[#090a0f] overflow-y-auto flex flex-col">
        <VideoPlayer
          videoUrl={videoUrl}
          platform={resultPlatform}
          revisedPrompt={revisedPrompt}
          isLoading={isGenerating}
          error={generation.status === 'error' ? generation.error : undefined}
          progress={generation.progress}
        />

        <div className="border-t border-gray-800 p-4 md:p-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-gray-200">最近生成记录（本机 Cookie）</h3>
            {historyItems.length > 0 && (
              <button
                onClick={clearHistory}
                className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                清空
              </button>
            )}
          </div>

          {historyItems.length === 0 ? (
            <p className="text-xs text-gray-500">暂无历史记录。生成成功后会自动保存最近 5 条。</p>
          ) : (
            <div className="space-y-2">
              {historyItems.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-gray-800 bg-[#11131c] p-3"
                >
                  <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
                    <span>
                      {PLATFORM_LABEL_MAP[item.platform]} · {item.model} · {item.ratio} ·{' '}
                      {item.duration}秒
                    </span>
                    <span>{formatDateTime(item.createdAt)}</span>
                  </div>
                  <p className="text-xs text-gray-300 truncate">
                    {item.prompt || item.revisedPrompt || '无提示词'}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => restoreHistoryItem(item)}
                      className="px-3 py-1.5 text-xs rounded-lg bg-purple-600/20 text-purple-300 hover:bg-purple-600/30 transition-colors"
                    >
                      查看
                    </button>
                    <a
                      href={buildProxyVideoUrl(item.videoUrl, item.platform)}
                      download="seedance-video.mp4"
                      className="px-3 py-1.5 text-xs rounded-lg bg-gray-700 text-gray-200 hover:bg-gray-600 transition-colors"
                    >
                      下载
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={{ platform, sessions }}
        onSave={(nextSettings) => {
          setPlatform(nextSettings.platform);
          setSessions(nextSettings.sessions);
        }}
      />
    </div>
  );
}
