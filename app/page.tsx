'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { AlertCircle, CheckCircle, Loader } from 'lucide-react';

type InstalledApp = {
  id: string;
  name: string;
};

type RuntimeInfo = {
  platform: string;
  hostName: string;
  hostType: 'vercel' | 'self-hosted';
  readsAppsFrom: 'server';
  canReadApps: boolean;
  canLaunchApps: boolean;
  warning: string | null;
};

const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

export default function AppLauncher() {
  const [appName, setAppName] = useState('');
  const [loading, setLoading] = useState(false);
  const [appsLoading, setAppsLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [platform, setPlatform] = useState('');
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [messageType, setMessageType] = useState<'success' | 'error' | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [availableApps, setAvailableApps] = useState<InstalledApp[]>([]);

  useEffect(() => {
    let active = true;

    async function loadInstalledApps() {
      try {
        const response = await fetch('/api/open-app', { cache: 'no-store' });
        const data = await response.json();

        if (!active) {
          return;
        }

        if (!response.ok) {
          throw new Error(data.error || 'Failed to load installed apps');
        }

        setPlatform(typeof data.platform === 'string' ? data.platform : '');
        setAvailableApps(Array.isArray(data.apps) ? data.apps : []);
        setRuntime(data.runtime ?? null);
      } catch {
        if (!active) {
          return;
        }

        setMessage('Could not load installed apps from this system.');
        setMessageType('error');
      } finally {
        if (active) {
          setAppsLoading(false);
        }
      }
    }

    loadInstalledApps();

    return () => {
      active = false;
    };
  }, []);

  const filteredApps = (
    appName.trim()
      ? availableApps.filter((app) =>
          app.name.toLowerCase().includes(appName.trim().toLowerCase()),
        )
      : availableApps
  ).slice(0, 16);

  const platformLabel = PLATFORM_LABELS[platform] || platform || 'unknown system';
  const serverLabel = runtime?.hostType === 'vercel' ? 'Vercel' : runtime?.hostName || 'server';
  const canLaunchApps = runtime?.canLaunchApps ?? false;

  const handleOpenApp = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!appName.trim()) {
      setMessage('Please enter an app name');
      setMessageType('error');
      setSuggestions([]);
      return;
    }

    setLoading(true);
    setMessage('');
    setSuggestions([]);

    try {
      const response = await fetch('/api/open-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName: appName.trim() }),
      });

      const data = await response.json();
      setRuntime(data.runtime ?? runtime);

      if (response.ok) {
        setMessage(data.message || `Opening ${appName}...`);
        setMessageType('success');
        setAppName('');
        setSuggestions([]);
      } else {
        setMessage(data.error || 'Failed to open app');
        setMessageType('error');
        setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      }
    } catch {
      setMessage('Error connecting to server');
      setMessageType('error');
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl p-8 bg-slate-800 border-slate-700 shadow-2xl">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">App Launcher</h1>
          <p className="text-slate-400">
            This can only read and open apps on the machine running the Next.js server
          </p>
          <p className="text-xs text-slate-500 mt-2">
            {appsLoading
              ? 'Checking server runtime...'
              : `${availableApps.length} apps found on ${serverLabel} (${platformLabel})`}
          </p>
        </div>

        <div className="mb-6 rounded-lg border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-100">
          <p className="font-semibold">Important</p>
          <p className="mt-1">
            If you open this site on Vercel or from another device by IP, it cannot see apps on
            your browser device. It only sees apps on the host machine running this app.
          </p>
          {runtime?.warning && <p className="mt-2 text-amber-200">{runtime.warning}</p>}
          <p className="mt-2 text-amber-200">
            To open apps from your current computer, run this project locally on that same
            computer, or use a desktop app/native helper.
          </p>
        </div>

        <form onSubmit={handleOpenApp} className="space-y-4">
          <div>
            <Input
              type="text"
              list="installed-apps"
              placeholder={
                appsLoading
                  ? 'Loading apps from server...'
                  : canLaunchApps
                    ? 'Type an app installed on the server machine'
                    : 'Desktop apps cannot be opened from this host'
              }
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              disabled={loading || appsLoading || !canLaunchApps}
              className="bg-slate-700 border-slate-600 text-white placeholder-slate-400 text-lg py-6"
              autoFocus
            />
            <datalist id="installed-apps">
              {availableApps.map((app) => (
                <option key={app.id} value={app.name} />
              ))}
            </datalist>
          </div>

          <Button
            type="submit"
            disabled={loading || appsLoading || !canLaunchApps}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3"
          >
            {loading ? (
              <>
                <Loader className="mr-2 h-4 w-4 animate-spin" />
                Opening...
              </>
            ) : (
              'Open App'
            )}
          </Button>
        </form>

        {message && (
          <div className="space-y-3 mt-6">
            <div
              className={`p-4 rounded-lg flex items-start gap-3 ${
                messageType === 'success'
                  ? 'bg-green-900/30 border border-green-700'
                  : 'bg-red-900/30 border border-red-700'
              }`}
            >
              {messageType === 'success' ? (
                <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              )}
              <p
                className={`text-sm ${
                  messageType === 'success' ? 'text-green-200' : 'text-red-200'
                }`}
              >
                {message}
              </p>
            </div>

            {suggestions.length > 0 && (
              <div className="bg-blue-900/30 border border-blue-700 p-4 rounded-lg">
                <p className="text-xs text-blue-300 font-semibold mb-2">Closest matches:</p>
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((suggestion) => (
                    <button
                      type="button"
                      key={suggestion}
                      onClick={() => {
                        setAppName(suggestion);
                        setSuggestions([]);
                      }}
                      className="px-3 py-1 bg-blue-700 hover:bg-blue-600 text-blue-100 text-xs rounded transition"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-slate-700">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-3">
            {appName.trim() ? 'Matching server apps' : `Apps available on ${serverLabel}`}
          </p>

          {appsLoading ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <Loader className="h-4 w-4 animate-spin" />
              Loading available apps...
            </div>
          ) : filteredApps.length > 0 ? (
            <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto pr-1">
              {filteredApps.map((app) => (
                <button
                  type="button"
                  key={app.id}
                  onClick={() => setAppName(app.name)}
                  className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded transition"
                >
                  {app.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No installed apps matched your search.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
