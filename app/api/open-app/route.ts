import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);
const APP_CACHE_TTL_MS = 30_000;

type WindowsTarget = {
  type: 'win32';
  appId: string;
};

type MacTarget = {
  type: 'darwin';
  appPath: string;
};

type LinuxTarget = {
  type: 'linux';
  desktopId: string;
  desktopFilePath: string;
  command?: string;
  args: string[];
};

type OpenTarget = WindowsTarget | MacTarget | LinuxTarget;

type InstalledApp = {
  id: string;
  name: string;
  aliases: string[];
  openTarget: OpenTarget;
};

type RuntimeInfo = {
  platform: NodeJS.Platform;
  hostName: string;
  hostType: 'vercel' | 'self-hosted';
  readsAppsFrom: 'server';
  canReadApps: boolean;
  canLaunchApps: boolean;
  warning: string | null;
};

let appCache:
  | {
      expiresAt: number;
      platform: NodeJS.Platform;
      apps: InstalledApp[];
    }
  | null = null;

function normalizeAppName(value: string) {
  return value
    .toLowerCase()
    .replace(/\.app$/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function uniqueStrings(values: Array<string | undefined | null>) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function serializeApps(apps: InstalledApp[]) {
  return apps.map((app) => ({
    id: app.id,
    name: app.name,
  }));
}

function getRuntimeInfo(): RuntimeInfo {
  const platform = process.platform;
  const hostType = process.env.VERCEL ? 'vercel' : 'self-hosted';
  const hostName = hostType === 'vercel' ? 'Vercel' : os.hostname();
  const supportedPlatform = ['win32', 'darwin', 'linux'].includes(platform);
  const hasLinuxDesktop = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

  const canReadApps =
    supportedPlatform && hostType !== 'vercel' && (platform !== 'linux' || hasLinuxDesktop);
  const canLaunchApps = canReadApps;

  let warning: string | null = null;

  if (hostType === 'vercel') {
    warning =
      'This API is running on Vercel. A hosted website cannot read or open apps on the visitor device.';
  } else if (!supportedPlatform) {
    warning = `This server is running on unsupported platform "${platform}".`;
  } else if (platform === 'linux' && !hasLinuxDesktop) {
    warning =
      'This Linux server has no desktop session, so desktop apps cannot be listed or opened.';
  }

  return {
    platform,
    hostName,
    hostType,
    readsAppsFrom: 'server',
    canReadApps,
    canLaunchApps,
    warning,
  };
}

function sortApps(apps: InstalledApp[]) {
  return [...apps].sort((left, right) => left.name.localeCompare(right.name));
}

function addApp(map: Map<string, InstalledApp>, app: InstalledApp) {
  const key = normalizeAppName(app.name) || app.id;
  const existing = map.get(key);

  if (!existing) {
    map.set(key, {
      ...app,
      aliases: uniqueStrings([app.name, ...app.aliases]),
    });
    return;
  }

  existing.aliases = uniqueStrings([...existing.aliases, app.name, ...app.aliases]);
}

async function readDirectoryEntries(directoryPath: string) {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readTextFile(filePath: string) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function getInstalledApps(forceRefresh = false) {
  const runtimeInfo = getRuntimeInfo();
  const { platform } = runtimeInfo;

  if (!runtimeInfo.canReadApps) {
    return [];
  }

  if (
    !forceRefresh &&
    appCache &&
    appCache.platform === platform &&
    appCache.expiresAt > Date.now()
  ) {
    return appCache.apps;
  }

  let apps: InstalledApp[] = [];

  if (platform === 'win32') {
    apps = await discoverWindowsApps();
  } else if (platform === 'darwin') {
    apps = await discoverMacApps();
  } else if (platform === 'linux') {
    apps = await discoverLinuxApps();
  }

  appCache = {
    expiresAt: Date.now() + APP_CACHE_TTL_MS,
    platform,
    apps,
  };

  return apps;
}

async function discoverWindowsApps() {
  const script =
    'Get-StartApps | Sort-Object Name | Select-Object Name, AppID | ConvertTo-Json -Depth 2';

  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      script,
    ]);
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const appsByName = new Map<string, InstalledApp>();

    for (const row of rows) {
      const name = typeof row?.Name === 'string' ? row.Name.trim() : '';
      const appId = typeof row?.AppID === 'string' ? row.AppID.trim() : '';

      if (!name || !appId) {
        continue;
      }

      addApp(appsByName, {
        id: appId,
        name,
        aliases: [appId],
        openTarget: {
          type: 'win32',
          appId,
        },
      });
    }

    return sortApps([...appsByName.values()]);
  } catch (error) {
    console.error('[open-app] Failed to read Windows apps:', extractErrorMessage(error));
    return [];
  }
}

async function collectMacAppBundles(
  directoryPath: string,
  remainingDepth: number,
  appPaths: string[],
) {
  const entries = await readDirectoryEntries(directoryPath);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = path.join(directoryPath, entry.name);

    if (entry.name.endsWith('.app')) {
      appPaths.push(fullPath);
      continue;
    }

    if (remainingDepth > 0) {
      await collectMacAppBundles(fullPath, remainingDepth - 1, appPaths);
    }
  }
}

async function discoverMacApps() {
  const appPaths: string[] = [];
  const searchDirectories = [
    '/Applications',
    '/System/Applications',
    path.join(os.homedir(), 'Applications'),
  ];

  for (const directoryPath of searchDirectories) {
    await collectMacAppBundles(directoryPath, 2, appPaths);
  }

  const appsByName = new Map<string, InstalledApp>();

  for (const appPath of appPaths) {
    const name = path.basename(appPath, '.app').trim();

    if (!name) {
      continue;
    }

    addApp(appsByName, {
      id: appPath,
      name,
      aliases: [path.basename(appPath)],
      openTarget: {
        type: 'darwin',
        appPath,
      },
    });
  }

  return sortApps([...appsByName.values()]);
}

function parseDesktopEntry(content: string) {
  const fields: Record<string, string> = {};
  let insideDesktopEntry = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('[')) {
      if (line === '[Desktop Entry]') {
        insideDesktopEntry = true;
        continue;
      }

      if (insideDesktopEntry) {
        break;
      }

      continue;
    }

    if (!insideDesktopEntry) {
      continue;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (!(key in fields)) {
      fields[key] = value;
    }
  }

  return fields;
}

function pickDesktopName(fields: Record<string, string>) {
  if (fields.Name) {
    return fields.Name;
  }

  const localizedKey = Object.keys(fields).find((key) => key.startsWith('Name['));
  return localizedKey ? fields[localizedKey] : '';
}

function splitCommandLine(commandLine: string) {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const character of commandLine) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += character;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function parseDesktopExec(execLine?: string) {
  if (!execLine) {
    return null;
  }

  const tokens = splitCommandLine(execLine)
    .map((token) => token.replace(/%[fFuUdDnNickvm]/g, '').trim())
    .filter(Boolean);

  if (!tokens.length) {
    return null;
  }

  const [command, ...args] = tokens;

  return {
    command,
    args,
  };
}

async function discoverLinuxApps() {
  const searchDirectories = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(os.homedir(), '.local/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
  ];
  const appsByName = new Map<string, InstalledApp>();

  for (const directoryPath of searchDirectories) {
    const entries = await readDirectoryEntries(directoryPath);

    for (const entry of entries) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith('.desktop')) {
        continue;
      }

      const desktopFilePath = path.join(directoryPath, entry.name);
      const content = await readTextFile(desktopFilePath);

      if (!content) {
        continue;
      }

      const fields = parseDesktopEntry(content);
      const appType = fields.Type?.trim();
      const isHidden = fields.Hidden?.toLowerCase() === 'true';
      const isNoDisplay = fields.NoDisplay?.toLowerCase() === 'true';
      const name = pickDesktopName(fields)?.trim();

      if (appType !== 'Application' || isHidden || isNoDisplay || !name) {
        continue;
      }

      const desktopId = path.basename(entry.name, '.desktop');
      const parsedExec = parseDesktopExec(fields.Exec);
      const commandAlias = parsedExec?.command ? path.basename(parsedExec.command) : undefined;

      addApp(appsByName, {
        id: desktopId,
        name,
        aliases: uniqueStrings([entry.name, desktopId, commandAlias]),
        openTarget: {
          type: 'linux',
          desktopId,
          desktopFilePath,
          command: parsedExec?.command,
          args: parsedExec?.args ?? [],
        },
      });
    }
  }

  return sortApps([...appsByName.values()]);
}

function getMatchScore(app: InstalledApp, normalizedQuery: string) {
  const names = uniqueStrings([app.name, ...app.aliases])
    .map((value) => normalizeAppName(value))
    .filter(Boolean);

  if (names.includes(normalizedQuery)) {
    return 0;
  }

  if (names.some((value) => value.startsWith(normalizedQuery))) {
    return 1;
  }

  if (names.some((value) => value.includes(normalizedQuery))) {
    return 2;
  }

  return Number.POSITIVE_INFINITY;
}

function findBestAppMatch(apps: InstalledApp[], query: string) {
  const normalizedQuery = normalizeAppName(query);

  if (!normalizedQuery) {
    return null;
  }

  const rankedMatches = apps
    .map((app) => ({
      app,
      score: getMatchScore(app, normalizedQuery),
    }))
    .filter((match) => Number.isFinite(match.score))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      return left.app.name.localeCompare(right.app.name);
    });

  return rankedMatches[0]?.app ?? null;
}

function buildSuggestions(apps: InstalledApp[], query: string) {
  const normalizedQuery = normalizeAppName(query);
  const source = normalizedQuery
    ? apps.filter((app) => getMatchScore(app, normalizedQuery) < Number.POSITIVE_INFINITY)
    : apps;

  return source.slice(0, 10).map((app) => app.name);
}

async function openInstalledApp(app: InstalledApp) {
  if (app.openTarget.type === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Start-Process "shell:AppsFolder\\${app.openTarget.appId}"`,
    ]);
    return;
  }

  if (app.openTarget.type === 'darwin') {
    await execFileAsync('open', ['-a', app.openTarget.appPath]);
    return;
  }

  const launchErrors: string[] = [];

  try {
    await execFileAsync('gtk-launch', [app.openTarget.desktopId]);
    return;
  } catch (error) {
    launchErrors.push(extractErrorMessage(error));
  }

  try {
    await execFileAsync('gio', ['launch', app.openTarget.desktopFilePath]);
    return;
  } catch (error) {
    launchErrors.push(extractErrorMessage(error));
  }

  if (app.openTarget.command) {
    try {
      await execFileAsync(app.openTarget.command, app.openTarget.args);
      return;
    } catch (error) {
      launchErrors.push(extractErrorMessage(error));
    }
  }

  throw new Error(launchErrors[launchErrors.length - 1] || `Could not open ${app.name}`);
}

export async function GET() {
  try {
    const apps = await getInstalledApps();
    const runtimeInfo = getRuntimeInfo();

    return NextResponse.json({
      platform: runtimeInfo.platform,
      count: apps.length,
      apps: serializeApps(apps),
      runtime: runtimeInfo,
    });
  } catch (error) {
    console.error('[open-app] Failed to list apps:', error);

    return NextResponse.json(
      { error: 'Could not read installed apps from this system.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const appName = typeof body?.appName === 'string' ? body.appName.trim() : '';
    const runtimeInfo = getRuntimeInfo();

    if (!appName) {
      return NextResponse.json({ error: 'Please provide an app name.' }, { status: 400 });
    }

    if (!runtimeInfo.canLaunchApps) {
      return NextResponse.json(
        {
          error:
            runtimeInfo.warning ||
            'This server cannot open desktop apps for the device visiting the site.',
          runtime: runtimeInfo,
        },
        { status: 400 },
      );
    }

    const apps = await getInstalledApps();
    const matchedApp = findBestAppMatch(apps, appName);

    if (!matchedApp) {
      return NextResponse.json(
        {
          error: `"${appName}" was not found on this system.`,
          platform: runtimeInfo.platform,
          runtime: runtimeInfo,
          suggestions: buildSuggestions(apps, appName),
        },
        { status: 404 },
      );
    }

    await openInstalledApp(matchedApp);

    return NextResponse.json({
      success: true,
      message: `Opening ${matchedApp.name}...`,
      openedApp: matchedApp.name,
      platform: runtimeInfo.platform,
      runtime: runtimeInfo,
    });
  } catch (error) {
    console.error('[open-app] Failed to open app:', error);

    return NextResponse.json(
      {
        error: 'Server error while opening the app. Please try again.',
      },
      { status: 500 },
    );
  }
}
