import { useState, useEffect } from 'react';
import { CloseIcon, EyeIcon, EyeOffIcon } from './Icons';
import type { PlatformId } from '../types';
import { PLATFORM_OPTIONS } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

const LS_SESSION_KEY_LEGACY = 'seedance_session_id';
const LS_PLATFORM_KEY = 'seedance_platform';
const LS_SESSION_KEYS: Record<PlatformId, string> = {
  jimeng: 'seedance_session_id_jimeng',
  xyq: 'seedance_session_id_xyq',
};

export interface AppSettings {
  platform: PlatformId;
  sessions: Record<PlatformId, string>;
}

export function loadSettings(): AppSettings {
  const legacySession = localStorage.getItem(LS_SESSION_KEY_LEGACY) || '';
  const savedPlatform = localStorage.getItem(LS_PLATFORM_KEY);
  const platform: PlatformId = savedPlatform === 'xyq' ? 'xyq' : 'jimeng';

  return {
    platform,
    sessions: {
      jimeng: localStorage.getItem(LS_SESSION_KEYS.jimeng) || legacySession,
      xyq: localStorage.getItem(LS_SESSION_KEYS.xyq) || '',
    },
  };
}

function saveSettings(settings: AppSettings) {
  localStorage.setItem(LS_PLATFORM_KEY, settings.platform);
  localStorage.setItem(LS_SESSION_KEYS.jimeng, settings.sessions.jimeng);
  localStorage.setItem(LS_SESSION_KEYS.xyq, settings.sessions.xyq);
  // 向后兼容历史单 key
  localStorage.setItem(LS_SESSION_KEY_LEGACY, settings.sessions.jimeng);
}

export default function SettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
}: SettingsModalProps) {
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings);
  const [showSessionId, setShowSessionId] = useState(false);

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  if (!isOpen) return null;

  const currentPlatform = localSettings.platform;
  const currentSessionId = localSettings.sessions[currentPlatform];
  const currentPlatformInfo =
    PLATFORM_OPTIONS.find((item) => item.value === currentPlatform) ||
    PLATFORM_OPTIONS[0];

  const updateCurrentSession = (nextSession: string) => {
    setLocalSettings((prev) => ({
      ...prev,
      sessions: {
        ...prev.sessions,
        [prev.platform]: nextSession,
      },
    }));
  };

  const handleSave = () => {
    const normalized: AppSettings = {
      platform: localSettings.platform,
      sessions: {
        jimeng: localSettings.sessions.jimeng.trim(),
        xyq: localSettings.sessions.xyq.trim(),
      },
    };
    onSave(normalized);
    saveSettings(normalized);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#1c1f2e] border border-gray-800 rounded-3xl p-6 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg text-gray-200 font-medium">设置</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-800 transition-colors">
            <CloseIcon className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <div className="space-y-4">
          {/* 平台选择 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">生成平台</label>
            <div className="grid grid-cols-2 gap-2">
              {PLATFORM_OPTIONS.map((item) => (
                <button
                  key={item.value}
                  onClick={() =>
                    setLocalSettings((prev) => ({ ...prev, platform: item.value }))
                  }
                  className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                    localSettings.platform === item.value
                      ? 'border-purple-500 bg-purple-500/10'
                      : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                  }`}
                >
                  <div
                    className={`text-sm font-medium ${
                      localSettings.platform === item.value
                        ? 'text-purple-300'
                        : 'text-gray-200'
                    }`}
                  >
                    {item.label}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">{item.domain}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Session ID */}
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Session ID</label>
            <div className="relative">
              <input
                type={showSessionId ? 'text' : 'password'}
                value={currentSessionId}
                onChange={(e) => updateCurrentSession(e.target.value)}
                placeholder={`输入${currentPlatformInfo.label} sessionid`}
                className="w-full bg-[#161824] border border-gray-700 rounded-xl px-3 py-2.5 pr-10 text-sm text-gray-200 placeholder-gray-500 outline-none focus:border-purple-500 transition-colors"
              />
              <button
                onClick={() => setShowSessionId(!showSessionId)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-300"
              >
                {showSessionId ? (
                  <EyeOffIcon className="w-4 h-4" />
                ) : (
                  <EyeIcon className="w-4 h-4" />
                )}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {currentPlatform === 'xyq'
                ? '建议直接粘贴整段 Cookie（后端会自动提取）。仅填 sessionid/sid_tt 可能不足，需要包含 uid_tt 等关键字段'
                : `从 ${currentPlatformInfo.domain} 的 Cookie 中获取 sessionid`}
            </p>
            <p className="text-xs text-gray-600 mt-1">
              即梦和小云雀会分别保存各自的 session，互不覆盖。
            </p>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-xl bg-[#161824] border border-gray-700 text-gray-300 text-sm hover:bg-[#1c2030] transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-sm font-bold transition-all shadow-lg shadow-purple-900/20"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
